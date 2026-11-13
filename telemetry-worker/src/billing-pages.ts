// HTML for the paid plans: /account/billing (the plan, its renewal or end, the plans side by side, Upgrade, Switch and
// Manage billing buttons, the seats of a plan sold per seat, and the team: members, invite links and the teams the
// account is a member of; src/team.ts) and the plan-dependent sections of an owned app's dashboard (forwarding and export, and the
// note on the time ranges). A switch between two paid plans is a new Checkout (src/billing.ts checkout); back from it
// the page waits for the new plan. Same shell, tokens and rules as the account pages; server-rendered text goes through esc(),
// scripts insert text with textContent. Buttons that need Stripe are shown only to an account that can buy (a live
// STRIPE_SECRET_KEY, or a test key and the account in STRIPE_TEST_ACCOUNTS). A plan agreed by email (Enterprise) has
// Talk to us, a mailto link, whatever the key. Which plans include something is said from billing/plans.json
// (plansWith), never by name.

import { CLIENT_JS, ORG_CSS, orgRail, time } from "./account-pages.js";
import type { Env } from "./collector.js";
import type { D1Like, Project, Range } from "./dashboard.js";
import { integrationRows, integrationsKey, KIND_NAMES, KINDS, maskConfig, openConfig, DATADOG_SITES, POSTHOG_HOSTS, type Kind } from "./forward.js";
import { DASH_CSS, embed, esc, orgName } from "./pages.js";
import { studioPage } from "./studio.js";
import {
  accountPlan,
  billingLive,
  byAgreement,
  entitled,
  GRACE_DAYS,
  keepDays,
  LIVE_STATUSES,
  MAX_SEATS,
  PAID_PLANS,
  PAST_DUE_GRACE_DAYS,
  RETIRED_PLAN_IDS,
  PLANS,
  PLANS_FILE,
  planById,
  priceText,
  viewRanges,
  type Access,
  type Billing,
  type Entitlement,
  type Plan,
} from "./plans.js";
import type { Team } from "./team.js";

const CONTACT = PLANS_FILE.contact;
const day = (iso: string | null): string => (iso ? time(iso, "date") : "");

