// The GenClass report as an email (src/report.ts builds it): a subject, an HTML body and a plain-text body.
//
// Invariants:
// - Pure: the same report gives the same email. Everything from outside (app and page names, the model's words,
//   design sites, pull request names) goes through esc() and is a line of text; links are https and built in
//   src/report.ts or here from the report's own origin.
// - Email-safe HTML: tables, inline styles, no script, no external CSS, one image (the logo, from genclass.dev). A
//   <style> block only adds the dark-mode colours for clients that read it; every client gets the light ones inline.
// - Short to read: a prompt is a button to its signed page (/account/report/prompt), never a block of text, and the
//   same setup step on several apps is one row. Only without a signed link (no INTEGRATIONS_KEY, or past the 60
//   links a report signs) is a prompt printed, and then only a short one; the plain-text body always has them all.
// - The sections and their order: the headline, the summary, what needs doing (critical, then important), setup when
//   an app is not connected, the apps' numbers, code changes, visitors, security, setup otherwise, worth a look,
//   suggestions, website design, then how to change or stop these emails. Every section is about the account's own
//   sites: while GenClass has measured none of them and has no genclass suggest answer, the headline names the apps
//   that send nothing yet, and one card says what the next reports hold for them in place of generic ideas.
// - An app on Free is counted, not listed: its problems' count shows with Pro's box, never its pages or prompts.

import { esc } from "./escape.js";
import { DESIGN_CHECKS, EVERY_WORDS, PRIORITY_WORDS, showcasePrompt, type AppReport, type Every, type Item, type Priority, type Report } from "./report.js";

