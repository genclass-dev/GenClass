// What the `genclass` command asks genclass.dev beyond the runtime CLI's own calls (packages/runtime/bin/lib/account.mjs):
// the account's overview (plan, apps, limits), what the GitHub App is doing on this repository, the suggestions
// plan, and one app's dashboard as data. The request and answer shapes are the collector's (telemetry-worker/src/cli.ts).
//
// Invariants:
// - Every call carries the CLI session saved by `genclass login` and goes to the host that session was made for.
// - None of them rejects: each resolves { ok: true, ... } or { ok: false, reason, status?, missing? }. `missing` is
//   true when the server has no such route (an older or self-hosted collector): the caller then says what it cannot
//   check instead of failing.
// - Text from the server is data. Whoever prints it passes it through tui.mjs clean() first.

import { cleanProject, failure, request } from "../../runtime/bin/lib/account.mjs";

const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
/** The server's 402 for an account without Pro (the genclass command is Pro's since 2026-11-13), as cliOf reads it. */
const proOf = (r, host) => (r.status === 402 && r.json?.needs_pro === true ? { needsPro: cliOf({ ...r.json, paid: false }, host) } : {});
/** Why a call failed, in the server's own sentence when Pro is why. */
const why = (r, what) => (r.status === 402 && r.json?.needs_pro === true && typeof r.json.error === "string" ? r.json.error.slice(0, 300) : failure(r, what));
const sameOrigin = (u, host) => {
  try {
    return typeof u === "string" && new URL(u).origin === host ? u : null;
  } catch {
    return null;
  }
};

/**
 * The account, its plan and its apps. From GET /api/cli/overview; on a server without it, from GET /api/me, with the
 * plan and limits unknown (null).
 * @returns {Promise<{ ok: true, account: object, plan: { id: string, name: string } | null, suggestions: { perDay: number | null, shown: number | null, usedToday: number, model: boolean } | null, projects: object[], github: { app: boolean, installUrl: string | null, connectUrl: string | null } | null, billingUrl: string | null } | { ok: false, status: number, reason: string }>}
 */
export async function fetchOverview(creds, opts = {}) {
  const base = { token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn };
  let r = await request("/api/cli/overview", base);
  const full = r.ok;
  if (!r.ok && r.status === 404) r = await request("/api/me", base);
  if (!r.ok) return { ok: false, status: r.status, reason: failure(r) };
  const j = r.json ?? {};
  const projects = (Array.isArray(j.projects) ? j.projects : []).map((p) => withPlan(cleanProject(p, creds.host), p, creds.host)).filter(Boolean);
  const account = j.account && typeof j.account === "object" ? { id: String(j.account.id ?? ""), email: str(j.account.email), github_login: str(j.account.github_login, 60) } : creds.account;
  if (!full) return { ok: true, account, plan: null, suggestions: null, projects, github: null, billingUrl: null };
  const s = j.suggestions && typeof j.suggestions === "object" ? j.suggestions : null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  return {
    ok: true,
    account,
    plan: j.plan && typeof j.plan === "object" && str(j.plan.id, 40) ? { id: str(j.plan.id, 40), name: str(j.plan.name, 40) ?? str(j.plan.id, 40) } : null,
    suggestions: s ? { perDay: num(s.per_day), shown: num(s.shown), usedToday: num(s.used_today) ?? 0, model: s.model === true } : null,
    projects,
    github: j.github && typeof j.github === "object" ? { app: j.github.app === true, installUrl: sameOrigin(j.github.install_url, creds.host), connectUrl: sameOrigin(j.github.connect_url, creds.host) } : null,
    billingUrl: sameOrigin(j.billing_url, creds.host),
    offer: offerOf(j.offer, creds.host),
    cli: cliOf(j.cli, creds.host),
  };
}

/**
 * Whether this command works for the account (it is Pro's since 2026-11-13: Pro, its trial, GenClass's grant or a
 * place in a paying team) and, without it, where Pro starts: the plan's name, its price, the trial the account has
 * left, and the page that opens the checkout (on the server's own host; its billing page when it sent another).
 * Null when the server does not say (an older or self-hosted one): nothing is locked then.
 * @returns {{ paid: true } | { paid: false, plan: string, price: string | null, trialDays: number | null, checkoutUrl: string } | null}
 */