/** "A and B", "A, B or C": the names of the plans that include `e`, from billing/plans.json. */
function plansWith(e: Entitlement, last: "and" | "or" = "and"): string {
  const n = PLANS.filter((p) => entitled(p, e)).map((p) => p.name);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} ${last} ${n[n.length - 1]}` : (n[0] ?? "");
}
/** Every plan includes `e` (today: only the dashboard). */
const everyPlan = (e: Entitlement): boolean => PLANS.every((p) => entitled(p, e));
/** "A and B": the paid plans a switch moves between, said only when there are two or more. */
const switchable = (): string | null => (PAID_PLANS.length > 1 ? PAID_PLANS.map((p) => p.name).join(" and ") : null);

// --------------------------------------------------------------------------------------------- /account/billing

export interface BillingView {
  account: { id: string; email: string | null; githubLogin: string | null };
  /** Every app with its plan (plans are per project since billing/plans.json version 4). */
  projects?: { id: string; name: string; access: Access }[];
  apps: { id: string; name: string }[];
  billing: Billing;
  /** What the account may use now: its paid plan or GenClass's grant (src/plans.ts accessOf). */
  access: Access;
  /** This account can buy (src/plans.ts canBuy). */
  live: boolean;
  /** The key is a Stripe test key: no real money moves. */
  testMode: boolean;
  /** Back from Stripe Checkout (?done=1). */
  done: boolean;
  /** The plan chosen on the pricing page (?plan=<id>). */
  picked: string | null;
  /** With a picked plan: open its checkout at once (?start=1, from the genclass command's plan step). */
  go?: boolean;
  /** Back from a switch's Checkout (?to=<plan>): the plan it bought. */
  switchTo?: string | null;
  /** The names of the plans sold through Stripe Managed Payments (src/stripe.ts managedPayments). */
  managedPlans?: string[];
  /** The account's team as its owner sees it (src/team.ts teamOf); left out, the page has no Team section. */
  team?: Team;
  /** The teams this account is a member of (src/team.ts membershipsOf). */
  memberships?: { ownerId: string; email: string | null; githubLogin: string | null; joined: string; active: boolean }[];
  now: Date;
}

const BILLING_CSS = `
.plans{display:grid;grid-template-columns:repeat(${PLANS.length},minmax(0,1fr));gap:16px}
.plan{background:var(--s75);border:1px solid var(--rule);border-radius:6px;padding:20px;display:flex;flex-direction:column;gap:10px;min-width:0}
.plan.cur,.plan.pick{border-color:var(--accent-b);background:var(--accent-t)}
.plan h3{font-size:18px;margin:0}
.plan .price{font:400 14px var(--mono);color:var(--ink)}
.plan .sum{font-size:13px;color:var(--ink2);line-height:1.5}
.plan ul{list-style:none;padding:0;margin:4px 0 0;display:grid;gap:7px;font-size:13px;line-height:1.45;color:var(--ink2)}
.plan li{padding-left:18px;position:relative}
.plan li::before{content:"";position:absolute;left:2px;top:.45em;width:8px;height:5px;border-left:1.5px solid var(--accent);border-bottom:1.5px solid var(--accent);transform:rotate(-45deg)}
.plan li.soon{color:var(--ink3)}
.plan li.soon::before{border-color:var(--ink3)}
.plan .act{margin-top:auto;padding-top:10px}
.plan .tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font:500 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--accent);background:var(--accent-t);border:1px solid var(--accent-b)}
.status{margin-top:6px;font-size:14px;line-height:1.55;max-width:80ch;color:var(--ink2)}
.status b{color:var(--ink);font-weight:500}
.status a{color:var(--ink)}
.plan .seats{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2);margin-bottom:8px}
.plan .seats input{width:72px;min-height:32px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:13px var(--mono)}
.team .intro{font-size:14.5px;color:var(--ink2);margin-top:10px;max-width:72ch;line-height:1.55}
.team .intro a{color:var(--ink)}
.team .ok{font-size:14px;color:var(--ink2);margin-top:8px}
.team .ok:empty{display:none}
.team .ok code{font:13px var(--mono);overflow-wrap:anywhere}
.team td.act{text-align:right;white-space:nowrap}
.team .acct-form{margin-top:14px}
@media (max-width:860px){.plans{grid-template-columns:1fr}}
`;

function statusLine(v: BillingView, plan: Plan): string {
  const b = v.billing;
  const name = `<b>${esc(plan.name)}</b>`;
  // a server with PLAN_GATES open (a self-hosted collector): nothing is sold and nothing is locked
  if (v.access.source === "open") return `This server gives every account everything in <b>${esc(v.access.plan.name)}</b>: it sells no plans (PLAN_GATES is open).`;
  if (plan.id === "free") {
    if (v.access.source === "comp") return `You have <b>${esc(v.access.plan.name)}</b>, set up by GenClass. Questions: <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`;
    const overdue = !!b.subscription_id && (b.subscription_status === "past_due" || b.subscription_status === "unpaid");
    // a subscription not ended while the account reads as Free, with nothing sold on the site (or a stored plan GenClass
    // no longer sells): one to a retired plan (plans.json retired_plans; the webhook stores its plan as free). Paying it
    // gives no plan, so the page says to cancel it, never to pay it
    // With a plan on sale an overdue subscription on a Free account may also be that plan's, lapsed (the branch
    // below), so there only one still live counts as retired: a live subscription that gives no plan can be nothing else
    const known = !PAID_PLANS.length || RETIRED_PLAN_IDS.includes(b.plan);
    const retired = !!b.subscription_id && (known ? ["active", "trialing", "past_due", "unpaid"] : ["active", "trialing"]).includes(b.subscription_status ?? "");
    const ended = retired
      ? b.cancel_at_period_end
        ? ` Your subscription to a plan GenClass no longer sells is cancelled and ends on ${day(b.current_period_end)}, without another charge.`
        : ` Your subscription to a plan GenClass no longer sells is still open in Stripe and can bill again: cancel it in Manage billing, or email <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`
      : overdue
      ? ` The last payment for your paid plan did not go through, so it has ended. Update your card in Manage billing to pay it and get the plan back, or email <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`
      : b.subscription_id && b.current_period_end && b.subscription_status === "canceled" && Date.parse(b.current_period_end) > v.now.getTime() - GRACE_DAYS * 86_400_000
        ? ` Your paid plan ended on ${day(b.current_period_end)}. Data older than 90 days stays for ${GRACE_DAYS} days after that, in case you come back.`
        : "";
    return `You are on the ${name} plan.${ended}${v.live || !PAID_PLANS.length ? "" : " Paid plans are not on sale yet."}`;
  }
  if (!b.subscription_id) return `You are on the ${name} plan, set up by GenClass. Questions: <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`;
  if (b.subscription_status === "past_due") {
    return `You are on the ${name} plan. The last payment did not go through; Stripe tries the card again over the next days. Update it in Manage billing to keep ${esc(plan.name)}: if it is still unpaid ${PAST_DUE_GRACE_DAYS} days after the failed payment, the account moves to the Free plan.`;
  }
  if (b.cancel_at_period_end) {
    return `You are on the ${name} plan until ${day(b.current_period_end)}. It is cancelled and will not renew; you can resume it in Manage billing before then.`;
  }
  if (b.subscription_status === "trialing") {
    return `You are on the ${name} plan, in a trial until ${day(b.current_period_end)}. When it ends your card is charged for the first month (${esc(priceText(plan))}), unless you cancel before in Manage billing.`;
  }
  if (plan.per_seat === true && v.access.seats !== null) {
    const n = v.access.seats;
    const total = (plan.price_usd_cents.monthly ?? 0) * n;
    return `You are on the ${name} plan with <b>${n} seat${n === 1 ? "" : "s"}</b>, ${esc(priceText(plan))} ($${total % 100 ? (total / 100).toFixed(2) : String(total / 100)} a month). It renews on ${day(b.current_period_end)}. Add or remove seats in Manage billing.`;
  }
  return `You are on the ${name} plan, ${esc(priceText(plan))}. It renews on ${day(b.current_period_end)}.`;
}

function planColumn(v: BillingView, p: Plan, current: Plan): string {
  // the column marked as the account's: its paid plan, or the grant's
  const cur = p.id === (v.access.source === "comp" || v.access.source === "open" ? v.access.plan.id : current.id);
  const subscribed = !!v.billing.subscription_id && LIVE_STATUSES.has(v.billing.subscription_status ?? "") && current.id !== "free";
  // back from Checkout (a purchase or a switch) and still waiting for Stripe's word: no buttons, so a second purchase
  // or switch cannot start
  const waiting = !!awaited(v, current);
  const pick = !cur && v.picked === p.id && v.live && !waiting;
  // the first paid plan's button is the strong one, unless another was picked on the pricing page
  // a plan sold per seat asks how many people first (the owner is one); Stripe's page shows it and lets them change it
  const seats =
    p.per_seat === true
      ? `<label class="seats" for="seats-${esc(p.id)}">Seats <input id="seats-${esc(p.id)}" type="number" inputmode="numeric" min="1" max="${MAX_SEATS}" step="1" value="${Math.max(1, v.team?.used ?? 1)}" data-seats="${esc(p.id)}"></label>`
      : "";
  // a plan sold per project is bought on that project's own page, from the list below
  const buy = p.per_project === true
    ? v.projects?.length
      ? `<a class="btn" href="#projects"><span>Choose a project</span></a>`
      : '<span class="muted">Add a project first: run npx genclass in your app.</span>'
    : `${seats}<button class="btn${p !== PAID_PLANS[0] && !pick ? " ghost" : ""}" type="button" data-plan="${esc(p.id)}"${pick ? " data-pick" : ""}><span>${subscribed ? "Switch to" : "Upgrade to"} ${esc(p.name)}</span></button>`;
  const talk = `<a class="btn ghost" href="mailto:${esc(CONTACT)}?subject=${encodeURIComponent(`GenClass ${p.name}`)}"><span>Talk to us</span></a>`;
  let act = "";
  if (cur) act = `<span class="tag">${v.access.source === "comp" ? "Set up by GenClass" : v.access.source === "open" ? "This server" : "Your plan"}</span>`;
  else if (p.id === "free") act = subscribed && v.live ? '<span class="muted">To go back to Free, cancel in Manage billing.</span>' : "";
  else if (byAgreement(p)) act = talk;
  else if (v.live && !waiting) act = buy;
  const features = p.features
    .map((f) => `<li${f.available ? "" : ' class="soon"'}>${esc(f.text)}${f.available || /coming next/i.test(f.text) ? "" : " (coming next)"}</li>`)
    .join("");
  return `<div class="plan${cur ? " cur" : pick ? " pick" : ""}"><h3>${esc(p.name)}</h3><p class="price">${esc(priceText(p))}</p><p class="sum">${esc(p.summary)}</p><ul>${features}</ul><div class="act">${act}</div></div>`;
}

/** The account's projects, each with its plan and the way to change it (its own page). */
function projectsSection(v: BillingView): string {
  if (!v.projects?.length) return "";
  const rows = v.projects
    .map((p) => {
      const a = p.access;
      const what = a.locked
        ? `<span class="tag" style="color:var(--warn);border-color:var(--warn)">Needs a plan</span>`
        : a.plan.id === "free"
          ? "Free"
          : `<b>${esc(a.plan.name)}</b>${a.source === "comp" ? " (set up by GenClass)" : ""}`;
      const act = a.source === "paid" ? `<a href="/account/billing?project=${encodeURIComponent(p.id)}">See plan</a>` : `<a class="btn${a.locked ? "" : " ghost"}" href="/account/billing?project=${encodeURIComponent(p.id)}"><span>${a.locked ? "Choose a plan" : "Upgrade"}</span></a>`;
      return `<tr><td>${esc(p.name)}</td><td>${what}</td><td class="act">${act}</td></tr>`;
    })
    .join("");
  return `<section class="blk team" id="projects">
  <div class="blk-h"><h2>Projects</h2><span class="aside">A plan per project</span></div>
  <p class="intro">Each project has its own plan. Free covers ${FREE_APPS} projects; ${esc(PAID_PLANS[0] ? `${PAID_PLANS[0].name} is ${priceText(PAID_PLANS[0])}` : "")}, everyone on your team included.</p>
  <table><thead><tr><th>Project</th><th>Plan</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
}

const FREE_APPS = PLANS[0]?.limits.apps ?? 3;

/** The popup's reasons (src/billing.ts FREE_REASONS, kept in step by a test): [value, the words shown]. */
const FREE_REASON_WORDS: readonly (readonly [string, string])[] = [
  ["price", "It costs too much"],
  ["trying", "I'm only trying GenClass out"],
  ["approval", "I need to ask my team or my boss"],
  ["feature", "It's missing something I need"],
  ["unsure", "I'm not sure it works for my app yet"],
  ["other", "Something else"],
];
export const FREE_REASONS_SHOWN = FREE_REASON_WORDS;

