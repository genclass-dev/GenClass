// The genclass command is Pro's (the owner's call, 2026-11-13: "let's make the entire CLI paid"). Every command but
// the sign-in's, the plan's, help and remove asks genclass.dev first whether the account has Pro (paid, in its
// trial, GenClass's grant, or a place in a paying team) and, without it, shows the one way on: Pro, its free trial
// first (the card is asked for up front, on Stripe), started in the browser. There is no Free in the terminal: the
// website keeps Free.
//
// Invariants:
// - Signed out, the sign-in comes first and the plan right after it: the first thing a new person does is sign in
//   and start the trial.
// - The answer is genclass.dev's (`cli` in GET /api/cli/overview, api.mjs cliOf). A server that does not say (an
//   older or self-hosted one) locks nothing, and neither does one that cannot be reached: its own routes refuse
//   what is Pro's (402) when it is back.
// - The command never says to go back to the terminal: it opens the checkout, waits for the payment itself and goes
//   on with the command that was asked for.
// - Without a terminal (--yes, --json, a coding agent) nothing is opened and nothing waits: one line with the
//   checkout address, and exit code 1.
// - Asked once per process: once Pro is seen, the home's commands (home.mjs) go on without asking again. The home's
//   commands pass this gate like any other (the home can be opened before the sign-in, by q).

import { readCredentials } from "../../runtime/bin/lib/account.mjs";
import { accountLabel } from "../../runtime/bin/lib/init.mjs";
import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { fetchOverview } from "./api.mjs";
import { clean, homeOpen, note, planCard, PROMPT, typed, warn } from "./tui.mjs";

let seen = false;
// the card was shown in this process (the home): a later command that needs Pro gets one line, not the card again
let cardShown = false;
// the last command was stopped by the gate: the home's after-command line (manage.mjs freeLine) is not said again
let refused = false;

/** For tests: forget that Pro was seen in this process. */
export const forgetPro = () => {
  seen = false;
  cardShown = false;
  refused = false;
};

/** Whether the last gate stopped its command (read by the home after each command, then reset with resetRefused). */
export const wasRefused = () => refused;
export const resetRefused = () => {
  refused = false;
};

/** Whether this process has seen the account's Pro (the gate passed, or Pro was started here). */
export const proSeen = () => seen;

/**
 * Tells the runtime CLI's modules (init, connect) where a new app of this account goes, for the lines that say so:
 * a member of a paying team with no plan of their own adds apps to the team's account (genclass.dev puts them
 * there), not to their own. `who`: { plan, cli, teamPlan } from the overview (api.mjs fetchOverview, state.mjs).
 */
export function noteAccount(who) {
  const host = globalThis.__GENCLASS_CLI__;
  if (!host || typeof host !== "object" || !who) return;
  const member = who.plan?.via === "team" || who.cli?.via === "team" || (!!who.teamPlan && (!who.plan || who.plan.id === "free"));
  host.into = member ? "your team's account" : null;
}

/**
 * The one JSON answer for an account without Pro, whichever part of the command gives it (the gate, a route's 402,
 * `upgrade`): what is needed, where it starts, and the command that starts it. Signed out, the sign-in comes first.
 * @param {{ plan?: string, price?: string | null, trialDays?: number | null, checkoutUrl?: string } | null} cli
 */
export function needsProJson(cli, signedIn = true, from = null) {
  return {
    ok: false,
    error: "the genclass command comes with Pro",
    needs_pro: true,
    signed_in: signedIn,
    plan: cli?.plan ?? "Pro",
    price: cli?.price ?? null,
    trial_days: cli?.trialDays ?? null,
    checkout_url: cli?.checkoutUrl ?? null,
    // `upgrade` itself points at the checkout (opened in a browser), never at itself
    run: !signedIn ? "npx genclass login" : from === "upgrade" ? null : "npx genclass upgrade",
    ...(signedIn && from === "upgrade" ? { next: "open checkout_url in a browser to start the trial" } : {}),
  };
}

/**
 * What the paywall shows for an account without Pro: the server's plan card (its offer, in genclass.dev's words)
 * with the trial and checkout of `cli`.
 * @param {{ plan: string, price: string | null, trialDays: number | null, checkoutUrl: string }} cli
 * @param {object | null} offer the overview's `offer` (api.mjs offerOf), for the summary and the lines of the card
 */
export function proOffer(cli, offer) {
  return {
    plan: { name: cli.plan },
    price: cli.price ?? offer?.price ?? "",
    summary: offer?.summary ?? null,
    // an account whose trial is used has none left: the card does not promise one
    features: (offer?.features ?? []).filter((f) => cli.trialDays || !/days? free/i.test(f)),
    trialDays: cli.trialDays,
    checkoutUrl: cli.checkoutUrl,
  };
}

/** The one line the command says without a terminal, and after a stop: what it needs and where it starts. */
export function proLine(cli) {
  const start = cli.trialDays ? `start your ${cli.trialDays}-day free trial` : `start ${clean(cli.plan, 20)}`;
  return `The genclass command comes with ${clean(cli.plan, 20)}${cli.price ? ` (${clean(cli.price, 40)})` : ""}: ${start} at ${cli.checkoutUrl}`;
}

/**
 * The paywall, on a terminal: the card, then one question. Enter (or y) opens the checkout (genclass.dev sends the
 * person straight to Stripe, the trial first) and waits for the payment; anything else (q, n, s, exit) stops.
 * Without a terminal it prints proLine and opens nothing. Returns whether the account has Pro now.
 * @param {{ plan: string, price: string | null, trialDays: number | null, checkoutUrl: string }} cli
 * @param {object | null} offer
 * @param {{ yes?: boolean, json?: boolean, noBrowser?: boolean, card?: boolean, account?: string | null }} o  `card`:
 *   the card without a terminal too; `account`: who it is for, said above the card (the checkout is the browser's
 *   account, so a person signed in there as someone else can tell)
 * @param {{ fetchFn?: typeof fetch, waitMs?: number, everyMs?: number }} [deps]
 */
