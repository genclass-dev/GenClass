// The other views of one app, next to the dashboard (app.mjs): `genclass analytics`, `problems`, `events`, `health`,
// `agent` and `report`. Each reads what the dashboard page reads (GET /api/cli/app, with the plan's rules) and prints
// one part of it in full, so nothing the browser dashboard shows is missing from the terminal.
//
// Invariants:
// - Short first: every list shows its top rows and says how many more there are; --all prints every row, and a
//   section's name after the command prints that section alone, in full (`genclass analytics sources`).
// - Every line fits the window (tui.mjs width(), 60 columns at least). A label that is wider than its column is the
//   only thing ever cut.
// - Words from the server (a page, a referrer, a button's label, a kind) go through clean() before they are
//   printed, like every text that is not this program's.
// - What happened is said in the dashboard's own words where the vocabulary is known (kinds.mjs, app.mjs KINDS);
//   a name this program does not know is printed as it is, never guessed at.
// - Read only. `report` writes a file only when --out names one. --json prints the same data as JSON and nothing else.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { c, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { appView, fit, KINDS, n, RANGE_WORDS, spark } from "./app.mjs";
import { brand } from "./art.mjs";
import { ACTION_NAMES, checkFixed, checkOf, didAct, markdown } from "./kinds.mjs";
import { agentConfigs } from "./state.mjs";
import { ago, bad, clean, good, linkLine, note, width, wrap } from "./tui.mjs";

/** The longest line that fits the window. */
const room = () => width() - 2;
/** A share as a percentage; almost all of it is never rounded up to "100%". */
const pct = (part, whole) => {
  if (!(whole > 0)) return "";
  const r = (100 * part) / whole;
  return `${r > 99.5 && part < whole ? Math.floor(r * 10) / 10 : Math.round(r)}%`;
};
const split = (key) => {
  const i = key.indexOf("\t");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
};
/** "45s", "1m 05s" from milliseconds. */
export const time = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const cell = (label, value) => `${c.gray(label.padEnd(15))}${c.bold(String(value).padEnd(9))}`;
const head = (title, hint = "") => {
  out();
  out(`  ${c.bold(title)}`);
  if (hint) for (const l of wrap(hint, room() - 4)) out(`    ${c.gray(l)}`);
};
/** A label and a text beside it, the text wrapped under itself. */
const part = (label, text, w = 18) => {
  const [first = "", ...rest] = wrap(text, room() - 2 - w);
  out(`  ${c.gray(label.padEnd(w))}${first}`);
  for (const l of rest) out(`  ${" ".repeat(w)}${l}`);
};
const period = (app, now) => out(`  ${c.gray(RANGE_WORDS[app.range] ?? app.range)}${app.lastEvent ? c.gray(` ${sym.dot} last page ${ago(app.lastEvent, now)}`) : ""}${app.demo ? c.gray(` ${sym.dot} sample data`) : ""}`);
/** "up 12% on the period before", or "" when there is nothing to compare with. */
const change = (now, before) => {
  if (!before) return "";
  const d = Math.round(((now - before) / before) * 100);
  return d === 0 ? "the same as the period before" : `${d > 0 ? "up" : "down"} ${Math.abs(d)}% on the period before`;
};

/**
 * A ranked list with bars: the name, the count, a bar as long as its share of the largest, and its share of the
 * whole. `rows`: [{ key, count }], largest first as given.
 */
export function bars(title, rows, o = {}) {
  if (!rows?.length) return;
  const shown = o.all ? rows.length : Math.min(rows.length, o.shown ?? 5);
  const top = rows.slice(0, shown).map((r) => ({ ...r, label: clean((o.label ?? ((k) => k))(r.key) || "(none)", 120) }));
  const whole = o.whole ?? rows.reduce((a, r) => a + r.count, 0);
  const max = Math.max(1, ...top.map((r) => r.count));
  const wCount = Math.max(...top.map((r) => n(r.count).length));
  const longest = Math.max(...top.map((r) => r.label.length));
  // 4 of indent, the label, 2, the count, 2, the bar, 1, the share (4): a long label takes room from the bar first
  const wBar = Math.max(6, Math.min(18, Math.floor(room() / 5), room() - 13 - wCount - longest));
  const wLabel = Math.max(8, Math.min(longest, room() - 13 - wCount - wBar));
  head(title, o.hint);
  for (const r of top) {
    const len = Math.max(1, Math.round((r.count / max) * wBar));
    out(`    ${clean(r.label, wLabel).padEnd(wLabel)}  ${c.bold(n(r.count).padStart(wCount))}  ${brand("█".repeat(len))}${" ".repeat(wBar - len)} ${c.gray(pct(r.count, whole).padStart(4))}`.trimEnd());
  }
  if (rows.length > shown) out(`    ${c.gray(`and ${n(rows.length - shown)} more: ${o.more ?? "add --all"}`)}`);
}

