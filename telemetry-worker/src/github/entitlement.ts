// Which repositories genclass-dev[bot] reviews: every public repository, free; a private one only for an installation
// with a plan that includes private repositories.
//
// Invariants:
// - A public repository is always reviewed, whatever the installation's account or plan. Nothing here can turn that
//   off, so "free for public and open-source repositories" cannot be broken by a billing bug.
// - A private repository is reviewed when one of these holds: the server runs with GITHUB_APP_PRIVATE_REPOS=open (a
//   beta, or a self-hosted collector); the GenClass account managing the installation has a plan with the
//   `github_private` entitlement (billing/plans.json; src/plans.ts accountAccess, so a grant counts); or the GitHub
//   account bought a paid plan, or is in a paid plan's free trial, on GitHub Marketplace (github_marketplace).
// - A private repository that is not entitled is not read at all: no file list, no artifacts, no settings file. Its
//   pull requests get one neutral check that says why, and no comment.
// - Visibility comes from GitHub's signed webhook payload or API answer for that request, never from a stored value.

import type { Env } from "../collector.js";
import type { D1Like } from "../dashboard.js";
import { accountAccess, entitled } from "../plans.js";
import type { GithubAppConfig } from "./config.js";
import { marketplaceOf, type Installation } from "./store.js";

export type Entitled = { ok: true; why: "public" | "open" | "plan" | "marketplace" } | { ok: false };

/** Whether reviews run for this repository of this installation now. */
export async function repoEntitled(db: D1Like, env: Env, cfg: GithubAppConfig, inst: Pick<Installation, "owner" | "account_id">, repo: { private: boolean }, now: Date): Promise<Entitled> {
  if (!repo.private) return { ok: true, why: "public" };
  if (cfg.privateRepos === "open") return { ok: true, why: "open" };
  if (inst.owner) {
    const access = await accountAccess(db, inst.owner, env, now);
    if (entitled(access.plan, "github_private")) return { ok: true, why: "plan" };
  }
  const m = await marketplaceOf(db, inst.account_id);
  if (m) {
    const trial = m.free_trial_ends ? Date.parse(m.free_trial_ends) > now.getTime() : false;
    if (m.monthly_cents > 0 || trial) return { ok: true, why: "marketplace" };
  }
  return { ok: false };
}
