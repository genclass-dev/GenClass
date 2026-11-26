// `genclass` and `genclass setup`: the one way to set GenClass up. It reads where the project stands (state.mjs),
// shows it in a few lines, does the next step (actions.mjs) and reads the state again, until nothing is left that
// this machine can do. `genclass status` prints the same view and stops.
//
// Invariants:
// - Simple first: the view is three or four lines (done, next, waiting, later) and one sentence about the next step.
// - Everything is one key away: d shows every part with what is known about it and the fuller explanation, and d
//   again folds it back. Nothing is hidden for good, and nothing is shown that the person did not ask for.
// - One next step at a time, always the first one open in the fixed order, and every run starts from what is true
//   now: stopping at any point and running `genclass` again continues where it left off, and a step done by hand or
//   by another tool counts.
// - The setup comes first and Pro's free trial after it (the owner's call, 2026-11-24): Pro's step is the last but
//   the suggestions, which are Pro's, and nothing before it asks for Pro.
// - On a terminal a step starts on Enter, and Enter is the yes for what the step's sentence says it will write (s
//   skips it for this run, q stops). With --yes nothing is asked: every step that needs no person is done, and what
//   only a person can do (install the GitHub App, deploy) is printed with its address; the sign-in prints its link
//   and code and waits for the approval (up to ten minutes), so a coding agent can hand them to the person. Without a
//   terminal and without --yes nothing is done at all: the view and the next command are printed, which is what a
//   coding agent reads. Input that ends at a question (end of file) stops the walk: an empty answer is an Enter only
//   while someone can still type.
// - A step that fails or is skipped does not stop the ones after it that do not depend on it.

