// The GenClass report as an email (src/report.ts builds it): a subject, an HTML body and a plain-text body.
//
// Invariants:
// - Pure: the same report gives the same email. Everything from outside (app and page names, the model's words,
//   design sites, pull request names) goes through esc() and is a line of text; links are https and built in
//   src/report.ts or here from the report's own origin.
// - Email-safe HTML: tables, inline styles, no script, no external CSS, one image (the logo, from genclass.dev). A
//   <style> block only adds the dark-mode colours for clients that read it; every client gets the light ones inline.
// - The sections and their order: what needs doing (critical, then important), the apps' numbers, code changes,
//   visitors, security, setup, worth a look, suggestions, website design, then how to change or stop these emails.
//   An app on Free is counted, not listed: its problems' count shows with Pro's box, never its pages or prompts.

import { esc } from "./escape.js";
import { DESIGN_CHECKS, EVERY_WORDS, PRIORITY_WORDS, showcasePrompt, type AppReport, type Every, type Item, type Priority, type Report } from "./report.js";

const C = {
  bg: "#f3f4f3",
  card: "#ffffff",
  ink: "#1c1c1c",
  ink2: "#4f4f4f",
  ink3: "#7a7a7a",
  rule: "#e6e6e6",
  soft: "#f7f7f7",
  green: "#0a7c4a",
  greenBg: "#eaf7f0",
  red: "#c4320a",
  redBg: "#fdeeea",
  amber: "#9a5b00",
  amberBg: "#fdf3dc",
  grey: "#555555",
  greyBg: "#efefef",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Source Code Pro',monospace";
const P_COLOURS: Record<Priority, [string, string]> = { 0: [C.red, C.redBg], 1: [C.amber, C.amberBg], 2: [C.grey, C.greyBg] };
const P_LABEL: Record<Priority, string> = { 0: "P0 critical", 1: "P1 important", 2: "P2 worth a look" };
const ADJ: Record<Every, string> = { hourly: "hourly", daily: "daily", weekly: "weekly", monthly: "monthly", off: "" };

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

const counts = (items: Item[]): Record<Priority, number> => {
  const c: Record<Priority, number> = { 0: 0, 1: 0, 2: 0 };
  for (const i of items) c[i.p]++;
  return c;
};
const problemItems = (r: Report) => r.items.filter((i) => i.section === "problems");

/** The subject line. Pure. */
export function subjectOf(r: Report): string {
  const test = r.kind === "test" ? "[Test] " : "";
  const p0 = r.items.filter((i) => i.p === 0);
  if (r.kind === "alert" && p0[0]) return `${test}[P0] ${p0[0].app}: ${p0[0].title}${p0.length > 1 ? ` (+${p0.length - 1} more)` : ""}`.slice(0, 200);
  const c = counts(r.items.filter((i) => i.section !== "setup" || i.p === 0));
  const name = r.apps.length === 1 ? r.apps[0]!.name : `${r.apps.length} apps`;
  const adj = ADJ[r.every] || "daily";
  const lead = `${test}GenClass ${adj} report, ${name}`;
  if (c[0] || c[1]) return `${lead}: ${[c[0] ? `${c[0]} critical` : "", c[1] ? `${c[1]} important` : ""].filter(Boolean).join(", ")}`.slice(0, 200);
  if (r.apps.every((a) => !a.lastEvent)) return `${lead}: finish setting up`;
  return `${lead}: all clear`;
}

// --------------------------------------------------------------------------------------------- html pieces

const a = (href: string, text: string, style = ""): string => `<a href="${esc(href)}" style="color:${C.green};text-decoration:underline;${style}">${esc(text)}</a>`;
const pill = (text: string, fg: string, bg: string): string =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600;line-height:18px;white-space:nowrap">${esc(text)}</span>`;
const h2 = (text: string, id: string): string => `<h2 id="${id}" style="margin:32px 0 12px;font-size:17px;line-height:24px;font-weight:600;color:${C.ink}">${esc(text)}</h2>`;
const p = (html: string, style = ""): string => `<p style="margin:0 0 10px;font-size:14px;line-height:21px;color:${C.ink2};${style}">${html}</p>`;
const small = (html: string): string => `<p style="margin:6px 0 0;font-size:12px;line-height:18px;color:${C.ink3}">${html}</p>`;

function promptBox(r: Report, prompt: string, label = "Copy the prompt or open it in Claude Code"): string {
  const link = r.promptLinks[prompt];
  return `<div class="gc-pr" style="margin:10px 0 0;padding:10px 12px;background:${C.soft};border:1px solid ${C.rule};border-radius:6px;font-family:${MONO};font-size:12px;line-height:18px;color:${C.ink};white-space:pre-wrap;word-break:break-word">${esc(prompt)}</div>${
    link ? `<p style="margin:6px 0 0;font-size:13px;line-height:20px">${a(link, label)}</p>` : `<p style="margin:6px 0 0;font-size:12px;line-height:18px;color:${C.ink3}">Select the text above and paste it into Claude Code, Codex or Cursor.</p>`
  }`;
}

function itemCard(r: Report, i: Item, withPrompt: boolean): string {
  const [fg, bg] = P_COLOURS[i.p];
  const pages = i.pages.length ? `<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;line-height:18px;color:${C.ink2}">${i.pages.map(esc).join(" &nbsp;·&nbsp; ")}</p>` : "";
  const link = i.link ? `<p style="margin:8px 0 0;font-size:13px;line-height:20px">${a(i.link.href, i.link.label)}</p>` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid ${C.rule};border-left:4px solid ${fg};border-radius:6px;background:${C.card}" class="gc-card"><tr><td style="padding:14px 16px">
<p style="margin:0 0 6px;font-size:12px;line-height:18px;color:${C.ink3}">${pill(P_LABEL[i.p], fg, bg)} &nbsp;${esc(i.app)}</p>
<p style="margin:0 0 4px;font-size:15px;line-height:22px;font-weight:600;color:${C.ink}">${esc(i.title)}</p>
<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(i.detail)}</p>${pages}${withPrompt && i.prompt ? promptBox(r, i.prompt) : ""}${link}
</td></tr></table>`;
}

function chips(r: Report): string {
  const c = counts(r.items.filter((i) => i.section !== "setup" || i.p === 0));
  const cell = (k: Priority) => {
    const [fg, bg] = P_COLOURS[k];
    return `<td style="padding:0 8px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:8px 12px;border-radius:6px;background:${c[k] ? bg : C.soft}"><span style="font-size:20px;line-height:24px;font-weight:600;color:${c[k] ? fg : C.ink3}">${c[k]}</span><span style="font-size:12px;line-height:18px;color:${c[k] ? fg : C.ink3}"> &nbsp;${esc(PRIORITY_WORDS[k])}</span></td></tr></table></td>`;
  };
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 0"><tr>${cell(0)}${cell(1)}${cell(2)}</tr></table>`;
}