export function cliOf(v, host) {
  if (!v || typeof v !== "object" || typeof v.paid !== "boolean") return null;
  if (v.paid) return { paid: true };
  const days = Number(v.trial_days);
  return {
    paid: false,
    plan: str(v.plan, 40) ?? "Pro",
    price: str(v.price, 60),
    trialDays: Number.isInteger(days) && days > 0 && days <= 730 ? days : null,
    checkoutUrl: sameOrigin(v.checkout_url, host) ?? `${host}/account/billing`,
  };
}

/**
 * An app with its plan, when the server says it (plans are per project since genclass.dev's billing/plans.json
 * version 4): `plan` { id, name, source }, `needsPlan` for an app past the ones Free covers, `planChosen` once Free
 * was chosen for it on its plan page, `planUrl` that page (on the server's own host, or none).
 */
function withPlan(app, p, host) {
  if (!app || !p?.plan || typeof p.plan !== "object" || !str(p.plan.id, 40)) return app;
  return { ...app, plan: { id: str(p.plan.id, 40), name: str(p.plan.name, 40) ?? str(p.plan.id, 40), source: str(p.plan.source, 20) }, needsPlan: p.needs_plan === true, planChosen: p.plan_chosen === true, planUrl: sameOrigin(p.plan_url, host) };
}

/**
 * The plan an account on Free can start, in the server's own words (its name, price and the lines of its card come
 * from genclass.dev's plans, never from this command). Null when the server offers none, or when what it sent is
 * not usable (no plan, no price, or a checkout address that is not on the server's own host).
 */
function offerOf(o, host) {
  if (!o || typeof o !== "object" || !o.plan || typeof o.plan !== "object") return null;
  const id = str(o.plan.id, 40);
  const price = str(o.price, 60);
  const checkoutUrl = sameOrigin(o.checkout_url, host);
  if (!id || !price || !checkoutUrl) return null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  const f = o.free && typeof o.free === "object" ? o.free : {};
  return {
    plan: { id, name: str(o.plan.name, 40) ?? id },
    price,
    summary: str(o.summary, 200),
    features: (Array.isArray(o.features) ? o.features : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 12).map((x) => x.slice(0, 120)),
    checkoutUrl,
    free: { name: str(f.name, 40) ?? "Free", apps: num(f.apps), historyDays: num(f.history_days), suggestionsShown: num(f.suggestions_shown), liveFixes: num(f.live_fixes) },
    trialDays: num(o.trial_days),
    appsPerUnit: num(o.apps_per_unit),
  };
}

/**
 * What genclass-dev[bot] is doing on a GitHub repository ("owner/name"), as far as the account's own answer from
 * GitHub says. `known` is false when genclass.dev has no recent answer for this account: the person then continues
 * with GitHub in the browser (`connectUrl`), and the next call knows.
 * @returns {Promise<{ ok: true, known: boolean, installed: boolean | null, evidence: boolean, prs: number, last: string | null, private: boolean, needsPlan: boolean, paused: boolean, connectUrl: string | null, installUrl: string | null } | { ok: false, status: number, reason: string, missing?: true }>}
 */
export async function fetchRepoStatus(creds, repo, opts = {}) {
  const r = await request(`/api/cli/github?repo=${encodeURIComponent(repo)}`, { token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn });
  if (!r.ok) return { ok: false, status: r.status, reason: why(r), ...(r.status === 404 ? { missing: true } : {}), ...proOf(r, creds.host) };
  const j = r.json ?? {};
  return {
    ok: true,
    known: j.known === true,
    installed: typeof j.installed === "boolean" ? j.installed : null,
    evidence: j.evidence === true,
    prs: Number.isFinite(Number(j.prs)) ? Math.max(0, Number(j.prs)) : 0,
    last: str(j.last, 40),
    private: j.private === true,
    needsPlan: j.needs_plan === true,
    paused: j.paused === true,
    connectUrl: sameOrigin(j.connect_url, creds.host),
    installUrl: sameOrigin(j.install_url, creds.host),
  };
}

