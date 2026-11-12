// `genclass` and `genclass setup`: the one way to set GenClass up. It reads where the project stands (state.mjs),
// shows the checklist, does the next step (actions.mjs) and reads the state again, until nothing is left that this
// machine can do. `genclass status` prints the same checklist and stops.
//
// Invariants:
// - One next step at a time, always the first one open in the fixed order, and every run starts from what is true
//   now: stopping at any point and running `genclass` again continues where it left off, and a step done by hand or
//   by another tool counts.
// - On a terminal each step waits for Enter (s skips it for this run, q stops). With --yes nothing is asked: every
//   step that needs no person is done, and what only a person can do (approve a sign-in, install the GitHub App,
//   deploy) is printed with its address. Without a terminal and without --yes nothing is done at all: the checklist
//   and the next command are printed, which is what a coding agent reads.
// - A step that fails or is skipped does not stop the ones after it that do not depend on it.

import { ask, c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { addRuntime, connectAgent, setUpPullRequests, signIn, watchFirstPage } from "./actions.mjs";
import { readState, stateJson } from "./state.mjs";
import { checklist, header, nextBlock, note, rule } from "./tui.mjs";

/** What the Next block calls each step. */
const DOING = {
  account: "Sign in to GenClass",
  runtime: "Add GenClass to this app",
  "first-page": "See your first page",
  "pull-requests": "Check every pull request",
  agent: "Connect your coding agent",
  suggestions: "See what your app is missing",
};

/** Prints the header and the checklist for a state. */
export function show(state) {
  header({ app: state.app.name, framework: state.app.framework, account: state.account?.label ?? null, plan: state.account?.plan?.name ?? null, host: state.host });
  checklist(state.steps);
}

/** The lines under the checklist when nothing is left to walk through. */
function closing(state) {
  out();
  const waiting = state.steps.filter((s) => s.state === "waiting");
  const blocked = state.steps.find((s) => s.state === "blocked");
  if (blocked) note(`${blocked.title}: ${blocked.detail}. Run genclass inside your web app's folder (or pass --cwd).`);
  else if (state.complete) out(`  ${c.green("Everything is set up.")}`);
  else if (waiting.length) {
    out(`  ${c.bold("Nothing more to do here right now.")}`);
    for (const s of waiting) note(`${s.title}: ${s.human ?? s.detail}.`);
  }
  out();
  out(`  ${c.gray("Day to day")}`);
  out(`    ${c.cyan("genclass".padEnd(20))}${c.gray("where things stand and what comes next")}`);
  out(`    ${c.cyan("genclass suggest".padEnd(20))}${c.gray("what your app is missing, most important first")}`);
  if (state.app.token) out(`    ${c.cyan("genclass dashboard".padEnd(20))}${c.gray("what GenClass found on your live site")}`);
  out();
}

/** `genclass status`: the checklist, and the next step as a command. Exit code 0. */
export async function status(o = {}) {
  const state = await readState({ cwd: o.cwd });
  if (o.json) {
    out(JSON.stringify(stateJson(state), null, 2));
    return 0;
  }
  show(state);
  const step = state.next;
  if (step) {
    nextBlock(DOING[step.id] ?? step.title, step.why);
    out();
    out(`        ${c.gray("Run")} ${c.cyan(step.run ?? "genclass setup")}${step.human ? c.gray(`  (then: ${step.human})`) : ""}`);
    out();
  } else closing(state);
  return 0;
}

/**
 * `genclass setup` (and `genclass` on a terminal): walks the steps. `runSuggest` runs the suggestions step (passed in
 * by cli.mjs, so this module does not load the checks until they are needed). Exit code 0, or 1 when a step failed.
 * @param {{ cwd?: string, yes?: boolean, noBrowser?: boolean, json?: boolean }} o
 * @param {{ runSuggest?: (o: object) => Promise<number> }} [deps]
 */
export async function setup(o = {}, deps = {}) {
  const auto = !!o.yes;
  if (!auto && !interactive()) return status(o);
  const skip = [];
  let failed = false;
  for (let turn = 0; turn < 12; turn++) {
    const state = await readState({ cwd: o.cwd, skip });
    show(state);
    const step = state.next;
    if (!step) {
      closing(state);
      break;
    }
    nextBlock(DOING[step.id] ?? step.title, step.why);
    out();
    if (!auto) {
      const a = (await ask(`        ${c.bold("Enter")} ${c.gray("to continue,")} ${c.bold("s")} ${c.gray("to skip,")} ${c.bold("q")} ${c.gray("to stop")} `)) ?? "q";
      if (/^q/i.test(a)) {
        out();
        note("Stopped. Run genclass again any time: it continues from here.");
        out();
        return 0;
      }
      if (/^s/i.test(a)) {
        skip.push(step.id);
        continue;
      }
    }
    let result = "skipped";
    if (step.id === "account") result = await signIn(o);
    else if (step.id === "runtime") result = await addRuntime(state, o);
    else if (step.id === "first-page") result = await watchFirstPage(state, o);
    else if (step.id === "pull-requests") result = await setUpPullRequests(state, o);
    else if (step.id === "agent") result = await connectAgent(state, o);
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