function summaryBox(r: Report): string {
  const s = r.summary;
  if (!s) return "";
  const actions = s.actions.length
    ? `<ol style="margin:12px 0 0;padding:0 0 0 20px">${s.actions
        .map((x) => `<li style="margin:0 0 12px;font-size:14px;line-height:21px;color:${C.ink2}"><strong style="color:${C.ink}">${esc(x.title)}</strong>${x.why ? `. ${esc(x.why)}` : ""}${x.prompt ? promptBox(r, x.prompt) : ""}</li>`)
        .join("")}</ol>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;background:${C.greenBg};border-radius:8px" class="gc-sum"><tr><td style="padding:16px 18px">
<p style="margin:0 0 4px;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.green}">GenClass summary</p>
<p style="margin:0 0 8px;font-size:16px;line-height:23px;font-weight:600;color:${C.ink}">${esc(s.headline)}</p>
<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(s.text)}</p>${actions}
<p style="margin:8px 0 0;font-size:11px;line-height:16px;color:${C.ink3}">Written by a model from the numbers below; the priorities are GenClass's own rules.</p>
</td></tr></table>`;
}

function appsTable(r: Report): string {
  const hourly = r.every === "hourly";
  const th = (t: string, right = true) => `<th style="padding:8px 6px;font-size:12px;line-height:16px;font-weight:600;color:${C.ink3};text-align:${right ? "right" : "left"};border-bottom:1px solid ${C.rule}">${esc(t)}</th>`;
  const td = (h: string, right = true) => `<td style="padding:10px 6px;font-size:14px;line-height:20px;color:${C.ink};text-align:${right ? "right" : "left"};border-bottom:1px solid ${C.rule};vertical-align:top">${h}</td>`;
  const sub = (t: string) => (t ? `<br><span style="font-size:11px;color:${C.ink3}">${esc(t)}</span>` : "");
  const rows = r.apps
    .map((x) => {
      const t = x.totals;
      const status = !x.lastEvent ? "not connected yet" : x.demo ? "recorded sample, not measured yet" : `last data ${day(x.lastEvent)}`;
      const name = td(`${a(x.dashboard, x.name, "font-weight:600;text-decoration:none")}${sub(`${x.pro ? "Pro" : "Free"} · ${status}`)}`, false);
      // the recorded demo's estimate is not this app's numbers: none are printed as if measured
      if (x.demo) return `<tr>${name}${td("sample")}${td("sample")}${td("sample")}${td("-")}${hourly ? td("-") : ""}</tr>`;
      return `<tr>${name}${td(`${fmt(t.loads)}${sub(delta(t.loads, t.prevLoads))}`)}${td(`${fmt(t.problems)}${sub(delta(t.problems, t.prevProblems))}`)}${td(`${fmt(t.checks)}${sub(delta(t.checks, t.prevChecks))}`)}${td(fmt(t.fixed))}${hourly ? td(x.lastHour ? `${fmt(x.lastHour.problems + x.lastHour.checks)}${sub(`${fmt(x.lastHour.loads)} loads`)}` : "-") : ""}</tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${th("App", false)}${th("Page loads")}${th("Problems")}${th("Checks")}${th("Fixed live")}${hourly ? th("Last hour") : ""}</tr>${rows}</table>
${small(`Problems are what GenClass's model found on the live site; checks are measurements against fixed thresholds. Changes are against ${esc(r.apps[0]?.period.replace("the last", "the") ?? "the period")} before.`)}`;
}

function kindsLine(x: AppReport): string {
  if (x.demo) return `${esc(x.name)}'s dashboard shows the recorded demo's estimate until its first page load with measured checks arrives; this report lists nothing from it.`;
  if (!x.pro) return x.totals.problems + x.totals.checks ? `${plural(x.totals.problems + x.totals.checks, "problem was", "problems were")} found on ${esc(x.name)}; Pro lists each with its pages and a fix prompt.` : "";
  const parts = [...x.kinds.map((k) => `${esc(k.name)} ${fmt(k.count)}`), ...x.checks.map((k) => `${esc(k.name)} ${fmt(k.count)}`)];
  return parts.length ? `<strong style="color:${C.ink}">${esc(x.name)}</strong>: ${parts.join(" · ")}` : "";
}

function prsSection(r: Report): string {
  const rows = r.apps.flatMap((x) => x.prs.map((pr) => ({ x, pr })));
  if (!rows.length) return "";
  return `${h2("Code changes GenClass reviewed", "code")}${rows
    .map(({ x, pr }) =>
      p(
        `${a(pr.url, `${pr.repo}#${pr.number}`)} &nbsp;${pr.flagged ? pill(`${plural(pr.flagged, "race flagged", "races flagged")}${pr.fresh ? `, ${fmt(pr.fresh)} new` : ""}`, C.red, C.redBg) : pill("nothing flagged", C.green, C.greenBg)}${pr.closed ? ` ${pill("closed", C.grey, C.greyBg)}` : ""}<br><span style="font-size:12px;color:${C.ink3}">${esc(x.name)} · reviewed ${day(pr.updated)}</span>`,
      ),
    )
    .join("")}${small("From the GitHub App's reviews of your linked repositories' test runs.")}`;
}

function visitorsSection(r: Report): string {
  const withV = r.apps.filter((x) => x.visitors && x.visitors.visits + x.visitors.views > 0);
  const freeOnly = r.apps.every((x) => !x.pro);
  if (!withV.length) return freeOnly && r.upgrade ? `${h2("Visitors", "visitors")}${p(`Visits, the pages they read, where they came from, and the clicks that did nothing come with ${esc(r.upgrade.plan)}.`)}` : "";
  return `${h2("Visitors", "visitors")}${withV
    .map((x) => {
      const v = x.visitors!;
      const list = (l: { key: string; count: number }[]) => l.map((y) => `${esc(y.key)} ${fmt(y.count)}`).join(" · ");
      return `${p(`<strong style="color:${C.ink}">${esc(x.name)}</strong>: ${plural(v.visits, "visit", "visits")}, ${plural(v.views, "page view", "page views")}${v.seconds !== null ? `, ${fmt(v.seconds)} s a page on average` : ""}, ${plural(v.oneTimers, "one-page visit", "one-page visits")}${v.rage ? `, ${plural(v.rage, "rage click", "rage clicks")}` : ""}${v.dead ? `, ${plural(v.dead, "click that did nothing", "clicks that did nothing")}` : ""}.`)}${
        v.pages.length ? small(`Top pages: ${list(v.pages)}`) : ""
      }${v.sources.length ? small(`Came from: ${list(v.sources)}`) : ""}${v.countries.length ? small(`Countries: ${list(v.countries)}`) : ""}${v.devices.length ? small(`Devices: ${list(v.devices)}`) : ""}`;
    })
    .join("")}`;
}

function securitySection(r: Report): string {
  const items = r.items.filter((i) => i.section === "security");
  const body = items.length ? items.map((i) => itemCard(r, i, true)).join("") : p("Nothing unusual: no new terminals or passkeys on your account, and no request storms or traffic jumps on your apps.");
  return `${h2("Security and unusual activity", "security")}${body}${small("GenClass never stores a visitor's IP address, so this reads patterns in the counts (storms, jumps, odd behaviour) and your own account's sign-ins, not addresses.")}`;
}

function setupSection(r: Report): string {
  const items = r.items.filter((i) => i.section === "setup");
  const body = items.length ? items.map((i) => itemCard(r, i, true)).join("") : p("Everything is connected: every app is reporting and GenClass's model loads.");
  return `${h2("Is GenClass set up right?", "setup")}${body}`;
}

function suggestionsSection(r: Report): string {
  if (!r.suggestions.length && !r.suggestionsHidden) {
    return `${h2("Suggestions for your app", "suggestions")}${p(`Run <code style="font-family:${MONO};font-size:13px">npx genclass suggest</code> in your app's folder once: GenClass checks the repository and the live site, and every report after carries what to do first, with a prompt for each.`)}`;
  }
  const list = r.suggestions
    .map((s) => `<li style="margin:0 0 12px;font-size:14px;line-height:21px;color:${C.ink2}"><strong style="color:${C.ink}">${esc(s.title)}</strong>${s.why ? `<br>${esc(s.why)}` : ""}${s.prompt ? promptBox(r, s.prompt) : ""}</li>`)
    .join("");
  const more = r.suggestionsHidden && r.upgrade ? p(`${plural(r.suggestionsHidden, "more suggestion", "more suggestions")} with ${esc(r.upgrade.plan)}.`) : "";
  return `${h2("Suggestions for your app", "suggestions")}<ol style="margin:0;padding:0 0 0 20px">${list}</ol>${more}${small("From your last genclass suggest: measured checks ordered by a model, and the model's own ideas (not measured).")}`;
}

function designSection(r: Report): string {
  const out: string[] = [h2("Upgrade your website design", "design")];
  const design = r.apps.flatMap((x) => (x.pro ? x.checks.filter((c) => DESIGN_CHECKS.has(c.kind)).map((c) => ({ x, c })) : []));
  if (design.length) {
    out.push(p(`Measured on your visitors' screens: ${design.map(({ x, c }) => `${esc(c.name)} ${fmt(c.count)}${r.apps.length > 1 ? ` (${esc(x.name)})` : ""}`).join(" · ")}.${design.some(({ c }) => c.kind === "text-invisible") ? " Invisible text means a contrast under 1.5:1; aim for 4.5:1 for body text." : ""}`));
  } else if (r.apps.some((x) => x.pro && !x.demo && x.totals.loads > 0)) {
    out.push(p("No contrast, layout or font problems measured on your visitors' screens in this period."));
  }
  if (r.designs.length) {
    out.push(p("Picked for your company by the model from sites in your field (from your last genclass suggest):"));
    for (const d of r.designs) {
      out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid ${C.rule};border-radius:6px" class="gc-card"><tr><td style="padding:14px 16px">
<p style="margin:0 0 4px;font-size:15px;line-height:22px;font-weight:600;color:${C.ink}">${esc(d.title)}</p>
<p style="margin:0 0 4px;font-size:13px;line-height:20px">Inspired by ${a(d.inspired_by, d.inspired_by.replace(/^https:\/\//, ""))}</p>
${d.why ? `<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(d.why)}</p>` : ""}${promptBox(r, d.prompt, "Copy the full redesign prompt")}
</td></tr></table>`);
    }
  } else if (r.designsHidden && r.upgrade) {
    out.push(p(`${plural(r.designsHidden, "website design", "website designs")} picked for your company, each with a full redesign prompt, come with ${esc(r.upgrade.plan)}.`));
  } else {
    out.push(p(`For designs picked for your company, run <code style="font-family:${MONO};font-size:13px">npx genclass suggest</code> once: it reads what your site says it does and finds the best sites in your field.`));
  }
  const name = r.apps[0]?.name ?? "my app";
  out.push(p(`<strong style="color:${C.ink}">Sites to learn from today</strong>`, "margin-top:16px"));
  for (const s of r.showcase) {
    out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid ${C.rule};border-radius:6px" class="gc-card"><tr><td style="padding:12px 16px">
<p style="margin:0 0 4px;font-size:14px;line-height:21px;font-weight:600;color:${C.ink}">${a(s.site, s.name, "text-decoration:none")}${s.three ? ` &nbsp;${pill("3D", C.green, C.greenBg)}` : ""}</p>
<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink2}">${esc(s.take)}</p>${r.promptLinks[showcasePrompt(s, name)] ? `<p style="margin:6px 0 0;font-size:13px;line-height:20px">${a(r.promptLinks[showcasePrompt(s, name)]!, `Get a prompt that redesigns ${name} this way`)}</p>` : ""}
</td></tr></table>`);
  }
  return out.join("");
}

function upgradeBox(r: Report): string {
  const u = r.upgrade;
  if (!u) return "";
  const hidden = r.apps.filter((x) => !x.pro).reduce((s, x) => s + x.totals.problems + x.totals.checks, 0);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0;border:1px solid ${C.green};border-radius:8px" class="gc-card"><tr><td style="padding:16px 18px">
<p style="margin:0 0 6px;font-size:16px;line-height:23px;font-weight:600;color:${C.ink}">See everything in this report with ${esc(u.plan)}</p>
<p style="margin:0 0 12px;font-size:14px;line-height:21px;color:${C.ink2}">${hidden ? `${plural(hidden, "problem", "problems")} on your Free ${r.apps.filter((x) => !x.pro).length === 1 ? "app" : "apps"} with their pages and fix prompts, ` : "Every problem with its pages and fix prompts, "}the GenClass summary, visitors, and website designs picked for your company. ${esc(u.price)}${u.trialDays ? `, ${u.trialDays} days free to start` : ""}.</p>
<a class="gc-btn" href="${esc(u.url)}" style="display:inline-block;padding:10px 18px;background:${C.green};color:#ffffff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none">${u.trialDays ? `Start the ${u.trialDays}-day free trial` : `Get ${esc(u.plan)}`}</a>
</td></tr></table>`;
}

function footer(r: Report): string {
  const s = r.links.settings;
  const choose = (e: Every) => (s ? a(`${s}&every=${e}`, EVERY_WORDS[e]) : esc(EVERY_WORDS[e]));
  const now = r.every === "off" ? "" : `You get this report ${EVERY_WORDS[r.every].toLowerCase()}${r.kind === "alert" ? ", and alerts like this one when GenClass sees something critical" : ", and an alert as soon as GenClass sees something critical"}. `;
  const change = s ? `Change it: ${(["hourly", "daily", "weekly", "monthly"] as Every[]).map(choose).join(" · ")} · ${a(`${s}&every=off`, "Stop these emails")}.` : `Change it on ${a(r.links.account, "your account")}.`;
  const who = r.account.verified ? "" : ` Not your account? ${s ? a(`${s}&every=off`, "Stop these emails") : "Reply to this email"} and nothing else will be sent.`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0 0;border-top:1px solid ${C.rule}"><tr><td style="padding:16px 0 0;font-size:12px;line-height:18px;color:${C.ink3}">
${now}${change}<br><br>Sent to ${esc(r.account.email)} for your GenClass account.${who} Reply to reach a person at GenClass.<br>GenClass · Daybot Solutions Inc. · ${a(`${r.links.origin}/privacy`, "Privacy")}
</td></tr></table>`;
}

const DARK = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
 body,.gc-bg{background:#121212!important}
 .gc-main{background:#1c1c1c!important}
 .gc-main p,.gc-main td,.gc-main li,.gc-main th,.gc-main h1,.gc-main h2,.gc-main strong{color:#e6e6e6!important}
 .gc-card{background:#1c1c1c!important;border-color:#333333!important}
 .gc-pr{background:#262626!important;border-color:#333333!important;color:#e6e6e6!important}
 .gc-sum{background:#0b2118!important}
 .gc-main a{color:#3ecf8e!important}
 .gc-main a.gc-btn{color:#ffffff!important}
}
</style>`;

/** The HTML body. Pure. */
export function htmlOf(r: Report): string {
  const adj = ADJ[r.every] || "daily";
  const period = r.apps[0]?.period ?? "the last 24 hours";
  const title = r.kind === "alert" ? "Something critical on your app" : `Your ${adj} report`;
  const p0p1 = problemItems(r).filter((i) => i.p <= 1);
  const secNow = r.items.filter((i) => i.section === "security" && i.p <= 1).length;
  const p2 = problemItems(r).filter((i) => i.p === 2);
  const lines = r.apps.map(kindsLine).filter(Boolean);
  const head = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle"><a href="${esc(r.links.origin)}" style="text-decoration:none;color:${C.ink};font-size:16px;font-weight:600"><img src="https://genclass.dev/brand/mark-64.png?v=2" width="22" height="22" alt="" style="vertical-align:-5px;border:0;margin-right:8px">GenClass</a></td>
<td style="vertical-align:middle;text-align:right;font-size:12px;color:${C.ink3}">${r.kind === "test" ? "Test · " : ""}${esc(day(r.generated))}, ${esc(clock(r.generated))}</td></tr></table>`;
  const intro = `<h1 style="margin:24px 0 4px;font-size:24px;line-height:31px;font-weight:600;color:${C.ink}">${esc(title)}</h1>
<p style="margin:0;font-size:14px;line-height:21px;color:${C.ink3}">${esc(plural(r.apps.length, "app", "apps"))} · ${esc(period)}</p>${chips(r)}`;
  const needs = p0p1.length
    ? `${h2(p0p1.some((i) => i.p === 0) ? "Critical and important" : "Important", "now")}${p0p1.map((i) => itemCard(r, i, true)).join("")}`
    : `${h2("What needs doing", "now")}${p(r.apps.some((x) => x.lastEvent) ? `Nothing critical or important on your apps in this period.${secNow ? ` ${plural(secNow, "important item is", "important items are")} under Security and unusual activity below.` : ""}` : "Nothing yet: connect your app first (below).")}`;
  const free = r.apps.filter((x) => !x.pro && x.totals.problems + x.totals.checks > 0);
  const freeNote = free.length && r.upgrade ? p(`${free.map((x) => `${esc(x.name)}: ${plural(x.totals.problems + x.totals.checks, "problem", "problems")}`).join(" · ")}. Free shows the totals; ${esc(r.upgrade.plan)} lists each one with its pages and a fix prompt.`) : "";
  const body = r.kind === "alert"
    ? [head, intro, needs, setupSection(r)].join("")
    : [
        head,
        intro,
        summaryBox(r),
        needs,
        freeNote,
        h2("Your apps", "apps"),
        appsTable(r),
        lines.length ? lines.map((l) => p(l, "margin-top:10px")).join("") : "",
        prsSection(r),
        visitorsSection(r),
        securitySection(r),
        setupSection(r),
        p2.length ? `${h2("Worth a look", "later")}${p2.map((i) => itemCard(r, i, false)).join("")}` : "",
        suggestionsSection(r),
        designSection(r),
        upgradeBox(r),
      ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subjectOf(r))}</title>${DARK}</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}" class="gc-bg"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${C.card};border-radius:10px" class="gc-main"><tr><td style="padding:28px 28px 24px;font-family:${FONT}">
${body}${footer(r)}
</td></tr></table>
</td></tr></table>
</body></html>`;
}

// --------------------------------------------------------------------------------------------- plain text

function textItem(r: Report, i: Item): string[] {
  const out = [`[${P_LABEL[i.p]}] ${i.app}: ${i.title}`, `  ${i.detail}`];
  if (i.pages.length) out.push(`  Pages: ${i.pages.join(", ")}`);
  if (i.prompt) out.push("  Prompt for your coding agent:", ...i.prompt.match(/.{1,96}(\s|$)/g)!.map((l) => `    ${l.trim()}`));
  if (i.link) out.push(`  ${i.link.label}: ${i.link.href}`);
  return [...out, ""];
}

/** The plain-text body. Pure. */
export function textOf(r: Report): string {
  const adj = ADJ[r.every] || "daily";
  const c = counts(r.items.filter((i) => i.section !== "setup" || i.p === 0));
  const out: string[] = [
    r.kind === "alert" ? "GenClass: something critical on your app" : `GenClass ${adj} report${r.kind === "test" ? " (test)" : ""}`,
    `${day(r.generated)}, ${clock(r.generated)} · ${plural(r.apps.length, "app", "apps")} · ${r.apps[0]?.period ?? ""}`,
    `${c[0]} critical · ${c[1]} important · ${c[2]} worth a look`,
    "",
  ];
  if (r.summary && r.kind !== "alert") {
    out.push("GENCLASS SUMMARY", r.summary.headline, r.summary.text, "");
    r.summary.actions.forEach((x, k) => out.push(`${k + 1}. ${x.title}${x.why ? `. ${x.why}` : ""}`, ...(x.prompt ? [`   Prompt: ${x.prompt}`] : []), ""));
  }
  const now = problemItems(r).filter((i) => i.p <= 1);
  out.push("WHAT NEEDS DOING", ...(now.length ? now.flatMap((i) => textItem(r, i)) : ["Nothing critical or important in this period.", ""]));
  if (r.kind !== "alert") {
    out.push("YOUR APPS");
    for (const x of r.apps) {
      const t = x.totals;
      if (x.demo) { out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): the recorded demo's estimate, not measured yet. ${x.dashboard}`); continue; }
      out.push(`- ${x.name} (${x.pro ? "Pro" : "Free"}): ${fmt(t.loads)} page loads, ${fmt(t.problems)} problems, ${fmt(t.checks)} checks, ${fmt(t.fixed)} fixed live. ${x.dashboard}`);
    }
    out.push("");
    const prs = r.apps.flatMap((x) => x.prs);
    if (prs.length) out.push("CODE CHANGES GENCLASS REVIEWED", ...prs.map((pr) => `- ${pr.repo}#${pr.number}: ${pr.flagged ? `${pr.flagged} races flagged` : "nothing flagged"} ${pr.url}`), "");
    const sec = r.items.filter((i) => i.section === "security");
    out.push("SECURITY AND UNUSUAL ACTIVITY", ...(sec.length ? sec.flatMap((i) => textItem(r, i)) : ["Nothing unusual.", ""]));
  }
  const setup = r.items.filter((i) => i.section === "setup");
  out.push("IS GENCLASS SET UP RIGHT?", ...(setup.length ? setup.flatMap((i) => textItem(r, i)) : ["Everything is connected.", ""]));
  if (r.kind !== "alert") {
    const p2 = problemItems(r).filter((i) => i.p === 2);
    if (p2.length) out.push("WORTH A LOOK", ...p2.flatMap((i) => textItem(r, i)));
    if (r.suggestions.length) out.push("SUGGESTIONS", ...r.suggestions.flatMap((s) => [`- ${s.title}${s.why ? `: ${s.why}` : ""}`, ...(s.prompt ? [`  Prompt: ${s.prompt}`] : [])]), "");
    out.push("UPGRADE YOUR WEBSITE DESIGN");
    for (const d of r.designs) out.push(`- ${d.title} (inspired by ${d.inspired_by})`, `  Prompt: ${d.prompt}`);
    for (const s of r.showcase) out.push(`- ${s.name} ${s.site}${s.three ? " (3D)" : ""}: ${s.take}`);
    out.push("");
    if (r.upgrade) out.push(`${r.upgrade.plan}: everything in this report, ${r.upgrade.price}${r.upgrade.trialDays ? `, ${r.upgrade.trialDays} days free to start` : ""}: ${r.upgrade.url}`, "");
  }
  out.push("--", `Sent to ${r.account.email} for your GenClass account.`, r.links.settings ? `Change how often, or stop these emails: ${r.links.settings}` : `Change how often: ${r.links.account}`, "Reply to reach a person at GenClass.");
  return out.join("\n");
}

/** Subject, HTML and text. Pure. */
export function renderReport(r: Report): { subject: string; html: string; text: string } {
  return { subject: subjectOf(r), html: htmlOf(r), text: textOf(r) };
}
