#!/usr/bin/env node
// Discord setup for the GenClass server (the one the READMEs link), for the owner to run (Node 20 or later, no
// dependencies). It works through a throwaway bot, never a user account: automating a user account is against
// Discord's terms. docs/community/DISCORD.md has the steps (make the bot, add it, run this) and the layout.
//
//   DISCORD_BOT_TOKEN=... node scripts/discord-setup.mjs --dry-run     read only: say what would change
//   DISCORD_BOT_TOKEN=... node scripts/discord-setup.mjs               apply it, then the bot leaves the server
//
// The server is the one the bot is in (it must be in exactly one, or --guild <id> names it). The invite the
// README links (discord.gg/<code>) must open that same server, or the script stops: it never sets up a server the
// repository does not point to unless --guild names it. It makes the server match LAYOUT below:
// 1. @everyone loses the moderation permissions (mention @everyone, manage messages, kick, ...), nothing else;
// 2. the roles Maintainer, Moderator, Contributor and Release pings, in that order, below the bot's own role; the
//    server owner gets Maintainer;
// 3. the categories and channels, with their topics, forum tags and permissions. A channel is found by name (case
//    ignored), so the server's own #general is moved into Community, not duplicated. On a channel it finds, it sets
//    only the overwrites of @everyone and the layout's roles and keeps every other overwrite;
// 4. Community on (needed for #announcements and the forums), with #rules as the rules channel and #mod-log for
//    Discord's community updates and safety alerts, verification Low or higher (never lowered), the media filter on
//    for all members, default notifications to mentions only, the description, and the GenClass mark as the icon if
//    the server has none;
// 5. the welcome screen and onboarding (a "Release pings" choice), AutoMod rules (spam, mention spam, slurs, scam
//    and invite links; an existing rule of a kind Discord allows once is kept), the bot's #welcome and #rules
//    messages (edited in place on a later run), and a "GitHub" webhook in #github that `gh` adds to the repository
//    (issues, pull requests, releases; without `gh` the script prints the steps);
// 6. a permanent invite to #welcome when the README's invite is gone or expires (and the files to update);
// 7. then the bot leaves the server (--stay keeps it), since a bot with Administrator is a standing risk.
// Everything is read and checked first; changes start only when every check passed. Nothing is ever deleted:
// channels and roles outside the layout are listed at the end, for the owner to keep or remove. Running it again
// changes only what differs.
//
// Flags: --dry-run, --guild <id>, --stay (the bot stays in the server), --no-github (skip the `gh` step).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const API = "https://discord.com/api/v10";
/** The repository (its old name, GenClass-lib, redirects here). */
export const REPO = "genclass-dev/GenClass";
const GH = `https://github.com/${REPO}`;
const REASON = "GenClass server setup (scripts/discord-setup.mjs)";
const USER_AGENT = `DiscordBot (${GH}, 1)`;
/** The files that carry the server's invite link (the site, in genclass-dev/genclass-site, has it too). */
export const INVITE_FILES = ["README.md", "packages/runtime/README.md", "FAQ.md", ".github/ISSUE_TEMPLATE/config.yml", "telemetry-worker/src/studio.ts"];
const ICON = "packages/mcp/plugin/.claude-plugin/icon.png";
export const GITHUB_EVENTS = ["issues", "pull_request", "release"];

// ------------------------------------------------------------------------------------------- permissions

const bit = (n) => 1n << BigInt(n);
/** The permission bits the layout uses (discord.com/developers/docs/topics/permissions). */
export const P = {
  KICK_MEMBERS: bit(1),
  BAN_MEMBERS: bit(2),
  ADMINISTRATOR: bit(3),
  MANAGE_CHANNELS: bit(4),
  MANAGE_GUILD: bit(5),
  VIEW_AUDIT_LOG: bit(7),
  VIEW_CHANNEL: bit(10),
  SEND_MESSAGES: bit(11),
  MANAGE_MESSAGES: bit(13),
  MENTION_EVERYONE: bit(17),
  MANAGE_NICKNAMES: bit(27),
  MANAGE_ROLES: bit(28),
  MANAGE_WEBHOOKS: bit(29),
  MANAGE_GUILD_EXPRESSIONS: bit(30),
  MANAGE_EVENTS: bit(33),
  MANAGE_THREADS: bit(34),
  CREATE_PUBLIC_THREADS: bit(35),
  CREATE_PRIVATE_THREADS: bit(36),
  SEND_MESSAGES_IN_THREADS: bit(38),
  MODERATE_MEMBERS: bit(40),
  CREATE_EVENTS: bit(44),
};
const or = (...ps) => ps.reduce((a, b) => a | b, 0n);
const permNames = (bits) => Object.entries(P).filter(([, b]) => bits & b).map(([k]) => k.toLowerCase().replaceAll("_", " "));

/** What @everyone may never have on a public server (what Discord's own Community setup removes). */
export const EVERYONE_STRIP = or(
  P.ADMINISTRATOR, P.MANAGE_GUILD, P.MANAGE_ROLES, P.MANAGE_CHANNELS, P.KICK_MEMBERS, P.BAN_MEMBERS, P.MANAGE_NICKNAMES,
  P.MANAGE_WEBHOOKS, P.MENTION_EVERYONE, P.MANAGE_MESSAGES, P.MANAGE_THREADS, P.MODERATE_MEMBERS, P.VIEW_AUDIT_LOG,
  P.MANAGE_EVENTS, P.MANAGE_GUILD_EXPRESSIONS,
);
const MOD = or(P.KICK_MEMBERS, P.MANAGE_MESSAGES, P.MANAGE_THREADS, P.MODERATE_MEMBERS, P.VIEW_AUDIT_LOG, P.MANAGE_NICKNAMES);

// ------------------------------------------------------------------------------------------- the layout

/** Top to bottom. Created in this order, each new role lands just above @everyone, so the first ends highest. */
export const ROLES = [
  { key: "maintainer", name: "Maintainer", color: 0x3ecf8e, hoist: true, permissions: or(MOD, P.BAN_MEMBERS, P.MANAGE_CHANNELS, P.MANAGE_ROLES, P.MANAGE_WEBHOOKS, P.MANAGE_EVENTS, P.CREATE_EVENTS, P.MANAGE_GUILD_EXPRESSIONS, P.MENTION_EVERYONE) },
  { key: "moderator", name: "Moderator", color: 0xf1a10d, hoist: true, permissions: MOD },
  { key: "contributor", name: "Contributor", color: 0x60a5fa, hoist: true, permissions: 0n },
  { key: "pings", name: "Release pings", color: 0, hoist: false, permissions: 0n },
];

