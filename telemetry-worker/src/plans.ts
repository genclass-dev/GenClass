// Plans and what they allow: limits (apps, dashboard history), entitlements (dashboard, forwarding, export, analytics,
// custom_model), what an account may use now (a paid plan, GenClass's own grant, or Free), the dashboard ranges a plan
// shows, and the plan-aware retention sweep.
//
// - The plans live in billing/plans.json at the repo root (genclass.dev's pricing page reads the same file). Change a
//   price, a limit or an entitlement there, not here. Every check below reads the plan's entitlements and limits, so
//   nothing here names a plan but Free and the grant's (plans.json grant_plan).
// - Since plans.json version 3 (2026-11-11) there are three plans. Free is what finds, shows and fixes the problems: the
//   dashboard's problems for one person, 3 apps and the last 7 days shown. Team (US$15 a month per seat, sold on Stripe
//   Checkout) adds visitor analytics, forwarding, export, 90 days shown, private repositories for the GitHub App and
//   members (src/team.ts). Enterprise (by agreement) adds the classifier a person trains (custom_model) and a year.
//   Individual, US$29 a month, ended on 2026-10-22: a stored "individual" reads as Free, while its Stripe prices stay
//   GenClass's (ownedPrice, plans.json retired_plans). Every plan includes the dashboard; the locked paths
//   (hasDashboard false) are kept for a plan file that leaves it out, and the tests run them on a fixture
//   (test/fixtures/plans-two-paid.json). Team has a 3-day trial on an account's first subscription (trial_days).
// - Seats. A per_seat plan is paid per person: the subscription's quantity (accounts.seats, written by src/stripe.ts)
//   is how many people the account holds, its owner included. A plan that is not per_seat holds limits.seats people
//   (Free: 1; null: no limit), and a plan GenClass grants has no seat count, so no limit. seatsOf says it.
// - PLAN_GATES = "open" (a self-hosted collector, wrangler.selfhost.toml): every account has the grant plan, so
//   nothing is locked on a server that sells nothing (planGatesOpen, source "open").
// - A plan comes from accounts.plan, which src/stripe.ts derives from the Stripe subscription. Entitlements follow the
//   plan whatever the server's configuration, except that a plan bought in Stripe's test mode counts only while the
//   key is a test key (inMode): a test purchase never carries over to live. A live plan always counts.
// - A plan with a null monthly price (Enterprise) is not sold on the site: it is agreed by email, and an account gets
//   it from GenClass's own grant (accounts.comp_until, set by hand to the end of the agreement), which gives the plan
//   accounts.comp_plan names (plans.json grant_plan when it is empty or unknown). When an account has both a paid plan
//   and a grant, the plan listed later in plans.json applies (accessOf).
// - A price names a plan only when it is provably GenClass's: a lookup key starting with genclass_ AND a product whose
//   metadata genclass_plan names a paid plan (planForPrice). GenClass now has a Stripe account of its own; this rule
//   is kept from when it shared a Stripe account with another business, as a defence in depth.
// - A plan whose payment is overdue ends here, whatever the Stripe account's retry settings: past_due keeps the plan
//   for PAST_DUE_GRACE_DAYS (14) after GenClass first saw it past due, then it is Free (the webhook, and the daily
//   sweep below); unpaid is Free at once.
// - The Free plan's app limit (3; the caller's abuse cap still applies) applies to every account without a plan or
//   grant, whatever the Stripe key: no more apps are created past it, and the apps an account already has stay. Ingest
//   collects for every app whatever its plan, visitor analytics included: a plan decides what is shown (stripAnalytics
//   in src/dashboard.ts), never what is counted, so an upgrade shows what was counted before it. With a test key only the
//   accounts in STRIPE_TEST_ACCOUNTS can buy (canBuy).
// - limits.history_days is what the dashboard shows (viewRanges), not what is kept. Retention never deletes data newer
//   than the plan allows, and never shortens what existing projects had: daily
//   counters, recent rows and stored batches are kept RETENTION_DAYS (90) for every project, and longer for the apps
//   of accounts on a plan with more history or a grant (and for GRACE_DAYS after a paid plan ends, so a lapsed card
//   does not cost a year of data at once).

import PLANS_JSON from "../../billing/plans.json";
import type { Env } from "./collector.js";
import { retention, RETENTION_DAYS, type D1Like, type Range } from "./dashboard.js";
import { exportSweep, type BucketOps } from "./export.js";

