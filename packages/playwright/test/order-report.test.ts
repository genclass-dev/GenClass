// What the report says about a test that failed in some runs (src/explain.ts): its failing runs against its passing
// ones when there are enough of both (src/order.ts), one line naming the command when there are not, and nothing at
// all for files that carry no status. Exact text, because the report is posted on pull requests. The summariser
// alone (src/summarize.ts, which genclass-dev[bot] bundles) says none of it.
import { describe, expect, it } from "vitest";
import { encodeSteps, type StepEvent } from "../src/steps.js";
import { EXPLAIN_FLAG, EXPLAIN_RUNS, MAX_ORDER_TESTS, explainCommand, orderLines, orderSection, ordersToReport, summarizeWithOrder, testOrders } from "../src/explain.js";
import { buildSummary, summarize } from "../src/summarize.js";
import type { RacesFileInput } from "../src/types.js";
import { FIXTURE_REPORT, fixtureInputs } from "./helpers.js";

/** Steps from short names, 10 ms apart: "a:click Go", "s:GET /x", "r:GET /x#2" (the number is 1 unless given). */
function seq(...items: string[]): StepEvent[] {
  return items.map((item, i) => {
    const m = /^([asrx]):(.*?)(?:#(\d+))?$/.exec(item)!;
    return { kind: m[1] as StepEvent["kind"], label: m[2], n: Number(m[3] ?? 1), t: i * 10 };
  });
}

/** One race file: a test, a seed, the test's status and its steps. */
function file(test: string, seed: number, status: string | undefined, steps: StepEvent[] | null, extra: Record<string, unknown> = {}): RacesFileInput {
  return {
    name: `test-results/genclass/${test.replace(/[^a-z]+/gi, "-")}-s${seed}.json`,
    content: JSON.stringify({ schema: "genclass-races/1", test, seed, signatures: [], ...(status ? { status } : {}), ...(steps ? { steps: encodeSteps({ events: steps, bodyKnown: true }, { max: 300, bytes: 5000 }) } : {}), ...extra }),
  };
}

/** A bulk edit: the response lands before the click on the tag, between the two clicks, or after the second. */
function bulkEdit(where: "before" | "between" | "after", failed: boolean): StepEvent[] {
  const items = ['a:click button "Tags"', "s:POST /api/selection", 'a:type input "Filter tags"', 'a:click menuitem "Urgent"', 'a:click button "Apply"'];
  items.splice(where === "before" ? 3 : where === "between" ? 4 : 5, 0, "r:POST /api/selection");
  if (!failed) items.push('a:click button "Confirm"', "s:POST /api/bulk_edit", "r:POST /api/bulk_edit");
  return seq(...items);
}

const DELAYS = { chaos: { latencyMs: [0, 600], reorder: true }, fixture: { model: "skip", agent: null, chaosApplied: 4, serviceWorker: false } };
const BULK = "list.spec.ts > bulk edit";
const at = (line: number) => ({ location: { file: "e2e/list.spec.ts", line } });
const bulk: RacesFileInput[] = [
  ...Array.from({ length: 5 }, (_, i) => file(BULK, 1 + i, "failed", bulkEdit("between", true), { ...DELAYS, ...at(140) })),
  ...Array.from({ length: 6 }, (_, i) => file(BULK, 6 + i, "passed", bulkEdit("before", false), { ...DELAYS, ...at(140) })),
  ...Array.from({ length: 7 }, (_, i) => file(BULK, 12 + i, "passed", bulkEdit("after", false), { ...DELAYS, ...at(140) })),
];
const CART = "cart.spec.ts > adds two";
const cart: RacesFileInput[] = [file(CART, 1, "failed", bulkEdit("between", true), { ...DELAYS, location: { file: "e2e/cart.spec.ts", line: 12 } }), file(CART, 2, "passed", bulkEdit("before", false), DELAYS)];

const INTRO =
  "For a test that failed in some runs and passed in others, the order of user actions, requests and responses in its failing runs is compared with the order in its passing runs. " +
  "It is a measured comparison, given with its counts and with what shuffled outcomes give, not a diagnosis: an order only the failing runs have may be the cause, a consequence of the cause, or neither.";
const DIFFERENCE =
  '1. In 5 of 5 failing runs and in none of the 13 passing runs that recorded these steps, the response to `POST /api/selection` came between the action `click menuitem "Urgent"` and the action `click button "Apply"` ' +
  "(median 10 ms after the first and 10 ms before the second; there it came before the first of the two in 6 and after the second in 7).";
const CHANCE = "With the outcomes shuffled 1000 times, 0 gave an order that every failing run has and no passing run has. Orders that every failing run has and no passing run has: 1 here, 0 on average per shuffle.";
const HINT =
  "**cart.spec.ts > adds two** · failed in 1 of 2 runs (under the delays), and no witness was recorded in a failing run. That is too few runs to compare (it takes 3 failing and 3 passing). " +
  "This runs the test 30 times, each run on its own, and compares the order of steps in its failing and passing runs: `npx genclass-playwright-run --explain-flaky e2e/cart.spec.ts:12`";

describe("order in the report: a test with enough failing and passing runs", () => {
  it("gets a section of its own with the comparison, its counts and what shuffled outcomes gave; a test with too few gets the command", () => {
    expect(summarizeWithOrder([...bulk, ...cart], { sources: ["test-results/genclass"] })).toBe(
      [
        "<!-- genclass-report -->",
        "## GenClass race report",
        "",
        "**Nothing flagged** in 2 tests · 20 files read in `test-results/genclass`",
        "",
        "### Failed in some runs: the order of steps, failing against passing",
        "",
        INTRO,
        "",
        "**list.spec.ts > bulk edit** · failed in 5 of 18 runs (under the delays)",
        "",
        "Compared 5 failing runs with 13 passing runs: every failing run has this order of steps, and no passing run does.",
        "",
        DIFFERENCE,
        "",
        CHANCE,
        "",
        HINT,
        "",
        "<details><summary>2 tests with nothing flagged</summary>",
        "",
        "- cart.spec.ts > adds two (2 seeds: 1, 2)",
        "- list.spec.ts > bulk edit (18 seeds: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)",
        "",
        "</details>",
        "",
      ].join("\n"),
    );
  });

  it("is the same whatever order the files come in, never counts as a signature, and is no part of the summariser alone", () => {
    const forward = summarizeWithOrder([...bulk, ...cart]);
    expect(summarizeWithOrder([...cart, ...bulk].reverse())).toBe(forward);
    expect(buildSummary([...bulk, ...cart]).totals.signatures).toBe(0);
    // the summariser a reader may bundle on its own says nothing of it, and its summary has no field for it
    const alone = summarize([...bulk, ...cart]);
    expect(alone).not.toContain("Failed in some runs");
    expect(forward.replace(`${orderSection(testOrders([...bulk, ...cart])).join("\n")}\n\n`, "")).toBe(alone);
    expect(Object.keys(buildSummary(bulk).tests[0])).not.toContain("order");
    const orders = testOrders([...bulk, ...cart]);
    expect(orders.map((t) => [t.test, t.files, t.failed, t.passed])).toEqual([
      [CART, 2, 1, 1],
      [BULK, 18, 5, 13],
    ]);
    expect(ordersToReport(orders).map((t) => t.test)).toEqual([BULK, CART]);
    expect(orders[1]).toMatchObject({ withoutSteps: 0, underDelays: true, witnessed: false, hint: null, location: { file: "e2e/list.spec.ts", line: 140 }, explanation: { verdict: "explained", failing: 5, passing: 13, covered: 5 } });
  });

  it("the lines for a terminal are the same sentences without the markup", () => {
    expect(orderLines(testOrders(bulk)[0], false)).toEqual([
      "list.spec.ts > bulk edit · failed in 5 of 18 runs (under the delays)",
      "",
      "Compared 5 failing runs with 13 passing runs: every failing run has this order of steps, and no passing run does.",
      "",
      DIFFERENCE,
      "",
      CHANCE,
    ]);
    expect(orderLines(testOrders(fixtureInputs())[0], true)).toEqual([]);
  });

  it("runs without steps are not compared and the section says how many; a verdict that is not an explanation lists no order", () => {
    const some = [...bulk, file(BULK, 30, "passed", null, DELAYS), file(BULK, 31, "failed", null, DELAYS)];
    const lines = orderLines(testOrders(some)[0], true);
    expect(lines[0]).toBe("**list.spec.ts > bulk edit** · failed in 6 of 20 runs (under the delays)");
    expect(lines[lines.length - 1]).toBe("Note: 2 runs had no recorded steps and were not compared.");
    // three failing against three passing: compared, and too few to tell an order from chance
    const three = [...bulk.slice(0, 3), ...bulk.slice(5, 8)];
    const few = orderLines(testOrders(three)[0], true);
    expect(few).toHaveLength(5);
    expect(few[2]).toMatch(/^Compared 3 failing runs with 3 passing runs: \d+ orders? of steps (is|are) the failing runs' alone, the most frequent in 3 of 3, and shuffled outcomes give as much too often to call any of them an explanation\. More runs would tell\.$/);
    expect(few[4]).toMatch(/^Of the 20 ways to choose which 3 of these 6 runs failed, \d+ give an order that every failing run has and no passing run has \(the real outcomes are one of them\)\./);
    expect(few.join("\n")).not.toMatch(/^\d\. /m);
  });

  it("the minimum of runs is an option of the report", () => {
    const t = testOrders(bulk, { minFailing: 6 })[0];
    expect(t).toMatchObject({ explanation: { verdict: "too-few-runs", minimum: { failing: 6, passing: 3 } } });
    expect(orderLines(t, true)[0]).toContain("it takes 6 failing and 3 passing");
    expect(summarizeWithOrder(bulk, { order: { minFailing: 6 } })).toContain("it takes 6 failing and 3 passing");
  });
});

describe("order in the report: too few runs to compare", () => {
  it("one line naming the command, when a failing run has no witness to read first", () => {
    const t = testOrders(cart)[0];
    expect(t).toMatchObject({ hint: "npx genclass-playwright-run --explain-flaky e2e/cart.spec.ts:12", underDelays: true, witnessed: false, explanation: { verdict: "too-few-runs" } });
    expect(orderLines(t, true)).toEqual([HINT]);
    expect(EXPLAIN_RUNS).toBe(30);
  });

  it("nothing when a failing run has a witness, when the test simply fails without delays, or when it never failed", () => {
    const witness = { sig: "witness|overwrote-newer|GET /api/cart", trigger: "witness", diagnosis: "overwrote-newer", op: "GET /api/cart", confidence: 1, evidence: "e", seeds: [1] };
    const witnessed = testOrders([file(CART, 1, "failed", bulkEdit("between", true), { ...DELAYS, signatures: [witness] }), file(CART, 2, "passed", bulkEdit("before", false), DELAYS)]);
    expect(witnessed[0]).toMatchObject({ witnessed: true, hint: null });
    expect(ordersToReport(witnessed)).toEqual([]);
    expect(orderSection(witnessed)).toEqual([]);
    // a witness in a passing run only is not one that explains the failing run
    const elsewhere = testOrders([file(CART, 1, "failed", bulkEdit("between", true), DELAYS), file(CART, 2, "passed", bulkEdit("before", false), { ...DELAYS, signatures: [{ ...witness, seeds: [2] }] })]);
    expect(elsewhere[0].hint).not.toBeNull();
    // failing in every run with no delay applied: a failing test, not one to compare with itself
    const broken = testOrders([file(CART, 1, "failed", bulkEdit("between", true)), file(CART, 2, "timedOut", bulkEdit("between", true), { chaos: null, fixture: { model: "skip", agent: null, chaosApplied: null, serviceWorker: false } })]);
    expect(broken[0]).toMatchObject({ failed: 2, passed: 0, underDelays: false, hint: null });
    expect(orderLines(broken[0], true)).toEqual([]);
    // delays on that held nothing are not "under the delays"
    const idle = testOrders([file(CART, 1, "failed", bulkEdit("between", true), { chaos: DELAYS.chaos, fixture: { ...DELAYS.fixture, chaosApplied: 0 } })]);
    expect(idle[0].underDelays).toBe(false);
    // failing in every run under the delays: the command is named (without them the test may pass)
    expect(testOrders([file(CART, 1, "failed", bulkEdit("between", true), DELAYS)])[0].hint).not.toBeNull();
    // failing and passing without delays: flaky on its own, the command is named
    const flaky = testOrders([file(CART, 1, "failed", bulkEdit("between", true)), file(CART, 2, "passed", bulkEdit("before", false))]);
    expect(orderLines(flaky[0], true)[0]).toMatch(/^\*\*cart\.spec\.ts > adds two\*\* · failed in 1 of 2 runs, and no witness was recorded in a failing run\./);
    const passed = testOrders([file(CART, 1, "passed", bulkEdit("before", false), DELAYS)]);
    expect(passed[0]).toMatchObject({ failed: 0, passed: 1, hint: null, explanation: { verdict: "too-few-runs" } });
    expect(orderLines(passed[0], true)).toEqual([]);
    expect(summarizeWithOrder([file(CART, 1, "passed", bulkEdit("before", false), DELAYS)])).toBe(summarize([file(CART, 1, "passed", bulkEdit("before", false), DELAYS)]));
  });

  it("the command selects the test by where it is declared, else by its title", () => {
    expect(EXPLAIN_FLAG).toBe("--explain-flaky");
    expect(explainCommand("a.spec.ts > t", { file: "e2e/a.spec.ts", line: 7 })).toBe("npx genclass-playwright-run --explain-flaky e2e/a.spec.ts:7");
    expect(explainCommand("a.spec.ts > t", { file: "e2e/my tests/a.spec.ts", line: 7 })).toBe('npx genclass-playwright-run --explain-flaky "e2e/my tests/a.spec.ts:7"');
    expect(explainCommand("[chromium] a.spec.ts > checkout > pays (twice)", undefined)).toBe('npx genclass-playwright-run --explain-flaky -g "pays \\\\(twice\\\\)"');
    expect(orderLines(testOrders([file(CART, 1, "failed", bulkEdit("between", true), DELAYS)])[0], true)[0]).toContain('`npx genclass-playwright-run --explain-flaky -g "adds two"`');
  });
});

describe("order in the report: what stays as it was", () => {
  it("files without a status (an older fixture's) give the report they always gave", () => {
    expect(summarizeWithOrder(fixtureInputs(), { sources: ["test-results/genclass"] })).toBe(FIXTURE_REPORT);
    const orders = testOrders(fixtureInputs());
    expect(orders).toHaveLength(2);
    expect(orders.every((t) => t.failed === 0 && t.passed === 0 && t.hint === null)).toBe(true);
    expect(ordersToReport(orders)).toEqual([]);
    // files that do not validate are the summariser's to list as skipped; they are no test here
    expect(testOrders([{ name: "x.json", content: "{}" }, { name: "y.json", content: null, error: "could not be read" }])).toEqual([]);
  });

  it("the section is bounded: so many tests, and a share of a report that has a size limit; what is left out is counted", () => {
    const many: RacesFileInput[] = [];
    for (let t = 0; t < 40; t++) many.push(file(`suite${String(t).padStart(2, "0")}.spec.ts > flaky ${"x".repeat(60)}`, 1, "failed", bulkEdit("between", true), DELAYS), file(`suite${String(t).padStart(2, "0")}.spec.ts > flaky ${"x".repeat(60)}`, 2, "passed", bulkEdit("before", false), DELAYS));
    const hints = (text: string): number => text.match(/and no witness was recorded in a failing run/g)?.length ?? 0;
    // without a size limit: the first twenty tests, and a line for the rest
    const full = summarizeWithOrder(many, { maxChars: 0 });
    expect(MAX_ORDER_TESTS).toBe(20);
    expect(hints(full)).toBe(20);
    expect(full).toContain("_…and 20 more tests that failed in some runs, not shown._");
    // under a size limit the section takes at most two fifths of it, and the whole report stays within it
    const cut = summarizeWithOrder(many, { maxChars: 6000 });
    expect(cut.length).toBeLessThanOrEqual(6000);
    const shown = hints(cut);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(20);
    expect(cut).toContain(`_…and ${40 - shown} more tests that failed in some runs, not shown._`);
    expect(orderSection(testOrders(many), 2400).join("\n").length).toBeLessThanOrEqual(2400 + 80);
    // one test always fits, however small the share
    expect(hints(orderSection(testOrders(many), 10).join("\n"))).toBe(1);
  });
});