export interface ProjectPlanView {
  account: { id: string; email: string | null; githubLogin: string | null };
  apps: { id: string; name: string }[];
  project: { id: string; name: string };
  access: Access;
  /** The project's own subscription, as the webhook wrote it. */
  sub: { status: string | null; periodEnd: string | null; cancels: boolean };
  usage: { used: number; limit: number | null; observe_only: boolean; resets: string } | null;
  /** Days free this account's first plan starts with (billing.ts trialFor); 0: none. */
  trialDays?: number;
  live: boolean;
  testMode: boolean;
  /** Back from Stripe Checkout (?done=1). */
  done: boolean;
  /** Open the checkout at once (?start=1, from the genclass command). */
  go: boolean;
  /** The project was just added from the genclass command (?from=cli). */
  fromCli: boolean;
  /** Just added on the website (?new=1): after the choice, the app's setup. */
  isNew?: boolean;
  /** Free was chosen for it on this page before (projects.plan_chosen). */
  chosen?: boolean;
  now: Date;
}

/**
 * One project's plan: what it is on, what it has used, and the paid plan large with "Try free for now (limited)"
 * small under it (the owner's layout, 2026-11-12). The genclass command opens this page when it adds a project.
 */
export function projectPlanPage(nonce: string, v: ProjectPlanView): string {
  const offer = PAID_PLANS[0] ?? null;
  const a = v.access;
  const paid = a.source === "paid";
  const name = esc(v.project.name);
  // version 5 (2026-11-13): Pro is the account's, 3 apps for each $15; every new app sees this page, a paying account
  // included (Continue with Pro), and an app past what the plan covers waits here for more
  const per = offer?.apps_per_unit ?? null;
  const proFull = a.locked === "pro_apps";
  const covered = !a.locked && a.source !== null;
  const status = a.source === "open"
    ? `This server gives every app everything in <b>${esc(a.plan.name)}</b>.`
    : proFull
      ? `Your <b>${esc(offer?.name ?? "paid")}</b> plan covers ${a.apps ?? 0} apps, and <b>${name}</b> is one more.${per ? ` Add ${per} more apps for ${esc(priceText(offer!).replace(/ for \d+ apps$/, ""))}.` : ""}`
      : paid
        ? v.sub.cancels
          ? `<b>${name}</b> is on <b>${esc(a.plan.name)}</b> until ${day(v.sub.periodEnd)}. It is cancelled and will not renew; you can resume it in Manage billing.`
          : v.sub.status === "past_due"
            ? `<b>${name}</b> is on <b>${esc(a.plan.name)}</b>. The last payment did not go through: update your card in Manage billing.`
            : `Your <b>${esc(a.plan.name)}</b> plan covers <b>${name}</b>${a.apps ? ` (${a.apps} apps on your account)` : ""}.`
        : a.source === "comp"
          ? `Your <b>${esc(a.plan.name)}</b> plan, set up by GenClass, covers <b>${name}</b>.`
          : a.locked
            ? `Free covers ${FREE_APPS === 1 ? "one app" : `${FREE_APPS} apps`}, and <b>${name}</b> is one more: it needs ${esc(offer?.name ?? "a paid plan")}.`
            : `<b>${name}</b> is on <b>Free</b>.`;
  const usage = v.usage && v.usage.limit !== null
    ? `<p class="status">${v.usage.observe_only ? `<b>Observing only.</b> ` : ""}Problems fixed live this month: <b>${v.usage.used} of ${v.usage.limit}</b>.${v.usage.observe_only ? ` GenClass keeps finding and reporting every problem, and stops fixing them on visitors' screens until ${day(v.usage.resets)}, or until this project has ${esc(offer?.name ?? "a paid plan")}.` : ""}</p>`
    : "";
  const notice = v.done && !paid
    ? '<p class="notice n-ok" role="status" id="donemsg"><b>Thanks.</b> This page changes as soon as Stripe confirms your payment, usually within a minute.</p>'
    : v.done
      ? `<p class="notice n-ok" role="status"><b>Thanks.</b> ${name} is on ${esc(a.plan.name)} now. <a href="/account/apps/${encodeURIComponent(v.project.id)}">Open its dashboard</a>.</p>`
      : (v.fromCli || v.isNew) && !paid && a.source === null
        ? `<p class="notice" role="status"><b>${name}</b> is in your account. Choose its plan to go on.</p>`
        : "";
  const test = v.testMode && v.live ? '<p class="notice" role="note"><b>Stripe test mode.</b> No real money moves. Pay with card 4242 4242 4242 4242, any future date and any CVC.</p>' : "";
  const features = (offer?.features ?? []).filter((f) => f.available).map((f) => `<li>${esc(f.text)}</li>`).join("");
  const action = covered
    ? `<button class="btn" type="button" data-continue><span>Continue with ${esc(a.plan.name)}</span></button><p class="trialnote">Your current plan.${paid ? ` <a href="#" id="portal">Manage billing</a>` : ""}</p>`
    : proFull
      ? `<button class="btn" type="button" data-addapps><span>Add ${per ?? 3} more apps</span></button><p class="trialnote">${esc(priceText(offer!).replace(/ for \d+ apps$/, ""))} more, on your next bill. You choose the quantity on Stripe.</p>`
      : v.live
        ? `<button class="btn" type="button" data-plan="${esc(offer!.id)}" data-pick><span>${v.trialDays ? `Start your ${v.trialDays}-day free trial` : `Start ${esc(offer!.name)}`}</span></button>${v.trialDays ? `<p class="trialnote">${v.trialDays} days free, then ${esc(priceText(offer!))}. Cancel before the trial ends and you pay nothing.</p>` : ""}`
        : '<span class="muted">Paid plans are not on sale yet.</span>';
  const card = offer && a.source !== "open"
    ? `<div class="plan pick big"><h3>${esc(offer.name)}${covered ? ' <span class="tag">Your plan</span>' : ""}</h3><p class="price">${esc(priceText(offer))}</p><p class="sum">${esc(offer.summary)}</p><ul>${features}</ul>
  <div class="act">${action}</div></div>
  ${a.locked || a.source !== null ? "" : `<p class="free"><a href="#why" class="linkish" id="free">Try for free (limited)</a></p>
  <dialog id="why" class="why" aria-labelledby="whyh">
    <form id="whyform">
      <h2 id="whyh">What's stopping you from paying?</h2>
      <p class="muted">Pick one. It tells us what to fix.</p>
      <fieldset>${FREE_REASON_WORDS.map(([val, words]) => `<label><input type="radio" name="why" value="${esc(val)}"> ${esc(words)}</label>`).join("")}</fieldset>
      <textarea id="whynote" maxlength="500" placeholder="Anything else? (optional)"></textarea>
      <p class="err" id="whyerr" role="alert"></p>
      <div class="why-act"><button class="btn" type="button" id="whyteam"><span>Start ${esc(offer.name)} instead</span></button><button class="btn ghost" type="submit" id="whygo" disabled><span>Continue with Free (limited)</span></button></div>
    </form>
  </dialog>`}`
    : a.source === "open"
      ? `<div class="act"><button class="btn" type="button" data-continue><span>Continue</span></button></div>`
      : "";
  const body = `
<div class="sb-page planpage" id="mc" tabindex="-1">
<header class="sb-ph" id="top"><div>
  <h1>Choose a plan for ${name}</h1>
  <p class="status" id="status">${status}</p>
  ${usage}
</div></header>
${notice}${test}
<section class="blk" id="plan">
  ${card}
  <p class="err" id="planerr" role="alert"></p><p class="err" id="portalerr" role="alert"></p>
  <p class="intro"><a href="/account/billing#projects">All your projects and their plans</a></p>
</section>
</div>
<script type="application/json" id="cfg">${embed({ project: v.project.id, go: v.go && !covered && !proFull && v.live, wait: (v.done && !paid) || proFull, cli: v.fromCli, isNew: !!v.isNew })}</script>`;
  const script = `
(function(){
  gcDropQuery(["project"]);
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  var b = document.querySelector("[data-plan]");
  if (b) b.addEventListener("click", function(){
    var err = document.getElementById("planerr"); err.textContent = "";
    gcBusy(b, true, "Opening Stripe...");
    gcPost("/api/billing/checkout", { plan: b.getAttribute("data-plan"), project_id: cfg.project }).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
  });
  if (b) b.focus();
  // sent here by the genclass command to start the plan: the same click a person would make
  if (b && cfg.go) b.click();
  // the small way on: Free for this app, for now, once the person has said what stops them from paying (the
  // genclass command waits for this choice or a payment)
  var fr = document.getElementById("free");
  var why = document.getElementById("why");
  var go = document.getElementById("whygo");
  if (fr && why) {
    fr.addEventListener("click", function(e){ e.preventDefault(); if (why.showModal) why.showModal(); else why.setAttribute("open", ""); });
    why.querySelectorAll("input[name=why]").forEach(function(r){ r.addEventListener("change", function(){ go.disabled = false; }); });
    document.getElementById("whyteam").addEventListener("click", function(){ if (why.close) why.close(); else why.removeAttribute("open"); if (b) b.click(); });
    document.getElementById("whyform").addEventListener("submit", function(e){
      e.preventDefault();
      var picked = why.querySelector("input[name=why]:checked");
      var err = document.getElementById("whyerr"); err.textContent = "";
      if (!picked) { err.textContent = "Pick what is stopping you."; return; }
      gcBusy(go, true, "Saving...");
      gcPost("/api/billing/projects/" + encodeURIComponent(cfg.project) + "/free", { reason: picked.value, note: document.getElementById("whynote").value }).then(function(){
        location.href = "/account/apps/" + encodeURIComponent(cfg.project) + (cfg.isNew || cfg.cli ? "#connect" : "");
      }, function(e2){ err.textContent = gcWhy(e2); gcBusy(go, false); });
    });
  }
  var portal = document.getElementById("portal");
  if (portal) portal.addEventListener("click", function(e){
    e.preventDefault();
    var err = document.getElementById("portalerr"); err.textContent = "";
    gcPost("/api/billing/portal", {}).then(function(j){ location.href = j.url; }, function(e2){ err.textContent = gcWhy(e2); });
  });
  // a paying account goes on with its plan: the app's dashboard (its setup for a new one)
  var cont = document.querySelector("[data-continue]");
  if (cont) cont.addEventListener("click", function(){
    var err = document.getElementById("planerr"); err.textContent = "";
    gcBusy(cont, true, "One moment...");
    gcPost("/api/billing/projects/" + encodeURIComponent(cfg.project) + "/continue", {}).then(function(){
      location.href = "/account/apps/" + encodeURIComponent(cfg.project) + (cfg.isNew || cfg.cli ? "#connect" : "");
    }, function(e){ err.textContent = gcWhy(e); gcBusy(cont, false); });
  });
  // more apps on Pro: the quantity is changed on Stripe's billing page, and this page waits for it
  var add = document.querySelector("[data-addapps]");
  if (add) add.addEventListener("click", function(){
    var err = document.getElementById("planerr"); err.textContent = "";
    gcBusy(add, true, "Opening Stripe...");
    gcPost("/api/billing/portal", {}).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(add, false); });
  });
  if (cfg.wait) {
    var tries = 0;
    var timer = setInterval(function(){
      if (++tries > 40) { clearInterval(timer); return; }
      fetch("/api/billing?project=" + encodeURIComponent(cfg.project), { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ if (j && j.project && j.project.source === "paid" && !j.project.locked) { clearInterval(timer); location.reload(); } })
        .catch(function(){});
    }, 3000);
  }
})();`;
  const label = v.account.email ?? (v.account.githubLogin ? `@${v.account.githubLogin}` : "Your account");
  return studioPage(nonce, {
    title: `${paid || a.source === "comp" || a.source === "open" ? "The plan for" : "Choose a plan for"} ${v.project.name} | GenClass`,
    account: true,
    org: { name: orgName(label), plan: a.plan.name, href: "/account" },
    projects: v.apps,
    project: null,
    user: { label, sub: orgName(label) },
    ...orgRail("billing"),
    railLabel: "Organization",
    css: DASH_CSS + ORG_CSS + BILLING_CSS + ".planpage .sb-ph{text-align:center}.planpage .sb-ph>div{margin:0 auto}.planpage #plan{background:none;border:0;box-shadow:none;padding:0;display:flex;flex-direction:column;align-items:center;gap:0}.planpage #plan .intro{margin:20px auto 0;text-align:center}.planpage #plan .err:empty{display:none}.planpage .notice{max-width:560px;margin-left:auto;margin-right:auto}.planpage .acct-form{justify-content:center}.plan.big{width:100%;max-width:560px;padding:34px 32px 30px}.plan.big h3{font-size:34px;letter-spacing:-.01em}.plan.big .price{font-size:22px;font-weight:600;margin-top:6px}.plan.big .sum{font-size:15px}.plan.big li{font-size:15px}.plan.big .act .btn{width:100%;justify-content:center;padding:15px 18px;font-size:17px}.free{margin-top:14px;font-size:11px;width:100%;max-width:560px;text-align:center}.linkish{background:none;border:0;padding:0;font:inherit;font-size:11px;color:var(--ink3);text-decoration:underline;cursor:pointer}.linkish:disabled{opacity:.6;cursor:default}.trialnote{margin:10px 0 0;font-size:13px;color:var(--ink3);text-align:center;width:100%}dialog.why{margin:auto;max-height:calc(100vh - 32px);overflow:auto;max-width:460px;width:calc(100% - 32px);border:1px solid var(--rule);border-radius:14px;background:var(--paper);color:var(--ink);padding:24px 24px 20px}dialog.why::backdrop{background:rgba(0,0,0,.62)}dialog.why h2{font-size:21px;margin:0 0 4px}dialog.why fieldset{border:0;padding:0;margin:14px 0 6px}dialog.why label{display:flex;gap:10px;align-items:center;padding:7px 0;font-size:15px;cursor:pointer}dialog.why textarea{margin-top:6px}.why-act{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}",
    body,
    script: CLIENT_JS + script,
  });
}