const DAY = 86_400_000;
export const GRACE_DAYS = 30;

export type PlanId = "free" | "team" | "enterprise";
/**
 * `github_private`: genclass-dev[bot] reviews the account's private repositories (src/github/entitlement.ts); public
 * ones are free for everyone. `problems` (2026-11-12): the problem lists, the pages they happen on, the activity and
 * the fix prompts, on the dashboard and in the genclass command (Free shows the totals only); `ask`: genclass ask. A
 * plan file without `problems` or `ask` gives them (hasProblems, hasAsk).
 */
export type Entitlement = "dashboard" | "forwarding" | "export" | "analytics" | "custom_model" | "github_private" | "problems" | "ask";

export interface Plan {
  id: PlanId;
  name: string;
  summary: string;
  /** US cents; monthly null: not sold on the site, agreed by email (byAgreement). */
  price_usd_cents: { monthly: number | null; yearly: number | null };
  stripe_lookup_keys: { monthly: string | null; yearly: string | null };
  /** The Stripe product tax code scripts/stripe-setup.mjs sets on the plan's product (null for Free). */
  stripe_tax_code: string | null;
  /** Sold through Stripe Managed Payments (src/stripe.ts managedPayments): none today. */
  managed_payments: boolean;
  /** Sold per person: the monthly price is for one seat, and the subscription's quantity is the seats (seatsOf). */
  per_seat?: boolean;
  /** Sold per project (version 4): one subscription of quantity 1 for each app, its metadata naming the app. */
  per_project?: boolean;
  /** Days free at Checkout before the first payment (Pro: 3), once per account; left out: no trial. */
  trial_days?: number;
  /**
   * Version 5: the apps one unit of the subscription covers (Pro: 3). The quantity is the units (accounts.seats), so
   * the account's first apps_per_unit x quantity apps have the plan; a later one waits for more (coverage).
   */
  apps_per_unit?: number;
  /**
   * `seats`: the people a plan that is not per_seat holds, the owner included (null or left out: no limit). `apps`
   * on Free: how many of an account's projects it covers (a later one is locked until it has a plan).
   * `live_fixes_per_month`: what the runtime may fix on visitors' screens a month for one project (interventions and
   * visual fixes); past it the runtime is told to observe only until the month ends (null or left out: no limit).
   */
  limits: { apps: number | null; history_days: number; seats?: number | null; live_fixes_per_month?: number | null };
  /**
   * `genclass suggest` (src/suggest.ts): `per_day`, model runs an account has a day; `shown`, how many items of the
   * plan it is shown (null: all). Left out: 3 and 3.
   */
  suggestions?: { per_day: number; shown: number | null };
  /** A key a plan leaves out counts as false (entitled). */
  entitlements: Partial<Record<Entitlement, boolean>> & Record<Exclude<Entitlement, "github_private" | "problems" | "ask">, boolean>;
  features: { text: string; available: boolean }[];
}

export interface PlansFile {
  version: number;
  currency: string;
  contact: string;
  /** The plan GenClass's own grant (accounts.comp_until) gives. */
  grant_plan: PlanId;
  /** Plan ids GenClass sold before: their Stripe prices stay GenClass's (ownedPrice) but give no plan. */
  retired_plans?: string[];
  footer: string;
  plans: Plan[];
}

export const PLANS_FILE = PLANS_JSON as unknown as PlansFile;
export const PLANS: Plan[] = PLANS_FILE.plans;
export const FREE: Plan = PLANS.find((p) => p.id === "free")!;
/** The plan GenClass's own grant gives (plans.json grant_plan: Enterprise). */
export const GRANT_PLAN: Plan = PLANS.find((p) => p.id === PLANS_FILE.grant_plan) ?? FREE;
/** The plans sold on Stripe Checkout: a monthly price above 0. */
export const PAID_PLANS: Plan[] = PLANS.filter((p) => (p.price_usd_cents.monthly ?? 0) > 0);
/** A plan agreed by email, not sold on the site (a null monthly price: Enterprise). */
export const byAgreement = (plan: Plan): boolean => plan.price_usd_cents.monthly === null;

export function planById(id: unknown): Plan {
  return PLANS.find((p) => p.id === id) ?? FREE;
}

/** Plan ids GenClass sold before (plans.json retired_plans; Individual until 2026-10-22). */
export const RETIRED_PLAN_IDS: readonly string[] = Array.isArray(PLANS_FILE.retired_plans) ? PLANS_FILE.retired_plans : [];

