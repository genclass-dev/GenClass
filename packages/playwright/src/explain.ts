// What a report says about a test that failed in some runs: its failing runs against its passing ones when the race
// files hold enough of both (order.ts), and one line naming the command that makes the runs when they do not. Pure:
// no I/O, no clock; the same files give the same lines whatever order they come in.
//
// It is a section of its own, built here and handed to the summariser through its `after` option, and it is never
// counted as a signature. The summariser itself (summarize.ts) does not import this module: a reader that only
// summarises race files, such as genclass-dev[bot], bundles summarize.ts from source and gets neither this section
// nor its work. The local reporter and the two commands use summarizeWithOrder().
//
// This module is also built as a file of its own (dist/explain.js: the comparison and what reads a file's steps,
// re-exported at the bottom), for the package's end-to-end check and the repository's bench. It is not one of the
// package's public entries: `@genclass/playwright` and `/summarize` are the summariser, as they were.
//
// When there is nothing to say, nothing is said: a test that never failed, files without a status (written by 0.1.0),
// a test with too few runs whose failing run has a witness to read first, and a test that failed in every run with no
// delay applied (a test that is simply failing) add no line, so a report over such files is byte for byte what the
// summariser alone gives.

import { chanceText, differenceText, explainOrder, runsOf, statementText, verdictText, type ExplainOptions, type OrderExplanation } from "./order.js";
import { parseRaces, validateRaces } from "./schema.js";
import { DEFAULT_MAX_CHARS, WITNESS_TRIGGER, buildSummary, escapeMarkdown, inlineCode, renderMarkdown, type SummarizeOptions } from "./summarize.js";
import type { GenClassRacesFile, RacesFileInput, RacesLocation } from "./types.js";

/** The option of genclass-playwright-run that runs a test many times and compares its failing and passing runs. */
export const EXPLAIN_FLAG = "--explain-flaky";
/** How many times that command runs the test unless told: enough for three failing runs of a test that fails one time in six. */
export const EXPLAIN_RUNS = 30;
/** In a report: at most this many tests in the section, and at most this share of the report's size. */
export const MAX_ORDER_TESTS = 20;
const ORDER_SHARE = 0.4;

/** One test's runs, as its race files tell them, and its failing runs against its passing ones. */
export interface TestOrder {
  test: string;
  /** Race files read for this test. */
  files: number;
  /** Files whose test failed or timed out, and files whose test passed. A file without a status counts in neither. */
  failed: number;
  passed: number;
  /** The comparison; its verdict is "too-few-runs" when nothing could be compared. */
  explanation: OrderExplanation;
  /** Failing or passing runs whose file carries no steps (not compared). */
  withoutSteps: number;
  /** A failing run was under the fixture's delays (chaos on and at least one request held). */
  underDelays: boolean;
  /** A failing run's file has a witness. */
  witnessed: boolean;
  /** Where the test is declared, from the first file (by name) that says. */
  location?: RacesLocation;
  /**
   * With too few runs to compare and no witness in a failing run: the command that runs the test many times and
   * compares them. Null when the comparison was made, when a witness is there to read first, or when the test
   * failed in every run with no delay applied.
   */
  hint: string | null;
}