/** Back from Checkout and the plan bought is not on the account yet: that plan ("paid": any paid plan), else null. */
function awaited(v: BillingView, current: Plan): string | null {
  if (!v.done) return null;
  if (v.switchTo && v.switchTo !== current.id) return v.switchTo;
  return current.id === "free" ? "paid" : null;
}

const who = (x: { email: string | null; githubLogin: string | null }): string => x.email ?? (x.githubLogin ? `@${x.githubLogin}` : "A GenClass account");

/** The Team section: seats, members, invite links (the owner's side) and the teams this account is a member of. */
function teamSection(v: BillingView): string {
  const t = v.team;
  if (!t) return "";
  const holds = t.seats === null || t.seats > 1;
  const sold = PAID_PLANS.filter((p) => p.per_seat === true).map((p) => p.name);
  const aside = t.seats === null ? `${t.used} ${t.used === 1 ? "person" : "people"}` : `${t.used} of ${t.seats} seat${t.seats === 1 ? "" : "s"} used`;
  let own: string;
  if (!holds) {
    own = `<p class="intro">${
      t.access.plan.per_seat === true
        ? "Your plan has one seat, yours. Add seats in Manage billing to invite your team."
        : `The ${esc(t.access.plan.name)} plan is for one person.${sold.length ? ` Members come with ${esc(sold.join(" and "))}: one seat each, and they open the dashboards of your apps with their own sign-in.` : ""}`
    }</p>`;
  } else {
    const over = t.members.some((m) => !m.active);
    const members = t.members.length
      ? `<div class="tablewrap"><table class="dt rows"><thead><tr><th>Member</th><th>Joined</th><th>Access</th><th></th></tr></thead><tbody>${t.members
          .map(
            (m) =>
              `<tr><td>${esc(who(m))}</td><td data-l="Joined">${time(m.joined)}</td><td data-l="Access">${m.active ? "Dashboards" : '<span class="muted">No seat</span>'}</td><td class="act"><button class="btn sm ghost" type="button" data-rmmember="${esc(m.id)}" aria-label="Remove ${esc(who(m))} from your team">Remove</button></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="intro">No members yet. Make an invite link and send it to a teammate: it works once, for 7 days.</p>';
    const invites = t.invites.length
      ? `<div class="tablewrap"><table class="dt rows"><thead><tr><th>Invite link</th><th>Made</th><th>Expires</th><th></th></tr></thead><tbody>${t.invites
          .map((i) => `<tr><td>Not used yet</td><td data-l="Made">${time(i.created)}</td><td data-l="Expires">${time(i.expires)}</td><td class="act"><button class="btn sm ghost" type="button" data-rminvite="${esc(i.id)}">Revoke</button></td></tr>`)
          .join("")}</tbody></table></div>`
      : "";
    own = `<p class="intro">Members open the dashboards of your apps with their own sign-in. They cannot change an app, its forwarding or export, or see billing. You are the first seat.</p>
  ${over ? '<p class="intro"><b>More members than seats.</b> The members marked No seat cannot open your dashboards until you add seats in Manage billing or remove someone.</p>' : ""}
  ${members}${invites}
  <div class="acct-form"><button class="btn ghost" type="button" id="invite"><span>Make an invite link</span></button></div>
  <p class="err" id="teamerr" role="alert"></p><p class="ok" id="teamok" role="status"></p>`;
  }
  const mine = v.memberships?.length
    ? `<div class="blk-h"><h2>Teams you are in</h2></div>
  <div class="tablewrap"><table class="dt rows"><thead><tr><th>Team of</th><th>Joined</th><th>Access</th><th></th></tr></thead><tbody>${v.memberships
    .map(
      (m) =>
        `<tr><td>${esc(who(m))}</td><td data-l="Joined">${time(m.joined)}</td><td data-l="Access">${m.active ? "Dashboards" : '<span class="muted">No seat now</span>'}</td><td class="act"><button class="btn sm ghost" type="button" data-leave="${esc(m.ownerId)}" aria-label="Leave the team of ${esc(who(m))}">Leave</button></td></tr>`,
    )
    .join("")}</tbody></table></div>
  <p class="err" id="leaveerr" role="alert"></p>`
    : "";
  return `<section class="blk team" id="team">
  <div class="blk-h"><h2>Team</h2><span class="aside">${esc(aside)}</span></div>
  ${own}
  ${mine}
</section>`;
}