/** Every GenClass lookup key starts with this: plans.json's, and those of prices scripts/stripe-setup.mjs retired. */
export const LOOKUP_PREFIX = "genclass_";

/** The plan a lookup_key from billing/plans.json sells (monthly or yearly), or null for any other key. */
export function planByLookupKey(key: unknown): Plan | null {
  if (typeof key !== "string" || !key) return null;
  return PLANS.find((p) => p.stripe_lookup_keys.monthly === key || p.stripe_lookup_keys.yearly === key) ?? null;
}

/** The paid plan named by a Stripe product's (or price's) metadata.genclass_plan (scripts/stripe-setup.mjs sets it). */
export function planByMetadata(meta: unknown): Plan | null {
  const id = meta && typeof meta === "object" ? (meta as Record<string, unknown>).genclass_plan : null;
  return PAID_PLANS.find((p) => p.id === id) ?? null;
}

/**
 * The plan a Stripe price sells, or null when the price is not provably GenClass's. Both must hold (a rule from when
 * the Stripe account was shared, kept as a defence): the price's lookup_key starts with genclass_, and its product
 * (expanded) carries metadata genclass_plan naming a paid plan; the plan is the product's. A price the setup script replaced keeps its
 * product and gets a genclass_..._retired_<id> lookup key, so its subscribers keep their plan. A lookup key from
 * plans.json that names another plan than the product does is refused as inconsistent.
 */
export function planForPrice(price: unknown): Plan | null {
  if (!price || typeof price !== "object") return null;
  const p = price as Record<string, unknown>;
  if (typeof p.lookup_key !== "string" || !p.lookup_key.startsWith(LOOKUP_PREFIX)) return null;
  const product = p.product && typeof p.product === "object" ? (p.product as Record<string, unknown>) : null;
  const plan = planByMetadata(product?.metadata);
  if (!plan) return null;
  const named = planByLookupKey(p.lookup_key);
  return named && named.id !== plan.id ? null : plan;
}

/**
 * The Stripe price is provably GenClass's, whether or not it gives a plan now: planForPrice's rule, with a product whose
 * genclass_plan names a plan sold now or one GenClass sold before (RETIRED_PLAN_IDS). Ownership only: a subscription to a
 * retired plan is cancelled with its account, opens the Billing Portal and reaches the owner, but counts as Free.
 */
export function ownedPrice(price: unknown): boolean {
  if (planForPrice(price)) return true;
  if (!price || typeof price !== "object") return false;
  const p = price as Record<string, unknown>;
  if (typeof p.lookup_key !== "string" || !p.lookup_key.startsWith(LOOKUP_PREFIX) || planByLookupKey(p.lookup_key)) return false;
  const product = p.product && typeof p.product === "object" ? (p.product as Record<string, unknown>) : null;
  const meta = product?.metadata && typeof product.metadata === "object" ? (product.metadata as Record<string, unknown>) : null;
  return typeof meta?.genclass_plan === "string" && RETIRED_PLAN_IDS.includes(meta.genclass_plan);
}

export const entitled = (plan: Plan, e: Entitlement): boolean => plan.entitlements[e] === true;

export type StripeMode = "test" | "live";

/** The mode of STRIPE_SECRET_KEY (sk_ or rk_, live_ or test_), or null when it is unset or not a Stripe key. */
export function stripeMode(env: Env): StripeMode | null {
  const k = (env.STRIPE_SECRET_KEY ?? "").trim();
  return /^[sr]k_live_/.test(k) ? "live" : /^[sr]k_test_/.test(k) ? "test" : null;
}

/** Paid plans are on sale to everyone (a live key). */
export const billingLive = (env: Env): boolean => stripeMode(env) === "live";

/**
 * This account can buy a plan: any account with a live key; with a test key only the accounts listed in
 * STRIPE_TEST_ACCOUNTS (emails or account ids), so a test pass on the production worker sells nothing to anyone else.
 */
export function canBuy(env: Env, account: { id: string; email: string | null }): boolean {
  const mode = stripeMode(env);
  if (mode === "live") return true;
  if (mode !== "test") return false;
  const list = (env.STRIPE_TEST_ACCOUNTS ?? "").split(/[\s,]+/).filter(Boolean);
  const email = account.email?.toLowerCase();
  return list.some((x) => x === account.id || (!!email && x.toLowerCase() === email));
}