const C = {
  bg: "#f3f4f3",
  card: "#ffffff",
  ink: "#17191a",
  ink2: "#4b504d",
  ink3: "#7d827f",
  rule: "#e7e9e7",
  soft: "#f6f7f6",
  green: "#0a7c4a",
  greenBg: "#e9f6ef",
  red: "#c4320a",
  redBg: "#fdeeea",
  amber: "#a05c00",
  amberBg: "#fdf3dc",
  grey: "#6b706d",
  greyBg: "#eff0ef",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Source Code Pro',monospace";
const P_COLOURS: Record<Priority, [string, string]> = { 0: [C.red, C.redBg], 1: [C.amber, C.amberBg], 2: [C.grey, C.greyBg] };
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
/** One quiet line that says something is Pro's, with the upgrade link. */
function lockedLine(r: Report, text: string): string {
  const u = r.upgrade;
  return `<p style="margin:12px 0 0;padding:10px 12px;border:1px dashed ${C.rule};border-radius:8px;font-size:13px;line-height:20px;color:${C.ink2}">🔒&nbsp; ${text}${u ? ` &nbsp;${a(u.url, `Unlock with ${u.plan} →`)}` : ""}</p>`;
}

/** The headline at the top of the report: what matters most, in a few words. */
function headlineOf(r: Report): { text: string; tone: Priority | null } {
  const c = counts(counted(r));
  if (r.kind === "alert") return { text: r.items.length === 1 ? "Something critical needs you" : `${fmt(r.items.length)} critical problems need you`, tone: 0 };
  if (c[0]) return { text: `${plural(c[0], "critical problem", "critical problems")}${c[1] ? ` and ${plural(c[1], "important one", "important ones")}` : ""}`, tone: 0 };
  if (!r.apps.length) return { text: "Add your first app to GenClass", tone: 1 };
  if (!measured(r).length) return { text: notSending(r), tone: 1 };
  if (c[1]) return { text: `${plural(c[1], "important thing", "important things")} to look at`, tone: 1 };
  return { text: "All clear on your apps", tone: null };
}

// --------------------------------------------------------------------------------------------- html pieces

const a = (href: string, text: string, style = ""): string => `<a href="${esc(href)}" style="color:${C.green};text-decoration:none;font-weight:600;${style}">${esc(text)}</a>`;
const pill = (text: string, fg: string, bg: string): string =>
  `<span style="display:inline-block;padding:1px 8px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:700;line-height:18px;white-space:nowrap">${esc(text)}</span>`;
const p = (html: string, style = ""): string => `<p style="margin:0 0 8px;font-size:14px;line-height:21px;color:${C.ink2};${style}">${html}</p>`;
const note = (html: string, style = ""): string => `<p style="margin:12px 0 0;font-size:12px;line-height:18px;color:${C.ink3};${style}">${html}</p>`;
const code = (t: string): string => `<code style="font-family:${MONO};font-size:13px;background:${C.soft};padding:1px 5px;border-radius:4px">${esc(t)}</code>`;
/** The filled button (one per row at most). */
const button = (href: string, text: string): string =>
  `<a class="gc-btn" href="${esc(href)}" style="display:inline-block;padding:7px 14px;margin:10px 8px 0 0;background:${C.green};color:#ffffff;border-radius:6px;font-size:13px;line-height:18px;font-weight:600;text-decoration:none">${esc(text)}</a>`;
/** The quiet button beside it. */
const ghost = (href: string, text: string): string =>
  `<a class="gc-ghost" href="${esc(href)}" style="display:inline-block;padding:6px 13px;margin:10px 8px 0 0;border:1px solid ${C.rule};color:${C.ink};border-radius:6px;font-size:13px;line-height:18px;font-weight:600;text-decoration:none">${esc(text)}</a>`;

/** A white card on the grey page, with an optional title row (title left, a quiet note right). */
function card(body: string, title = "", meta = "", style = ""): string {
  const head = title
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px"><tr><td style="vertical-align:baseline"><h2 style="margin:0;font-size:16px;line-height:24px;font-weight:650;color:${C.ink}">${esc(title)}</h2></td>${meta ? `<td style="vertical-align:baseline;text-align:right;font-size:12px;line-height:18px;color:${C.ink3};white-space:nowrap">${esc(meta)}</td>` : ""}</tr></table>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="gc-card" style="margin:12px 0 0;background:${C.card};border:1px solid ${C.rule};border-radius:12px;${style}"><tr><td style="padding:20px 22px">${head}${body}</td></tr></table>`;
}

/** Rows inside a card, a hairline between them. */
function rows(parts: string[]): string {
  return parts.map((h, k) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="gc-row" style="${k ? `border-top:1px solid ${C.rule};` : ""}"><tr><td style="padding:${k ? 14 : 10}px 0 ${k === parts.length - 1 ? 0 : 14}px">${h}</td></tr></table>`).join("");
}

/** A prompt as a button to its signed page, or (no link) a short one printed, or a word that the text part has it. */
function promptAction(r: Report, prompt: string, label: string, quiet = false): string {
  const link = r.promptLinks[prompt];
  if (link) return quiet ? ghost(link, label) : button(link, label);
  if (prompt.length > INLINE_PROMPT_MAX) return note("The full prompt is in the plain-text part of this email.");
  return `<div class="gc-pr" style="margin:10px 0 0;padding:10px 12px;background:${C.soft};border:1px solid ${C.rule};border-radius:6px;font-family:${MONO};font-size:12px;line-height:18px;color:${C.ink};white-space:pre-wrap;word-break:break-word">${esc(prompt)}</div>${note("Paste it into Claude Code, Codex or Cursor.", "margin-top:6px")}`;
}

/** The small line above an item's title: its priority, and where it is. */
const label = (pr: Priority, where: string): string => {
  const [fg] = P_COLOURS[pr];
  return `<p style="margin:0 0 3px;font-size:11px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;font-weight:700"><span style="color:${fg}">${esc(PRIORITY_WORDS[pr])}</span><span style="color:${C.ink3}"> &nbsp;·&nbsp; ${esc(where)}</span></p>`;
};
const title = (t: string): string => `<p style="margin:0 0 4px;font-size:15px;line-height:22px;font-weight:600;color:${C.ink}">${esc(t)}</p>`;
const detail = (t: string): string => `<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(t)}</p>`;

function itemRow(r: Report, i: Item, actions: boolean): string {
  const pages = i.pages.length ? `<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;line-height:18px;color:${C.ink2}">${i.pages.map(esc).join(" &nbsp;·&nbsp; ")}</p>` : "";
  const btns = actions ? `${i.prompt ? promptAction(r, i.prompt, i.section === "setup" ? "Copy the setup prompt" : "Copy the fix prompt") : ""}${i.link ? ((i.prompt && r.promptLinks[i.prompt]) || i.section === "security" ? ghost(i.link.href, i.link.label) : button(i.link.href, i.link.label)) : ""}` : i.link ? `<p style="margin:6px 0 0;font-size:13px;line-height:20px">${a(i.link.href, `${i.link.label} →`)}</p>` : "";
  return `${label(i.p, i.app)}${title(i.title)}${detail(i.detail)}${pages}${btns}`;
}

/** The same step on several apps (one rule, one title): one row naming them, a link per app. */
function groupRow(r: Report, g: Item[]): string {
  const first = g[0]!;
  const names = g.map((i) => i.app);
  const per = g
    .map((i) => {
      const href = (i.prompt && r.promptLinks[i.prompt]) || i.link?.href;
      return href ? a(href, i.app) : esc(i.app);
    })
    .join(" &nbsp;·&nbsp; ");
  const linked = g.every((i) => i.prompt && r.promptLinks[i.prompt]);
  const what = linked ? "Copy the setup prompt for" : first.link ? `${first.link.label}:` : "";
  const missing = !linked && g.some((i) => i.prompt) ? note("The prompts are in the plain-text part of this email.", "margin-top:6px") : "";
  return `${label(first.p, plural(g.length, "app", "apps"))}${title(first.title)}${detail(`On ${andList(names)}. ${first.detail}`)}<p style="margin:10px 0 0;font-size:13px;line-height:20px;color:${C.ink2}">${esc(what)} ${per}</p>${missing}`;
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

function hero(r: Report): string {
  const adj = ADJ[r.every] || "daily";
  const h = headlineOf(r);
  const c = counts(counted(r));
  const kicker = r.kind === "alert" ? "Alert" : `${r.kind === "test" ? "Test · " : ""}${adj} report`;
  const dot = h.tone === null ? C.green : P_COLOURS[h.tone][0];
  const period = r.apps[0]?.period ?? "the last 24 hours";
  const legend = ([0, 1, 2] as Priority[])
    .map((k) => {
      const [fg, bg] = P_COLOURS[k];
      return `<td style="padding:0 6px 0 0"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${c[k] ? bg : C.soft};color:${c[k] ? fg : C.ink3};font-size:12px;line-height:18px;font-weight:600;white-space:nowrap">${fmt(c[k])} ${esc(PRIORITY_WORDS[k].toLowerCase())}</span></td>`;
    })
    .join("");
  const m = measured(r);
  const tot = (f: (x: AppReport) => number) => m.reduce((s, x) => s + f(x), 0);
  // visits only when some were counted: an app whose pages do not send analytics would read "0 visits" beside its loads
  const visits = m.some((x) => x.visitors) && tot((x) => x.visitors?.visits ?? 0) > 0 ? tot((x) => x.visitors?.visits ?? 0) : null;
  const tiles = m.length && r.kind !== "alert"
    ? [
        ["Page loads", tot((x) => x.totals.loads), tot((x) => x.totals.prevLoads)],
        ["Problems", tot((x) => x.totals.problems), tot((x) => x.totals.prevProblems)],
        ["Checks", tot((x) => x.totals.checks), tot((x) => x.totals.prevChecks)],
        ...(visits !== null ? [["Visits", visits, null] as const] : []),
      ]
    : [];
  const tileRow = tiles.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;border-top:1px solid ${C.rule}"><tr>${tiles
        .map(([name, now, before]) => `<td style="padding:14px 8px 0 0;vertical-align:top;width:${Math.floor(100 / tiles.length)}%"><p style="margin:0;font-size:12px;line-height:16px;color:${C.ink3}">${esc(String(name))}</p><p style="margin:2px 0 0;font-size:22px;line-height:28px;font-weight:650;color:${C.ink}">${fmt(Number(now))}</p>${before !== null && delta(Number(now), Number(before)) ? `<p style="margin:0;font-size:12px;line-height:16px;color:${C.ink3}">${esc(delta(Number(now), Number(before)))}</p>` : ""}</td>`)
        .join("")}</tr></table>`
    : "";
  return card(`<p style="margin:0 0 6px;font-size:11px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${C.ink3}">${esc(kicker)}</p>
<h1 style="margin:0;font-size:24px;line-height:31px;font-weight:700;color:${C.ink}"><span style="color:${dot}">●</span>&nbsp;${esc(h.text)}</h1>
<p style="margin:6px 0 0;font-size:14px;line-height:21px;color:${C.ink3}">${r.apps.length ? `${esc(plural(r.apps.length, "app", "apps"))} · ${esc(period)}` : "Your GenClass account"}</p>
${r.kind === "alert" ? "" : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0"><tr>${legend}</tr></table>`}${tileRow}`);
}

/** For an account with a Free app: this report is half, what the other half holds, and the trial. */
function halfCard(r: Report): string {
  const u = r.upgrade;
  if (!u || !r.apps.length) return "";
  const out = leftOut(r);
  const list = out.length ? `<p style="margin:6px 0 0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(u.plan)} shows the other half: ${esc(out.join(", "))}.</p>` : `<p style="margin:6px 0 0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(u.plan)} shows everything: every problem with its pages and fix prompts, the summary's next steps, every suggestion and design, and your visitors.</p>`;
  return card(
    `<p style="margin:0;font-size:15px;line-height:22px;font-weight:650;color:${C.ink}">You're seeing half of this report on Free</p>${list}${button(u.url, u.trialDays ? `Start the ${u.trialDays}-day free trial` : `Upgrade to ${u.plan}`)}<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${C.ink3}">${esc(u.price)}${u.trialDays ? `, ${u.trialDays} days free to start` : ""}. Cancel any time.</p>`,
    "",
    "",
    `border:1px solid ${C.green};background:${C.greenBg}`,
  );
}

function summaryCard(r: Report): string {
  const s = r.summary;
  if (!s) return "";
  const acts = s.actions.length
    ? rows(
        s.actions.map(
          (x, k) =>
            `<p style="margin:0 0 3px;font-size:15px;line-height:22px;font-weight:600;color:${C.ink}"><span style="color:${C.green}">${k + 1}.</span>&nbsp; ${esc(x.title)}</p>${x.why ? detail(x.why) : ""}${x.prompt ? promptAction(r, x.prompt, "Copy the prompt") : ""}`,
        ),
      )
    : "";
  return card(
    `<p style="margin:0 0 6px;font-size:11px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${C.green}">GenClass summary</p>
<p style="margin:0 0 6px;font-size:17px;line-height:25px;font-weight:650;color:${C.ink}">${esc(s.headline)}</p>
<p style="margin:0 0 ${acts ? 8 : 0}px;font-size:14px;line-height:21px;color:${C.ink2}">${esc(s.text)}</p>${acts}${r.actionsHidden ? lockedLine(r, `${plural(r.actionsHidden, "next step", "next steps")}, each with a prompt for your coding agent, ${r.actionsHidden === 1 ? "is" : "are"} in the other half.`) : ""}${note("Written by a model from the numbers below; the priorities are GenClass's own rules.")}`,
    "",
    "",
    `border-left:4px solid ${C.green}`,
  );
}

function needsCard(r: Report): string {
  const now = problemItems(r).filter((i) => i.p <= 1);
  const sec = r.items.filter((i) => i.section === "security" && i.p <= 1).length;
  // Free's half: the problems it leaves out, counted per app, never named
  const locked = r.problemsHidden.map((x) => lockedLine(r, `${plural(x.counts[0] + x.counts[1] + x.counts[2], "more problem", "more problems")} on <strong style="color:${C.ink}">${esc(x.app)}</strong> (${esc(byP(x.counts))}), with ${x.counts[0] + x.counts[1] + x.counts[2] === 1 ? "its" : "their"} pages and fix prompts.`)).join("");
  if (now.length) return card(itemRows(r, now, true) + locked, now.some((i) => i.p === 0) ? "Fix these first" : "Worth fixing", plural(now.length, "item", "items"));
  if (locked) return card(p("The problems in the free half of this report are below.", "margin:8px 0 0") + locked, "Problems");
  if (!measured(r).length) return "";
  return card(p(`Nothing critical or important on your apps.${sec ? ` ${plural(sec, "item needs", "items need")} a look under Security.` : ""}`, "margin:0"), "Needs you");
}


function appsCard(r: Report): string {
  if (!r.apps.length) return "";
  const hourly = r.every === "hourly";
  const fixed = r.apps.some((x) => !x.demo && x.totals.fixed > 0);
  const th = (t: string, right = true) => `<th style="padding:0 0 8px 8px;font-size:12px;line-height:16px;font-weight:600;color:${C.ink3};text-align:${right ? "right" : "left"};border-bottom:1px solid ${C.rule};white-space:nowrap">${esc(t)}</th>`;
  const td = (h: string, right = true) => `<td style="padding:10px 0 10px 8px;font-size:14px;line-height:20px;color:${C.ink};text-align:${right ? "right" : "left"};border-bottom:1px solid ${C.rule};vertical-align:top">${h}</td>`;
  const sub = (t: string) => (t ? `<br><span style="font-size:11px;line-height:16px;color:${C.ink3}">${esc(t)}</span>` : "");
  const list = r.apps
    .map((x) => {
      const t = x.totals;
      const status = !x.lastEvent ? "not connected" : x.demo ? "sample data" : `last data ${day(x.lastEvent)}`;
      const name = `<td style="padding:10px 0;font-size:14px;line-height:20px;text-align:left;border-bottom:1px solid ${C.rule};vertical-align:top">${a(x.dashboard, x.name, "color:" + C.ink)}${sub(`${x.pro ? "Pro" : "Free"} · ${status}`)}</td>`;
      // the recorded demo's estimate is not this app's numbers: none are printed as if measured
      const dash = `<span style="color:${C.ink3}">–</span>`;
      if (x.demo || !x.lastEvent) return `<tr>${name}${td(dash)}${td(dash)}${td(dash)}${fixed ? td(dash) : ""}${hourly ? td(dash) : ""}</tr>`;
      return `<tr>${name}${td(`${fmt(t.loads)}${sub(delta(t.loads, t.prevLoads))}`)}${td(`${fmt(t.problems)}${sub(delta(t.problems, t.prevProblems))}`)}${td(`${fmt(t.checks)}${sub(delta(t.checks, t.prevChecks))}`)}${fixed ? td(fmt(t.fixed)) : ""}${hourly ? td(x.lastHour ? `${fmt(x.lastHour.problems + x.lastHour.checks)}${sub(`${fmt(x.lastHour.loads)} loads`)}` : dash) : ""}</tr>`;
    })
    .join("");
  const kinds = r.apps.map(kindsLine).filter(Boolean);
  const demo = r.apps.filter((x) => x.demo);
  if (!measured(r).length) {
    // nothing measured yet: a column of dashes says less than the apps' state
    const state = (x: AppReport) => (x.demo ? "sample data until real visits arrive" : x.lastEvent ? `last data ${day(x.lastEvent)}` : "not connected yet");
    return card(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 0">${r.apps
        .map((x, k) => `<tr><td style="padding:9px 0;font-size:14px;line-height:20px;${k ? `border-top:1px solid ${C.rule};` : ""}">${a(x.dashboard, x.name, `color:${C.ink}`)}</td><td style="padding:9px 0 9px 12px;font-size:13px;line-height:20px;color:${C.ink3};text-align:right;${k ? `border-top:1px solid ${C.rule};` : ""}">${x.pro ? "Pro" : "Free"} · ${esc(state(x))}</td></tr>`)
        .join("")}</table>${note("Numbers show here once a page loads with GenClass.")}`,
      "Your apps",
    );
  }
  return card(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 0"><tr><th style="padding:0 0 8px;font-size:12px;line-height:16px;font-weight:600;color:${C.ink3};text-align:left;border-bottom:1px solid ${C.rule}">App</th>${th("Loads")}${th("Problems")}${th("Checks")}${fixed ? th("Fixed") : ""}${hourly ? th("Last hour") : ""}</tr>${list}</table>${kinds.map((l) => p(l, "margin:12px 0 0;font-size:13px;line-height:20px")).join("")}${note(
      `Problems: found by GenClass's model on the live site. Checks: measured against fixed thresholds. Changes are against the ${esc((r.apps[0]?.period ?? "period").replace(/^the (last )?/, ""))} before.${demo.length ? ` ${esc(andList(demo.map((x) => x.name)))} ${demo.length === 1 ? "shows" : "show"} sample data until real visits arrive, so nothing is listed from ${demo.length === 1 ? "it" : "them"}.` : ""}`,
    )}`,
    "Your apps",
  );
}

function kindsLine(x: AppReport): string {
  if (x.demo || !x.pro) return "";
  const parts = [...x.kinds, ...x.checks].map((k) => `${esc(k.name)} <span style="color:${C.ink3}">${fmt(k.count)}</span>`);
  return parts.length ? `<strong style="color:${C.ink}">${esc(x.name)}</strong> &nbsp;${parts.join(" &nbsp;·&nbsp; ")}` : "";
}

function prsCard(r: Report): string {
  const list = r.apps.flatMap((x) => x.prs.map((pr) => ({ x, pr })));
  if (!list.length) return "";
  return card(
    rows(
      list.map(
        ({ x, pr }) =>
          `<p style="margin:0;font-size:14px;line-height:21px">${a(pr.url, `${pr.repo}#${pr.number}`)} &nbsp;${pr.flagged ? pill(`${plural(pr.flagged, "race flagged", "races flagged")}${pr.fresh ? `, ${fmt(pr.fresh)} new` : ""}`, C.red, C.redBg) : pill("nothing flagged", C.green, C.greenBg)}${pr.closed ? ` ${pill("closed", C.grey, C.greyBg)}` : ""}</p><p style="margin:2px 0 0;font-size:12px;line-height:18px;color:${C.ink3}">${esc(x.name)} · reviewed ${day(pr.updated)}</p>`,
      ),
    ) + note("From the GitHub App's reviews of your linked repositories' test runs."),
    "Code changes GenClass reviewed",
  );
}

function visitorsCard(r: Report): string {
  const withV = r.apps.filter((x) => x.visitors && x.visitors.visits + x.visitors.views > 0);
  if (!withV.length) return r.apps.every((x) => !x.pro) && r.upgrade ? card(p(`Visits, the pages people read, where they came from and the clicks that did nothing come with ${esc(r.upgrade.plan)}.`, "margin:0"), "Visitors") : "";
  return card(
    rows(
      withV.map((x) => {
        const v = x.visitors!;
        const list = (l: { key: string; count: number }[]) => l.map((y) => `${esc(y.key)} <span style="color:${C.ink3}">${fmt(y.count)}</span>`).join(" &nbsp;·&nbsp; ");
        const facts = [plural(v.visits, "visit", "visits"), plural(v.views, "page view", "page views"), v.seconds !== null ? `${fmt(v.seconds)} s a page` : "", v.rage ? plural(v.rage, "rage click", "rage clicks") : "", v.dead ? plural(v.dead, "dead click", "dead clicks") : ""].filter(Boolean);
        const line = (k: string, l: { key: string; count: number }[]) => (l.length ? `<p style="margin:4px 0 0;font-size:13px;line-height:20px;color:${C.ink2}"><span style="color:${C.ink3}">${k}</span> &nbsp;${list(l)}</p>` : "");
        return `${withV.length > 1 || r.apps.length > 1 ? title(x.name) : ""}<p style="margin:0 0 4px;font-size:14px;line-height:21px;color:${C.ink}">${esc(facts.join(" · "))}</p>${line("Top pages", v.pages)}${line("From", v.sources)}${line("Countries", v.countries)}${line("Devices", v.devices)}${x.visitorsLimited ? lockedLine(r, "The pages they read, where they came from, their countries and devices are in the other half.") : ""}`;
      }),
    ),
    "Visitors",
  );
}

function securityCard(r: Report): string {
  const items = r.items.filter((i) => i.section === "security");
  const body = items.length ? itemRows(r, items, true) : p("Nothing unusual: no new terminals or passkeys on your account, and no request storms or traffic jumps on your apps.", "margin:8px 0 0");
  return card(`${body}${note("GenClass never stores a visitor's IP address: this reads patterns in the counts and your own account's sign-ins.")}`, "Security", items.length ? plural(items.length, "item", "items") : "");
}

function setupCard(r: Report): string {
  const items = r.items.filter((i) => i.section === "setup");
  if (!items.length) return card(p("Everything is connected: every app is reporting and GenClass's model loads.", "margin:8px 0 0"), "Setup");
  return card(itemRows(r, items, true), "Finish setting up", plural(items.length, "step", "steps"));
}

function laterCard(r: Report): string {
  const p2 = problemItems(r).filter((i) => i.p === 2);
  return p2.length ? card(itemRows(r, p2, false), "Worth a look", plural(p2.length, "item", "items")) : "";
}

function suggestionsCard(r: Report): string {
  if (!r.suggestions.length && !r.suggestionsHidden) {
    return card(p(`Run ${code("npx genclass suggest")} in your app's folder once. GenClass checks the repository and the live site, and every report after this one starts with what to do first, a prompt for each.`, "margin:8px 0 0"), "Suggestions for your app");
  }
  const list = rows(
    r.suggestions.map(
      (s, k) => `<p style="margin:0 0 3px;font-size:15px;line-height:22px;font-weight:600;color:${C.ink}"><span style="color:${C.green}">${k + 1}.</span>&nbsp; ${esc(s.title)}</p>${s.why ? detail(s.why) : ""}${s.prompt ? promptAction(r, s.prompt, "Copy the prompt", true) : ""}`,
    ),
  );
  const more = r.suggestionsHidden && r.upgrade ? lockedLine(r, `${plural(r.suggestionsHidden, "more suggestion", "more suggestions")}, each with a prompt, ${r.suggestionsHidden === 1 ? "is" : "are"} in the other half.`) : "";
  return card(`${list}${more}${note("From your last genclass suggest: measured checks ordered by a model, and the model's own ideas (not measured).")}`, "Suggestions for your app", plural(r.suggestions.length, "idea", "ideas"));
}