/**
 * The suggestions plan for a digest of failed checks (suggest/digest.mjs): which to do first for this app, why, the
 * first step and a prompt for a coding agent. `source` says who ordered it: "model" (genclass.dev's model) or
 * "checks" (the checks' own weights: no model on the server, the day's runs used up, or the model did not answer).
 * @returns {Promise<{ ok: true, source: "model" | "checks", plan: { id: string, name: string } | null, total: number, items: { id: string, why: string | null, step: string | null, prompt: string | null }[], locked: number, lockedIds: string[], upgradeUrl: string | null, remainingToday: number | null, limited: boolean } | { ok: false, status: number, reason: string, missing?: true }>}
 */
export async function requestPlan(creds, digest, opts = {}) {
  // the model works through the checks, its own ideas and three website designs: up to 90 seconds on the server
  const r = await request("/api/cli/suggest", { method: "POST", token: creds.access_token, host: creds.host, body: digest, fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs ?? 120_000 });
  if (!r.ok) return { ok: false, status: r.status, reason: why(r), ...(r.status === 404 ? { missing: true } : {}), ...proOf(r, creds.host) };
  const j = r.json ?? {};
  const items = (Array.isArray(j.items) ? j.items : [])
    .filter((i) => i && typeof i === "object" && /^[a-z0-9-]{1,40}$/.test(String(i.id ?? "")))
    .slice(0, 80)
    .map((i) => ({ id: String(i.id), why: str(i.why, 600), step: str(i.step, 400), prompt: str(i.prompt, 1200) }));
  return {
    ok: true,
    source: j.source === "model" ? "model" : "checks",
    plan: j.plan && typeof j.plan === "object" && str(j.plan.id, 40) ? { id: str(j.plan.id, 40), name: str(j.plan.name, 40) ?? str(j.plan.id, 40) } : null,
    total: Number.isFinite(Number(j.total)) ? Number(j.total) : items.length,
    items,
    locked: Number.isFinite(Number(j.locked)) ? Math.max(0, Number(j.locked)) : 0,
    lockedIds: (Array.isArray(j.locked_ids) ? j.locked_ids : []).filter((x) => typeof x === "string" && /^[a-z0-9-]{1,40}$/.test(x)).slice(0, 80),
    upgradeUrl: sameOrigin(j.upgrade_url, creds.host),
    remainingToday: Number.isFinite(Number(j.remaining_today)) && j.remaining_today !== null ? Number(j.remaining_today) : null,
    limited: j.limited === true,
    /** the model's own ideas (not measured) and website designs: Pro gets them, Free their counts */
    ideas: (Array.isArray(j.ideas) ? j.ideas : [])
      .filter((i) => i && typeof i === "object" && str(i.title, 120))
      .slice(0, 20)
      .map((i) => ({ title: str(i.title, 120), why: str(i.why, 600), step: str(i.step, 400), prompt: str(i.prompt, 1200) })),
    designs: (Array.isArray(j.designs) ? j.designs : [])
      .filter((d) => d && typeof d === "object" && str(d.title, 120) && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(String(d.inspired_by ?? "")) && str(d.prompt, 4000))
      .slice(0, 4)
      .map((d) => ({ title: str(d.title, 120), inspiredBy: String(d.inspired_by).slice(0, 200), why: str(d.why, 600), prompt: str(d.prompt, 4000) })),
    ideasLocked: Number.isFinite(Number(j.ideas_locked)) ? Math.max(0, Number(j.ideas_locked)) : 0,
    designsLocked: Number.isFinite(Number(j.designs_locked)) ? Math.max(0, Number(j.designs_locked)) : 0,
    /** this answer was kept from an earlier run (Free sees its first one again until it pays) */
    cachedAt: str(j.cached_at, 40),
    upgradePlan: j.upgrade_plan && typeof j.upgrade_plan === "object" ? { plan: str(j.upgrade_plan.name, 40), price: str(j.upgrade_plan.price, 60), trialDays: Number.isInteger(j.upgrade_plan.trial_days) && j.upgrade_plan.trial_days > 0 ? j.upgrade_plan.trial_days : null } : null,
  };
}

