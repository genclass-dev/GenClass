// Routes for GenClass reports by email (src/report.ts). Checked before the account routes; null for any other path.
//
//   GET  /account/report               browser session; how often, alerts, Send me one now, the preview
//   GET  /account/report/preview       browser session; this account's report as the email shows it (nothing sent,
//                                      no model summary)
//   GET  /api/account/report           browser session; { every, alerts, next, sent, email, can_send }
//   POST /api/account/report           browser session + Origin; { every, alerts }: saved, the next slot set again
//   POST /api/account/report/test      browser session + Origin; sends this account's report now (TEST_DAILY_CAP a day)
//   GET  /account/report/email         no session: ?a=<account>&t=<token> from an email's links; the same choice, with
//                                      ?every= ticked, and a Save button (a GET never changes anything)
//   POST /api/report/settings          the token in the form: { a, t, every, alerts }; a form post goes back to the page
//   GET|POST /api/report/unsubscribe   the List-Unsubscribe link: a POST (RFC 8058 one-click) turns reports and
//                                      alerts off; a GET opens the page above with Never ticked
//   GET  /account/report/prompt        no session: ?q=<prompt>&s=<signature>; shows a prompt the report signed, with
//                                      Copy and links that open it in Claude Code or Codex
//
// A CLI session is refused on every route here (rule 12: a terminal does what its approval page lists). The token is
// an HMAC of the account id (src/report.ts accountToken): it changes nothing but this account's report settings.

import { accountContext, fail, page, readJson, redirect, webSession, type C } from "./auth.js";
import { ACCOUNT_CSS, CLIENT_JS, orgRail } from "./account-pages.js";
import { browserRead, browserWrite } from "./billing.js";
import type { Env, HandleOptions } from "./collector.js";
import { esc } from "./escape.js";
import { json } from "./http.js";
import { agentLinks, DASH_CSS, LOGO, orgName, shell } from "./pages.js";
import { renderReport } from "./report-email.js";
import { ACCOUNT_REPORT_COLUMNS, buildReport, claimSend, everyOf, EVERY, EVERY_WORDS, nextSlot, REPORT_HOUR_UTC, sendReport, signatureOk, TEST_DAILY_CAP, tokenOk, type AccountRow, type Every } from "./report.js";
import { COPY_JS, studioPage } from "./studio.js";

const method = (): Response => fail(405, "method not allowed");
const MAX_PROMPT = 6000;

const WHEN: Record<Every, string> = {
  hourly: "At 7 minutes past every hour, only when something happened.",
  daily: `Every day at ${REPORT_HOUR_UTC}:00 UTC (9 am in Toronto).`,
  weekly: `Mondays at ${REPORT_HOUR_UTC}:00 UTC.`,
  monthly: `The 1st of the month at ${REPORT_HOUR_UTC}:00 UTC.`,
  off: "No reports and no alerts.",
};

