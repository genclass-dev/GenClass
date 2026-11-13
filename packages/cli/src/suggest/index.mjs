// `genclass suggest`: what this app is missing, most important first. It measures the repository (repo.mjs) and the
// live site (site.mjs), runs the catalog of checks over those facts (checks.mjs), asks genclass.dev to order and
// explain what failed for this app (api.mjs requestPlan), and prints the plan.
//
// Invariants:
// - Every line printed about the app is a check's result on a measured fact. The model on genclass.dev orders the
//   failed checks and words the reasons; it cannot add one (the server drops any id that was not sent), and without
//   it the checks' own weights and words are used.
// - Nothing leaves this machine except the requests to the app's own site and the digest (digest.mjs). The digest is
//   shown and agreed to before the first time it is sent for a project; --yes agrees, --no-model sends nothing.
// - The plan's numbers are the server's: how many items an account's plan is shown in full. The rest are still
//   listed with their titles and evidence (those are measured here), with where the plans are.
// - Text from the server and from the site is cleaned of control characters before it is printed (tui.mjs clean).

import { readCredentials } from "../../../runtime/bin/lib/account.mjs";
import { inspectProject } from "../../../runtime/bin/lib/init.mjs";
import { c, interactive, out, sym } from "../../../runtime/bin/lib/ui.mjs";
import { requestPlan } from "../api.mjs";
import { proSeen } from "../paywall.mjs";
import { copyText, findAgents, startAgent } from "../fix.mjs";
import { readNotes, saveNotes } from "../store.mjs";
import { agree, clean, good, header, note, para, proBox, PROMPT, rule, spinner, typed, visible, warn, width, wrap } from "../tui.mjs";
import { AREAS, runChecks } from "./checks.mjs";
import { buildDigest, describeDigest } from "./digest.mjs";
import { collectRepoFacts } from "./repo.mjs";
import { collectSiteFacts } from "./site.mjs";

/** Items shown in full when no server said how many (not signed in, or a server without the route). */
export const FREE_SHOWN = 1;

/** A site address as typed: with https:// in front of a bare host, or null when it is not one. */
export function siteAddress(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".") ? u.origin + (u.pathname === "/" ? "" : u.pathname) : null;
  } catch {
    return null;
  }
}

/**
 * The plan to print: the failed checks in order, each with the words to show and whether it is shown in full.
 * `plan` is the server's answer (api.mjs requestPlan) or null; without it the order is by weight and the first
 * FREE_SHOWN are shown in full with the catalog's own words, or every one for an account with Pro (`paid`: no plan
 * was asked for, --no-model or nothing agreed to send, but the account's own plan shows them all).
 */
export function layOut(results, plan, paid = false) {
  const failed = results.filter((r) => r.status === "fail");
  const by = new Map(failed.map((r) => [r.id, r]));
  const order = [];
  const full = new Map();
  if (plan) {
    for (const i of plan.items) if (by.has(i.id) && !full.has(i.id)) full.set(i.id, i) && order.push(i.id);
    for (const id of plan.lockedIds ?? []) if (by.has(id) && !order.includes(id)) order.push(id);
  }
  // whatever the server did not name (or everything, without a server), heaviest first
  const rest = failed.filter((r) => !order.includes(r.id)).sort((a, b) => b.weight - a.weight);
  const shown = plan ? plan.items.length : paid ? rest.length : Math.min(FREE_SHOWN, rest.length);
  for (const r of rest) order.push(r.id);
  return order.map((id, n) => {
    const r = by.get(id);
    const words = full.get(id);
    const open = plan ? full.has(id) : n < shown;
    return { ...r, n: n + 1, open, why: (open && words?.why) || r.why, step: (open && words?.step) || r.fix, prompt: (open && words?.prompt) || r.prompt, fromModel: !!(open && words?.why) };
  });
}

const dots = (weight) => (weight >= 5 ? c.red("urgent") : weight >= 4 ? c.yellow("important") : weight >= 3 ? c.gray("worth doing") : c.gray("polish"));