/** "$29 / month", "$15 / developer / month" (a per_seat plan), "$0", or "By agreement" for a plan agreed by email. */
export function priceText(plan: Plan): string {
  const c = plan.price_usd_cents.monthly;
  if (c === null) return "By agreement";
  if (!c) return "$0";
  return `$${c % 100 ? (c / 100).toFixed(2) : String(c / 100)}${plan.per_project === true ? " / project" : plan.per_seat === true ? " / developer" : ""} / month${plan.apps_per_unit ? ` for ${plan.apps_per_unit} apps` : ""}`;
}

/** The most seats one Checkout sells and one account holds on a per_seat plan; a larger team is agreed by email. */
export const MAX_SEATS = 200;

/** A seat count as asked for (Checkout) or as Stripe reports it (a subscription item's quantity): 1 to MAX_SEATS. */
export function cleanSeats(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_SEATS ? v : null;
}

/** PLAN_GATES = "open": this server gives every account the grant plan (a self-hosted collector). */
export const planGatesOpen = (env: Pick<Env, "PLAN_GATES">): boolean => /^open$/i.test((env.PLAN_GATES ?? "").trim());

// --------------------------------------------------------------------------------------------- an account's plan

/** Subscription statuses that keep a paid plan (past_due: for PAST_DUE_GRACE_DAYS, while Stripe retries the card). */
export const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** How long a past_due subscription keeps its plan, counted from when GenClass first saw it past due. */
export const PAST_DUE_GRACE_DAYS = 14;

/** A past_due subscription seen past due since `since` (ISO) has used up its grace at `now`. */
export const pastDueLapsed = (since: string | null | undefined, now: Date): boolean => {
  const t = since ? Date.parse(since) : NaN;
  return Number.isFinite(t) && now.getTime() - t > PAST_DUE_GRACE_DAYS * DAY;
};

export interface Billing {
  plan: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  /** The Stripe mode the ids belong to ('test' or 'live'), null when there are none. */
  stripe_mode: string | null;
}

const NO_BILLING: Billing = { plan: "free", stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, cancel_at_period_end: 0, stripe_mode: null };

/** The SQL test for "this account's plan counts under the current key" (`?` binds the key's mode, or ''). */
export const MODE_OK_SQL = "(a.stripe_mode IS NULL OR a.stripe_mode <> 'test' OR ? = 'test')";

/** A plan recorded in this Stripe mode counts under a key of `mode`: test-mode records only under a test key. */
export const modeCounts = (recorded: string | null | undefined, mode: StripeMode | null): boolean => recorded !== "test" || mode === "test";

/**
 * The billing as the current Stripe key sees it: ids and a plan bought in test mode count as none unless the key is a
 * test key (a test purchase after the key went live). Live records always count, so changing or removing the key
 * never downgrades someone Stripe still charges.
 */
export function inMode(b: Billing, env: Env): Billing {
  return modeCounts(b.stripe_mode, stripeMode(env)) ? b : NO_BILLING;
}