// ------------------------------------------------------------------------------------------------- analytics

export const ANALYTICS_SECTIONS = ["pages", "sources", "devices", "clicks", "paths", "funnels"];

/** The lines of `genclass analytics`. `section`: one of ANALYTICS_SECTIONS, or null for every section, short. */
export function renderAnalytics(app, o = {}) {
  const m = app.more;
  const b = m.breakdowns;
  const t = m.totals;
  const only = ANALYTICS_SECTIONS.includes(o.section) ? o.section : null;
  const all = !!o.all || !!only;
  // with no part named and no --all, the short view: the numbers and the top of the lists people look at first
  const brief = !all;
  const want = (s) => !only || only === s;
  const more = (s) => `npx genclass analytics ${s}`;
  let regions = null;
  try {
    regions = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    /* codes as they are */
  }
  const country = (k) => {
    try {
      return /^[A-Z]{2}$/.test(k) ? (regions?.of(k) ?? k) : k;
    } catch {
      return k;
    }
  };
  period(app, o.now);
  if (app.visitorsPlan) {
    out();
    out(`  ${c.bold(`Visitor analytics come with the ${clean(app.visitorsPlan.plan ?? "Pro", 20)} plan.`)}`);
    // "already counted" only when the app sends visitor events (page views in the totals); else it is the app's switch
    const counted = (t?.ix_views ?? 0) > 0 || (app.totals?.pageViews ?? 0) > 0;
    note(counted ? "What your visitors do is already being counted, so it shows from the day you switch: visits, pages, time on a page, where people come from, what they click, funnels." : "Visits, pages, time on a page, where people come from, what they click, funnels. Your app turns it on with one line, no cookies:");
    if (!counted) out(`    ${c.cyan("https://genclass.dev/docs/analytics")}`);
    out(`    ${c.cyan("npx genclass plan")}`);
    out();
    return;
  }
  const v = app.visitors ?? { visits: 0, pages: 0, bounces: 0, entry: [] };
  const views = t.ix_views ?? v.pages;
  if (!v.visits && !views && only !== "funnels") {
    out();
    note("No visits counted in this period. Visitor analytics is something your app turns on (one line, no cookies): https://genclass.dev/docs/analytics. GenClass counts nothing from localhost.");
    out();
    return;
  }
  if (!only) {
    const fresh = (b.ix_returning ?? []).find((r) => r.key === "new")?.count ?? 0;
    const known = (b.ix_returning ?? []).reduce((a, r) => a + r.count, 0);
    out();
    out(`  ${cell("Visits", n(v.visits))}  ${cell("Page views", n(views))}`.trimEnd());
    out(`  ${cell("Pages a visit", v.visits ? (views / v.visits).toFixed(1) : "0")}  ${cell("Left at once", pct(v.bounces, v.visits) || "0%")}`.trimEnd());
    out(`  ${cell("Time on a page", views && t.ix_engaged_ms ? time(t.ix_engaged_ms / views) : "-")}  ${cell("New visitors", known ? pct(fresh, known) : "-")}`.trimEnd());
    const line = spark(fit(m.series.map((x) => x.visits), Math.max(8, room() - 2 - 15 - 17)));
    if (line) out(`  ${c.gray("Visits".padEnd(15))}${c.green(line)}  ${c.gray("over the period")}`);
    const delta = change(views, m.previous.ix_views);
    if (delta) out(`  ${c.gray(`Page views are ${delta}.`)}`);
  }
  if (want("pages")) {
    // each page: its views, the time people spent on it, and how many read to the end
    const pages = b.ix_views ?? [];
    if (pages.length) {
      const ms = new Map((b.ix_engaged_ms ?? []).map((r) => [r.key, r.count]));
      const end = new Map((b.ix_scroll ?? []).map((r) => [r.key, r.count]));
      const shown = all ? pages.length : Math.min(5, pages.length);
      const top = pages.slice(0, shown);
      const wViews = Math.max(5, ...top.map((r) => n(r.count).length));
      // 4 of indent, the page, 2, views, 2, time (7), 2, read (4)
      const wPage = Math.max(8, Math.min(Math.max(...top.map((r) => clean(r.key, 120).length)), room() - 21 - wViews));
      head("Pages", "time: on the page, on average. read: reached the end of the page.");
      out(`    ${c.gray("page".padEnd(wPage))}  ${c.gray("views".padStart(wViews))}  ${c.gray("time".padEnd(7))}  ${c.gray("read")}`);
      for (const r of top) {
        const spent = ms.has(r.key) && r.count ? time(ms.get(r.key) / r.count) : "";
        const read = end.has(`${r.key}\t100`) ? pct(end.get(`${r.key}\t100`), r.count) : "";
        out(`    ${c.cyan(clean(r.key, wPage).padEnd(wPage))}  ${c.bold(n(r.count).padStart(wViews))}  ${spent.padEnd(7)}  ${read}`.trimEnd());
      }
      if (pages.length > shown) out(`    ${c.gray(`and ${n(pages.length - shown)} more: ${more("pages")}`)}`);
    }
    if (!brief) {
      bars("Came in on", v.entry, { all, whole: v.visits, more: more("pages") });
      bars("Left from", m.exit, { all, whole: v.visits, more: more("pages") });
    }
  }
  if (want("sources")) {
    bars("Where they come from", b.ix_ref ?? [], { all, whole: v.visits, more: more("sources"), label: (k) => (k === "" || k === "(direct)" ? "Direct or unknown" : k) });
    if (!brief) {
      bars("Campaigns", b.ix_utm_campaign ?? [], { all, shown: 3, more: more("sources") });
      if (all) {
        bars("Campaign sources", b.ix_utm_source ?? [], { all });
        bars("Campaign mediums", b.ix_utm_medium ?? [], { all });
      }
    }
  }
  if (want("devices")) {
    const o3 = { all, shown: 3, whole: v.visits, more: more("devices") };
    bars("Devices", b.ix_device ?? [], o3);
    if (!brief) {
      bars("Browsers", b.ix_browser ?? [], o3);
      bars("Systems", b.ix_os ?? [], o3);
    }
    bars("Countries", b.ix_country ?? [], { ...o3, label: country });
    if (!brief) bars("New or returning", b.ix_returning ?? [], { all });
  }
  const onPage = (k) => {
    const [page, what] = split(k);
    return what ? `${what} on ${page}` : page;
  };
  if (want("clicks")) {
    if (!brief) bars("Most clicked", b.ix_click ?? [], { all, label: onPage, more: more("clicks") });
    bars("Clicked again and again", b.ix_rage ?? [], { all, shown: 3, label: onPage, more: more("clicks"), hint: "The same thing, several times in a moment: usually it did not seem to work." });
    if (!brief) bars("Clicked with no effect", b.ix_dead ?? [], { all, label: onPage, more: more("clicks"), hint: "A click that changed nothing on the page." });
  }
  if (want("paths") && !brief && (only || (b.ix_path ?? []).length)) {
    const arrow = ` ${sym.arrow} `;
    bars("Paths through the site", b.ix_path ?? [], { all, shown: 3, more: more("paths"), label: (k) => k.split(" > ").join(arrow) });
    if (all) {
      bars("From one page to the next", b.ix_nav ?? [], { all, label: (k) => split(k).join(arrow) });
      bars("First thing people use", b.ix_first ?? [], { all, label: onPage });
    }
    if (only && !(b.ix_path ?? []).length) {
      out();
      note("No paths counted in this period.");
    }
  }
  if (want("funnels")) {
    if (m.funnels.length) {
      head("Funnels", "The visits that reached each page, in order.");
      for (const f of m.funnels) {
        out(`    ${c.bold(clean(f.name, 60))}`);
        const wStep = Math.min(Math.max(...f.steps.map((s) => clean(s, 60).length)), room() - 28);
        f.steps.forEach((step, i) => {
          const got = f.counts[i] ?? 0;
          out(`      ${c.cyan(clean(step, wStep).padEnd(wStep))}  ${c.bold(n(got).padStart(6))}${i && f.counts[0] ? c.gray(`  ${pct(got, f.counts[0])} of step 1`) : ""}`.trimEnd());
        });
      }
    } else if (only) {
      out();
      note("No funnel yet. A funnel is a list of pages in order; it counts the visits that reach each one.");
    }
    if (only) {
      out();
      out(`  ${c.gray("Add or remove one:")} ${c.cyan("npx genclass funnels")}`);
    }
  }
  out();
  if (brief) {
    out(`  ${c.gray("Every list in full:")} ${c.cyan("npx genclass analytics --all")}`);
    out(`  ${c.gray("One part:")} ${c.cyan("npx genclass analytics pages")}`);
    out(`  ${c.gray(`also ${ANALYTICS_SECTIONS.slice(1).join(", ")}`)}`);
  }
  if (app.dashboardUrl) linkLine("In the browser", app.dashboardUrl);
  out();
}