export interface ReportOptions extends SummarizeOptions {
  /** The comparison's own options: its minimum of runs, its shuffles (order.ts). */
  order?: ExplainOptions;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The command that runs one test many times and compares its failing and passing runs (genclass-playwright-run). */
export function explainCommand(test: string, location: RacesLocation | undefined): string {
  if (location) return `npx genclass-playwright-run ${EXPLAIN_FLAG} ${/\s/.test(location.file) ? JSON.stringify(`${location.file}:${location.line}`) : `${location.file}:${location.line}`}`;
  // without a place: by the test's own title (the last part of its name), as a pattern for --grep
  const title = test.split(" > ").pop() ?? test;
  return `npx genclass-playwright-run ${EXPLAIN_FLAG} -g ${JSON.stringify(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}`;
}

/**
 * Every test in the files, by name, with its runs and the comparison of its failing and passing ones. Files that do
 * not validate are left out here (the summariser lists them as skipped). Never throws.
 */
export function testOrders(inputs: readonly RacesFileInput[], options: ExplainOptions = {}): TestOrder[] {
  const byTest = new Map<string, GenClassRacesFile[]>();
  for (const input of [...inputs].sort((a, b) => cmp(a.name, b.name))) {
    if (input.error) continue;
    const r = typeof input.content === "string" ? parseRaces(input.content) : validateRaces(input.content);
    if (!r.ok) continue;
    const list = byTest.get(r.file.test);
    if (list) list.push(r.file);
    else byTest.set(r.file.test, [r.file]);
  }
  const out: TestOrder[] = [];
  for (const [test, files] of byTest) {
    const runs = runsOf(files);
    const failing = files.filter((f) => f.status === "failed" || f.status === "timedOut");
    const underDelays = failing.some((f) => !!f.chaos && (f.fixture?.chaosApplied ?? 0) > 0);
    const witnessed = failing.some((f) => f.signatures.some((s) => s.trigger === WITNESS_TRIGGER));
    const explanation = explainOrder(runs.runs, options);
    const location = files.find((f) => f.location)?.location;
    // too few runs to compare: name the command, unless a witness in a failing run is there to read first, or the
    // test never passed and no delay was applied (a test that is simply failing)
    const hint = runs.failed > 0 && explanation.verdict === "too-few-runs" && !witnessed && (underDelays || runs.passed > 0) ? explainCommand(test, location) : null;
    const t: TestOrder = { test, files: files.length, failed: runs.failed, passed: runs.passed, explanation, withoutSteps: runs.withoutSteps, underDelays, witnessed, hint };
    if (location) t.location = location;
    out.push(t);
  }
  return out.sort((a, b) => cmp(a.test, b.test));
}

const VERDICT_RANK: Readonly<Record<string, number>> = { explained: 0, chance: 1, "no-difference": 2, "too-few-runs": 3 };

/** The tests a report has something to say about under "failed in some runs", in the order it says it. */
export function ordersToReport(orders: readonly TestOrder[]): TestOrder[] {
  return orders
    .filter((t) => t.failed > 0 && (t.explanation.verdict !== "too-few-runs" || t.hint !== null))
    .sort((a, b) => VERDICT_RANK[a.explanation.verdict] - VERDICT_RANK[b.explanation.verdict] || cmp(a.test, b.test));
}

/**
 * What a report says about one test that failed in some runs: its failing runs against its passing ones, or the
 * command that makes enough runs to compare. `markdown`: for the report (the test's name escaped, emphasis); else
 * plain lines for a terminal. Empty when there is nothing to say.
 */
export function orderLines(t: TestOrder, markdown: boolean): string[] {
  if (t.failed === 0) return [];
  const x = t.explanation;
  const name = markdown ? `**${escapeMarkdown(t.test)}**` : t.test;
  const head = `${name} · failed in ${t.failed} of ${plural(t.failed + t.passed, "run")}${t.underDelays ? " (under the delays)" : ""}`;
  if (x.verdict === "too-few-runs") {
    if (t.hint === null) return [];
    return [
      `${head}, and no witness was recorded in a failing run. That is too few runs to compare (it takes ${x.minimum.failing} failing and ${x.minimum.passing} passing). This runs the test ${EXPLAIN_RUNS} times, each run on its own, and compares the order of steps in its failing and passing runs: ${inlineCode(t.hint)}`,
    ];
  }
  const L = [head, "", verdictText(x)];
  if (x.differences.length) {
    L.push("");
    x.differences.forEach((d, i) => {
      L.push(`${i + 1}. ${differenceText(d, x, inlineCode)}`);
      if (d.alike > 0) L.push(`   The same runs also have: ${d.also.map((a) => statementText(a, inlineCode)).join("; ")}${d.alike > d.also.length ? `; and ${plural(d.alike - d.also.length, "more order")}` : ""}.`);
    });
    // orders that met the same measure and are not in the list (the ones the lines above name as "also" are counted there)
    const others = x.more - x.differences.reduce((n, d) => n + d.alike, 0);
    if (others > 0) L.push("", `${plural(others, "other order")} of steps ${others === 1 ? "has" : "have"} as many failing runs as shuffled outcomes rarely give and ${others === 1 ? "adds" : "add"} no failing run to ${x.differences.length === 1 ? "this one" : "these"}.`);
  }
  const chance = chanceText(x);
  if (chance) L.push("", chance);
  const notes: string[] = [];
  if (t.withoutSteps > 0) notes.push(`${plural(t.withoutSteps, "run")} had no recorded steps and ${t.withoutSteps === 1 ? "was" : "were"} not compared`);
  if (x.capped) notes.push("there were more runs or steps than are compared, and the first ones were taken");
  if (notes.length) L.push("", `Note: ${notes.join("; ")}.`);
  return L;
}

/** What the section is, in the report. */
export const ORDER_HEADING = "### Failed in some runs: the order of steps, failing against passing";
export const ORDER_INTRO =
  "For a test that failed in some runs and passed in others, the order of user actions, requests and responses in its failing runs is compared with the order in its passing runs. " +
  "It is a measured comparison, given with its counts and with what shuffled outcomes give, not a diagnosis: an order only the failing runs have may be the cause, a consequence of the cause, or neither.";

/**
 * The report's section, as markdown lines: a heading, what the comparison is, and each test's lines. At most
 * MAX_ORDER_TESTS tests and `maxChars` characters; what is left out is counted in one last line. Empty when no test
 * has anything to say.
 */
export function orderSection(orders: readonly TestOrder[], maxChars = Infinity): string[] {
  const tests = ordersToReport(orders);
  if (tests.length === 0) return [];
  const L = [ORDER_HEADING, "", ORDER_INTRO];
  let size = L.join("\n").length;
  let shown = 0;
  for (const t of tests) {
    const lines = orderLines(t, true);
    const more = lines.join("\n").length + 2;
    if (shown >= MAX_ORDER_TESTS || (shown > 0 && size + more > maxChars)) break;
    L.push("", ...lines);
    size += more;
    shown++;
  }
  if (shown < tests.length) L.push("", `_…and ${plural(tests.length - shown, "more test")} that failed in some runs, not shown._`);
  return L;
}

/**
 * Files -> markdown, as summarize() gives it, with the section about tests that failed in some runs after the tests
 * with signatures. With no such test the result is summarize()'s own, byte for byte. Pure; never throws.
 */
export function summarizeWithOrder(inputs: readonly RacesFileInput[], options: ReportOptions = {}): string {
  const max = typeof options.maxChars === "number" && !Number.isNaN(options.maxChars) ? (options.maxChars === 0 || options.maxChars === Infinity ? Infinity : Math.max(1000, Math.floor(options.maxChars))) : DEFAULT_MAX_CHARS;
  const after = orderSection(testOrders(inputs, options.order), max === Infinity ? Infinity : Math.floor(max * ORDER_SHARE));
  return renderMarkdown(buildSummary(inputs, options), after.length ? { ...options, after } : options);
}

// The comparison itself and what reads a file's steps, for whoever loads this module as a file (see the header).
export { DEFAULT_ALPHA, DEFAULT_MIN_RUNS, DEFAULT_SHUFFLES, EXACT_WAYS, PASSING_PER_EXCEPTION, chanceText, differenceText, explainOrder, runsOf, statementText, stepText, verdictText } from "./order.js";
export type { ExplainOptions, OrderChance, OrderDifference, OrderExplanation, OrderRun, OrderStatement, OrderVerdict, StepRef, TestRuns } from "./order.js";
export { decodeSteps, readSteps } from "./steps.js";
export type { StepEvent, StepKind } from "./steps.js";