/** Prints one item of the plan. */
function printItem(i, full) {
  out();
  const tag = `${c.gray(`${AREAS[i.area] ?? i.area} ${sym.dot}`)} ${dots(i.weight)}`;
  // the title on as many lines as it takes at this width, the tag after it or under it
  const [first = "", ...more] = wrap(clean(i.title, 90), width() - 8);
  const title = `  ${c.bold(String(i.n).padStart(2))}  ${c.bold(first)}`;
  if (!more.length && visible(title) + 2 + visible(tag) <= width() - 2) out(`${title}  ${tag}`);
  else {
    out(title);
    for (const l of more) out(`      ${c.bold(l)}`);
    out(`      ${tag}`);
  }
  for (const e of i.evidence ?? []) {
    const [first = "", ...rest] = wrap(clean(e, 400), width() - 10);
    out(`      ${c.gray(`${sym.arrow} ${first}`)}`);
    for (const l of rest) out(`        ${c.gray(l)}`);
  }
  if (!full) return;
  para(clean(i.why, 600), "      ");
  out(`      ${c.cyan("Do")}  ${wrap(clean(i.step, 400), width() - 12).join("\n          ")}`);
  out(`      ${c.cyan("Ask your agent")}`);
  para(clean(i.prompt, 1000), "        ", c.gray);
}

/**
 * @param {{ cwd?: string, url?: string | null, json?: boolean, yes?: boolean, noModel?: boolean, all?: boolean, fromSetup?: boolean }} o
 * @param {{ fetchFn?: typeof fetch, dns?: object, runGit?: Function }} [deps]
 * @returns {Promise<number>} the exit code: 0, or 1 when the site was named and could not be reached at all
 */
/** "Nov 12" for an ISO time. */
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** The model's own ideas (Pro): not measured, and said so. */
function printIdeas(ideas, all) {
  out();
  rule();
  out(`  ${c.bold("Ideas from the model")}`);
  note("Not measured: judged from your app and its site.");
  ideas.forEach((d, i) => {
    out();
    out(`  ${c.bold(String(i + 1).padStart(2))}  ${c.bold(clean(d.title, 90))}`);
    if (!all && i >= 5) return;
    if (d.why) para(clean(d.why, 600), "      ");
    if (d.step) out(`      ${c.cyan("Do")}  ${wrap(clean(d.step, 400), width() - 12).join("\n          ")}`);
    if (d.prompt) {
      out(`      ${c.cyan("Ask your agent")}`);
      para(clean(d.prompt, 1000), "        ", c.gray);
    }
  });
  if (!all && ideas.length > 6) note(`Ideas 7 and after are listed by title: ${c.cyan("npx genclass suggest --all")} prints each one in full.`);
}

/** The website designs (Pro): each inspired by a real site, with the whole prompt to paste into a coding agent. */
function printDesigns(designs) {
  out();
  rule();
  out(`  ${c.bold("Website designs")}`);
  note("The model's choice of sites that fit what you do.");
  designs.forEach((d, i) => {
    out();
    out(`  ${c.bold(String(i + 1).padStart(2))}  ${c.bold(clean(d.title, 90))}`);
    out(`      ${c.gray("Inspired by")} ${c.cyan(clean(d.inspiredBy, 200))}`);
    if (d.why) para(clean(d.why, 600), "      ");
    out(`      ${c.cyan("Prompt for Claude")} ${c.gray("(copy it all)")}`);
    para(clean(d.prompt, 4000), "        ", c.gray);
  });
}

/**
 * The whole list as one prompt for a coding agent in the repository: each item with its reason, first step and
 * prompt (the ones the plan shows), the rest by title, most important first, and how to check the work.
 */