const ix = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("ix_")));

/** `genclass analytics [pages|sources|devices|clicks|paths|funnels]`. */
export function analytics(o = {}, deps = {}) {
  return appView(o, deps, {
    name: "analytics",
    json: (app, _s, target) => ({ ok: true, app: target.name, range: app.range, demo: app.demo, locked: app.visitorsPlan, visitors: app.visitors, exit: app.more.exit, totals: ix(app.more.totals), breakdowns: ix(app.more.breakdowns), series: app.more.series.map((x) => ({ bucket: x.bucket, visits: x.visits, views: x.views })), funnels: app.more.funnels }),
    show: (app) => renderAnalytics(app, { all: o.all, section: o.section, now: deps.now }),
  });
}

// -------------------------------------------------------------------------------------------------- problems

/** A key this program has no words for, readable: "scroll_lock" as "scroll lock". Never more than that. */
const plain = (k) => String(k).replace(/[_-]+/g, " ");
const kindWords = (k) => KINDS[k] ?? plain(k);
const actionWords = (k) => ACTION_NAMES[k] ?? plain(k);
/** What GenClass stepped in on: the runtime's own actions and the visual fixes still in place. */
const steppedIn = (app) => (app.more.totals.interventions ?? 0) + checkFixed(app.more.totals, app.more.breakdowns);

