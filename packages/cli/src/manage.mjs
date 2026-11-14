// The account's side of GenClass in the terminal: `genclass apps`, `plan`, `team`, `connections`, `export`,
// `funnels` and `agent link`. What the account pages and the dashboard's settings do in the browser, for a terminal
// that was approved for it (telemetry-worker/src/cli.ts).
//
// Invariants:
// - Reading asks nothing; a change says what it will do and is made on a key press or a named subcommand, never on
//   a bare `genclass <command>`.
// - A secret typed here (a webhook address, an API key) is not echoed, is sent to genclass.dev once over HTTPS, and
//   is kept nowhere on this machine. What comes back is the server's masked form.
// - Paying happens in the browser (genclass.dev, then Stripe): this command opens the page and waits.
// - What stays in the browser on purpose is named with its address: removing a person, deleting an app, sign-in
//   methods. No dead end: a plan that leaves something out says which plan has it and the command that starts it.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAccountProject, readCredentialsFor } from "../../runtime/bin/lib/account.mjs";
import { hostUrl } from "../../runtime/bin/lib/host.mjs";
import { c, interactive, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { checkout, mcpServer, openBrowser, planNow, projectPlan, signIn, upgradeOffer } from "./actions.mjs";
import { changeConnection, createInvite, fetchAccount, fetchApp, fetchOverview, fetchConnections, fetchEvents, makeAgentLink, saveFunnels } from "./api.mjs";
import { appArg, n, pickApp } from "./app.mjs";
import { copyText, onPath } from "./fix.mjs";
import { asking, refused } from "./session.mjs";
import { accountPaid, planName, readState } from "./state.mjs";
import { ago, agree, bad, clean, good, header, homeOpen, linkLine, note, planCard, PROMPT, secret, spinner, typed, warn, width, wrap } from "./tui.mjs";
import { agentSetup } from "./views.mjs";

const room = () => width() - 2;
const row = (label, text, w = 16) => {
  const [first = "", ...rest] = wrap(text, room() - 2 - w);
  out(`  ${c.gray(label.padEnd(w))}${first}`);
  for (const l of rest) out(`  ${" ".repeat(w)}${l}`);
};
const top = (state, target = null) => header({ app: target?.name ?? state.app.name, framework: !target || state.app.token === target.token ? state.app.framework : null, account: state.account?.label, plan: planName(state), host: state.host });
const day = (iso) => String(iso ?? "").slice(0, 10);
/** Signed in, or the lines that say how to. Returns { state, creds } or { code }. */
async function signedIn(o, deps, name) {
  let state = await readState({ cwd: o.cwd }, deps);
  let { creds } = readCredentialsFor();
  if (state.signedIn && creds) return { state, creds };
  // signed out on a terminal: the sign-in starts here, as it does for the commands behind Pro (paywall.mjs
  // requirePro), so every command does the same thing signed out (the 0.3.9 user stories). Not for a server that
  // cannot be reached, where a new sign-in would not help
  if (!o.json && !o.yes && interactive() && !(state.sessionProblem && state.sessionProblem !== "expired")) {
    out();
    note("Sign in to genclass.dev first.");
    if ((await (deps.signIn ?? signIn)(o)) === "done") {
      state = await readState({ cwd: o.cwd }, deps);
      creds = readCredentialsFor().creds;
      if (state.signedIn && creds) return { state, creds };
    }
    return { code: 1 };
  }
  if (o.json) out(JSON.stringify({ ok: false, error: "not signed in", run: "npx genclass login" }));
  else {
    header({ app: state.app.name, framework: state.app.framework, host: state.host });
    note(state.sessionProblem && state.sessionProblem !== "expired" ? `Could not reach genclass.dev (${state.sessionProblem}).` : `Sign in first: npx genclass login. Then: npx genclass ${name}`);
    out();
  }
  return { code: 1 };
}

// ------------------------------------------------------------------------------------------------------ apps

/**
 * `genclass apps`: the apps in the account. `genclass apps new "Name"` makes one (its project key is what
 * `npx genclass` writes into an app; run in an app's folder, that command makes the app itself).
 */
export async function apps(o = {}, deps = {}) {
  const s = await signedIn(o, deps, "apps");
  if ("code" in s) return s.code;
  const { state, creds } = s;
  const [sub, ...rest] = o.args ?? [];
  if (sub === "new" || sub === "add") {
    const name = rest.join(" ").trim();
    if (!name) {
      if (o.json) out(JSON.stringify({ ok: false, error: "a name is needed", run: 'npx genclass apps new "Name"' }));
      else {
        top(state);
        note('Give the app a name: npx genclass apps new "My shop"');
        out();
      }
      return 2;
    }
    const r = await createAccountProject(creds, name, deps);
    if (o.json) out(JSON.stringify(r.ok ? { ok: true, app: { id: r.id, name: r.name, key: r.token, dashboard_url: r.dashboardUrl } } : { ok: false, error: r.reason }));
    else {
      top(state);
      if (!r.ok) {
        bad(`Could not make the app: ${clean(r.reason, 240)}`);
        if (/upgrade needed/.test(r.reason ?? "")) out(`  ${c.gray("More apps:")} ${c.cyan("npx genclass plan")}`);
      } else {
        good(`Made ${c.bold(clean(r.name, 60))}.`);
        row("Project key", r.token);
        // plans are per project: an app past the ones Free covers needs its own, and its page says so
        const me = await fetchOverview(creds, deps).catch(() => null);
        const made = me?.ok ? me.projects.find((p) => p.token === r.token) : null;
        const full = !!made?.needsPlan && accountPaid(me);
        if (made?.needsPlan && made.planUrl) {
          // past the apps a paying account's plan covers: nothing to pay for, so nothing is opened or waited for
          warn(full ? "Your plan covers no more apps: more come with Enterprise, by email." : "Free covers one app: this one needs Pro.");
          out(`  ${c.gray(full ? "The address, on its plan page:" : "Its plan:")}`);
          out(`    ${c.cyan(made.planUrl)}`);
        } else if (made?.plan?.id === "free" && made.planUrl) {
          out(`  ${c.gray("On Free (limited). Its plan:")}`);
          out(`    ${c.cyan(made.planUrl)}`);
        }
        // its plan is chosen now, on its page (Pro, or Free with a reason)
        if (made?.id && !full) await planNow({ cwd: o.cwd, noBrowser: o.noBrowser }, deps, made.id);
        note("To put GenClass into that app's code, run npx genclass in its folder and pick this app.");
      }
      out();
    }
    return r.ok ? 0 : 1;
  }
  const list = state.projects;
  if (o.json) {
    out(JSON.stringify({ ok: true, plan: state.account?.plan ?? null, apps: list.map((p) => ({ id: p.id, name: p.name, key: p.token, last_event: p.last_event, dashboard_url: p.dashboard_url, shared: p.shared === true, here: p.token === state.app.token })) }, null, 2));
    return 0;
  }
  top(state);
  if (!list.length) {
    note("No app yet. Run npx genclass in your web app's folder: it adds GenClass and gives the app its dashboard.");
    out();
    return 0;
  }
  out(`  ${c.bold(`${n(list.length)} app${list.length === 1 ? "" : "s"}`)}${state.account?.plan?.name ? c.gray(`  on ${clean(state.account.plan.name, 20)}`) : ""}`);
  const wName = Math.min(Math.max(...list.map((p) => clean(p.name, 40).length)), room() - 34);
  for (const p of list.slice(0, o.all ? 200 : 20)) {
    const mark = p.token === state.app.token ? c.green(`${sym.arrow} this folder`) : p.shared ? c.gray("a team's") : "";
    out(`    ${c.bold(clean(p.name, wName).padEnd(wName))}  ${c.gray((p.last_event ? `last page ${ago(p.last_event, deps.now)}` : "nothing received yet").padEnd(28))}${mark}`.trimEnd());
  }
  if (!o.all && list.length > 20) out(`    ${c.gray(`and ${n(list.length - 20)} more: add --all`)}`);
  out();
  // the hint names the app worth looking at: this folder's, else the one that heard from its site last
  const live = [...list].sort((a, b) => String(b.last_event ?? "").localeCompare(String(a.last_event ?? "")));
  const show = list.find((p) => p.token === state.app.token) ?? live[0];
  out(`  ${c.gray("See one:")} ${c.cyan(`npx genclass dashboard --app ${appArg(show, list)}`)}`);
  out(`  ${c.gray("New one:")} ${c.cyan('npx genclass apps new "Name"')}`);
  out(`  ${c.gray("Delete one, in the browser:")} ${c.cyan(hostUrl("/account"))}`);
  out();
  return 0;
}

// ------------------------------------------------------------------------------------------------------ plan

const noLimit = (v, unit = "") => (v === null ? "no limit" : `${n(v)}${unit}`);

/** `genclass plan`: the plan, what it holds and what is used; on Free, the paid plan and Enter to start it. */
export async function plan(o = {}, deps = {}) {
  const s = await signedIn(o, deps, "plan");
  if ("code" in s) return s.code;
  const { state, creds } = s;
  const a = await asking(o, creds, (cr) => fetchAccount(cr, deps), deps);
  // plans per project: this folder's app's plan (the setup's plan step), else, from a server from before them, the
  // account's; an older sign-in or an older server: what the overview knows is still an answer
  // the genclass command is Pro's: an account without it is shown where Pro starts (paywall.mjs), else this folder's
  // app's plan page when it has one to see, else (a server from before plans per project) the account's offer
  const cli = state.account?.cli ?? null;
  const pro = cli && !cli.paid ? cli : null;
  const step = state.steps.find((x) => x.id === "app-plan");
  const mine = (state.projects ?? []).filter((p) => p.plan);
  const offer = pro ? null : (step?.offer ?? (mine.length ? null : a.ok ? a.offer : null));
  if (o.json) {
    const apps = mine.map((p) => ({ id: p.id, name: p.name, plan: p.plan, needs_plan: p.needsPlan, plan_url: p.planUrl, this_folder: p.token === state.app?.token }));
    const command = cli ? { paid: cli.paid, ...(cli.paid && cli.via ? { via: cli.via } : {}), ...(pro ? { checkout_url: pro.checkoutUrl, trial_days: pro.trialDays, price: pro.price } : {}) } : null;
    // without Pro the command runs no model at all: its runs a day are none here, whatever Free's number on the server
    const limits = a.ok && pro ? { ...a.limits, suggestionsPerDay: 0 } : a.ok ? a.limits : null;
    // a team's member: `plan`, its limits and what it includes are the team's Pro its seat is on (what an agent
    // reading plan.name should see), `own_plan` the account's own (Free), `team_plan` the team's in full
    const member = a.ok && a.teamPlan && a.teamPlan.id !== a.plan.id ? a.teamPlan : null;
    const shown = member
      ? { plan: { id: member.id, name: member.name, via: "team", source: member.source, owner: member.owner }, limits: { ...limits, apps: member.apps, historyDays: member.historyDays, seats: null }, includes: member.includes ?? a.includes }
      : a.ok ? { plan: a.plan, limits, includes: a.includes } : {};
    out(JSON.stringify(a.ok ? { ok: true, plan: shown.plan, ...(member ? { own_plan: a.plan } : {}), access: a.access, team_plan: a.teamPlan ?? null, limits: shown.limits, used: a.used, includes: shown.includes, subscription: a.subscription, billing_url: a.billingUrl, offer: offer ?? (pro ? a.offer : null), cli: command, apps } : { ok: true, plan: state.account?.plan ?? null, billing_url: state.account?.billingUrl ?? null, offer, cli: command, partial: a.reauth ? "sign in again for the limits: npx genclass login" : "this genclass.dev says no more" }, null, 2));
    return 0;
  }
  top(state);
  const billingUrl = (a.ok ? a.billingUrl : state.account?.billingUrl) ?? hostUrl("/account/billing");
  if (o.open) openBrowser(billingUrl, o);
  if (!a.ok) {
    row("Plan", c.bold(clean(state.account?.plan?.name ?? "not known", 20)));
    if (a.reauth) note("For its limits and what is used: npx genclass login, once (this sign-in is from before the command could show them).");
  } else if (a.teamPlan && a.teamPlan.id !== a.plan.id) {
    // a member of a paying team: its seat is one the team's owner pays for (Pro is per developer), so it shows the
    // team's plan, the team's apps and what that plan includes, never its own Free
    const t = a.teamPlan;
    const inc = t.includes ?? a.includes;
    row("Plan", `${c.bold(clean(t.name, 20))}${c.gray(t.owner ? `  on ${clean(t.owner, 40)}'s team` : "  on your team")}`);
    row("Seat", t.source === "comp" ? "set up by GenClass for the team" : "paid for by the team's owner");
    row("Team apps", t.apps === null ? `${t.usedApps === null ? "" : `${n(t.usedApps)} ${sym.dot} `}no limit` : `${t.usedApps === null ? "" : `${n(t.usedApps)} of `}${n(t.apps)}`);
    if (t.historyDays !== null) row("History", `${n(t.historyDays)} days`);
    if (a.limits.suggestionsPerDay !== null) row("Model runs", `${n(a.used.suggestionsToday)} of ${n(a.limits.suggestionsPerDay)} used today ${sym.dot} suggest and ask share them`);
    const has = [inc.analytics && "visitor analytics", inc.forwarding && "alerts to Slack, Sentry and others", inc.export && "the stored events as a file", inc.privateRepositories && "private repositories"].filter(Boolean);
    if (has.length) row("Includes", has.join(", "));
    note("Apps you add go into the team's account, under its plan.");
  } else {
    row("Plan", `${c.bold(clean(a.plan.name, 20))}${a.plan.price && a.access !== "comp" ? c.gray(`  ${clean(a.plan.price, 40)}`) : ""}${a.access === "comp" ? c.gray("  set up by GenClass") : ""}`);
    const trial = a.subscription.status === "trialing" && a.access === "paid" && a.subscription.periodEnd;
    // the trial says that it is one, and when its first charge is (or that a canceled one charges nothing)
    if (trial) row("Trial", a.subscription.cancels ? `until ${day(a.subscription.periodEnd)}. Canceled: nothing is charged.` : `until ${day(a.subscription.periodEnd)}. Then the first charge, ${a.plan.price ? clean(a.plan.price, 40) : "the plan's price"}, unless you cancel before.`);
    else if (a.subscription.periodEnd && a.access === "paid") row(a.subscription.cancels ? "Ends" : "Renews", day(a.subscription.periodEnd));
    if (a.subscription.status && !["active", "trialing"].includes(a.subscription.status)) row("Payment", c.yellow(clean(a.subscription.status.replace(/_/g, " "), 30)));
    // GenClass's grants cover every app, whatever the plan's own number says
    row("Apps", a.limits.apps === null || a.access === "comp" ? `${n(a.used.apps)} ${sym.dot} no limit` : `${n(a.used.apps)} of ${n(a.limits.apps)}`);
    row("History", a.limits.historyDays === null ? "" : `${n(a.limits.historyDays)} days`);
    row("People", a.limits.seats === null ? `${n(a.used.seats)} ${sym.dot} no limit` : `${n(a.used.seats)} of ${n(a.limits.seats)}`);
    // without Pro neither suggest nor ask runs here: their model runs are Pro's
    if (pro) row("Model runs", "come with Pro (suggest and ask)");
    else if (a.limits.suggestionsPerDay !== null) row("Model runs", `${n(a.used.suggestionsToday)} of ${n(a.limits.suggestionsPerDay)} used today ${sym.dot} suggest and ask share them`);
    const has = [a.includes.analytics && "visitor analytics", a.includes.forwarding && "alerts to Slack, Sentry and others", a.includes.export && "the stored events as a file", a.includes.privateRepositories && "private repositories"].filter(Boolean);
    const lacks = [!a.includes.analytics && "visitor analytics", !a.includes.forwarding && "alerts to Slack, Sentry and others", !a.includes.export && "the stored events as a file", !a.includes.privateRepositories && "private repositories"].filter(Boolean);
    if (has.length) row("Includes", has.join(", "));
    if (lacks.length) row("Not included", lacks.join(", "));
  }
  // each app with its plan
  if (mine.length) {
    out();
    out(`  ${c.bold("Apps and their plans")}`);
    for (const p of mine) {
      const what = p.needsPlan ? c.yellow("needs a plan") : p.plan.id === "free" ? (p.planChosen ? c.gray("Free") : c.yellow("no plan chosen")) : c.bold(clean(p.plan.name, 20));
      out(`    ${clean(p.name, 24).padEnd(24)}  ${what}${p.token === state.app?.token ? c.gray("  this folder") : ""}`);
    }
  }
  if (pro) {
    await (await import("./paywall.mjs")).startPro(pro, state.account?.offer ?? (a.ok ? a.offer : null), { ...o, card: true, short: true }, deps);
    out();
    return 0;
  }
  if (!offer) {
    out();
    linkLine("Billing, in the browser", billingUrl);
    out();
    return 0;
  }
  if (offer.project) {
    await projectPlan(offer, o, deps);
    out();
    return 0;
  }
  planCard(offer, null);
  if (o.yes || !interactive()) {
    out(`  ${c.gray(`Start ${clean(offer.plan.name, 20)}:`)} ${c.cyan(offer.checkoutUrl)}`);
    out();
    return 0;
  }
  const dot = c.gray("·");
  const k = await typed(`  ${PROMPT()} ${c.bold("Enter")} ${c.gray(`to start ${clean(offer.plan.name, 20)}`)} ${dot} ${c.bold("q")} ${c.gray("stop")}  `);
  if (k === null || k !== "") {
    out();
    return 0;
  }
  await checkout(offer, o, deps);
  out();
  return 0;
}

// ------------------------------------------------------------------------------------- profile, upgrade, Free

/** Free's limits in a few words, from the numbers the server sent ("3 apps, 100 live fixes a month"). */
const freeWords = (free) =>
  [free?.apps ? `${free.apps} app${free.apps === 1 ? "" : "s"}` : null, free?.liveFixes ? `${free.liveFixes} live fixes a month` : null, free?.historyDays ? `${free.historyDays} days of history` : null].filter(Boolean).join(", ");

/**
 * The line after a command for an app on Free that can have a paid plan here: Free's limits and the way up. Printed
 * after every command of the home and at the end of a command run on its own (the owner's call, 2026-11-12). Nothing
 * for an app with a plan, signed out, or where nothing is sold. Returns whether it printed.
 */
export async function freeLine(o = {}, deps = {}) {
  let state;
  try {
    state = await readState({ cwd: o.cwd }, deps);
  } catch {
    return false;
  }
  if (!state.signedIn) return false;
  const cli = state.account?.cli ?? null;
  const offer = cli?.paid ? null : (state.account?.offer ?? upgradeOffer(state));
  if (!offer && !(cli && !cli.paid)) return false;
  const lim = offer ? freeWords(offer.free) : "";
  const name = clean(cli && !cli.paid ? cli.plan : offer.plan.name, 20);
  const price = clean((cli && !cli.paid ? cli.price : null) ?? offer?.price ?? "", 40);
  const days = cli && !cli.paid ? cli.trialDays : offer?.trialDays;
  // the genclass command is Pro's: Free is the website's (one app and its totals), and the line says so
  const [first = "", ...rest] = wrap(
    cli && !cli.paid
      ? `You are on Free${lim ? ` (${lim})` : ""}, on the website. Every genclass command comes with ${name}${days ? `, ${days} days free` : ""}: ${homeOpen() ? "type upgrade" : "npx genclass upgrade"}`
      : `You are on Free, which has limits${lim ? ` (${lim})` : ""}. ${name} has everything, ${days ? `${days} days free, then ${price}` : `for ${price}`}. Upgrade now: ${homeOpen() ? "type upgrade" : "npx genclass upgrade"}`,
    width() - 6,
  );
  out();
  out(`  ${c.yellow(sym.warn)} ${c.bold(first)}`);
  for (const l of rest) out(`    ${l}`);
  return true;
}

/**
 * `genclass upgrade`: a paid plan for this folder's app (--app for another), on its plan page in the browser: the
 * paid plan large and "Try for free (limited)" small. The terminal shows the plan's card and waits for the choice.
 */
export async function upgrade(o = {}, deps = {}) {
  const s = await signedIn(o, deps, "upgrade");
  if ("code" in s) return s.code;
  const { state } = s;
  // an account without Pro starts it here, for the whole account: the paywall the other commands show (paywall.mjs).
  // Until it is started this ends as they do: the needs_pro answer, exit code 1
  const cli = state.account?.cli ?? null;
  const paywall = await import("./paywall.mjs");
  if (cli && !cli.paid) {
    if (o.json) {
      out(JSON.stringify(paywall.needsProJson(cli, true, "upgrade")));
      return 1;
    }
    top(state);
    const started = await paywall.startPro(cli, state.account?.offer ?? null, { ...o, card: true }, deps);
    out();
    return started ? 0 : 1;
  }
  const billingUrl = state.account?.billingUrl ?? hostUrl("/account/billing");
  const here = (state.projects ?? []).find((p) => p.token === state.app?.token && p.plan && !p.shared) ?? null;
  // Pro already: an app past the ones it covers is Enterprise's (by email); nothing else is for sale here
  const paying = accountPaid(state.account);
  const full = paying && here?.needsPlan ? here : null;
  const offer = paying ? null : upgradeOffer(state, o.app ?? null);
  const viaTeam = cli?.via === "team" || state.account?.plan?.via === "team";
  if (o.json) {
    if (paying) out(JSON.stringify({ ok: true, paid: true, via: viaTeam ? "team" : (cli?.via ?? null), plan: state.account?.plan ?? null, app: here?.name ?? null, needs_plan: !!full, ...(full ? { error: "the plan covers no more apps: more come with Enterprise, by email", plan_url: full.planUrl } : {}), billing_url: billingUrl }));
    else out(JSON.stringify({ ok: true, app: offer?.project?.name ?? null, plan: offer?.plan ?? null, price: offer?.price ?? null, url: offer?.checkoutUrl ?? billingUrl }));
    return 0;
  }
  top(state);
  if (full) {
    warn(`Your plan covers no more apps, and ${clean(full.name, 30)} is one more. More apps come with Enterprise, by email.`);
    if (full.planUrl) {
      out(`  ${c.gray("The address, on its plan page:")}`);
      out(`    ${c.cyan(full.planUrl)}`);
    }
    out();
    return 0;
  }
  if (!offer) {
    if (paying) {
      good(viaTeam ? "You are on your team's Pro: there is nothing to upgrade." : `You are on ${clean(state.account?.plan?.id !== "free" ? (state.account?.plan?.name ?? "Pro") : "Pro", 20)}: there is nothing to upgrade.`);
      // a grant has no subscription and no seat count; a paid plan adds people as seats in Manage billing
      if (state.account?.plan?.source === "comp") note("Set up by GenClass: it covers every app, with no seats to add.");
      else if (!viaTeam) note("More people on it: add seats in Manage billing, on the billing page.");
    } else if (here && here.plan.id !== "free") good(`${clean(here.name, 30)} is on ${clean(here.plan.name, 20)}.`);
    else note("Nothing to upgrade here: genclass.dev sells nothing here.");
    out(`  ${c.gray("Billing, in the browser")}`);
    out(`    ${c.cyan(billingUrl)}`);
    out();
    return 0;
  }
  if (offer.project) await projectPlan(offer, o, deps);
  else {
    planCard(offer, null);
    if (o.yes || !interactive()) out(`  ${c.gray(`Start ${clean(offer.plan.name, 20)}:`)} ${c.cyan(offer.checkoutUrl)}`);
    else await checkout(offer, o, deps);
  }
  out();
  return 0;
}

/**
 * `genclass profile`: who is signed in, the plan of each app, and what can be done about it, as numbered choices:
 * upgrade an app on Free, billing in the browser, sign out.
 */
export async function profile(o = {}, deps = {}) {
  const s = await signedIn(o, deps, "profile");
  if ("code" in s) return s.code;
  const { state } = s;
  const mine = (state.projects ?? []).filter((p) => p.plan && !p.shared);
  const cli = state.account?.cli ?? null;
  const pro = cli && !cli.paid ? cli : null;
  const offer = pro ? null : upgradeOffer(state, o.app ?? null);
  const billingUrl = state.account?.billingUrl ?? hostUrl("/account/billing");
  // a team's member: the overview names the team's plan (via "team"), a seat its owner pays for
  const viaTeam = state.account?.plan?.via === "team" || cli?.via === "team";
  const onFree = !viaTeam && (state.account?.plan?.id === "free" || (mine.length > 0 && mine.every((p) => p.plan.id === "free")));
  if (o.json) {
    out(JSON.stringify({ ok: true, account: state.account?.label ?? null, plan: state.account?.plan ?? null, apps: mine.map((p) => ({ id: p.id, name: p.name, plan: p.plan, needs_plan: p.needsPlan })), upgrade_url: pro?.checkoutUrl ?? offer?.checkoutUrl ?? null, trial_days: pro?.trialDays ?? offer?.trialDays ?? null, price: pro?.price ?? offer?.price ?? null, team_plan: state.account?.teamPlan ?? null, cli: cli ? { paid: cli.paid, ...(cli.paid && cli.via ? { via: cli.via } : {}) } : null, billing_url: billingUrl }));
    return 0;
  }
  top(state);
  out(`  ${c.bold("Profile")}`);
  row("Signed in as", clean(state.account?.label ?? "", 60));
  row("Plan", onFree ? `Free ${c.gray(pro ? "(website only: the genclass command comes with Pro)" : "(limited)")}` : `${c.bold(clean(state.account?.plan?.name ?? "", 20))}${viaTeam ? c.gray(state.account?.plan?.source === "comp" ? "  on your team: set up by GenClass" : "  on your team: a seat its owner pays for") : state.account?.plan?.source === "comp" ? c.gray("  set up by GenClass") : ""}`);
  if (mine.length) {
    out();
    out(`  ${c.bold("Apps and their plans")}`);
    for (const p of mine) {
      const what = p.needsPlan ? c.yellow("needs a plan") : p.plan.id === "free" ? (p.planChosen ? c.gray("Free") : c.yellow("no plan chosen")) : c.bold(clean(p.plan.name, 20));
      out(`    ${clean(p.name, 24).padEnd(24)}  ${what}${p.token === state.app?.token ? c.gray("  this folder") : ""}`);
    }
  }
  const choices = [];
  if (pro) choices.push([`${pro.trialDays ? `Start the ${pro.trialDays}-day free trial` : `Start ${clean(pro.plan, 20)}`}  ${c.gray(clean(pro.price ?? "", 40))}`, "npx genclass upgrade", () => upgrade(o, deps)]);
  if (offer) choices.push([`Upgrade ${offer.project ? clean(offer.project.name, 20) : "to"} ${offer.project ? `to ${clean(offer.plan.name, 20)}` : clean(offer.plan.name, 20)}  ${c.gray(clean(offer.price, 40))}`, "npx genclass upgrade", () => upgrade({ ...o, app: offer.project?.id ?? o.app }, deps)]);
  choices.push(["Billing, in the browser", billingUrl, () => (openBrowser(billingUrl, o) ? note("Your browser is opening billing.") : out(`  ${c.cyan(billingUrl)}`))]);
  choices.push(["Sign out", "npx genclass logout", async () => (await import("../../runtime/bin/lib/login.mjs")).run("logout", [])]);
  out();
  if (o.yes || !interactive()) {
    for (const [label, cmd] of choices) {
      out(`    ${label}`);
      out(`      ${c.cyan(cmd)}`);
    }
    out();
    return 0;
  }
  choices.forEach(([label], i) => out(`  ${c.gray(String(i + 1).padStart(2))}  ${label}`));
  out();
  const a = await typed(`  ${PROMPT()} ${c.gray("a number ·")} ${c.bold("q")} ${c.gray("stop")}  `);
  const pick = a !== null && /^\d+$/.test(a.trim()) ? choices[Number(a.trim()) - 1] : null;
  if (pick) {
    const r = await pick[2]();
    if (typeof r === "number") return r;
  }
  out();
  return 0;
}

// ------------------------------------------------------------------------------------------------------ team

/** `genclass team`: who is on the plan. `genclass team invite` makes a single-use invite link. */
export async function team(o = {}, deps = {}) {
  const s = await signedIn(o, deps, "team");
  if ("code" in s) return s.code;
  const { state, creds } = s;
  const billing = state.account?.billingUrl ?? hostUrl("/account/billing");
  // a member works on a paying team's plan: invites and seats are that team's owner's
  const member = state.account?.cli?.via === "team" || state.account?.plan?.via === "team";
  if ((o.args ?? [])[0] === "invite") {
    if (member) {
      if (o.json) out(JSON.stringify({ ok: false, error: "invites come from the team's owner: ask them for a link", member: true }));
      else {
        top(state);
        warn("Invites come from the team's owner: ask them for a link.");
        note(state.account?.plan?.source === "comp" ? "Your seat is on their team's plan, set up by GenClass." : "Your seat is on their team, and they add seats in Manage billing.");
        out();
      }
      return 1;
    }
    const r = await asking(o, creds, (cr) => createInvite(cr, deps), deps);
    // on Pro, a refusal for the plan is a full team: seats are added in Manage billing, not by another plan
    if (!r.ok && r.upgradeUrl && !r.needsPro && accountPaid(state.account)) {
      if (o.json) out(JSON.stringify({ ok: false, error: "every seat is taken: add seats in Manage billing", billing_url: billing }));
      else {
        top(state);
        seatsFull(billing);
      }
      return 1;
    }
    if (!r.ok) {
      if (!o.json) top(state);
      return refused(r, { what: "A team", command: "team invite", browserUrl: billing, json: o.json });
    }
    if (o.json) out(JSON.stringify({ ok: true, url: r.url, expires: r.expires }));
    else {
      top(state);
      good("An invite link, for one person:");
      out(`    ${c.cyan(r.url)}`);
      note(`It works once${r.expires ? `, until ${day(r.expires)}` : ""}, and is shown only now. Whoever opens it signs in and joins your team: they can open your apps' dashboards, not change them.`);
      out();
    }
    return 0;
  }
  const a = await asking(o, creds, (cr) => fetchAccount(cr, deps), deps);
  if (!a.ok) {
    if (!o.json) top(state);
    return refused(a, { what: "The team", command: "team", browserUrl: billing, json: o.json });
  }
  if (o.json) {
    out(JSON.stringify({ ok: true, plan: a.plan, ...a.team }, null, 2));
    return 0;
  }
  top(state);
  const t = a.team;
  // a member of a paying team (its own account is Free, with no team of its own): the team it is on, its paid seat
  if (a.teamPlan && a.teamPlan.id !== a.plan.id && t.used <= 1 && !t.members.length) {
    const tp = a.teamPlan;
    out(`  ${c.bold("Team")}  ${c.gray(`${clean(tp.name, 20)}, on ${clean(tp.owner ?? "your team's owner", 50)}'s team`)}`);
    for (const m of t.memberships) out(`    ${clean(m.label, 50)}  ${c.gray(`owner${m.active ? "" : ` ${sym.dot} your seat is not active`}`)}`);
    const granted = tp.source === "comp";
    out(`    ${clean(state.account?.label ?? "you", 50)}  ${c.gray(granted ? "you, on a plan GenClass set up" : "you, a seat the owner pays for")}`);
    out();
    note(granted ? "The owner invites people. Apps you add go into the team's account." : "The owner invites people and adds seats in Manage billing. Apps you add go into the team's account.");
    out();
    return 0;
  }
  out(`  ${c.bold("Team")}  ${c.gray(t.seats === null ? `${n(t.used)} ${t.used === 1 ? "person" : "people"}` : `${n(t.used)} of ${n(t.seats)} seat${t.seats === 1 ? "" : "s"} used`)}`);
  out(`    ${clean(state.account?.label ?? "you", 50)}  ${c.gray("owner")}`);
  for (const m of t.members) out(`    ${clean(m.label, 50)}  ${c.gray(`${m.joined ? `joined ${ago(m.joined, deps.now)}` : "member"}${m.active ? "" : ` ${sym.dot} over the seats, cannot open dashboards`}`)}`);
  for (const i of t.invites) out(`    ${c.gray(`an invite link is open${i.expires ? ` until ${day(i.expires)}` : ""}`)}`);
  for (const m of t.memberships) out(`  ${c.gray("You are also in the team of")} ${clean(m.label, 50)}${m.active ? "" : c.gray(" (not active)")}`);
  out();
  if (t.seats !== null && t.seats <= t.used && (a.access === "paid" || a.plan.id !== "free")) seatsFull(billing, t.seats);
  else if (t.seats !== null && t.seats <= 1) {
    out(`  ${c.bold(`${clean(a.plan.name, 20)} is for one person.`)}`);
    note("A team comes with Pro: everyone you invite opens the same dashboards.");
    out(`    ${c.cyan("npx genclass upgrade")}`);
  } else {
    out(`  ${c.gray("Invite someone:")} ${c.cyan("npx genclass team invite")}`);
    out(`  ${c.gray(t.seats === null ? "Remove someone or change your plan, in the browser:" : "Remove someone or add seats, in the browser:")}`);
    out(`    ${c.cyan(billing)}`);
  }
  out();
  return 0;
}

/** A paid plan whose seats are all taken (one seat: the buyer's): more people come with more seats, in Manage billing. */
function seatsFull(billing, seats = null) {
  out(`  ${c.bold(seats === 1 ? "Your plan has one seat, yours." : "Every seat of your plan is taken.")}`);
  note("Add seats in Manage billing, then invite your team: npx genclass team invite");
  out(`    ${c.cyan(billing)}`);
}

// ----------------------------------------------------------------------------------------------- connections

/** The destinations: [kind, name, [field, what is asked, hidden]]. */
export const DESTINATIONS = {
  slack: ["Slack", [["url", "Slack incoming webhook URL", true]]],
  sentry: ["Sentry", [["dsn", "Sentry DSN (Client Keys page)", true]]],
  posthog: ["PostHog", [["key", "PostHog project API key", true], ["host", "PostHog host: us, eu or your own https address (Enter: us)", false]]],
  datadog: ["Datadog", [["api_key", "Datadog API key", true], ["site", "Datadog site (Enter: datadoghq.com)", false]]],
  webhook: ["Webhook", [["url", "Webhook URL (https)", true]]],
};
const destName = (k) => DESTINATIONS[k]?.[0] ?? k;
const POSTHOG = { us: "https://us.i.posthog.com", eu: "https://eu.i.posthog.com" };

/**
 * `genclass connections`: where the app's alerts go, the GitHub App, the coding agent and the private link.
 * `genclass connections add|test|on|off|remove <slack|sentry|posthog|datadog|webhook>` changes one destination.
 */
export async function connections(o = {}, deps = {}) {
  const picked = await pickApp(o, deps, ["connections", ...(o.args ?? [])].join(" "));
  if ("code" in picked) return picked.code;
  const { state, creds, target } = picked;
  const dash = target.dashboard_url ?? hostUrl("/account");
  const [sub, kindRaw] = o.args ?? [];
  const ctx = (what) => ({ what, command: `connections${sub ? ` ${sub}${kindRaw ? ` ${kindRaw}` : ""}` : ""}`, browserUrl: dash, json: o.json });
  if (target.shared) {
    if (o.json) out(JSON.stringify({ ok: false, error: "this app is its owner's to change" }));
    else {
      top(state, target);
      note(`${clean(target.name, 40)} belongs to a team you are a member of. Where its alerts go is its owner's to see and change.`);
      out();
    }
    return 1;
  }
  if (sub) {
    const kind = String(kindRaw ?? "").toLowerCase();
    const how = { add: "set", set: "set", test: "test", on: "on", off: "off", remove: "remove", delete: "remove" }[sub];
    if (!how || !DESTINATIONS[kind]) {
      if (o.json) out(JSON.stringify({ ok: false, error: "usage: connections add|test|on|off|remove <kind>", kinds: Object.keys(DESTINATIONS) }));
      else {
        top(state, target);
        warn(how ? `Which one? ${Object.keys(DESTINATIONS).join(", ")}` : `There is no "connections ${clean(sub, 20)}".`);
        out(`    ${c.cyan(`npx genclass connections add ${Object.keys(DESTINATIONS).join(" | ")}`)}`);
        out(`    ${c.cyan("npx genclass connections test | on | off | remove <one of them>")}`);
        out();
      }
      return 2;
    }
    let fields = {};
    if (how === "set") {
      if (!interactive() || o.json) {
        if (o.json) out(JSON.stringify({ ok: false, error: "setting up a destination asks for its address or key on a terminal" }));
        else {
          top(state, target);
          note(`Setting up ${destName(kind)} asks for its address or key, so it needs a terminal. In the browser: ${dash}`);
          out();
        }
        return 1;
      }
      top(state, target);
      // the plan first: nobody is asked for a key that their plan cannot use
      const can = await asking(o, creds, (cr) => fetchConnections(cr, target.id, deps), deps);
      if (!can.ok) return refused(can, ctx("Sending alerts"));
      if (!can.forwarding) return refused({ ok: false, upgradeUrl: can.upgradeUrl ?? hostUrl("/account/billing") }, { ...ctx("Sending alerts"), plan: can.plan });
      out(`  ${c.bold(`Send ${clean(target.name, 40)}'s new problems to ${destName(kind)}`)}`);
      note("Each new likely problem is sent once per kind and page an hour. What you type next is not shown, goes to genclass.dev over HTTPS, is stored encrypted there, and is not kept on this machine.");
      for (const [field, label, hidden] of DESTINATIONS[kind][1]) {
        const v = await (hidden ? secret : typed)(`  ${PROMPT()} ${label}: `);
        if (v === null) return 1;
        if (!v && hidden) {
          warn("Nothing typed, so nothing was changed.");
          out();
          return 1;
        }
        if (v) fields[field] = field === "host" ? (POSTHOG[v.toLowerCase()] ?? v) : v;
      }
    } else if (!o.json) top(state, target);
    if (how === "remove" && !o.yes && interactive() && !(await agree(`Stop sending to ${destName(kind)} and forget its settings?`, false))) {
      out();
      return 0;
    }
    const sp = o.json ? null : spinner(how === "test" ? `Sending a test record to ${destName(kind)}` : "Saving");
    const r = await asking(o, creds, (cr) => changeConnection(cr, target.id, kind, how, fields, deps), deps);
    sp?.stop(null);
    if (!r.ok) return refused(r, { ...ctx(how === "test" ? `The test to ${destName(kind)}` : "Sending alerts"), plan: null });
    if (o.json) {
      out(JSON.stringify({ ok: true, kind, done: how, ...(r.summary ? { summary: r.summary } : {}), ...(r.secret ? { secret: r.secret } : {}) }));
      return 0;
    }
    good({ set: `${destName(kind)} is set up${r.summary ? `: ${clean(r.summary, 80)}` : ""}.`, test: `A test record reached ${destName(kind)}.`, on: `${destName(kind)} is on.`, off: `${destName(kind)} is off. Its settings are kept.`, remove: `${destName(kind)} is removed.` }[how]);
    if (r.secret) {
      out(`  ${c.gray("Signing secret, shown once:")} ${c.bold(r.secret)}`);
      note("Each request carries a signature made with it, so your server can check the request is GenClass's.");
    }
    if (how === "set") {
      if (await agree("Send a test record now?")) {
        const t = await changeConnection(readCredentialsFor().creds ?? creds, target.id, kind, "test", {}, deps);
        if (t.ok) good(`A test record reached ${destName(kind)}.`);
        else warn(`The test did not arrive: ${clean(t.reason ?? "", 200)}`);
      }
    }
    out();
    return 0;
  }

  const r = await asking(o, creds, (cr) => fetchConnections(cr, target.id, deps), deps);
  const here = state.app.token === target.token;
  const agentHere = here ? agentSetup(state.cwd, deps.home) : null;
  const gh = here ? state.steps.find((x) => x.id === "github-app") : null;
  // the genclass command is Pro's: an account without it is told where Pro starts, and nothing else
  if (!r.ok && r.needsPro) {
    if (!o.json) top(state, target);
    return refused(r, { what: "Alerts", command: "connections", json: o.json });
  }
  if (o.json) {
    out(JSON.stringify({ ok: true, app: target.name, alerts: r.ok ? { in_plan: r.forwarding, destinations: r.list } : { error: r.reauth ? "sign in again" : r.reason }, private_link: r.ok ? r.privateLink : null, github_app: gh ? { state: gh.state, detail: gh.detail ?? null } : null, coding_agent: agentHere }, null, 2));
    return 0;
  }
  top(state, target);
  out(`  ${c.bold("Alerts")}`);
  out(`    ${c.gray("Each new problem, sent where your team already looks.")}`);
  if (!r.ok) {
    if (r.reauth) note("To see them: npx genclass login, once (this sign-in is from before the command could show them).");
    else if (r.missing) note("This genclass.dev cannot show them in the terminal yet.");
    else note(`Could not read them: ${clean(r.reason ?? "", 200)}`);
  } else {
    const set = new Map(r.list.map((x) => [x.kind, x]));
    const kinds = r.kinds.length ? r.kinds : Object.keys(DESTINATIONS);
    for (const k of kinds) {
      const x = set.get(k);
      if (!x) {
        out(`    ${destName(k).padEnd(9)}${c.gray("not set up")}`);
        continue;
      }
      out(`    ${c.bold(destName(k).padEnd(9))}${x.enabled ? c.green("on ") : c.yellow("off")}  ${c.gray(clean(x.summary, room() - 20))}`.trimEnd());
      const tail = [x.lastSent ? `last sent ${ago(x.lastSent, deps.now)}` : "nothing sent yet", x.lastError ? `last error: ${clean(x.lastError, 80)}` : ""].filter(Boolean).join(` ${sym.dot} `);
      for (const l of wrap(tail, room() - 13)) out(`    ${" ".repeat(9)}${x.lastError ? c.yellow(l) : c.gray(l)}`);
    }
    if (!r.forwarding) {
      out();
      out(`  ${c.bold(`Alerts come with the ${clean(r.plan ?? "Pro", 20)} plan.`)}  ${c.cyan("npx genclass plan")}`);
    } else {
      out();
      out(`  ${c.gray("Set one up:")} ${c.cyan("npx genclass connections add slack")}`);
      out(`  ${c.gray("Also sentry, posthog, datadog, webhook.")}`);
      out(`  ${c.gray("In place of add: test, on, off, remove.")}`);
    }
  }
  out();
  if (gh) row("GitHub App", gh.state === "done" ? clean(gh.detail ?? "connected", 80) : gh.state === "optional" ? c.gray("not used in this project") : `${c.gray(clean(gh.detail ?? "not connected yet", 60))} ${sym.dot} npx genclass setup`, 14);
  if (agentHere) row("Coding agent", agentHere.files.length ? `connected ${sym.dot} production numbers ${agentHere.production ? "on" : "off: npx genclass agent link"}` : "not connected yet: npx genclass setup", 14);
  if (r.ok) row("Private link", r.privateLink ? `on ${sym.dot} whoever has it can read this app's numbers` : "off", 14);
  out();
  return 0;
}

// ---------------------------------------------------------------------------------------------------- export

const DAY = 86_400_000;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";

/**
 * `genclass export`: the app's stored events, as the collector kept them, into a file (JSON Lines, or CSV with
 * --format csv). --from and --to are days (2026-11-01), both included; the default is the last 7 days. --out names
 * the file, `--out -` writes to the terminal or a pipe.
 */
export async function exportEvents(o = {}, deps = {}) {
  const picked = await pickApp(o, deps, "export");
  if ("code" in picked) return picked.code;
  const { state, creds, target } = picked;
  const format = o.format === "csv" ? "csv" : "jsonl";
  const now = deps.now ?? Date.now();
  const to = o.to ?? new Date(now).toISOString().slice(0, 10);
  const from = o.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
  const toStd = o.out === "-";
  const quiet = toStd || o.json;
  if (!isDay(from) || !isDay(to) || from > to || (o.format && !["csv", "jsonl"].includes(o.format))) {
    if (o.json) out(JSON.stringify({ ok: false, error: "--from and --to are days like 2026-11-01, --from on or before --to; --format is jsonl or csv" }));
    else {
      top(state, target);
      warn("--from and --to are days like 2026-11-01, with --from on or before --to; --format is jsonl or csv.");
      out(`    ${c.cyan("npx genclass export --from 2026-11-01 --to 2026-11-07 --format csv")}`);
      out();
    }
    return 2;
  }
  if (!quiet) top(state, target);
  // the server's `to` is exclusive: the day after the last one wanted
  const q = { from, to: new Date(Date.parse(`${to}T00:00:00Z`) + DAY).toISOString().slice(0, 10), format };
  const sp = quiet ? null : spinner(`Reading ${clean(target.name, 40)}'s events, ${from} to ${to}`);
  const parts = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const r = await (pages ? fetchEvents(readCredentialsFor().creds ?? creds, target.id, { ...q, cursor }, deps) : asking(o, creds, (cr) => fetchEvents(cr, target.id, q, deps), deps));
    if (!r.ok) {
      sp?.stop(null);
      if (toStd && !o.json) {
        process.stderr.write(`genclass export: ${r.reauth ? "sign in again: npx genclass login" : r.upgradeUrl ? "the stored events as a file come with Pro: npx genclass plan" : (r.reason ?? "it did not work")}\n`);
        return 1;
      }
      return refused(r, { what: "The stored events as a file", command: ["export", o.from ? `--from ${o.from}` : "", o.to ? `--to ${o.to}` : "", o.format ? `--format ${o.format}` : "", o.out ? `--out ${o.out}` : ""].filter(Boolean).join(" "), browserUrl: target.dashboard_url, json: o.json });
    }
    parts.push(r.text);
    pages++;
    sp?.update(`Reading ${clean(target.name, 40)}'s events: ${n(pages)} page${pages === 1 ? "" : "s"}`);
    if (!r.next || pages >= 500) break;
    cursor = r.next;
  }
  const text = parts.join("");
  const lines = text ? text.split("\n").filter(Boolean).length - (format === "csv" ? 1 : 0) : 0;
  if (toStd) {
    // as bytes: the data is not this program's text, so nothing in it is reworded on its way out (name.mjs)
    process.stdout.write(Buffer.from(text, "utf8"));
    return 0;
  }
  const name = o.out ?? `genclass-${slug(target.name)}-${from}-${to}.${format}`;
  const file = resolve(o.cwd ?? process.cwd(), String(name));
  if (!lines) {
    sp?.stop(null);
    if (o.json) out(JSON.stringify({ ok: true, events: 0, file: null }));
    else {
      note(`No events stored for ${from} to ${to}. Events are kept for the export from the day the app's plan has it.`);
      out();
    }
    return 0;
  }
  try {
    writeFileSync(file, text);
  } catch (e) {
    sp?.stop(null);
    if (o.json) out(JSON.stringify({ ok: false, error: `could not write ${name}: ${e?.message ?? e}` }));
    else {
      bad(`Could not write ${clean(String(name), 80)}: ${e?.message ?? e}`);
      out();
    }
    return 1;
  }
  sp?.stop(null);
  if (o.json) out(JSON.stringify({ ok: true, events: Math.max(0, lines), file, from, to, format }));
  else {
    good(`Wrote ${c.bold(clean(String(name), 80))}`);
    note(`${n(Math.max(0, lines))} events, ${from} to ${to}, ${Math.max(1, Math.round(text.length / 1024))} KB. Each line is one event as GenClass stored it, with its page load, the runtime's version and when it arrived.`);
    out();
  }
  return 0;
}

// --------------------------------------------------------------------------------------------------- funnels

/**
 * `genclass funnels`: the app's funnels. `genclass funnels add "Name" /a /b /c` adds one (2 to 6 pages, in order;
 * a page ending in * matches everything that starts with it); `genclass funnels remove "Name"` removes one.
 */
export async function funnels(o = {}, deps = {}) {
  const picked = await pickApp(o, deps, ["funnels", ...(o.args ?? []).map((w) => (/\s/.test(w) ? `"${w}"` : w))].join(" "));
  if ("code" in picked) return picked.code;
  const { state, creds, target } = picked;
  const [sub, name, ...steps] = o.args ?? [];
  const app = await fetchApp(creds, target.id, "7d", deps);
  if (!o.json) top(state, target);
  if (!app.ok) return refused(app, { what: "The funnels", command: "funnels", browserUrl: target.dashboard_url, json: o.json });
  if (app.visitorsPlan) return refused({ ok: false, upgradeUrl: app.visitorsPlan.upgradeUrl ?? hostUrl("/account/billing") }, { what: "Funnels (part of visitor analytics)", command: "funnels", plan: app.visitorsPlan.plan, json: o.json });
  const current = app.more.funnels.map((f) => ({ name: f.name, steps: f.steps }));
  if (!sub) {
    if (o.json) out(JSON.stringify({ ok: true, app: target.name, funnels: app.more.funnels }, null, 2));
    else {
      if (!current.length) note("No funnel yet. A funnel is a list of pages in order; it counts the visits that reach each one.");
      for (const f of app.more.funnels) {
        out(`  ${c.bold(clean(f.name, 60))}`);
        f.steps.forEach((step, i) => out(`    ${c.cyan(clean(step, room() - 30))}  ${c.bold(n(f.counts[i] ?? 0))}${i && f.counts[0] ? c.gray(`  ${Math.round(((f.counts[i] ?? 0) / f.counts[0]) * 100)}% of step 1`) : ""}`));
      }
      out();
      out(`  ${c.gray("Add:   ")} ${c.cyan('npx genclass funnels add "Checkout" /cart /checkout /thanks')}`);
      if (current.length) out(`  ${c.gray("Remove:")} ${c.cyan(`npx genclass funnels remove "${clean(current[0].name, 40)}"`)}`);
      out();
    }
    return 0;
  }
  let next;
  if (sub === "add" && name && steps.length >= 2) next = [...current.filter((f) => f.name.toLowerCase() !== name.toLowerCase()), { name, steps }];
  else if ((sub === "remove" || sub === "delete") && name && current.some((f) => f.name.toLowerCase() === name.toLowerCase())) next = current.filter((f) => f.name.toLowerCase() !== name.toLowerCase());
  else {
    const said = sub === "add" ? "A funnel needs a name and at least two pages, in order." : sub === "remove" || sub === "delete" ? `No funnel named "${clean(name ?? "", 40)}".` : `There is no "funnels ${clean(sub, 20)}".`;
    if (o.json) out(JSON.stringify({ ok: false, error: said }));
    else {
      warn(said);
      out(`    ${c.cyan('npx genclass funnels add "Checkout" /cart /checkout /thanks')}`);
      out();
    }
    return 2;
  }
  const r = await asking(o, creds, (cr) => saveFunnels(cr, target.id, next, deps), deps);
  if (!r.ok) return refused(r, { what: "Funnels (part of visitor analytics)", command: ["funnels", sub, name ? `"${name}"` : "", ...steps].filter(Boolean).join(" "), browserUrl: target.dashboard_url, json: o.json });
  if (o.json) out(JSON.stringify({ ok: true, funnels: r.funnels }));
  else {
    good(sub === "add" ? `Saved the funnel ${c.bold(clean(name, 60))}: ${steps.map((x) => clean(x, 30)).join(` ${sym.arrow} `)}` : `Removed the funnel ${c.bold(clean(name, 60))}.`);
    if (sub === "add") note("It counts the visits that started in the period: npx genclass analytics funnels");
    out();
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------ agent link

/** The Claude Code command that gives the MCP server the link, in the person's own settings (not .mcp.json). */
export const claudeAdd = (url) => ["mcp", "add", "genclass", "-e", `GENCLASS_DASHBOARD=${url}`, "-e", "GENCLASS_REPORT=on", "--", ...[mcpServer().command, ...mcpServer().args]];

/**
 * `genclass agent link`: gives the coding agent the app's production numbers. It makes the app's private dashboard
 * link (an earlier one stops working) and hands it to GenClass's MCP server as GENCLASS_DASHBOARD, in the person's
 * own agent settings, never in a file of the repository.
 * @param {{ run?: Function, find?: Function, copy?: Function }} [deps]
 */
export async function agentLink(o = {}, deps = {}) {
  const picked = await pickApp(o, deps, "agent link");
  if ("code" in picked) return picked.code;
  const { state, creds, target } = picked;
  if (!o.json) top(state, target);
  if (target.shared) {
    if (o.json) out(JSON.stringify({ ok: false, error: "this app is its owner's to change" }));
    else {
      note(`${clean(target.name, 40)} belongs to a team you are a member of: its owner makes its link.`);
      out();
    }
    return 1;
  }
  if (!o.json) {
    out(`  ${c.bold("Give your coding agent the live site's numbers")}`);
    note(`This makes a private link to ${clean(target.name, 40)}'s dashboard and gives it to GenClass's MCP server, so the agent can read what was found in production and report what it fixes. A link made before stops working. Anyone with the link can read this app's numbers, so it goes into your own agent settings, not into the repository.`);
    if (!o.yes) {
      if (!interactive()) {
        note("Not a terminal: add --yes to make the link.");
        out();
        return 1;
      }
      if (!(await agree("Make the link?"))) {
        out();
        return 0;
      }
    }
  } else if (!o.yes) {
    out(JSON.stringify({ ok: false, error: "this replaces the app's private link: add --yes" }));
    return 1;
  }
  const r = await asking(o, creds, (cr) => makeAgentLink(cr, target.id, deps), deps);
  if (!r.ok) return refused(r, { what: "The agent link", command: "agent link", browserUrl: target.dashboard_url, json: o.json });
  const args = claudeAdd(r.url);
  const line = `claude ${args.join(" ")}`;
  if (o.json) {
    out(JSON.stringify({ ok: true, dashboard_url: r.url, env: { GENCLASS_DASHBOARD: r.url, GENCLASS_REPORT: "on" }, claude_code: line }));
    return 0;
  }
  good("The link is made. It is shown only now:");
  out(`    ${c.cyan(r.url)}`);
  const claude = (deps.find ?? onPath)("claude");
  if (claude && interactive() && (await agree("Add it to Claude Code on this machine (your own settings, not .mcp.json)?"))) {
    const code = await (deps.run ?? runQuiet)(claude, args, state.cwd);
    if (code === 0) {
      good("Claude Code has it for this folder. Restart Claude Code here, then ask it for this app's production numbers.");
      out();
      return 0;
    }
    warn("Claude Code did not take it. By hand, in this folder:");
  } else note("For Claude Code, run this in the project folder (it stays in your own settings):");
  for (const l of wrap(line, room() - 4)) out(`    ${c.cyan(l)}`);
  note("For another agent, set GENCLASS_DASHBOARD to the link and GENCLASS_REPORT to on in the genclass server's env, in your own settings file (for Cursor: ~/.cursor/mcp.json).");
  if (await (deps.copy ?? copyText)(line)) note("The command is on your clipboard.");
  out();
  return 0;
}

/** Runs a command with nothing shown. Resolves its exit code (1 when it did not start). */
async function runQuiet(cmd, args, cwd) {
  const { spawn } = await import("node:child_process");
  return new Promise((done) => {
    try {
      const child = spawn(cmd, args, { cwd, stdio: "ignore" });
      child.on("error", () => done(1));
      child.on("close", (code) => done(code ?? 1));
    } catch {
      done(1);
    }
  });
}