function designCard(r: Report): string {
  const out: string[] = [];
  const design = r.apps.flatMap((x) => (x.pro ? x.checks.filter((c) => DESIGN_CHECKS.has(c.kind)).map((c) => ({ x, c })) : []));
  if (design.length) {
    out.push(p(`Measured on your visitors' screens: ${design.map(({ x, c }) => `${esc(c.name)} ${fmt(c.count)}${r.apps.length > 1 ? ` (${esc(x.name)})` : ""}`).join(" · ")}.${design.some(({ c }) => c.kind === "text-invisible") ? " Invisible text means a contrast under 1.5:1; aim for 4.5:1 for body text." : ""}`, "margin:8px 0 0"));
  } else if (r.apps.some((x) => x.pro && !x.demo && x.totals.loads > 0)) {
    out.push(p("No contrast, layout or font problems measured on your visitors' screens.", "margin:8px 0 0"));
  }
  if (r.designs.length) {
    out.push(`<p style="margin:16px 0 0;font-size:11px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${C.ink3}">Picked for your company</p>`);
    out.push(
      rows(
        r.designs.map(
          (d) =>
            `${title(d.title)}<p style="margin:0 0 4px;font-size:13px;line-height:20px;color:${C.ink3}">Inspired by ${a(d.inspired_by, d.inspired_by.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, ""))}</p>${d.why ? detail(d.why) : ""}${promptAction(r, d.prompt, "Copy the redesign prompt", true)}`,
        ),
      ),
    );
  } else if (r.designsHidden && r.upgrade) {
    out.push(p(`${plural(r.designsHidden, "design", "designs")} picked for your company, each with a full redesign prompt, ${r.designsHidden === 1 ? "comes" : "come"} with ${esc(r.upgrade.plan)}.`, "margin:12px 0 0"));
  } else if (!r.designs.length) {
    out.push(p(`For designs picked for your company, run ${code("npx genclass suggest")} once: it reads what your site is about and finds the best sites in your field.`, "margin:12px 0 0"));
  }
  if (r.designs.length && r.designsHidden) out.push(lockedLine(r, `${plural(r.designsHidden, "more design", "more designs")} picked for your company, each with a redesign prompt, ${r.designsHidden === 1 ? "is" : "are"} in the other half.`));
  const name = r.apps[0]?.name ?? "my app";
  out.push(`<p style="margin:20px 0 0;font-size:11px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${C.ink3}">Sites to learn from today</p>`);
  out.push(
    rows(
      r.showcase.map((s) => {
        const link = r.promptLinks[showcasePrompt(s, name)];
        return `<p style="margin:0 0 2px;font-size:15px;line-height:22px">${a(s.site, s.name, `color:${C.ink}`)} <span style="color:${C.ink3};font-size:13px">↗</span>${s.three ? ` &nbsp;${pill("3D", C.green, C.greenBg)}` : ""}</p>${detail(s.take)}${link ? `<p style="margin:6px 0 0;font-size:13px;line-height:20px">${a(link, `Prompt: redesign ${name} this way →`)}</p>` : ""}`;
      }),
    ),
  );
  return card(out.join(""), "Upgrade your website design");
}

