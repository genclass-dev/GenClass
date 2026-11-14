// `genclass dashboard`: one app, whole, in the terminal. What GenClass found on the live site (problems by kind and
// page, measured visual checks), what was handled, visitors, what the coding agent did with the findings, and what
// the GitHub App is doing on the repository. The same numbers the browser dashboard shows, read with the CLI session.
//
// Invariants:
// - Read only: one GET for the state (state.mjs) and one for the app's numbers (api.mjs fetchApp). Nothing is
//   written, nothing is opened unless --open is passed.
// - Short first: a handful of numbers, the top problems and one line per part. --all shows every row.
// - Every number is the server's. Nothing here adds, scales or guesses; a part with nothing to show says so in one
//   line, or what to do to fill it.
// - Text from the server (app names, page routes, kinds) is data: it goes through tui.mjs clean() before printing.

import { readCredentialsFor } from "../../runtime/bin/lib/account.mjs";
import { hostConfig, hostUrl } from "../../runtime/bin/lib/host.mjs";
import { c, interactive, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { openBrowser, planNow, signIn } from "./actions.mjs";
import { fetchApp, signInIsOld } from "./api.mjs";
import { planName, readState } from "./state.mjs";
import { ago, bad, clean, header, linkLine, note, proBox, PROMPT, typed, visible, warn, width, wrap } from "./tui.mjs";

/** The views a Free app does not have (the server sends their data to Pro only), and what the Pro box says about each. */
const PRO_VIEWS = {
  problems: "Every problem, the pages it happens on and what GenClass did come with Pro.",
  events: "The latest events, one per line, come with Pro.",
  report: "The period as Markdown comes with Pro.",
  fix: "Handing problems to your coding agent, with a fix prompt for each, comes with Pro.",
};

/** "Dec 1" for an ISO time (UTC). */
const monthDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** The model's default kinds in plain words (packages/runtime/src/situation/questions.ts DEFAULT_DIAGNOSES). */
export const KINDS = {
  stale: "old data replaced newer data",
  conflict: "two operations competed over the same data",
  duplicate: "the same request went out twice",
  inconsistent: "the page's state contradicted itself",
  failing: "a request keeps failing",
  slow: "a request was far slower than usual",
  overload: "work was triggered far too often",
  unusual: "an operation behaved unlike it normally does",
  transient: "a one-off failure",
};

export const RANGE_WORDS = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", "1y": "last year" };
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
export const n = (v) => Number(v).toLocaleString("en-US");
const plural = (v, one, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** A row of bars for a series of counts: the tallest is the full block, zero is the lowest. "" for an empty series. */
export function spark(series) {
  if (!series.length) return "";
  const max = Math.max(...series);
  if (max <= 0) return "";
  return series.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))]).join("");
}

/** "duplicate TAB /checkout" rows as { kind, page, count }, largest first as the server sent them. */
const rows = (list) =>
  list.map((x) => {
    const i = x.key.indexOf("\t");
    return { kind: clean(i < 0 ? x.key : x.key.slice(0, i), 40), page: clean(i < 0 ? "" : x.key.slice(i + 1), 60), count: x.count };
  });

/**
 * A list of counts, largest first: how many, what happened in plain words (a kind the model's vocabulary does not
 * have keeps its own name), and the page. Nothing is cut short: a row that does not fit puts the page on the line
 * under it. With `all`, the kind's own name follows the page.
 */
function table(title, list, shown, describe, all = false) {
  if (!list.length) return;
  out();
  out(`  ${c.bold(title)}`);
  const top = [...list]
    .sort((a, b) => b.count - a.count)
    .slice(0, shown)
    .map((r) => ({ ...r, page: r.page || "(page unknown)", what: describe?.[r.kind] ?? r.kind }));
  const wCount = Math.max(...top.map((r) => n(r.count).length));
  const room = width() - 4 - wCount - 2;
  const wWhat = Math.max(...top.map((r) => r.what.length));
  for (const r of top) {
    const lead = `    ${c.bold(n(r.count).padStart(wCount))}  `;
    const tail = `${c.cyan(r.page)}${all && describe?.[r.kind] ? c.gray(`  ${r.kind}`) : ""}`;
    const row = `${r.what.padEnd(wWhat)}  ${tail}`;
    if (visible(row) <= room) out(`${lead}${row}`.trimEnd());
    else {
      out(`${lead}${r.what}`);
      out(`${" ".repeat(4 + wCount + 2)}${tail}`);
    }
  }
  if (list.length > shown) out(`    ${c.gray(`and ${n(list.length - shown)} more: npx genclass dashboard --all`)}`);
}