/** The lines of `genclass problems`. */
export function renderProblems(app, o = {}) {
  const m = app.more;
  const b = m.breakdowns;
  const all = !!o.all;
  const found = app.totals.found + app.totals.checks;
  period(app, o.now);
  out();
  out(`  ${cell("Problems found", n(found))}  ${cell("Fixed live", n(steppedIn(app)))}`.trimEnd());
  out(`  ${cell("Possible", n(app.totals.possible))}  ${cell("Pages affected", n(new Set([...(b.detect_route ?? []).map((x) => x.key), ...(b.check_issue ?? []).map((x) => split(x.key)[1])]).size))}`.trimEnd());
  const line = spark(fit(m.series.map((x) => x.found + x.checks), Math.max(8, room() - 2 - 15 - 17)));
  if (line) out(`  ${c.gray("Problems".padEnd(15))}${c.green(line)}  ${c.gray("over the period")}`);
  const delta = change(found, (m.previous.detections ?? 0) + (m.previous.checks ?? 0));
  if (delta) out(`  ${c.gray(`That is ${delta}.`)}`);
  if (!found && !app.totals.possible) {
    out();
    if (app.totals.visits) good("No problems found in this period.");
    else note("Nothing received yet. GenClass sends nothing from localhost: deploy your app and open the live site once.");
    out();
    return;
  }
  bars("What it was", (b.detect_diagnosis ?? []).filter((x) => x.key !== "expected"), { all, label: kindWords, whole: app.totals.found });
  bars("Where", b.detect_route ?? [], { all, whole: app.totals.found });
  // every kind on every page: what to look at first
  const pairs = [...(b.detect_issue ?? [])].sort((x, y) => y.count - x.count);
  if (pairs.length) {
    const shown = all ? pairs.length : Math.min(6, pairs.length);
    const wCount = Math.max(...pairs.slice(0, shown).map((r) => n(r.count).length));
    head("Each kind on each page");
    for (const r of pairs.slice(0, shown)) {
      const [kind, page] = split(r.key);
      const lead = `    ${c.bold(n(r.count).padStart(wCount))}  `;
      const words = clean(kindWords(kind), 80);
      const where = clean(page || "(page unknown)", 80);
      if (4 + wCount + 2 + words.length + 4 + where.length <= room()) out(`${lead}${words} ${c.gray("on")} ${c.cyan(where)}`);
      else {
        out(`${lead}${words}`);
        out(`${" ".repeat(4 + wCount + 2)}${c.gray("on")} ${c.cyan(clean(where, room() - 9 - wCount))}`);
      }
    }
    if (pairs.length > shown) out(`    ${c.gray(`and ${n(pairs.length - shown)} more: add --all`)}`);
  }
  // the measured visual checks, in the dashboard's names
  bars("Visual checks", (b.check_kind ?? []).filter((x) => x.count > 0), { all, label: (k) => checkOf(k).name, whole: app.totals.checks, hint: "Measurements against fixed thresholds, not model findings." });
  // what GenClass did about them, when the app lets it act (guard or heal)
  const did = [...(b.intervention ?? [])];
  const fixed = checkFixed(m.totals, b);
  if (fixed) did.push({ key: "check_fix", count: fixed });
  if (did.length) {
    head("What GenClass did", "Only where the app runs it in guard or heal mode.");
    const wCount = Math.max(...did.map((r) => n(r.count).length));
    for (const r of all ? did : did.slice(0, 5)) out(`    ${c.bold(n(r.count).padStart(wCount))}  ${clean(actionWords(r.key), 60)}`);
    const outcome = (b.action_outcome ?? []).filter((x) => x.key !== "applied" && x.count > 0);
    if (outcome.length) out(`    ${c.gray(outcome.map((x) => `${n(x.count)} ${clean(x.key, 20)}`).join(` ${sym.dot} `))}`);
  } else if (!(b.mode ?? []).some((x) => x.key === "guard" || x.key === "heal")) {
    out();
    note("GenClass only reports here (observe mode). In guard mode it also stops these on the visitor's screen: https://genclass.dev/docs");
  }
  if (all || (!app.totals.found && app.totals.possible)) bars("Possible problems", b.possible_diagnosis ?? [], { all, label: kindWords, whole: app.totals.possible, hint: "Lower confidence: not counted as problems." });
  out();
  out(`  ${c.gray("Have them fixed:")} ${c.cyan("npx genclass fix")}`);
  out(`  ${c.gray("One at a time:  ")} ${c.cyan("npx genclass events")}`);
  out();
}