/**
 * In place of the suggestions and the design ideas when GenClass knows nothing about the account's sites yet (no
 * measured app, no genclass suggest answer): what the next reports hold for them, by name, and how to get ideas now.
 */
function nextCard(r: Report): string {
  if (!r.apps.length) return "";
  const name = appsName(r);
  return card(
    `${p(`Once ${esc(name)} ${r.apps.length === 1 ? "sends its" : "send their"} first page load, this report lists what breaks there with the pages it happens on, ${r.apps.some((x) => x.analytics) ? "who visits and what they click, " : ""}and contrast and layout problems measured on your visitors' screens.`, "margin:8px 0 0")}${p(`For ideas picked for ${esc(name)} today, run ${code("npx genclass suggest")} in ${r.apps.length === 1 ? "its" : "an app's"} folder: GenClass checks the repository and the live site, then suggests what to fix and website designs from sites in your field.`, "margin:8px 0 0")}`,
    "What this report will show",
  );
}

function upgradeCard(r: Report): string {
  const u = r.upgrade;
  if (!u) return "";
  if (!r.apps.length) return "";
  const out = leftOut(r);
  return card(
    `<p style="margin:0 0 6px;font-size:17px;line-height:25px;font-weight:650;color:${C.ink}">Upgrade to see the whole report</p>
<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink2}">${out.length ? `The other half: ${esc(out.join(", "))}. ` : ""}${esc(u.plan)} also watches every app every day with every problem's pages and fix prompts. ${esc(u.price)}${u.trialDays ? `, ${u.trialDays} days free to start` : ""}.</p>
${button(u.url, u.trialDays ? `Start the ${u.trialDays}-day free trial` : `Get ${u.plan}`)}`,
    "",
    "",
    `border:1px solid ${C.green}`,
  );
}