/** A series folded into at most `max` buckets (each the sum of its part), so its chart fits the window. */
export function fit(series, max) {
  if (series.length <= max || max < 1) return series;
  const size = Math.ceil(series.length / max);
  const out = [];
  for (let i = 0; i < series.length; i += size) out.push(series.slice(i, i + size).reduce((a, b) => a + b, 0));
  return out;
}

/** The app's numbers as the lines of the view. Exported for the tests: pure, prints with out(). */
export function render(app, state, o = {}) {
  const all = !!o.all;
  const t = app.totals;
  // the chart is as wide as the window allows and never wider
  const line = spark(fit(app.series, Math.max(8, width() - 4 - 15 - 17)));
  const cell = (label, value) => `${c.gray(label.padEnd(15))}${c.bold(String(value).padEnd(9))}`;
  out(`  ${c.gray(RANGE_WORDS[app.range] ?? app.range)}${app.lastEvent ? c.gray(` · last page ${ago(app.lastEvent, o.now)}`) : ""}`);
  out();
  // past this month's live fixes: GenClass observes only, and the way on is the app's plan
  const u = app.usage;
  if (u?.observeOnly && u.limit !== null) {
    const [first = "", ...rest] = wrap(`Observing only. This app used its ${n(u.limit)} live fixes for the month, so GenClass finds and reports problems and fixes none${u.resets ? ` until ${monthDay(u.resets)}` : ""}. A paid plan has no limit: npx genclass plan`, width() - 6);
    out(`  ${c.yellow(sym.warn)} ${c.bold(first)}`);
    for (const l of rest) out(`    ${l}`);
    out();
  }
  // the dashboard page's own words: a page load is one page GenClass watched
  out(`  ${cell("Page loads", n(t.visits))}  ${cell("Problems found", n(t.found))}`.trimEnd());
  out(`  ${cell("Handled", n(t.handled))}  ${cell("Visual checks", n(t.checks))}`.trimEnd());
  if (line) out(`  ${c.gray("Problems".padEnd(15))}${c.green(line)}  ${c.gray("over the period")}`);

  if (!t.visits && !t.found && !t.checks) {
    out();
    note(app.lastEvent ? "Nothing in this period. Try a longer one: npx genclass dashboard --range 30d" : "Nothing received yet. GenClass sends nothing from localhost: deploy your app, open the live site once, and run this again.");
  } else if (!t.found && !t.checks) {
    out();
    out(`  ${c.green(sym.ok)} No problems found in this period.`);
  }
  // Free: the totals above, and the way to the rest
  if (app.problemsPlan) proBox("The problems, the pages they happen on and a fix prompt for each come with Pro. Free shows the totals.", app.problemsPlan);
  else table("Problems", rows(app.problems), all ? 200 : 5, KINDS, all);
  if (all) table("Possible problems (lower confidence)", rows(app.possible), 200, KINDS, all);
  table("Visual checks", rows(app.checks), all ? 200 : 3, null, all);
  if (all && app.recent.length) {
    out();
    out(`  ${c.bold("Latest")}`);
    for (const r of app.recent) out(`    ${c.gray(ago(r.at, o.now).padEnd(15))}${clean(r.kind ?? "", 22).padEnd(22)}  ${c.cyan(clean(r.route ?? "", 40))}${r.handled ? c.gray("  handled") : ""}`.trimEnd());
  }

  // one line per other part of GenClass
  out();
  const part = (label, text) => {
    const [first = "", ...rest] = wrap(text, width() - 4 - 15);
    out(`  ${c.bold(label.padEnd(15))}${first}`);
    for (const l of rest) out(`  ${" ".repeat(15)}${l}`);
  };
  if (app.visitors) {
    const v = app.visitors;
    const bounce = v.visits ? ` · ${Math.round((v.bounces / v.visits) * 100)}% left after one page` : "";
    part("Visitors", v.visits ? `${plural(v.visits, "visit")} · ${plural(v.pages, "page view")}${bounce}` : c.gray("none counted in this period (analytics is opt-in: genclass.dev/docs)"));
    if (v.visits && v.entry.length) for (const l of wrap(`came in on ${v.entry.slice(0, all ? 10 : 3).map((e) => `${clean(e.key, 30)} (${n(e.count)})`).join(", ")}`, width() - 4 - 15)) out(`  ${" ".repeat(15)}${c.gray(l)}`);
  } else if (app.visitorsPlan) part("Visitors", c.gray(`visitor analytics come with the ${clean(app.visitorsPlan.plan ?? "Pro", 20)} plan${app.visitorsPlan.upgradeUrl ? `: ${app.visitorsPlan.upgradeUrl}` : ""}`));
  if (u && u.limit !== null) part("Live fixes", u.observeOnly ? c.yellow(`${n(u.used)} of ${n(u.limit)} this month · observing only`) : `${n(u.used)} of ${n(u.limit)} this month`);
  else if (u?.used) part("Live fixes", `${n(u.used)} this month · no limit`);
  const a = app.agent;
  const agentStep = state?.steps?.find((s) => s.id === "agent");
  part("Coding agent", a.found ? `${n(a.found)} found · ${n(a.reproduced)} reproduced · ${n(a.fixed)} fixed · ${n(a.closed)} with a test` : agentStep?.state === "done" ? c.gray("connected · nothing reported in this period") : c.gray("not connected yet: npx genclass setup"));
  const gh = state?.steps?.find((s) => s.id === "github-app");
  if (gh) part("GitHub App", gh.state === "done" ? clean(gh.detail, 60) : c.gray(gh.detail ? clean(gh.detail, 60) : gh.state === "optional" ? "not used in this project" : "not connected yet: npx genclass setup"));
  const sg = state?.steps?.find((s) => s.id === "suggestions");
  if (sg) part("Suggestions", sg.detail ? (sg.state === "done" ? clean(sg.detail, 60) : `${clean(sg.detail, 60)}${c.gray(" · npx genclass suggest")}`) : c.gray("not run yet: npx genclass suggest"));
  out();
  if (app.dashboardUrl) linkLine("In the browser", app.dashboardUrl);
  if (!all) out(`  ${c.gray("Every row:")} ${c.cyan("npx genclass dashboard --all")}`);
  out();
}

