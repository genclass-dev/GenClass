import { beforeAll, describe, expect, it } from "vitest";

// scripts/discord-setup.mjs against a fake Discord: a fresh server as Discord makes it (its own Text Channels and
// Voice Channels categories, #general, a General voice channel, @everyone with Discord's defaults) plus whatever
// the script creates. The script must make the server match its layout, move the server's own #general instead of
// duplicating it, never delete anything, stop before any change when a check fails, change nothing on a second
// run, and leave the server at the end. The README's invite (discord.gg/kN9kRnFtZm) must open the server it sets up.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any;
beforeAll(async () => {
  setup = await import("../../scripts/discord-setup.mjs");
});

type Obj = Record<string, any>;
const GUILD = "100000000000000000";
const BOT = "1";
const OWNER = "7";
const README_INVITE = "kN9kRnFtZm";

const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
const none = () => new Response(null, { status: 204 });
const bad = (message: string, status = 400, code?: number) => json({ message, code }, status);

/** A fake Discord with one server. `guilds: 0` puts the bot in no server; `invites` maps codes to guild ids. */
function discord(o: { guilds?: number; invites?: Record<string, { guild: string; expires?: string }>; community?: boolean; botPerms?: bigint; userToken?: boolean; channels?: Obj[]; automod?: Obj[]; limit?: number } = {}) {
  const P = setup.P as Record<string, bigint>;
  const everyoneDefault = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MENTION_EVERYONE | P.CREATE_PUBLIC_THREADS | P.SEND_MESSAGES_IN_THREADS | P.MANAGE_MESSAGES;
  let nextId = 1000;
  const id = () => String(nextId++);
  const guild: Obj = {
    id: GUILD, name: "GenClass", owner_id: OWNER, features: o.community ? ["COMMUNITY"] : [], verification_level: 0, explicit_content_filter: 0,
    default_message_notifications: 0, description: null, icon: null, rules_channel_id: null, public_updates_channel_id: null, safety_alerts_channel_id: null,
  };
  const roles = new Map<string, Obj>([
    [GUILD, { id: GUILD, name: "@everyone", permissions: String(everyoneDefault), position: 0, color: 0, hoist: false, mentionable: false, managed: false }],
    ["2", { id: "2", name: "GenClass setup", permissions: String(o.botPerms ?? P.ADMINISTRATOR), position: 1, color: 0, hoist: false, mentionable: false, managed: true }],
  ]);
  const members = new Map<string, Obj>([
    [BOT, { user: { id: BOT, username: "GenClass setup", bot: true }, roles: ["2"] }],
    [OWNER, { user: { id: OWNER, username: "mehar" }, roles: [] }],
  ]);
  const channels = new Map<string, Obj>(
    (
      o.channels ?? [
        { id: "10", type: 4, name: "Text Channels", position: 0, parent_id: null, permission_overwrites: [] },
        { id: "11", type: 0, name: "general", position: 0, parent_id: "10", topic: null, permission_overwrites: [{ id: "2", type: 0, allow: "1024", deny: "0" }] },
        { id: "12", type: 4, name: "Voice Channels", position: 1, parent_id: null, permission_overwrites: [] },
        { id: "13", type: 2, name: "General", position: 0, parent_id: "12", permission_overwrites: [] },
      ]
    ).map((c) => [c.id, c]),
  );
  const automod: Obj[] = o.automod ?? [];
  const messages = new Map<string, Obj[]>();
  const webhooks = new Map<string, Obj[]>();
  const invites: Record<string, { guild: string; expires?: string }> = o.invites ?? { [README_INVITE]: { guild: GUILD } };
  let onboarding: Obj = { enabled: false, prompts: [], default_channel_ids: [], mode: 0 };
  let welcome: Obj | null = null;
  const calls: { method: string; path: string; body: Obj | undefined; headers: Record<string, string> }[] = [];
  const left: string[] = [];
  const created: string[] = [];
  let limited = o.limit ?? 0;
  const snapshot = () => JSON.stringify({ guild, roles: [...roles.values()], channels: [...channels.values()], automod, messages: [...messages], webhooks: [...webhooks], onboarding, welcome, members: [...members.values()] });

  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)) });
    if (!/^Bot \S+$/.test(String((init.headers as Obj)?.authorization))) return bad("401: Unauthorized", 401);
    if (limited > 0) {
      limited--;
      return json({ message: "You are being rate limited.", retry_after: 0.001, global: false }, 429);
    }
    let m: RegExpExecArray | null;
    const community = () => guild.features.includes("COMMUNITY");
    if (path === "/users/@me") return json({ id: BOT, username: "GenClass setup", bot: !o.userToken });
    if (path === "/users/@me/guilds") return json((o.guilds ?? 1) === 0 ? [] : [{ id: GUILD, name: guild.name }]);
    if (path === "/oauth2/applications/@me") return json({ id: "app1" });
    if ((m = /^\/invites\/([\w-]+)$/.exec(path))) {
      const inv = invites[m[1]!];
      return inv ? json({ code: m[1], guild: { id: inv.guild, name: inv.guild === GUILD ? guild.name : "Other" }, expires_at: inv.expires ?? null }) : bad("Unknown Invite", 404, 10006);
    }
    if ((m = /^\/users\/@me\/guilds\/(\d+)$/.exec(path)) && method === "DELETE") {
      left.push(m[1]!);
      return none();
    }
    if (path === `/guilds/${GUILD}`) {
      if (method === "GET") return json(guild);
      if (body.features?.includes("COMMUNITY") && !community()) {
        if (!body.rules_channel_id || !body.public_updates_channel_id || (body.verification_level ?? 0) < 1 || body.explicit_content_filter !== 2) return bad("Invalid Form Body: community requirements");
        if (!channels.has(body.rules_channel_id) || !channels.has(body.public_updates_channel_id)) return bad("Unknown Channel", 400, 10003);
      }
      if (body.description !== undefined && !community() && !body.features?.includes("COMMUNITY")) return bad("description needs COMMUNITY");
      Object.assign(guild, body);
      if (body.icon) guild.icon = "hash";
      return json(guild);
    }
    if (path === `/guilds/${GUILD}/roles`) {
      if (method === "GET") return json([...roles.values()]);
      if (method === "POST") {
        for (const r of roles.values()) if (r.id !== GUILD) r.position++;
        const r = { id: id(), position: 1, managed: false, mentionable: false, hoist: false, color: 0, permissions: "0", ...body };
        roles.set(r.id, r);
        created.push(`role ${r.name}`);
        return json(r);
      }
      for (const { id: rid, position } of body as Obj[]) roles.get(rid)!.position = position;
      return json([...roles.values()]);
    }
    if ((m = new RegExp(`^/guilds/${GUILD}/roles/(\\d+)$`).exec(path)) && method === "PATCH") {
      const r = roles.get(m[1]!);
      if (!r) return bad("Unknown Role", 404, 10011);
      if (r.position >= roles.get("2")!.position && r.id !== GUILD) return bad("Missing Permissions", 403, 50013);
      Object.assign(r, body);
      return json(r);
    }
    if (path === `/guilds/${GUILD}/channels`) {
      if (method === "GET") return json([...channels.values()]);
      if (method === "POST") {
        if ((body.type === 5 || body.type === 15) && !community()) return bad("Invalid Form Body: type needs COMMUNITY", 400, 50035);
        if (body.parent_id && !channels.has(body.parent_id)) return bad("Unknown Channel", 400, 10003);
        const c: Obj = { id: id(), parent_id: null, topic: null, permission_overwrites: [], position: [...channels.values()].filter((x) => x.parent_id === (body.parent_id ?? null) && (x.type === 4) === (body.type === 4)).length, ...body };
        if (c.type === 15) c.available_tags = (c.available_tags ?? []).map((t: Obj) => ({ ...t, id: id() }));
        channels.set(c.id, c);
        created.push(`channel ${c.name}`);
        return json(c);
      }
      for (const { id: cid, position } of body as Obj[]) channels.get(cid)!.position = position;
      return none();
    }
    if ((m = /^\/channels\/(\d+)$/.exec(path)) && method === "PATCH") {
      const c = channels.get(m[1]!);
      if (!c) return bad("Unknown Channel", 404, 10003);
      if (body.type === 5 && !community()) return bad("needs COMMUNITY");
      if (body.available_tags) body.available_tags = body.available_tags.map((t: Obj) => ({ ...t, id: t.id ?? id() }));
      Object.assign(c, body);
      return json(c);
    }
    if ((m = new RegExp(`^/guilds/${GUILD}/members/(\\d+)$`).exec(path))) return members.has(m[1]!) ? json(members.get(m[1]!)) : bad("Unknown Member", 404, 10007);
    if ((m = new RegExp(`^/guilds/${GUILD}/members/(\\d+)/roles/(\\d+)$`).exec(path)) && method === "PUT") {
      members.get(m[1]!)!.roles.push(m[2]!);
      return none();
    }
    if (path === `/guilds/${GUILD}/auto-moderation/rules`) {
      if (method === "GET") return json(automod);
      if ([3, 4, 5].includes(body.trigger_type) && automod.some((r) => r.trigger_type === body.trigger_type)) return bad("Maximum number of rules of this type reached", 400, 200013);
      if (!channels.has(body.actions?.[1]?.metadata?.channel_id)) return bad("alert channel", 400);
      const r = { id: id(), ...body };
      automod.push(r);
      return json(r);
    }
    if (path === `/guilds/${GUILD}/welcome-screen`) {
      if (method === "GET") return welcome ? json(welcome) : bad("Unknown Guild Welcome Screen", 404, 10069);
      if (!community()) return bad("needs COMMUNITY", 403, 50024);
      welcome = body;
      if (!guild.features.includes("WELCOME_SCREEN_ENABLED")) guild.features.push("WELCOME_SCREEN_ENABLED");
      return json(welcome);
    }
    if (path === `/guilds/${GUILD}/onboarding`) {
      if (method === "GET") return json(onboarding);
      if (!community()) return bad("needs COMMUNITY");
      if (body.enabled && body.default_channel_ids.length < 7) return bad("Onboarding needs at least 7 default channels", 400, 50035);
      if (body.default_channel_ids.some((cid: string) => !channels.has(cid))) return bad("Unknown Channel", 400, 10003);
      onboarding = body;
      return json(onboarding);
    }
    if ((m = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      const list = messages.get(m[1]!) ?? [];
      if (method === "GET") return json([...list].reverse());
      if (String(body.content).length > 2000) return bad("Must be 2000 or fewer in length", 400, 50035);
      const msg = { id: id(), author: { id: BOT }, ...body };
      list.push(msg);
      messages.set(m[1]!, list);
      return json(msg);
    }
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path)) && method === "PATCH") {
      const msg = (messages.get(m[1]!) ?? []).find((x) => x.id === m![2]);
      Object.assign(msg!, body);
      return json(msg);
    }
    if ((m = /^\/channels\/(\d+)\/webhooks$/.exec(path))) {
      const list = webhooks.get(m[1]!) ?? [];
      if (method === "GET") return json(list);
      const w = { id: id(), token: `tok${nextId}`, name: body.name, channel_id: m[1] };
      list.push(w);
      webhooks.set(m[1]!, list);
      return json(w);
    }
    if ((m = /^\/channels\/(\d+)\/invites$/.exec(path)) && method === "POST") {
      invites.newcode1 = { guild: GUILD };
      return json({ code: "newcode1", ...body });
    }
    throw new Error(`fake Discord: no route for ${method} ${path}`);
  };
  const find = (name: string, type?: number) => [...channels.values()].find((c) => c.name.toLowerCase() === name.toLowerCase() && (type === undefined || c.type === type));
  const role = (name: string) => [...roles.values()].find((r) => r.name === name);
  return { fetch, calls, guild, roles, channels, automod, messages, webhooks, onboarding: () => onboarding, welcome: () => welcome, members, left, created, snapshot, find, role };
}