function footer(r: Report): string {
  const s = r.links.settings;
  const choose = (e: Every) =>
    e === r.every
      ? `<span style="display:inline-block;padding:3px 10px;margin:4px 2px 0;border-radius:999px;background:${C.ink};color:#ffffff;font-weight:600">${esc(EVERY_WORDS[e])}</span>`
      : s
        ? `<a href="${esc(`${s}&every=${e}`)}" style="display:inline-block;padding:3px 10px;margin:4px 2px 0;border-radius:999px;border:1px solid ${C.rule};color:${C.ink2};text-decoration:none">${esc(EVERY_WORDS[e])}</a>`
        : "";
  const pills = s ? (["hourly", "daily", "weekly", "monthly"] as Every[]).map(choose).join("") : "";
  const alerts = r.every === "off" ? "" : r.kind === "alert" ? "You get alerts like this one when GenClass sees something critical. " : "You also get an alert as soon as GenClass sees something critical. ";
  const stop = s ? a(`${s}&every=off`, "Stop these emails", `color:${C.ink3};text-decoration:underline;font-weight:400`) : a(r.links.account, "Change how often", `color:${C.ink3};text-decoration:underline;font-weight:400`);
  const who = r.account.verified ? "" : " Not your account? Stop these emails and nothing else is sent.";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tr><td align="center" style="padding:0 8px;font-size:12px;line-height:18px;color:${C.ink3};text-align:center">
${pills ? `<p style="margin:0 0 10px">${pills}</p>` : ""}<p style="margin:0 0 8px">${alerts}${stop}</p>
<p style="margin:0">Sent to ${esc(r.account.email)} for your GenClass account.${who} Reply to reach a person.<br>GenClass · Daybot Solutions Inc. · ${a(`${r.links.origin}/privacy`, "Privacy", `color:${C.ink3};text-decoration:underline;font-weight:400`)}</p>
</td></tr></table>`;
}

const DARK = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
 body,.gc-bg{background:#101211!important}
 .gc-card{background:#1a1c1b!important;border-color:#2c2f2d!important}
 .gc-row{border-color:#2c2f2d!important}
 .gc-card p,.gc-card td,.gc-card th,.gc-card h1,.gc-card h2,.gc-card strong{color:#e7e9e7!important}
 .gc-pr{background:#232624!important;border-color:#2c2f2d!important;color:#e7e9e7!important}
 .gc-card a{color:#3ecf8e!important}
 .gc-card a.gc-btn{color:#ffffff!important}
 .gc-card a.gc-ghost{color:#e7e9e7!important;border-color:#3a3d3b!important}
}
</style>`;

/** The HTML body. Pure. */
export function htmlOf(r: Report): string {
  const head = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;padding:0 4px"><a href="${esc(r.links.origin)}" style="text-decoration:none;color:${C.ink};font-size:16px;font-weight:700"><img src="https://genclass.dev/brand/mark-64.png?v=2" width="22" height="22" alt="" style="vertical-align:-5px;border:0;margin-right:8px">GenClass</a></td>
<td style="vertical-align:middle;text-align:right;font-size:12px;color:${C.ink3};padding:0 4px">${esc(day(r.generated))}, ${esc(clock(r.generated))}</td></tr></table>`;
  // a new account's first step is to connect its app: that card comes before the empty numbers
  const setupFirst = !measured(r).length || r.items.some((i) => i.section === "setup" && i.p === 0);
  const body =
    r.kind === "alert"
      ? [hero(r), card(itemRows(r, r.items, true), "What GenClass saw")].join("")
      : [
          hero(r),
          halfCard(r),
          summaryCard(r),
          needsCard(r),
          setupFirst ? setupCard(r) : "",
          appsCard(r),
          prsCard(r),
          visitorsCard(r),
          securityCard(r),
          setupFirst ? "" : setupCard(r),
          laterCard(r),
          knowsSites(r) ? suggestionsCard(r) : "",
          knowsSites(r) ? designCard(r) : nextCard(r),
          upgradeCard(r),
        ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subjectOf(r))}</title>${DARK}</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}" class="gc-bg"><tr><td align="center" style="padding:24px 10px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td style="font-family:${FONT}">
${head}${body}${footer(r)}
</td></tr></table>
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

/** The plain-text body. Pure. */
export function textOf(r: Report): string {
  const adj = ADJ[r.every] || "daily";
  const c = counts(counted(r));
  const out: string[] = [
    r.kind === "alert" ? "GenClass: something critical on your app" : `GenClass ${adj} report${r.kind === "test" ? " (test)" : ""}`,
    headlineOf(r).text,
    `${day(r.generated)}, ${clock(r.generated)} · ${plural(r.apps.length, "app", "apps")} · ${r.apps[0]?.period ?? ""}`,
    `${c[0]} critical · ${c[1]} important · ${c[2]} worth a look`,
    "",
  ];
  if (r.summary && r.kind !== "alert") {
    out.push("GENCLASS SUMMARY", r.summary.headline, r.summary.text, "");
    r.summary.actions.forEach((x, k) => out.push(`${k + 1}. ${x.title}${x.why ? `. ${x.why}` : ""}`, ...(x.prompt ? [`   Prompt: ${x.prompt}`] : []), ""));
  }
  const now = problemItems(r).filter((i) => i.p <= 1);
  out.push("WHAT NEEDS DOING", ...(now.length ? now.flatMap(textItem) : ["Nothing critical or important in this period.", ""]));
  for (const x of r.problemsHidden) out.push(`Locked: ${plural(x.counts[0] + x.counts[1] + x.counts[2], "more problem", "more problems")} on ${x.app} (${byP(x.counts)}): in the other half, with ${r.upgrade?.plan ?? "Pro"}.`, "");
  if (r.kind !== "alert") {
    out.push("YOUR APPS");
    for (const x of r.apps) {
      const t = x.totals;
      if (x.demo) { out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): sample data until real visits arrive. ${x.dashboard}`); continue; }
      if (!x.lastEvent) { out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): not connected yet. ${x.dashboard}`); continue; }
      out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): ${fmt(t.loads)} page loads, ${fmt(t.problems)} problems, ${fmt(t.checks)} checks, ${fmt(t.fixed)} fixed live. ${x.dashboard}`);
    }
    out.push("");
    const prs = r.apps.flatMap((x) => x.prs);
    if (prs.length) out.push("CODE CHANGES GENCLASS REVIEWED", ...prs.map((pr) => `- ${pr.repo}#${pr.number}: ${pr.flagged ? `${pr.flagged} races flagged` : "nothing flagged"} ${pr.url}`), "");
    const sec = r.items.filter((i) => i.section === "security");
    out.push("SECURITY", ...(sec.length ? sec.flatMap(textItem) : ["Nothing unusual.", ""]));
  }
  const setup = r.items.filter((i) => i.section === "setup");
  out.push("SETUP", ...(setup.length ? setup.flatMap(textItem) : ["Everything is connected.", ""]));
  if (r.kind !== "alert") {
    const p2 = problemItems(r).filter((i) => i.p === 2);
    if (p2.length) out.push("WORTH A LOOK", ...p2.flatMap(textItem));
    if (r.suggestions.length) out.push("SUGGESTIONS", ...r.suggestions.flatMap((s) => [`- ${s.title}${s.why ? `: ${s.why}` : ""}`, ...(s.prompt ? [`  Prompt: ${s.prompt}`] : [])]), "");
    if (knowsSites(r)) {
      out.push("UPGRADE YOUR WEBSITE DESIGN");
      for (const d of r.designs) out.push(`- ${d.title} (inspired by ${d.inspired_by})`, `  Prompt: ${d.prompt}`);
      for (const s of r.showcase) out.push(`- ${s.name} ${s.site}${s.three ? " (3D)" : ""}: ${s.take}`);
    } else {
      out.push("WHAT THIS REPORT WILL SHOW", `Once ${appsName(r)} sends its first page load: what breaks there and on which pages, and contrast and layout problems on your visitors' screens.`, "For ideas now, run npx genclass suggest in the app's folder.");
    }
    out.push("");
    if (r.upgrade && r.apps.length) {
      const lo = leftOut(r);
      out.push(`You're seeing half of this report on Free.${lo.length ? ` ${r.upgrade.plan} shows the other half: ${lo.join(", ")}.` : ""} ${r.upgrade.price}${r.upgrade.trialDays ? `, ${r.upgrade.trialDays} days free to start` : ""}: ${r.upgrade.url}`, "");
    }
  }
  out.push("--", `Sent to ${r.account.email} for your GenClass account.`, r.links.settings ? `Change how often, or stop these emails: ${r.links.settings}` : `Change how often: ${r.links.account}`, "Reply to reach a person at GenClass.");
  return out.join("\n");
}

/** Subject, HTML and text. Pure. */
export function renderReport(r: Report): { subject: string; html: string; text: string } {
  return { subject: subjectOf(r), html: htmlOf(r), text: textOf(r) };
}