/** `genclass problems`. */
export function problems(o = {}, deps = {}) {
  return appView(o, deps, {
    name: "problems",
    json: (app, _s, target) => ({
      ok: true,
      app: target.name,
      range: app.range,
      demo: app.demo,
      totals: { ...app.totals, stepped_in: steppedIn(app) },
      kinds: app.kinds,
      problems: app.problems,
      possible: app.possible,
      checks: app.checks,
      pages: app.more.breakdowns.detect_route ?? [],
      interventions: app.more.breakdowns.intervention ?? [],
      outcomes: app.more.breakdowns.action_outcome ?? [],
      series: app.more.series.map((x) => ({ bucket: x.bucket, found: x.found, handled: x.handled, possible: x.possible, checks: x.checks })),
    }),
    show: (app) => renderProblems(app, { all: o.all, now: deps.now }),
  });
}

// ---------------------------------------------------------------------------------------------------- events

/** The lines of `genclass events`: the latest events as the server keeps them, newest first. */
export function renderEvents(app, o = {}) {
  const all = !!o.all;
  const rows = all ? app.more.events : app.more.events.slice(0, 15);
  period(app, o.now);
  if (!rows.length) {
    out();
    note("No events in this period.");
    out();
    return;
  }
  const short = (iso) => ago(iso, o.now).replace(/ minutes? ago/, " min ago").replace(/ hours? ago/, " h ago");
  const wWhen = Math.max(...rows.map((r) => short(r.at).length));
  const wKind = Math.max(4, Math.min(14, Math.max(...rows.map((r) => plain(r.kind ?? r.trigger ?? "").length))));
  // 4 of indent, when, 2, kind, 2, how sure (4), 2, the page
  const wPage = Math.max(8, room() - 14 - wWhen - wKind);
  head(`The latest ${rows.length} event${rows.length === 1 ? "" : "s"}`, "Newest first. sure: how confident the model was.");
  out(`    ${c.gray("when".padEnd(wWhen))}  ${c.gray("kind".padEnd(wKind))}  ${c.gray("sure")}  ${c.gray("page")}`);
  for (const r of rows) {
    const sure = r.confidence === null ? "" : `${Math.round(r.confidence * 100)}%`;
    out(`    ${c.gray(short(r.at).padEnd(wWhen))}  ${clean(plain(r.kind ?? r.trigger ?? ""), wKind).padEnd(wKind)}  ${sure.padStart(4)}  ${c.cyan(clean(r.route ?? "", wPage))}`.trimEnd());
    const did = didAct(r) ? actionWords(r.ran) : null;
    if (did) out(`    ${" ".repeat(wWhen)}  ${c.green(`${sym.arrow} ${clean(did, 60)}`)}`);
    if (all) {
      const extra = [r.mode ? `mode ${r.mode}` : "", r.trigger ? `trigger ${r.trigger}` : "", r.fn ? `fn ${r.fn}` : "", did ? "" : "reported"].filter(Boolean).join(` ${sym.dot} `);
      for (const l of wrap(clean(extra, 300), room() - 6 - wWhen)) out(`    ${" ".repeat(wWhen)}  ${c.gray(l)}`);
    }
  }
  if (!all && app.more.events.length > rows.length) out(`    ${c.gray(`and ${n(app.more.events.length - rows.length)} more, each with its mode and trigger: add --all`)}`);
  out();
  out(`  ${c.gray("As data:          ")} ${c.cyan("npx genclass events --json")}`);
  out(`  ${c.gray("Everything stored:")} ${c.cyan("npx genclass export")}`);
  out();
}