const count = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const pairs = (list, max) =>
  (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === "object" && typeof x.key === "string")
    .slice(0, max)
    .map((x) => ({ key: x.key.slice(0, 300), count: count(x.count) }));

/**
 * True when the saved sign-in works but was approved before the command could do what it does now, so the server
 * asks for one more approval (403 with `reauth`). The newest thing a terminal is approved for is asked first (the
 * account's plan); a server without that route is asked the one before it (a dashboard, with an id no app has:
 * the server checks the sign-in first). False for anything else, including a server that cannot be reached.
 */
export async function signInIsOld(creds, opts = {}) {
  const ask = (path) => request(path, { token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn });
  const old = (r) => !r.ok && r.status === 403 && r.json?.reauth === true;
  const newest = await ask("/api/cli/account");
  if (old(newest)) return true;
  if (newest.ok || newest.status !== 404) return false;
  return old(await ask("/api/cli/app?id=-&range=24h"));
}

/** A part the plan leaves out, as the server said it: { plan, trialDays, price, upgradeUrl }, or null. */
function lockOf(l, host) {
  if (!l || typeof l !== "object") return null;
  const days = Number(l.trial_days);
  return { plan: str(l.plan, 40), trialDays: Number.isInteger(days) && days > 0 ? days : null, price: str(l.price, 60), upgradeUrl: sameOrigin(l.upgrade_url, host) };
}

/** The live-fix count the server sent with an app's dashboard (src/usage.ts there), or null. */
function liveUsage(u) {
  if (!u || typeof u !== "object" || !Number.isFinite(Number(u.used))) return null;
  const lim = u.limit === null || u.limit === undefined || !Number.isFinite(Number(u.limit)) ? null : Math.max(0, Math.round(Number(u.limit)));
  return { used: Math.max(0, Math.round(Number(u.used))), limit: lim, observeOnly: u.observe_only === true, resets: str(u.resets, 40) };
}

/**
 * One app's dashboard as data, for `genclass dashboard`: the counts the browser dashboard shows, for the period.
 * `reauth` is true when this sign-in was approved before the command could show dashboards (sign in again);
 * `missing` when the server has no such route; `locked` when the app's plan leaves the dashboard out.
 * @param {{ access_token: string, host: string }} creds
 * @param {string} id     the app's id in the account (from the overview)
 * @param {string} [range] "24h", "7d" or "30d" (a plan may show longer ones)
 */