export function billingPage(nonce: string, v: BillingView): string {
  const plan = planById(v.billing.plan);
  const want = awaited(v, plan);
  const a = v.account;
  const manage = v.live && v.billing.stripe_customer_id;
  let notice = "";
  if (v.done) {
    const to = want && want !== "paid" ? planById(want) : null;
    notice = to
      ? `<p class="notice n-ok" role="status" id="donemsg"><b>Thanks.</b> This page changes to ${esc(to.name)} as soon as Stripe confirms your payment, usually within a minute (a bank debit can take a few days). Your ${esc(plan.name)} plan stays until then, then ends, and its unused days are refunded to the card or account that paid for it.</p>`
      : want
        ? '<p class="notice n-ok" role="status" id="donemsg"><b>Thanks.</b> This page changes to your new plan as soon as Stripe confirms your payment, usually within a minute (a bank debit can take a few days).</p>'
        : `<p class="notice n-ok" role="status"><b>Thanks.</b> You are on the ${esc(plan.name)} plan now.</p>`;
  }
  const subscribed = !!v.billing.subscription_id && LIVE_STATUSES.has(v.billing.subscription_status ?? "") && plan.id !== "free";
  const between = switchable();
  const switchNote =
    subscribed && v.live && !want && between
      ? `<p class="intro">Switching between ${esc(between)} opens Stripe's checkout for the new plan. Your current plan stays until that payment goes through, then ends at once, and its unused days are refunded to the card or account that paid for it.</p>`
      : "";
  // Stripe Managed Payments: Link is the merchant of record, so the page names it next to the plans
  const managed = v.live && v.managedPlans?.length
    ? `<p class="intro">${esc(v.managedPlans.join(" and "))} ${v.managedPlans.length > 1 ? "are" : "is"} sold through Link, Stripe's merchant of record service.</p>`
    : "";
  const custom =
    PAID_PLANS.includes(plan) && entitled(plan, "custom_model") && !!v.billing.subscription_id
      ? `<p class="status">A person from GenClass emails ${a.email ? esc(a.email) : "you"} within 1 business day of your purchase to start training your classifier. You can also write to <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.</p>`
      : "";
  const test =
    v.testMode && v.live
      ? '<p class="notice" role="note"><b>Stripe test mode.</b> Only accounts listed in STRIPE_TEST_ACCOUNTS can buy, and no real money moves. Pay with card 4242 4242 4242 4242, any future date and any CVC.</p>'
      : "";
  const body = `
<div class="sb-page" id="mc" tabindex="-1">
<header class="sb-ph" id="top"><div>
  <h1>Plan and billing</h1>
  <p class="status" id="status">${statusLine(v, plan)}</p>
  ${custom}
</div></header>
${notice}${test}
<section class="blk" id="plans">
  <div class="blk-h"><h2>Plans</h2>${PAID_PLANS.length ? '<span class="aside">US dollars, billed monthly</span>' : ""}</div>
  <div class="plans">${PLANS.map((p) => planColumn(v, p, plan)).join("")}</div>
  <p class="err" id="planerr" role="alert"></p>
  ${switchNote}${managed}
  <p class="intro">${esc(PLANS_FILE.footer).replace(esc(CONTACT), `<a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>`)}</p>
</section>
${
  manage
    ? `<section class="blk" id="manage">
  <div class="blk-h"><h2>Manage billing</h2><span class="aside">On Stripe</span></div>
  <p class="intro">Card, invoices${PAID_PLANS.some((p) => p.per_seat === true) ? ", seats" : ""} and cancellation.</p>
  <div class="acct-form"><button class="btn ghost" type="button" id="portal"><span>Manage billing</span></button></div>
  <p class="err" id="portalerr" role="alert"></p>
</section>`
    : ""
}
${projectsSection(v)}
${teamSection(v)}
</div>
<script type="application/json" id="cfg">${embed(v.go === true ? { want, go: true } : { want })}</script>`;

  const script = `
(function(){
  gcDropQuery([]);
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  document.querySelectorAll("[data-plan]").forEach(function(b){
    b.addEventListener("click", function(){
      var err = document.getElementById("planerr"); err.textContent = "";
      var body = { plan: b.getAttribute("data-plan") }, seats = document.querySelector('[data-seats="' + body.plan + '"]');
      if (seats) {
        var n = Number(seats.value);
        if (!(n >= 1 && n <= ${MAX_SEATS} && Math.floor(n) === n)) { err.textContent = "Seats is a whole number from 1 to ${MAX_SEATS}. For a larger team, email ${esc(CONTACT)}."; return; }
        body.seats = n;
      }
      gcBusy(b, true, "Opening Stripe...");
      gcPost("/api/billing/checkout", body).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
    });
  });
  // the team: an invite link is shown once; removing, revoking and leaving take two clicks (gcArm)
  var teamerr = document.getElementById("teamerr"), teamok = document.getElementById("teamok"), invite = document.getElementById("invite");
  if (invite) invite.addEventListener("click", function(){
    teamerr.textContent = ""; teamok.textContent = ""; gcBusy(invite, true, "Making the link...");
    gcPost("/api/team/invites", {}).then(function(j){
      gcBusy(invite, false);
      teamok.textContent = "Send this link to one person. It works once, for 7 days, and is not shown again: ";
      var c = document.createElement("code"); c.textContent = j.url; teamok.appendChild(c);
    }, function(e){ teamerr.textContent = gcWhy(e); gcBusy(invite, false); });
  });
  function gone(sel, attr, url, label, errId){
    document.querySelectorAll(sel).forEach(function(b){
      b.addEventListener("click", function(){
        if (!gcArm(b, label)) return;
        b.disabled = true;
        gcPost(url + encodeURIComponent(b.getAttribute(attr)), undefined, "DELETE").then(function(){ location.reload(); }, function(e){ var x = document.getElementById(errId); if (x) x.textContent = gcWhy(e); b.disabled = false; });
      });
    });
  }
  gone("[data-rmmember]", "data-rmmember", "/api/team/members/", "Confirm remove", "teamerr");
  gone("[data-rminvite]", "data-rminvite", "/api/team/invites/", "Confirm revoke", "teamerr");
  gone("[data-leave]", "data-leave", "/api/team/memberships/", "Confirm leave", "leaveerr");
  var pick = document.querySelector("[data-pick]");
  if (pick) pick.focus();
  // sent here to start that plan (the address said so, and it is gone from the address bar by now, so a reload
  // does not start it again): the same click a person would make, with the seats the page shows
  if (pick && cfg.go) pick.click();
  var portal = document.getElementById("portal");
  if (portal) portal.addEventListener("click", function(){
    var err = document.getElementById("portalerr"); err.textContent = "";
    gcBusy(portal, true, "Opening Stripe...");
    gcPost("/api/billing/portal", {}).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(portal, false); });
  });
  if (cfg.want) {
    var tries = 0;
    var timer = setInterval(function(){
      if (++tries > 40) { clearInterval(timer); var m = document.getElementById("donemsg"); if (m) m.lastChild.textContent = " Stripe has not told us yet. Reload this page in a few minutes; if your plan still shows Free, email ${esc(CONTACT)}."; return; }
      fetch("/api/billing", { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){
          if (j && j.plan && (cfg.want === "paid" ? j.plan !== "free" : j.plan === cfg.want)) { clearInterval(timer); location.reload(); }
        })
        .catch(function(){});
    }, 3000);
  }
})();`;
  const label = a.email ?? (a.githubLogin ? `@${a.githubLogin}` : "Your account");
  return studioPage(nonce, {
    title: "Plan and billing | GenClass",
    account: true,
    org: { name: orgName(label), plan: v.access.plan.name, href: "/account" },
    projects: v.apps,
    project: null,
    user: { label, sub: orgName(label) },
    ...orgRail("billing"),
    railLabel: "Organization",
    css: DASH_CSS + ORG_CSS + BILLING_CSS,
    body,
    script: CLIENT_JS + script,
  });
}

