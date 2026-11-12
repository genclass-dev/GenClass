// What the `genclass` command asks genclass.dev beyond the runtime CLI's own calls (packages/runtime/bin/lib/account.mjs):
// the account's overview (plan, apps, limits), what the GitHub App is doing on this repository, and the suggestions
// plan. The request and answer shapes are the collector's (telemetry-worker/src/cli.ts).
//
// Invariants:
// - Every call carries the CLI session saved by `genclass login` and goes to the host that session was made for.
// - None of them rejects: each resolves { ok: true, ... } or { ok: false, reason, status?, missing? }. `missing` is
//   true when the server has no such route (an older or self-hosted collector): the caller then says what it cannot
//   check instead of failing.
// - Text from the server is data. Whoever prints it passes it through tui.mjs clean() first.

import { cleanProject, failure, request } from "../../runtime/bin/lib/account.mjs";

const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
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
  const projects = (Array.isArray(j.projects) ? j.projects : []).map((p) => cleanProject(p, creds.host)).filter(Boolean);
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
  if (!r.ok) return { ok: false, status: r.status, reason: failure(r), ...(r.status === 404 ? { missing: true } : {}) };
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
  const r = await request("/api/cli/suggest", { method: "POST", token: creds.access_token, host: creds.host, body: digest, fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs ?? 45_000 });
  if (!r.ok) return { ok: false, status: r.status, reason: failure(r), ...(r.status === 404 ? { missing: true } : {}) };
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
  };
}