export function suggestionsPrompt(items, url = null) {
  const lines = [
    `GenClass checked this repository${url ? ` and the live site ${url}` : ""} and found ${items.length} thing${items.length === 1 ? "" : "s"} to fix, most important first. Work through them one at a time, in this order. After each one, run \`npx genclass suggest --json\` and check that it no longer lists it.`,
    "",
  ];
  for (const i of items) {
    lines.push(`${i.n}. ${i.title}${i.evidence ? ` (found: ${i.evidence})` : ""}`);
    if (i.open) {
      if (i.why) lines.push(`   Why: ${i.why}`);
      if (i.step) lines.push(`   First step: ${i.step}`);
      if (i.prompt) lines.push(`   ${i.prompt}`);
    } else lines.push("   Look at what this check measures and fix it the usual way for this framework.");
    lines.push("");
  }
  return lines.join("\n").trim();
}

/**
 * After the list, on a terminal: hand every item to a coding agent in one go, as numbered choices (each agent
 * installed here, copy the prompt, print it). The agent starts in this folder with the prompt and the terminal.
 */
async function handToAgent(items, url, cwd, o, deps, plan) {
  const prompt = suggestionsPrompt(items, url);
  const agents = (deps.agents ?? findAgents)(o.agent ?? null);
  const locked = items.filter((i) => !i.open).length;
  out();
  rule();
  out(`  ${c.bold(`Hand ${items.length === 1 ? "it" : `all ${items.length}`} to your coding agent?`)}`);
  if (locked) note(`On ${plan?.plan?.name ?? "Free"} it gets the steps for ${items.length - locked} of them and the rest by title. Every step for every one: npx genclass upgrade`);
  const choices = [
    ...agents.map((a) => [`Start ${a.name} with the list`, async () => {
      out(`  ${c.gray(sym.arrow)} Starting ${c.bold(a.name)} in this folder, with the list.`);
      const code = await (deps.start ?? startAgent)(a, prompt, cwd);
      if (code === null) {
        warn(`${a.name} did not start. The prompt, to paste by hand:`);
        out(prompt);
      }
    }]),
    ["Copy the prompt", async () => ((await (deps.copy ?? copyText)(prompt)) ? good("Copied. Paste it into your coding agent.") : out(prompt))],
    ["Print the prompt", async () => out(`\n${prompt}\n`)],
    // each website design's own prompt, to paste into Claude whole
    ...(plan?.designs ?? []).map((d) => [`Copy the design prompt: ${clean(d.title, 40)}`, async () => ((await (deps.copy ?? copyText)(d.prompt)) ? good("Copied. Paste it into Claude in your repository.") : out(d.prompt))]),
  ];
  choices.forEach(([label], i) => out(`  ${c.gray(String(i + 1).padStart(2))}  ${label}`));
  if (!agents.length) note("No coding agent's command found here (claude, codex, cursor-agent, gemini).");
  out();
  const a = await typed(`  ${PROMPT()} ${c.gray("a number ·")} ${c.bold("q")} ${c.gray("stop")}  `);
  const pick = a !== null && /^\d+$/.test(a.trim()) ? choices[Number(a.trim()) - 1] : null;
  if (pick) await pick[1]();
}

