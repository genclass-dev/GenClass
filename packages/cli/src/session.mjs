// What the commands that ask genclass.dev for more than the dashboard share (plan, team, connections, export,
// funnels, agent link, ask): one way to ask, and one way to say why the answer was no.
//
// Invariants:
// - A terminal does these only when it was approved on a page that lists them. A sign-in from before that page is
//   told so and, with someone at the terminal, signed in once more on the spot (one approval in the browser), then
//   the same request is made again. Nothing is retried otherwise.
// - No dead end: every refusal names the next step, as a command that runs as typed or an address to open. When
//   the plan is why, it names the plan and the command that starts it; when the account has no Pro (the genclass
//   command is Pro's), the checkout of its free trial.

import { readCredentialsFor } from "../../runtime/bin/lib/account.mjs";
import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { signIn } from "./actions.mjs";
import { needsProJson, proLine } from "./paywall.mjs";
import { bad, clean, linkLine, note, proBox, typed, warn } from "./tui.mjs";

/**
 * Runs `call(creds)` (one of api.mjs's calls). When the answer says this sign-in is from before the command could
 * do it and someone is at a terminal, signs in once more and calls again. Returns the last answer.
 * @param {{ json?: boolean, noBrowser?: boolean }} o
 * @param {{ signIn?: Function }} [deps]
 */
export async function asking(o, creds, call, deps = {}) {
  let r = await call(creds);
  if (!r.ok && r.reauth && !o.json && interactive()) {
    out();
    note("This sign-in is from before the command could do this, so it was not approved for it. Signing in once more fixes it: the page lists what the terminal can do.");
    const a = await typed(`  ${c.bold("Enter")} ${c.gray("to sign in again ·")} ${c.bold("q")} ${c.gray("stop")} `);
    if (a === null || /^q/i.test(a)) return r;
    if ((await (deps.signIn ?? signIn)(o)) !== "done") return r;
    const again = readCredentialsFor().creds;
    if (again) r = await call(again);
  }
  return r;
}

/**
 * Says why a call was refused and what to do next. Returns the exit code (1).
 * @param {{ ok: false, reason?: string, reauth?: boolean, upgradeUrl?: string, missing?: boolean }} r
 * @param {{ what: string, command: string, browserUrl?: string | null, plan?: string | null, json?: boolean }} ctx
 *   `what`: the thing in a few words, capitalised ("Sending alerts"); `command`: what was typed after `genclass`
 */
export function refused(r, ctx) {
  // the genclass command is Pro's (paywall.mjs): the one way on, whatever was asked
  if (r.needsPro) {
    if (ctx.json) out(JSON.stringify(needsProJson(r.needsPro)));
    else {
      out();
      warn(proLine(r.needsPro));
      out(`  ${c.gray("Start it here")}  ${c.cyan("npx genclass upgrade")}`);
      out();
    }
    return 1;
  }
  if (ctx.json) {
    out(JSON.stringify({ ok: false, error: r.reauth ? "sign in again" : r.upgradeUrl ? "not in this plan" : r.missing ? "this genclass.dev has no such route" : r.reason, ...(r.reauth ? { run: "npx genclass login" } : {}), ...(r.upgradeUrl ? { upgrade_url: r.upgradeUrl, run: "npx genclass plan" } : {}) }));
    return 1;
  }
  out();
  if (r.reauth) warn(`This sign-in is from before the command could do this. Run ${c.cyan("npx genclass login")} once, then ${c.cyan(`npx genclass ${ctx.command}`)}.`);
  else if (r.upgradeUrl) {
    const lock = r.lock ?? { plan: ctx.plan ?? null, upgradeUrl: r.upgradeUrl };
    proBox(`${ctx.what} comes with ${clean(lock.plan ?? ctx.plan ?? "Pro", 20)}.`, { ...lock, upgradeUrl: lock.upgradeUrl ?? r.upgradeUrl });
  } else if (r.missing) note("This genclass.dev cannot do this from the terminal yet.");
  else bad(`${ctx.what}: ${clean(r.reason ?? "it did not work", 240)}`);
  if (ctx.browserUrl && !r.upgradeUrl) linkLine("In the browser", ctx.browserUrl);
  out();
  return 1;
}