// --------------------------------------------------------------------------------------------- app page sections

export interface AppExtras {
  projectId: string;
  projectName: string;
  plan: Plan;
  live: boolean;
  /** INTEGRATIONS_KEY is set and valid, so forwarding settings can be saved. */
  canSave: boolean;
  destinations: { kind: Kind; enabled: boolean; summary: string; lastSent: string | null; lastError: string | null }[];
  exportKeys: { id: string; label: string | null; created: string; lastUsed: string | null }[];
  ranges: Range[];
  keep: number;
}

/** Everything the app page's plan-dependent sections show, read for one owned app (a grant gives its plan's). */
export async function appExtrasData(db: D1Like, env: Env, accountId: string, p: Project, now: Date): Promise<AppExtras> {
  const plan = await accountPlan(db, accountId, env, now);
  const projectId = p.id ?? "";
  const destinations: AppExtras["destinations"] = [];
  if (entitled(plan, "forwarding") && projectId) {
    for (const r of await integrationRows(db, projectId)) {
      const c = await openConfig(env, projectId, r.kind, r.config);
      destinations.push({ kind: r.kind, enabled: !!r.enabled, summary: maskConfig(r.kind, c), lastSent: r.last_sent, lastError: r.last_error });
    }
  }
  let exportKeys: AppExtras["exportKeys"] = [];
  if (entitled(plan, "export")) {
    const r = await db.prepare("SELECT id, label, created, last_used FROM export_keys WHERE account_id = ? ORDER BY created").bind(accountId).all<{ id: string; label: string | null; created: string; last_used: string | null }>();
    exportKeys = (r.results ?? []).map((k) => ({ id: k.id, label: k.label, created: k.created, lastUsed: k.last_used }));
  }
  return {
    projectId,
    projectName: p.name,
    plan,
    live: billingLive(env),
    canSave: !!(await integrationsKey(env)),
    destinations,
    exportKeys,
    ranges: viewRanges(plan),
    keep: keepDays(plan),
  };
}

const EXTRA_CSS = `
.paid .intro{font-size:14.5px;color:var(--ink2);margin-top:14px;max-width:72ch;line-height:1.55}
.paid .intro a,.paid td a{color:var(--ink)}
.paid .xf{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:14px;max-width:760px}
.paid .xf .f{flex:1 1 220px;min-width:0}
.paid .xf .f.sm{flex:0 1 150px}
.paid .xf label{display:block;font:500 12.5px var(--mono);color:var(--ink3);margin-bottom:6px}
.paid .xf input,.paid .xf select{min-height:40px;width:100%;padding:0 10px;border-radius:0;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:14px var(--sans)}
.paid .xf input:focus-visible,.paid .xf select:focus-visible{outline:1px solid var(--accent);outline-offset:1px}
.paid .xf .btn{min-height:40px}
.paid .err{font-size:14px;color:var(--warn);margin-top:8px}
.paid .err:empty{display:none}
.paid .ok{font-size:14px;color:var(--ink2);margin-top:8px}
.paid .ok:empty{display:none}
.paid .ok code{font:13px var(--mono);overflow-wrap:anywhere}
.paid .caution{margin-top:14px;padding:10px 0 10px 14px;border-left:3px solid var(--warn);font-size:14.5px;color:var(--ink2)}
.paid td .btn.sm{margin-left:6px}
.paid td.act{text-align:right;white-space:nowrap}
.paid td.e{white-space:normal;color:var(--warn);max-width:34ch}
.paid details.more{margin-top:14px}
.paid pre.code{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:10px}
.rnote{font-size:12.5px;color:var(--ink3);margin-top:8px;line-height:1.45}
.rnote a{color:var(--ink2)}
`;

const SEE_PLANS = '<a href="/account/billing">See plans</a>';

