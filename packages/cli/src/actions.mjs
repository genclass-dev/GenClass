// What each step of `genclass setup` does when it is its turn: sign in, add the runtime, watch for the first page,
// add the workflow file and check the GitHub App, connect a coding agent. Each returns "done", "skipped" or "failed".
//
// Invariants:
// - Nothing is written before the person has seen what will be written and said yes (or passed --yes). The runtime is
//   added by the runtime CLI's own `init` (packages/runtime/bin/lib/init.mjs), which shows its diff and asks.
// - No git command that changes anything is run: a new file is left for the person to commit, and the command to do
//   so is printed.
// - No secret is asked for or typed here. Signing in and installing the GitHub App happen in the browser; this
//   process only waits for genclass.dev to say they happened.
// - A question that gets no answer because input ended is a no (tui.mjs agree, pick): nothing is written, sent or
//   opened on an empty answer unless someone could still have typed one.
// - Nothing this command sets up is drawn on a page: the runtime is added without the developer overlay
//   (runtimeArgs), so a site's visitors and its developer see their own layout and nothing of GenClass's.
// - A browser is opened only for addresses on the host this CLI talks to, built here or checked against that host
//   (api.mjs), never one taken from a file or a page.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pollDeviceLogin, readCredentials, saveCredentials, startDeviceLogin } from "../../runtime/bin/lib/account.mjs";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { apiHost, hostConfig, hostUrl } from "../../runtime/bin/lib/host.mjs";
import { accountLabel, inspectProject, run as runInit } from "../../runtime/bin/lib/init.mjs";
import { run as runLogin } from "../../runtime/bin/lib/login.mjs";
import { c, interactive, out, printChange, stopOnEnter, sym } from "../../runtime/bin/lib/ui.mjs";
import { fetchOverview, fetchRepoStatus } from "./api.mjs";
import { BUILD, SKILL_FILE, WORKFLOW_FILE } from "./assets.mjs";
import { accountPaid, appPlanOffer, WORKFLOW_PATH } from "./state.mjs";
import { agree, bad, clean, good, note, planCard, spinner, warn } from "./tui.mjs";
import { planViteSettings } from "./vite.mjs";

/** Resolves after `ms`, or at once when `signal` aborts. */
const nap = (ms, signal) =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        r();
      },
      { once: true },
    );
  });

/**
 * Opens `url` in the default browser when that makes sense here: never with --no-browser, never without a terminal
 * (a coding agent, CI, a pipe: the link is printed instead), never over SSH. Returns whether it tried; never throws.
 */