/**
 * `genclass login` when the saved sign-in is from before the command could do what it does now (show dashboards;
 * the plan, alerts, stored events, questions): says so and signs in again (one approval in the browser). Returns the exit code, or null when the sign-in is fine, missing or cannot be
 * checked, and the usual login command should run.
 * @param {{ noBrowser?: boolean }} o
 * @param {{ fetchFn?: typeof fetch, signIn?: (o: object) => Promise<string> }} [deps]
 */
export async function signInAgain(o = {}, deps = {}) {
  if (hostConfig().error) return null;
  const { creds } = readCredentialsFor();
  if (!creds || !(await signInIsOld(creds, deps))) return null;
  out();
  note("You are signed in, from before the command could do all it does now. One more approval in the browser adds that: the page lists what the terminal can do.");
  return (await (deps.signIn ?? signIn)(o)) === "done" ? 0 : 1;
}

/**
 * `genclass dashboard`. Exit code 0, or 1 when the app's numbers could not be read.
 * @param {{ cwd?: string, app?: string, range?: string, all?: boolean, json?: boolean, open?: boolean, noBrowser?: boolean }} o
 * @param {{ fetchFn?: typeof fetch, runGit?: Function, now?: number, fallback?: () => Promise<number> }} [deps]
 */
export async function dashboard(o = {}, deps = {}) {
  return appView(o, deps, {
    name: "dashboard",
    json: (app, state, target) => ({ ok: true, app: target.name, ...app, more: undefined, github_app: state.steps.find((s) => s.id === "github-app")?.detail ?? null }),
    // the agent, GitHub App and suggestions lines are this folder's: shown when the app is this folder's app
    show: (app, state, target) => render(app, state.app.token === target.token ? state : { steps: [] }, { all: o.all, now: deps.now }),
  });
}

/** How an app is named after --app: its name in quotes, or its id when another app has the same name. */
/** An app as a choice in a list: its name, and its id's start when the name is shared or there is none. */
export const appLabel = (p, projects) =>
  p.name === "unnamed" || projects.filter((x) => x.name.toLowerCase() === p.name.toLowerCase()).length > 1 ? `${p.name === "unnamed" ? "unnamed app" : p.name} (${String(p.id).slice(0, 6)})` : p.name;

