// The GenClass report as an email (src/report.ts builds it): a subject, an HTML body and a plain-text body.
//
// Invariants:
// - Pure: the same report gives the same email. Everything from outside (app and page names, the model's words,
//   design sites, pull request names) goes through esc() and is a line of text; links are https and built in
//   src/report.ts or here from the report's own origin.
// - Summary first (the owner, 2026-11-15): a headline, a few short sentences (what happened, what to do first) and at
//   most one button; the details follow below a rule. The model's summary leads only once an app has measured data;
//   before that the lead is written here from the report's own items.
// - Looks like genclass.dev: black and green, square corners (no border-radius anywhere), 1px rules between sections
//   instead of cards, no pills, dots or emoji. Light colours are inline; the dark ones come from one <style> block
//   (prefers-color-scheme, and Outlook.com's data-ogsc/data-ogsb) for the clients that read it.
// - Email-safe HTML: tables, inline styles, system fonts only, no script, one image (the mark, from genclass.dev), the
//   main button a table cell and the column a fixed 600 px table in Outlook.
// - Short to read: a prompt is a link to its signed page (/account/report/prompt), never a block of text, and the same
//   setup step on several apps is one row. Only without a signed link (no INTEGRATIONS_KEY, or past the 60 links a
//   report signs) is a prompt printed, and then only a short one; the plain-text body always has them all.
// - The details and their order: Free's half, what needs fixing (critical, then important), setup when an app is not
//   connected, the apps' numbers, code changes, visitors, security, setup otherwise, worth a look, suggestions, website
//   design, then one quiet line for the sections with nothing new, and how to change or stop these emails. Every
//   section is about the account's own sites: while GenClass has measured none of them and has no genclass suggest
//   answer, the lead names the apps that send nothing yet and the details hold no generic ideas.
// - An app on Free is counted, not listed: its problems' count shows with Pro's box, never its pages or prompts.

import { esc } from "./escape.js";
import { DESIGN_CHECKS, EVERY_WORDS, PRIORITY_WORDS, showcasePrompt, type AppReport, type Every, type Item, type Priority, type Report } from "./report.js";