export function openBrowser(url, o = {}) {
  const env = process.env;
  if (o.noBrowser || !interactive() || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ 1. sign in

/** The device sign-in: a code and a link, the browser opened on it, and a wait until it is approved. */
export async function signIn(o = {}) {
  const h = hostConfig();
  if (h.error) {
    bad(h.error);
    return "failed";
  }
  const dev = await startDeviceLogin();
  if (!dev.ok) {
    bad(`Could not start the sign-in: ${dev.reason}`);
    return "failed";
  }
  out();
  out(`  Open  ${c.cyan(dev.verification_uri_complete)}`);
  out(`  Code  ${c.bold(dev.user_code)}  ${c.gray("(the page must show the same code)")}`);
  out();
  if (openBrowser(dev.verification_uri_complete, o)) note("Your browser is opening that page.");
  const stop = stopOnEnter();
  const sp = spinner("Waiting for you to approve in the browser", { stoppable: interactive() });
  const r = await pollDeviceLogin(dev, { signal: stop.signal });
  await stop.done();
  if (!r.ok && r.error === "cancelled") {
    sp.stop("warn", "Stopped waiting. Nothing was signed in; run npx genclass again when you want to.");
    return "skipped";
  }
  if (!r.ok) {
    sp.stop("bad", r.error === "access_denied" ? "The sign-in was denied in the browser." : r.error === "expired_token" ? "The code expired before it was approved (codes last ten minutes)." : `The sign-in did not finish: ${r.reason}`);
    return "failed";
  }
  saveCredentials({ host: apiHost(), access_token: r.access_token, account: r.account });
  sp.stop("ok", `Signed in as ${c.bold(accountLabel(r.account))}`);
  return "done";
}

// ------------------------------------------------------------------------------------------------ 1b. Pro

/**
 * The Pro step, right after the sign-in (state.mjs, step "plan"): the genclass command is Pro's (the owner's call,
 * 2026-11-13), so an account without it sees the paywall (paywall.mjs startPro): the card, then Enter, which opens
 * the checkout with its free trial and waits for the payment. There is no Free here. Returns "done" once Pro is on,
 * "skipped" when there is nothing to start, and "quit" otherwise (the walk stops: nothing after it works without Pro).
 * @param {{ fetchFn?: typeof fetch, waitMs?: number, everyMs?: number }} [deps]
 */
export async function choosePlan(state, o = {}, deps = {}) {
  const cli = state.steps.find((s) => s.id === "plan")?.cli;
  if (!cli || cli.paid) return "skipped";
  // seen once already in this process (the prompt): one line, not the card again
  return (await (await import("./paywall.mjs")).startPro(cli, state.account?.offer ?? null, { ...o, again: "Setup goes on with Pro." }, deps)) ? "done" : "quit";
}

/** This app's plan page, in the walk (state.mjs, step "app-plan"): projectPlan with the step's offer. */
export async function chooseAppPlan(state, o = {}, deps = {}) {
  const offer = state.steps.find((s) => s.id === "app-plan")?.offer;
  if (!offer) return "skipped";
  return projectPlan(offer, o, deps);
}

/**
 * What a paid plan for one app is, from the server's offer (genclass.dev's own words and price): this folder's app,
 * or the one `name` names, else the account's first app past the ones Free covers, else its first app on Free. Null
 * when that app has a plan (or a grant), when nothing is sold here, and when every app has one. A server from before
 * plans per project: the account's offer as it sent it.
 */
export function upgradeOffer(state, name = null) {
  const base = state.account?.offer ?? state.steps?.find((x) => x.id === "plan")?.offer ?? null;
  if (!base) return null;
  const mine = (state.projects ?? []).filter((p) => p.plan && !p.shared);
  if (!mine.length) return base.project ? base : (state.projects ?? []).some((p) => p.plan) ? null : base;
  const named = name ? mine.find((p) => p.id === name || p.name.toLowerCase() === String(name).toLowerCase()) : null;
  const here = mine.find((p) => p.token === state.app?.token) ?? null;
  const target = named ?? here ?? mine.find((p) => p.needsPlan) ?? mine.find((p) => p.plan.id === "free" && !p.plan.source) ?? null;
  if (!target || target.plan.id !== "free" || target.plan.source || !target.planUrl) return null;
  return { ...base, checkoutUrl: `${target.planUrl}&from=cli`, project: { id: target.id, name: target.name, token: target.token }, needs: target.needsPlan === true, chosen: target.planChosen === true, paying: accountPaid(state.account) };
}

/**
 * An app of the account with no plan chosen yet (on Free, nothing paid, granted or chosen on its page): the owner's
 * rule (2026-11-12) is that it has its plan chosen before anything else, Pro or Free with a reason, so this opens its
 * plan page in the browser and waits for the choice. `id` names the app; without it, this folder's. Without a
 * terminal it says where the page is and goes on. Returns "chosen", "none" (nothing to choose: a plan, a grant, a
 * choice already, or nothing sold), "covered" (the account's plan covers it; Continue was not clicked yet, which
 * blocks nothing), "locked" (past the apps a paying account's plan covers: Enterprise, by email) or "open" (the
 * choice was not made).
 */
export async function planNow(o = {}, deps = {}, id = null) {
  let state;
  try {
    state = await (deps.readState ?? (await import("./state.mjs")).readState)({ cwd: o.cwd }, deps);
  } catch {
    return "none";
  }
  const app = (state.projects ?? []).find((p) => (id ? p.id === id : p.token === state.app?.token) && !p.shared);
  // version 5 (2026-11-13): every new app sees its plan page, a paying account's too (it goes on with its plan
  // there), and an app its plan does not cover waits there (state.mjs appPlanOffer)
  const offer = appPlanOffer(app, state.account?.offer ?? null, !!state.account && accountPaid(state.account));
  if (!offer) return "none";
  // past the apps a paying account's plan covers: nothing to pay for here, more apps are Enterprise's (by email)
  if (offer.needs && offer.paying && !offer.appsPerUnit) {
    if (!o.json) await projectPlan(offer, o, deps);
    return "locked";
  }
  if (o.json) return offer.current ? "covered" : "open";
  // covered by the account's plan: it has its plan, so nothing opens and nothing waits (its page is in `genclass plan`).
  // Said once, right after the app reached the account (o.announce: login, connect, init, apps new), never before
  // a view (the 0.3.9 user stories: four times in one session)
  if (offer.current && !offer.needs) {
    if (o.announce) {
      out();
      note(`${clean(app.name, 40)} is on your ${clean(offer.current, 20)} plan.`);
    }
    return "covered";
  }
  if (o.yes || !interactive()) {
    out();
    // an app the account's plan covers has a plan: it goes on with it once, on its page
    note(offer.current ? `${clean(app.name, 40)} is covered by your ${clean(offer.current, 20)} plan. Continue with it once on its plan page: ${offer.checkoutUrl}` : `${clean(app.name, 40)} has no plan yet. Choose it in the browser: ${offer.checkoutUrl}`);
    return offer.current ? "covered" : "open";
  }
  const r = await projectPlan(offer, o, deps);
  return r === "done" ? "chosen" : offer.current ? "covered" : "open";
}

/**
 * Opens a plan's checkout in the browser and waits for the payment (Enter stops the wait). The page is
 * genclass.dev's, the payment is Stripe's; this command never sees a card. Returns whether the plan became active.
 * @param {{ plan: { name: string }, checkoutUrl: string }} offer
 * @param {{ fetchFn?: typeof fetch, waitMs?: number, everyMs?: number }} [deps]
 */
export async function checkout(offer, o = {}, deps = {}) {
  return (await waitForPlan(offer, o, deps)) === "paid";
}

/**
 * One app's plan, on its page in the browser (genclass.dev/account/billing?project=<id>): the paid plan large, with
 * its price and what it has, and a very small "Try for free (limited)" under it (none for an app past the ones Free
 * covers). The command opens the page and waits for the choice made there: a payment, or Free for now. Without a
 * terminal (--yes, a coding agent) it opens the page and goes on, and the step stays open until the choice is made.
 * Returns "done" once the app has its plan; "quit" when the wait ended without a choice (the setup stops there);
 * "skipped" without a terminal.
 * @param {{ plan: { name: string }, price: string, free: { name: string, apps: number | null }, checkoutUrl: string, project: { id: string, name: string, token: string }, needs: boolean }} offer
 */
export async function projectPlan(offer, o = {}, deps = {}) {
  const name = clean(offer.project.name, 30);
  // a paying account past the apps its plan covers: its page sells nothing (more apps are Enterprise's, by email),
  // so nothing is opened or waited for: the line, where the address is, and the setup goes on
  if (offer.needs && offer.paying && !offer.appsPerUnit) {
    out();
    warn(`Your plan covers no more apps, and ${name} is one more. More apps come with Enterprise, by email.`);
    out(`  ${c.gray("The address, on its plan page:")}`);
    out(`    ${c.cyan(offer.checkoutUrl)}`);
    note("Or delete an app you no longer need, in the browser.");
    return "skipped";
  }
  if (offer.features?.length) planCard(offer, offer.project.name);
  else out();
  note(
    offer.current
      ? `Your ${clean(offer.current, 20)} plan covers ${name}: continue with it on its plan page.`
      : offer.needs && offer.paying
        ? `Your plan covers no more apps: add ${offer.appsPerUnit} more for ${name} on its plan page.`
        : offer.needs
          ? `Free covers ${offer.free.apps === 1 ? "one app" : `${offer.free.apps ?? 1} apps`} and this is one more: it needs ${offer.plan.name}, ${offer.price}.`
          : `${offer.plan.name} is ${offer.price}. Or try ${offer.free.name.toLowerCase()} for now (limited), on the same page.`,
  );
  if (o.yes || !interactive()) {
    out(`  Open  ${c.cyan(offer.checkoutUrl)}`);
    if (openBrowser(offer.checkoutUrl, o)) note("Your browser is opening its plan page. Run npx genclass again once it is chosen.");
    return "skipped";
  }
  const got = await waitForPlan(offer, o, deps);
  if (got) return "done";
  // the setup goes on only once the app has its plan: Team, or Free with what stops the person from paying (the
  // owner's call, 2026-11-12)
  note(offer.current ? `${name} goes on with ${clean(offer.current, 20)} once you continue on ${offer.checkoutUrl}` : `${name} has no plan yet: ${offer.needs ? offer.plan.name : `${offer.plan.name}, or ${offer.free.name} for now`}, on ${offer.checkoutUrl}`);
  return "quit";
}

/**
 * Opens a plan's page in the browser and waits (Enter stops the wait): for the account's plan (a server from before
 * plans per project), or for one app's: its payment, or Free chosen for it on the page. The page is genclass.dev's,
 * the payment is Stripe's; this command never sees a card. Returns "paid", "free" or null.
 */
async function waitForPlan(offer, o = {}, deps = {}) {
  const app = offer.project ? clean(offer.project.name, 30) : null;
  out();
  out(`  Open  ${c.cyan(offer.checkoutUrl)}`);
  if (openBrowser(offer.checkoutUrl, o)) note(app ? `Your browser is opening the plan page for ${app}.` : "Your browser is opening the checkout.");
  const creds = readCredentials();
  const stop = stopOnEnter();
  const sp = spinner(offer.current || (app && !offer.needs) ? "Waiting for your choice in the browser" : "Waiting for the payment in the browser", { stoppable: interactive() });
  const until = Date.now() + (deps.waitMs ?? 10 * 60_000);
  let got = null;
  while (creds && !stop.signal.aborted && Date.now() < until) {
    await nap(deps.everyMs ?? 3000, stop.signal);
    if (stop.signal.aborted) break;
    const me = await fetchOverview(creds, deps);
    if (!me.ok) continue;
    if (offer.project) {
      const p = me.projects.find((x) => x.token === offer.project.token);
      // covered already: Continue was clicked; else a payment (or more apps) that covers it now, or Free chosen
      if (offer.current) got = p?.planChosen ? "kept" : null;
      else if (p?.plan && (p.plan.id !== "free" || p.plan.source) && !p.needsPlan) got = "paid";
      // Free counts only when it is chosen now: a choice made before this wait is not an answer to it
      else if (p?.planChosen && !offer.chosen && !offer.needs && !p.needsPlan) got = "free";
    } else if (me.cli ? me.cli.paid : me.plan && me.plan.id !== "free") got = "paid";
    if (got) break;
  }
  await stop.done();
  if (got === "kept") sp.stop("ok", `${app} goes on with ${clean(offer.current, 20)}.`);
  else if (got === "paid") sp.stop("ok", `${offer.plan.name} is active${app ? ` for ${app}` : ""}. Thank you.`);
  else if (got === "free") sp.stop("ok", `${app} is on ${offer.free.name} for now (limited).`);
  else sp.stop("warn", app && !offer.needs ? "No choice yet." : `No payment yet: ${clean(offer.plan.name, 20)} is not started.`);
  return got;
}

// ------------------------------------------------------------------------------------------------ 2. the runtime

/**
 * The arguments the runtime step hands to the runtime CLI's `init` (a fresh project) or `connect` (added, not in
 * the account yet). `init` gets --no-devtools: GenClass set up by this command draws nothing on a page, not on the
 * deployed site (it never did) and not on localhost either (the developer overlay is left out). What it finds goes
 * to the browser console, the dashboard and `genclass dashboard`.
 */
export function runtimeArgs(state, o = {}) {
  const connect = state.steps.find((s) => s.id === "runtime")?.run === "npx genclass connect";
  const args = ["--cwd", state.cwd, ...(o.yes ? ["--yes"] : [])];
  // connect takes only its own options (packages/runtime/bin/lib/login.mjs SPECS.connect): it asks which app of the
  // account this is, and the account is the one signed in. init gets --in-account (signed in one step earlier, so
  // the app goes into that account without asking again), --no-devtools and --brief (the walk has its own header,
  // so init says the same things in a few lines)
  return connect ? { cmd: "connect", args } : { cmd: "init", args: [...args, ...(state.signedIn ? ["--in-account"] : []), "--no-devtools", "--brief"] };
}

/**
 * Adds the runtime with the runtime CLI's own init (fresh project) or connect (added, not in the account), then the
 * two build settings an app on Vite 7 or earlier needs with it (vite.mjs). When those settings are all that is
 * missing (the step says so), only they are written.
 */
export async function addRuntime(state, o = {}) {
  // a member of a paying team: init and connect say the new app goes into the team's account
  if (state.account) (await import("./paywall.mjs")).noteAccount(state.account);
  if (!state.steps.find((s) => s.id === "runtime")?.vite) {
    const { cmd, args } = runtimeArgs(state, o);
    // GenClass taken out and added again: the account's app of the same name is this one, not a new app
    const again = cmd === "init" ? await sameApp(state, o) : null;
    const code = again ? await again() : cmd === "connect" ? await runLogin("connect", args) : await runInit("init", args);
    if (code !== 0) return "failed";
    // init returns 0 when the person says no to its change: then there is no GenClass to add Vite settings for
    const after = inspectProject({ cwd: state.cwd });
    if (after.fresh) return "skipped";
    // signed in, GenClass is in the code but the app never reached the account (genclass.dev did not answer): the
    // step did not finish, so the walk says so and ends with exit code 1 instead of "done"
    const optedOut = args.some((a) => a === "--no-telemetry" || a === "--no-token" || a === "--no-network" || a === "--dry-run");
    if (state.signedIn && !after.token && !optedOut) {
      warn("GenClass is in your code, but the app is not in your account yet: run npx genclass again to connect it.");
      await addViteSettings(state, o);
      return "failed";
    }
  }
  return (await addViteSettings(state, o)) === "failed" ? "failed" : "done";
}

/**
 * A fresh project (no GenClass in it) whose name is an app already in the account, as after `genclass remove`: on a
 * terminal it asks whether this is that app (yes by default), with --yes it is. Returns the init that writes that
 * app's key (no new app is made), or null when there is no such app or the person said no.
 */
export async function sameApp(state, o = {}) {
  if (!state.signedIn) return null;
  let st;
  try {
    st = inspectProject({ cwd: state.cwd });
  } catch {
    return null;
  }
  const name = String(st.project.pkg?.name || st.project.name || "").slice(0, 80);
  const app = name ? (state.projects ?? []).find((p) => !p.shared && p.name === name && p.token) : null;
  if (!app) return null;
  if (!o.yes) {
    if (!interactive()) return null;
    out();
    if (!(await agree(`Use your existing ${clean(app.name, 40)}? ${c.gray("(No makes a new app)")}`))) return null;
  }
  const { args } = runtimeArgs(state, o);
  const creds = readCredentials();
  return async () => {
    const { init, parse } = await import("../../runtime/bin/lib/init.mjs");
    return init({ ...parse(args), token: app.token, ...(o.noInstall ? { noInstall: true } : {}) }, { cmd: "init", creds, app });
  };
}

/** Shows the two Vite settings and writes them on a yes (--yes, or one question on a terminal). */
export async function addViteSettings(state, o = {}) {
  let plan = null;
  try {
    plan = planViteSettings(state.cwd, detectProject(state.cwd));
  } catch {
    plan = null;
  }
  if (!plan) return "done";
  out();
  if (plan.note) {
    warn(plan.note);
    return "skipped";
  }
  warn(`Vite ${plan.major} needs two settings for the model's worker.`);
  note('Without them "vite build" fails.');
  out();
  printChange(plan.change);
  // in the walk (o.confirmed) the step's Enter was the yes: adding GenClass, whose build fails without these two
  // lines, or the step "Add two Vite settings" itself (the 0.3.9 user stories: one yes per step, not two)
  if (!o.yes && !o.confirmed) {
    if (!interactive()) {
      note(`Not a terminal: run ${c.cyan("npx genclass setup --yes")} to write them.`);
      return "skipped";
    }
    if (!(await agree("Add them?"))) {
      note("Left as it is. The two lines are above when you want them.");
      return "skipped";
    }
  }
  try {
    writeFileSync(plan.change.path, plan.change.after);
  } catch (e) {
    bad(`Could not write ${plan.change.file}: ${e?.message ?? e}`);
    return "failed";
  }
  good(`${plan.change.kind === "create" ? "Wrote" : "Updated"} ${c.bold(plan.change.file)} ${c.gray("(your build and dev server now handle the model's worker)")}`);
  note("Vite 8 needs neither setting. npx genclass remove takes them out again.");
  return "done";
}

// ------------------------------------------------------------------------------------------------ 3. first page

/** Waits (up to `seconds`) for genclass.dev to have received a first event from this app. */
export async function watchFirstPage(state, o = {}) {
  const creds = readCredentials();
  if (!creds || !state.app.token) {
    note(!creds ? "Sign in first: npx genclass login. The first page is looked for in your account." : "Put this app in your account first: npx genclass connect");
    return "skipped";
  }
  if (!o.yes && interactive()) {
    const ok = await agree("Is your site deployed with GenClass in it? I will watch for its first page for two minutes", false);
    if (!ok) {
      note("No problem. Deploy as you normally do, open the live site once, and run genclass again: this step turns green by itself.");
      return "skipped";
    }
  } else return "skipped";
  const stop = stopOnEnter();
  const sp = spinner("Open your live site in a browser now. Watching for its first page", { stoppable: interactive() });
  const until = Date.now() + (o.seconds ?? 120) * 1000;
  while (Date.now() < until && !stop.signal.aborted) {
    await nap(5000, stop.signal);
    if (stop.signal.aborted) break;
    const me = await fetchOverview(creds);
    if (me.ok && me.projects.find((p) => p.token === state.app.token)?.last_event) {
      await stop.done();
      sp.stop("ok", "GenClass received the first page from your site. Your dashboard is filling.");
      return "done";
    }
  }
  await stop.done();
  sp.stop("warn", "Nothing arrived yet. GenClass sends nothing from localhost or a private address; run npx genclass again after the live site was opened.");
  return "skipped";
}

// ------------------------------------------------------------------------------------------------ 4. pull requests

/**
 * The workflow file for a project that is `sub` below the repository's root ("" at the root): the job runs in that
 * folder and uploads the race files from it. Null when `sub` holds a character a workflow path should not.
 */
export function workflowFor(sub) {
  if (!sub) return WORKFLOW_FILE;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(sub) || sub.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  const withDir = WORKFLOW_FILE.replace("    timeout-minutes: 45\n", `    timeout-minutes: 45\n    defaults:\n      run:\n        working-directory: ${sub}\n`).replace("          path: test-results/genclass\n", `          path: ${sub}/test-results/genclass\n`);
  return withDir.includes(`working-directory: ${sub}`) && withDir.includes(`path: ${sub}/test-results/genclass`) ? withDir : null;
}

/**
 * Writes the workflow file at the repository's root. On a terminal the step's Enter is the yes (`o.confirmed`);
 * `--yes` writes too; otherwise it asks.
 */
export async function addWorkflow(state, o = {}) {
  const root = state.git.root;
  const sub = relative(root, state.cwd).split(sep).join("/");
  const text = workflowFor(sub);
  if (text === null) {
    warn(`This app's folder (${sub}) has a name the workflow cannot use as it is. Copy docs/github-app/workflows/genclass.yml from the GenClass repository and set its working directory by hand.`);
    return "skipped";
  }
  const file = join(root, WORKFLOW_PATH);
  if (!o.yes && !o.confirmed) {
    if (!interactive()) {
      note(`Not a terminal: run ${c.cyan("npx genclass setup --yes")} to write ${WORKFLOW_PATH}.`);
      return "skipped";
    }
    if (!(await agree(`Write ${WORKFLOW_PATH}?`))) return "skipped";
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
  } catch (e) {
    bad(`Could not write ${WORKFLOW_PATH}: ${e?.code === "EEXIST" ? "a file with that name is already there" : (e?.message ?? e)}`);
    return e?.code === "EEXIST" ? "skipped" : "failed";
  }
  good(`Wrote ${c.bold(WORKFLOW_PATH)} ${c.gray(`(new file, ${text.split("\n").length - 1} lines)`)}`);
  note("It is not committed. When you are ready:");
  // one command a line, so each fits a narrow terminal and can be copied alone
  out(`    ${c.cyan(`git add ${WORKFLOW_PATH}`)}`);
  out(`    ${c.cyan('git commit -m "Add GenClass to pull requests"')}`);
  out(`    ${c.cyan("git push")}`);
  return "done";
}

/**
 * Waits (up to `seconds`) for genclass.dev to have an answer from GitHub about `repo` that passes `until`.
 * The last answer, or null when none passed in time.
 */
async function waitForGithub(creds, repo, text, until, seconds) {
  const stop = stopOnEnter();
  const sp = spinner(text, { stoppable: interactive() });
  const end = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < end && !stop.signal.aborted) {
    await nap(3000, stop.signal);
    if (stop.signal.aborted) break;
    const r = await fetchRepoStatus(creds, repo);
    if (r.ok) last = r;
    if (r.ok && until(r)) break;
  }
  await stop.done();
  sp.stop();
  return last && until(last) ? last : null;
}

/**
 * The GitHub App on this repository, with as little asked as possible: genclass.dev is asked what GitHub says; when
 * it has no answer the browser is opened to get one (Continue with GitHub), and when the answer is that the app is
 * not on the repository the browser is opened on GitHub's install page. This process only waits for the answer.
 */
export async function connectGithubApp(state, o = {}) {
  const creds = readCredentials();
  const repo = state.git.github;
  if (!creds || !repo) {
    note(!creds ? "Sign in first: npx genclass login. The GitHub App is connected to your account." : "This folder is not a repository on GitHub, so there is nothing to connect.");
    return "skipped";
  }
  // a genclass.dev with no GitHub App (a collector someone hosts themselves): nothing to connect, and no waiting
  if (state.account?.github && state.account.github.app === false) {
    note("This genclass.dev has no GitHub App, so there is nothing to connect here.");
    return "skipped";
  }
  let st = await fetchRepoStatus(creds, repo);
  if (!st.ok && st.missing) {
    note(`This genclass.dev cannot tell the command about the GitHub App. Check it in the browser: ${c.cyan(hostUrl("/account/github"))}`);
    return "skipped";
  }
  const on = (r) => r.known && r.installed === true;
  if (st.ok && on(st)) {
    good(`The GenClass GitHub App is on ${c.bold(repo)}.`);
    return "done";
  }
  const installUrl = (st.ok && st.installUrl) || hostUrl("/github/install");
  const connectUrl = (st.ok && st.connectUrl) || hostUrl("/github/connect");
  if (o.yes || !interactive()) {
    out(`  Install the GenClass GitHub App on ${c.bold(repo)}:  ${c.cyan(installUrl)}`);
    out(`  Then, on the page GitHub sends you to, press ${c.bold("Continue with GitHub")}. Already installed: ${c.cyan(connectUrl)}`);
    return "skipped";
  }
  // 1. no answer from GitHub yet: get one. The page asks GitHub which repositories the app is on and comes back.
  if (!st.ok || !st.known) {
    out(`  ${c.gray(sym.arrow)} Asking GitHub which repositories the app is on: ${c.cyan(connectUrl)}`);
    openBrowser(connectUrl, o);
    st = (await waitForGithub(creds, repo, "Waiting for GitHub's answer (approve in the browser if it asks)", (r) => r.known, 90)) ?? st;
    if (st.ok && on(st)) {
      good(`The GenClass GitHub App is on ${c.bold(repo)}.`);
      return "done";
    }
    if (!st.ok || !st.known) {
      warn(`No answer yet. Make sure the browser is signed in to the same GenClass account as this command, then run npx genclass again.`);
      return "skipped";
    }
  }
  // 2. GitHub's answer does not list the repository: install the app on it
  out(`  ${c.gray(sym.arrow)} The app is not on ${c.bold(repo)} yet. Opening GitHub to install it: ${c.cyan(installUrl)}`);
  note("Pick this repository on GitHub's page. On the page that follows, press Continue with GitHub.");
  openBrowser(installUrl, o);
  const done = await waitForGithub(creds, repo, `Waiting for the app to be installed on ${repo}`, on, 240);
  if (done) {
    good(`The GenClass GitHub App is on ${c.bold(repo)}.`);
    return "done";
  }
  warn("Not installed yet. Finish on GitHub and run genclass again: this step picks up where it stopped.");
  return "skipped";
}

// ------------------------------------------------------------------------------------------------ 5. coding agent

/** The MCP server entry most clients take (packages/mcp/src/clients.ts serverConfig), at the version this CLI was built with. */
export const mcpServer = () => ({ command: "npx", args: ["-y", `@genclass/mcp@${BUILD.mcpVersion}`] });

/**
 * The change that adds GenClass's MCP server to a project's agent configuration: `.cursor/mcp.json` when the project
 * has a `.cursor` folder and no `.mcp.json`, else `.mcp.json` (Claude Code and other clients read it). Null with
 * `reason` when the file is there and is not a JSON object (it is left alone).
 */
export function planAgentConfig(dir) {
  const file = existsSync(join(dir, ".cursor")) && !existsSync(join(dir, ".mcp.json")) ? ".cursor/mcp.json" : ".mcp.json";
  const path = join(dir, file);
  let before = null;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    /* a new file */
  }
  let json = {};
  if (before !== null && before.trim()) {
    try {
      json = JSON.parse(before);
    } catch {
      return { file, change: null, reason: `${file} is not valid JSON` };
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return { file, change: null, reason: `${file} is not a JSON object` };
  }
  const servers = json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers) ? json.mcpServers : {};
  const after = `${JSON.stringify({ ...json, mcpServers: { ...servers, genclass: mcpServer() } }, null, 2)}\n`;
  return { file, path, change: { file, kind: before === null ? "create" : "modify", before: before ?? "", after }, reason: null };
}