export const appArg = (p, projects) => {
  const name = clean(p.name, 200);
  // a name that is shared, cut, or holds a quote is not typed: the id always works
  return projects.filter((x) => x.name.toLowerCase() === p.name.toLowerCase()).length > 1 || name !== p.name || /["\\$`]/.test(name) ? p.id : `"${name}"`;
};

/**
 * Which app a command is about, for a signed-in account: --app by name or id, else this folder's app, else the
 * account's only one. Returns { state, creds, target } or, when there is none to act on, { code } after saying why
 * and what to type instead (signed out, no app yet, which app). `name`: the command, for those hints.
 */
export async function pickApp(o = {}, deps = {}, name = "dashboard") {
  const state = await readState({ cwd: o.cwd }, deps);
  if (!state.signedIn) {
    // signed out, an app can still have a private dashboard link: the runtime CLI's own command knows it
    if (!o.json && deps.fallback) return { code: await deps.fallback() };
    if (o.json) out(JSON.stringify({ ok: false, error: "not signed in", run: "npx genclass login" }));
    else {
      header({ app: state.app.name, framework: state.app.framework, host: state.host });
      note(state.sessionProblem && state.sessionProblem !== "expired" ? `Could not reach genclass.dev (${state.sessionProblem}).` : "Sign in to see your app here: npx genclass login (or just npx genclass, which walks you through it).");
      out();
    }
    return { code: 1 };
  }
  const { creds } = readCredentialsFor();
  const projects = state.projects;
  // which app: --app by id or by name, else this folder's, else the account's only one
  const byId = o.app ? projects.filter((p) => p.id === o.app) : [];
  const wanted = byId.length ? byId : o.app ? projects.filter((p) => p.name.toLowerCase() === String(o.app).toLowerCase()) : state.app.token ? projects.filter((p) => p.token === state.app.token) : projects.length === 1 ? projects : [];
  // on a terminal: the apps as numbered choices, and the number picks one
  if (wanted.length !== 1 && projects.length && !o.json && !o.yes && interactive()) {
    const list = (wanted.length > 1 ? wanted : projects).slice(0, 30);
    header({ app: state.app.name, framework: state.app.framework, account: state.account?.label, plan: planName(state), host: state.host });
    note(wanted.length > 1 ? `More than one app is named "${clean(o.app, 40)}". Which one?` : o.app ? `No app named "${clean(o.app, 40)}". Which one?` : state.app.token ? "This folder's app is not in your account yet. Which app?" : "Which app?");
    list.forEach((p, i) => out(`  ${c.gray(String(i + 1).padStart(2))}  ${c.bold(clean(appLabel(p, projects), 34))}${p.last_event ? c.gray(`  last page ${ago(p.last_event, deps.now)}`) : ""}`));
    out();
    const a = await typed(`  ${PROMPT()} ${c.gray("a number ·")} ${c.bold("q")} ${c.gray("stop")}  `);
    const i = a !== null && /^\d+$/.test(a.trim()) ? Number(a.trim()) - 1 : -1;
    if (list[i]) return { state, creds, target: list[i] };
    out();
    return { code: 2 };
  }
  if (wanted.length !== 1) {
    if (o.json) out(JSON.stringify({ ok: false, error: projects.length ? "which app" : "no app yet", apps: projects.map((p) => p.name) }));
    else {
      header({ app: state.app.name, framework: state.app.framework, account: state.account?.label, plan: planName(state), host: state.host });
      if (!projects.length) note("No app in your account yet. Run npx genclass in your web app's folder: it adds GenClass and gives the app its dashboard.");
      else {
        note(wanted.length > 1 ? `More than one app is named "${clean(o.app, 40)}". Name it by its id:` : o.app ? `No app named "${clean(o.app, 40)}" in your account. Your apps:` : state.app.token ? "This folder's app is not in your account yet (genclass puts it there). Your apps:" : "Which app? Run this in the app's folder, or name one:");
        for (const p of (wanted.length > 1 ? wanted : projects).slice(0, 30)) out(`    ${c.cyan(`npx genclass ${name} --app ${appArg(p, projects)}`)}${p.last_event ? c.gray(`  last page ${ago(p.last_event, deps.now)}`) : ""}`);
      }
      out();
    }
    return { code: projects.length ? 2 : 1 };
  }
  return { state, creds, target: wanted[0] };
}

/**
 * One view of one app (the dashboard, and views.mjs: analytics, problems, events). Finds which app is meant, reads
 * its numbers, and hands them to `view.show(app, state, target)`; with --json prints `view.json(...)` instead.
 * Everything that can go wrong on the way is said the same for every view: signed out, which app, an older
 * sign-in, a server without the route. Exit code 0, 1 when the numbers could not be read, 2 when no app is named.
 * @param {{ name: string, show: Function, json?: Function }} view
 */
export async function appView(o = {}, deps = {}, view) {
  const range = ["24h", "7d", "30d", "90d", "1y"].includes(o.range) ? o.range : "7d";
  const picked = await pickApp(o, deps, view.name);
  if ("code" in picked) return picked.code;
  let { state } = picked;
  const { creds, target } = picked;
  // an app of the account with no plan chosen opens its plan page first, as its page on genclass.dev does. An app
  // the account's plan covers goes on whether or not Continue was clicked; one past what a paying account's plan
  // covers has said so (Enterprise, by email), and its numbers are not the plan's
  if (!o.json && interactive()) {
    const p = await planNow({ cwd: o.cwd, yes: o.yes, noBrowser: o.noBrowser }, deps, target.id);
    if (p === "locked") {
      out();
      return 1;
    }
    if (p === "open") {
      out();
      note(`${clean(target.name, 40)} needs its plan first. Run this again once it is chosen.`);
      out();
      return 1;
    }
    if (p === "chosen") state = await readState({ cwd: o.cwd }, deps);
  }
  if (o.open && target.dashboard_url) openBrowser(target.dashboard_url, o);
  let app = await fetchApp(creds, target.id, range, deps);
  if (!app.ok && app.reauth && !o.json && interactive()) {
    // signed in before the command could show dashboards: one more approval in the browser, then it is shown
    header({ app: target.name, framework: state.app.framework, account: state.account?.label, plan: planName(state, target.token), host: state.host });
    note("This sign-in is from before the command could show dashboards, so it was not approved for that. Signing in once more fixes it.");
    const a = await typed(`  ${c.bold("Enter")} ${c.gray("to sign in again ·")} ${c.bold("q")} ${c.gray("stop")} `);
    if (a === null || /^q/i.test(a)) return 1;
    if ((await signIn(o)) !== "done") return 1;
    const again = readCredentialsFor().creds;
    state = await readState({ cwd: o.cwd }, deps);
    app = await fetchApp(again, target.id, range, deps);
  }
  // the genclass command is Pro's: an account without it is told where Pro starts, as every command says it
  if (!app.ok && app.needsPro) {
    if (!o.json) header({ app: target.name, framework: state.app.framework, account: state.account?.label, plan: planName(state, target.token), host: state.host });
    return (await import("./session.mjs")).refused(app, { what: "The dashboard", command: view.name, json: o.json });
  }
  if (!app.ok) {
    if (o.json) out(JSON.stringify({ ok: false, error: app.reauth ? "sign in again" : app.reason, run: app.reauth ? "npx genclass login" : null, dashboard_url: target.dashboard_url }));
    else {
      header({ app: target.name, framework: state.app.framework, account: state.account?.label, plan: planName(state, target.token), host: state.host });
      if (app.reauth) warn(`This sign-in is from before the command could show dashboards. Run ${c.cyan("npx genclass login")} once, then ${c.cyan(`npx genclass ${view.name}`)}.`);
      else if (app.missing) note("This genclass.dev cannot show a dashboard in the terminal yet.");
      else bad(`Could not read the dashboard: ${clean(app.reason, 200)}`);
      if (target.dashboard_url) linkLine("In the browser", target.dashboard_url);
      else out(`  ${c.gray("Your apps")}  ${c.cyan(hostUrl("/account"))}`);
      out();
    }
    return 1;
  }
  if (o.json) {
    if (app.problemsPlan && PRO_VIEWS[view.name]) {
      out(JSON.stringify({ ok: false, locked: true, error: `${PRO_VIEWS[view.name]}`, plan: app.problemsPlan.plan, trial_days: app.problemsPlan.trialDays, upgrade_url: app.problemsPlan.upgradeUrl, run: "npx genclass upgrade" }, null, 2));
      return 0;
    }
    out(JSON.stringify((view.json ?? ((a, st, t) => ({ ok: true, app: t.name, ...a })))(app, state, target), null, 2));
    return 0;
  }
  // Free sees the totals only (the server left the rest out): these views are Pro's, and say so with the way to it
  if (app.problemsPlan && PRO_VIEWS[view.name]) {
    header({ app: target.name, framework: state.app.token === target.token ? state.app.framework : null, account: state.account?.label, plan: planName(state, target.token), host: state.host });
    proBox(PRO_VIEWS[view.name], app.problemsPlan);
    out();
    return 0;
  }
  // a view whose output is meant to be piped or pasted (the report) has no card over it
  if (!view.plain) header({ app: target.name, framework: state.app.token === target.token ? state.app.framework : null, account: state.account?.label, plan: planName(state, target.token), host: state.host });
  const code = await view.show(app, state, target, readCredentialsFor().creds ?? creds);
  return typeof code === "number" ? code : 0;
}