export async function suggest(o = {}, deps = {}) {
  const st = inspectProject({ cwd: o.cwd });
  const cwd = st.cwd;
  const notes = readNotes(cwd);
  const quiet = !!o.json;

  // ---- the facts
  const repo = collectRepoFacts(cwd, deps.runGit ? { runGit: deps.runGit } : {});
  let url = siteAddress(o.url) ?? siteAddress(notes.site) ?? siteAddress(repo.site?.url);
  if (o.url && !siteAddress(o.url)) {
    warn(`${clean(o.url, 80)} is not a site address. Give it as https://example.com.`);
    return 2;
  }
  if (!quiet) header({ app: repo.name ?? st.project.name, framework: st.project.label || null, account: readCredentials()?.account?.email ?? null });
  // asked once per project: Enter (the repository only) is remembered, and the address can still be given
  if (!url && !notes.repoOnly && !quiet && !o.yes && interactive()) {
    para("Where is this app live? With its address GenClass also checks what search engines, AI assistants and visitors get from it.", "  ");
    const a = await typed(`  ${c.bold("Address")} ${c.gray("(or Enter for the repository only)")} `);
    url = siteAddress(a);
    if (a && !url) warn("That is not a site address, so only the repository is checked this time.");
    if (a === "") saveNotes(cwd, { repoOnly: true });
  }
  let site = null;
  if (url) {
    const sp = quiet ? null : spinner(`Reading ${url}`);
    site = await collectSiteFacts(url, { fetchFn: deps.fetchFn, dns: deps.dns });
    if (sp) site.reachable ? sp.stop("ok", `Read ${url} ${c.gray(`(${Math.round((site.elapsedMs ?? 0) / 100) / 10} s)`)}`) : sp.stop("warn", `Could not read ${url}: ${clean(site.error ?? "no answer", 120)}. Checking the repository only.`);
  }

  // ---- the checks
  const results = runChecks({ repo, site: site?.reachable ? site : null });
  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass");
  const unknown = results.filter((r) => r.status === "unknown");
  const about = site?.reachable ? [site.defaultTitle ? null : site.title, site.description].filter(Boolean).join(". ") || null : null;
  const app = { name: repo.name ?? null, framework: st.project.label || null, site: site?.reachable ? url : null, about, payments: repo.payments?.provider ?? null, hosting: repo.hosting?.provider ?? null };
  const digest = buildDigest(app, results);

  // ---- the plan
  const creds = readCredentials();
  let plan = null;
  let planNote = null;
  if (o.noModel) planNote = "Ordered by the checks' own weights (--no-model: nothing was sent).";
  else if (!failed.length && !app.site) planNote = null;
  else if (!creds) planNote = `Ordered by the checks' own weights. Sign in (${c.cyan("npx genclass login")}) and the order and the reasons are written for your app.`;
  else {
    let agreed = o.yes || notes.sendOk === true;
    if (!agreed && !quiet && interactive()) {
      out();
      out(`  ${c.bold("To write your plan, this is sent to genclass.dev:")}`);
      for (const l of describeDigest(digest)) para(l, "    ", c.gray);
      agreed = (await agree("Send it?")) === true;
      if (agreed) saveNotes(cwd, { sendOk: true });
    }
    if (!agreed) planNote = `Ordered by the checks' own weights: nothing was sent. ${quiet || !interactive() ? "Pass --yes to send the failed checks to genclass.dev for a plan written for your app." : ""}`.trim();
    else {
      const sp = quiet ? null : spinner("Writing the plan for your app (up to a minute)");
      const r = await requestPlan(creds, digest, { fetchFn: deps.fetchFn });
      if (r.ok) {
        plan = { ...r, lockedIds: r.lockedIds ?? [] };
        sp?.stop("ok", r.cachedAt ? `Your plan from ${day(r.cachedAt)}.` : r.source === "model" ? "The plan is written for your app." : r.limited ? "Today's plans are used up, so this one is ordered by the checks' own weights." : "Ordered by the checks' own weights.");
      } else {
        sp?.stop("warn", r.missing ? "This genclass.dev has no suggestions yet: ordered by the checks' own weights." : `No plan from genclass.dev (${clean(r.reason, 120)}): ordered by the checks' own weights.`);
      }
    }
  }
  // no plan from genclass.dev (--no-model, nothing sent): the account's own plan says how much is shown
  const items = layOut(results, plan, !plan && !!creds && (o.paid === true || proSeen()));
  const locked = items.filter((i) => !i.open);
  saveNotes(cwd, { ...(site?.reachable ? { site: url } : {}), suggest: { at: new Date().toISOString(), failed: failed.length, urgent: failed.filter((r) => r.weight >= 4).length, passed: passed.length, top: items.slice(0, 3).map((i) => i.id) } });

  if (o.json) {
    out(
      JSON.stringify(
        {
          site: site?.reachable ? url : null,
          source: plan?.source ?? "checks",
          plan: plan?.plan ?? null,
          passed: passed.length,
          failed: items.filter((i) => i.open).map((i) => ({ n: i.n, id: i.id, area: i.area, title: i.title, weight: i.weight, evidence: i.evidence, why: i.why, do: i.step, prompt: i.prompt })),
          // what the plan does not show is counted, not listed (Free: the first suggestion only)
          more: { checks: locked.length, ideas: plan?.ideasLocked ?? 0, designs: plan?.designsLocked ?? 0 },
          ideas: plan?.ideas ?? [],
          designs: (plan?.designs ?? []).map((d) => ({ title: d.title, inspired_by: d.inspiredBy, why: d.why, prompt: d.prompt })),
          cached_at: plan?.cachedAt ?? null,
          not_checked: unknown.map((r) => r.id),
          upgrade_url: locked.length || plan?.ideasLocked || plan?.designsLocked ? (plan?.upgradeUrl ?? null) : null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  // ---- print
  out();
  const total = passed.length + failed.length;
  out(`  ${c.bold(`${passed.length} of ${total} checks pass.`)} ${failed.length ? `${failed.length} to do${failed.some((r) => r.weight >= 5) ? `, ${failed.filter((r) => r.weight >= 5).length} of them urgent` : ""}.` : c.green("Nothing to do.")}`);
  if (planNote) note(planNote);
  if (!site?.reachable) note(url ? "The site could not be read, so only the repository was checked." : `Only the repository was checked. With the site's address there is more: ${c.cyan("npx genclass suggest https://your-site.com")}`);
  // Free: the first suggestion only, and how many more there are (the rest is Pro's, the owner's call 2026-11-12)
  const fullCount = o.all ? items.length : 5;
  for (const i of items.filter((x) => x.open)) printItem(i, i.n <= fullCount);
  if (items.some((i) => i.open && i.n > fullCount)) {
    out();
    note(`Items ${fullCount + 1} and after are listed by title. ${c.cyan("npx genclass suggest --all")} prints each one's reason, first step and prompt.`);
  }
  if (plan?.ideas?.length) printIdeas(plan.ideas, o.all);
  if (plan?.designs?.length) printDesigns(plan.designs);
  const hiddenIdeas = plan?.ideasLocked ?? 0;
  const hiddenDesigns = plan?.designsLocked ?? 0;
  const more = locked.length + hiddenIdeas + hiddenDesigns;
  if (more) {
    out();
    rule();
    const parts = [locked.length && `${locked.length} from your checks`, hiddenIdeas && `${hiddenIdeas} idea${hiddenIdeas === 1 ? "" : "s"} from the model`, hiddenDesigns && `${hiddenDesigns} website design${hiddenDesigns === 1 ? "" : "s"} inspired by sites like yours`].filter(Boolean);
    const up = plan?.upgradePlan ?? {};
    proBox(`${more} more suggestion${more === 1 ? "" : "s"} for this app: ${parts.join(", ")}, each with a prompt for your coding agent.`, { plan: up.plan ?? "Pro", trialDays: up.trialDays ?? null, price: up.price ?? null, upgradeUrl: plan?.upgradeUrl ?? null });
    if (plan?.cachedAt) note(`This is your plan from ${day(plan.cachedAt)}: on Free it stays this one. Pro writes it again every time you run this.`);
  }
  if (unknown.length) {
    out();
    // without the site's address these could not be measured: a count is enough, the line above says how to get them
    if (!site?.reachable) note(`${unknown.length} more checks need your live site${url ? "." : `: ${c.cyan("npx genclass suggest https://your-site.com")}`}`);
    else note(`${unknown.length} check${unknown.length === 1 ? "" : "s"} could not be measured on this site this time.`);
  }
  out();
  if (failed.length && !more) {
    good("Fix one, then run this again: it measures afresh.");
    out(`    ${c.cyan("npx genclass suggest")}`);
    note(`With a coding agent: paste an "Ask your agent" block, or tell it to run ${c.cyan("npx genclass suggest --json")} and work through the list.`);
  }
  // on a terminal: every item handed to a coding agent in one go (Claude Code, Codex, Cursor, Gemini CLI)
  if ((items.some((i) => i.open) || plan?.designs?.length) && interactive() && !o.yes) await handToAgent(items.filter((i) => i.open), site?.reachable ? url : null, cwd, o, deps, plan);
  out();
  return url && site && !site.reachable && o.url ? 1 : 0;
}