/** Runs the script against a fake; `gh` answers with no hooks and accepts the new one unless told otherwise. */
async function run(fake: ReturnType<typeof discord>, argv: string[] = [], o: { gh?: (args: string[], input?: string) => Promise<{ ok: boolean; stdout: string }>; env?: Obj } = {}) {
  const lines: string[] = [];
  const ghCalls: { args: string[]; input?: string }[] = [];
  const gh =
    o.gh ??
    (async (args: string[], input?: string) => {
      ghCalls.push({ args, input });
      return args.includes("-X") ? { ok: true, stdout: "{}" } : { ok: true, stdout: "[]" };
    });
  const result = await setup.main({ argv, env: { DISCORD_BOT_TOKEN: "abc.def.ghi", ...o.env }, fetch: fake.fetch, log: (s: string) => lines.push(s), sleep: async () => {}, gh, now: () => 1_762_000_000_000 });
  return { result, out: lines.join("\n"), ghCalls };
}
const writes = (fake: ReturnType<typeof discord>) => fake.calls.filter((c) => c.method !== "GET");

describe("scripts/discord-setup.mjs", () => {
  it("a dry run reads everything and changes nothing", async () => {
    const fake = discord();
    const before = fake.snapshot();
    const { result, out } = await run(fake, ["--dry-run"]);
    expect(writes(fake)).toEqual([]);
    expect(fake.snapshot()).toBe(before);
    expect(result.changes).toBeGreaterThan(10);
    expect(out).toContain("would create the role Maintainer");
    expect(out).toContain("would turn Community on");
    expect(out).toContain("would create #help (forum) in Help");
    expect(out).toContain(`Dry run: ${result.changes} changes to make; nothing was changed.`);
    expect(out).toContain(`discord.gg/${README_INVITE} (README.md) opens this server and never expires.`);
    expect(fake.left).toEqual([]);
  });

  it("sets a fresh server up to the layout, moves its #general, deletes nothing and leaves", async () => {
    const fake = discord();
    const channelsBefore = fake.channels.size;
    const { result, out, ghCalls } = await run(fake);
    const P = setup.P as Record<string, bigint>;

    // @everyone keeps its ordinary permissions and loses the moderation ones
    const everyone = BigInt(fake.roles.get(GUILD)!.permissions);
    expect(everyone & P.VIEW_CHANNEL).toBeTruthy();
    expect(everyone & P.SEND_MESSAGES).toBeTruthy();
    expect(everyone & P.MENTION_EVERYONE).toBe(0n);
    expect(everyone & P.MANAGE_MESSAGES).toBe(0n);

    // the roles, highest first, all below the bot's own role; the owner is a Maintainer
    const names = ["Maintainer", "Moderator", "Contributor", "Release pings"];
    const ours = names.map((n) => fake.role(n)!);
    expect(ours.every(Boolean)).toBe(true);
    expect([...ours].sort((a, b) => b.position - a.position).map((r) => r.name)).toEqual(names);
    expect(ours.every((r) => r.position < fake.roles.get("2")!.position)).toBe(true);
    expect(BigInt(fake.role("Maintainer")!.permissions) & P.BAN_MEMBERS).toBeTruthy();
    expect(BigInt(fake.role("Moderator")!.permissions) & P.BAN_MEMBERS).toBe(0n);
    expect(BigInt(fake.role("Contributor")!.permissions)).toBe(0n);
    expect(fake.members.get(OWNER)!.roles).toContain(fake.role("Maintainer")!.id);

    // every layout channel exists once, in its category; the server's own #general was moved, not duplicated
    for (const ch of setup.CHANNELS as Obj[]) {
      const group = (t: number) => ({ 0: "text", 5: "text", 15: "forum", 2: "voice", 13: "voice" })[t as 0];
      const same = [...fake.channels.values()].filter((c) => c.name.toLowerCase() === ch.name.toLowerCase() && group(c.type) === group(ch.type));
      expect(same, ch.name).toHaveLength(1);
      const cat = (setup.LAYOUT as Obj[]).find((c) => c.key === ch.cat)!;
      expect(fake.channels.get(same[0]!.parent_id)?.name, ch.name).toBe(cat.name);
      if (ch.topic) expect(same[0]!.topic).toBe(ch.topic);
    }
    const general = fake.find("general", 0)!;
    expect(general.id).toBe("11");
    expect(fake.channels.get(general.parent_id)!.name).toBe("Community");
    // ... and its own overwrite (the bot's) was kept
    expect(general.permission_overwrites.some((o: Obj) => o.id === "2")).toBe(true);
    expect(fake.find("announcements")!.type).toBe(5);
    const help = fake.find("help", 15)!;
    expect(help.available_tags.map((t: Obj) => t.name)).toContain("Solved");
    expect(fake.find("ideas", 15)!.available_tags.find((t: Obj) => t.name === "Planned").moderated).toBe(true);
    // read-only and staff-only channels
    const deny = (c: Obj, roleId: string) => BigInt(c.permission_overwrites.find((o: Obj) => o.id === roleId)?.deny ?? 0);
    expect(deny(fake.find("welcome")!, GUILD) & P.SEND_MESSAGES).toBeTruthy();
    expect(deny(fake.find("github")!, GUILD) & P.SEND_MESSAGES).toBeTruthy();
    expect(deny(fake.find("mod-chat")!, GUILD) & P.VIEW_CHANNEL).toBeTruthy();
    expect(deny(fake.find("general")!, GUILD)).toBe(0n);
    // nothing deleted: Discord's own categories and voice channel are still there, and named at the end
    expect(fake.channels.size).toBe(channelsBefore + fake.created.filter((c) => c.startsWith("channel")).length);
    expect(fake.find("Text Channels", 4)).toBeTruthy();
    expect(out).toMatch(/Not in the layout \(kept.*category Text Channels, category Voice Channels, the voice channel General/);

    // Community and the server settings
    expect(fake.guild.features).toContain("COMMUNITY");
    expect(fake.guild.rules_channel_id).toBe(fake.find("rules")!.id);
    expect(fake.guild.public_updates_channel_id).toBe(fake.find("mod-log")!.id);
    expect(fake.guild.safety_alerts_channel_id).toBe(fake.find("mod-log")!.id);
    expect(fake.guild.verification_level).toBe(1);
    expect(fake.guild.explicit_content_filter).toBe(2);
    expect(fake.guild.default_message_notifications).toBe(1);
    expect(fake.guild.description).toBe(setup.GUILD.description);
    expect(fake.guild.icon).toBe("hash");

    // welcome screen, onboarding with the Release pings question, AutoMod
    expect(fake.welcome()!.welcome_channels).toHaveLength(5);
    expect(fake.welcome()!.welcome_channels[0].channel_id).toBe(fake.find("rules")!.id);
    const ob = fake.onboarding();
    expect(ob.enabled).toBe(true);
    expect(ob.prompts[0].options[0].role_ids).toEqual([fake.role("Release pings")!.id]);
    expect(ob.default_channel_ids).toContain(fake.find("help", 15)!.id);
    expect(ob.default_channel_ids).not.toContain(fake.find("mod-chat")!.id);
    expect(fake.automod.map((r) => r.trigger_type).sort()).toEqual([1, 3, 4, 5]);
    const links = fake.automod.find((r) => r.trigger_type === 1)!;
    expect(links.trigger_metadata.allow_list).toEqual([`discord.gg/${README_INVITE}`]);
    expect(links.actions[1].metadata.channel_id).toBe(fake.find("mod-log")!.id);
    expect(links.exempt_roles).toContain(fake.role("Contributor")!.id);

    // the welcome and rules messages: under Discord's limit, with real mentions and pings off
    const welcomeMsg = fake.messages.get(fake.find("welcome")!.id)![0]!;
    const rulesMsg = fake.messages.get(fake.find("rules")!.id)![0]!;
    for (const msg of [welcomeMsg, rulesMsg]) {
      expect(msg.content.length).toBeLessThanOrEqual(2000);
      expect(msg.content).not.toMatch(/\{[#@]/);
      expect(msg.allowed_mentions).toEqual({ parse: [] });
    }
    expect(welcomeMsg.content).toContain(`<#${fake.find("help", 15)!.id}>`);
    expect(rulesMsg.content).toContain(`<@&${fake.role("Moderator")!.id}>`);
    expect(rulesMsg.content).toContain("CODE_OF_CONDUCT.md");

    // the GitHub webhook, added to the repository with gh (issues, pull requests, releases)
    const hook = fake.webhooks.get(fake.find("github")!.id)![0]!;
    expect(result.hookUrl).toBe(`https://discord.com/api/webhooks/${hook.id}/${hook.token}/github`);
    const added = ghCalls.find((c) => c.args.includes("-X"))!;
    expect(added.args).toContain(`repos/${setup.REPO}/hooks`);
    expect(JSON.parse(added.input!)).toMatchObject({ events: setup.GITHUB_EVENTS, config: { url: result.hookUrl, content_type: "json" } });
    expect(out).not.toContain(hook.token); // the URL is a secret: printed only when gh could not add it

    // the README's invite opens this server, so no new invite; every write carried the audit-log reason; the bot left
    expect(result.invite).toBeNull();
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/invites"))).toEqual([]);
    expect(writes(fake).every((c) => c.headers["x-audit-log-reason"])).toBe(true);
    expect(fake.left).toEqual([GUILD]);
    expect(out).toContain("The bot left the server.");
    expect(out).toContain(`Done: ${result.changes} changes.`);
  });

  it("a second run finds nothing to change", async () => {
    const fake = discord();
    await run(fake, ["--stay"]);
    expect(fake.left).toEqual([]);
    const before = fake.snapshot();
    fake.calls.length = 0;
    const hookUrl = `https://discord.com/api/webhooks/${fake.webhooks.get(fake.find("github")!.id)![0]!.id}/`;
    const { result, out } = await run(fake, ["--stay"], { gh: async () => ({ ok: true, stdout: JSON.stringify([{ config: { url: `${hookUrl}secret/github` } }]) }) });
    expect(writes(fake)).toEqual([]);
    expect(fake.snapshot()).toBe(before);
    expect(result.changes).toBe(0);
    expect(out).toContain("Nothing to change: the server matches the layout.");
  });

  it("edits its own messages in place when their text changes, and keeps a kept AutoMod rule", async () => {
    const fake = discord({ automod: [{ id: "a1", name: "Anti-spam (Discord's)", trigger_type: 3, trigger_metadata: {}, actions: [] }] });
    await run(fake, ["--stay"]);
    const welcomeId = fake.find("welcome")!.id;
    fake.messages.get(welcomeId)![0]!.content = "old text";
    fake.calls.length = 0;
    const { out } = await run(fake, ["--stay"]);
    expect(fake.messages.get(welcomeId)).toHaveLength(1);
    expect(fake.messages.get(welcomeId)![0]!.content).not.toBe("old text");
    expect(out).toContain("edit the welcome message in #welcome");
    expect(fake.automod.filter((r) => r.trigger_type === 3)).toHaveLength(1);
    expect(out).toContain(`kept the AutoMod rule "Anti-spam (Discord's)"`);
  });

  it("stops before any change when the README's invite opens another server", async () => {
    const fake = discord({ invites: { [README_INVITE]: { guild: "999" } } });
    await expect(run(fake)).rejects.toThrow(new RegExp(`opens "Other" \\(999\\), not "GenClass" \\(${GUILD}\\).*Nothing was changed`));
    expect(writes(fake)).toEqual([]);
    // --guild overrides it, with a warning
    const { out } = await run(fake, ["--guild", GUILD, "--stay"]);
    expect(out).toContain(`warning: discord.gg/${README_INVITE} (README.md) opens another server`);
    expect(fake.guild.features).toContain("COMMUNITY");
  });

  it("makes a permanent invite when the README's is gone, and names the files to update", async () => {
    const fake = discord({ invites: {} });
    const { result, out } = await run(fake);
    expect(result.invite).toBe("newcode1");
    const made = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/invites"))!;
    expect(made.path).toBe(`/channels/${fake.find("welcome")!.id}/invites`);
    expect(made.body).toMatchObject({ max_age: 0, max_uses: 0 });
    expect(out).toContain("The new permanent invite is discord.gg/newcode1.");
    for (const f of setup.INVITE_FILES) expect(out).toContain(f);
  });

  it("refuses a user token, a bot without Administrator, and a channel it cannot convert", async () => {
    await expect(run(discord({ userToken: true }))).rejects.toThrow(/must be a bot's token/);
    const noAdmin = discord({ botPerms: 0n });
    await expect(run(noAdmin)).rejects.toThrow(/needs the Administrator permission.*Nothing was changed/);
    expect(writes(noAdmin)).toEqual([]);
    const clash = discord({ channels: [{ id: "20", type: 2, name: "help", position: 0, parent_id: null, permission_overwrites: [] }] });
    await expect(run(clash)).rejects.toThrow(/#help exists as a voice channel.*forum channel.*Nothing was changed/);
    expect(writes(clash)).toEqual([]);
  });

  it("prints the link that adds the bot when it is in no server", async () => {
    const fake = discord({ guilds: 0 });
    const { result, out } = await run(fake);
    expect(result.changes).toBe(0);
    expect(out).toContain("https://discord.com/oauth2/authorize?client_id=app1&scope=bot&permissions=8");
    expect(out).toContain('the server discord.gg/kN9kRnFtZm opens ("GenClass")');
    expect(writes(fake)).toEqual([]);
  });

  it("waits out a rate limit and tells the owner the GitHub step when gh cannot add the webhook", async () => {
    const fake = discord({ limit: 3 });
    const { result, out } = await run(fake, [], { gh: async () => ({ ok: false, stdout: "" }) });
    expect(fake.calls.filter((c) => c.path === "/users/@me")).toHaveLength(4); // three 429s, then the answer
    expect(fake.guild.features).toContain("COMMUNITY");
    expect(out).toContain(`Add the GitHub webhook (gh could not): https://github.com/${setup.REPO}/settings/hooks/new, Payload URL ${result.hookUrl}`);
  });

  it("refuses an unknown option and a missing token before any call", async () => {
    const fake = discord();
    await expect(run(fake, ["--force"])).rejects.toThrow(/unknown option --force/);
    await expect(setup.main({ argv: [], env: {}, fetch: fake.fetch, log: () => {} })).rejects.toThrow(/set DISCORD_BOT_TOKEN/);
    expect(fake.calls).toEqual([]);
  });

  it("the layout is consistent: keys unique, every mention resolves, welcome screen and onboarding point at real channels", () => {
    const keys = (setup.CHANNELS as Obj[]).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const names = (setup.CHANNELS as Obj[]).map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const text of [setup.WELCOME, setup.RULES] as string[]) {
      for (const [, k] of text.matchAll(/\{#([a-z-]+)\}/g)) expect(keys, k).toContain(k);
      for (const [, k] of text.matchAll(/\{@&([a-z-]+)\}/g)) expect((setup.ROLES as Obj[]).map((r) => r.key), k).toContain(k);
    }
    for (const w of setup.WELCOME_SCREEN.channels) expect(keys).toContain(w.key);
    expect(setup.WELCOME_SCREEN.description.length).toBeLessThanOrEqual(140);
    expect((setup.ROLES as Obj[]).map((r) => r.key)).toContain(setup.ONBOARDING.option.role);
    expect(setup.GUILD.description.length).toBeLessThanOrEqual(300);
    for (const ch of setup.CHANNELS as Obj[]) {
      if (ch.topic) expect(ch.topic.length, ch.name).toBeLessThanOrEqual(ch.type === 15 ? 4096 : 1024);
      if (ch.tags) expect(ch.tags.length, ch.name).toBeLessThanOrEqual(20);
    }
    expect(setup.repoInvites("a discord.gg/abc and https://discord.gg/abc then discord.gg/x-y")).toEqual(["abc", "x-y"]);
  });
});
