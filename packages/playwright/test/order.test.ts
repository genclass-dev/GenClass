// The comparison of a test's failing runs with its passing ones (src/order.ts): a measured comparison of the order of
// steps, with counts and with what shuffled outcomes give. These tests build runs by hand: a planted difference among
// noise, too few runs, failing runs cut short, steps missing from some runs, outcomes that say nothing, and failing
// runs that only last longer than passing ones (which must not read as an order of their own).
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/chaos.js";
import { DEFAULT_MIN_RUNS, EXACT_WAYS, PASSING_PER_EXCEPTION, chanceText, differenceText, explainOrder, runsOf, statementText, stepText, verdictText, type OrderDifference, type OrderRun, type OrderStatement } from "../src/order.js";
import { encodeSteps, type StepEvent } from "../src/steps.js";

/**
 * Steps from short names, 10 ms apart: "a:click Go", "s:GET /x", "r:GET /x#2" (the number is 1 unless given). "|"
 * ends the test's own code: what follows landed after it (late).
 */
function seq(...items: string[]): StepEvent[] {
  const out: StepEvent[] = [];
  let late = false;
  for (const item of items) {
    if (item === "|") {
      late = true;
      continue;
    }
    const m = /^([asrx]):(.*?)(?:#(\d+))?$/.exec(item)!;
    const e: StepEvent = { kind: m[1] as StepEvent["kind"], label: m[2], n: Number(m[3] ?? 1), t: out.length * 10 };
    if (late) e.late = true;
    out.push(e);
  }
  return out;
}

/** A statement as "first < second" or "before < between < after", in the short names of seq(). */
const short = (s: OrderStatement): string => s.steps.map((x) => `${x.kind}:${x.label}${x.n > 1 || x.many ? `#${x.n}` : ""}`).join(" < ");

const short_ = short;

const quote = (s: string): string => `\`${s}\``;

/**
 * A run of a search test: two search requests whose responses come back in either order, a click and a save, and
 * three polls dropped into the sequence wherever the seed puts them (noise that has nothing to do with the outcome).
 */
function searchRun(failed: boolean, seed: number, o: { stale?: boolean; stopEarly?: boolean } = {}): OrderRun {
  const stale = o.stale ?? failed;
  const items = ["a:type input", "s:GET /search#1", "s:GET /search#2", ...(stale ? ["r:GET /search#2", "r:GET /search#1"] : ["r:GET /search#1", "r:GET /search#2"])];
  if (!o.stopEarly) items.push("a:click Go", "s:POST /save", "r:POST /save");
  const random = mulberry32(seed);
  for (let k = 1; k <= 3; k++) {
    const at = Math.floor(random() * (items.length + 1));
    items.splice(at, 0, `s:GET /poll#${k}`);
    const after = at + 1 + Math.floor(random() * (items.length - at));
    items.splice(after, 0, `r:GET /poll#${k}`);
  }
  return { failed, events: seq(...items) };
}

/** `failing` failing and `passing` passing runs of searchRun, each with noise of its own. */
function searchRuns(failing: number, passing: number, o: { stopEarly?: boolean } = {}): OrderRun[] {
  const runs: OrderRun[] = [];
  for (let i = 0; i < failing + passing; i++) runs.push(searchRun(i % Math.ceil((failing + passing) / failing) === 0 && runs.filter((r) => r.failed).length < failing, 100 + i, o.stopEarly ? { stopEarly: i % 2 === 0 } : {}));
  // top up when the spread above gave fewer failing runs than asked for
  for (let i = 0; runs.filter((r) => r.failed).length < failing; i++) if (!runs[i].failed) runs[i] = searchRun(true, 100 + i);
  return runs;
}

describe("order: a planted difference among noise", () => {
  it("the one order every failing run has and no passing run has is found, first, with its counts", () => {
    const runs = searchRuns(6, 14);
    expect(runs.filter((r) => r.failed)).toHaveLength(6);
    const x = explainOrder(runs);
    expect(x.verdict).toBe("explained");
    expect([x.failing, x.passing]).toEqual([6, 14]);
    expect(short(x.differences[0])).toBe("r:GET /search#2 < r:GET /search#1");
    expect(x.differences[0]).toMatchObject({ form: "pair", failing: { with: 6, recorded: 6 }, passing: { with: 0, recorded: 14 }, adds: 6, ms: [10] });
    expect(x.differences).toHaveLength(1);
    expect(x.covered).toBe(6);
    expect(x.strongest).toBe(6);
    expect(x.separating).toBeGreaterThanOrEqual(1);
    // 38,760 ways to choose 6 of 20: shuffled 1000 times. The polls give many orders that some six runs share, so a
    // few shuffles do find one all six "failing" runs have; the count is what the answer reports
    expect(x.chance).toMatchObject({ ways: 1000, exact: false });
    expect(x.chance!.asStrong).toBeLessThanOrEqual(10);
    expect(x.chance!.share).toBe((x.chance!.asStrong + 1) / 1001);
    expect(x.chance!.separating).toBeLessThan(0.05);
    expect(x.capped).toBe(false);
  });

  it("the same runs give the same answer, whatever else is asked for", () => {
    const runs = searchRuns(5, 12);
    expect(explainOrder(runs)).toEqual(explainOrder(runs));
    expect(explainOrder(runs, { seed: 7 }).differences).toEqual(explainOrder(runs).differences);
    expect(explainOrder(runs, { maxDifferences: 1, shuffles: 50 }).chance!.ways).toBe(50);
  });

  it("with few runs every way of choosing which failed is tried, the real one among them", () => {
    const x = explainOrder(searchRuns(3, 5));
    // 56 ways to choose 3 of 8
    expect(x.chance).toMatchObject({ ways: 56, exact: true });
    expect(x.chance!.asStrong).toBeGreaterThanOrEqual(1);
    expect(x.chance!.share).toBe(x.chance!.asStrong / 56);
    expect(EXACT_WAYS).toBe(2000);
  });
});

describe("order: it refuses below a minimum of failing and passing runs", () => {
  it("fewer than three failing or three passing runs: nothing is compared", () => {
    expect(DEFAULT_MIN_RUNS).toBe(3);
    for (const [failing, passing] of [[2, 14], [1, 1], [6, 2], [0, 9], [9, 0]] as const) {
      const runs = [...Array.from({ length: failing }, (_, i) => searchRun(true, i)), ...Array.from({ length: passing }, (_, i) => searchRun(false, 50 + i))];
      const x = explainOrder(runs);
      expect(x, `${failing} failing, ${passing} passing`).toMatchObject({ verdict: "too-few-runs", failing, passing, minimum: { failing: 3, passing: 3 }, differences: [], chance: null, strongest: 0 });
    }
    expect(explainOrder([])).toMatchObject({ verdict: "too-few-runs", failing: 0, passing: 0 });
  });

  it("the minimum can be raised, never below one of each; a run without a step does not count", () => {
    const runs = searchRuns(4, 8);
    expect(explainOrder(runs, { minFailing: 5 }).verdict).toBe("too-few-runs");
    expect(explainOrder(runs, { minPassing: 9 }).verdict).toBe("too-few-runs");
    expect(explainOrder(runs, { minFailing: 0, minPassing: 0 }).minimum).toEqual({ failing: 1, passing: 1 });
    const empty: OrderRun[] = [{ failed: true, events: [] }, { failed: true, events: [] }];
    expect(explainOrder([...runs.filter((r) => !r.failed), ...runs.filter((r) => r.failed).slice(0, 2), ...empty])).toMatchObject({ verdict: "too-few-runs", failing: 2, passing: 8 });
  });

  it("three failing against three passing is compared, and is too few to tell a pair's order from chance", () => {
    // any order that is the three failing runs' alone is, with the outcomes swapped, the three passing runs' alone
    const x = explainOrder([...[1, 2, 3].map((i) => searchRun(true, i)), ...[4, 5, 6].map((i) => searchRun(false, i))]);
    expect(x.verdict).toBe("chance");
    expect(x.differences).toEqual([]);
    expect(x.strongest).toBe(3);
    expect(x.chance).toMatchObject({ ways: 20, exact: true });
    expect(x.chance!.asStrong).toBeGreaterThanOrEqual(2);
  });
});

describe("order: a failing run stops early, and a step it never reached is never evidence", () => {
  it("failing runs that are passing runs cut short have no order of their own", () => {
    const whole = seq("a:type input", "s:GET /search", "r:GET /search", "a:click Go", "s:POST /save", "r:POST /save", "a:click Done", "s:GET /done", "r:GET /done");
    const runs: OrderRun[] = [...Array.from({ length: 5 }, (_, i) => ({ failed: true, events: whole.slice(0, 3 + i) })), ...Array.from({ length: 9 }, () => ({ failed: false, events: whole }))];
    const x = explainOrder(runs);
    expect(x).toMatchObject({ verdict: "no-difference", failing: 5, passing: 9, differences: [], strongest: 0, separating: 0 });
    expect(x.chance).toMatchObject({ asStrong: 0, separating: 0 });
  });

  it("the planted difference is still found when half the failing runs stop right after it, and no step they lack is named", () => {
    const runs = searchRuns(6, 14, { stopEarly: true });
    const stopped = runs.filter((r) => !r.events.some((e) => e.label === "POST /save"));
    expect(stopped.length).toBeGreaterThanOrEqual(3);
    const x = explainOrder(runs);
    expect(x.verdict).toBe("explained");
    expect(short(x.differences[0])).toBe("r:GET /search#2 < r:GET /search#1");
    expect(x.differences[0].failing).toEqual({ with: 6, recorded: 6 });
    for (const d of x.differences) for (const s of [d, ...d.also]) expect(short(s)).not.toMatch(/POST \/save|click Go/);
  });

  it("a step only the passing runs reach is in no difference, however it is ordered there", () => {
    // every failing run ends before "click Go"; in the passing runs the late response lands before or after it
    const failing = Array.from({ length: 5 }, () => ({ failed: true, events: seq("a:type input", "s:GET /search", "s:GET /slow", "r:GET /search", "r:GET /slow") }));
    const passing = Array.from({ length: 10 }, (_, i) => ({ failed: false, events: i % 2 ? seq("a:type input", "s:GET /search", "s:GET /slow", "r:GET /search", "a:click Go", "r:GET /slow") : seq("a:type input", "s:GET /search", "s:GET /slow", "r:GET /search", "r:GET /slow", "a:click Go") }));
    expect(explainOrder([...failing, ...passing])).toMatchObject({ verdict: "no-difference", differences: [] });
  });
});

describe("order: failing runs that stop early, with outcomes that depend on nothing", () => {
  it("next to none is called explained: a run that did not record a statement's steps is read the same way under the real outcomes and under a shuffle", () => {
    // One click, twelve requests answered at any time in 600 ms, two more clicks. A failing run stops at a moment of
    // its own, which has nothing to do with any order; a passing run goes to the end. Counting an unrecorded run
    // against a statement only when a shuffle calls it passing made every shuffle weaker than the real outcomes:
    // 108 of 1,367 such tests were then called explained (7.9%), 27 of them (2.0%) with the rule as it is
    const random = mulberry32(31);
    const make = (failed: boolean): OrderRun => {
      const items: { kind: StepEvent["kind"]; label: string; t: number }[] = [{ kind: "a", label: "click Load", t: 0 }];
      for (let k = 0; k < 12; k++) items.push({ kind: "s", label: `GET /r${k}`, t: 1 });
      for (let k = 0; k < 12; k++) items.push({ kind: "r", label: `GET /r${k}`, t: 5 + Math.floor(random() * 600) });
      items.push({ kind: "a", label: "click Next", t: 300 }, { kind: "a", label: "click Done", t: 650 });
      const stop = failed ? 100 + Math.floor(random() * 500) : Infinity;
      const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => a.x.t - b.x.t || a.i - b.i);
      return { failed, events: sorted.filter((o) => o.x.t <= stop).map((o) => ({ ...o.x, n: 1 })) };
    };
    let compared = 0;
    let explained = 0;
    for (let trial = 0; trial < 240; trial++) {
      const runs = Array.from({ length: 12 }, () => make(random() < 0.4));
      const x = explainOrder(runs);
      if (x.verdict === "too-few-runs") continue;
      compared++;
      if (x.verdict === "explained") explained++;
    }
    expect(compared).toBeGreaterThan(180);
    expect(explained / compared).toBeLessThanOrEqual(0.06);
  });
});

describe("order: steps missing from some runs", () => {
  it("a failing run that did not record a statement's steps is left out of it; a passing run that did not counts as if it had the order", () => {
    const without = (r: OrderRun, label: string, n: number, kinds: string): OrderRun => ({ ...r, events: r.events.filter((e) => !(kinds.includes(e.kind) && e.label === label && e.n === n)) });
    const runs = searchRuns(6, 25);
    const failing = runs.filter((r) => r.failed);
    const passing = runs.filter((r) => !r.failed);
    // a failing run whose first response was never delivered: the statement is judged in the other five
    const x = explainOrder([without(failing[0], "GET /search", 1, "r"), ...failing.slice(1), ...passing]);
    expect(x.verdict).toBe("explained");
    expect(short(x.differences[0])).toBe("r:GET /search#2 < r:GET /search#1");
    expect(x.differences[0].failing).toEqual({ with: 5, recorded: 5 });
    expect(x.differences[0].passing).toEqual({ with: 0, recorded: 25, late: 0 });
    expect(x.covered).toBe(5);
    expect(differenceText(x.differences[0], x, quote)).toContain("In 5 of 6 failing runs and in none of the 25 passing runs that recorded these steps");
    expect(differenceText(x.differences[0], x, quote)).toContain("; 1 failing run did not record these steps).");
    // one passing run in twenty-five that never made the second request: it is the one exception the rule allows, and is said
    const y = explainOrder([...failing, without(passing[0], "GET /search", 2, "sr"), ...passing.slice(1)]);
    expect(y.verdict).toBe("explained");
    expect(y.differences[0]).toMatchObject({ kind: "alone", failing: { with: 6, recorded: 6 }, passing: { with: 0, recorded: 24 } });
    expect(differenceText(y.differences[0], y, quote)).toContain("in none of the 24 passing runs that recorded these steps");
    expect(differenceText(y.differences[0], y, quote)).toContain("; 1 passing run did not record these steps and is counted as if it had this order).");
    // two such passing runs are one too many for "the failing runs' alone": it is then an order every failing run has
    const z = explainOrder([...failing, without(passing[0], "GET /search", 2, "sr"), without(passing[1], "GET /search", 1, "sr"), ...passing.slice(2)]);
    expect(z.differences[0]).toMatchObject({ kind: "every", failing: { with: 6, recorded: 6 }, passing: { with: 0, recorded: 23 } });
    expect(verdictText(z)).toBe("Compared 6 failing runs with 25 passing runs: every failing run has this order of steps, and no passing run that recorded these steps does; 2 of the 25 passing runs did not record them.");
  });

  it("a step only the longer passing runs have picks no passing runs out: the ones without it count against the order", () => {
    // a timer's 2nd poll: every failing run waited long enough to see it answered; of the passing runs only the six that
    // took longest did, and those happen to have the stale response before it
    const head = ["a:click lamp", "s:GET /lamp", "a:click desk", "s:GET /desk"];
    const failing = Array.from({ length: 6 }, () => ({ failed: true, events: seq(...head, "r:GET /desk", "r:GET /lamp", "s:GET /poll#2", "r:GET /poll#2") }));
    const long = Array.from({ length: 6 }, () => ({ failed: false, events: seq(...head, "r:GET /lamp", "r:GET /desk", "s:GET /poll#2", "r:GET /poll#2") }));
    const short = Array.from({ length: 6 }, () => ({ failed: false, events: seq(...head, "r:GET /desk", "|", "r:GET /lamp") }));
    const x = explainOrder([...failing, ...long, ...short]);
    // read only in the passing runs that recorded the poll, "the stale response came between /desk and the poll" would
    // be in 6 of 6 failing runs and in none of 6 passing ones; the six short runs had the same order of responses
    for (const d of x.differences) for (const stated of [d, ...d.also]) expect(short_(stated)).not.toContain("GET /poll");
    expect(x.verdict).not.toBe("explained");
  });

  it("a response not delivered when the record ended: later than everything in a passing run, unknown in a failing one", () => {
    const both = (failed: boolean, first: "a" | "b"): OrderRun => ({ failed, events: seq("a:open", "s:GET /a", "s:GET /b", ...(first === "a" ? ["r:GET /a", "r:GET /b"] : ["r:GET /b", "r:GET /a"])) });
    const open = (failed: boolean): OrderRun => ({ failed, events: seq("a:open", "s:GET /a", "s:GET /b", "r:GET /a") });
    // passing runs that ended before /b was answered did not have "/b before /a": all ten passing runs are judged
    const x = explainOrder([...Array.from({ length: 5 }, () => both(true, "b")), ...Array.from({ length: 5 }, () => both(false, "a")), ...Array.from({ length: 5 }, () => open(false))]);
    expect(x.verdict).toBe("explained");
    expect(short(x.differences[0])).toBe("r:GET /b < r:GET /a");
    expect(x.differences[0]).toMatchObject({ kind: "alone", failing: { with: 5, recorded: 5 }, passing: { with: 0, recorded: 10 } });
    // and they did have "/a before /b": with five such passing runs it is not the failing runs' order alone
    const y = explainOrder([...Array.from({ length: 5 }, () => both(true, "a")), ...Array.from({ length: 5 }, () => both(false, "b")), ...Array.from({ length: 5 }, () => open(false))]);
    expect(y.differences.filter((d) => d.kind === "alone")).toEqual([]);
    // failing runs that stopped before /b was answered say nothing about /b: "missing" is never "after"
    const z = explainOrder([...Array.from({ length: 5 }, () => open(true)), ...Array.from({ length: 10 }, () => both(false, "b"))]);
    expect(z).toMatchObject({ verdict: "no-difference", differences: [], strongest: 0 });
  });

  it("a step too few runs have is not compared at all; a statement fewer than half the passing runs can judge is no difference", () => {
    const runs = searchRuns(6, 14);
    const passing = runs.filter((r) => !r.failed);
    // the second request is made in 6 failing runs and in only 4 of the 14 passing ones
    const thin = [...runs.filter((r) => r.failed), ...passing.slice(0, 4), ...passing.slice(4).map((r) => ({ ...r, events: r.events.filter((e) => !(e.label === "GET /search" && e.n === 2)) }))];
    const x = explainOrder(thin);
    for (const d of x.differences) expect(short(d)).not.toBe("r:GET /search#2 < r:GET /search#1");
  });

  it("what landed after the test's own code still landed after: a passing run with the failing order, a moment later, has that order", () => {
    // passing runs: the stale response comes after the test has already passed (late), or the responses come in order
    const failing = Array.from({ length: 6 }, () => ({ failed: true, events: seq("a:click lamp", "s:GET /lamp", "a:click desk", "s:GET /desk", "r:GET /desk", "r:GET /lamp") }));
    const lateOnes = Array.from({ length: 4 }, () => ({ failed: false, events: seq("a:click lamp", "s:GET /lamp", "a:click desk", "s:GET /desk", "r:GET /desk", "|", "r:GET /lamp") }));
    const inOrder = Array.from({ length: 10 }, () => ({ failed: false, events: seq("a:click lamp", "s:GET /lamp", "a:click desk", "s:GET /desk", "r:GET /lamp", "r:GET /desk") }));
    const x = explainOrder([...failing, ...lateOnes, ...inOrder]);
    expect(x.verdict).toBe("explained");
    expect(short(x.differences[0])).toBe("r:GET /desk < r:GET /lamp");
    // not the failing runs' alone: every failing run has it, and so do the four passing runs where it came too late to be seen
    expect(x.differences[0]).toMatchObject({ kind: "every", failing: { with: 6, recorded: 6 }, passing: { with: 4, recorded: 14, late: 4 } });
    expect(x.separating).toBe(0);
    expect(verdictText(x)).toBe("Compared 6 failing runs with 14 passing runs: every failing run has this order of steps, and so do only 4 of the 14 passing runs.");
    expect(differenceText(x.differences[0], x, quote)).toBe(
      "In 6 of 6 failing runs and in 4 of the 14 passing runs that recorded these steps, the response to `GET /desk` came before the response to `GET /lamp` (median 10 ms apart; in the other passing runs the order was the other way round). In all 4 of those passing runs, the last of these steps came only after the test's own code had ended.",
    );
    // where the test's own code ended changes what is said about those passing runs, never which runs have the order
    const during = lateOnes.map((r) => ({ ...r, events: r.events.map(({ late: _late, ...e }) => e) }));
    const y = explainOrder([...failing, ...during, ...inOrder]);
    expect(y.differences[0]).toMatchObject({ kind: "every", failing: { with: 6, recorded: 6 }, passing: { with: 4, recorded: 14, late: 0 } });
    expect(y.strength).toBe(x.strength);
    expect(differenceText(y.differences[0], y, quote)).not.toContain("after the test's own code had ended");
    // the same when the stale response had not been delivered at all when the passing run's record ended
    const open = lateOnes.map((r) => ({ ...r, events: r.events.filter((e) => !e.late) }));
    expect(explainOrder([...failing, ...open, ...inOrder]).differences[0]).toMatchObject({ kind: "every", passing: { with: 4, recorded: 14, late: 4 } });
  });
});

describe("order: failing runs last longer than passing ones, and that is not an order", () => {
  // One click, two requests in flight, and the test ends when /a is answered. Whether it fails has nothing to do with
  // the order of the answers. A failing run waits for its check to give up, so it records /b wherever it lands; a
  // passing run has already ended when /b lands after /a (late: the fixture's wait caught it; open: it did not).
  const run = (failed: boolean, first: "a" | "b", after: "late" | "open"): OrderRun => {
    const head = ["a:click Go", "s:GET /a", "s:GET /b"];
    if (first === "b") return { failed, events: seq(...head, "r:GET /b", "r:GET /a") };
    if (failed) return { failed, events: seq(...head, "r:GET /a", "r:GET /b") };
    return { failed, events: after === "late" ? seq(...head, "r:GET /a", "|", "r:GET /b") : seq(...head, "r:GET /a") };
  };

  it("the case an independent review found: 7 of 11 failing runs with /a first, and so are the 13 passing runs that ended before /b", () => {
    for (const after of ["late", "open"] as const) {
      const runs = [...Array.from({ length: 7 }, () => run(true, "a", after)), ...Array.from({ length: 4 }, () => run(true, "b", after)), ...Array.from({ length: 13 }, () => run(false, "a", after)), ...Array.from({ length: 16 }, () => run(false, "b", after))];
      const x = explainOrder(runs);
      expect(x.verdict, after).not.toBe("explained");
      expect(x.differences, after).toEqual([]);
    }
  });

  it("over many such tests, with the outcome a coin and the order a coin, next to none is called explained", () => {
    const random = mulberry32(77);
    let explained = 0;
    for (let trial = 0; trial < 120; trial++) {
      const after = trial % 2 ? "late" : "open";
      const bFast = trial % 4 < 2 ? 0.5 : 0.7;
      const runs: OrderRun[] = [];
      for (let i = 0; i < 40; i++) runs.push(run(random() < 0.3, random() < bFast ? "b" : "a", after));
      if (explainOrder(runs, { shuffles: 200 }).verdict === "explained") explained++;
    }
    // 121 and 202 of 300 before late steps were read as later; a comparison that holds its 5% gives about 6 of 120
    expect(explained).toBeLessThanOrEqual(10);
  });
});

describe("order: shuffled outcomes give no explanation", () => {
  it("with the outcomes dealt at random over the same runs, at most a few in a hundred are called explained", () => {
    const runs = searchRuns(6, 14);
    const random = mulberry32(2026);
    let explained = 0;
    let listed = 0;
    for (let round = 0; round < 100; round++) {
      const dealt = runs.map((r) => ({ r, key: random() })).sort((a, b) => a.key - b.key);
      // the first six of the shuffle are called failing: nothing about a run says which it is
      const shuffled = dealt.map((d, i) => ({ failed: i < 6, events: d.r.events }));
      const x = explainOrder(shuffled, { shuffles: 200 });
      if (x.verdict === "explained") explained++;
      else listed += x.differences.length;
    }
    expect(explained).toBeLessThanOrEqual(8);
    // and a verdict that is not "explained" lists no difference
    expect(listed).toBe(0);
  });

  it("noise alone, with outcomes that depend on nothing: no difference is called an explanation", () => {
    const runs = Array.from({ length: 24 }, (_, i) => searchRun(i % 4 === 0, 500 + i, { stale: i % 3 === 0 }));
    const x = explainOrder(runs);
    expect(x.verdict).not.toBe("explained");
    expect(x.differences).toEqual([]);
  });
});

describe("order: a step between two others", () => {
  /** A response that lands before the first click, between the two clicks, or after the second. */
  const run = (failed: boolean, where: "before" | "between" | "after"): OrderRun => {
    const r = "r:POST /selection";
    const items = ["a:click Tags", "s:POST /selection", "a:type filter", "a:click tag", "a:click Apply"];
    items.splice(where === "before" ? 3 : where === "between" ? 4 : 5, 0, r);
    if (!failed) items.push("a:click Confirm", "s:POST /edit", "r:POST /edit");
    return { failed, events: seq(...items) };
  };

  it("failing runs have it between, passing runs before the first or after the second: no pair says it, the between does", () => {
    const runs = [...Array.from({ length: 5 }, () => run(true, "between")), ...Array.from({ length: 6 }, () => run(false, "before")), ...Array.from({ length: 7 }, () => run(false, "after"))];
    const x = explainOrder(runs);
    expect(x.verdict).toBe("explained");
    expect(x.differences).toHaveLength(1);
    const d = x.differences[0];
    expect(d.form).toBe("between");
    expect(short(d)).toBe("a:click tag < r:POST /selection < a:click Apply");
    expect(d.failing).toEqual({ with: 5, recorded: 5 });
    expect(d.passing).toEqual({ with: 0, recorded: 13, late: 0, before: 6, after: 7 });
    expect(d.kind).toBe("alone");
    expect(d.ms).toEqual([10, 10]);
    expect(x.separating).toBe(1);
    expect(differenceText(d, x, quote)).toBe(
      "In 5 of 5 failing runs and in none of the 13 passing runs that recorded these steps, the response to `POST /selection` came between the action `click tag` and the action `click Apply` (median 10 ms after the first and 10 ms before the second; there it came before the first of the two in 6 and after the second in 7).",
    );
  });

  it("when one pair does say it, the pair is listed and the between is not needed", () => {
    const runs = [...Array.from({ length: 5 }, () => run(true, "between")), ...Array.from({ length: 13 }, () => run(false, "before"))];
    const x = explainOrder(runs);
    expect(x.verdict).toBe("explained");
    expect(x.differences[0].form).toBe("pair");
    expect(short(x.differences[0])).toBe("a:click tag < r:POST /selection");
    expect(differenceText(x.differences[0], x, quote)).toBe(
      "In 5 of 5 failing runs and in none of the 13 passing runs that recorded these steps, the action `click tag` came before the response to `POST /selection` (median 10 ms apart; there the order was the other way round).",
    );
  });
});

describe("order: next to no passing run", () => {
  const stale = (failed: boolean): OrderRun => ({ failed, events: seq("a:type input", "s:GET /search#1", "s:GET /search#2", "r:GET /search#2", "r:GET /search#1") });
  const inOrder = (): OrderRun => ({ failed: false, events: seq("a:type input", "s:GET /search#1", "s:GET /search#2", "r:GET /search#1", "r:GET /search#2") });

  it("one passing run in twenty may have the failing runs' order: it is counted, and said", () => {
    expect(PASSING_PER_EXCEPTION).toBe(20);
    // a run that passed with the stale order: the app repaired itself before the test looked
    const x = explainOrder([...Array.from({ length: 6 }, () => stale(true)), stale(false), ...Array.from({ length: 23 }, inOrder)]);
    expect(x.verdict).toBe("explained");
    expect(x.differences[0]).toMatchObject({ failing: { with: 6, recorded: 6 }, passing: { with: 1, recorded: 24 } });
    expect(differenceText(x.differences[0], x, quote)).toBe(
      "In 6 of 6 failing runs and in 1 of the 24 passing runs that recorded these steps, the response to the 2nd `GET /search` came before the response to the 1st `GET /search` (median 10 ms apart; in the other passing runs the order was the other way round).",
    );
    expect(verdictText(x)).toBe("Compared 6 failing runs with 24 passing runs: every failing run has this order of steps, and next to no passing run does.");
    expect(chanceText(x)).toMatch(/^With the outcomes shuffled 1000 times, \d+ gave a difference as strong as the strongest here\. Orders that every failing run has and next to no passing run has: 1 here, /);
  });

  it("two in twenty-four, or one below twenty passing runs, is no longer the failing runs' alone: it is an order every failing run has and few passing runs have", () => {
    const two = explainOrder([...Array.from({ length: 6 }, () => stale(true)), stale(false), stale(false), ...Array.from({ length: 22 }, inOrder)]);
    expect(two).toMatchObject({ verdict: "explained", separating: 0 });
    expect(two.differences[0]).toMatchObject({ kind: "every", failing: { with: 6, recorded: 6 }, passing: { with: 2, recorded: 24, late: 0 } });
    expect(verdictText(two)).toBe("Compared 6 failing runs with 24 passing runs: every failing run has this order of steps, and so do only 2 of the 24 passing runs.");
    const few = explainOrder([...Array.from({ length: 6 }, () => stale(true)), stale(false), ...Array.from({ length: 18 }, inOrder)]);
    expect(few.differences[0]).toMatchObject({ kind: "every", passing: { with: 1, recorded: 19 } });
    // an order half the passing runs have too is no difference at all, however many failing runs have it
    const half = explainOrder([...Array.from({ length: 6 }, () => stale(true)), ...Array.from({ length: 12 }, () => stale(false)), ...Array.from({ length: 12 }, inOrder)]);
    expect(half).toMatchObject({ verdict: "no-difference", strongest: 0, differences: [] });
    // and one that only some failing runs have must be theirs alone
    const some = explainOrder([...Array.from({ length: 4 }, () => stale(true)), ...Array.from({ length: 2 }, () => ({ ...inOrder(), failed: true })), stale(false), stale(false), ...Array.from({ length: 22 }, inOrder)]);
    expect(some).toMatchObject({ verdict: "no-difference", strongest: 0, differences: [] });
    // a strict order is listed before one with an exception, whatever else is equal
    const both = (failed: boolean, leak: boolean): OrderRun => ({
      failed,
      events: seq("s:GET /a", "s:GET /b", "s:GET /c", "s:GET /d", ...(failed || leak ? ["r:GET /b", "r:GET /a"] : ["r:GET /a", "r:GET /b"]), ...(failed ? ["r:GET /d", "r:GET /c"] : ["r:GET /c", "r:GET /d"])),
    });
    const x = explainOrder([...Array.from({ length: 6 }, () => both(true, false)), both(false, true), ...Array.from({ length: 23 }, () => both(false, false))], { maxDifferences: 1 });
    expect(short(x.differences[0])).toBe("r:GET /d < r:GET /c");
    expect(x.differences[0].passing.with).toBe(0);
  });
});

describe("order: failing runs that differ among themselves", () => {
  it("each line adds failing runs the lines above it do not have, and the counts say how many have one of them", () => {
    // two races in one test: seven failing runs have the search's responses the wrong way round, four the detail's
    const run = (stale: "search" | "detail" | null): OrderRun => ({
      failed: stale !== null,
      events: seq(
        "a:type input",
        "s:GET /search#1",
        "s:GET /search#2",
        ...(stale === "search" ? ["r:GET /search#2", "r:GET /search#1"] : ["r:GET /search#1", "r:GET /search#2"]),
        "a:click lamp",
        "s:GET /lamp",
        "a:click desk",
        "s:GET /desk",
        ...(stale === "detail" ? ["r:GET /desk", "r:GET /lamp"] : ["r:GET /lamp", "r:GET /desk"]),
      ),
    });
    const runs = [...Array.from({ length: 7 }, () => run("search")), ...Array.from({ length: 4 }, () => run("detail")), ...Array.from({ length: 12 }, () => run(null))];
    const x = explainOrder(runs);
    expect(x.verdict).toBe("explained");
    expect(x.differences.map(short)).toEqual(["r:GET /search#2 < r:GET /search#1", "r:GET /desk < r:GET /lamp"]);
    expect(x.differences.map((d) => [d.failing.with, d.adds])).toEqual([
      [7, 7],
      [4, 4],
    ]);
    expect([x.covered, x.strongest, x.separating]).toEqual([11, 7, 0]);
    expect(verdictText(x)).toBe("Compared 11 failing runs with 12 passing runs: every failing run has one of these orders of steps, and no passing run does.");
  });
});

describe("order: how differences are ranked", () => {
  it("a response against a user action or another response comes before a statement about a send; a pair of the nearest steps before a farther one", () => {
    // in failing runs the response lands after the click; with it, it also lands after the request the click sends and
    // after the far-away first action's neighbour
    const run = (failed: boolean): OrderRun =>
      failed
        ? { failed, events: seq("a:open", "s:GET /a", "s:GET /b", "r:GET /b", "a:click Save", "s:POST /save", "r:GET /a", "r:POST /save") }
        : { failed, events: seq("a:open", "s:GET /a", "s:GET /b", "r:GET /a", "r:GET /b", "a:click Save", "s:POST /save", "r:POST /save") };
    const x = explainOrder([...Array.from({ length: 5 }, () => run(true)), ...Array.from({ length: 12 }, () => run(false))], { maxDifferences: 1 });
    expect(x.verdict).toBe("explained");
    const d = x.differences[0];
    // three statements are true in exactly the failing runs: against the other response (two steps apart), against
    // the click (two apart) and against the send (one apart); a statement about a send comes last however near it is
    expect(d.alike).toBe(2);
    expect([short(d), ...d.also.map(short)]).toEqual(["r:GET /b < r:GET /a", "a:click Save < r:GET /a", "s:POST /save < r:GET /a"]);
  });
});

describe("order: very many runs and steps", () => {
  it("the work is bounded: what is over the bound is left out, said, and the answer still comes at once", () => {
    // 400 runs of 130 responses in an order of their own each: every pair of steps varies, some 16,000 statements
    const random = mulberry32(5);
    const runs: OrderRun[] = [];
    for (let i = 0; i < 400; i++) {
      const order = Array.from({ length: 130 }, (_, k) => ({ k, key: random() })).sort((a, b) => a.key - b.key);
      runs.push({ failed: i % 4 === 0, events: order.map((o, at) => ({ kind: "r" as const, label: `GET /r${o.k}`, n: 1, t: at })) });
    }
    const started = Date.now();
    const x = explainOrder(runs);
    const took = Date.now() - started;
    expect(x.verdict).not.toBe("explained");
    expect(x.differences).toEqual([]);
    expect(x.capped).toBe(true);
    // fewer shuffles than asked for, never fewer than 200
    expect(x.chance!.ways).toBeGreaterThanOrEqual(200);
    expect(x.chance!.ways).toBeLessThan(1000);
    // seconds on a busy machine; without the bound it was minutes and gigabytes at the limits the function accepts
    expect(took).toBeLessThan(20_000);
  });
});

describe("order: runs from race files", () => {
  const steps = encodeSteps({ events: seq("a:click Go", "s:GET /x", "r:GET /x"), bodyKnown: true }, { max: 300, bytes: 5000 });

  it("failed and timed out are failing runs, passed is a passing run; another status or none is not compared", () => {
    const r = runsOf([{ status: "failed", steps }, { status: "timedOut", steps }, { status: "passed", steps }, { status: "passed" }, { status: "interrupted", steps }, { steps }, { status: "passed", steps: { ...steps!, cut: 3 } }]);
    expect(r).toMatchObject({ failed: 2, passed: 3, withoutSteps: 1, other: 2, retried: 0, cut: 1 });
    expect(r.runs.map((x) => x.failed)).toEqual([true, true, false, false]);
    expect(r.runs[0].events).toEqual(seq("a:click Go", "s:GET /x", "r:GET /x"));
  });

  it("a retried attempt is not a run of its own: one failing seed with two retries is one failing run", () => {
    // Playwright retries after a failure, and the fixture gives a retry its first attempt's seed: the same delays again
    const r = runsOf([{ status: "failed", steps }, { status: "failed", steps, retry: 1 }, { status: "failed", steps, retry: 2 }, { status: "passed", steps }, { status: "failed", steps }, { status: "passed", steps, retry: 1 }]);
    expect(r).toMatchObject({ failed: 2, passed: 1, retried: 3, withoutSteps: 0 });
    expect(r.runs.map((x) => x.failed)).toEqual([true, false, true]);
    // thirty seeds, one of which failed and was retried twice: too few failing runs, as without the retries
    const passing = Array.from({ length: 29 }, () => ({ status: "passed" as const, steps }));
    const once = runsOf([{ status: "failed", steps }, { status: "failed", steps, retry: 1 }, { status: "failed", steps, retry: 2 }, ...passing]);
    expect(explainOrder(once.runs)).toMatchObject({ verdict: "too-few-runs", failing: 1, passing: 29 });
  });
});

describe("order: in words", () => {
  const ref = (kind: StepEvent["kind"], label: string, n = 1, many = false) => ({ kind, label, n, many });

  it("a step is named by what it is; its number is said only when the test has several", () => {
    expect(stepText(ref("a", 'click button "Apply"'), quote)).toBe('the action `click button "Apply"`');
    expect(stepText(ref("a", "click img", 3, true), quote)).toBe("the 3rd `click img` action");
    expect(stepText(ref("s", "POST /api/orders"), quote)).toBe("the sending of `POST /api/orders`");
    expect(stepText(ref("r", "GET /api/search", 2, true), quote)).toBe("the response to the 2nd `GET /api/search`");
    expect(stepText(ref("x", "GET /api/search", 11, true), quote)).toBe("the end of the 11th `GET /api/search` without a response");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => stepText(ref("r", "x", n, true), String).split(" ")[4])).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
    expect(statementText({ form: "pair", steps: [ref("r", "GET /b"), ref("a", "click Go")] }, quote)).toBe("the response to `GET /b` came before the action `click Go`");
    expect(statementText({ form: "between", steps: [ref("a", "click A"), ref("r", "GET /b"), ref("a", "click C")] }, quote)).toBe("the response to `GET /b` came between the action `click A` and the action `click C`");
  });

  it("the verdict and what shuffled outcomes gave are sentences with the counts", () => {
    expect(verdictText(explainOrder([searchRun(true, 1), searchRun(false, 2)]))).toBe("Not compared: 1 failing run and 1 passing run with recorded steps, and the comparison needs at least 3 failing and 3 passing.");
    const whole = seq("a:type input", "s:GET /search", "r:GET /search");
    const same = explainOrder([...Array.from({ length: 3 }, () => ({ failed: true, events: whole })), ...Array.from({ length: 4 }, () => ({ failed: false, events: whole }))]);
    expect(verdictText(same)).toBe("Compared 3 failing runs with 4 passing runs: no order of steps sets the failing runs apart.");
    expect(chanceText(same)).toBe("Of the 35 ways to choose which 3 of these 7 runs failed, an order that every failing run has and no passing run has turns up 0 times on average over those ways; here there is none.");
    const x = explainOrder(searchRuns(6, 14));
    expect(verdictText(x)).toBe("Compared 6 failing runs with 14 passing runs: every failing run has this order of steps, and no passing run does.");
    expect(chanceText(x)).toBe(`With the outcomes shuffled 1000 times, ${x.chance!.asStrong} gave a difference as strong as the strongest here. Orders that every failing run has and no passing run has: ${x.separating} here, ${x.chance!.separating} on average per shuffle.`);
    const exact = explainOrder(searchRuns(3, 5));
    expect(chanceText(exact)).toBe(`Of the 56 ways to choose which 3 of these 8 runs failed, ${exact.chance!.asStrong} ${exact.chance!.asStrong === 1 ? "gives" : "give"} a difference as strong as the strongest here (the real outcomes are one of them). Orders that every failing run has and no passing run has: ${exact.separating} here, ${exact.chance!.separating} on average over those ways.`);
    const three = explainOrder([...[1, 2, 3].map((i) => searchRun(true, i)), ...[4, 5, 6].map((i) => searchRun(false, i))]);
    expect(verdictText(three)).toMatch(/^Compared 3 failing runs with 3 passing runs: \d+ orders? of steps sets? the failing runs apart, the strongest in 3 of 3, and shuffled outcomes give as much too often to call any of them an explanation\. More runs would tell\.$/);
    expect(chanceText(explainOrder([]))).toBe("");
  });
});

// a compile-time check that the exported difference type carries what the report prints
const _shape: (d: OrderDifference) => number[] = (d) => [d.failing.with, d.failing.recorded, d.passing.recorded, d.passing.late, d.adds, d.alike, ...d.ms];
void _shape;