export async function startPro(cli, offer, o = {}, deps = {}) {
  const card = proOffer(cli, offer);
  const heading = cli.trialDays ? `Start your ${cli.trialDays}-day free trial` : `genclass comes with ${clean(cli.plan, 20)}`;
  if (o.yes || o.json || !interactive()) {
    if (o.json) out(JSON.stringify(needsProJson(cli)));
    else {
      // `genclass plan` and `upgrade` show the card all the same: it is what they are for
      if (o.card && card.features.length) planCard(card, null, heading);
      out();
      warn(proLine(cli));
    }
    return false;
  }
  const start = cli.trialDays ? `start your ${cli.trialDays}-day free trial` : `start ${clean(cli.plan, 20)}`;
  // seen once in this process: one line from then on (the 0.3.9 user stories: the same card three times in four
  // commands). `genclass upgrade` and `plan` (o.card) are asked for it, so they show it again
  // `again`: the command's own words for that line (plan: what Pro has; setup: it goes on with Pro)
  if (cardShown && (o.short || o.again)) {
    out();
    note(`${o.again ?? `That comes with ${clean(cli.plan, 20)}.`} ${homeOpen() ? "Type upgrade" : "Run npx genclass upgrade"} to ${start}.`);
    refused = true;
    return false;
  }
  cardShown = true;
  if (o.account) {
    out();
    note(`For ${clean(o.account, 60)}`);
  }
  planCard(card, null, heading);
  // the price is on the card once; this says only how paying works
  note(
    cli.trialDays
      ? `Every genclass command comes with ${clean(cli.plan, 20)}. Your card is asked for on Stripe, and nothing is charged if you cancel before the trial ends.`
      : `Every genclass command comes with ${clean(cli.plan, 20)}, paid on Stripe.`,
  );
  out();
  const dot = c.gray("·");
  const a = await typed(`  ${PROMPT()} ${c.bold("Enter")} ${c.gray(cli.trialDays ? "to start the free trial" : `to start ${clean(cli.plan, 20)}`)} ${dot} ${c.bold("q")} ${c.gray("stop")}  `);
  // only Enter or a yes starts it: n, no, s, exit and q all stop, as q does everywhere else
  if (a === null || !/^(y|yes)?$/i.test(a.trim())) {
    out();
    note(`Not started. ${homeOpen() ? "Type upgrade" : "Run npx genclass upgrade"} any time to ${start}.`);
    // the line above is the way up: the prompt's Free line is not said again after it
    refused = true;
    return false;
  }
  const { checkout } = await import("./actions.mjs");
  if (await checkout({ ...card, pro: true }, o, deps)) {
    seen = true;
    return true;
  }
  return false;
}

/**
 * The gate every command but cli.mjs FREE_COMMANDS passes first. Signed out: the sign-in (on a terminal), then the plan.
 * Returns 0 when the command may run, else the exit code to end with (1).
 * @param {{ yes?: boolean, json?: boolean, noBrowser?: boolean }} o
 * @param {{ fetchFn?: typeof fetch, signIn?: (o: object) => Promise<string>, waitMs?: number, everyMs?: number }} [deps]
 */
export async function requirePro(o = {}, deps = {}) {
  refused = false;
  if (seen) return 0;
  let creds = readCredentials();
  if (!creds) {
    if (o.yes || o.json || !interactive()) {
      if (o.json) out(JSON.stringify(needsProJson(null, false)));
      else {
        out();
        warn("Sign in first: npx genclass login. The genclass command comes with Pro; its free trial starts right after the sign-in.");
      }
      return 1;
    }
    out();
    note("Sign in to genclass.dev first. Pro, with its free trial, comes right after.");
    const signIn = deps.signIn ?? (await import("./actions.mjs")).signIn;
    if ((await signIn(o)) !== "done") return 1;
    creds = readCredentials();
    if (!creds) return 1;
  }
  const me = await fetchOverview(creds, deps);
  if (me.ok) noteAccount({ plan: me.plan, cli: me.cli, teamPlan: me.account?.teamPlan });
  // a server that cannot be reached, or one that does not say, locks nothing here (its own routes still do)
  if (!me.ok || !me.cli || me.cli.paid) {
    if (me.ok && me.cli?.paid) seen = true;
    return 0;
  }
  if (await startPro(me.cli, me.offer ?? null, { ...o, account: accountLabel(me.account), short: true }, deps)) {
    seen = true;
    out();
    return 0;
  }
  refused = true;
  return 1;
}

/**
 * After `genclass login`: Pro comes right after the sign-in. An account with it hears so in one line; one without it
 * sees the paywall (startPro). Never changes the login's exit code. Returns whether the account has Pro now (true
 * too when the server does not say or cannot be reached: nothing is locked then).
 */
export async function afterLogin(o = {}, deps = {}) {
  const creds = readCredentials();
  if (!creds) return false;
  const me = await fetchOverview(creds, deps);
  if (me.ok) noteAccount({ plan: me.plan, cli: me.cli, teamPlan: me.account?.teamPlan });
  if (!me.ok || !me.cli) return true;
  if (me.cli.paid) {
    seen = true;
    if (!o.json) note(`${clean(me.plan && me.plan.id !== "free" ? me.plan.name : "Pro", 20)} is on: every genclass command works.`);
    return true;
  }
  if (await startPro(me.cli, me.offer ?? null, { ...o, account: accountLabel(me.account) }, deps)) {
    seen = true;
    return true;
  }
  return false;
}