/** Light colours (inline) and their dark twins (the <style> block): the dashboard's light theme and genclass.dev. */
const C = { bg: "#ffffff", ink: "#171717", ink2: "#525252", ink3: "#6b6b6b", rule: "#e6e6e6", code: "#f3f3f3", green: "#0a7c4a", onGreen: "#ffffff", greenBg: "#e8f5ee", red: "#c8242b", amber: "#9a5b00", grey: "#6b6b6b" };
const D = { bg: "#000000", ink: "#f0f1e9", ink2: "#a0a196", ink3: "#88897f", rule: "#30312b", code: "#131311", green: "#2fd07f", onGreen: "#02140a", greenBg: "#04150c", red: "#ff6b4a", amber: "#f5c66a", grey: "#88897f" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const P_COLOUR: Record<Priority, string> = { 0: C.red, 1: C.amber, 2: C.grey };
const P_LABEL: Record<Priority, string> = { 0: "P0 critical", 1: "P1 important", 2: "P2 worth a look" };
const ADJ: Record<Every, string> = { hourly: "hourly", daily: "daily", weekly: "weekly", monthly: "monthly", off: "" };
/** A prompt printed in the HTML when it has no link: longer ones are left to the plain-text body. */
const INLINE_PROMPT_MAX = 700;

const fmt = (x: number): string => Math.round(x).toLocaleString("en-US");
const plural = (k: number, one: string, many: string): string => `${fmt(k)} ${Math.round(k) === 1 ? one : many}`;
const day = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const clock = (iso: string): string => `${iso.slice(11, 16)} UTC`;
/** "+40%" / "-12%" / "new" against the period before; "" when both are 0. */
function delta(now: number, before: number): string {
  if (!now && !before) return "";
  if (!before) return "new";
  const d = Math.round(((now - before) / before) * 100);
  return d === 0 ? "same" : `${d > 0 ? "+" : ""}${d}%`;
}
/** "a", "a and b", "a, b and c". */
const andList = (xs: string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** "the last 24 hours" -> "24 hours", for "the 24 hours before". */
const span = (period: string): string => period.replace(/^the (last )?/, "");

const counts = (items: Item[]): Record<Priority, number> => {
  const c: Record<Priority, number> = { 0: 0, 1: 0, 2: 0 };
  for (const i of items) c[i.p]++;
  return c;
};
/** What the headline and the counts count: every item but setup steps below critical. */
const counted = (r: Report): Item[] => r.items.filter((i) => i.section !== "setup" || i.p === 0);
const problemItems = (r: Report) => r.items.filter((i) => i.section === "problems");
const measured = (r: Report): AppReport[] => r.apps.filter((x) => !!x.lastEvent && !x.demo);
/** Whether GenClass knows anything about the account's sites: a measured app, or a genclass suggest answer. */
const knowsSites = (r: Report): boolean => measured(r).length > 0 || r.suggestions.length + r.suggestionsHidden + r.designs.length + r.designsHidden > 0;
/** "Glyco site" or "3 apps": what the report is about, by name when there is one. */
const appsName = (r: Report): string => (r.apps.length === 1 ? r.apps[0]!.name : plural(r.apps.length, "app", "apps"));
/** The headline when no app has measured data: the apps by name. */
const notSending = (r: Report): string => (r.apps.length === 1 ? `${r.apps[0]!.name} isn't sending data yet` : `${plural(r.apps.length, "app isn't", "apps aren't")} sending data yet`);
/** "1 critical · 2 worth a look": the counts that are not 0, or "" when all are. */
const countLine = (c: Record<Priority, number>): string => ([0, 1, 2] as Priority[]).filter((k) => c[k]).map((k) => `${fmt(c[k])} ${PRIORITY_WORDS[k].toLowerCase()}`).join(" · ");

/** The subject line. Pure. */
export function subjectOf(r: Report): string {
  const test = r.kind === "test" ? "[Test] " : "";
  const p0 = r.items.filter((i) => i.p === 0);
  if (r.kind === "alert" && p0[0]) return `${test}[P0] ${p0[0].app}: ${p0[0].title}${p0.length > 1 ? ` (+${p0.length - 1} more)` : ""}`.slice(0, 200);
  const c = counts(counted(r));
  const adj = ADJ[r.every] || "daily";
  if (!r.apps.length) return `${test}GenClass ${adj} report: add your first app`;
  const name = r.apps.length === 1 ? r.apps[0]!.name : `${r.apps.length} apps`;
  const lead = `${test}GenClass ${adj} report, ${name}`;
  if (c[0] || (c[1] && measured(r).length)) return `${lead}: ${[c[0] ? `${c[0]} critical` : "", c[1] ? `${c[1]} important` : ""].filter(Boolean).join(", ")}`.slice(0, 200);
  if (!measured(r).length) return `${lead}: finish setting up`;
  return `${lead}: all clear`;
}

const hiddenProblems = (r: Report): number => r.problemsHidden.reduce((n, x) => n + x.counts[0] + x.counts[1] + x.counts[2], 0);
/** What Free's half of this report leaves out, as short phrases (empty when nothing is left out). */
function leftOut(r: Report): string[] {
  const hp = hiddenProblems(r);
  return [
    hp ? `${plural(hp, "more problem", "more problems")} with ${hp === 1 ? "its" : "their"} pages and fix prompts` : "",
    r.actionsHidden ? `${plural(r.actionsHidden, "next step", "next steps")} from the summary, each with a prompt` : "",
    r.suggestionsHidden ? plural(r.suggestionsHidden, "more suggestion", "more suggestions") : "",
    r.designsHidden ? plural(r.designsHidden, "more website design", "more website designs") : "",
    r.apps.some((x) => x.visitorsLimited && x.visitors) ? "where your visitors come from and what they read" : "",
  ].filter(Boolean);
}
/** "1 critical, 2 important" for counts by priority. */
const byP = (c: Record<Priority, number>): string => ([0, 1, 2] as Priority[]).filter((k) => c[k]).map((k) => `${fmt(c[k])} ${PRIORITY_WORDS[k].toLowerCase()}`).join(", ");

// --------------------------------------------------------------------------------------------- the lead

/** The headline when there is no model summary to lead with. */
function headlineOf(r: Report): string {
  const c = counts(counted(r));
  if (r.kind === "alert") return r.items.length === 1 ? r.items[0]!.title : `${fmt(r.items.length)} critical problems`;
  if (c[0]) return `${plural(c[0], "critical problem", "critical problems")}${c[1] ? ` and ${plural(c[1], "important one", "important ones")}` : ""}`;
  if (!r.apps.length) return "Add your first app to GenClass";
  if (!measured(r).length) return notSending(r);
  if (c[1]) return `${plural(c[1], "important thing", "important things")} to look at`;
  return `All clear on ${appsName(r)}`;
}

/** The item to do first: the most urgent one at critical or important. */
const firstItem = (r: Report): Item | undefined => r.items.find((i) => i.p <= 1 && i.rule !== "setup:first-app") ?? r.items.find((i) => i.rule === "setup:first-app");
/** An item's main action: its signed prompt, else its link. */
function itemAction(r: Report, i: Item): { href: string; label: string; prompt?: boolean } | null {
  const href = i.prompt ? r.promptLinks[i.prompt] : undefined;
  if (href) return { href, label: i.section === "setup" ? "Copy the setup prompt" : "Copy the fix prompt", prompt: true };
  return i.link ? { href: i.link.href, label: i.link.label } : null;
}

/** What happened, in a sentence or two, from the measured apps' numbers. */
function numbersText(r: Report): string {
  const m = measured(r);
  const tot = (f: (x: AppReport) => number) => m.reduce((s, x) => s + f(x), 0);
  const loads = tot((x) => x.totals.loads), before = tot((x) => x.totals.prevLoads);
  const problems = tot((x) => x.totals.problems), checks = tot((x) => x.totals.checks);
  const period = m[0]!.period;
  const d = before ? Math.round(((loads - before) / before) * 100) : 0;
  const vs = !before ? "" : d > 0 ? `, ${d}% more than the ${span(period)} before` : d < 0 ? `, ${-d}% fewer than the ${span(period)} before` : `, as many as the ${span(period)} before`;
  const who = m.length === 1 ? m[0]!.name : `Your ${m.length} apps`;
  const found = problems && checks ? `GenClass found ${plural(problems, "problem", "problems")}, and its measured checks fired ${plural(checks, "time", "times")}.` : problems ? `GenClass found ${plural(problems, "problem", "problems")}.` : checks ? `GenClass's measured checks fired ${plural(checks, "time", "times")}.` : "Nothing broke.";
  return `${who} had ${plural(loads, "page load", "page loads")} in ${period}${vs}. ${found}`;
}

/** What to do first, in a sentence. */
function firstText(r: Report, i: Item | undefined): string {
  if (i) return `First: ${i.title}${r.apps.length > 1 && i.appId && !i.title.includes(i.app) ? ` (${i.app})` : ""}.`;
  const p2 = problemItems(r).filter((x) => x.p === 2).length;
  return p2 ? `Nothing critical or important. ${plural(p2, "problem is", "problems are")} worth a look below.` : "";
}

interface Lead {
  headline: string;
  text: string;
  /** The model's next steps (Pro), in order. */
  steps: { title: string; why: string | null; prompt: string | null }[];
  /** The one button under the lead, or null; `prompt` when it opens a prompt the text part prints in full. */
  button: { href: string; label: string; prompt?: boolean } | null;
  /** A single alert's pages and its quiet second link: the lead is then the whole email. */
  pages: string[];
  link: { href: string; label: string } | null;
  /** The text is the model's. */
  model: boolean;
}

/** The headline, the summary and the first thing to do. Pure. */
function leadOf(r: Report): Lead {
  const top = firstItem(r);
  const button = top ? itemAction(r, top) : null;
  if (r.kind === "alert") {
    const i = r.items[0];
    const one = r.items.length === 1;
    const text = !i ? "" : one ? `${i.app}: ${i.detail}` : `GenClass saw ${andList(r.items.slice(0, 3).map((x) => `${x.title} (${x.app})`))}${r.items.length > 3 ? ` and ${plural(r.items.length - 3, "more", "more")}` : ""}.`;
    const link = one && i?.link && i.link.href !== button?.href ? i.link : null;
    return { headline: headlineOf(r), text, steps: [], button, model: false, pages: one && i ? i.pages : [], link };
  }
  const none = { pages: [], link: null };
  if (!r.apps.length) return { headline: headlineOf(r), text: "Your GenClass account has no app yet. Add one and GenClass watches it for you: what breaks for your visitors, on which pages, and a prompt to fix each.", steps: [], button, model: false, ...none };
  if (!measured(r).length) {
    const one = r.apps.length === 1;
    const names = andList(r.apps.map((x) => x.name));
    const wait = r.items.find((i) => i.rule === "setup:no-data");
    const act = wait ? itemAction(r, wait) : button;
    return {
      headline: headlineOf(r),
      text: `GenClass hasn't had a page load from ${names} yet. Paste the setup prompt into your coding agent, or run npx genclass in ${one ? "the app's" : "each app's"} folder. Once ${one ? `${r.apps[0]!.name} sends its` : "they send their"} first page load, this email shows what breaks there and on which pages.`,
      steps: [],
      // several apps: the button is the first one's, by name (each app's own link is in the setup section)
      button: act && wait && !one ? { ...act, label: `${act.label} for ${wait.app}` } : act,
      model: false,
      ...none,
    };
  }
  const s = r.summary;
  if (s) return { headline: s.headline, text: s.text, steps: s.actions, button: s.actions.length || r.actionsHidden ? null : button, model: true, ...none };
  return { headline: headlineOf(r), text: [numbersText(r), firstText(r, top)].filter(Boolean).join(" "), steps: [], button, model: false, ...none };
}

// --------------------------------------------------------------------------------------------- html pieces

const GAP = "&nbsp;&nbsp;&nbsp;&nbsp;";
const a = (href: string, text: string, style = ""): string => `<a class="gc-a" href="${esc(href)}" style="color:${C.green};text-decoration:none;font-weight:600;${style}">${esc(text)}</a>`;
/** A quiet link (the footer). */
const qa = (href: string, text: string): string => `<a class="gc-i3" href="${esc(href)}" style="color:${C.ink3};text-decoration:underline">${esc(text)}</a>`;
const p = (html: string, style = ""): string => `<p class="gc-i2" style="margin:0;font-size:14px;line-height:21px;color:${C.ink2};${style}">${html}</p>`;
const note = (html: string, style = ""): string => `<p class="gc-i3" style="margin:10px 0 0;font-size:13px;line-height:19px;color:${C.ink3};${style}">${html}</p>`;
const strong = (t: string): string => `<strong class="gc-i1" style="color:${C.ink};font-weight:600">${esc(t)}</strong>`;
const code = (t: string): string => `<code class="gc-code" style="font-family:${MONO};font-size:13px;background:${C.code};color:${C.ink};padding:1px 4px">${esc(t)}</code>`;
const title = (t: string): string => `<p class="gc-i1" style="margin:0;font-size:15px;line-height:22px;font-weight:600;color:${C.ink}">${esc(t)}</p>`;
/** Links on one line under an item. */
const links = (xs: string[]): string => (xs.length ? `<p style="margin:10px 0 0;font-size:14px;line-height:21px">${xs.join(GAP)}</p>` : "");
const TABLE = `role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`;

/** The one filled button: a table cell, so Outlook draws it too. */
const button = (href: string, text: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0"><tr><td class="gc-btn" bgcolor="${C.green}" style="background:${C.green}"><a class="gc-btn-a" href="${esc(href)}" style="display:inline-block;padding:11px 18px;font-size:15px;line-height:20px;font-weight:600;color:${C.onGreen};text-decoration:none">${esc(text)}</a></td></tr></table>`;

/** A section of the details: a rule, a title (a quiet note on the right), the body. */
function section(name: string, body: string, meta = ""): string {
  if (!body) return "";
  return `<table ${TABLE}><tr><td style="height:36px;line-height:36px;font-size:0">&nbsp;</td></tr><tr><td class="gc-rule" style="border-top:1px solid ${C.rule};padding:18px 0 0">
<table ${TABLE}><tr><td style="vertical-align:baseline"><h2 class="gc-i1" style="margin:0;font-size:17px;line-height:24px;font-weight:700;color:${C.ink}">${esc(name)}</h2></td>${meta ? `<td class="gc-i3" style="vertical-align:baseline;text-align:right;font-size:13px;line-height:19px;color:${C.ink3};white-space:nowrap">${esc(meta)}</td>` : ""}</tr></table>${body}</td></tr></table>`;
}

/** Rows inside a section, a rule between them. */
function rows(parts: string[]): string {
  return parts.map((h, k) => `<table ${TABLE}><tr><td class="gc-rule" style="${k ? `border-top:1px solid ${C.rule};` : ""}padding:${k ? 16 : 12}px 0 ${k === parts.length - 1 ? 0 : 16}px">${h}</td></tr></table>`).join("");
}

/** An item's content beside a 3px bar in its priority's colour (a table cell: square, and drawn in every client). */
const barred = (pr: Priority, html: string): string =>
  `<table ${TABLE}><tr><td class="gc-p${pr}" width="3" bgcolor="${P_COLOUR[pr]}" style="width:3px;background:${P_COLOUR[pr]};font-size:0;line-height:0">&nbsp;</td><td style="padding:0 0 0 14px">${html}</td></tr></table>`;

/** "Critical · Shop" under an item's title: its priority in its colour, and where it is when that is not obvious. */
const meta = (r: Report, pr: Priority, where: string): string =>
  `<p style="margin:2px 0 6px;font-size:13px;line-height:19px"><span class="gc-c${pr}" style="color:${P_COLOUR[pr]};font-weight:600">${esc(PRIORITY_WORDS[pr])}</span>${where && (r.apps.length !== 1 || where !== r.apps[0]!.name) ? `<span class="gc-i3" style="color:${C.ink3}"> · ${esc(where)}</span>` : ""}</p>`;

/** A prompt as a link to its signed page; without one, a short prompt printed or a word that the text part has it. */
function promptBits(r: Report, prompt: string, label: string): { link: string; block: string } {
  const href = r.promptLinks[prompt];
  if (href) return { link: a(href, label), block: "" };
  if (prompt.length > INLINE_PROMPT_MAX) return { link: "", block: note("The full prompt is in the plain-text part of this email.") };
  return {
    link: "",
    block: `<div class="gc-code" style="margin:10px 0 0;padding:10px 12px;background:${C.code};border:1px solid ${C.rule};font-family:${MONO};font-size:12px;line-height:18px;color:${C.ink};white-space:pre-wrap;word-break:break-word">${esc(prompt)}</div>${note("Paste it into Claude Code, Codex or Cursor.", "margin-top:6px")}`,
  };
}

/** One line that says something is Pro's, with the upgrade link. */
function lockedLine(r: Report, html: string): string {
  const u = r.upgrade;
  return `<p class="gc-rule gc-i2" style="margin:14px 0 0;padding:10px 12px;border:1px solid ${C.rule};font-size:13px;line-height:20px;color:${C.ink2}">${html}${u ? `${GAP}${a(u.url, `Unlock with ${u.plan}`)}` : ""}</p>`;
}

function itemRow(r: Report, i: Item, actions: boolean): string {
  const pages = i.pages.length ? `<p class="gc-i2" style="margin:6px 0 0;font-family:${MONO};font-size:12px;line-height:18px;color:${C.ink2}">${i.pages.map(esc).join(" &nbsp;·&nbsp; ")}</p>` : "";
  const pr = actions && i.prompt ? promptBits(r, i.prompt, i.section === "setup" ? "Copy the setup prompt" : "Copy the fix prompt") : { link: "", block: "" };
  const acts = links([pr.link, i.link ? a(i.link.href, i.link.label) : ""].filter(Boolean)) + pr.block;
  return barred(i.p, `${title(i.title)}${meta(r, i.p, i.app)}${p(esc(i.detail))}${pages}${acts}`);
}

/** The same step on several apps (one rule, one title): one row naming them, a link per app. */
function groupRow(r: Report, g: Item[]): string {
  const first = g[0]!;
  const per = g
    .map((i) => {
      const href = (i.prompt && r.promptLinks[i.prompt]) || i.link?.href;
      return href ? a(href, i.app) : esc(i.app);
    })
    .join(GAP);
  const linked = g.every((i) => i.prompt && r.promptLinks[i.prompt]);
  const what = linked ? "Copy the setup prompt for" : first.link ? `${first.link.label}:` : "";
  const missing = !linked && g.some((i) => i.prompt) ? note("The prompts are in the plain-text part of this email.", "margin-top:6px") : "";
  return barred(first.p, `${title(first.title)}${meta(r, first.p, plural(g.length, "app", "apps"))}${p(esc(`On ${andList(g.map((i) => i.app))}. ${first.detail}`))}<p class="gc-i2" style="margin:10px 0 0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(what)}${GAP}${per}</p>${missing}`);
}

/** Items in order, the same rule and title on several apps folded into one group. */
function grouped(items: Item[]): Item[][] {
  const out: Item[][] = [];
  const at = new Map<string, Item[]>();
  for (const i of items) {
    const k = `${i.section}\t${i.rule}\t${i.title}\t${i.p}`;
    const g = i.appId ? at.get(k) : undefined;
    if (g) g.push(i);
    else {
      const n = [i];
      out.push(n);
      if (i.appId) at.set(k, n);
    }
  }
  return out;
}
const itemRows = (r: Report, items: Item[], actions: boolean): string => rows(grouped(items).map((g) => (g.length > 1 ? groupRow(r, g) : itemRow(r, g[0]!, actions))));

/** The numbered steps (the model's next steps, the suggestions). */
function steps(r: Report, list: { title: string; why: string | null; prompt: string | null }[], label: string): string {
  return rows(
    list.map((s, k) => {
      const pr = s.prompt ? promptBits(r, s.prompt, label) : { link: "", block: "" };
      return `<table ${TABLE}><tr><td class="gc-a" width="24" style="width:24px;vertical-align:top;font-size:15px;line-height:22px;font-weight:700;color:${C.green}">${k + 1}.</td><td style="vertical-align:top">${title(s.title)}${s.why ? p(esc(s.why), "margin-top:2px") : ""}${links(pr.link ? [pr.link] : [])}${pr.block}</td></tr></table>`;
    }),
  );
}

// --------------------------------------------------------------------------------------------- the parts

function leadHtml(r: Report, l: Lead): string {
  const cl = r.kind === "alert" || !measured(r).length ? "" : countLine(counts(counted(r)));
  const hidden = l.model && r.actionsHidden ? lockedLine(r, `${plural(r.actionsHidden, "next step", "next steps")}, each with a prompt for your coding agent, ${r.actionsHidden === 1 ? "is" : "are"} in the other half.`) : "";
  return `<h1 class="gc-i1" style="margin:0;font-size:25px;line-height:32px;font-weight:700;letter-spacing:-0.01em;color:${C.ink}">${esc(l.headline)}</h1>
${l.text ? `<p class="gc-i1" style="margin:12px 0 0;font-size:16px;line-height:25px;color:${C.ink}">${esc(l.text)}</p>` : ""}${l.pages.length ? `<p class="gc-i2" style="margin:8px 0 0;font-family:${MONO};font-size:13px;line-height:19px;color:${C.ink2}">${l.pages.map(esc).join(" &nbsp;·&nbsp; ")}</p>` : ""}${cl ? note(esc(cl), "margin-top:12px;font-size:14px;line-height:21px") : ""}${l.steps.length ? `<table ${TABLE}><tr><td style="padding:10px 0 0">${steps(r, l.steps, "Copy the prompt")}</td></tr></table>` : ""}${hidden}${l.button ? button(l.button.href, l.button.label) : ""}${l.link ? links([a(l.link.href, l.link.label)]) : ""}${l.model ? note("Summary written by a model from the numbers below. The priorities are GenClass's own rules.", "margin-top:14px") : ""}`;
}

/** For an account with a Free app: this report is half, what the other half holds, and the trial. */
function halfBox(r: Report): string {
  const u = r.upgrade;
  if (!u || !r.apps.length) return "";
  const out = leftOut(r);
  const what = out.length ? `${esc(u.plan)} shows the other half: ${esc(out.join(", "))}.` : `${esc(u.plan)} shows everything: every problem with its pages and fix prompts, the summary's next steps, every suggestion and design, and your visitors.`;
  return `<table ${TABLE}><tr><td style="height:28px;line-height:28px;font-size:0">&nbsp;</td></tr><tr><td class="gc-box" bgcolor="${C.greenBg}" style="background:${C.greenBg};border:1px solid ${C.green};padding:16px 18px">
${title("You're seeing half of this report on Free")}${p(what, "margin-top:4px")}${button(u.url, u.trialDays ? `Start the ${u.trialDays}-day free trial` : `Upgrade to ${u.plan}`)}${note(`${esc(u.price)}${u.trialDays ? `, ${u.trialDays} days free to start` : ""}. Cancel any time.`, "margin-top:8px")}</td></tr></table>`;
}

function needsSection(r: Report): string {
  const now = problemItems(r).filter((i) => i.p <= 1);
  // Free's half: the problems it leaves out, counted per app, never named
  const locked = r.problemsHidden.map((x) => lockedLine(r, `${plural(x.counts[0] + x.counts[1] + x.counts[2], "more problem", "more problems")} on ${strong(x.app)} (${esc(byP(x.counts))}), with ${x.counts[0] + x.counts[1] + x.counts[2] === 1 ? "its" : "their"} pages and fix prompts.`)).join("");
  if (now.length) return section(now.some((i) => i.p === 0) ? "Fix these first" : "Worth fixing", itemRows(r, now, true) + locked, plural(now.length, "item", "items"));
  return locked ? section("More problems", locked) : "";
}

function appsSection(r: Report): string {
  if (!r.apps.length) return "";
  const hourly = r.every === "hourly";
  const fixed = r.apps.some((x) => !x.demo && x.totals.fixed > 0);
  const border = `border-bottom:1px solid ${C.rule}`;
  const th = (t: string, right = true) => `<th class="gc-i3 gc-rule" style="padding:0 0 8px 8px;font-size:12px;line-height:16px;font-weight:600;color:${C.ink3};text-align:${right ? "right" : "left"};${border};white-space:nowrap">${esc(t)}</th>`;
  const td = (h: string, right = true) => `<td class="gc-i1 gc-rule" style="padding:10px 0 10px 8px;font-size:14px;line-height:20px;color:${C.ink};text-align:${right ? "right" : "left"};${border};vertical-align:top">${h}</td>`;
  const sub = (t: string) => (t ? `<br><span class="gc-i3" style="font-size:12px;line-height:16px;color:${C.ink3}">${esc(t)}</span>` : "");
  const name = (x: AppReport, status: string) => `<td class="gc-rule" style="padding:10px 0;font-size:14px;line-height:20px;text-align:left;${border};vertical-align:top">${a(x.dashboard, x.name)}${sub(`${x.pro ? "Pro" : "Free"} · ${status}`)}</td>`;
  const demo = r.apps.filter((x) => x.demo);
  if (!measured(r).length) {
    // nothing measured yet: the lead names one app; several get a row each with their state
    if (r.apps.length === 1) return "";
    const state = (x: AppReport) => (x.demo ? "sample data until real visits arrive" : x.lastEvent ? `last data ${day(x.lastEvent)}` : "not connected yet");
    return section("Your apps", `<table ${TABLE} style="border-collapse:collapse;margin:6px 0 0">${r.apps.map((x) => `<tr>${name(x, state(x))}</tr>`).join("")}</table>`);
  }
  const dash = `<span class="gc-i3" style="color:${C.ink3}">–</span>`;
  const list = r.apps
    .map((x) => {
      const t = x.totals;
      const status = !x.lastEvent ? "not connected" : x.demo ? "sample data" : `last data ${day(x.lastEvent)}`;
      // the recorded demo's estimate is not this app's numbers: none are printed as if measured
      if (x.demo || !x.lastEvent) return `<tr>${name(x, status)}${td(dash)}${td(dash)}${td(dash)}${fixed ? td(dash) : ""}${hourly ? td(dash) : ""}</tr>`;
      return `<tr>${name(x, status)}${td(`${fmt(t.loads)}${sub(delta(t.loads, t.prevLoads))}`)}${td(`${fmt(t.problems)}${sub(delta(t.problems, t.prevProblems))}`)}${td(`${fmt(t.checks)}${sub(delta(t.checks, t.prevChecks))}`)}${fixed ? td(fmt(t.fixed)) : ""}${hourly ? td(x.lastHour ? `${fmt(x.lastHour.problems + x.lastHour.checks)}${sub(`${fmt(x.lastHour.loads)} loads`)}` : dash) : ""}</tr>`;
    })
    .join("");
  const kinds = r.apps.map(kindsLine).filter(Boolean);
  return section(
    "Your apps",
    `<table ${TABLE} style="border-collapse:collapse;margin:8px 0 0"><tr><th class="gc-i3 gc-rule" style="padding:0 0 8px;font-size:12px;line-height:16px;font-weight:600;color:${C.ink3};text-align:left;${border}">App</th>${th("Page loads")}${th("Problems")}${th("Checks")}${fixed ? th("Fixed") : ""}${hourly ? th("Last hour") : ""}</tr>${list}</table>${kinds.map((l) => p(l, "margin:12px 0 0;font-size:13px;line-height:20px")).join("")}${note(
      `Problems are found by GenClass's model, checks are measured against fixed thresholds. Changes are against the ${esc(span(r.apps[0]?.period ?? "period"))} before.${demo.length ? ` ${esc(andList(demo.map((x) => x.name)))} ${demo.length === 1 ? "shows" : "show"} sample data until real visits arrive.` : ""}`,
    )}`,
  );
}

function kindsLine(x: AppReport): string {
  if (x.demo || !x.pro) return "";
  const parts = [...x.kinds, ...x.checks].map((k) => `${esc(k.name)} <span class="gc-i3" style="color:${C.ink3}">${fmt(k.count)}</span>`);
  return parts.length ? `${strong(x.name)}${GAP}${parts.join(" &nbsp;·&nbsp; ")}` : "";
}

function prsSection(r: Report): string {
  const list = r.apps.flatMap((x) => x.prs.map((pr) => ({ x, pr })));
  if (!list.length) return "";
  const word = (t: string, c: string, cls: string) => `<span class="${cls}" style="color:${c};font-weight:600">${esc(t)}</span>`;
  return section(
    "Code changes GenClass reviewed",
    rows(
      list.map(
        ({ x, pr }) =>
          `<p style="margin:0;font-size:14px;line-height:21px">${a(pr.url, `${pr.repo}#${pr.number}`)}${GAP}${pr.flagged ? word(`${plural(pr.flagged, "race flagged", "races flagged")}${pr.fresh ? `, ${fmt(pr.fresh)} new` : ""}`, C.red, "gc-c0") : word("nothing flagged", C.green, "gc-a")}${pr.closed ? `<span class="gc-i3" style="color:${C.ink3}"> · closed</span>` : ""}</p>${note(`${esc(x.name)} · reviewed ${day(pr.updated)}`, "margin-top:2px")}`,
      ),
    ),
  );
}

function visitorsSection(r: Report): string {
  const withV = r.apps.filter((x) => x.visitors && x.visitors.visits + x.visitors.views > 0);
  if (!withV.length) return "";
  return section(
    "Visitors",
    rows(
      withV.map((x) => {
        const v = x.visitors!;
        const list = (l: { key: string; count: number }[]) => l.map((y) => `${esc(y.key)} <span class="gc-i3" style="color:${C.ink3}">${fmt(y.count)}</span>`).join(" &nbsp;·&nbsp; ");
        const facts = [plural(v.visits, "visit", "visits"), plural(v.views, "page view", "page views"), v.seconds !== null ? `${fmt(v.seconds)} s a page` : "", v.rage ? plural(v.rage, "rage click", "rage clicks") : "", v.dead ? plural(v.dead, "dead click", "dead clicks") : ""].filter(Boolean);
        const line = (k: string, l: { key: string; count: number }[]) => (l.length ? `<p class="gc-i2" style="margin:4px 0 0;font-size:13px;line-height:20px;color:${C.ink2}"><span class="gc-i3" style="color:${C.ink3}">${k}</span>${GAP}${list(l)}</p>` : "");
        return `${withV.length > 1 || r.apps.length > 1 ? title(x.name) : ""}<p class="gc-i1" style="margin:0 0 4px;font-size:14px;line-height:21px;color:${C.ink}">${esc(facts.join(" · "))}</p>${line("Top pages", v.pages)}${line("From", v.sources)}${line("Countries", v.countries)}${line("Devices", v.devices)}${x.visitorsLimited ? lockedLine(r, "The pages they read, where they came from, their countries and devices are in the other half.") : ""}`;
      }),
    ),
  );
}

function securitySection(r: Report): string {
  const items = r.items.filter((i) => i.section === "security");
  return items.length ? section("Security", itemRows(r, items, true) + note("GenClass never stores a visitor's IP address: this reads patterns in the counts and your account's sign-ins."), plural(items.length, "item", "items")) : "";
}

/** Setup steps; the first app's step is the lead's own button. */
const setupItems = (r: Report): Item[] => r.items.filter((i) => i.section === "setup" && i.rule !== "setup:first-app");
function setupSection(r: Report): string {
  const items = setupItems(r);
  return items.length ? section("Finish setting up", itemRows(r, items, true), plural(items.length, "step", "steps")) : "";
}

function laterSection(r: Report): string {
  const p2 = problemItems(r).filter((i) => i.p === 2);
  return p2.length ? section("Worth a look", itemRows(r, p2, false), plural(p2.length, "item", "items")) : "";
}

function suggestionsSection(r: Report): string {
  if (!r.suggestions.length && !r.suggestionsHidden) return section("Suggestions for your app", p(`Run ${code("npx genclass suggest")} in your app's folder once. From then on this email starts with what to fix first, a prompt for each.`, "margin-top:8px"));
  const more = r.suggestionsHidden && r.upgrade ? lockedLine(r, `${plural(r.suggestionsHidden, "more suggestion", "more suggestions")}, each with a prompt, ${r.suggestionsHidden === 1 ? "is" : "are"} in the other half.`) : "";
  return section("Suggestions for your app", `${steps(r, r.suggestions, "Copy the prompt")}${more}${note("From your last genclass suggest: measured checks ordered by a model, and the model's own ideas.")}`, plural(r.suggestions.length, "idea", "ideas"));
}

const h3 = (t: string): string => `<p class="gc-i1" style="margin:20px 0 0;font-size:14px;line-height:20px;font-weight:700;color:${C.ink}">${esc(t)}</p>`;

function designSection(r: Report): string {
  const out: string[] = [];
  const design = r.apps.flatMap((x) => (x.pro ? x.checks.filter((c) => DESIGN_CHECKS.has(c.kind)).map((c) => ({ x, c })) : []));
  if (design.length) {
    out.push(p(`Measured on your visitors' screens: ${design.map(({ x, c }) => `${esc(c.name)} ${fmt(c.count)}${r.apps.length > 1 ? ` (${esc(x.name)})` : ""}`).join(" · ")}.${design.some(({ c }) => c.kind === "text-invisible") ? " Invisible text means a contrast under 1.5:1; aim for 4.5:1 for body text." : ""}`, "margin-top:8px"));
  } else if (r.apps.some((x) => x.pro && !x.demo && x.totals.loads > 0)) {
    out.push(p("No contrast, layout or font problems measured on your visitors' screens.", "margin-top:8px"));
  }
  if (r.designs.length) {
    out.push(h3("Picked for your company"));
    out.push(
      rows(
        r.designs.map((d) => {
          const pr = promptBits(r, d.prompt, "Copy the redesign prompt");
          return `${title(d.title)}${note(`Inspired by ${a(d.inspired_by, d.inspired_by.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, ""))}`, "margin:0 0 4px")}${d.why ? p(esc(d.why)) : ""}${links(pr.link ? [pr.link] : [])}${pr.block}`;
        }),
      ),
    );
  } else if (r.designsHidden && r.upgrade) {
    out.push(p(`${plural(r.designsHidden, "design", "designs")} picked for your company, each with a full redesign prompt, ${r.designsHidden === 1 ? "comes" : "come"} with ${esc(r.upgrade.plan)}.`, "margin-top:12px"));
  } else {
    out.push(p(`For designs picked for your company, run ${code("npx genclass suggest")} once: it reads what your site is about and finds the best sites in your field.`, "margin-top:12px"));
  }
  if (r.designs.length && r.designsHidden) out.push(lockedLine(r, `${plural(r.designsHidden, "more design", "more designs")} picked for your company, each with a redesign prompt, ${r.designsHidden === 1 ? "is" : "are"} in the other half.`));
  const name = r.apps[0]?.name ?? "my app";
  out.push(h3("Sites to learn from"));
  out.push(
    rows(
      r.showcase.map((s) => {
        const link = r.promptLinks[showcasePrompt(s, name)];
        return `<p style="margin:0;font-size:15px;line-height:22px">${a(s.site, s.name)}${s.three ? `<span class="gc-i3" style="color:${C.ink3};font-size:13px"> · 3D</span>` : ""}</p>${p(esc(s.take), "margin-top:2px")}${link ? links([a(link, `Prompt: redesign ${name} this way`)]) : ""}`;
      }),
    ),
  );
  return section("Website design", out.join(""));
}

/** Before GenClass knows the account's sites: how to get ideas for them now. */
function ideasSection(r: Report): string {
  if (!r.apps.length) return "";
  return section("Ideas before the data", p(`Run ${code("npx genclass suggest")} in ${r.apps.length === 1 ? "the app's" : "an app's"} folder: GenClass checks the repository and the live site, then suggests what to fix and website designs from sites in your field.`, "margin-top:8px"));
}

/** One quiet line for the sections that have nothing new. */
function quietLine(r: Report): string {
  const parts = [
    r.items.some((i) => i.section === "security") ? "" : "Security: nothing unusual on your account or apps.",
    !r.apps.length || setupItems(r).length || !measured(r).length ? "" : "Setup: every app is reporting.",
  ].filter(Boolean);
  return parts.length ? `<table ${TABLE}><tr><td style="height:36px;line-height:36px;font-size:0">&nbsp;</td></tr><tr><td class="gc-rule" style="border-top:1px solid ${C.rule};padding:14px 0 0">${note(esc(parts.join(" ")), "margin:0")}</td></tr></table>` : "";
}

function footer(r: Report): string {
  const s = r.links.settings;
  const often = s
    ? (["hourly", "daily", "weekly", "monthly"] as Every[])
        .map((e) => (e === r.every ? `<strong class="gc-i1" style="color:${C.ink};font-weight:600">${esc(EVERY_WORDS[e])}</strong>` : qa(`${s}&every=${e}`, EVERY_WORDS[e])))
        .join(" &nbsp;·&nbsp; ")
    : "";
  const alerts = r.every === "off" ? "" : r.kind === "alert" ? "You get alerts like this one when GenClass sees something critical. " : "You also get an alert as soon as GenClass sees something critical. ";
  const stop = s ? qa(`${s}&every=off`, "Stop these emails") : qa(r.links.account, "Change how often");
  const who = r.account.verified ? "" : " Not your account? Stop these emails and nothing else is sent.";
  return `<table ${TABLE}><tr><td style="height:40px;line-height:40px;font-size:0">&nbsp;</td></tr><tr><td class="gc-rule gc-i3" style="border-top:1px solid ${C.rule};padding:16px 0 0;font-size:12px;line-height:19px;color:${C.ink3}">
${often ? `<p style="margin:0 0 8px">How often: ${often}</p>` : ""}<p style="margin:0 0 8px">${alerts}${stop}</p>
<p style="margin:0">Sent to ${esc(r.account.email)} for your GenClass account.${who} Reply to reach a person.<br>GenClass · Daybot Solutions Inc. · ${qa(`${r.links.origin}/privacy`, "Privacy")}</p>
</td></tr></table>`;
}

/** The dark colours, for clients that read a <style> block: prefers-color-scheme, and Outlook.com's dark mode. */
const darkRules = (pre: string, bgPre: string): string =>
  [
    `${bgPre}body,${bgPre}.gc-bg{background:${D.bg}!important}`,
    `${pre}.gc-i1{color:${D.ink}!important}`,
    `${pre}.gc-i2{color:${D.ink2}!important}`,
    `${pre}.gc-i3{color:${D.ink3}!important}`,
    `${pre}.gc-a{color:${D.green}!important}`,
    `${pre}.gc-c0{color:${D.red}!important}`,
    `${pre}.gc-c1{color:${D.amber}!important}`,
    `${pre}.gc-c2{color:${D.grey}!important}`,
    `${pre}.gc-rule{border-color:${D.rule}!important}`,
    `${bgPre}.gc-p0{background:${D.red}!important}`,
    `${bgPre}.gc-p1{background:${D.amber}!important}`,
    `${bgPre}.gc-p2{background:${D.grey}!important}`,
    `${bgPre}.gc-btn{background:${D.green}!important}`,
    `${pre}.gc-btn-a{color:${D.onGreen}!important}`,
    `${bgPre}.gc-box{background:${D.greenBg}!important;border-color:${D.green}!important}`,
    `${bgPre}.gc-code{background:${D.code}!important;border-color:${D.rule}!important;color:${D.ink}!important}`,
  ].join("\n");
const DARK = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
${darkRules("", "")}
}
${darkRules("[data-ogsc] ", "[data-ogsb] ")}
</style>`;

/** The HTML body. Pure. */
export function htmlOf(r: Report): string {
  const l = leadOf(r);
  // the date (the subject says which report); the hour too when reports come hourly or this is an alert
  const when = `${r.kind === "alert" ? "Alert · " : r.kind === "test" ? "Test · " : ""}${day(r.generated)}${r.kind === "alert" || r.every === "hourly" ? `, ${clock(r.generated)}` : ""}`;
  const head = `<table ${TABLE}><tr>