/** Where the skill goes in a project: Claude Code reads a project's skills from here, as `npx @genclass/mcp init` writes it. */
export const SKILL_PATH = ".claude/skills/genclass/SKILL.md";
export const SKILL_MARK = "genclass:init";

/**
 * The skill file as this command writes it: the MCP package's own skill with a marker line after its front matter
 * (the same marker `npx @genclass/mcp init` uses, so either command replaces the other's file and neither replaces
 * one the person has made their own by removing the line).
 */
export function skillText(source = SKILL_FILE) {
  const mark = `<!-- ${SKILL_MARK}: written by \`npx genclass\`; a rerun replaces this file while this line is here, so remove the line to keep your edits -->`;
  const end = source.startsWith("---\n") ? source.indexOf("\n---\n", 4) : -1;
  return end < 0 ? `${mark}\n\n${source}` : `${source.slice(0, end + 5)}${mark}\n${source.slice(end + 5)}`;
}

/** Writes the skill unless a file is there that does not carry the marker. Returns "written", "kept" or "failed". */
export function writeSkill(dir) {
  const file = join(dir, SKILL_PATH);
  try {
    if (existsSync(file) && !readFileSync(file, "utf8").includes(SKILL_MARK)) return "kept";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, skillText());
    return "written";
  } catch {
    return "failed";
  }
}