/** `genclass events`. */
export function events(o = {}, deps = {}) {
  return appView(o, deps, {
    name: "events",
    json: (app, _s, target) => ({ ok: true, app: target.name, range: app.range, demo: app.demo, events: app.more.events }),
    show: (app) => renderEvents(app, { all: o.all, now: deps.now }),
  });
}

// ---------------------------------------------------------------------------------------------------- health

const sum = (list) => (list ?? []).reduce((a, x) => a + x.count, 0);
const BREAKDOWNS = [
  ["Triggers", "trigger"],
  ["Diagnoses", "diagnosis"],
  ["Routes", "route"],
  ["Pages", "page_route"],
  ["Functions", "fn"],
  ["Model load states", "model_state"],
  ["Decision latency", "latency_bucket"],
  ["Fail-opens", "fail_open"],
  ["Modes", "mode"],
  ["Model versions", "model_version"],
  ["Hosts", "host"],
  ["Possible issues", "possible_diagnosis"],
  ["Action limits", "action_limits"],
  ["Measured checks", "check_kind"],
  ["Checks setting", "visual_setting"],
];

/** The lines of `genclass health`: how GenClass itself is running on the app's pages. */
export function renderHealth(app, o = {}) {
  const t = app.more.totals;
  const b = app.more.breakdowns;
  const v = (k) => t[k] ?? 0;
  const ms = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${n(Math.round(x))} ms`);
  period(app, o.now);
  if (!v("sessions")) {
    out();
    note("No page load in this period, so there is nothing to say about how GenClass ran.");
    out();
    return;
  }
  out();
  const ready = v("model_ready");
  const failed = v("model_load_failed");
  const flag = ready + failed && failed / (ready + failed) > 0.02 ? c.yellow("needs a look") : ready ? c.green("healthy") : "";
  part("Model loads", ready + failed ? `${pct(ready, ready + failed)} succeeded ${sym.dot} ${n(ready)} loads, ${n(failed)} failures${flag ? ` ${sym.dot} ${flag}` : ""}` : "none yet");
  const be = b.backend ?? [];
  if (be.length || v("modelLoadAvgMs")) part("Where it ran", [be.map((x) => `${x.key === "webgpu" ? "WebGPU" : x.key === "wasm" ? "WASM" : clean(x.key, 20)} ${pct(x.count, sum(be))}`).join(", "), v("modelLoadAvgMs") ? `average load ${ms(v("modelLoadAvgMs"))}` : ""].filter(Boolean).join(` ${sym.dot} `));
  // from the decision records that arrived: routine ones are sampled, so the average leans towards the rest
  const sampled = v("records_sampled_out") + v("records_capped") > 0;
  if (v("latency_ms_n")) part("Decision time", `${ms(v("latencyAvgMs"))} ${sym.dot} average of ${n(v("latency_ms_n"))} records${sampled ? ", sampled" : ""}`);
  part("No decision", v("failOpens") ? `${n(v("failOpens"))} times the app carried on without one` : c.green("never"));
  const hs = v("hidden_skipped");
  const md = v("model_dropped");
  part("Not checked", hs + md ? `${n(hs + md)} ${sym.dot} ${[hs ? `${n(hs)} in hidden tabs` : "", md ? `${n(md)} over the decision rate limit` : ""].filter(Boolean).join(", ")}` : c.green("nothing"));
  if (v("actionLimits")) part("Action limits", `reached ${n(v("actionLimits"))} times`);
  const so = v("records_sampled_out");
  const rc = v("records_capped");
  const td = v("telemetry_dropped");
  if (so + rc + td) part("Records not sent", `${n(so + rc + td)} ${sym.dot} ${[so ? `${n(so)} routine decisions sampled out` : "", rc ? `${n(rc)} over the per-page cap` : "", td ? `${n(td)} dropped in the browser` : ""].filter(Boolean).join(", ")}`);
  const errs = (b.model_errors ?? []).length ? b.model_errors : (b.model_error_events ?? []);
  if (errs.length) {
    part("Load errors", `${n(sum(errs))} in all`);
    for (const x of errs.slice(0, o.all ? 25 : 4)) for (const [i, l] of wrap(`${n(x.count)} × ${clean(x.key, 300)}`, room() - 8).entries()) out(`      ${c.gray(i ? `  ${l}` : l)}`);
  }
  // the measured checks' coverage: the counts in `genclass problems` are read against it
  const vs = Object.fromEntries((b.visual_setting ?? []).map((x) => [x.key, x.count]));
  const cl = v("check_loads");
  if (cl || vs.on || vs.local) {
    const tiers = Object.fromEntries((b.check_tier ?? []).map((x) => [x.key, x.count]));
    part(
      "Visual checks",
      cl
        ? [`ran on ${pct(cl, v("sessions"))} of page loads`, tiers.light ? `${n(tiers.light)} on the light tier` : "", v("visual_fix") ? `${n(v("visual_fix"))} with fixes on` : "", v("check_ms") ? `about ${n(Math.round(v("check_ms") / cl))} ms each` : ""].filter(Boolean).join(` ${sym.dot} `)
        : `${c.yellow("not running")} ${sym.dot} off on public hosts until the app turns them on (visual: true)`,
    );
  }
  const rv = b.runtime ?? [];
  if (rv.length) part("Runtime versions", `${rv.slice(0, 3).map((x) => clean(x.key, 30)).join(", ")}${rv.length > 1 ? ` ${sym.dot} more than one version is live` : ""}`);
  const modes = (b.mode ?? []).filter((x) => x.key !== "(unknown)");
  if (modes.length) part("Mode", modes.map((x) => `${clean(x.key, 20)} ${pct(x.count, sum(modes))}`).join(", "));
  if (o.all) for (const [title, key] of BREAKDOWNS) bars(title, b[key] ?? [], { shown: 10 });
  out();
  if (!o.all) out(`  ${c.gray("Every breakdown:")} ${c.cyan("npx genclass health --all")}`);
  out();
}

/** `genclass health`. */
export function health(o = {}, deps = {}) {
  const keys = [...BREAKDOWNS.map(([, k]) => k), "backend", "runtime", "model_errors", "model_error_events", "check_tier"];
  return appView(o, deps, {
    name: "health",
    json: (app, _s, target) => ({ ok: true, app: target.name, range: app.range, demo: app.demo, totals: Object.fromEntries(Object.entries(app.more.totals).filter(([k]) => !k.startsWith("ix_"))), breakdowns: Object.fromEntries(keys.map((k) => [k, app.more.breakdowns[k] ?? []])) }),
    show: (app) => renderHealth(app, { all: o.all, now: deps.now }),
  });
}

// ----------------------------------------------------------------------------------------------------- agent

const ON = /^(on|1|true|yes)$/i;
const readJson = (file) => {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
};

/**
 * How the coding agent is connected in a project folder: the agent configuration files that hold GenClass's MCP
 * server, and whether the server is given the app's private dashboard link (production numbers) and told to report
 * what the agent does. The link is looked for where it belongs, outside the repository too: the project's own
 * files, and Claude Code's own settings for this folder (~/.claude.json). Only the genclass entry is read.
 * @returns {{ files: string[], production: boolean, reports: boolean, inRepo: boolean }}
 */
export function agentSetup(dir, home = homedir()) {
  const files = agentConfigs(dir);
  const envs = [];
  let inRepo = false;
  for (const f of [".mcp.json", ".cursor/mcp.json"]) {
    const e = readJson(join(dir, f))?.mcpServers?.genclass?.env;
    if (e && typeof e === "object") {
      envs.push(e);
      if (typeof e.GENCLASS_DASHBOARD === "string" && e.GENCLASS_DASHBOARD && e.GENCLASS_DASHBOARD !== "sample") inRepo = true;
    }
  }
  const mine = readJson(join(home, ".claude.json"))?.projects?.[resolve(dir)]?.mcpServers?.genclass;
  if (mine && typeof mine === "object") {
    if (!files.length) files.push("Claude Code's own settings");
    if (mine.env && typeof mine.env === "object") envs.push(mine.env);
  }
  const link = envs.map((e) => e.GENCLASS_DASHBOARD).find((x) => typeof x === "string" && x && x !== "sample");
  const rep = envs.map((e) => e.GENCLASS_REPORT).find((x) => typeof x === "string" && x);
  return { files, production: !!link, reports: !!rep && (ON.test(rep) ? !!link : true), inRepo };
}

/** The lines of `genclass agent`. `setup`: agentSetup() of this folder, or null when the app is not this folder's. */
export function renderAgent(app, setup, o = {}) {
  const st = app.more.stages;
  period(app, o.now);
  if (setup) {
    out();
    part("Connected here", setup.files.length ? `${c.green("yes")} ${sym.dot} ${setup.files.join(", ")}` : `${c.yellow("not yet")} ${sym.dot} npx genclass setup adds GenClass's MCP server`, 20);
    part("Production numbers", setup.production ? `${c.green("on")} ${sym.dot} the agent reads what GenClass found on the live site` : `off ${sym.dot} npx genclass agent link gives the agent the live site's numbers`, 20);
    part("Reports back", setup.reports ? `${c.green("on")} ${sym.dot} what it finds, reproduces and proves shows below` : `off ${sym.dot} it comes on with the link`, 20);
    if (setup.inRepo) note("The dashboard link is in a file of this project. Keep it out of what you commit: anyone with it can read this app's numbers.");
  }
  head("The loop", "What the agent did with the findings, as it reported it.");
  if (!st.found && !app.more.agentLog.length) {
    out(`    ${c.gray("Nothing reported in this period.")}`);
    if (setup && !setup.reports) {
      out(`    ${c.gray("It reports once it has the link:")}`);
      out(`    ${c.cyan("npx genclass agent link")}`);
    }
  } else {
    out(`    ${c.bold(n(st.found))} found ${c.gray(sym.arrow)} ${c.bold(n(st.reproduced))} reproduced`);
    out(`    ${c.gray(sym.arrow)} ${c.bold(n(st.fixed))} fix proven ${c.gray(sym.arrow)} ${c.bold(n(st.closed))} closed`);
    const tail = [st.open ? `${n(st.open)} open now` : "", st.continued ? `${n(st.continued)} still reproduced after a fix` : ""].filter(Boolean).join(` ${sym.dot} `);
    if (tail) out(`    ${c.gray(tail)}`);
  }
  const f = app.more.findings;
  if (f.length) {
    head("Findings");
    for (const x of o.all ? f : f.slice(0, 6)) {
      const state = [x.reproduced === true ? "reproduced" : x.reproduced === false ? "not reproduced" : "", x.tested ? "test written" : "", x.proven ? "fix proven" : "", x.closed ? "closed" : "open"].filter(Boolean).join(` ${sym.dot} `);
      const kind = clean(x.kind ?? "finding", 24);
      out(`    ${kind} ${c.gray("on")} ${c.cyan(clean(x.route ?? "(page unknown)", room() - 8 - kind.length))}`);
      out(`      ${c.gray(`${state}${x.updated ? ` ${sym.dot} ${ago(x.updated, o.now)}` : ""}`)}`);
    }
    if (!o.all && f.length > 6) out(`    ${c.gray(`and ${n(f.length - 6)} more: add --all`)}`);
  }
  const log = app.more.agentLog;
  if (o.all && log.length) {
    head("Log", "Newest first.");
    for (const x of log) {
      const what = x.step === "explore" ? `${n(x.runs)} page loads, ${n(x.races)} races` : x.step === "replay" ? (x.reproduced ? "reproduced" : "not reproduced") : x.step === "cleared" ? `cleared ${x.what ?? ""}` : "";
      out(`    ${c.gray(ago(x.at, o.now).padEnd(15))}${clean(x.step ?? "", 8).padEnd(9)}${clean([x.kind, x.route].filter(Boolean).join(" on "), room() - 28)}`.trimEnd());
      if (what) out(`    ${" ".repeat(24)}${c.gray(what)}`);
    }
  } else if (log.length) out(`    ${c.gray(`Its log, ${n(log.length)} steps: add --all`)}`);
  out();
  out(`  ${c.gray("Hand it a problem:")} ${c.cyan("npx genclass fix")}`);
  out();
}

