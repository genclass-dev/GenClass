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

import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { addRuntime, addWorkflow, connectAgent, connectGithubApp, signIn, watchFirstPage } from "./actions.mjs";
import { opening } from "./art.mjs";
import { BUILD } from "./assets.mjs";
import { readState, stateJson } from "./state.mjs";
import { checklist, header, nextBlock, note, para, rule, summary, typed } from "./tui.mjs";

/**
 * Prints the header and the steps for a state: the short view, or with `details` every part and what is known
 * about it.
 */
export function show(state, details = false) {
  header({ app: state.app.name, framework: state.app.framework, account: state.account?.label ?? null, plan: state.account?.plan?.name ?? null, host: state.host });
  if (details) checklist(state.steps);
  else summary(state.steps);
  // the wrong folder is the first thing to know, whatever step comes next
  const blocked = state.steps.find((s) => s.state === "blocked");
  if (blocked) {
    out();
    note(`${upper(blocked.detail)}. Run genclass inside your web app's folder, or name it: ${c.cyan("genclass --cwd <folder>")}`);
  }
}

const upper = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/** What comes next, in one sentence; with `details`, the fuller explanation under it. */
function showNext(step, details) {
  nextBlock(step.doing, step.why);
  if (details && step.more) para(step.more, "        ", c.gray);
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
  out(`    ${c.cyan("genclass".padEnd(20))}${c.gray("where things stand and what comes next")}`);
  out(`    ${c.cyan("genclass suggest".padEnd(20))}${c.gray("what your app is missing, most important first")}`);
  if (state.app.token) out(`    ${c.cyan("genclass dashboard".padEnd(20))}${c.gray("what GenClass found on your live site, here in the terminal")}`);
  out();
}

/** `genclass status`: the steps (--all: every part), and the next one as a command. Exit code 0. */
export async function status(o = {}) {
  const state = await readState({ cwd: o.cwd });
  if (o.json) {
    out(JSON.stringify(stateJson(state), null, 2));
    return 0;
  }
  show(state, !!o.all);
  const step = state.next;
  if (step) {
    showNext(step, !!o.all);
    out();
    out(`        ${c.gray("Run")} ${c.cyan(step.run ?? "genclass setup")}${step.human ? c.gray(`  (then: ${step.human})`) : ""}`);
    if (!o.all) out(`        ${c.gray("Every part:")} ${c.cyan("genclass status --all")}`);
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
  if (!auto) opening(BUILD.version);
  for (let turn = 0; turn < 14; turn++) {
    const state = await readState({ cwd: o.cwd, skip });
    const step = state.next;
    let go = auto;
    // the view, and (on a terminal) the keys: Enter starts the step, d unfolds or folds every part, s skips, q stops
    for (;;) {
      show(state, details);
      if (!step) break;
      showNext(step, details);
      out();
      if (auto) break;
      // input that ended is a stop, never an Enter: nothing is started without someone at the keyboard
      const keys = `        ${c.bold("Enter")} ${c.gray("to continue,")} ${c.bold("d")} ${c.gray(details ? "for less," : "for every part,")} ${c.bold("s")} ${c.gray("to skip,")} ${c.bold("q")} ${c.gray("to stop")} `;
      const a = (await typed(keys)) ?? "q";
      if (/^d/i.test(a)) {
        details = !details;
        continue;
      }
      if (/^q/i.test(a)) {
        out();
        note("Stopped. Run genclass again any time: it continues from here.");
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
        note(`Run ${c.cyan("genclass suggest")} to see what your app is missing.`);
        result = "skipped";
      } else result = (await deps.runSuggest({ cwd: o.cwd, fromSetup: true })) === 0 ? "done" : "failed";
    }
    if (result === "failed") failed = true;
    // done or not, the step is not offered twice in one run: the next reading of the state says where it stands
    skip.push(step.id);
    out();
    rule();
  }
  if (o.json) out(JSON.stringify(stateJson(await readState({ cwd: o.cwd })), null, 2));
  return failed ? 1 : 0;
}