export const TEXT = 0;
export const VOICE = 2;
export const CATEGORY = 4;
export const ANNOUNCEMENT = 5;
export const FORUM = 15;
/** Channel types Discord can convert between are in one group; the rest cannot share a name with a layout channel. */
const GROUP = { 0: "text", 5: "text", 15: "forum", 2: "voice", 13: "voice", 4: "category" };
const KIND = { 0: "text", 5: "announcement", 15: "forum", 2: "voice", 13: "stage", 4: "category" };

const READ_ONLY = [
  { to: "everyone", allow: 0n, deny: or(P.SEND_MESSAGES, P.SEND_MESSAGES_IN_THREADS, P.CREATE_PUBLIC_THREADS, P.CREATE_PRIVATE_THREADS) },
  { to: "maintainer", allow: or(P.SEND_MESSAGES, P.SEND_MESSAGES_IN_THREADS, P.CREATE_PUBLIC_THREADS), deny: 0n },
];
const STAFF_ONLY = [
  { to: "everyone", allow: 0n, deny: P.VIEW_CHANNEL },
  { to: "maintainer", allow: P.VIEW_CHANNEL, deny: 0n },
  { to: "moderator", allow: P.VIEW_CHANNEL, deny: 0n },
];

// {#key} is a channel mention, {@&key} a role mention; both are filled in with ids at run time. The messages are
// sent with mentions off, so a role mention never pings.
export const WELCOME = `# Welcome to GenClass
GenClass Runtime (\`@genclass/runtime\`) is an open-source (Apache-2.0) browser library that reports race conditions in web apps while they happen: stale responses that land over newer data, double submits, inconsistent state and failure storms. A small model runs on the user's device, and by default it only reports.

**Start here**
- Quick start: <${GH}#quick-start>
- Docs: <https://genclass.dev/docs> · FAQ: <${GH}/blob/main/FAQ.md>
- Code: <${GH}>

**Where to post**
- {#help}: a question about installing, configuring or reading a report. One post per question.
- {#ideas}: feature requests and feedback.
- {#show-and-tell}: races GenClass caught in your app, integrations, write-ups.
- {#contributing}: working on GenClass itself.
- {#general}: anything else about GenClass, and {#off-topic} for the rest.

**Not here**
- Bugs and false detections go in GitHub Issues, so nothing gets lost: <${GH}/issues>
- Security issues are never posted in public: email mehar@daybot.ca or open a private report: <${GH}/security/advisories/new>

Want a ping when a release ships? Pick **Release pings** in Channels & Roles, at the top of the channel list.`;

export const RULES = `# Rules
This server follows the GenClass Code of Conduct (the Contributor Covenant): <${GH}/blob/main/CODE_OF_CONDUCT.md>. In short:

1. **Be kind and assume good faith.** No harassment, insults or discrimination. Critique code and ideas, not people.
2. **Post in the right place.** Questions go in {#help}, one post per question; ideas in {#ideas}; bugs and false detections in GitHub Issues.
3. **No spam or self-promotion.** No ads, unsolicited DMs or invites to other servers. A project that uses GenClass is welcome in {#show-and-tell}.
4. **Redact before you paste.** Remove tokens, cookies, personal data and private URLs from logs, HAR files and screenshots.
5. **Keep security issues private.** Never post a vulnerability here; SECURITY.md says how to report one: <${GH}/blob/main/SECURITY.md>
6. **Use English in the shared channels,** so everyone can follow.
7. **Follow Discord's Terms and Community Guidelines:** <https://discord.com/guidelines>

Moderators may remove messages, time members out or ban them to keep this a good place. To report a problem, message a {@&moderator} or a {@&maintainer}, or email mehar@daybot.ca (the Code of Conduct's contact).`;

const tag = (name, emoji, moderated = false) => ({ name, emoji, moderated });

/** Categories top to bottom, each with its channels top to bottom. A channel without overwrites takes its category's. */
export const LAYOUT = [
  {
    key: "start", name: "Start here", overwrites: READ_ONLY, channels: [
      { key: "welcome", name: "welcome", type: TEXT, topic: "What GenClass is, where to post, and the links you need.", message: WELCOME },
      { key: "rules", name: "rules", type: TEXT, topic: "The server rules. The GenClass Code of Conduct applies everywhere here.", message: RULES },
      { key: "announcements", name: "announcements", type: ANNOUNCEMENT, topic: "Releases and news from the maintainers. Follow this channel to get the posts in your own server; pick Release pings in Channels & Roles to be pinged." },
    ],
  },
  {
    key: "community", name: "Community", channels: [
      { key: "general", name: "general", type: TEXT, topic: "Talk about GenClass, race conditions and web apps. A question that needs an answer works better as a post in #help." },
      { key: "show-and-tell", name: "show-and-tell", type: TEXT, topic: "Races GenClass caught in your app, integrations, write-ups and demos." },
      { key: "off-topic", name: "off-topic", type: TEXT, topic: "Anything else. Keep it friendly." },
    ],
  },
  {
    key: "support", name: "Help", channels: [
      {
        key: "help", name: "help", type: FORUM,
        topic: `One post per question, with a title that says what happened. Include the package and its version (\`npx @genclass/runtime info\` prints them), the mode (observe, guard or heal), your framework, and the console group or \`rt.explain(id)\` output for the report. Redact tokens and personal data. Tag the post, and add the Solved tag once it is answered. A bug or a false detection also belongs in GitHub Issues: ${GH}/issues`,
        tags: [tag("Runtime", "📦"), tag("Coding agents (MCP)", "🤖"), tag("Playwright", "🎭"), tag("Frameworks", "🧩"), tag("Model", "🧠"), tag("False detection", "🚩"), tag("Solved", "✅")],
      },
      {
        key: "ideas", name: "ideas", type: FORUM,
        topic: "Feature requests and feedback, one idea per post. Say what you were trying to do and what got in the way. Ideas the maintainers take on become GitHub issues and get the Planned tag here.",
        tags: [tag("Runtime", "📦"), tag("Coding agents (MCP)", "🤖"), tag("Integrations", "🧩"), tag("Docs", "📖"), tag("Planned", "📅", true), tag("Shipped", "🚀", true)],
      },
    ],
  },
  {
    key: "dev", name: "Development", channels: [
      { key: "contributing", name: "contributing", type: TEXT, topic: "Working on GenClass itself: pull requests, good first issues, design questions. Start with CONTRIBUTING.md and AGENTS.md in the repository." },
      { key: "github", name: "github", type: TEXT, overwrites: READ_ONLY, topic: `Issues, pull requests and releases from ${REPO}, posted by a GitHub webhook.` },
    ],
  },
  { key: "voice", name: "Voice", channels: [{ key: "office-hours", name: "Office hours", type: VOICE }] },
  {
    key: "staff", name: "Moderation", overwrites: STAFF_ONLY, channels: [
      { key: "mod-chat", name: "mod-chat", type: TEXT, topic: "Moderators and maintainers only." },
      { key: "mod-log", name: "mod-log", type: TEXT, topic: "AutoMod alerts, raid alerts and Discord's community updates." },
    ],
  },
];
/** Every layout channel, with its category's key and its overwrites resolved. */
export const CHANNELS = LAYOUT.flatMap((c) => c.channels.map((ch) => ({ ...ch, cat: c.key, overwrites: ch.overwrites ?? c.overwrites ?? [] })));
const PUBLIC = CHANNELS.filter((ch) => ch.cat !== "staff" && ch.type !== VOICE).map((ch) => ch.key);