export async function fetchApp(creds, id, range = "7d", opts = {}) {
  const r = await request(`/api/cli/app?id=${encodeURIComponent(id)}&range=${encodeURIComponent(range)}`, { token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn });
  if (!r.ok) return { ok: false, status: r.status, reason: why(r), ...(r.status === 404 ? { missing: true } : {}), ...proOf(r, creds.host), ...(r.json?.reauth === true ? { reauth: true } : {}), ...(r.json?.locked === true ? { locked: true, upgradeUrl: sameOrigin(r.json.upgrade_url, creds.host) } : {}) };
  const j = r.json ?? {};
  const t = j.totals && typeof j.totals === "object" ? j.totals : {};
  const b = j.breakdowns && typeof j.breakdowns === "object" ? j.breakdowns : {};
  const st = j.agent?.stages && typeof j.agent.stages === "object" ? j.agent.stages : {};
  const v = j.visits && typeof j.visits === "object" ? j.visits : {};
  const lock = j.locked?.analytics && typeof j.locked.analytics === "object" ? j.locked.analytics : null;
  return {
    ok: true,
    name: str(j.name, 80) ?? "",
    range: str(j.range, 8) ?? range,
    lastEvent: str(j.lastEvent, 40),
    totals: { visits: count(t.sessions), found: count(t.detections), handled: count(t.acted), possible: count(t.possible), checks: count(t.checks), pageViews: count(t.ix_views) },
    previous: { found: count(j.previous?.detections), visits: count(j.previous?.sessions) },
    /** problems found per bucket (hour or day), oldest first */
    series: (Array.isArray(j.series) ? j.series : []).slice(-400).map((x) => count(x?.detections)),
    /** kind TAB page */
    problems: pairs(b.detect_issue, 200),
    possible: pairs(b.possible_issue, 200),
    checks: pairs(b.check_issue, 200),
    kinds: pairs(b.detect_diagnosis, 25),
    recent: (Array.isArray(j.recent) ? j.recent : [])
      .filter((x) => x && typeof x === "object")
      .slice(0, 20)
      .map((x) => ({ at: str(x.t, 40), kind: str(x.diagnosis, 60), route: str(x.route, 200), handled: x.acted === 1 || x.acted === true })),
    visitors: lock ? null : { visits: count(v.sessions), pages: count(v.pages), bounces: count(v.bounces), entry: pairs(v.entry, 25) },
    visitorsPlan: lock ? { plan: str(lock.plan, 40), upgradeUrl: sameOrigin(lock.upgrade_url, creds.host) } : null,
    agent: { found: count(st.found), reproduced: count(st.reproduced), fixed: count(st.fixed), closed: count(st.closed), open: count(st.open), last: str(j.agent?.last, 40) },
    dashboardUrl: sameOrigin(j.dashboard_url, creds.host),
    /** Free sees the totals only: the plan that shows the problems, its trial and price, and its page */
    problemsPlan: lockOf(j.locked?.problems, creds.host),
    /** the problems fixed live this month against the app's plan: past its limit GenClass observes only */
    usage: liveUsage(j.usage),
    /** the app's plan page (plans per project) */
    planUrl: sameOrigin(j.plan_url, creds.host),
    /** the recorded demo's numbers stand in for measured ones (the server's sample app) */
    demo: j.demo === true,
    // The rest of what the dashboard page reads, for the other views (views.mjs): every total and breakdown by the
    // server's own key, the buckets, the latest events as they are stored, the visits' exit pages and the funnels.
    more: {
      totals: numbers(t),
      breakdowns: Object.fromEntries(
        Object.entries(b)
          .filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && Array.isArray(v))
          .map(([k, v]) => [k, pairs(v, 200)]),
      ),
      distinct: numbers(j.distinct),
      series: (Array.isArray(j.series) ? j.series : []).slice(-400).map((x) => ({ bucket: str(x?.bucket, 24) ?? "", pages: count(x?.sessions), found: count(x?.detections), handled: count(x?.acted), possible: count(x?.possible), checks: count(x?.checks), views: count(x?.ix_views), visits: count(x?.ix_sessions) })),
      events: (Array.isArray(j.recent) ? j.recent : [])
        .filter((x) => x && typeof x === "object")
        .slice(0, 50)
        .map((x) => ({
          at: str(x.t, 40),
          route: str(x.route, 200),
          fn: str(x.fn, 80),
          kind: str(x.diagnosis, 60),
          confidence: Number.isFinite(Number(x.confidence)) && x.confidence !== null ? Math.max(0, Math.min(1, Number(x.confidence))) : null,
          mode: str(x.mode, 20),
          trigger: str(x.trigger, 40),
          /** "detect": reported; "acted": the runtime was allowed to act on it */
          tier: str(x.kind, 20),
          handled: x.acted === 1 || x.acted === true,
          executed: x.executed === 1 || x.executed === true,
          action: str(x.action, 60),
          ran: str(x.ran, 60),
        })),
      exit: lock ? [] : pairs(v.exit, 25),
      funnels: (Array.isArray(j.funnels) ? j.funnels : [])
        .filter((f) => f && typeof f === "object" && Array.isArray(f.steps))
        .slice(0, 5)
        .map((f) => ({ name: str(f.name, 60) ?? "Funnel", steps: f.steps.filter((x) => typeof x === "string").slice(0, 6).map((x) => x.slice(0, 120)), counts: (Array.isArray(f.counts) ? f.counts : []).slice(0, 6).map(count) })),
      /** what the coding agent did with each finding (the MCP server reports it when GENCLASS_REPORT is on) */
      findings: (Array.isArray(j.agent?.findings) ? j.agent.findings : [])
        .filter((x) => x && typeof x === "object")
        .slice(0, 25)
        .map((x) => ({ id: str(x.id, 80), kind: str(x.kind, 60), route: str(x.route, 200), found: str(x.found, 40), reproduced: x.reproduced === true ? true : x.reproduced === false ? false : null, tested: !!x.tested, proven: !!x.proven, closed: x.closed === true, updated: str(x.updated, 40) })),
      agentLog: (Array.isArray(j.agent?.log) ? j.agent.log : [])
        .filter((x) => x && typeof x === "object")
        .slice(0, 50)
        .map((x) => ({ at: str(x.at, 40), step: str(x.t, 20), id: str(x.id, 80), kind: str(x.kind, 60), route: str(x.route, 200), reproduced: x.reproduced === true ? true : x.reproduced === false ? false : null, runs: count(x.runs), races: count(x.races), what: str(x.what, 200) })),
      stages: { found: count(st.found), explained: count(st.explained), reproduced: count(st.reproduced), fixed: count(st.fixed), closed: count(st.closed), open: count(st.open), continued: count(st.continued) },
      previous: numbers(j.previous),
      generated: str(j.generated, 40),
    },
  };
}