async function accountRow(c: C, id: string): Promise<AccountRow | null> {
  try {
    return await c.db.prepare(`SELECT ${ACCOUNT_REPORT_COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  } catch {
    return null; // migration 0020 not applied: reports are unavailable
  }
}

/** Saves the choice and gives the account the next slot of its new schedule. False when the columns are not there. */
async function save(c: C, id: string, every: Every, alerts: boolean): Promise<boolean> {
  try {
    await c.db.prepare("UPDATE accounts SET report_every = ?, report_alerts = ?, report_next = ? WHERE id = ?").bind(every, alerts ? 1 : 0, nextSlot(c.now, every), id).run();
    return true;
  } catch {
    return false;
  }
}

const readEvery = (v: unknown): Every | null => (typeof v === "string" && (EVERY as readonly string[]).includes(v) ? (v as Every) : null);

// --------------------------------------------------------------------------------------------- pages

const PAGE_CSS = `
.rp{display:grid;gap:18px;max-width:620px}
.rp-ch{display:grid;gap:8px;border:0;padding:0;margin:0;min-width:0}
.rp-ch legend{font-size:14px;font-weight:500;margin-bottom:6px;padding:0}
.rp-ch label{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:start;padding:12px 14px;border:1px solid var(--rule2,var(--rule));border-radius:8px;cursor:pointer}
.rp-ch label:has(input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.rp-ch input{margin:3px 0 0}
.rp-ch b{font-weight:500}
.rp-ch small{grid-column:2;color:var(--ink3);font-size:13px}
.rp-al{display:flex;gap:10px;align-items:flex-start;font-size:14px}
.rp-al input{margin-top:3px}
.rp-acts{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.rp-note{color:var(--ink3);font-size:13px;margin:0}
.rp-ok{color:var(--accent-f,var(--accent));font-size:14px;margin:0}
.rp-err{color:var(--warn-f,#e5484d);font-size:14px;margin:0}
.rp-err:empty,.rp-ok:empty{display:none}
.rp-pr{white-space:pre-wrap;word-break:break-word;font-family:"Source Code Pro",ui-monospace,monospace;font-size:13px;line-height:1.55;padding:14px 16px;border:1px solid var(--rule);border-radius:8px;background:var(--panel,transparent);max-height:55vh;overflow:auto}
`;

function choices(every: Every, alerts: boolean): string {
  const radio = (e: Every) =>
    `<label><input type="radio" name="every" value="${e}"${e === every ? " checked" : ""}><b>${esc(EVERY_WORDS[e])}</b><small>${esc(WHEN[e])}</small></label>`;
  return `<fieldset class="rp-ch"><legend>How often</legend>${EVERY.map(radio).join("")}</fieldset>
<label class="rp-al"><input type="checkbox" name="alerts" value="1"${alerts ? " checked" : ""}><span>Also email me at once when GenClass sees something critical (P0): an endpoint that keeps failing, a page that stopped working, an app that went silent. At most once a day per app and problem.</span></label>`;
}

/** A page outside the account frame (the email's links): the sign-in pages' column. */
function barePage(nonce: string, title: string, inner: string, script: string): string {
  return shell(nonce, `${title} | GenClass`, `<style nonce="${nonce}">${ACCOUNT_CSS}${PAGE_CSS}</style><div class="auth">${LOGO}${inner}</div>`, COPY_JS + script, { bare: true, account: true });
}

function emailSettingsPage(nonce: string, o: { a: string; t: string; every: Every; alerts: boolean; email: string | null; saved: boolean }): string {
  const inner = `<h1>Your GenClass emails</h1>
<p class="lead">${o.email ? `For ${esc(o.email)}. ` : ""}Choose how often the report comes, then save.</p>
<form class="rp" method="post" action="/api/report/settings">
<input type="hidden" name="a" value="${esc(o.a)}"><input type="hidden" name="t" value="${esc(o.t)}">
${choices(o.every, o.alerts)}
<div class="rp-acts"><button class="btn green" type="submit">Save</button></div>
<p class="rp-ok" role="status">${o.saved ? "Saved." : ""}</p>
</form>
<p class="rp-note">Signed in? The same settings are on <a href="/account/report">your account</a>.</p>`;
  return barePage(nonce, "Your GenClass emails", inner, "");
}

function promptPage(nonce: string, prompt: string): string {
  const links = agentLinks(prompt)
    .map((l) => `<a class="btn ghost" href="${esc(l.href)}"${l.fallback ? ` data-fallback="${esc(l.fallback)}"` : ""}>Open in ${esc(l.label)}</a>`)
    .join(" ");
  const inner = `<h1>A prompt from your GenClass report</h1>
<p class="lead">Paste it into your coding agent in the app's repository. Nothing runs until you press Enter there.</p>
<div class="rp-pr" id="pr">${esc(prompt)}</div>
<div class="rp-acts"><button class="btn green" type="button" data-copy="${esc(prompt)}">Copy prompt</button> ${links}</div>
<p class="rp-note">Claude Code opens with the prompt filled in when its desktop app is installed; otherwise copy it into the terminal.</p>`;
  // a deep link that the browser cannot open falls back to the terminal's (src/pages.ts agentLinks)
  const script = `document.querySelectorAll("a[data-fallback]").forEach(function(a){ a.addEventListener("click", function(){ var f = a.getAttribute("data-fallback"); setTimeout(function(){ if (document.visibilityState === "visible") location.href = f; }, 1200); }); });`;
  return barePage(nonce, "A prompt from your report", inner, script);
}

function settingsPage(nonce: string, o: { label: string; projects: { id: string; name: string }[]; every: Every; alerts: boolean; email: string | null; next: string | null; sent: string | null; canSend: boolean }): string {
  const body = `<div class="sb-page" id="mc" tabindex="-1">
<header class="sb-ph"><div><h1>Email reports</h1><p class="who">${o.email ? `Sent to ${esc(o.email)}` : "Your account has no email: add a password with an email, or sign in with Google, to get reports."}</p></div></header>
<section class="blk"><div class="blk-h"><h2>Your GenClass report</h2></div>
<p class="intro">What GenClass found on your apps, what changed in your code, who visited, anything unusual, what to fix in your setup and ideas for your website's design, each with a prompt you can paste into Claude Code.</p>
<form class="rp" id="rpf" novalidate>
${choices(o.every, o.alerts)}
<div class="rp-acts"><button class="btn" type="submit" id="rpsave"><span>Save</span></button><button class="btn ghost" type="button" id="rptest"${o.canSend ? "" : " disabled"}><span>Send me one now</span></button><a class="btn ghost" href="/account/report/preview" target="_blank" rel="noopener">Preview</a></div>
<p class="rp-ok" id="rpok" role="status"></p><p class="rp-err" id="rperr" role="alert"></p>
<p class="rp-note">${o.next ? `Next report: ${esc(o.next.slice(0, 16).replace("T", " "))} UTC. ` : ""}${o.sent ? `Last email: ${esc(o.sent.slice(0, 16).replace("T", " "))} UTC.` : ""}</p>
</form></section></div>`;
  const script = `
(function(){
  var f = document.getElementById("rpf"), ok = document.getElementById("rpok"), err = document.getElementById("rperr"), test = document.getElementById("rptest");
  function val(){ var e = f.querySelector("input[name=every]:checked"); return { every: e ? e.value : "daily", alerts: !!f.querySelector("input[name=alerts]").checked }; }
  f.addEventListener("submit", function(ev){ ev.preventDefault(); ok.textContent = ""; err.textContent = "";
    gcPost("/api/account/report", val()).then(function(j){ ok.textContent = "Saved." + (j.next ? " Next report: " + j.next.slice(0, 16).replace("T", " ") + " UTC." : ""); }, function(e){ err.textContent = e.message; });
  });
  test.addEventListener("click", function(){ ok.textContent = ""; err.textContent = ""; test.disabled = true;
    gcPost("/api/account/report/test", {}).then(function(){ ok.textContent = "Sent. It can take a minute to arrive."; test.disabled = false; }, function(e){ err.textContent = e.message; test.disabled = false; });
  });
})();`;
  return studioPage(nonce, {
    title: "Email reports | GenClass",
    account: true,
    org: { name: orgName(o.label), plan: null, href: "/account" },
    projects: o.projects,
    project: null,
    user: { label: o.label, sub: orgName(o.label) },
    ...orgRail("settings"),
    railLabel: "Organization",
    css: DASH_CSS + PAGE_CSS,
    body,
    script: CLIENT_JS + script,
  });
}

/** The email's HTML as a page: its own inline styles, no script. */
function previewResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https://genclass.dev data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

// --------------------------------------------------------------------------------------------- the routes

const PATHS = new Set(["/account/report", "/account/report/preview", "/account/report/email", "/account/report/prompt", "/api/account/report", "/api/account/report/test", "/api/report/settings", "/api/report/unsubscribe"]);

/** Form fields or JSON, whichever the request sent (the email's page works without script). */
async function readFields(c: C): Promise<Record<string, unknown> | Response> {
  const type = c.req.headers.get("content-type") ?? "";
  if (type.startsWith("application/x-www-form-urlencoded")) {
    const text = await c.req.text().catch(() => "");
    if (text.length > 4096) return fail(413, "too large");
    return Object.fromEntries(new URLSearchParams(text));
  }
  return readJson(c, 4096);
}

export async function routeReport(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (!PATHS.has(path)) return null;
  const c = accountContext(request, url, env, opts);
  if (!c) return null; // the account routes answer "unavailable"
  const m = request.method;
  const get = m === "GET" || m === "HEAD";
  const post = m === "POST";

  switch (path) {
    case "/account/report": {
      if (!get) return method();
      const a = await webSession(c);
      if (!a) return redirect("/login?next=%2Faccount%2Freport");
      const row = await accountRow(c, a.account.id);
      const projects = ((await c.db.prepare("SELECT id, name FROM projects WHERE account_id = ? AND id IS NOT NULL ORDER BY created").bind(a.account.id).all<{ id: string; name: string }>()).results ?? []);
      const label = a.account.email ?? (a.account.github_login ? `@${a.account.github_login}` : "Your account");
      return page(200, (n) => settingsPage(n, { label, projects, every: everyOf(row?.report_every), alerts: (row?.report_alerts ?? 1) === 1, email: a.account.email, next: row?.report_next ?? null, sent: row?.report_sent ?? null, canSend: !!a.account.email && !!env.EMAIL && !!row }));
    }
    case "/account/report/preview": {
      if (!get) return method();
      const a = await webSession(c);
      if (!a) return redirect("/login?next=%2Faccount%2Freport%2Fpreview");
      const row = await accountRow(c, a.account.id);
      if (!row || !row.email) return fail(404, "this account has no email to send reports to");
      const built = await buildReport(env, row, { kind: "test", now: c.now, model: false, fetch: (u, i) => fetch(u, i) });
      if (!built) return fail(404, "this account has no apps yet");
      return previewResponse(renderReport(built.report).html);
    }
    case "/api/account/report": {
      if (get) {
        const a = await browserRead(c);
        if (a instanceof Response) return a;
        const row = await accountRow(c, a.account.id);
        if (!row) return fail(503, "reports are unavailable");
        return json(200, { every: everyOf(row.report_every), alerts: row.report_alerts === 1, next: row.report_next, email: row.email, can_send: !!row.email && !!env.EMAIL });
      }
      if (!post) return method();
      const a = await browserWrite(c, "email reports are changed");
      if (a instanceof Response) return a;
      const body = await readJson(c, 1024);
      if (body instanceof Response) return body;
      const every = readEvery(body.every);
      if (!every) return fail(400, `every must be one of ${EVERY.join(", ")}`);
      if (!(await save(c, a.account.id, every, body.alerts !== false))) return fail(503, "reports are unavailable");
      return json(200, { ok: true, every, alerts: body.alerts !== false, next: nextSlot(c.now, every) });
    }
    case "/api/account/report/test": {
      if (!post) return method();
      const a = await browserWrite(c, "a report is sent");
      if (a instanceof Response) return a;
      if (!env.EMAIL) return fail(503, "this GenClass server does not send email");
      const row = await accountRow(c, a.account.id);
      if (!row) return fail(503, "reports are unavailable");
      if (!row.email) return fail(400, "your account has no email address");
      if (!(await claimSend(c.db, `test:${row.id}`, c.now, TEST_DAILY_CAP))) return fail(429, `at most ${TEST_DAILY_CAP} test reports a day`);
      const built = await buildReport(env, row, { kind: "test", now: c.now, model: true, fetch: (u, i) => fetch(u, i) });
      if (!built) return fail(400, "your account has no apps yet: create one first");
      const ok = await sendReport(env, built.report, renderReport(built.report), c.now);
      return ok ? json(200, { ok: true }) : fail(502, "the email could not be sent; try again later");
    }
    case "/account/report/email": {
      if (!get) return method();
      const id = url.searchParams.get("a") ?? "";
      const t = url.searchParams.get("t") ?? "";
      if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !(await tokenOk(env, id, t))) return page(404, (n) => barePage(n, "This link does not work", `<h1>This link does not work</h1><p class="lead">Open the settings from a newer report, or <a href="/account/report">sign in</a>.</p>`, ""));
      const row = await accountRow(c, id);
      if (!row) return page(404, (n) => barePage(n, "This link does not work", `<h1>This link does not work</h1><p class="lead">The account is gone.</p>`, ""));
      const every = readEvery(url.searchParams.get("every")) ?? everyOf(row.report_every);
      return page(200, (n) => emailSettingsPage(n, { a: id, t, every, alerts: every === "off" ? false : row.report_alerts === 1, email: row.email, saved: url.searchParams.get("saved") === "1" }));
    }
    case "/api/report/settings": {
      if (!post) return method();
      const body = await readFields(c);
      if (body instanceof Response) return body;
      const id = typeof body.a === "string" ? body.a : "";
      const t = typeof body.t === "string" ? body.t : "";
      if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !(await tokenOk(env, id, t))) return fail(403, "this link does not work");
      const every = readEvery(body.every);
      if (!every) return fail(400, `every must be one of ${EVERY.join(", ")}`);
      const alerts = every !== "off" && (body.alerts === true || body.alerts === "1");
      if (!(await save(c, id, every, alerts))) return fail(503, "reports are unavailable");
      const form = (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
      return form ? redirect(`/account/report/email?a=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}&saved=1`, [], 303) : json(200, { ok: true, every, alerts });
    }
    case "/api/report/unsubscribe": {
      const id = url.searchParams.get("a") ?? "";
      const t = url.searchParams.get("t") ?? "";
      if (get) return redirect(`/account/report/email?a=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}&every=off`);
      if (!post) return method();
      if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !(await tokenOk(env, id, t))) return fail(403, "this link does not work");
      if (!(await save(c, id, "off", false))) return fail(503, "reports are unavailable");
      return new Response("You will get no more GenClass reports or alerts.", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    case "/account/report/prompt": {
      if (!get) return method();
      const q = url.searchParams.get("q") ?? "";
      if (!q || q.length > MAX_PROMPT || !(await signatureOk(env, q, url.searchParams.get("s")))) {
        return page(404, (n) => barePage(n, "This link does not work", `<h1>This link does not work</h1><p class="lead">It did not come from a GenClass report, or it was cut short. Copy the prompt from the email itself.</p>`, ""));
      }
      return page(200, (n) => promptPage(n, q));
    }
  }
  return null;
}
