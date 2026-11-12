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
import { hostUrl } from "../../runtime/bin/lib/host.mjs";
import { c, interactive, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { openBrowser, signIn } from "./actions.mjs";
import { fetchApp } from "./api.mjs";
import { readState } from "./state.mjs";
import { ago, bad, clean, header, note, typed, warn, width } from "./tui.mjs";

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

const RANGE_WORDS = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", "1y": "last year" };
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const n = (v) => Number(v).toLocaleString("en-US");
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

function table(title, list, shown, describe) {
  if (!list.length) return;
  out();
  out(`  ${c.bold(title)}`);
  const top = list.slice(0, shown).map((r) => ({ ...r, page: r.page || "(page unknown)" }));
  const wCount = Math.max(...top.map((r) => n(r.count).length));
  const wKind = Math.min(22, Math.max(...top.map((r) => r.kind.length)));
  const wPage = Math.min(28, Math.max(4, ...top.map((r) => r.page.length)));
  for (const r of top) {
    const what = describe ? (describe[r.kind] ?? "") : "";
    const left = `    ${c.bold(n(r.count).padStart(wCount))}  ${r.kind.padEnd(wKind)}  ${c.cyan(clean(r.page, wPage).padEnd(wPage))}`;
    const room = width() - 4 - wCount - wKind - wPage - 8;
    out(`${left}${what && room > 16 ? `  ${c.gray(clean(what, room))}` : ""}`.trimEnd());
  }
  if (list.length > shown) out(`    ${c.gray(`and ${n(list.length - shown)} more: genclass dashboard --all`)}`);
}

/** The app's numbers as the lines of the view. Exported for the tests: pure, prints with out(). */
export function render(app, state, o = {}) {
  const all = !!o.all;
  const t = app.totals;
  const line = spark(app.series);
  const cell = (label, value) => `${c.gray(label.padEnd(15))}${c.bold(String(value).padEnd(9))}`;
  out(`  ${c.gray(RANGE_WORDS[app.range] ?? app.range)}${app.lastEvent ? c.gray(` · last page ${ago(app.lastEvent, o.now)}`) : ""}`);
  out();
  out(`  ${cell("Visits watched", n(t.visits))}  ${cell("Problems found", n(t.found))}${line ? `  ${c.green(line)}` : ""}`.trimEnd());
  out(`  ${cell("Handled", n(t.handled))}  ${cell("Visual checks", n(t.checks))}`.trimEnd());

  if (!t.visits && !t.found && !t.checks) {
    out();
    note(app.lastEvent ? "Nothing in this period. Try a longer one: genclass dashboard --range 30d" : "Nothing received yet. GenClass sends nothing from localhost: deploy your app, open the live site once, and run this again.");
  } else if (!t.found && !t.checks) {
    out();
    out(`  ${c.green(sym.ok)} No problems found in this period.`);
  }
  table("Problems", rows(app.problems), all ? 200 : 5, KINDS);
  if (all) table("Possible problems (lower confidence)", rows(app.possible), 200, KINDS);
  table("Visual checks", rows(app.checks), all ? 200 : 3, null);
  if (all && app.recent.length) {
    out();
    out(`  ${c.bold("Latest")}`);
    for (const r of app.recent) out(`    ${c.gray(ago(r.at, o.now).padEnd(15))}${clean(r.kind ?? "", 22).padEnd(22)}  ${c.cyan(clean(r.route ?? "", 40))}${r.handled ? c.gray("  handled") : ""}`.trimEnd());
  }

  // one line per other part of GenClass
  out();
  const part = (label, text) => out(`  ${c.bold(label.padEnd(15))}${text}`);
  if (app.visitors) {
    const v = app.visitors;
    const bounce = v.visits ? ` · ${Math.round((v.bounces / v.visits) * 100)}% left after one page` : "";
    part("Visitors", v.visits ? `${plural(v.visits, "visit")} · ${plural(v.pages, "page view")}${bounce}` : c.gray("none counted in this period (analytics is opt-in: genclass.dev/docs)"));
    if (v.visits && v.entry.length) out(`  ${" ".repeat(15)}${c.gray(`came in on ${v.entry.slice(0, all ? 10 : 3).map((e) => `${clean(e.key, 30)} (${n(e.count)})`).join(", ")}`)}`);
  } else if (app.visitorsPlan) part("Visitors", c.gray(`visitor analytics come with the ${clean(app.visitorsPlan.plan ?? "Team", 20)} plan${app.visitorsPlan.upgradeUrl ? `: ${app.visitorsPlan.upgradeUrl}` : ""}`));
  const a = app.agent;
  const agentStep = state?.steps?.find((s) => s.id === "agent");
  part("Coding agent", a.found ? `${n(a.found)} found · ${n(a.reproduced)} reproduced · ${n(a.fixed)} fixed · ${n(a.closed)} with a test` : agentStep?.state === "done" ? c.gray("connected · nothing reported in this period") : c.gray("not connected yet: genclass setup"));
  const gh = state?.steps?.find((s) => s.id === "github-app");
  if (gh) part("GitHub App", gh.state === "done" ? clean(gh.detail, 60) : c.gray(gh.detail ? clean(gh.detail, 60) : gh.state === "optional" ? "not used in this project" : "not connected yet: genclass setup"));
  const sg = state?.steps?.find((s) => s.id === "suggestions");
  if (sg) part("Suggestions", sg.detail ? (sg.state === "done" ? clean(sg.detail, 60) : `${clean(sg.detail, 60)}${c.gray(" · genclass suggest")}`) : c.gray("not run yet: genclass suggest"));
  out();
  if (app.dashboardUrl) out(`  ${c.gray("In the browser")}  ${c.cyan(app.dashboardUrl)}  ${c.gray("(genclass dashboard --open)")}`);
  if (!all) out(`  ${c.gray("Every row: genclass dashboard --all · another period: --range 24h, 7d or 30d")}`);
  out();
}

/**
 * `genclass dashboard`. Exit code 0, or 1 when the app's numbers could not be read.
 * @param {{ cwd?: string, app?: string, range?: string, all?: boolean, json?: boolean, open?: boolean, noBrowser?: boolean }} o
 * @param {{ fetchFn?: typeof fetch, runGit?: Function, now?: number, fallback?: () => Promise<number> }} [deps]
 */
export async function dashboard(o = {}, deps = {}) {
  const range = ["24h", "7d", "30d", "90d", "1y"].includes(o.range) ? o.range : "7d";
  let state = await readState({ cwd: o.cwd }, deps);
  if (!state.signedIn) {
    // signed out, an app can still have a private dashboard link: the runtime CLI's own command knows it
    if (!o.json && deps.fallback) return deps.fallback();
    if (o.json) out(JSON.stringify({ ok: false, error: "not signed in", run: "genclass login" }));
    else {
      header({ app: state.app.name, framework: state.app.framework, host: state.host });
      note(state.sessionProblem && state.sessionProblem !== "expired" ? `Could not reach genclass.dev (${state.sessionProblem}).` : "Sign in to see your app here: genclass login (or just genclass, which walks you through it).");
      out();
    }
    return 1;
  }
  const { creds } = readCredentialsFor();
  const projects = state.projects;
  // which app: --app by name, else this folder's, else the account's only one
  const wanted = o.app ? projects.filter((p) => p.name.toLowerCase() === String(o.app).toLowerCase() || p.id === o.app) : state.app.token ? projects.filter((p) => p.token === state.app.token) : projects.length === 1 ? projects : [];
  if (wanted.length !== 1) {
    if (o.json) out(JSON.stringify({ ok: false, error: projects.length ? "which app" : "no app yet", apps: projects.map((p) => p.name) }));
    else {
      header({ app: state.app.name, framework: state.app.framework, account: state.account?.label, plan: state.account?.plan?.name, host: state.host });
      if (!projects.length) note("No app in your account yet. Run genclass in your web app's folder: it adds GenClass and gives the app its dashboard.");
      else {
        note(o.app ? `No app named "${clean(o.app, 40)}" in your account. Your apps:` : state.app.token ? "This folder's app is not in your account yet (genclass puts it there). Your apps:" : "Which app? Run this in the app's folder, or name one:");
        for (const p of projects.slice(0, 30)) out(`    ${c.cyan(`genclass dashboard --app "${clean(p.name, 40)}"`)}${p.last_event ? c.gray(`  last page ${ago(p.last_event, deps.now)}`) : ""}`);
      }
      out();
    }
    return projects.length ? 2 : 1;
  }
  const target = wanted[0];
  if (o.open && target.dashboard_url) openBrowser(target.dashboard_url, o);
  let app = await fetchApp(creds, target.id, range, deps);
  if (!app.ok && app.reauth && !o.json && interactive()) {
    // signed in before the command could show dashboards: one more approval in the browser, then it is shown
    header({ app: target.name, framework: state.app.framework, account: state.account?.label, plan: state.account?.plan?.name, host: state.host });
    note("This sign-in is from before the command could show dashboards, so it was not approved for that. Signing in once more fixes it.");
    const a = await typed(`  ${c.bold("Enter")} ${c.gray("to sign in again,")} ${c.bold("q")} ${c.gray("to stop")} `);
    if (a === null || /^q/i.test(a)) return 1;
    if ((await signIn(o)) !== "done") return 1;
    const again = readCredentialsFor().creds;
    state = await readState({ cwd: o.cwd }, deps);
    app = await fetchApp(again, target.id, range, deps);
  }
  if (!app.ok) {
    if (o.json) out(JSON.stringify({ ok: false, error: app.reauth ? "sign in again" : app.reason, run: app.reauth ? "genclass login" : null, dashboard_url: target.dashboard_url }));
    else {
      header({ app: target.name, framework: state.app.framework, account: state.account?.label, plan: state.account?.plan?.name, host: state.host });
      if (app.reauth) warn(`This sign-in is from before the command could show dashboards. Run ${c.cyan("genclass login")} once, then ${c.cyan("genclass dashboard")}.`);
      else if (app.missing) note("This genclass.dev cannot show a dashboard in the terminal yet.");
      else bad(`Could not read the dashboard: ${clean(app.reason, 200)}`);
      if (target.dashboard_url) out(`  ${c.gray("In the browser")}  ${c.cyan(target.dashboard_url)}`);
      else out(`  ${c.gray("Your apps")}  ${c.cyan(hostUrl("/account"))}`);
      out();
    }
    return 1;
  }
  if (o.json) {
    out(JSON.stringify({ ok: true, app: target.name, ...app, github_app: state.steps.find((s) => s.id === "github-app")?.detail ?? null }, null, 2));
    return 0;
  }
  header({ app: target.name, framework: state.app.token === target.token ? state.app.framework : null, account: state.account?.label, plan: state.account?.plan?.name, host: state.host });
  // the agent, GitHub App and suggestions lines are this folder's: shown when the app is this folder's app
  render(app, state.app.token === target.token ? state : { steps: [] }, { all: o.all, now: deps.now });
  return 0;
}