/** `genclass agent`: how the coding agent is connected, and what it did with the findings. */
export function agent(o = {}, deps = {}) {
  return appView(o, deps, {
    name: "agent",
    json: (app, state, target) => ({ ok: true, app: target.name, range: app.range, here: state.app.token === target.token ? agentSetup(state.cwd, deps.home) : null, stages: app.more.stages, findings: app.more.findings, log: app.more.agentLog, last: app.agent.last }),
    show: (app, state, target) => renderAgent(app, state.app.token === target.token ? agentSetup(state.cwd, deps.home) : null, { all: o.all, now: deps.now }),
  });
}

// ---------------------------------------------------------------------------------------------------- report

/** `genclass report`: the period as Markdown, to the terminal (or a pipe), or to the file --out names. */
export function report(o = {}, deps = {}) {
  const text = (app, target) => markdown(target.name, app, app.more.generated ?? new Date(deps.now ?? Date.now()).toISOString());
  return appView(o, deps, {
    name: "report",
    // the report is the output: no card over it, so it can be piped or pasted as it is
    plain: !o.out,
    json: (app, _s, target) => ({ ok: true, app: target.name, range: app.range, markdown: text(app, target) }),
    show: (app, _s, target) => {
      if (!o.out) return void out(text(app, target));
      try {
        writeFileSync(resolve(o.cwd ?? process.cwd(), String(o.out)), `${text(app, target)}\n`);
      } catch (e) {
        bad(`Could not write ${clean(String(o.out), 80)}: ${e?.message ?? e}`);
        out();
        return 1;
      }
      good(`Wrote ${c.bold(clean(String(o.out), 80))} ${c.gray(`(${RANGE_WORDS[app.range] ?? app.range})`)}`);
      out();
      return 0;
    },
  });
}