<td style="vertical-align:middle;white-space:nowrap"><a class="gc-i1" href="${esc(r.links.origin)}" style="text-decoration:none;color:${C.ink};font-size:16px;line-height:24px;font-weight:700"><img src="https://genclass.dev/brand/mark-64.png?v=2" width="24" height="24" alt="" style="vertical-align:-6px;border:0;margin-right:8px">GenClass</a></td>
<td class="gc-i3" style="vertical-align:middle;text-align:right;font-size:13px;line-height:19px;color:${C.ink3}">${esc(when)}</td></tr></table>`;
  // a new account's first step is to connect its app: that section comes before the empty numbers
  const setupFirst = !measured(r).length || r.items.some((i) => i.section === "setup" && i.p === 0);
  // a single alert is all lead (its text, pages, prompt and dashboard); several get a row each below it, and so does
  // one whose prompt has no link (it is printed there)
  const details =
    r.kind === "alert"
      ? r.items.length > 1 || r.items.some((i) => i.prompt && !r.promptLinks[i.prompt])
        ? section(r.items.length > 1 ? "What GenClass saw" : "The fix prompt", itemRows(r, r.items, true))
        : ""
      : [
          halfBox(r),
          needsSection(r),
          setupFirst ? setupSection(r) : "",
          appsSection(r),
          prsSection(r),
          visitorsSection(r),
          securitySection(r),
          setupFirst ? "" : setupSection(r),
          laterSection(r),
          knowsSites(r) ? suggestionsSection(r) : "",
          knowsSites(r) ? designSection(r) : ideasSection(r),
          quietLine(r),
        ].join("");
  // the inbox's preview line: the summary, not the header's words
  const preview = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};opacity:0">${esc(l.text.slice(0, 180))}${"&#8204;&nbsp;".repeat(40)}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subjectOf(r))}</title>${DARK}</head>
<body class="gc-bg" style="margin:0;padding:0;background:${C.bg};font-family:${FONT}">${preview}
<table ${TABLE} class="gc-bg" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" style="padding:28px 20px 40px">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table ${TABLE} style="max-width:600px"><tr><td style="font-family:${FONT};text-align:left">
${head}<table ${TABLE}><tr><td style="padding:32px 0 0">${leadHtml(r, l)}</td></tr></table>${details}${footer(r)}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}

// --------------------------------------------------------------------------------------------- plain text

function textItem(i: Item): string[] {
  const out = [`[${P_LABEL[i.p]}] ${i.app}: ${i.title}`, `  ${i.detail}`];
  if (i.pages.length) out.push(`  Pages: ${i.pages.join(", ")}`);
  if (i.prompt) out.push("  Prompt for your coding agent:", ...i.prompt.match(/.{1,96}(\s|$)/g)!.map((l) => `    ${l.trim()}`));
  if (i.link) out.push(`  ${i.link.label}: ${i.link.href}`);
  return [...out, ""];
}

/** The plain-text body: the same lead first, then every section with its prompts in full. Pure. */
export function textOf(r: Report): string {
  const adj = ADJ[r.every] || "daily";
  const l = leadOf(r);
  const cl = r.kind === "alert" || !measured(r).length ? "" : countLine(counts(counted(r)));
  const out: string[] = [`${r.kind === "alert" ? "GenClass alert" : `GenClass ${adj} report${r.kind === "test" ? " (test)" : ""}`} · ${day(r.generated)}, ${clock(r.generated)}`, "", l.headline, ""];
  if (l.text) out.push(l.text, "");
  if (cl) out.push(cl, "");
  l.steps.forEach((x, k) => out.push(`${k + 1}. ${x.title}${x.why ? `. ${x.why}` : ""}`, ...(x.prompt ? [`   Prompt: ${x.prompt}`] : []), ""));
  if (l.model && r.actionsHidden) out.push(`${plural(r.actionsHidden, "next step", "next steps")} with prompts: in the other half, with ${r.upgrade?.plan ?? "Pro"}.`, "");
  // a prompt's link is long and its text is printed in full below
  if (l.button && !l.button.prompt) out.push(`${l.button.label}: ${l.button.href}`, "");
  if (r.upgrade && r.apps.length && r.kind !== "alert") {
    const lo = leftOut(r);
    out.push(`You're seeing half of this report on Free.${lo.length ? ` ${r.upgrade.plan} shows the other half: ${lo.join(", ")}.` : ""} ${r.upgrade.price}${r.upgrade.trialDays ? `, ${r.upgrade.trialDays} days free to start` : ""}: ${r.upgrade.url}`, "");
  }
  out.push("----", "");
  const now = problemItems(r).filter((i) => i.p <= 1);
  if (now.length) out.push("FIX THESE FIRST", "", ...now.flatMap(textItem));
  for (const x of r.problemsHidden) out.push(`Locked: ${plural(x.counts[0] + x.counts[1] + x.counts[2], "more problem", "more problems")} on ${x.app} (${byP(x.counts)}): in the other half, with ${r.upgrade?.plan ?? "Pro"}.`, "");
  const setup = setupItems(r);
  if (r.kind !== "alert") {
    if (r.apps.length) {
      out.push("YOUR APPS");
      for (const x of r.apps) {
        const t = x.totals;
        if (x.demo) { out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): sample data until real visits arrive. ${x.dashboard}`); continue; }
        if (!x.lastEvent) { out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): not connected yet. ${x.dashboard}`); continue; }
        out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): ${fmt(t.loads)} page loads, ${fmt(t.problems)} problems, ${fmt(t.checks)} checks, ${fmt(t.fixed)} fixed live. ${x.dashboard}`);
      }
      out.push("");
    }
    const prs = r.apps.flatMap((x) => x.prs);
    if (prs.length) out.push("CODE CHANGES GENCLASS REVIEWED", ...prs.map((pr) => `- ${pr.repo}#${pr.number}: ${pr.flagged ? `${pr.flagged} races flagged` : "nothing flagged"} ${pr.url}`), "");
    const sec = r.items.filter((i) => i.section === "security");
    out.push("SECURITY", ...(sec.length ? sec.flatMap(textItem) : ["Nothing unusual.", ""]));
  }
  if (setup.length) out.push("SETUP", "", ...setup.flatMap(textItem));
  if (r.kind !== "alert") {
    const p2 = problemItems(r).filter((i) => i.p === 2);
    if (p2.length) out.push("WORTH A LOOK", "", ...p2.flatMap(textItem));
    if (r.suggestions.length) out.push("SUGGESTIONS", ...r.suggestions.flatMap((s) => [`- ${s.title}${s.why ? `: ${s.why}` : ""}`, ...(s.prompt ? [`  Prompt: ${s.prompt}`] : [])]), "");
    if (knowsSites(r)) {
      out.push("WEBSITE DESIGN");
      for (const d of r.designs) out.push(`- ${d.title} (inspired by ${d.inspired_by})`, `  Prompt: ${d.prompt}`);
      for (const s of r.showcase) out.push(`- ${s.name} ${s.site}${s.three ? " (3D)" : ""}: ${s.take}`);
      out.push("");
    } else if (r.apps.length) {
      out.push("IDEAS BEFORE THE DATA", "Run npx genclass suggest in the app's folder: it suggests what to fix and website designs from sites in your field.", "");
    }
  }
  out.push("--", `Sent to ${r.account.email} for your GenClass account.`, r.links.settings ? `Change how often, or stop these emails: ${r.links.settings}` : `Change how often: ${r.links.account}`, "Reply to reach a person at GenClass.");
  return out.join("\n");
}

/** Subject, HTML and text. Pure. */
export function renderReport(r: Report): { subject: string; html: string; text: string } {
  return { subject: subjectOf(r), html: htmlOf(r), text: textOf(r) };
}