export const GUILD = { description: "Open-source race-condition reports for web apps: help, feedback and the development of GenClass Runtime." };

export const WELCOME_SCREEN = {
  description: "Open-source race-condition reports for web apps. Ask for help, share what you found, or help build it.",
  channels: [
    { key: "rules", description: "Read the rules", emoji: "📜" },
    { key: "help", description: "Ask a question", emoji: "🙋" },
    { key: "general", description: "Say hello", emoji: "👋" },
    { key: "announcements", description: "Releases and news", emoji: "📣" },
    { key: "contributing", description: "Work on GenClass", emoji: "🔧" },
  ],
};

export const ONBOARDING = {
  title: "Do you want a ping when a release ships?",
  option: { title: "Ping me for releases", description: "Get the Release pings role: one mention in #announcements per release", emoji: "📣", role: "pings" },
};

const BLOCKED = "Not posted: AutoMod flagged it. If that was a mistake, a moderator can help.";
/** AutoMod rules (trigger types: 1 keyword, 3 spam, 4 keyword preset, 5 mention spam; Discord allows 3 to 5 once). */
export function automodRules(inviteCodes) {
  return [
    { name: "GenClass: spam", trigger_type: 3, trigger_metadata: {}, exempt: ["maintainer", "moderator"] },
    { name: "GenClass: mention spam", trigger_type: 5, trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true }, exempt: ["maintainer", "moderator"] },
    { name: "GenClass: slurs and sexual content", trigger_type: 4, trigger_metadata: { presets: [2, 3], allow_list: [] }, exempt: [] },
    {
      name: "GenClass: scam and invite links",
      trigger_type: 1,
      trigger_metadata: {
        keyword_filter: ["*free nitro*", "*nitro for free*", "*gift nitro*", "*steam gift*", "*crypto giveaway*", "*airdrop claim*"],
        regex_patterns: ["(?:discord(?:app)?\\.(?:gg|com/invite)|dsc\\.gg)/[\\w-]+"],
        allow_list: inviteCodes.map((c) => `discord.gg/${c}`),
      },
      exempt: ["maintainer", "moderator", "contributor"],
    },
  ];
}

// ------------------------------------------------------------------------------------------- errors

export class SetupError extends Error {}
/** Discord refused a call; `status` and `code` are Discord's. */
export class DiscordError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function fail(msg) {
  throw new SetupError(msg);
}
/** Discord's nested form errors as "path: message" lines. */
function formErrors(errors, path = "") {
  if (!errors || typeof errors !== "object") return [];
  const out = (errors._errors ?? []).map((e) => `${path || "body"}: ${e.message}`);
  for (const [k, v] of Object.entries(errors)) if (k !== "_errors") out.push(...formErrors(v, path ? `${path}.${k}` : k));
  return out;
}