/** The account's billing row; with `env`, as the current Stripe key sees it (inMode). Without, as stored. */
export async function accountBilling(db: D1Like, accountId: string, env?: Env): Promise<Billing> {
  const row = await db
    .prepare("SELECT plan, stripe_customer_id, subscription_id, subscription_status, current_period_end, cancel_at_period_end, stripe_mode FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<Billing>();
  if (!row) return NO_BILLING;
  return env ? inMode(row, env) : row;
}

// --------------------------------------------------------------------------------------------- access: plan, grant

/** Why an account has a plan's entitlements now: a subscription, GenClass's own grant (comp_until), or PLAN_GATES open. */
export type AccessSource = "paid" | "comp" | "open";

export interface Access {
  /** The plan whose entitlements apply now: the paid plan or the grant's (accessOf), else Free. */
  plan: Plan;
  /** Why; null on Free. */
  source: AccessSource | null;
  /** How many people the account holds now, its owner included (seatsOf); null: no limit. */
  seats: number | null;
  /**
   * An app past the ones its account's plan covers (coverage): on Free past Free's apps, or on Pro past 3 x the units
   * paid for. No dashboard until the account's plan covers it.
   */
  locked?: "free_projects" | "pro_apps";
  /** How many apps the account's plan covers (coverage); null: no limit. */
  apps?: number | null;
}

/** The columns accountAccess reads (accounts, migrations 0004, 0006 and 0014). */
export interface AccessRow {
  plan: string | null;
  stripe_mode: string | null;
  comp_until: string | null;
  /** The plan GenClass's grant gives (migration 0014); empty or unknown: plans.json grant_plan. */
  comp_plan?: string | null;
  /** The paid seats of a per_seat plan: the subscription's quantity (migration 0014, src/stripe.ts). */
  seats?: number | null;
}

export const ACCESS_COLUMNS = "plan, stripe_mode, comp_until, comp_plan, seats";
export const NO_ACCESS: Access = { plan: FREE, source: null, seats: FREE.limits.seats ?? null };
/** What every account has on a server with PLAN_GATES open. */
export const OPEN_ACCESS: Access = { plan: GRANT_PLAN, source: "open", seats: null };

/**
 * How many people an account on `plan` holds, its owner included (null: no limit). A paid per_seat plan: the seats
 * paid for, at least 1. Any other plan, and every grant: the plan's own limits.seats (a grant of a per_seat plan has
 * no seat count, so no limit).
 */
export function seatsOf(plan: Plan, source: AccessSource | null, paidSeats: number | null | undefined): number | null {
  if (plan.per_seat === true) return source === "paid" ? Math.max(1, cleanSeats(paidSeats) ?? 1) : null;
  return plan.limits.seats ?? null;
}

/** The plan a grant gives: the one accounts.comp_plan names when it is a plan above Free, else plans.json grant_plan. */
export function grantPlan(compPlan: string | null | undefined): Plan {
  const p = compPlan ? PLANS.find((x) => x.id === compPlan) : undefined;
  return p && p.id !== "free" ? p : GRANT_PLAN;
}

const future = (iso: string | null | undefined, now: Date): boolean => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t > now.getTime();
};

/** Where a plan is listed in plans.json: the later, the more it includes. */
const rank = (plan: Plan): number => PLANS.indexOf(plan);

/**
 * What an account may use at `now`: its paid plan (as the current Stripe key sees it, modeCounts) or GenClass's own
 * grant while comp_until is in the future (grantPlan), whichever is listed later in plans.json (the paid plan when
 * they are the same); otherwise Free. A null row (no account) is Free. With `open` (planGatesOpen), every account and
 * every app without one has the grant plan.
 */
export function accessOf(row: AccessRow | null | undefined, mode: StripeMode | null, now: Date, open = false): Access {
  if (open) return OPEN_ACCESS;
  if (!row) return NO_ACCESS;
  const paid = modeCounts(row.stripe_mode, mode) ? planById(row.plan) : FREE;
  const comp = future(row.comp_until, now);
  const grant = grantPlan(row.comp_plan);
  if (paid.id !== "free" && (!comp || rank(paid) >= rank(grant))) return { plan: paid, source: "paid", seats: seatsOf(paid, "paid", row.seats) };
  if (comp) return { plan: grant, source: "comp", seats: seatsOf(grant, "comp", null) };
  return NO_ACCESS;
}

/** The better of two accesses: the plan listed later in plans.json, a paid one before a grant of the same plan. */
export function better(a: Access, b: Access): Access {
  if (rank(b.plan) !== rank(a.plan)) return rank(b.plan) > rank(a.plan) ? b : a;
  return a.source === "paid" || b.source !== "paid" ? a : b;
}

/** The columns a project's own plan is read from (migration 0016). */
export const PROJECT_PLAN_COLUMNS = "id, token, created, plan, stripe_mode, comp_until, comp_plan";
export interface ProjectPlanRow {
  id: string | null;
  token: string;
  created: string;
  plan: string | null;
  stripe_mode: string | null;
  comp_until: string | null;
  comp_plan: string | null;
}

/**
 * What an account gives every one of its apps: a subscription of the whole account from before plans were per
 * project, and GenClass's grant of a plan that is not sold per project (Enterprise, agreed by email). A grant of a
 * plan sold per project (Team) covers only the apps it was copied to (migration 0016: the owner's choice, "every
 * project they have").
 */
export function accountWide(row: AccessRow | null | undefined, mode: StripeMode | null, now: Date): Access {
  if (!row) return NO_ACCESS;
  return accessOf(grantPlan(row.comp_plan).per_project === true ? { ...row, comp_until: null } : row, mode, now);
}

/** A project's own access: its paid plan (as the current Stripe key sees it) or its grant (accessOf), else Free. */
export const projectOwnAccess = (r: ProjectPlanRow, mode: StripeMode | null, now: Date): Access =>
  accessOf({ plan: r.plan, stripe_mode: r.stripe_mode, comp_until: r.comp_until, comp_plan: r.comp_plan, seats: null }, mode, now);