import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pollDeviceLogin, readCredentials, saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { apiHost } from "../../runtime/bin/lib/host.mjs";
import { accountLabel } from "../../runtime/bin/lib/init.mjs";
import { c, err, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { addRuntime, addWorkflow, chooseAppPlan, choosePlan, connectAgent, connectGithubApp, signIn, watchFirstPage } from "./actions.mjs";
import { reportOnboard } from "./api.mjs";
import { brand, canDraw } from "./art.mjs";
import { BUILD } from "./assets.mjs";
import { appsBelow, planName, readState, stateJson } from "./state.mjs";
import { bad, barPara, card, checklist, header, homeOpen, nextBlock, note, pick, PROMPT, rule, spinner, summary, typed, warn } from "./tui.mjs";

/**
 * Prints the header and the steps for a state: the short view, or with `details` every part and what is known
 * about it.
 */
export function show(state, details = false, welcome = false) {
  const h = { app: state.app.name, framework: state.app.framework, account: state.account?.label ?? null, plan: planName(state), host: state.host };
  // the first screen on a terminal is the welcome card; every later one, anything piped, and `status` typed in the
  // home (which showed the card once, at the top) is the two-line header
  if (welcome && canDraw() && !homeOpen()) card({ ...h, cwd: state.cwd, version: BUILD.version });
  else header(h);
  if (details) checklist(state.steps);
  else summary(state.steps);
  // the wrong folder is the first thing to know, whatever step comes next
  const blocked = state.steps.find((s) => s.state === "blocked");
  if (blocked) {
    out();
    const below = state.app.below ?? { apps: [], more: 0 };
    if (!below.apps.length) note(`${upper(blocked.detail)}. Run npx genclass inside your web app's folder, or name it: ${c.cyan("npx genclass --cwd <folder>")}`);
    else {
      note(`${upper(blocked.detail)}. ${below.apps.length === 1 && !below.more ? "There is one below it:" : "Web apps below it:"}`);
      const pad = Math.min(48, Math.max(...below.apps.map((a) => a.dir.length)) + 2);
      for (const a of below.apps) out(`    ${c.cyan(`npx genclass --cwd ${a.dir.padEnd(pad)}`)}${c.gray(a.label)}`);
      if (below.more) out(`    ${c.gray(`and ${below.more} more`)}`);
    }
  }
}

const upper = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/**
 * On a terminal, in a folder that is not a web app but has some below it: asks which one, so the walk goes on there
 * instead of ending at "no web app in this folder". Returns the folder to work in (the same one when nothing is
 * picked, or nothing can be).
 */
async function whichApp(cwd) {
  const here = resolve(cwd ?? process.cwd());
  let below = { apps: [], more: 0 };
  try {
    if (!detectProject(here).framework) below = appsBelow(here);
  } catch {
    return cwd;
  }
  if (!below.apps.length) return cwd;
  out();
  out(`  ${c.bold(brand("GenClass"))}`);
  out();
  out(`  ${c.bold("This folder is not a web app.")} ${c.gray(below.apps.length === 1 && !below.more ? "There is one below it." : `There ${below.more ? "are web apps" : `are ${below.apps.length}`} below it.`)}`);
  if (below.more) note(`${below.more} more are not listed. Name one with ${c.cyan("npx genclass --cwd <folder>")}`);
  const stay = "none of these: stay in this folder";
  const i = await pick("Which one do you want to set up?", [...below.apps.map((a) => `${a.dir}  ${c.gray(a.label)}`), stay], 0);
  if (i === null || i >= below.apps.length) return cwd;
  const dir = below.apps[i].dir;
  note(`Working in ${dir}. Next time: ${c.cyan(`cd ${dir} && npx genclass`)}`);
  out();
  return join(here, dir);
}

/** What comes next, in one sentence; with `details`, the fuller explanation under it. */
function showNext(step, details) {
  nextBlock(step.doing, step.why);
  if (details && step.more) barPara(step.more);
}

/** The lines under the steps when nothing is left to walk through. */
export function closing(state) {
  out();
  const waiting = state.steps.filter((s) => s.state === "waiting");
  const blocked = state.steps.find((s) => s.state === "blocked");
  if (blocked) {
    /* show() has said where to run it */
  } else if (!state.signedIn) {
    // the sign-in did not finish (the code expired, the browser said no): the way back is one command
    out(`  ${c.bold("Not signed in yet.")}`);
    note("Run npx genclass again for a new code: setup goes on from the sign-in.");
  } else if (state.complete) out(`  ${c.green("Everything is set up.")}`);
  else if (waiting.length) {
    out(`  ${c.bold("Nothing more to do here right now.")}`);
    for (const s of waiting) note(`${s.title}: ${s.human ?? s.detail}.`);
  }
  out();
  out(`  ${c.gray("Day to day")}`);
  // the commands in one column with room after the longest, so the short name (genclass ...) keeps a gap too; on
  // Free only what works there (the 2026-11-25 onboarding walk: suggest and dashboard both opened the Pro card)
  const free = !!state.account?.cli && !state.account.cli.paid;
  out(`    ${c.cyan("npx genclass".padEnd(25))}${c.gray("the prompt: commands, questions")}`);
  if (free) {
    out(`    ${c.cyan("npx genclass fix <url>".padEnd(25))}${c.gray("your agent fixes a page's 3 worst problems")}`);
    out(`    ${c.cyan("npx genclass scan <url>".padEnd(25))}${c.gray("a page's score")}`);
    out(`    ${c.cyan("npx genclass upgrade".padEnd(25))}${c.gray("Pro: every problem, dashboard, suggestions")}`);
  } else {
    out(`    ${c.cyan("npx genclass suggest".padEnd(25))}${c.gray("what your app is missing")}`);
    if (state.app.token) out(`    ${c.cyan("npx genclass dashboard".padEnd(25))}${c.gray("what it found on your site")}`);
  }
  out();
}

/** `genclass status`: the steps (--all: every part), and the next one as a command. Exit code 0. */
export async function status(o = {}) {
  const state = await readState({ cwd: o.cwd });
  if (o.json) {
    out(JSON.stringify(stateJson(state), null, 2));
    return 0;
  }
  show(state, !!o.all, true);
  const step = state.next;
  if (step) {
    showNext(step, !!o.all);
    // inside the prompt a command is typed without npx genclass in front
    const cmd = step.run ?? "npx genclass setup";
    const typedHere = homeOpen() && cmd.startsWith("npx genclass ");
    barPara(`${c.gray(typedHere ? "Type" : "Run")} ${c.cyan(typedHere ? cmd.slice("npx genclass ".length) : cmd)}${step.human ? c.gray(`  (then: ${step.human})`) : ""}`, (l) => l);
    out();
    if (!o.all) out(`  ${c.gray("Every part:")} ${c.cyan(homeOpen() ? "status --all" : "npx genclass status --all")}`);
    out();
  } else closing(state);
  return 0;
}

/**
 * `genclass setup` (and `genclass` on a terminal): walks the steps. `runSuggest` runs the suggestions step (passed in
 * by cli.mjs, so this module does not load the checks until they are needed). Exit code 0, or 1 when a step failed.
 * @param {{ cwd?: string, yes?: boolean, noBrowser?: boolean, json?: boolean, all?: boolean, noAnalytics?: boolean }} o
 *   noAnalytics: the runtime step adds GenClass without visitor analytics (they are on by default)
 * @param {{ runSuggest?: (o: object) => Promise<number> }} [deps]
 */
export async function setup(o = {}, deps = {}) {
  const auto = !!o.yes;
  if (!auto && !interactive()) return status(o);
  // --json: the walk's view goes to stderr, so stdout is the JSON alone and parses
  if (o.json) {
    const write = process.stdout.write;
    process.stdout.write = process.stderr.write.bind(process.stderr);
    try {
      return await walk({ ...o, json: false }, deps, auto);
    } finally {
      process.stdout.write = write;
      out(JSON.stringify(stateJson(await readState({ cwd: o.cwd })), null, 2));
    }
  }
  return walk(o, deps, auto);
}

/** A code from Get started: the device flow's own secret (telemetry-worker src/auth.ts onboardCommand). */
const ONBOARD_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * `genclass onboard <code>`: the whole setup in one go, followed on genclass.dev (the owner, 2026-11-24: "the
 * onboarding system actually gives you a command for the CLI ... it goes through the entire setup ... the CLI should
 * connect to the dashboard and should show you a visualization of what's going on").
 * - The code is a sign-in the account approved by asking for it on Get started: it is swapped for this terminal's
 *   session at once, so nothing opens in the browser. Without a code the walk signs in the usual way.
 * - Then the walk runs as with --yes: every step that needs no person is done; what only a person can do (install the
 *   GitHub App, deploy, start the trial) is printed with its address.
 * - Before and after every step it says where the setup stands (POST /api/cli/onboard): the steps' ids, states and
 *   short words, nothing from the code. Get started draws them as they come. A report that fails changes nothing here.
 * Exit code: the walk's (0, or 1 when a step failed); 1 when the code did not sign in; 2 for a code that is not one.
 * @param {string | null} code
 * @param {{ cwd?: string, noBrowser?: boolean, noAnalytics?: boolean }} o
 * @param {{ fetchFn?: typeof fetch }} [deps]
 */
export async function onboard(code, o = {}, deps = {}) {
  out();
  out(`  ${c.bold(brand("GenClass"))} ${c.gray("· onboarding, shown live on your dashboard")}`);
  out();
  if (code) {
    if (!ONBOARD_CODE_RE.test(code)) {
      err(`genclass onboard: that is not a code from genclass.dev. Copy the whole command from ${c.cyan("genclass.dev/account/get-started")}`);
      return 2;
    }
    const sp = spinner("Signing in with the code from genclass.dev");
    const r = await pollDeviceLogin({ device_code: code, interval: 1, expires_in: 60 }, { fetchFn: deps.fetchFn });
    if (!r.ok) {
      sp.stop("bad", r.error === "expired_token" ? "That code has expired or was used already. Get a new one on genclass.dev/account/get-started." : `Could not sign in: ${r.reason}`);
      return 1;
    }
    saveCredentials({ host: apiHost(), access_token: r.access_token, account: r.account });
    sp.stop("ok", `Signed in as ${c.bold(accountLabel(r.account))}`);
  }
  const run = `run-${randomBytes(9).toString("base64url")}`;
  const send = async (body) => {
    const creds = readCredentials();
    if (!creds) return;
    try {
      await reportOnboard(creds, { run, ...body }, { fetchFn: deps.fetchFn });
    } catch {
      /* the dashboard shows less; the setup goes on */
    }
  };
  const report = async (ev) => {
    if (ev.type === "state") {
      const j = stateJson(ev.state);
      await send({ steps: j.steps.map((x) => ({ id: x.id, title: x.title, state: x.state, detail: x.detail ?? "" })), app: { name: ev.state.app.name ?? "", framework: ev.state.app.framework ?? "" } });
    } else if (ev.type === "step") await send({ step: { id: ev.step.id, doing: ev.step.doing, result: ev.result } });
  };
  note(`Your dashboard shows each step as it runs: ${apiHost().replace(/^https?:\/\//, "")}/account/get-started`);
  out();
  const exit = await walk({ ...o, yes: true, report }, {}, true);
  await report({ type: "state", state: await readState({ cwd: o.cwd, noAnalytics: o.noAnalytics }) });
  await send({ end: true, exit });
  return exit;
}

/** The walk itself (setup): every step in order until nothing is left that this machine can do. */
async function walk(o, deps, auto) {
  const skip = [];
  let failed = false;
  let details = !!o.all;
  if (!auto) o = { ...o, cwd: await whichApp(o.cwd) };
  let welcomed = false;
  let signInTries = 0;
  for (let turn = 0; turn < 14; turn++) {
    const state = await readState({ cwd: o.cwd, skip, noAnalytics: o.noAnalytics });
    const step = state.next;
    // genclass onboard: where the setup stands, for genclass.dev to show (a report that fails changes nothing here)
    if (o.report) await o.report({ type: "state", state });
    let go = auto;
    // the view, and (on a terminal) the keys: Enter starts the step, d unfolds or folds every part, s skips, q stops
    for (;;) {
      // the welcome card once, on the first screen of a walk someone is watching
      show(state, details, !auto && !welcomed);
      welcomed = true;
      if (!step) break;
      // Pro and the app's plan page are their own screens and ask their own question (the card, then Enter)
      if ((step.id === "plan" || step.id === "app-plan") && !auto) {
        go = true;
        break;
      }
      showNext(step, details);
      out();
      if (auto) break;
      // input that ended is a stop, never an Enter: nothing is started without someone at the keyboard
      const dot = c.gray("·");
      rule();
      const keys = `  ${PROMPT()} ${c.bold("Enter")} ${c.gray("to continue")} ${dot} ${c.bold("d")} ${c.gray(details ? "less" : "every part")} ${dot} ${c.bold("s")} ${c.gray("skip")} ${dot} ${c.bold("q")} ${c.gray("stop")}  `;
      const a = (await typed(keys)) ?? "q";
      if (/^d/i.test(a)) {
        details = !details;
        continue;
      }
      if (/^q/i.test(a)) {
        // leaving the walk is not leaving the command: its other commands are one prompt away
        if (o.home !== false && deps.home) {
          out();
          note("Setup stopped here. Type setup to go on with it.");
          return deps.home({ ...o, cwd: state.cwd, app: state.app.name ?? "" });
        }
        out();
        note(o.home === false ? "Setup stopped here. Type setup to go on with it." : "Stopped. Run npx genclass again any time: it continues from here.");
        out();
        return 0;
      }
      if (/^s/i.test(a)) skip.push(step.id);
      else go = true;
      break;
    }
    if (!step) {
      // someone is at a terminal: the command stays open (home.mjs); otherwise it says what is left and ends
      if (!auto && o.home !== false && deps.home) {
        const waiting = state.steps.filter((s) => s.state === "waiting");
        if (state.complete) out(`\n  ${c.green("Everything is set up.")}`);
        else if (waiting.length) {
          out();
          for (const s of waiting) note(`${s.title}: ${s.human ?? s.detail}.`);
        }
        return deps.home({ ...o, cwd: state.cwd, app: state.app.name ?? "" });
      }
      closing(state);
      break;
    }
    if (!go) continue;
    // Enter (or --yes) is the yes for what the step's sentence says it writes
    const so = { ...o, confirmed: true };
    let result = "skipped";
    if (o.report) await o.report({ type: "step", step, result: "running" });
    if (step.id === "account") result = await signIn(so);
    else if (step.id === "plan" || step.id === "app-plan") {
      result = step.id === "plan" ? await choosePlan(state, so) : await chooseAppPlan(state, so);
      // with --yes, Pro's step comes after the setup is done: its line says where the trial starts, and the walk ends
      // as a finished setup does (exit code 0), since what is after it is Pro's
      if (result === "quit" && auto && step.id === "plan") result = "skipped";
      // what is after Pro is Pro's (paywall.mjs), and an app waits for its plan
      if (result === "quit") {
        // Pro's card has said how to start it later (one line is enough: the 0.3.9 user stories had three); the
        // plan page's wait said where the page is. Inside the prompt, setup is typed again, not npx genclass
        if (!auto && step.id !== "plan") {
          out();
          note(o.home === false ? "Setup stopped here. Type setup to go on with it." : "Stopped. Run npx genclass again any time: it continues from here.");
        }
        out();
        return auto ? 1 : 0;
      }
    }
    else if (step.id === "runtime") result = await addRuntime(state, so);
    else if (step.id === "dashboard") result = await watchFirstPage(state, so);
    else if (step.id === "workflow") result = await addWorkflow(state, so);
    else if (step.id === "github-app") result = await connectGithubApp(state, so);
    else if (step.id === "agent") result = await connectAgent(state, so);
    else if (step.id === "suggestions") {
      if (auto || !deps.runSuggest) {
        note(`Run ${c.cyan("npx genclass suggest")} to see what your app is missing.`);
        result = "skipped";
      } else result = (await deps.runSuggest({ cwd: o.cwd, fromSetup: true, paid: state.steps.find((x) => x.id === "plan")?.state === "done" })) === 0 ? "done" : "failed";
    }
    if (o.report) await o.report({ type: "step", step, result });
    if (result === "failed") {
      failed = true;
      // what went wrong is above, in the step's own words; this says that the walk goes on without it (not for the
      // sign-in: every step after it needs it, so "the others go on" would not be true)
      if (!auto && step.id !== "account") {
        out();
        warn(`${step.doing} did not finish. The steps that do not need it go on, and npx genclass offers it again next time.`);
      }
    }
    // done or not, a step is not offered twice in one run: the next reading of the state says where it stands. The
    // one exception is a sign-in that did not finish (the code expired, the browser said no) while someone is at the
    // keyboard: everything after it is better with an account, so it is offered once more
    if (step.id === "account" && result === "failed" && !auto && signInTries++ < 1) note("Enter tries the sign-in again with a new code.");
    else {
      if (step.id === "account" && result === "failed" && !auto) note(`Sign in any time: ${deps.home && o.home !== false ? "type login" : "npx genclass login"}.`);
      skip.push(step.id);
    }
    out();
    rule();
  }
  return failed ? 1 : 0;
}