function destinationForm(kind: Kind, set: boolean, disabled: boolean): string {
  const dis = disabled ? " disabled" : "";
  const f = (id: string, label: string, input: string, cls = "f") => `<div class="${cls}"><label for="${id}">${label}</label>${input}</div>`;
  let fields = "";
  switch (kind) {
    case "sentry":
      fields = f("fw-sentry-dsn", "DSN", `<input id="fw-sentry-dsn" name="dsn" type="text" autocomplete="off" spellcheck="false" placeholder="https://abc123@o1.ingest.sentry.io/456"${dis}>`);
      break;
    case "posthog":
      fields =
        f("fw-posthog-key", "Project API key", `<input id="fw-posthog-key" name="key" type="text" autocomplete="off" spellcheck="false" placeholder="phc_..."${dis}>`) +
        f("fw-posthog-host", "Host", `<select id="fw-posthog-host" name="host"${dis}>${POSTHOG_HOSTS.map((h) => `<option value="${esc(h)}">${esc(new URL(h).host)}</option>`).join("")}</select>`, "f sm");
      break;
    case "datadog":
      fields =
        f("fw-datadog-key", "API key", `<input id="fw-datadog-key" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="32 hex characters"${dis}>`) +
        f("fw-datadog-site", "Site", `<select id="fw-datadog-site" name="site"${dis}>${DATADOG_SITES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>`, "f sm");
      break;
    case "slack":
      fields = f("fw-slack-url", "Incoming webhook URL", `<input id="fw-slack-url" name="url" type="password" autocomplete="off" spellcheck="false" placeholder="https://hooks.slack.com/services/..."${dis}>`);
      break;
    case "webhook":
      fields = f("fw-webhook-url", "URL", `<input id="fw-webhook-url" name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/hooks/genclass"${dis}>`);
      break;
  }
  // only the webhook needs a word: how to check its signature
  const help =
    kind === "webhook"
      ? '<p class="intro">Signed: <code>x-genclass-signature</code> is <code>t=&lt;unix time&gt;,v1=&lt;hex&gt;</code>, the HMAC-SHA256 of <code>t</code>, a dot and the body, with the secret shown once after you save.</p>'
      : "";
  return `<details class="more" id="fw-${kind}"><summary>${set ? "Change" : "Set up"} ${KIND_NAMES[kind]}</summary>
  ${help}
  <form class="xf" data-kind="${kind}" novalidate>${fields}<button class="btn" type="submit"${dis}><span>Save</span></button></form>
  <p class="err" data-err="${kind}" role="alert"></p><p class="ok" data-ok="${kind}" role="status"></p>
</details>`;
}