/**
 * What an account may use for itself (suggestions a day, its team, export keys) at `now`: the best of its own paid
 * plan or grant (accessOf; from before plans were per project) and every one of its projects' (projectOwnAccess).
 */
export async function accountAccess(db: D1Like, accountId: string, env: Env, now: Date): Promise<Access> {
  if (planGatesOpen(env)) return OPEN_ACCESS;
  const mode = stripeMode(env);
  const row = await db.prepare(`SELECT ${ACCESS_COLUMNS} FROM accounts WHERE id = ?`).bind(accountId).first<AccessRow>();
  let best = accessOf(row, mode, now);
  const r = await db.prepare(`SELECT ${PROJECT_PLAN_COLUMNS} FROM projects WHERE account_id = ?`).bind(accountId).all<ProjectPlanRow>();
  for (const p of r.results ?? []) best = better(best, projectOwnAccess(p, mode, now));
  return best;
}

/** The account's plan for its entitlements at `now`: the paid plan or the grant's, else Free. */
export async function accountPlan(db: D1Like, accountId: string, env: Env, now: Date): Promise<Plan> {
  return (await accountAccess(db, accountId, env, now)).plan;
}

/** This access opens dashboards (every plan in billing/plans.json today), unless the project waits for a plan. */
export const hasDashboard = (a: Access): boolean => entitled(a.plan, "dashboard") && !a.locked;
/** A plan sold by quantity: seats (per_seat) or units of apps (apps_per_unit). */
export const byQuantity = (plan: Plan): boolean => plan.per_seat === true || (Number.isInteger(plan.apps_per_unit) && plan.apps_per_unit! > 0);

/** This access shows visitor analytics (Team and Enterprise); without it the stats are served with them left out. */
export const hasAnalytics = (a: Access): boolean => entitled(a.plan, "analytics");
/** The problem lists, pages, activity and fix prompts (not only the totals); a plan file without the key gives them. */
export const hasProblems = (a: Access): boolean => a.plan.entitlements.problems !== false;
/** genclass ask; a plan file without the key gives it. */
export const hasAsk = (a: Access): boolean => a.plan.entitlements.ask !== false;
/** What a stats answer says when the problems are left out: the plan that shows them, its trial, and where to start it. */
export const problemsLock = (upgradeUrl: string): { plan: string | null; upgrade_url: string; trial_days: number | null; price: string | null } => {
  const p = firstPaidWith("problems");
  return { plan: p?.name ?? null, upgrade_url: upgradeUrl, trial_days: p?.trial_days ?? null, price: p ? priceText(p) : null };
};
/** The first plan on sale with an entitlement a plan file can leave out (problems, ask): for "comes with Pro". */
export const firstPaidWith = (e: "problems" | "ask"): Plan | null => PAID_PLANS.find((p) => p.entitlements[e] !== false) ?? null;

/** What an account's plan covers: its access, how many of its apps (null: all) and its apps, oldest first. */
export interface Coverage {
  access: Access;
  cap: number | null;
  rows: ProjectPlanRow[];
  /** The tokens of the apps with a subscription of their own (bought per project under version 4): always covered. */
  ownPaid?: Set<string>;
}

/**
 * The account's plan and how many apps it covers (billing/plans.json version 5): the best of its own subscription or
 * grant and every app's (a subscription bought per project under version 4, a grant copied to an app). A paid plan
 * sold by units (apps_per_unit) covers apps_per_unit x the units: the account's quantity (accounts.seats) plus one for
 * each app's own subscription. A grant covers every app, Free its limits.apps.
 */
export async function coverage(db: D1Like, accountId: string, mode: StripeMode | null, now: Date): Promise<Coverage> {
  const acct = await db.prepare(`SELECT ${ACCESS_COLUMNS} FROM accounts WHERE id = ?`).bind(accountId).first<AccessRow>();
  const rows = (await db.prepare(`SELECT ${PROJECT_PLAN_COLUMNS} FROM projects WHERE account_id = ? ORDER BY created, rowid`).bind(accountId).all<ProjectPlanRow>()).results ?? [];
  let best = accessOf(acct, mode, now);
  let units = best.source === "paid" ? Math.max(1, cleanSeats(acct?.seats) ?? 1) : 0;
  const ownPaid = new Set<string>();
  for (const r of rows) {
    const own = projectOwnAccess(r, mode, now);
    if (own.source === "paid") {
      units++;
      ownPaid.add(r.token);
    }
    best = better(best, own);
  }
  const per = best.plan.apps_per_unit;
  const cap = best.source === "comp" || best.source === "open" ? null : best.source === "paid" ? (per ? per * Math.max(1, units) : (best.plan.limits.apps ?? null)) : (FREE.limits.apps ?? null);
  return { access: { ...best, apps: cap }, cap, rows, ownPaid };
}

