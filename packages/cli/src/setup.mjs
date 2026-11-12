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
// - On a terminal a step starts on Enter, and Enter is the yes for what the step's sentence says it will write (s
//   skips it for this run, q stops). With --yes nothing is asked: every step that needs no person is done, and what
//   only a person can do (approve a sign-in, install the GitHub App, deploy) is printed with its address. Without a
//   terminal and without --yes nothing is done at all: the view and the next command are printed, which is what a
//   coding agent reads. Input that ends at a question (end of file) stops the walk: an empty answer is an Enter only
//   while someone can still type.
// - A step that fails or is skipped does not stop the ones after it that do not depend on it.

import { join, resolve } from "node:path";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { addRuntime, addWorkflow, connectAgent, connectGithubApp, signIn, watchFirstPage } from "./actions.mjs";
import { brand, canDraw } from "./art.mjs";
import { BUILD } from "./assets.mjs";
import { appsBelow, readState, stateJson } from "./state.mjs";
import { barPara, card, checklist, header, nextBlock, note, pick, PROMPT, rule, summary, typed } from "./tui.mjs";

/**
 * Prints the header and the steps for a state: the short view, or with `details` every part and what is known
 * about it.
 */
export function show(state, details = false, welcome = false) {
  const h = { app: state.app.name, framework: state.app.framework, account: state.account?.label ?? null, plan: state.account?.plan?.name ?? null, host: state.host };
  // the first screen on a terminal is the welcome card; every later one, and anything piped, is the two-line header
  if (welcome && canDraw()) card({ ...h, cwd: state.cwd, version: BUILD.version });
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
function closing(state) {
  out();
  const waiting = state.steps.filter((s) => s.state === "waiting");
  const blocked = state.steps.find((s) => s.state === "blocked");
  if (blocked) {
    /* show() has said where to run it */
  } else if (state.complete) out(`  ${c.green("Everything is set up.")}`);
  else if (waiting.length) {
    out(`  ${c.bold("Nothing more to do here right now.")}`);
    for (const s of waiting) note(`${s.title}: ${s.human ?? s.detail}.`);
  }
  out();
  out(`  ${c.gray("Day to day")}`);
  out(`    ${c.cyan("npx genclass".padEnd(23))}${c.gray("where things stand")}`);
  out(`    ${c.cyan("npx genclass suggest".padEnd(23))}${c.gray("what your app is missing")}`);
  if (state.app.token) out(`    ${c.cyan("npx genclass dashboard".padEnd(23))}${c.gray("what it found on your site")}`);
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
    barPara(`${c.gray("Run")} ${c.cyan(step.run ?? "npx genclass setup")}${step.human ? c.gray(`  (then: ${step.human})`) : ""}`, (l) => l);
    out();
    if (!o.all) out(`  ${c.gray("Every part:")} ${c.cyan("npx genclass status --all")}`);
    out();
  } else closing(state);
  return 0;
}

/**
 * `genclass setup` (and `genclass` on a terminal): walks the steps. `runSuggest` runs the suggestions step (passed in
 * by cli.mjs, so this module does not load the checks until they are needed). Exit code 0, or 1 when a step failed.
 * @param {{ cwd?: string, yes?: boolean, noBrowser?: boolean, json?: boolean, all?: boolean }} o
 * @param {{ runSuggest?: (o: object) => Promise<number> }} [deps]
 */
export async function setup(o = {}, deps = {}) {
  const auto = !!o.yes;
  if (!auto && !interactive()) return status(o);
  const skip = [];
  let failed = false;
  let details = !!o.all;
  if (!auto) o = { ...o, cwd: await whichApp(o.cwd) };
  let welcomed = false;
  let signInTries = 0;
  for (let turn = 0; turn < 14; turn++) {
    const state = await readState({ cwd: o.cwd, skip });
    const step = state.next;
    let go = auto;
    // the view, and (on a terminal) the keys: Enter starts the step, d unfolds or folds every part, s skips, q stops
    for (;;) {
      // the welcome card once, on the first screen of a walk someone is watching
      show(state, details, !auto && !welcomed);
      welcomed = true;
      if (!step) break;
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
        out();
        note("Stopped. Run npx genclass again any time: it continues from here.");
        out();
        return 0;
      }
      if (/^s/i.test(a)) skip.push(step.id);
      else go = true;
      break;
    }
    if (!step) {
      closing(state);
      break;
    }
    if (!go) continue;
    // Enter (or --yes) is the yes for what the step's sentence says it writes
    const so = { ...o, confirmed: true };
    let result = "skipped";
    if (step.id === "account") result = await signIn(so);
    else if (step.id === "runtime") result = await addRuntime(state, so);
    else if (step.id === "dashboard") result = await watchFirstPage(state, so);
    else if (step.id === "workflow") result = await addWorkflow(state, so);
    else if (step.id === "github-app") result = await connectGithubApp(state, so);
    else if (step.id === "agent") result = await connectAgent(state, so);
    else if (step.id === "suggestions") {
      if (auto || !deps.runSuggest) {
        note(`Run ${c.cyan("npx genclass suggest")} to see what your app is missing.`);
        result = "skipped";
      } else result = (await deps.runSuggest({ cwd: o.cwd, fromSetup: true })) === 0 ? "done" : "failed";
    }
    if (result === "failed") failed = true;
    // done or not, a step is not offered twice in one run: the next reading of the state says where it stands. The
    // one exception is a sign-in that did not finish (the code expired, the browser said no) while someone is at the
    // keyboard: everything after it is better with an account, so it is offered once more
    if (step.id === "account" && result === "failed" && !auto && signInTries++ < 1) note("Enter tries the sign-in again with a new code.");
    else skip.push(step.id);
    out();
    rule();
  }
  if (o.json) out(JSON.stringify(stateJson(await readState({ cwd: o.cwd })), null, 2));
  return failed ? 1 : 0;
}