/** Adds the MCP server to the project's agent configuration after showing the change, and the skill next to it. */
export async function connectAgent(state, o = {}) {
  const plan = planAgentConfig(state.cwd);
  if (!plan.change) {
    warn(`${plan.reason}, so it was left alone. Add this to its "mcpServers" by hand:`);
    out(`    ${c.cyan(`"genclass": ${JSON.stringify(mcpServer())}`)}`);
    return "skipped";
  }
  // what is written is shown first; it is asked for on its own, and in the walk the step's Enter was the yes (its
  // sentence says what it adds, as the workflow step's does); --yes writes it
  if (!o.yes) {
    out();
    printChange(plan.change);
    note(`And ${SKILL_PATH}: how the agent uses GenClass's tools (a file you changed is left alone).`);
    out();
  }
  if (!o.yes && !o.confirmed) {
    if (!interactive()) {
      note(`Not a terminal: run ${c.cyan("npx genclass setup --yes")} to write it.`);
      return "skipped";
    }
    if (!(await agree(`Write ${plan.file} and the skill?`))) return "skipped";
  }
  try {
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.change.after);
  } catch (e) {
    bad(`Could not write ${plan.file}: ${e?.message ?? e}`);
    return "failed";
  }
  good(`${plan.change.kind === "create" ? "Wrote" : "Updated"} ${c.bold(plan.file)} ${c.gray("(GenClass's MCP server)")}`);
  // the skill is the procedure the agent follows with those tools; a file the person made their own is left alone
  const skill = writeSkill(state.cwd);
  if (skill === "written") good(`Wrote ${c.bold(SKILL_PATH)} ${c.gray("(how the agent uses them)")}`);
  note('Restart your coding agent in this folder, then ask it "is GenClass connected?". The first time, it shows two dev-only lines that connect your running app and adds them when you say yes.');
  return "done";
}