/** One app's access under its account's coverage: the plan when the app is among the first `cap`, else locked. */
export function accessIn(cov: Coverage, project: { token?: string; id?: string | null }): Access {
  const i = cov.rows.findIndex((r) => (project.token ? r.token === project.token : r.id === project.id));
  if (i < 0 || cov.cap === null || i < cov.cap) return cov.access;
  // an app still paying for itself (a version 4 subscription) is never locked, wherever it is in the list
  if (cov.ownPaid?.has(cov.rows[i]!.token)) return cov.access;
  return { ...NO_ACCESS, apps: cov.cap, locked: cov.access.source === null ? "free_projects" : "pro_apps" };
}

/**
 * Every app of an account with its access (projectAccess's rule, in one pass): its own plan or grant, its account's
 * subscription from before plans were per project, and the lock on a project past the ones Free covers. In the
 * order the apps were created.
 */
export async function accountProjectsAccess(db: D1Like, accountId: string, env: Env, now: Date): Promise<{ row: ProjectPlanRow; access: Access }[]> {
  if (planGatesOpen(env)) {
    const rows = (await db.prepare(`SELECT ${PROJECT_PLAN_COLUMNS} FROM projects WHERE account_id = ? AND id IS NOT NULL ORDER BY created, rowid`).bind(accountId).all<ProjectPlanRow>()).results ?? [];
    return rows.map((row) => ({ row, access: OPEN_ACCESS }));
  }
  const cov = await coverage(db, accountId, stripeMode(env), now);
  return cov.rows.filter((row) => row.id).map((row) => ({ row, access: accessIn(cov, row) }));
}

/** The access behind an app: its account's plan when the plan covers it (coverage), Free's for an app with no account. */
export async function projectAccess(db: D1Like, project: { account_id?: string | null; token?: string; id?: string | null }, env: Env, now: Date): Promise<Access> {
  if (planGatesOpen(env)) return OPEN_ACCESS;
  if (!project.account_id) return NO_ACCESS;
  return accessIn(await coverage(db, project.account_id, stripeMode(env), now), project);
}

/** The first plan in plans.json that includes `e` (the plan an upgrade message names), or null. */
export const firstPlanWith = (e: Entitlement): Plan | null => PLANS.find((p) => entitled(p, e)) ?? null;

// --------------------------------------------------------------------------------------------- apps

export interface AppLimit {
  plan: Plan;
  /** The most apps this account may hold under its plan, or null when the plan sets no limit. */
  max: number | null;
}

/**
 * The app limit of the plan whose entitlements apply now (null: none; the caller's abuse cap still applies). Free's
 * limit applies to every account without a plan or grant, whatever the Stripe key.
 */
export async function appLimit(db: D1Like, env: Env, accountId: string, now: Date): Promise<AppLimit> {
  const plan = await accountPlan(db, accountId, env, now);
  return { plan, max: plan.limits.apps };
}

/** The 409 for an account at its plan's app limit: says the limit and where to go, for the page and the CLI. */
export function appLimitBody(lim: AppLimit, origin: string): { ok: false; error: string; upgrade_url: string } {
  const url = `${origin}/account/billing`;
  return {
    ok: false,
    error: `the ${lim.plan.name} plan holds ${lim.max} app${lim.max === 1 ? "" : "s"}; see the plans at ${url}`,
    upgrade_url: url,
  };
}

// --------------------------------------------------------------------------------------------- dashboard history

/** Dashboard ranges an owned app can show, shortest first, with the days each one reaches back. */
export const ACCOUNT_RANGES: Range[] = ["24h", "7d", "30d", "90d", "1y"];
export const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
/** The ranges this plan's dashboard shows (by its history_days: Free 7 days, Team 90, Enterprise a year). */
export function viewRanges(plan: Plan): Range[] {
  const out = ACCOUNT_RANGES.filter((r) => RANGE_DAYS[r] <= plan.limits.history_days);
  return out.length ? out : ["24h"];
}