/** The forwarding and export sections and their script (rendered into the dashboard page with its nonce). */
export function appExtrasHtml(nonce: string, d: AppExtras): { html: string; script: string } {
  const fw = entitled(d.plan, "forwarding");
  const ex = entitled(d.plan, "export");
  let forwarding: string;
  if (!fw) {
    forwarding = `<p class="intro">Included in ${esc(plansWith("forwarding"))}. ${SEE_PLANS}</p>`;
  } else {
    const byKind = new Map(d.destinations.map((x) => [x.kind, x]));
    const rows = KINDS.map((k) => {
      const x = byKind.get(k);
      const status = !x ? '<span class="muted">Not set up</span>' : x.enabled ? "On" : '<span class="muted">Off</span>';
      const acts = x
        ? `<button class="btn sm ghost" type="button" data-test="${k}" aria-label="Send a test record to ${KIND_NAMES[k]}">Send test</button>` +
          `<button class="btn sm ghost" type="button" data-toggle="${k}" data-on="${x.enabled ? "1" : "0"}">${x.enabled ? "Turn off" : "Turn on"}</button>` +
          `<button class="btn sm ghost" type="button" data-remove="${k}" aria-label="Remove ${KIND_NAMES[k]}">Remove</button>`
        : `<a href="#fw-${k}" data-open="${k}">Set up</a>`;
      return `<tr><td>${KIND_NAMES[k]}${x ? `<div class="muted">${esc(x.summary)}</div>` : ""}</td><td data-l="Status">${status}</td><td data-l="Last sent">${x ? time(x.lastSent, "ago", "never") : ""}</td><td class="e" data-l="Last error">${x?.lastError ? esc(x.lastError) : ""}</td><td class="act">${acts}</td></tr>`;
    }).join("\n");
    forwarding = `${d.canSave ? "" : '<p class="caution"><b>Not available on this server yet.</b> No encryption key is set.</p>'}
  <div class="tablewrap"><table class="dt rows"><thead><tr><th>Destination</th><th>Status</th><th>Last sent</th><th>Last error</th><th></th></tr></thead><tbody>
${rows}
  </tbody></table></div>
  <p class="err" id="fwerr" role="alert"></p><p class="ok" id="fwok" role="status"></p>
  ${KINDS.map((k) => destinationForm(k, byKind.has(k), !d.canSave)).join("\n")}`;
  }

  let exportHtml: string;
  if (!ex) {
    exportHtml = `<p class="intro">Included in ${esc(plansWith("export"))}. ${SEE_PLANS}</p>`;
  } else {
    const keys = d.exportKeys.length
      ? `<div class="tablewrap"><table class="dt rows"><thead><tr><th>Export key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${d.exportKeys
          .map((k) => `<tr><td>${esc(k.label ?? "Export key")}</td><td data-l="Created">${time(k.created)}</td><td data-l="Last used">${time(k.lastUsed, "ago")}</td><td class="act"><button class="btn sm ghost" type="button" data-revokekey="${esc(k.id)}">Revoke</button></td></tr>`)
          .join("")}</tbody></table></div>`
      : '<p class="intro">No export keys yet.</p>';
    const curl = `curl -H "Authorization: Bearer gce_..." \\\n  "https://genclass.dev/api/account/projects/${d.projectId}/events?from=2026-10-01&to=2026-10-14&format=jsonl"`;
    exportHtml = `${everyPlan("export") ? "" : `<p class="intro">Covers the time this account was on ${esc(plansWith("export", "or"))}.</p>`}
  <form class="xf" id="exf" novalidate>
    <div class="f sm"><label for="exfrom">From</label><input id="exfrom" type="date"></div>
    <div class="f sm"><label for="exto">To (inclusive)</label><input id="exto" type="date"></div>
    <div class="f sm"><label for="exfmt">Format</label><select id="exfmt"><option value="jsonl">JSON Lines</option><option value="csv">CSV</option></select></div>
    <button class="btn" type="submit" id="exgo"><span>Download</span></button>
  </form>
  <p class="ok" id="exstat" role="status"></p><p class="err" id="exerr" role="alert"></p>
  <details class="more" id="exapi"><summary>Read it with the API</summary>
  <p class="intro"><code>to</code> is exclusive. More pages: send <code>x-genclass-next-cursor</code> back as <code>cursor</code>. A key reads every app in this account.</p>
  <pre class="code">${esc(curl)}</pre>
  ${keys}
  <form class="xf" id="keyf" novalidate><div class="f"><label for="keylabel">New export key</label><input id="keylabel" type="text" maxlength="60" autocomplete="off" placeholder="Name, e.g. warehouse sync"></div><button class="btn ghost" type="submit"><span>Create export key</span></button></form>
  <p class="err" id="keyerr" role="alert"></p><p class="ok" id="keyok" role="status"></p>
  </details>`;
  }

  const html = `<style nonce="${nonce}">${EXTRA_CSS}</style>
<section class="blk paid" id="forwarding" data-v="forwarding">
  <div class="blk-h"><h2>Forwarding</h2><span class="aside">${fw ? "New detections" : esc(plansWith("forwarding"))}</span></div>
  ${forwarding}
</section>
<section class="blk paid" id="export" data-v="export">
  <div class="blk-h"><h2>Export</h2><span class="aside">${ex ? "File or API" : esc(plansWith("export"))}</span></div>
  ${exportHtml}
</section>
<script type="application/json" id="paidcfg">${embed({
    id: d.projectId,
    name: d.projectName,
    keep: d.keep,
    note: d.plan.id === "free" && d.live && d.plan.limits.history_days < 30 ? `The ${d.plan.name} plan shows ${d.plan.limits.history_days} days.` : null,
    // the first plan that reaches a year, named in the note's link
    year: `${PLANS.find((p) => p.limits.history_days >= 365)?.name ?? "A paid plan"} shows a year.`,
  })}</script>`;

  const script = `
(function(){
  var C = JSON.parse(document.getElementById("paidcfg").textContent);
  var base = "/api/account/projects/" + encodeURIComponent(C.id);
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function req(method, url, body){
    return fetch(url, { method: method, credentials: "same-origin", headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function(r){
        if (r.status === 204) return {};
        return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status)); return j; });
      });
  }
  function say(node, text){ if (node) node.textContent = text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.]$/.test(text) ? "" : ".") : ""; }
  // times in the viewer's zone ("12 min ago", "13 Oct 2026"); the server wrote UTC dates
  document.querySelectorAll(".paid time[data-f]").forEach(function(t){
    var d = new Date(t.getAttribute("datetime")); if (isNaN(d)) return;
    var s = (Date.now() - d.getTime()) / 1000;
    t.textContent = t.getAttribute("data-f") === "ago" && s >= 0 && s < 129600 ? (s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago") : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    t.title = d.toLocaleString();
  });
  // the plan's ranges: a short note under the range buttons
  if (C.note) document.querySelectorAll(".seg").forEach(function(s){ var p = el("p", "rnote", C.note + " "); var a = el("a", null, C.year); a.href = "/account/billing"; p.appendChild(a); s.parentNode.insertBefore(p, s.nextSibling); });
  // forwarding
  var fwerr = document.getElementById("fwerr"), fwok = document.getElementById("fwok");
  document.querySelectorAll("form[data-kind]").forEach(function(f){
    f.addEventListener("submit", function(ev){
      ev.preventDefault();
      var kind = f.getAttribute("data-kind"), err = document.querySelector('[data-err="' + kind + '"]'), ok = document.querySelector('[data-ok="' + kind + '"]'), body = {};
      say(err, ""); say(ok, "");
      f.querySelectorAll("input,select").forEach(function(i){ body[i.name] = i.value; });
      var b = f.querySelector("button"); b.disabled = true;
      req("PUT", base + "/integrations/" + kind, body).then(function(j){
        if (j.secret) { ok.textContent = "Saved. Your signing secret, shown once: "; ok.appendChild(el("code", null, j.secret)); b.disabled = false; return; }
        location.reload();
      }, function(e){ say(err, e.message); b.disabled = false; });
    });
  });
  document.querySelectorAll("[data-open]").forEach(function(a){ a.addEventListener("click", function(){ var d = document.getElementById("fw-" + a.getAttribute("data-open")); if (d) d.open = true; }); });
  document.querySelectorAll("[data-test]").forEach(function(b){
    b.addEventListener("click", function(){
      say(fwerr, ""); say(fwok, ""); b.disabled = true;
      req("POST", base + "/integrations/" + b.getAttribute("data-test") + "/test", {}).then(function(){ say(fwok, "Sent a test record. Check that it arrived"); b.disabled = false; }, function(e){ say(fwerr, e.message); b.disabled = false; });
    });
  });
  document.querySelectorAll("[data-toggle]").forEach(function(b){
    b.addEventListener("click", function(){
      b.disabled = true;
      req("PATCH", base + "/integrations/" + b.getAttribute("data-toggle"), { enabled: b.getAttribute("data-on") !== "1" }).then(function(){ location.reload(); }, function(e){ say(fwerr, e.message); b.disabled = false; });
    });
  });
  document.querySelectorAll("[data-remove]").forEach(function(b){
    b.addEventListener("click", function(){
      if (b.getAttribute("data-armed") !== "1") { b.setAttribute("data-armed", "1"); b.textContent = "Confirm remove"; return; }
      b.disabled = true;
      req("DELETE", base + "/integrations/" + b.getAttribute("data-remove")).then(function(){ location.reload(); }, function(e){ say(fwerr, e.message); b.disabled = false; });
    });
  });
  // export
  var exf = document.getElementById("exf");
  if (exf) {
    var from = document.getElementById("exfrom"), to = document.getElementById("exto"), fmt = document.getElementById("exfmt"), stat = document.getElementById("exstat"), exerr = document.getElementById("exerr");
    var today = new Date(), d0 = new Date(today.getTime() - 6 * 86400000), min = new Date(today.getTime() - (C.keep - 1) * 86400000);
    function ymd(d){ return d.toISOString().slice(0, 10); }
    from.value = ymd(d0); to.value = ymd(today); from.min = ymd(min); to.min = ymd(min); from.max = ymd(today); to.max = ymd(today);
    exf.addEventListener("submit", function(ev){
      ev.preventDefault(); say(exerr, ""); say(stat, "");
      if (!from.value || !to.value || from.value > to.value) { say(exerr, "Pick a start date on or before the end date"); return; }
      var end = new Date(Date.parse(to.value + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
      var q = base + "/events?from=" + from.value + "&to=" + end + "&format=" + fmt.value, parts = [], pages = 0, btn = document.getElementById("exgo");
      btn.disabled = true;
      function page(url){
        return fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function(r){
          if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error || ("HTTP " + r.status)); });
          var next = r.headers.get("x-genclass-next-cursor");
          return r.blob().then(function(b){ parts.push(b); pages++; stat.textContent = "Downloaded " + pages + (pages === 1 ? " page" : " pages") + (next ? ", reading more..." : "."); if (next) return page(q + "&cursor=" + encodeURIComponent(next)); });
        });
      }
      page(q).then(function(){
        var blob = new Blob(parts, { type: fmt.value === "csv" ? "text/csv" : "application/x-ndjson" });
        var a = el("a"); a.href = URL.createObjectURL(blob); a.download = "genclass-" + C.id + "-" + from.value + "-" + to.value + "." + fmt.value;
        document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        stat.textContent = blob.size ? "Saved " + Math.max(1, Math.round(blob.size / 1024)) + " KB." : "No events in those dates.";
      }, function(e){ say(exerr, e.message); }).then(function(){ btn.disabled = false; });
    });
  }
  var keyf = document.getElementById("keyf");
  if (keyf) keyf.addEventListener("submit", function(ev){
    ev.preventDefault();
    var err = document.getElementById("keyerr"), ok = document.getElementById("keyok"); say(err, ""); say(ok, "");
    req("POST", "/api/account/export-keys", { label: document.getElementById("keylabel").value }).then(function(j){
      ok.textContent = "Your export key, shown once. Keep it like a password: "; ok.appendChild(el("code", null, j.key));
    }, function(e){ say(err, e.message); });
  });
  document.querySelectorAll("[data-revokekey]").forEach(function(b){
    b.addEventListener("click", function(){
      if (b.getAttribute("data-armed") !== "1") { b.setAttribute("data-armed", "1"); b.textContent = "Confirm revoke"; return; }
      b.disabled = true;
      req("DELETE", "/api/account/export-keys/" + encodeURIComponent(b.getAttribute("data-revokekey"))).then(function(){ location.reload(); }, function(e){ say(document.getElementById("keyerr"), e.message); b.disabled = false; });
    });
  });
})();`;
  return { html, script };
}
