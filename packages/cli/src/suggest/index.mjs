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
import { readNotes, saveNotes } from "../store.mjs";
import { agree, clean, good, header, note, para, rule, spinner, typed, visible, warn, width, wrap } from "../tui.mjs";
import { AREAS, runChecks } from "./checks.mjs";
import { buildDigest, describeDigest } from "./digest.mjs";
import { collectRepoFacts } from "./repo.mjs";
import { collectSiteFacts } from "./site.mjs";

/** Items shown in full when no server said how many (not signed in, or a server without the route). */
export const FREE_SHOWN = 3;

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
 * FREE_SHOWN are shown in full with the catalog's own words.
 */
export function layOut(results, plan) {
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
  const shown = plan ? plan.items.length : Math.min(FREE_SHOWN, rest.length);
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
  const title = `  ${c.bold(String(i.n).padStart(2))}  ${c.bold(clean(i.title, 90))}`;
  const tag = `${c.gray(`${AREAS[i.area] ?? i.area} ${sym.dot}`)} ${dots(i.weight)}`;
  if (visible(title) + 2 + visible(tag) <= width()) out(`${title}  ${tag}`);
  else {
    out(title);
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
  if (!url && !quiet && !o.yes && interactive()) {
    para("Where is this app live? With its address GenClass also checks what search engines, AI assistants and visitors get from it.", "  ");
    const a = await typed(`  ${c.bold("Address")} ${c.gray("(or Enter for the repository only)")} `);
    url = siteAddress(a);
    if (a && !url) warn("That is not a site address, so only the repository is checked this time.");
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
  const app = { name: repo.name ?? null, framework: st.project.label || null, site: site?.reachable ? url : null, payments: repo.payments?.provider ?? null, hosting: repo.hosting?.provider ?? null };
  const digest = buildDigest(app, results);

  // ---- the plan
  const creds = readCredentials();
  let plan = null;
  let planNote = null;
  if (o.noModel) planNote = "Ordered by the checks' own weights (--no-model: nothing was sent).";
  else if (!failed.length) planNote = null;
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
      const sp = quiet ? null : spinner("Writing the plan for your app");
      const r = await requestPlan(creds, digest, { fetchFn: deps.fetchFn });
      if (r.ok) {
        plan = { ...r, lockedIds: r.lockedIds ?? [] };
        sp?.stop("ok", r.source === "model" ? "The plan is written for your app." : r.limited ? "Today's plans are used up, so this one is ordered by the checks' own weights." : "Ordered by the checks' own weights.");
      } else {
        sp?.stop("warn", r.missing ? "This genclass.dev has no suggestions yet: ordered by the checks' own weights." : `No plan from genclass.dev (${clean(r.reason, 120)}): ordered by the checks' own weights.`);
      }
    }
  }
  const items = layOut(results, plan);
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
          failed: items.map((i) => ({ n: i.n, id: i.id, area: i.area, title: i.title, weight: i.weight, evidence: i.evidence, ...(i.open ? { why: i.why, do: i.step, prompt: i.prompt } : { locked: true }) })),
          not_checked: unknown.map((r) => r.id),
          upgrade_url: locked.length ? (plan?.upgradeUrl ?? null) : null,
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
  const fullCount = o.all ? items.length : 5;
  for (const i of items) printItem(i, i.open && i.n <= fullCount);
  if (items.some((i) => i.open && i.n > fullCount)) {
    out();
    note(`Items ${fullCount + 1} and after are listed by title. ${c.cyan("npx genclass suggest --all")} prints each one's reason, first step and prompt.`);
  }
  if (locked.length) {
    out();
    rule();
    out(`  ${c.bold(`The reason, the first step and the agent prompt for the other ${locked.length} come with the Team plan.`)}`);
    note(`${plan?.plan?.name ?? "Free"} shows the plan for the first ${items.length - locked.length}. Every check above is measured for free. Plans: ${c.cyan(plan?.upgradeUrl ?? "https://genclass.dev/pricing")}`);
  }
  if (unknown.length) {
    out();
    // without the site's address these could not be measured: a count is enough, the line above says how to get them
    if (!site?.reachable) note(`${unknown.length} more checks need your live site${url ? "" : `: ${c.cyan("npx genclass suggest https://your-site.com")}`}.`);
    else note(`${unknown.length} check${unknown.length === 1 ? "" : "s"} could not be measured on this site this time.`);
  }
  out();
  if (failed.length) {
    good("Fix one, then run it again: everything is measured afresh.");
    out(`    ${c.cyan("npx genclass suggest")}`);
    note(`With a coding agent: paste an "Ask your agent" block, or tell it to run ${c.cyan("npx genclass suggest --json")} and work through the list.`);
  }
  out();
  return url && site && !site.reachable && o.url ? 1 : 0;
}