/** The range to serve for a request: the one asked for when the plan shows it, else the longest it shows up to 7 days. */
export function pickRange(asked: string | null, allowed: Range[]): Range {
  if (asked && (allowed as string[]).includes(asked)) return asked as Range;
  const days = asked && asked in RANGE_DAYS ? RANGE_DAYS[asked as Range] : 7;
  const fit = allowed.filter((r) => RANGE_DAYS[r] <= days);
  return fit.length ? fit[fit.length - 1]! : allowed[0]!;
}

/** How long this plan keeps an app's data, in days (never less than what every project had before plans). */
export const keepDays = (plan: Plan): number => Math.max(RETENTION_DAYS, plan.limits.history_days);

// --------------------------------------------------------------------------------------------- retention

/**
 * The apps kept longer than RETENTION_DAYS: those of accounts on a plan with more history, of accounts whose paid
 * period ended less than GRACE_DAYS ago, and of accounts in GenClass's own grant (the grant plan's history; no grace
 * after it). `days` is the longest such plan's history. With `mode` (the current key's, null without one), a plan
 * bought in test mode counts only under a test key.
 */
export function longRetention(now: Date, mode?: StripeMode | null): { tokens: string; params: unknown[]; days: number } | undefined {
  const long = PLANS.filter((p) => p.limits.history_days > RETENTION_DAYS);
  if (!long.length) return undefined;
  const grace = new Date(now.getTime() - GRACE_DAYS * DAY).toISOString();
  const iso = now.toISOString();
  const granted = GRANT_PLAN.limits.history_days > RETENTION_DAYS;
  return {
    tokens:
      "SELECT p.token FROM projects p JOIN accounts a ON a.id = p.account_id WHERE " +
      (granted ? "a.comp_until > ? OR " : "") +
      `((a.plan IN (${long.map(() => "?").join(", ")}) OR (a.subscription_id IS NOT NULL AND a.current_period_end > ?))` +
      (mode !== undefined ? ` AND ${MODE_OK_SQL}` : "") +
      ")",
    params: [...(granted ? [iso] : []), ...long.map((p) => p.id), grace, ...(mode !== undefined ? [mode ?? ""] : [])],
    days: Math.max(...long.map((p) => p.limits.history_days)),
  };
}

/**
 * Plans whose payment is overdue end, whatever the Stripe account's retry settings (the owner sets them to cancel the
 * subscription once every retry failed; this is the backstop): an unpaid subscription, or one past_due for more than
 * PAST_DUE_GRACE_DAYS, leaves its account on Free. The webhook does the same when an event arrives; this catches the
 * accounts no event arrives for.
 */
export async function endOverduePlans(db: D1Like, now: Date): Promise<void> {
  await db
    .prepare("UPDATE accounts SET plan = 'free' WHERE plan <> 'free' AND (subscription_status = 'unpaid' OR (subscription_status = 'past_due' AND past_due_since < ?))")
    .bind(new Date(now.getTime() - PAST_DUE_GRACE_DAYS * DAY).toISOString())
    .run();
}

/**
 * The daily sweep (index.ts): dashboard rows by plan, stored-batch index and export copies by plan, forwarding dedupe
 * rows older than 2 hours, handled Stripe event ids older than 30 days, then overdue plans end (endOverduePlans; an
 * ended plan's data keeps its GRACE_DAYS either way). A failing step does not stop the ones after it, so the
 * past-due backstop always runs; the retention step's error is thrown at the end.
 */
export async function planRetention(db: D1Like, now: Date, bucket?: BucketOps, mode?: StripeMode | null): Promise<void> {
  const long = longRetention(now, mode);
  let failed: unknown = null;
  await retention(db, now, long).catch((e: unknown) => {
    failed = e;
  });
  // one after the other (each D1 batch is a transaction); a failure in one does not stop the next
  await exportSweep(db, bucket, now, long).catch(() => undefined);
  await db
    .batch([
      db.prepare("DELETE FROM forward_log WHERE hour < ?").bind(new Date(now.getTime() - 2 * 3_600_000).toISOString().slice(0, 13)),
      db.prepare("DELETE FROM billing_events WHERE received < ?").bind(new Date(now.getTime() - 30 * DAY).toISOString()),
    ])
    .catch(() => undefined);
  await endOverduePlans(db, now).catch(() => undefined);
  if (failed) throw failed;
}