function runGh(args, input) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn("gh", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      done({ ok: false, stdout: "" });
      return;
    }
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => done({ ok: false, stdout: "" }));
    child.on("close", (code) => done({ ok: code === 0, stdout: out }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** The invite codes in README.md, first one first. */
export function repoInvites(readme = readFileSync(join(ROOT, "README.md"), "utf8")) {
  return [...new Set([...readme.matchAll(/discord\.gg\/([A-Za-z0-9-]+)/g)].map((m) => m[1]))];
}

function parseArgs(argv) {
  const o = { dry: false, guild: null, stay: false, github: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dry = true;
    else if (a === "--stay") o.stay = true;
    else if (a === "--no-github") o.github = false;
    else if (a === "--guild") {
      o.guild = argv[++i];
      if (!/^\d{5,25}$/.test(o.guild ?? "")) fail("--guild takes a server id (Developer Mode on, then right-click the server, Copy Server ID)");
    } else fail(`unknown option ${a} (use --dry-run, --guild <id>, --stay or --no-github)`);
  }
  return o;
}

/**
 * The whole run. `fetch`, `log`, `sleep`, `gh` and `now` are parameters so the tests can run it against a fake
 * Discord (telemetry-worker/test/discord-setup.test.ts). Throws SetupError when a check fails.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  gh = runGh,
  now = () => Date.now(),
} = {}) {
  const opts = parseArgs(argv);
  const DRY = opts.dry;
  const TOKEN = (env.DISCORD_BOT_TOKEN ?? "").trim().replace(/^Bot\s+/i, "");
  if (!TOKEN) fail("set DISCORD_BOT_TOKEN to the setup bot's token (Discord developer portal, your application, Bot, Reset Token); docs/community/DISCORD.md has the steps");
  const say = (s) => log(s);
  const would = (s) => say(`${DRY ? "would " : ""}${s}`);
  const warnings = [];
  const warn = (s) => {
    warnings.push(s);
    say(`warning: ${s}`);
  };
  let changes = 0;
  const change = (s) => {
    changes++;
    would(s);
  };

  // ------------------------------------------------------------------------------------------- Discord REST

  /** One call; `missingOk`: a 404 answers null. Waits out a 429 and retries a network error or a 5xx twice. */
  async function discord(method, path, body, o = {}) {
    const headers = { authorization: `Bot ${TOKEN}`, "user-agent": USER_AGENT };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-audit-log-reason"] = encodeURIComponent(REASON);
    let failures = 0;
    for (let limited = 0; ; ) {
      let res;
      try {
        res = await fetchImpl(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (++failures <= 2) {
          await sleep(1000 * failures);
          continue;
        }
        fail(`no answer from Discord for ${method} ${path} (${e?.message ?? e})`);
      }
      if (res.status === 204) return null;
      const j = await res.json().catch(() => null);
      if (res.status === 429 && ++limited <= 8) {
        await sleep(Math.ceil(Number(j?.retry_after ?? res.headers.get("retry-after") ?? 1) * 1000) + 50);
        continue;
      }
      if (res.status >= 500 && ++failures <= 2) {
        await sleep(1000 * failures);
        continue;
      }
      if (res.status === 404 && o.missingOk) return null;
      if (res.status === 401) fail("Discord refused the token (401). Use the bot token from your application's Bot page, not a user token.");
      if (!res.ok) {
        const detail = [j?.message ?? `HTTP ${res.status}`, ...formErrors(j?.errors)].join("; ");
        throw new DiscordError(`${method} ${path}: ${detail}${j?.code ? ` (code ${j.code})` : ""}`, res.status, j?.code);
      }
      return j;
    }
  }

  // ------------------------------------------------------------------------------------------- read and check

  const me = await discord("GET", "/users/@me");
  if (!me?.bot) fail("DISCORD_BOT_TOKEN must be a bot's token (the Bot page of your application in the Discord developer portal)");
  const guilds = (await discord("GET", "/users/@me/guilds")) ?? [];
  const codes = repoInvites();
  const code = codes[0] ?? null;
  const invite = code ? await discord("GET", `/invites/${code}?with_expiration=true`, undefined, { missingOk: true }) : null;

  let gid = opts.guild;
  if (!gid) {
    if (guilds.length === 0) {
      const app = await discord("GET", "/oauth2/applications/@me");
      const where = invite?.guild ? `the server discord.gg/${code} opens ("${invite.guild.name}")` : "the GenClass server";
      say(`The bot ${me.username} is in no server yet. Open this link, pick ${where}, and authorize; then run this again:
  https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=8`);
      return { changes: 0, warnings };
    }
    if (guilds.length > 1) fail(`the bot is in ${guilds.length} servers (${guilds.map((g) => `"${g.name}" ${g.id}`).join(", ")}); name one with --guild <id>`);
    gid = guilds[0].id;
  } else if (!guilds.some((g) => g.id === gid)) {
    fail(`the bot is not in the server ${gid}; add it first (run this without --guild to get the link)`);
  }

  let guild = await discord("GET", `/guilds/${gid}`);
  const wasCommunity = guild.features.includes("COMMUNITY");
  say(`${DRY ? "Dry run on" : "Setting up"} "${guild.name}" (${gid}) as ${me.username}.`);
  if (code && invite?.guild && invite.guild.id !== gid && !opts.guild) {
    fail(`discord.gg/${code}, the invite README.md links, opens "${invite.guild.name}" (${invite.guild.id}), not "${guild.name}" (${gid}), the server the bot is in. Add the bot to the server the invite opens, or pass --guild ${gid} to set up this one anyway (then replace the invite in the repository). Nothing was changed.`);
  }
  if (code && invite?.guild && invite.guild.id !== gid) warn(`discord.gg/${code} (README.md) opens another server, "${invite.guild.name}"; replace it once this server has an invite`);

  let roles = await discord("GET", `/guilds/${gid}/roles`);
  let channels = await discord("GET", `/guilds/${gid}/channels`);
  const member = await discord("GET", `/guilds/${gid}/members/${me.id}`);
  const owner = guild.owner_id ? await discord("GET", `/guilds/${gid}/members/${guild.owner_id}`, undefined, { missingOk: true }) : null;
  const automod = (await discord("GET", `/guilds/${gid}/auto-moderation/rules`)) ?? [];

  const everyone = roles.find((r) => r.id === gid);
  const mine = roles.filter((r) => member.roles.includes(r.id));
  const myPerms = [everyone, ...mine].reduce((a, r) => a | BigInt(r?.permissions ?? 0), 0n);
  if (!(myPerms & P.ADMINISTRATOR)) fail("the bot needs the Administrator permission (turning Community on needs it). Remove the bot, add it again with the link this script prints when the bot is in no server (permissions=8), then run this again. Nothing was changed.");
  const myTop = mine.reduce((top, r) => (r.position > (top?.position ?? -1) ? r : top), null);

  /** layout key -> the role or channel object; null until it exists. */
  const roleOf = new Map();
  for (const spec of ROLES) {
    const found = roles.filter((r) => !r.managed && r.name.toLowerCase() === spec.name.toLowerCase());
    if (found.length > 1) fail(`there are ${found.length} roles named ${spec.name}; rename or delete all but one, then run this again. Nothing was changed.`);
    if (found[0] && found[0].position >= (myTop?.position ?? 0)) {
      fail(`the role ${spec.name} is above the bot's role ${myTop?.name ?? ""}, so the bot cannot change it. In Server Settings, Roles, drag ${myTop?.name ?? "the bot's role"} above ${spec.name}, then run this again. Nothing was changed.`);
    }
    roleOf.set(spec.key, found[0] ?? null);
  }

  function match(name, type) {
    const same = channels.filter((c) => c.name.toLowerCase() === name.toLowerCase());
    const ok = same.filter((c) => GROUP[c.type] === GROUP[type]);
    if (ok.length > 1) fail(`there are ${ok.length} ${KIND[type]} channels named ${name}; rename or delete all but one, then run this again. Nothing was changed.`);
    if (!ok.length && type !== CATEGORY) {
      const clash = same.find((c) => c.type !== CATEGORY && GROUP[c.type] !== GROUP[type]);
      if (clash) fail(`#${name} exists as a ${KIND[clash.type]} channel, but the layout has a ${KIND[type]} channel by that name and Discord cannot convert one into the other. Rename or delete #${name}, then run this again. Nothing was changed.`);
    }
    return ok[0] ?? null;
  }
  const catOf = new Map(LAYOUT.map((c) => [c.key, match(c.name, CATEGORY)]));
  const chanOf = new Map(CHANNELS.map((ch) => [ch.key, match(ch.name, ch.type)]));

  say("Every check passed.");
  say("");

  /** Keeps the local channel list current after a create or an edit. */
  const track = (c) => {
    channels = [...channels.filter((x) => x.id !== c.id), c];
    return c;
  };
  const roleId = (key) => (key === "everyone" ? gid : (roleOf.get(key)?.id ?? `(new ${key})`));
  const chanId = (key) => chanOf.get(key)?.id ?? null;
  const render = (text) =>
    text
      .replace(/\{#([a-z-]+)\}/g, (_, k) => (chanId(k) ? `<#${chanId(k)}>` : `#${k}`))
      .replace(/\{@&([a-z-]+)\}/g, (_, k) => (roleOf.get(k) ? `<@&${roleOf.get(k).id}>` : `@${ROLES.find((r) => r.key === k)?.name ?? k}`));
  const overwritesFor = (list) => list.map((o) => ({ id: roleId(o.to), type: 0, allow: String(o.allow), deny: String(o.deny) }));
  const owKey = (o) => `${o.id}:${o.type}:${BigInt(o.allow ?? 0)}:${BigInt(o.deny ?? 0)}`;
  /** The channel's overwrites with the layout's set: any other overwrite (another role, a member) is kept. */
  const mergeOverwrites = (existing = [], want) => [...existing.filter((o) => !want.some((w) => w.id === o.id)).map((o) => ({ id: o.id, type: o.type, allow: String(o.allow), deny: String(o.deny) })), ...want];
  const sameOverwrites = (a = [], b = []) => JSON.stringify(a.map(owKey).sort()) === JSON.stringify(b.map(owKey).sort());
  const label = (ch) => (ch.type === VOICE ? `the voice channel ${ch.name}` : `#${ch.name}${ch.type === FORUM ? " (forum)" : ch.type === ANNOUNCEMENT ? " (announcements)" : ""}`);

  /** Soft steps (icon, welcome screen, onboarding): a refusal is a warning with the manual step, not a stop. */
  async function soft(what, manual, fn) {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof DiscordError)) throw e;
      warn(`${what} failed (${e.message}). ${manual}`);
    }
  }

  try {
    // --------------------------------------------------------------------------------------- 1. @everyone
    const strip = BigInt(everyone.permissions) & EVERYONE_STRIP;
    if (strip) {
      change(`take ${permNames(strip).join(", ")} away from @everyone`);
      if (!DRY) await discord("PATCH", `/guilds/${gid}/roles/${gid}`, { permissions: String(BigInt(everyone.permissions) & ~EVERYONE_STRIP) });
    }

    // --------------------------------------------------------------------------------------- 2. roles
    for (const spec of ROLES) {
      const want = { name: spec.name, permissions: String(spec.permissions), color: spec.color, hoist: spec.hoist, mentionable: false };
      const r = roleOf.get(spec.key);
      if (!r) {
        change(`create the role ${spec.name}`);
        if (!DRY) roleOf.set(spec.key, await discord("POST", `/guilds/${gid}/roles`, want));
        continue;
      }
      const diff = {};
      if (BigInt(r.permissions) !== spec.permissions) diff.permissions = want.permissions;
      if (r.color !== spec.color) diff.color = spec.color;
      if (r.hoist !== spec.hoist) diff.hoist = spec.hoist;
      if (r.mentionable) diff.mentionable = false;
      if (Object.keys(diff).length) {
        change(`update the role ${spec.name} (${Object.keys(diff).join(", ")})`);
        if (!DRY) roleOf.set(spec.key, await discord("PATCH", `/guilds/${gid}/roles/${r.id}`, diff));
      }
    }
    if (!DRY) {
      roles = await discord("GET", `/guilds/${gid}/roles`);
      for (const spec of ROLES) roleOf.set(spec.key, roles.find((r) => r.id === roleOf.get(spec.key).id));
    }
    // order: new roles sit below every existing one, in layout order; fix it if the result is not the layout's
    const placed = [...ROLES.filter((s) => roleOf.get(s.key)).sort((a, b) => roleOf.get(b.key).position - roleOf.get(a.key).position), ...ROLES.filter((s) => !roleOf.get(s.key))];
    if (placed.some((s, i) => s.key !== ROLES[i].key)) {
      change(`put the roles in the order ${ROLES.map((s) => s.name).join(", ")}`);
      if (!DRY) {
        const slots = ROLES.map((s) => roleOf.get(s.key).position).sort((a, b) => b - a);
        await discord("PATCH", `/guilds/${gid}/roles`, ROLES.map((s, i) => ({ id: roleOf.get(s.key).id, position: slots[i] })));
      }
    }
    const maintainer = roleOf.get("maintainer");
    if (owner && !(maintainer && owner.roles.includes(maintainer.id))) {
      change(`give the server owner (${owner.user?.username ?? guild.owner_id}) the Maintainer role`);
      if (!DRY) await discord("PUT", `/guilds/${gid}/members/${guild.owner_id}/roles/${maintainer.id}`);
    }

    // --------------------------------------------------------------------------------------- 3. categories, channels
    for (const cat of LAYOUT) {
      const want = overwritesFor(cat.overwrites ?? []);
      const c = catOf.get(cat.key);
      if (!c) {
        change(`create the category ${cat.name}`);
        if (!DRY) catOf.set(cat.key, track(await discord("POST", `/guilds/${gid}/channels`, { name: cat.name, type: CATEGORY, permission_overwrites: want })));
        continue;
      }
      const merged = mergeOverwrites(c.permission_overwrites, want);
      if (!sameOverwrites(c.permission_overwrites, merged)) {
        change(`set the permissions of the category ${cat.name}`);
        if (!DRY) catOf.set(cat.key, track(await discord("PATCH", `/channels/${c.id}`, { permission_overwrites: merged })));
      }
    }

    const tagBody = (t) => ({ name: t.name, moderated: t.moderated, emoji_id: null, emoji_name: t.emoji });
    async function ensureChannel(ch) {
      const cat = LAYOUT.find((c) => c.key === ch.cat);
      const parentId = catOf.get(ch.cat)?.id ?? null;
      const want = overwritesFor(ch.overwrites);
      const c = chanOf.get(ch.key);
      if (!c) {
        change(`create ${label(ch)} in ${cat.name}`);
        if (DRY) return;
        const body = { name: ch.name, type: ch.type, parent_id: parentId, permission_overwrites: want };
        if (ch.topic) body.topic = ch.topic;
        if (ch.type === FORUM) Object.assign(body, { available_tags: ch.tags.map(tagBody), default_sort_order: 0, default_forum_layout: 1 });
        chanOf.set(ch.key, track(await discord("POST", `/guilds/${gid}/channels`, body)));
        return;
      }
      const patch = {};
      if (ch.type === ANNOUNCEMENT && c.type === TEXT) patch.type = ANNOUNCEMENT;
      if (ch.topic !== undefined && (c.topic ?? "") !== ch.topic) patch.topic = ch.topic;
      if ((c.parent_id ?? null) !== parentId) patch.parent_id = parentId;
      const merged = mergeOverwrites(c.permission_overwrites, want);
      if (!sameOverwrites(c.permission_overwrites, merged)) patch.permission_overwrites = merged;
      if (ch.type === FORUM) {
        const have = c.available_tags ?? [];
        const missing = ch.tags.filter((t) => !have.some((h) => h.name.toLowerCase() === t.name.toLowerCase()));
        if (missing.length) patch.available_tags = [...have.map((h) => ({ id: h.id, name: h.name, moderated: h.moderated, emoji_id: h.emoji_id, emoji_name: h.emoji_name })), ...missing.map(tagBody)];
        if (c.default_sort_order !== 0) patch.default_sort_order = 0;
        if (c.default_forum_layout !== 1) patch.default_forum_layout = 1;
      }
      const keys = Object.keys(patch);
      if (!keys.length) return;
      const what = { type: "make it an announcement channel", topic: "topic", parent_id: `move to ${cat.name}`, permission_overwrites: "permissions", available_tags: "tags", default_sort_order: "sort", default_forum_layout: "layout" };
      change(`update ${label(ch)} (${keys.map((k) => what[k]).join(", ")})`);
      if (!DRY) chanOf.set(ch.key, track(await discord("PATCH", `/channels/${c.id}`, patch)));
    }
    const needsCommunity = (ch) => ch.type === ANNOUNCEMENT || ch.type === FORUM;
    for (const ch of CHANNELS.filter((ch) => !needsCommunity(ch))) await ensureChannel(ch);

    // --------------------------------------------------------------------------------------- 4. Community, settings
    const rulesId = chanId("rules") ?? "(new #rules)";
    const modlogId = chanId("mod-log") ?? "(new #mod-log)";
    if (!guild.features.includes("COMMUNITY")) {
      const body = {
        features: [...new Set([...guild.features, "COMMUNITY"])],
        rules_channel_id: rulesId,
        public_updates_channel_id: modlogId,
        verification_level: Math.max(guild.verification_level ?? 0, 1),
        explicit_content_filter: 2,
      };
      change("turn Community on (rules in #rules, community updates in #mod-log, verification Low or higher, media filter for all members)");
      guild = DRY ? { ...guild, ...body } : await discord("PATCH", `/guilds/${gid}`, body);
    }
    const settings = {};
    if (guild.rules_channel_id !== rulesId) settings.rules_channel_id = rulesId;
    if (guild.public_updates_channel_id !== modlogId) settings.public_updates_channel_id = modlogId;
    if (guild.safety_alerts_channel_id !== modlogId) settings.safety_alerts_channel_id = modlogId;
    if ((guild.verification_level ?? 0) < 1) settings.verification_level = 1;
    if (guild.explicit_content_filter !== 2) settings.explicit_content_filter = 2;
    if (guild.default_message_notifications !== 1) settings.default_message_notifications = 1;
    if ((guild.description ?? "") !== GUILD.description) settings.description = GUILD.description;
    if (Object.keys(settings).length) {
      const what = { rules_channel_id: "rules channel", public_updates_channel_id: "community updates channel", safety_alerts_channel_id: "safety alerts channel", verification_level: "verification level", explicit_content_filter: "media filter", default_message_notifications: "default notifications (mentions only)", description: "description" };
      change(`set the server's ${Object.keys(settings).map((k) => what[k]).join(", ")}`);
      guild = DRY ? { ...guild, ...settings } : await discord("PATCH", `/guilds/${gid}`, settings);
    }
    if (!guild.icon) {
      change("set the server icon to the GenClass mark");
      if (!DRY) {
        await soft("Setting the icon", "Set it in Server Settings, Server Profile.", async () => {
          guild = await discord("PATCH", `/guilds/${gid}`, { icon: `data:image/png;base64,${readFileSync(join(ROOT, ICON)).toString("base64")}` });
        });
      }
    }
    for (const ch of CHANNELS.filter(needsCommunity)) await ensureChannel(ch);

    // --------------------------------------------------------------------------------------- order
    const byPos = (a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    if (!DRY) {
      const moves = [];
      const ours = LAYOUT.map((c) => catOf.get(c.key));
      const cats = channels.filter((c) => c.type === CATEGORY).sort(byPos);
      const wantCats = [...ours, ...cats.filter((c) => !ours.some((o) => o.id === c.id))];
      if (wantCats.some((c, i) => c.id !== cats[i]?.id)) moves.push(...wantCats.map((c, i) => ({ id: c.id, position: i })));
      for (const cat of LAYOUT) {
        const pid = catOf.get(cat.key).id;
        const kids = channels.filter((c) => c.parent_id === pid).sort(byPos);
        const oursIn = cat.channels.map((ch) => chanOf.get(ch.key));
        const wantKids = [...oursIn, ...kids.filter((c) => !oursIn.some((o) => o.id === c.id))];
        if (wantKids.some((c, i) => c.id !== kids[i]?.id)) moves.push(...wantKids.map((c, i) => ({ id: c.id, position: i })));
      }
      if (moves.length) {
        change("put the categories and channels in the layout's order");
        await discord("PATCH", `/guilds/${gid}/channels`, moves);
        channels = await discord("GET", `/guilds/${gid}/channels`);
      }
    } else if (CHANNELS.some((ch) => !chanOf.get(ch.key)) || LAYOUT.some((c) => !catOf.get(c.key))) {
      change("put the categories and channels in the layout's order");
    }

    // --------------------------------------------------------------------------------------- 5. welcome screen, onboarding
    const wantScreen = {
      enabled: true,
      description: WELCOME_SCREEN.description,
      welcome_channels: WELCOME_SCREEN.channels.map((w) => ({ channel_id: chanId(w.key) ?? `(new #${w.key})`, description: w.description, emoji_id: null, emoji_name: w.emoji })),
    };
    const screen = wasCommunity || !DRY ? await discord("GET", `/guilds/${gid}/welcome-screen`, undefined, { missingOk: true }).catch(() => null) : null;
    const screenKey = (s) => JSON.stringify([s?.description ?? "", (s?.welcome_channels ?? []).map((w) => [w.channel_id, w.description, w.emoji_name ?? null])]);
    const screenOn = guild.features.includes("WELCOME_SCREEN_ENABLED");
    if (!screen || !screenOn || screenKey(screen) !== screenKey(wantScreen)) {
      change("set the welcome screen (rules, help, general, announcements, contributing)");
      if (!DRY) await soft("Setting the welcome screen", "Set it in Server Settings, Onboarding, Welcome Screen (docs/community/DISCORD.md has the text).", () => discord("PATCH", `/guilds/${gid}/welcome-screen`, wantScreen));
    }

    let seq = 0;
    const snowflake = () => String(((BigInt(now()) - 1420070400000n) << 22n) | BigInt(seq++ & 0xfff));
    const pings = roleOf.get("pings");
    const onboarding = wasCommunity || !DRY ? await discord("GET", `/guilds/${gid}/onboarding`, undefined, { missingOk: true }).catch(() => null) : null;
    const defaults = PUBLIC.map(chanId).filter(Boolean);
    const prompt = onboarding?.prompts?.find((p) => p.title === ONBOARDING.title);
    const option = prompt?.options?.find((o) => o.title === ONBOARDING.option.title);
    const onboardingDone = onboarding?.enabled && option && pings && option.role_ids?.includes(pings.id) && defaults.every((id) => onboarding.default_channel_ids?.includes(id));
    if (!onboardingDone) {
      change(`turn onboarding on, with every public channel as a default and the question "${ONBOARDING.title}" (Release pings)`);
      if (!DRY) {
        const optionBody = (o) => ({ id: o.id, title: o.title, description: o.description ?? null, channel_ids: o.channel_ids ?? [], role_ids: o.role_ids ?? [], emoji_id: o.emoji?.id ?? null, emoji_name: o.emoji?.name ?? null, emoji_animated: o.emoji?.animated ?? false });
        const promptBody = (p) => ({ id: p.id, type: p.type, title: p.title, single_select: p.single_select, required: p.required, in_onboarding: p.in_onboarding, options: p.options.map(optionBody) });
        const ours = {
          id: prompt?.id ?? snowflake(),
          type: 0,
          title: ONBOARDING.title,
          single_select: false,
          required: false,
          in_onboarding: true,
          options: [{ id: option?.id ?? snowflake(), title: ONBOARDING.option.title, description: ONBOARDING.option.description, channel_ids: [], role_ids: [pings.id], emoji_id: null, emoji_name: ONBOARDING.option.emoji, emoji_animated: false }],
        };
        const others = (onboarding?.prompts ?? []).filter((p) => p.title !== ONBOARDING.title).map(promptBody);
        const ids = new Set(channels.map((c) => c.id));
        const keep = (onboarding?.default_channel_ids ?? []).filter((id) => ids.has(id) && !defaults.includes(id));
        await soft(
          "Turning onboarding on",
          "Set it in Server Settings, Onboarding: every public channel as a default, and a question with a Release pings answer that gives the Release pings role.",
          () => discord("PUT", `/guilds/${gid}/onboarding`, { prompts: [...others, ours], default_channel_ids: [...defaults, ...keep], enabled: true, mode: 0 }),
        );
      }
    }

    // --------------------------------------------------------------------------------------- AutoMod
    const rules = automodRules(codes);
    for (const rule of rules) {
      const have = automod.find((r) => r.name === rule.name) ?? (rule.trigger_type !== 1 ? automod.find((r) => r.trigger_type === rule.trigger_type) : null);
      if (have) {
        if (have.name !== rule.name) say(`kept the AutoMod rule "${have.name}" (Discord allows one rule of its kind)`);
        continue;
      }
      change(`add the AutoMod rule "${rule.name}" (alerts in #mod-log)`);
      if (DRY) continue;
      await discord("POST", `/guilds/${gid}/auto-moderation/rules`, {
        name: rule.name,
        event_type: 1,
        trigger_type: rule.trigger_type,
        trigger_metadata: rule.trigger_metadata,
        actions: [{ type: 1, metadata: { custom_message: BLOCKED } }, { type: 2, metadata: { channel_id: modlogId } }],
        enabled: true,
        exempt_roles: rule.exempt.map((k) => roleOf.get(k).id),
        exempt_channels: [modlogId, chanId("mod-chat")],
      });
    }

    // --------------------------------------------------------------------------------------- messages
    for (const ch of CHANNELS.filter((ch) => ch.message)) {
      const id = chanId(ch.key);
      const content = render(ch.message);
      if (!id) {
        change(`post the ${ch.key} message in #${ch.name}`);
        continue;
      }
      const recent = (await discord("GET", `/channels/${id}/messages?limit=50`)) ?? [];
      const own = recent.find((m) => m.author?.id === me.id);
      if (own?.content === content) continue;
      const body = { content, allowed_mentions: { parse: [] }, flags: 4 };
      change(`${own ? "edit" : "post"} the ${ch.key} message in #${ch.name}`);
      if (!DRY) await discord(own ? "PATCH" : "POST", own ? `/channels/${id}/messages/${own.id}` : `/channels/${id}/messages`, body);
    }

    // --------------------------------------------------------------------------------------- GitHub webhook
    const githubId = chanId("github");
    let hookUrl = null;
    const existingHook = githubId ? ((await discord("GET", `/channels/${githubId}/webhooks`)) ?? []).find((w) => w.name === "GitHub" && w.token) : null;
    if (existingHook) hookUrl = `${API.replace("/v10", "")}/webhooks/${existingHook.id}/${existingHook.token}/github`;
    else {
      change("create the webhook GitHub in #github");
      if (!DRY) {
        const w = await discord("POST", `/channels/${githubId}/webhooks`, { name: "GitHub" });
        hookUrl = `${API.replace("/v10", "")}/webhooks/${w.id}/${w.token}/github`;
      }
    }
    let githubDone = !opts.github;
    if (opts.github && hookUrl) {
      const hookPrefix = hookUrl.replace(/\/github$/, "").replace(/[^/]+$/, "");
      const list = await gh(["api", `repos/${REPO}/hooks`]);
      let hooks = null;
      try {
        hooks = list.ok ? JSON.parse(list.stdout) : null;
      } catch {
        hooks = null;
      }
      if (Array.isArray(hooks)) {
        if (hooks.some((h) => h.config?.url?.startsWith(hookPrefix))) githubDone = true;
        else {
          change(`add the webhook to ${REPO} on GitHub (${GITHUB_EVENTS.join(", ")}) with gh`);
          if (!DRY) {
            const made = await gh(["api", "-X", "POST", `repos/${REPO}/hooks`, "--input", "-"], JSON.stringify({ name: "web", active: true, events: GITHUB_EVENTS, config: { url: hookUrl, content_type: "json", insecure_ssl: "0" } }));
            githubDone = made.ok;
          } else githubDone = true;
        }
      }
    } else if (opts.github && DRY) {
      change(`add the webhook to ${REPO} on GitHub (${GITHUB_EVENTS.join(", ")}) with gh`);
      githubDone = true;
    }

    // --------------------------------------------------------------------------------------- invite
    let newInvite = null;
    const inviteOk = invite?.guild?.id === gid && !invite.expires_at;
    if (!inviteOk) {
      const why = !code ? "README.md links no invite" : !invite ? `discord.gg/${code} (README.md) no longer works` : invite.guild?.id !== gid ? `discord.gg/${code} opens another server` : `discord.gg/${code} expires ${invite.expires_at}`;
      change(`make a permanent invite to #welcome (${why})`);
      if (!DRY) newInvite = (await discord("POST", `/channels/${chanId("welcome")}/invites`, { max_age: 0, max_uses: 0, temporary: false, unique: false })).code;
    } else say(`discord.gg/${code} (README.md) opens this server and never expires.`);

    // --------------------------------------------------------------------------------------- the rest
    const ourRoles = new Set([gid, ...ROLES.map((s) => roleOf.get(s.key)?.id)]);
    const ourChannels = new Set([...catOf.values(), ...chanOf.values()].filter(Boolean).map((c) => c.id));
    const otherRoles = roles.filter((r) => !ourRoles.has(r.id) && !r.managed).map((r) => r.name);
    const otherChannels = channels.filter((c) => !ourChannels.has(c.id)).map((c) => (c.type === CATEGORY ? `category ${c.name}` : label(c)));

    say("");
    say(DRY ? `Dry run: ${changes} change${changes === 1 ? "" : "s"} to make; nothing was changed.` : changes ? `Done: ${changes} change${changes === 1 ? "" : "s"}.` : "Nothing to change: the server matches the layout.");
    if (otherChannels.length) say(`Not in the layout (kept; delete them in Discord if you do not want them): ${otherChannels.join(", ")}.`);
    if (otherRoles.length) say(`Roles not in the layout (kept): ${otherRoles.join(", ")}.`);
    const steps = [];
    if (newInvite) {
      const files = INVITE_FILES.filter((f) => code && readFileSync(join(ROOT, f), "utf8").includes(`discord.gg/${code}`));
      steps.push(`The new permanent invite is discord.gg/${newInvite}. Replace ${code ? `discord.gg/${code}` : "the link"} with it in ${files.length ? files.join(", ") : "the READMEs"} and on the site (genclass-dev/genclass-site).`);
    }
    if (!githubDone && hookUrl) {
      steps.push(`Add the GitHub webhook (gh could not): ${GH}/settings/hooks/new, Payload URL ${hookUrl} (a secret: anyone with it can post in #github), Content type application/json, "Let me select individual events": Issues, Pull requests, Releases.`);
    }
    if (!DRY && !opts.stay) {
      await discord("DELETE", `/users/@me/guilds/${gid}`);
      steps.push(`The bot left the server. Reset its token, or delete the application, in the developer portal (https://discord.com/developers/applications) unless you will run this again.`);
    } else if (!DRY) steps.push("The bot is still in the server (--stay). Kick it in Server Settings, Members when you are done, and reset its token.");
    steps.push("Give the Maintainer, Moderator and Contributor roles to the people who should have them (Server Settings, Members).");
    if (!DRY && steps.length) {
      say("");
      say("Next:");
      steps.forEach((s, i) => say(`${i + 1}. ${s}`));
    }
    if (warnings.length) say(`\n${warnings.length} warning${warnings.length === 1 ? "" : "s"} above.`);
    return { changes, warnings, invite: newInvite, hookUrl };
  } catch (e) {
    if (e instanceof DiscordError) fail(`Discord refused ${e.message}. The changes before this one were made; fix the cause and run this again (it changes only what still differs).`);
    throw e;
  }
}

const invoked = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch((e) => {
    console.error(`discord-setup: ${e instanceof SetupError ? e.message : e instanceof DiscordError ? `Discord refused ${e.message}. Nothing was changed.` : (e?.stack ?? e)}`);
    process.exit(1);
  });
}