/** Every finite number of an object, by its key (keys as the server names them, letters, digits and underscores only). */
function numbers(o) {
  const out = {};
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (/^[A-Za-z0-9_]{1,40}$/.test(k) && Number.isFinite(Number(v)) && v !== null) out[k] = Number(v);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What a terminal approved for it can read and change beyond the dashboard (telemetry-worker/src/cli.ts, the routes
// below CLI_ACCOUNT_FROM). Every answer that is not ok carries what the caller needs to say the next step:
// `reauth` (sign in once more: this sign-in is from before the command could do this), `upgradeUrl` (the plan is
// why), `missing` (this genclass.dev has no such route).

const base = (creds, opts) => ({ token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn });
const refused = (r, host, what) => ({
  ok: false,
  status: r.status,
  reason: typeof r.json?.error === "string" && r.status !== 401 ? r.json.error.slice(0, 300) : failure(r, what),
  // an app the caller names comes from the account's own list, so a bare 404 is a server without the route; a
  // 404 with its own sentence ("slack is not set up for this app") is an answer, and is shown
  ...(r.status === 404 && (typeof r.json?.error !== "string" || r.json.error === "not found") ? { missing: true } : {}),
  ...(r.json?.reauth === true ? { reauth: true } : {}),
  ...(sameOrigin(r.json?.upgrade_url, host) ? { upgradeUrl: sameOrigin(r.json.upgrade_url, host) } : {}),
  // a part of the paid plan: which plan, its trial and price (the Pro box)
  ...(r.json?.locked === true ? { lock: lockOf(r.json, host) } : {}),
  // the genclass command is Pro's: where Pro starts
  ...proOf(r, host),
});
const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
const person = (x) => ({ label: str(x?.email, 120) ?? (str(x?.github_login, 60) ? `@${str(x.github_login, 60)}` : "a GenClass account"), joined: str(x?.joined, 40), active: x?.active !== false });

/** The plan with its limits and what is used, the subscription's state and the team (`genclass plan`, `genclass team`). */
export async function fetchAccount(creds, opts = {}) {
  const r = await request("/api/cli/account", base(creds, opts));
  if (!r.ok) return refused(r, creds.host);
  const j = r.json ?? {};
  const l = j.limits ?? {};
  const u = j.used ?? {};
  const t = j.team ?? {};
  const inc = j.includes ?? {};
  return {
    ok: true,
    plan: { id: str(j.plan?.id, 40) ?? "free", name: str(j.plan?.name, 40) ?? "Free", price: str(j.plan?.price, 60), summary: str(j.plan?.summary, 200) },
    /** why the account has its plan: "paid", "comp" (a grant), "open" (a server with every plan open) or null */
    access: ["paid", "comp", "open"].includes(j.access) ? j.access : null,
    limits: { apps: numOrNull(l.apps), historyDays: numOrNull(l.history_days), seats: numOrNull(l.seats), suggestionsPerDay: numOrNull(l.suggestions_per_day), suggestionsShown: numOrNull(l.suggestions_shown) },
    used: { apps: count(u.apps), suggestionsToday: count(u.suggestions_today), seats: count(u.seats) },
    includes: { analytics: inc.analytics === true, forwarding: inc.forwarding === true, export: inc.export === true, privateRepositories: inc.private_repositories === true },
    subscription: { status: str(j.subscription?.status, 30), periodEnd: str(j.subscription?.current_period_end, 40), cancels: j.subscription?.cancel_at_period_end === true },
    team: {
      seats: numOrNull(t.seats),
      used: count(t.used),
      members: (Array.isArray(t.members) ? t.members : []).slice(0, 200).map(person),
      invites: (Array.isArray(t.invites) ? t.invites : []).slice(0, 200).map((x) => ({ created: str(x?.created, 40), expires: str(x?.expires, 40) })),
      memberships: (Array.isArray(t.memberships) ? t.memberships : []).slice(0, 50).map(person),
    },
    billingUrl: sameOrigin(j.billing_url, creds.host),
    offer: offerOf(j.offer, creds.host),
  };
}

/** A new single-use invite link for the account's team. The link is shown once: the server keeps only its hash. */
export async function createInvite(creds, opts = {}) {
  const r = await request("/api/cli/team/invite", { ...base(creds, opts), method: "POST", body: {} });
  if (!r.ok) return refused(r, creds.host);
  const url = sameOrigin(r.json?.url, creds.host);
  return url ? { ok: true, url, expires: str(r.json?.expires, 40) } : { ok: false, status: r.status, reason: "the server sent no invite link" };
}

/** Where an app's alerts are sent: the destinations set up (settings masked), and whether the plan sends them. */
export async function fetchConnections(creds, id, opts = {}) {
  const r = await request(`/api/cli/connections?id=${encodeURIComponent(id)}`, base(creds, opts));
  if (!r.ok) return refused(r, creds.host);
  const j = r.json ?? {};
  return {
    ok: true,
    forwarding: j.forwarding === true,
    plan: str(j.plan, 40),
    upgradeUrl: sameOrigin(j.upgrade_url, creds.host),
    kinds: (Array.isArray(j.kinds) ? j.kinds : []).filter((k) => typeof k === "string" && /^[a-z]{1,20}$/.test(k)),
    privateLink: j.private_link === true,
    list: (Array.isArray(j.integrations) ? j.integrations : [])
      .filter((x) => x && typeof x === "object" && typeof x.kind === "string")
      .slice(0, 20)
      .map((x) => ({ kind: x.kind.slice(0, 20), enabled: x.enabled === true, summary: summaryText(x.summary), lastSent: str(x.last_sent, 40), lastError: str(x.last_error, 200) })),
  };
}

/** A destination's masked settings as one line ("url https://hooks.slack.com/…XXXX"), whatever shape the server sent. */
function summaryText(v) {
  if (typeof v === "string") return v.slice(0, 160);
  if (!v || typeof v !== "object") return "";
  return Object.entries(v)
    .filter(([, x]) => typeof x === "string" || typeof x === "number")
    .slice(0, 4)
    .map(([k, x]) => `${k} ${String(x).slice(0, 80)}`)
    .join(", ");
}

/**
 * One change to a destination. `how`: "set" (fields: its settings), "on", "off", "test" or "remove". A webhook's
 * signing secret comes back once, when it is new (`secret`).
 */
export async function changeConnection(creds, id, kind, how, fields = {}, opts = {}) {
  const q = `?id=${encodeURIComponent(id)}`;
  const path = `/api/cli/connections/${encodeURIComponent(kind)}`;
  const call = { set: [path, "PUT", fields], on: [path, "PATCH", { enabled: true }], off: [path, "PATCH", { enabled: false }], test: [`${path}/test`, "POST", {}], remove: [path, "DELETE", undefined] }[how];
  if (!call) return { ok: false, status: 0, reason: `unknown change ${how}` };
  const r = await request(`${call[0]}${q}`, { ...base(creds, opts), method: call[1], ...(call[2] !== undefined ? { body: call[2] } : {}), timeoutMs: how === "test" ? 30_000 : undefined });
  if (!r.ok) return refused(r, creds.host);
  return { ok: true, summary: summaryText(r.json?.summary), secret: str(r.json?.secret, 200) };
}

/**
 * One page of an app's stored events, as text (JSON Lines or CSV): what the collector kept, batch by batch. `next`
 * is the cursor of the page after it, null on the last one.
 * @param {{ from?: string, to?: string, format?: "jsonl" | "csv", cursor?: string | null }} q
 */
export async function fetchEvents(creds, id, q = {}, opts = {}) {
  const p = new URLSearchParams({ id, format: q.format === "csv" ? "csv" : "jsonl" });
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.cursor) p.set("cursor", q.cursor);
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  try {
    const res = await fetchFn(`${creds.host}/api/cli/events?${p}`, { headers: { authorization: `Bearer ${creds.access_token}`, accept: "*/*" }, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
    if (!res.ok) {
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* not JSON */
      }
      return refused({ status: res.status, json }, creds.host);
    }
    return { ok: true, text: await res.text(), next: res.headers.get("x-genclass-next-cursor") || null };
  } catch (e) {
    return { ok: false, status: 0, reason: e?.name === "TimeoutError" ? "no answer within 60 s" : `network error (${e?.cause?.code ?? e?.message ?? e})` };
  }
}

/** Saves an app's funnels, whole: [{ name, steps: [page, ...] }]. The server answers the list as it kept it. */
export async function saveFunnels(creds, id, funnels, opts = {}) {
  const r = await request(`/api/cli/funnels?id=${encodeURIComponent(id)}`, { ...base(creds, opts), method: "PUT", body: { funnels } });
  if (!r.ok) return refused(r, creds.host);
  return { ok: true, funnels: (Array.isArray(r.json?.funnels) ? r.json.funnels : []).map((f) => ({ name: str(f?.name, 60) ?? "Funnel", steps: (Array.isArray(f?.steps) ? f.steps : []).filter((x) => typeof x === "string") })) };
}

/** A new private dashboard link for an app (it replaces any earlier one). Shown once: the server keeps only its hash. */
export async function makeAgentLink(creds, id, opts = {}) {
  const r = await request(`/api/cli/link?id=${encodeURIComponent(id)}`, { ...base(creds, opts), method: "POST", body: {} });
  if (!r.ok) return refused(r, creds.host);
  const url = sameOrigin(r.json?.dashboardUrl, creds.host);
  return url && /\/dashboard\/[A-Za-z0-9]{32}$/.test(url) ? { ok: true, url } : { ok: false, status: r.status, reason: "the server sent no link" };
}

/**
 * A question about an app, answered by genclass.dev's model from the app's dashboard numbers. `answer` is null
 * with `why` when there is none: "no-model" (this server has none), "limit" (the day's runs are used) or "failed".
 * @param {{ id: string, range?: string, question: string, history?: { q: string, a: string }[] }} q
 */
export async function askModel(creds, q, opts = {}) {
  const r = await request("/api/cli/ask", { ...base(creds, opts), method: "POST", body: { id: q.id, range: q.range ?? "7d", question: q.question, history: (q.history ?? []).slice(-3) }, timeoutMs: opts.timeoutMs ?? 60_000 });
  if (!r.ok) return refused(r, creds.host);
  const j = r.json ?? {};
  return {
    ok: true,
    answer: typeof j.answer === "string" && j.answer.trim() ? j.answer.slice(0, 3000) : null,
    why: ["no-model", "limit", "failed"].includes(j.why) ? j.why : null,
    range: str(j.range, 8),
    remainingToday: numOrNull(j.remaining_today),
    perDay: numOrNull(j.per_day),
    upgradeUrl: sameOrigin(j.upgrade_url, creds.host),
  };
}
