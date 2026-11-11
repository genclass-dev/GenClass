// What a team already knows, and what a review does with it (src/github/review.ts header; docs/github-app/README.md,
// "What the lines mean" and "Settings"):
// - one finding per kind and operation, whatever number of tests reach it, and rows stored the earlier way (one per
//   test and signature, state v1) regrouped without a number changing its meaning;
// - a comparison with the race files of the default branch's most recent commit that has them (the baseline);
// - the signatures a repository's settings leave out (`ignore`).
// The pure parts first, then the read of the default branch against the fake GitHub, then everything through the
// worker's real webhook handler.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { installationClient } from "../src/github/api.js";
import { githubApp } from "../src/github/config.js";
import { BASELINE_WORKFLOW_MISSES, baselineEvidence, MAX_BASELINE_CALLS, MAX_BASELINE_PROBES, type CiEvidence } from "../src/github/evidence.js";
import {
  baselineIndex,
  emptyState,
  fingerprint,
  hasFindings,
  inlineComments,
  legacyFingerprint,
  legacyFingerprints,
  loadState,
  MAX_FINDING_TESTS,
  MAX_FINDINGS,
  mergeFindings,
  operationMatches,
  parseState,
  regroup,
  renderCheck,
  renderFixBrief,
  renderIssue,
  renderReplay,
  renderSummary,
  summaryOf,
  testLocations,
  type BaselineView,
  type MergeOptions,
  type PrState,
  type ReviewModel,
} from "../src/github/review.js";
import { DEFAULT_SETTINGS, readSettings, type IgnoreRule, type RepoSettings } from "../src/github/settings.js";
import { savePr } from "../src/github/store.js";
import { advance, now, resetClock } from "./account-helpers.js";
import { commentEvent, deliver, fakeGithub, githubSetup, INSTALLATION, installationCreated, pullEvent, pullRequest, raceFile, races, racesZip, REPO, result, runEvent, SHA1, SHA2, SHA3 } from "./github-helpers.js";

beforeEach(() => {
  resetClock();
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
/** Commits of the default branch. */
const BASE1 = "d".repeat(40);
const BASE2 = "e".repeat(40);
const BASE3 = "f".repeat(40);
const LINKS = { docs: "https://example.test/docs", setup: "https://example.test/setup", app: "https://genclass.dev/github", origin: "https://genclass.dev" };

const T_SEARCH = "search.spec.ts > search > buggy page: results of the last query";
const T_CHROMIUM = `[chromium] ${T_SEARCH}`;
const T_CHECKOUT = "checkout.spec.ts > checkout > places one order";
const T_CART = "cart.spec.ts > cart > adds";

type Sig = { d: string; op: string; t?: string; ev?: string };
/** A race file for one test and seed, as an input of the summariser. */
function race(test: string, seed: number, sigs: Sig[], extra: Record<string, unknown> = {}) {
  return {
    name: `${test.replace(/\W+/g, "-")}-s${seed}.json`,
    content: JSON.stringify({
      schema: "genclass-races/1",
      test,
      seed,
      signatures: sigs.map((s) => ({ sig: `${s.t ?? "request"}|${s.d}|${s.op}`, trigger: s.t ?? "request", diagnosis: s.d, op: s.op, confidence: 0.95, evidence: s.ev ?? `evidence of ${s.op} in ${test}`, seeds: [seed] })),
      ...extra,
    }),
  };
}
/** The same test under `n` seeds, each flagging `sigs`. */
const seeds = (test: string, n: number, sigs: Sig[], extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => race(test, i + 1, sigs, extra));
const OVERWROTE: Sig = { d: "overwrote-newer", op: "GET /api/search", t: "witness" };
const IN_FLIGHT: Sig = { d: "identical-in-flight", op: "POST /api/cart", t: "witness" };
const DUPLICATE: Sig = { d: "duplicate", op: "POST /api/orders" };
const STALE: Sig = { d: "stale", op: "GET /api/items", t: "delivery" };
const FAILING: Sig = { d: "failing", op: "GET /api/cart", t: "failure" };

type Input = ReturnType<typeof race>;
const ci = (inputs: Input[]): CiEvidence => ({ state: "ready", incomplete: false, unfinished: false, runs: [], artifacts: [{ name: "genclass-races", runId: 1, files: inputs.length }], inputs, notes: [] });

interface ReviewOf {
  sha?: string;
  prev?: PrState;
  settings?: RepoSettings;
  /** The default branch's race files, read for this review at `sha`. */
  base?: { sha: string; inputs: Input[]; incomplete?: boolean } | null;
  /** What the review tells of the comparison when no files were read for it. */
  view?: BaselineView;
  partial?: boolean;
}

/** One review of `inputs`, as src/github/handlers.ts builds it: the findings folded in, and the model the renderers take. */
async function review(inputs: Input[], o: ReviewOf = {}) {
  const settings = o.settings ?? DEFAULT_SETTINGS;
  const sha = o.sha ?? SHA_A;
  const summary = summaryOf(inputs, settings);
  const options: MergeOptions = { partial: o.partial, ignore: settings.ignore };
  if (o.base) options.baseline = { sha: o.base.sha, ...(await baselineIndex(summaryOf(o.base.inputs, DEFAULT_SETTINGS))) };
  const merged = await mergeFindings(o.prev ?? emptyState(), summary, sha, options);
  const baseline: BaselineView | undefined = o.base ? { state: "read", sha: o.base.sha, files: o.base.inputs.length, incomplete: !!o.base.incomplete } : o.view;
  const m: ReviewModel = { repo: "acme/shop", number: 12, headSha: sha, mention: "genclass-dev", ci: ci(inputs), summary, findings: merged.view, production: null, settings, warnings: [], links: LINKS, partial: o.partial, unlisted: merged.unlisted, baseline, ignored: merged.ignored };
  return { m, state: merged.state, merged };
}

const rows = (body: string): string[] => body.split("\n").filter((l) => /^\| \d+ \|/.test(l));
const failing = (failOn: "never" | "reproducible" | "any", failOnBaseline = false, over: Partial<RepoSettings> = {}): RepoSettings => ({ ...DEFAULT_SETTINGS, ...over, check: { enabled: true, failOn, failOnBaseline } });

// --------------------------------------------------------------------------------------------- one finding per signature

describe("github app: one finding per kind and operation (docs/github-app/README.md, \"What the lines mean\")", () => {
  it("one test in two Playwright projects, the same race: one finding that lists both tests, not a row for each", async () => {
    // the two rows of genclass-dev/GenClass pull request 180: the same witness, once per project
    const inputs = [...seeds(T_CHROMIUM, 2, [OVERWROTE]), ...seeds(T_SEARCH, 5, [OVERWROTE]), ...seeds("search.spec.ts > search > fixed page", 2, [])];
    const { m, state } = await review(inputs);
    expect(state.findings).toHaveLength(1);
    // the test that flags it in most seeds leads, and the seeds are that test's
    expect(state.findings[0]).toMatchObject({ n: 1, c: "witness", kind: "witness:overwrote-newer", op: "GET /api/search", test: T_SEARCH, tests: [T_SEARCH, T_CHROMIUM], nt: 2, rep: true, seeds: [1, 2, 3, 4, 5], of: 5, status: "new", base: false });
    expect(state.findings[0]!.fp).toBe(await fingerprint("witness:overwrote-newer", "GET /api/search"));
    expect(state.next).toBe(2);
    const body = renderSummary(m)!;
    expect(body).toContain("**1 finding** in this pull request's tests at `aaaaaaa` · 1 reproducible · 3 tests read");
    expect(rows(body)).toEqual([
      "| 1 | New | Witness, overwrote-newer · `GET /api/search` | 2 tests: search.spec.ts > search > buggy page: results of the last query; \\[chromium\\] search.spec.ts > search > buggy page: results of the last query | 5 of 5 seeds in the first, **reproducible** |",
    ]);
    expect(renderCheck(m)).toMatchObject({ title: "1 finding, 1 reproducible", conclusion: "neutral" });
    // the race report in the fold is the summariser's and stays test by test: each test with its own seeds
    expect(body).toContain("##### \\[chromium\\] search.spec.ts > search > buggy page: results of the last query");
    expect(body).toContain("- **Reproducible**: 2 of 2 seeds (1, 2) · `GET /api/search` · `witness:overwrote-newer`");
    // what the review shows of this commit: every test that flags it, with that test's own numbers
    expect(m.findings[0]!.now!.tests.map((t) => [t.test, t.seeds.length, t.of, t.rep])).toEqual([
      [T_SEARCH, 5, 5, true],
      [T_CHROMIUM, 2, 2, true],
    ]);
    // which test leads does not depend on the order the files came in
    expect((await review([...inputs].reverse())).state.findings).toEqual(state.findings);
  });

  it("many tests: the row names three and counts the rest, the state names five; another kind or another operation is another finding", async () => {
    const tests = Array.from({ length: 7 }, (_, i) => `a${i + 1}.spec.ts > adds to the cart`);
    const inputs = [
      ...tests.map((t) => race(t, 1, [{ d: "duplicate", op: "POST /api/cart" }])),
      // the same kind on another operation, and the same operation under another kind
      race(T_CHECKOUT, 1, [DUPLICATE]),
      race("z.spec.ts > retries", 1, [{ d: "duplicate", op: "POST /api/cart", t: "delivery" }]),
    ];
    const { m, state } = await review(inputs);
    expect(state.findings.map((f) => [f.n, f.kind, f.op, f.nt, f.tests.length])).toEqual([
      [1, "request:duplicate", "POST /api/cart", 7, MAX_FINDING_TESTS],
      [2, "request:duplicate", "POST /api/orders", 1, 1],
      [3, "delivery:duplicate", "POST /api/cart", 1, 1],
    ]);
    // nothing sets the seven apart (one seed each): they are named in the order of their names
    expect(state.findings[0]!.tests).toEqual(tests.slice(0, MAX_FINDING_TESTS));
    const row = rows(renderSummary(m)!).find((l) => l.startsWith("| 1 |"))!;
    expect(row).toBe("| 1 | New | Duplicate submit · `POST /api/cart` | 7 tests: a1.spec.ts > adds to the cart; a2.spec.ts > adds to the cart; a3.spec.ts > adds to the cart; and 4 more | 1 of 1 seed in the first |");
    expect(renderSummary(m)).toContain("**3 findings** in this pull request's tests at `aaaaaaa` · 0 reproducible · 9 tests read");
    // the replies name the test it is flagged in most, and say that there are others
    const replay = renderReplay(state.findings[0]!, { mention: "genclass-dev", headSha: SHA_A, links: LINKS });
    expect(replay).toContain("**Replay, finding 1**: Duplicate submit on `POST /api/cart`, in a1.spec.ts > adds to the cart and 6 other tests, flagged at `aaaaaaa`.");
    expect(replay).toContain("Also flagged in: a2.spec.ts > adds to the cart; a3.spec.ts > adds to the cart; a4.spec.ts > adds to the cart; a5.spec.ts > adds to the cart; and 2 more.");
    expect(replay).toContain('`npx playwright test a1.spec.ts -g "adds to the cart" --repeat-each 2`');
    const brief = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(renderFixBrief(state.findings[0]!, { repo: "acme/shop", number: 12, headSha: SHA_A, mention: "genclass-dev", links: LINKS, asker: "ada" }))![1]!);
    expect(brief.finding).toMatchObject({ number: 1, kind: "request:duplicate", operation: "POST /api/cart", test: tests[0], tests: tests.slice(0, MAX_FINDING_TESTS), tests_flagged: 7, on_default_branch: false });
    const issue = renderIssue([state.findings[0]!, state.findings[1]!], { repo: "acme/shop", number: 12, headSha: SHA_A, mention: "genclass-dev", links: LINKS, merged: false });
    expect(issue.body).toContain("- Tests: 7 tests: a1.spec.ts > adds to the cart; a2.spec.ts > adds to the cart; a3.spec.ts > adds to the cart; and 4 more");
    expect(issue.body).toContain(`- Test: ${T_CHECKOUT}`);
  });

  it("from push to push: flagged in any of its tests it is flagged; \"not flagged now\" only when every test it was in ran without it", async () => {
    const A = "a.spec.ts > one";
    const B = "b.spec.ts > two";
    const first = await review([...seeds(A, 2, [DUPLICATE]), race(B, 1, [DUPLICATE]), race(B, 2, [])]);
    expect(first.state.findings.map((f) => [f.n, f.status, f.test, f.tests, f.rep])).toEqual([[1, "new", A, [A, B], true]]);
    // A runs clean, B still flags it: still flagged, and it names the test that flags it now
    const second = await review([...seeds(A, 2, []), race(B, 1, [DUPLICATE]), race(B, 2, [])], { sha: SHA_B, prev: first.state });
    expect(second.state.findings.map((f) => [f.n, f.status, f.test, f.tests, f.nt, f.rep, f.seeds, f.last])).toEqual([[1, "still", B, [B], 1, false, [1], "bbbbbbb"]]);
    // both run clean: not flagged now
    const third = await review([...seeds(A, 2, []), ...seeds(B, 2, [])], { sha: SHA_C, prev: second.state });
    expect(third.state.findings.map((f) => [f.status, f.last])).toEqual([["gone", "bbbbbbb"]]);
    expect(rows(renderSummary(third.m)!)).toEqual(["| 1 | Not flagged now | Duplicate submit · `POST /api/orders` | b.spec.ts > two | last flagged at `bbbbbbb` |"]);
    // from the first push: A runs clean and B is not in the run. One of its tests did not run, so absence is not said
    const partRun = await review(seeds(A, 2, []), { sha: SHA_B, prev: first.state });
    expect(partRun.state.findings.map((f) => f.status)).toEqual(["not-run"]);
    const noRun = await review(seeds("c.spec.ts > three", 1, []), { sha: SHA_B, prev: first.state });
    expect(noRun.state.findings.map((f) => f.status)).toEqual(["not-run"]);
    // flagged again in a test it was not in before: the same finding, the same number, new again
    const back = await review(seeds("c.spec.ts > three", 2, [DUPLICATE]), { sha: SHA_C, prev: partRun.state });
    expect(back.state.findings.map((f) => [f.n, f.status, f.tests])).toEqual([[1, "new", ["c.spec.ts > three"]]]);
    expect(back.state.next).toBe(2);
  });

  it("some of a commit's race files unread: the tests in the unread files stay with the finding, and the one that showed most stays first", async () => {
    const A = "a.spec.ts > one";
    const B = "b.spec.ts > two";
    const shardA = seeds(A, 2, [DUPLICATE]);
    const shardB = [race(B, 1, [DUPLICATE]), race(B, 2, [])];
    const first = await review([...shardA, ...shardB]);
    // the same commit read again with A's shard unread
    const partial = await review(shardB, { prev: first.state, partial: true });
    expect(partial.state.findings.map((f) => [f.status, f.test, f.tests, f.nt, f.rep, f.seeds, f.of])).toEqual([["new", A, [A, B], 2, true, [1, 2], 2]]);
    // with B's shard unread
    const other = await review(shardA, { prev: first.state, partial: true });
    expect(other.state.findings.map((f) => [f.status, f.test, f.tests, f.rep])).toEqual([["new", A, [A, B], true]]);
    // a read that is whole says what it read: only B flags it now
    const whole = await review(shardB, { prev: first.state });
    expect(whole.state.findings.map((f) => [f.status, f.test, f.tests, f.rep])).toEqual([["new", B, [B], false]]);
    // unread files of another commit keep nothing
    const next = await review(shardB, { prev: first.state, partial: true, sha: SHA_B });
    expect(next.state.findings.map((f) => [f.status, f.tests])).toEqual([["still", [B]]]);
    // nothing of it read now and one of its tests unread: it stays as it was; every test read without it: not flagged now
    const none = await review([race("c.spec.ts > three", 1, [])], { prev: first.state, partial: true });
    expect(none.state.findings).toEqual(first.state.findings);
    const clean = await review([...seeds(A, 2, []), ...seeds(B, 2, [])], { prev: first.state, partial: true });
    expect(clean.state.findings.map((f) => f.status)).toEqual(["gone"]);
  });

  it("rows that list three tests still fit one comment: the longest a review can write is under GitHub's 65,536 characters", async () => {
    // every character of a name needs an escape, every name is as long as a race file may hold, every operation too
    const hostile = (i: number, j: number) => `${`*_[<|@#${i}.${j}`.padEnd(40, "*")}${"<*_|[@".repeat(160)}`;
    const op = (i: number) => `POST /${"|`*".repeat(90)}${i}`;
    const head: Input[] = [];
    const baseInputs: Input[] = [];
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 4; j++) {
        // reproducible in four tests here; on the default branch one of them flags it and another runs clean
        head.push(...seeds(hostile(i, j), 2, [{ d: `odd*_<${i}`, op: op(i), ev: "<e>*_|".repeat(300) }]));
        if (j === 0) baseInputs.push(race(hostile(i, j), 1, [{ d: `odd*_<${i}`, op: op(i) }]));
        if (j === 1) baseInputs.push(race(hostile(i, j), 1, []));
      }
    }
    const notes = Array.from({ length: 5 }, (_, i) => `The artifact "${"<*_|@".repeat(20)}${i}" could not be downloaded.`);
    const { m } = await review(head, { base: { sha: BASE1, inputs: baseInputs, incomplete: true } });
    const model: ReviewModel = { ...m, ci: { ...m.ci, notes, artifacts: Array.from({ length: 6 }, (_, i) => ({ name: `genclass-${"x".repeat(90)}${i}`, runId: i, files: 1 })) }, ignored: 7 };
    // every one of the forty is the pull request's own (reproducible in a test that ran clean there), and the review says so of three
    expect(model.findings.every((f) => !f.base && f.now?.beyond)).toBe(true);
    const body = renderSummary(model)!;
    expect(body).toContain("Finding 1 is flagged there too, but here also in ");
    expect(body.length).toBeLessThan(65_536);
    // and with every one already on the default branch instead, and rows from before the grouping
    const known = await review(head, { base: { sha: BASE1, inputs: head } });
    const aliased: ReviewModel = { ...known.m, ci: model.ci, ignored: 7, findings: known.m.findings.map((f, i) => (i < 5 ? { ...f, also: Array.from({ length: 30 }, (_, k) => 1000 + i * 30 + k) } : f)) };
    expect(aliased.findings.every((f) => f.base)).toBe(true);
    expect(renderSummary(aliased)!.length).toBeLessThan(65_536);
    expect(renderCheck(aliased).summary.length).toBeLessThanOrEqual(60_000);
    // (measured the day this was written: 59,053 and 58,923 characters, of which the table and the sentences are 47,773)
  });

  it("names are kept as they are compared: a cut that falls after a space, a count of tests beyond the names kept", async () => {
    // a test's name whose 240th character is a space, and an operation whose 160th is: what is stored reads back the same
    const long = `${"t".repeat(239)} tail of the name`;
    const op = `GET /${"p".repeat(154)} rest`;
    const first = await review([...seeds(long, 2, [{ d: "duplicate", op }]), ...seeds("b.spec.ts > two", 2, [])]);
    expect(first.state.findings[0]!.test).toBe("t".repeat(239));
    expect(first.state.findings[0]!.op).toBe(`GET /${"p".repeat(154)}`);
    const back = parseState(JSON.stringify(first.state));
    expect(back).toEqual(first.state);
    // so the same files read again change nothing, with or without files unread
    for (const partial of [false, true]) {
      const again = await review([...seeds(long, 2, [{ d: "duplicate", op }]), ...seeds("b.spec.ts > two", 2, [])], { prev: back, partial });
      expect(again.state, String(partial)).toEqual(first.state);
    }
    // and its test running clean is seen as that
    const clean = await review([...seeds(long, 2, []), ...seeds("b.spec.ts > two", 2, [])], { prev: back, sha: SHA_B });
    expect(clean.state.findings.map((f) => f.status)).toEqual(["gone"]);
    // a row stored the earlier way with such an operation regroups under the fingerprint a review gives it
    const stored = v1State([await v1Row(1, "a.spec.ts > one", { d: "duplicate", op: `GET /${"p".repeat(154)} ` })]);
    expect((await loadState(stored)).findings[0]!.fp).toBe(first.state.findings[0]!.fp);

    // twelve tests flag it; five names are kept, and with files of the same commit unread the count does not shrink
    const tests = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}.spec.ts > flags it`);
    const all = tests.flatMap((t) => seeds(t, 1, [DUPLICATE]));
    const whole = await review(all);
    expect(whole.state.findings.map((f) => [f.nt, f.tests.length])).toEqual([[12, MAX_FINDING_TESTS]]);
    const part = await review(all.slice(0, 2), { prev: whole.state, partial: true });
    expect(part.state.findings.map((f) => [f.nt, f.tests.length])).toEqual([[12, MAX_FINDING_TESTS]]);
    // a read that is whole says what it read
    expect((await review(all.slice(0, 2), { prev: whole.state })).state.findings.map((f) => f.nt)).toEqual([2]);
  });

  it("an inline comment goes on one of the finding's tests: the first that is reproducible there and on a line of the diff", async () => {
    const at = (file: string, line: number) => ({ location: { file, line } });
    const inputs = [...seeds(T_SEARCH, 5, [OVERWROTE], at("tests/search.spec.ts", 40)), ...seeds(T_CHROMIUM, 2, [OVERWROTE], at("tests/search.chromium.spec.ts", 7)), race("flaky.spec.ts > once", 1, [OVERWROTE], at("tests/flaky.spec.ts", 3)), race("flaky.spec.ts > once", 2, [], at("tests/flaky.spec.ts", 3))];
    const { m, state } = await review(inputs);
    const locations = testLocations(inputs);
    const diff = (files: Record<string, [number, number][]>) => new Map(Object.entries(files));
    // only the second test's line is in the diff: the comment goes there, with that test's seeds and evidence
    const one = inlineComments(m, state, locations, diff({ "tests/search.chromium.spec.ts": [[1, 20]], "tests/flaky.spec.ts": [[1, 20]] }));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ fp: state.findings[0]!.fp, path: "tests/search.chromium.spec.ts", line: 7 });
    expect(one[0]!.body).toContain("**GenClass, finding 1**: Witness, overwrote-newer on `GET /api/search`, flagged in 2 of 2 seeds of this test, and in 2 other tests.");
    expect(one[0]!.body).toContain(`> evidence of GET /api/search in \\[chromium\\] ${T_SEARCH}`);
    // both lines in the diff: one comment, on the test that flags it in most seeds
    const both = inlineComments(m, state, locations, diff({ "tests/search.chromium.spec.ts": [[1, 20]], "tests/search.spec.ts": [[30, 50]] }));
    expect(both.map((c) => [c.path, c.line])).toEqual([["tests/search.spec.ts", 40]]);
    // a test that flags it in one seed only is not where the comment goes
    expect(inlineComments(m, state, locations, diff({ "tests/flaky.spec.ts": [[1, 20]] }))).toEqual([]);
    expect(inlineComments(m, { ...state, inline: [state.findings[0]!.fp] }, locations, diff({ "tests/search.spec.ts": [[30, 50]] }))).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------- rows stored as v1

/** A finding as the version before this one stored it: one per test and signature, its fingerprint a hash of the two. */
async function v1Row(n: number, test: string, s: Sig, over: Record<string, unknown> = {}) {
  const t = s.t ?? "request";
  const c = t === "witness" ? "witness" : ["duplicate", "stale", "failing"].includes(s.d) ? s.d : "other";
  return { n, fp: await legacyFingerprint(test, `${t}|${s.d}|${s.op}`), c, kind: `${t}:${s.d}`, op: s.op, test, rep: true, seeds: [1, 2], of: 2, first: "1111111", last: "1111111", status: "new", ...over };
}
/** A pull request's state as that version wrote it. */
const v1State = (findings: unknown[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, next: findings.length + 1, findings, evidence: SHA_A, waiting: null, held: false, commentHash: "c".repeat(32), commentDeleted: false, checkHash: "d".repeat(32), inline: [], ...over });

describe("github app: a state stored before findings were grouped (src/github/review.ts regroup)", () => {
  it("rows that share a kind and operation become one finding under the lowest number; the other numbers still name it, and none is given out again", async () => {
    const r = [
      await v1Row(1, T_CHROMIUM, OVERWROTE),
      await v1Row(2, T_SEARCH, OVERWROTE, { seeds: [1, 2, 3, 4, 5], of: 5 }),
      await v1Row(3, T_CHECKOUT, DUPLICATE, { status: "gone", first: "0000000", last: "0000000" }),
      await v1Row(4, T_CART, OVERWROTE, { status: "not-run", rep: false, seeds: [2] }),
    ];
    const stored = v1State(r, { inline: [r[1]!.fp, r[2]!.fp] });
    // read as it is, it is what was stored: what a pass needs besides the findings is all there
    const raw = parseState(stored);
    expect(raw).toMatchObject({ v: 1, next: 5, evidence: SHA_A, base: null, commentHash: "c".repeat(32), checkHash: "d".repeat(32) });
    expect(raw.findings.map((f) => [f.n, f.fp])).toEqual(r.map((x) => [x.n, x.fp]));

    const s = await loadState(stored);
    const search = await fingerprint("witness:overwrote-newer", "GET /api/search");
    const orders = await fingerprint("request:duplicate", "POST /api/orders");
    expect(s.v).toBe(2);
    expect(s.findings.map((f) => [f.n, f.also ?? [], f.fp, f.status, f.test, f.tests, f.nt, f.rep, f.seeds, f.of, f.first, f.last])).toEqual([
      // rows 1, 2 and 4: flagged in the two tests whose rows were, the one with more seeds first
      [1, [2, 4], search, "new", T_SEARCH, [T_SEARCH, T_CHROMIUM], 2, true, [1, 2, 3, 4, 5], 5, "1111111", "1111111"],
      // a row that shared its kind and operation with no other: everything as it was but the fingerprint
      [3, [], orders, "gone", T_CHECKOUT, [T_CHECKOUT], 1, true, [1, 2], 2, "0000000", "0000000"],
    ]);
    expect(s).toMatchObject({ next: 5, evidence: SHA_A, base: null, waiting: null, held: false, commentHash: "c".repeat(32), checkHash: "d".repeat(32), commentDeleted: false });
    // an inline mark follows its row
    expect(s.inline).toEqual([search, orders]);
    // a state that is grouped is left alone, and what is written reads back the same
    expect(await regroup(s)).toBe(s);
    expect(await loadState(JSON.stringify(s))).toEqual(s);

    // the same commit read again by the new version: nothing is new, nothing is renumbered
    const inputs = [...seeds(T_CHROMIUM, 2, [OVERWROTE]), ...seeds(T_SEARCH, 5, [OVERWROTE]), ...seeds(T_CHECKOUT, 2, [])];
    const again = await review(inputs, { prev: s });
    expect(again.state.findings.map((f) => [f.n, f.also ?? [], f.status])).toEqual([
      [1, [2, 4], "new"],
      [3, [], "gone"],
    ]);
    expect(again.state.next).toBe(5);
    // the comment says where the rows went
    const body = renderSummary(again.m)!;
    expect(rows(body)).toHaveLength(2);
    expect(body).toContain("Finding 1 was also listed as 2, 4: rows with the same kind and operation are one finding now, and those numbers still name it in a command.");
    // a finding that is new afterwards gets the next number: 2 and 4 are not given out again
    const more = await review([...inputs, race(T_CART, 1, [FAILING])], { prev: again.state, sha: SHA_B });
    expect(more.state.findings.map((f) => [f.n, f.status])).toEqual([
      [1, "still"],
      [3, "gone"],
      [5, "new"],
    ]);
    // the fold regroups by itself when it is handed a state as it was stored
    const direct = await mergeFindings(parseState(stored), summaryOf(inputs, DEFAULT_SETTINGS), SHA_A, { ignore: [] });
    expect(direct.state).toEqual(again.state);
  });

  it("the one finding is flagged when one of its rows was, still flagged when one was, and not flagged only when every row said so", async () => {
    const group = async (...statuses: string[]) => {
      const r = [];
      for (const [i, status] of statuses.entries()) r.push(await v1Row(i + 1, `t${i + 1}.spec.ts > t`, DUPLICATE, { status }));
      const s = await loadState(v1State(r));
      expect(s.findings).toHaveLength(1);
      return s.findings[0]!;
    };
    expect(await group("new", "gone")).toMatchObject({ n: 1, also: [2], status: "new", tests: ["t1.spec.ts > t"], nt: 1 });
    expect(await group("gone", "still", "new")).toMatchObject({ n: 1, also: [2, 3], status: "still", tests: ["t2.spec.ts > t", "t3.spec.ts > t"], nt: 2 });
    expect(await group("gone", "gone")).toMatchObject({ status: "gone", tests: ["t1.spec.ts > t", "t2.spec.ts > t"], nt: 2 });
    expect(await group("gone", "not-run")).toMatchObject({ status: "not-run" });
    expect(await group("not-run")).toMatchObject({ n: 1, status: "not-run", test: "t1.spec.ts > t" });
    expect((await group("new")).also).toBeUndefined();
    // `next` is past every number a row ever had, also when the stored one was lost
    const r = [await v1Row(3, "a.spec.ts > a", DUPLICATE), await v1Row(9, "b.spec.ts > b", DUPLICATE)];
    const s = await loadState(v1State(r, { next: 1 }));
    expect(s.findings.map((f) => [f.n, f.also])).toEqual([[3, [9]]]);
    expect(s.next).toBe(10);
    expect(parseState(JSON.stringify(s)).next).toBe(10);
  });

  it("an issue opened before findings were grouped still counts for its finding", async () => {
    const r = [await v1Row(1, T_CHROMIUM, OVERWROTE), await v1Row(2, T_SEARCH, OVERWROTE)];
    const f = (await loadState(v1State(r))).findings[0]!;
    // the fingerprints its rows had, which the markers of issues opened then carry
    expect(new Set(await legacyFingerprints(f))).toEqual(new Set([r[0]!.fp, r[1]!.fp]));
    expect(await legacyFingerprints(f)).not.toContain(f.fp);
    expect(await legacyFingerprints({ kind: "no-colon", op: "x", test: "t", tests: ["t"] })).toEqual([]);
  });

  it("anything else in the column is read as it always was: an unknown version is an empty state, and a hostile v2 state keeps only what a review writes", () => {
    expect(parseState('{"v":3,"findings":[]}')).toEqual(emptyState());
    const hostile = JSON.stringify({
      v: 2,
      next: 2,
      base: "not a commit",
      findings: [{ n: 7, also: [7, 8, "9", -1, 8, 100000], fp: "0123456789abcdef", c: "stale", status: "new", kind: "delivery:stale", op: "GET /a", test: "t", tests: ["t", "u", 5, "", "u", "v", "w", "x", "y"], nt: -3, base: "yes" }],
    });
    const s = parseState(hostile);
    expect(s.findings).toHaveLength(1);
    expect(s.findings[0]).toMatchObject({ n: 7, also: [8], tests: ["t", "u", "v", "w", "x"], nt: 5, base: false });
    expect(s.next).toBe(9);
    expect(s.base).toBeNull();
    expect(parseState(JSON.stringify({ v: 2, base: BASE1, findings: [{ n: 1, fp: "0123456789abcdef", c: "stale", status: "new", base: true, nt: 12, test: "t" }] }))).toMatchObject({ base: BASE1, findings: [{ base: true, nt: 12, tests: ["t"] }] });
  });
});

// --------------------------------------------------------------------------------------------- the baseline, pure

describe("github app: what the default branch has too (src/github/review.ts header)", () => {
  // on the default branch: the double submit and the stale response, flagged by other tests than the pull request's
  const ON_BASE = [...seeds("legacy/buy.spec.ts > buys", 2, [DUPLICATE]), race("legacy/list.spec.ts > lists", 1, [STALE])];
  const HEAD = [...seeds(T_CHECKOUT, 2, [DUPLICATE]), race(T_SEARCH, 1, [STALE]), race(T_SEARCH, 2, []), ...seeds(T_CART, 2, [FAILING])];

  it("a finding the default branch's race files flag too is listed as already there: not new, after the pull request's own, without an inline comment", async () => {
    const { m, state } = await review(HEAD, { base: { sha: BASE1, inputs: ON_BASE } });
    // the default branch flags the same kind and operation in other tests than these: the test is not what is compared
    expect(state.findings.map((f) => [f.n, f.op, f.status, f.base])).toEqual([
      [1, "GET /api/cart", "new", false],
      [2, "POST /api/orders", "new", true],
      [3, "GET /api/items", "new", true],
    ]);
    expect(state.base).toBe(BASE1);
    const body = renderSummary(m)!;
    expect(body).toContain("**3 findings** in this pull request's tests at `aaaaaaa` · 2 reproducible · 1 new · 2 already on the default branch · 3 tests read");
    expect(rows(body)).toEqual([
      "| 1 | New | Failing endpoint · `GET /api/cart` | cart.spec.ts > cart > adds | 2 of 2 seeds, **reproducible** |",
      "| 2 | Already on the default branch | Duplicate submit · `POST /api/orders` | checkout.spec.ts > checkout > places one order | 2 of 2 seeds, **reproducible** |",
      "| 3 | Already on the default branch | Stale response · `GET /api/items` | search.spec.ts > search > buggy page: results of the last query | 1 of 2 seeds |",
    ]);
    // a finding of the pull request's own goes first whatever its number: here the default branch has the first two
    const other = await review(HEAD, { base: { sha: BASE1, inputs: [...seeds("x.spec.ts > x", 2, [FAILING]), ...seeds("y.spec.ts > y", 2, [DUPLICATE])] } });
    expect(rows(renderSummary(other.m)!).map((l) => l.split(" | ").slice(0, 2).join(" | "))).toEqual(["| 3 | New", "| 1 | Already on the default branch", "| 2 | Already on the default branch"]);
    // one sentence says what the status rests on and which commit it can be checked against
    expect(body).toContain("2 of the 3 findings are already on the default branch: its race files at `ddddddd` flag the same kind and operation. They are not counted as new and get no inline comment.\n");
    // what was read is said where everything that was read is said
    expect(body).toContain("genclass-dev[bot] read 6 race files from the artifact `genclass-races` of this pull request's workflow run, and 3 race files of the default branch at `ddddddd`, never your source code.");
    // the command line names a finding that is flagged, whichever it is
    expect(body).toContain("Reply `@genclass-dev replay 1` for the steps to reproduce a finding");
    const check = renderCheck(m);
    expect(check).toMatchObject({ title: "3 findings, 2 reproducible, 2 already on the default branch", conclusion: "neutral" });
    expect(check.summary).toContain("2 of the 3 findings are already on the default branch");
    // inline: the cart test's line and the checkout test's line are both in the diff, and only the pull request's own finding is commented
    const located = [...seeds(T_CHECKOUT, 2, [DUPLICATE], { location: { file: "tests/checkout.spec.ts", line: 12 } }), ...seeds(T_CART, 2, [FAILING], { location: { file: "tests/cart.spec.ts", line: 30 } })];
    const second = await review(located, { base: { sha: BASE1, inputs: ON_BASE } });
    const diff = new Map<string, [number, number][]>([
      ["tests/checkout.spec.ts", [[1, 50]]],
      ["tests/cart.spec.ts", [[1, 50]]],
    ]);
    expect(inlineComments(second.m, second.state, testLocations(located), diff).map((c) => c.path)).toEqual(["tests/cart.spec.ts"]);
    // a statement about two sets of race files: the sentence says nothing of what the pull request did or did not cause
    const sentence = body.split("\n").find((l) => l.includes("already on the default branch:"))!;
    expect(sentence.toLowerCase()).not.toMatch(/\bcause|\bbug|pre-existing|\bfixed|\bintroduc/);
  });

  it("`check.fail_on`: what the default branch has too does not fail a pull request's check, unless `check.fail_on_baseline` asks", async () => {
    const base = { sha: BASE1, inputs: ON_BASE };
    const known = seeds(T_CHECKOUT, 2, [DUPLICATE]);
    const verdict = async (inputs: Input[], settings: RepoSettings) => renderCheck((await review(inputs, { base, settings })).m);
    // only a finding that is already there, reproducible: neutral under both settings, never a success
    for (const failOn of ["reproducible", "any"] as const) {
      const c = await verdict(known, failing(failOn));
      expect(c, failOn).toMatchObject({ status: "completed", conclusion: "neutral", title: "1 finding, 1 reproducible, 1 already on the default branch" });
      expect(c.summary).toContain("This finding is already on the default branch: its race files at `ddddddd` flag the same kind and operation. It is not counted as new and gets no inline comment. It does not fail the check; `check.fail_on_baseline: true` makes it count.");
      const strict = await verdict(known, failing(failOn, true));
      expect(strict.conclusion, failOn).toBe("failure");
      expect(strict.summary).toContain("It counts for `check.fail_on`, as `check.fail_on_baseline` asks.");
    }
    expect((await verdict(known, failing("never"))).summary).not.toContain("check.fail_on");
    // with a reproducible finding of the pull request's own: a failure
    expect((await verdict([...known, ...seeds(T_CART, 2, [FAILING])], failing("reproducible"))).conclusion).toBe("failure");
    // its own finding seen in one seed: `reproducible` does not fail, `any` does
    const single = [...known, race(T_CART, 1, [FAILING]), race(T_CART, 2, [])];
    expect((await verdict(single, failing("reproducible"))).conclusion).toBe("neutral");
    expect((await verdict(single, failing("any"))).conclusion).toBe("failure");
    // without a comparison everything counts, as it did before there were baselines
    expect(renderCheck((await review(known, { settings: failing("reproducible"), view: { state: "none", sha: null, files: 0, incomplete: false } })).m).conclusion).toBe("failure");
  });

  it("the marks are of the last comparison: they stand while the default branch's files cannot be read, and go when those files no longer flag the finding", async () => {
    const first = await review(seeds(T_CHECKOUT, 2, [DUPLICATE]), { base: { sha: BASE1, inputs: ON_BASE } });
    expect(first.state.findings.map((f) => [f.n, f.base])).toEqual([[1, true]]);
    // the next push, and nothing could be read of the default branch: the mark stands, a finding first flagged now has none
    const head2 = [...seeds(T_CHECKOUT, 2, [DUPLICATE]), ...seeds(T_CART, 2, [FAILING])];
    const second = await review(head2, { prev: first.state, sha: SHA_B, view: { state: "unread", sha: BASE1, files: 0, incomplete: false } });
    expect(second.state.findings.map((f) => [f.n, f.status, f.base])).toEqual([
      [1, "still", true],
      [2, "new", false],
    ]);
    expect(second.state.base).toBe(BASE1);
    const body = renderSummary(second.m)!;
    expect(rows(body)[1]).toContain("| 1 | Already on the default branch |");
    expect(body).toContain("The default branch's race files were not read this time: what was compared with them at `ddddddd` stands, and a finding first flagged since then is listed like any other.");
    expect(body).not.toContain("race files of the default branch at");
    // A later commit of the default branch no longer flags it. It is this pull request's own now, and it was never
    // listed as that: it is new, as a finding first flagged at this commit would be
    const third = await review(head2, { prev: second.state, sha: SHA_C, base: { sha: BASE2, inputs: [race("legacy/list.spec.ts > lists", 1, [STALE])] } });
    expect(third.state.findings.map((f) => [f.n, f.status, f.base])).toEqual([
      [1, "new", false],
      [2, "still", false],
    ]);
    expect(third.state.base).toBe(BASE2);
    expect(renderSummary(third.m)).toContain("Compared with the default branch's race files at `eeeeeee`: none of these findings is flagged there.");
    expect(rows(renderSummary(third.m)!).map((l) => l.split(" | ").slice(0, 2).join(" | "))).toEqual(["| 1 | New", "| 2 | Still flagged"]);
    expect(renderSummary(third.m)).toContain("**2 findings** in this pull request's tests at `ccccccc` · 2 reproducible · 1 new · 2 tests read");
    // read again at the same commit, nothing changes
    const again = await review(head2, { prev: third.state, sha: SHA_C, base: { sha: BASE2, inputs: [race("legacy/list.spec.ts > lists", 1, [STALE])] } });
    expect(again.state).toEqual(third.state);
    // a finding that is not flagged now carries no mark from a comparison it was not part of
    const gone = await review(seeds(T_CHECKOUT, 2, []), { prev: first.state, sha: SHA_B, base: { sha: BASE2, inputs: ON_BASE } });
    expect(gone.state.findings.map((f) => [f.status, f.base])).toEqual([["gone", false]]);
    // the settings turn the comparison off: no mark is kept, and the state names no commit
    const off = await mergeFindings(first.state, summaryOf(head2, DEFAULT_SETTINGS), SHA_B, { baseline: "off" });
    expect(off.state.findings.map((f) => [f.n, f.base])).toEqual([
      [1, false],
      [2, false],
    ]);
    expect(off.state.base).toBeNull();
    // also while a commit has no race files yet: a review that says nothing of the default branch shows no mark of it
    const waiting = await mergeFindings(first.state, null, SHA_B, { baseline: "off" });
    expect(waiting.state.findings.map((f) => [f.n, f.status, f.base])).toEqual([[1, "new", false]]);
    expect(waiting.state.base).toBeNull();
    // and with the comparison on, a commit without race files changes nothing
    expect((await mergeFindings(first.state, null, SHA_B)).state).toEqual(first.state);
  });

  it("pull request 180's two \"New\" rows, with a default branch whose race files show the same witness in the same tests: one row, already there", async () => {
    const files = [...seeds(T_CHROMIUM, 2, [OVERWROTE]), ...seeds(T_SEARCH, 5, [OVERWROTE]), ...seeds("search.spec.ts > search > fixed page: results of the last query", 5, [])];
    const { m, state } = await review(files, { base: { sha: `d49a0b3${"0".repeat(33)}`, inputs: files } });
    const body = renderSummary(m)!;
    expect(rows(body)).toEqual([
      "| 1 | Already on the default branch | Witness, overwrote-newer · `GET /api/search` | 2 tests: search.spec.ts > search > buggy page: results of the last query; \\[chromium\\] search.spec.ts > search > buggy page: results of the last query | 5 of 5 seeds in the first, **reproducible** |",
    ]);
    expect(body).toContain("This finding is already on the default branch: its race files at `d49a0b3` flag the same kind and operation. It is not counted as new and gets no inline comment.");
    expect(body).toContain("**1 finding** in this pull request's tests at `aaaaaaa` · 1 reproducible · 1 already on the default branch · 3 tests read");
    expect(state.findings.map((f) => [f.n, f.base])).toEqual([[1, true]]);
    // and were the fixed page to show it here in every seed, that would be this pull request's, whatever the buggy page does
    const broken = [...files.slice(0, 7), ...seeds("search.spec.ts > search > fixed page: results of the last query", 5, [OVERWROTE])];
    const regressed = await review(broken, { base: { sha: `d49a0b3${"0".repeat(33)}`, inputs: files } });
    expect(regressed.state.findings.map((f) => [f.n, f.base, f.nt])).toEqual([[1, false, 3]]);
    expect(rows(renderSummary(regressed.m)!)[0]).toContain("| 1 | New | Witness, overwrote-newer · `GET /api/search` | 3 tests: ");
    expect(renderSummary(regressed.m)).toContain("Finding 1 is flagged there too, but here also in search.spec.ts > search > fixed page: results of the last query, a test that ran there without it: it is listed as this pull request's.");
  });

  it("a known race that the pull request brings into a test that ran clean on the default branch is the pull request's own", async () => {
    const A = "a.spec.ts > one";
    const B = "b.spec.ts > two";
    const C = "c.spec.ts > three";
    // on the default branch: A flags the double submit in both seeds, and B runs without it
    const base = { sha: BASE1, inputs: [...seeds(A, 2, [DUPLICATE]), ...seeds(B, 2, [])] };
    // here B flags it in both seeds too: reproducible in a test that was clean there
    const spread = await review([...seeds(A, 2, [DUPLICATE]), ...seeds(B, 2, [DUPLICATE])], { base, settings: failing("reproducible") });
    expect(spread.state.findings.map((f) => [f.n, f.status, f.base, f.tests])).toEqual([[1, "new", false, [A, B]]]);
    expect(spread.m.findings[0]!.now!.beyond).toBe(B);
    const body = renderSummary(spread.m)!;
    expect(rows(body)).toEqual(["| 1 | New | Duplicate submit · `POST /api/orders` | 2 tests: a.spec.ts > one; b.spec.ts > two | 2 of 2 seeds in the first, **reproducible** |"]);
    expect(body).toContain("**1 finding** in this pull request's tests at `aaaaaaa` · 1 reproducible · 2 tests read");
    expect(body).toContain("Compared with the default branch's race files at `ddddddd`: nothing here is listed as already there. Finding 1 is flagged there too, but here also in b.spec.ts > two, a test that ran there without it: it is listed as this pull request's.");
    // and it fails a check that fails on reproducible findings: the default branch's own would not
    expect(renderCheck(spread.m)).toMatchObject({ title: "1 finding, 1 reproducible", conclusion: "failure" });
    // in that test alone, with A clean here: the same
    const moved = await review([...seeds(A, 2, []), ...seeds(B, 2, [DUPLICATE])], { base });
    expect(moved.state.findings.map((f) => [f.base, f.tests])).toEqual([[false, [B]]]);
    // one seed in a test that was clean there is not enough to tell it from the default branch's own
    const once = await review([...seeds(A, 2, [DUPLICATE]), race(B, 1, [DUPLICATE]), race(B, 2, [])], { base, settings: failing("reproducible") });
    expect(once.state.findings.map((f) => [f.base, f.tests])).toEqual([[true, [A, B]]]);
    expect(once.m.findings[0]!.now!.beyond).toBeNull();
    expect(renderCheck(once.m).conclusion).toBe("neutral");
    // a test the default branch did not run (a new test) is not a test that was clean there
    const added = await review([...seeds(A, 2, [DUPLICATE]), ...seeds(C, 2, [DUPLICATE])], { base });
    expect(added.state.findings.map((f) => [f.base, f.tests])).toEqual([[true, [A, C]]]);
    // beside one that the default branch has: each is told for itself
    const two = await review([...seeds(A, 2, [DUPLICATE, STALE]), ...seeds(B, 2, [DUPLICATE])], { base: { sha: BASE1, inputs: [...seeds(A, 2, [DUPLICATE, STALE]), ...seeds(B, 2, [])] } });
    expect(two.state.findings.map((f) => [f.op, f.base])).toEqual([
      ["POST /api/orders", false],
      ["GET /api/items", true],
    ]);
    expect(renderSummary(two.m)).toContain("1 of the 2 findings is already on the default branch: its race files at `ddddddd` flag the same kind and operation. It is not counted as new and gets no inline comment. Finding 1 is flagged there too, but here also in b.spec.ts > two, a test that ran there without it: it is listed as this pull request's.");

    // A mark that stands without a comparison stands for the tests it was made for
    const first = await review(seeds(A, 2, [DUPLICATE]), { base });
    expect(first.state.findings[0]!.base).toBe(true);
    const unread: BaselineView = { state: "unread", sha: BASE1, files: 0, incomplete: false };
    const same = await review(seeds(A, 2, [DUPLICATE]), { prev: first.state, sha: SHA_B, view: unread });
    expect(same.state.findings[0]!.base).toBe(true);
    const single = await review([...seeds(A, 2, [DUPLICATE]), race(B, 1, [DUPLICATE]), race(B, 2, [])], { prev: first.state, sha: SHA_B, view: unread });
    expect(single.state.findings[0]!.base).toBe(true);
    // reproducible in another test, and nothing to check that against: the mark goes, and the finding is news here
    const wider = await review([...seeds(A, 2, [DUPLICATE]), ...seeds(B, 2, [DUPLICATE])], { prev: first.state, sha: SHA_B, view: unread });
    expect(wider.state.findings.map((f) => [f.status, f.base])).toEqual([["new", false]]);
    expect(rows(renderSummary(wider.m)!)[0]).toContain("| 1 | New |");
    // the same when the comparison is made and shows the test clean on the default branch: new at the commit that brought it there
    const later = await review([...seeds(A, 2, [DUPLICATE]), ...seeds(B, 2, [DUPLICATE])], { prev: first.state, sha: SHA_B, base });
    expect(later.state.findings.map((f) => [f.status, f.base])).toEqual([["new", false]]);
  });

  it("no baseline: the review is what it was before, and says that none was read", async () => {
    const none: BaselineView = { state: "none", sha: null, files: 0, incomplete: false };
    const plain = renderSummary((await review(HEAD)).m)!;
    const said = "No baseline was read: no workflow run on the default branch has race files this review can read, so a finding that is already there is listed like any other.";
    const withNone = await review(HEAD, { view: none });
    const body = renderSummary(withNone.m)!;
    expect(body).toContain(`${said}\n`);
    // that sentence is the whole difference
    expect(body.replace(`${said}\n\n`, "")).toBe(plain);
    expect(withNone.state.findings.every((f) => !f.base)).toBe(true);
    expect(withNone.state.base).toBeNull();
    expect(renderCheck(withNone.m).summary).toContain(said);
    expect(renderCheck(withNone.m).title).toBe("3 findings, 2 reproducible");
    // not read this time, and never compared before
    expect(renderSummary((await review(HEAD, { view: { ...none, state: "unread" } })).m)).toContain("No baseline was read: the default branch's race files could not be read this time, so a finding that is already there is listed like any other.");
    // turned off in the settings: nothing is said about it
    expect(renderSummary((await review(HEAD, { view: { ...none, state: "off" } })).m)).toBe(plain);
    // nothing flagged: nothing to compare, and nothing is said
    const clean = await review(seeds(T_CHECKOUT, 2, []), { view: none });
    expect(renderSummary(clean.m)).not.toContain("baseline");
    expect(renderCheck(clean.m)).toMatchObject({ conclusion: "success", title: "Nothing flagged in 1 test" });
  });

  it("a comparison that is not whole says so; one that finds nothing says that; one finding is spoken of as one", async () => {
    const part = await review(HEAD, { base: { sha: BASE1, inputs: ON_BASE, incomplete: true } });
    expect(renderSummary(part.m)).toContain("They are not counted as new and get no inline comment. Not all of the default branch's race files could be read, so a finding that is there may be listed as new.");
    const nothing = await review(seeds(T_CART, 2, [FAILING]), { base: { sha: BASE1, inputs: ON_BASE } });
    expect(renderSummary(nothing.m)).toContain("Compared with the default branch's race files at `ddddddd`: this finding is not flagged there.");
    expect(nothing.state.base).toBe(BASE1);
    const all = await review([...seeds(T_CHECKOUT, 2, [DUPLICATE]), race(T_SEARCH, 1, [STALE])], { base: { sha: BASE1, inputs: ON_BASE } });
    expect(renderSummary(all.m)).toContain("All 2 findings are already on the default branch: its race files at `ddddddd` flag the same kind and operation. They are not counted as new and get no inline comment.");
    expect(renderSummary(all.m)).toContain("**2 findings** in this pull request's tests at `aaaaaaa` · 1 reproducible · 2 already on the default branch · 2 tests read");
    const one = await review([...seeds(T_CHECKOUT, 2, [DUPLICATE]), ...seeds(T_CART, 2, [FAILING])], { base: { sha: BASE1, inputs: ON_BASE } });
    expect(renderSummary(one.m)).toContain("1 of the 2 findings is already on the default branch: its race files at `ddddddd` flag the same kind and operation. It is not counted as new and gets no inline comment.");
    // the brief for an agent says it too
    const there = one.state.findings.find((f) => f.op === "POST /api/orders")!;
    expect(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(renderFixBrief(there, { repo: "acme/shop", number: 12, headSha: SHA_A, mention: "genclass-dev", links: LINKS, asker: "ada" }))![1]!).finding.on_default_branch).toBe(true);
  });

  it("over MAX_FINDINGS: a finding that has no row is compared too, and counts for the check as its mark says", async () => {
    const t = "big.spec.ts > one";
    const single = Array.from({ length: MAX_FINDINGS }, (_, i) => ({ ...race(t, 1, [{ d: "duplicate", op: `POST /api/x${i}` }]), name: `x${i}.json` }));
    const first = await review(single);
    const late: Sig = { d: "stale", op: "GET /api/late", t: "delivery" };
    const more = [...single, { ...race(t, 1, [late]), name: "late-1.json" }, { ...race(t, 2, [late]), name: "late-2.json" }];
    // the reproducible one has no room, and the default branch flags it too
    const second = await review(more, { prev: first.state, sha: SHA_B, settings: failing("reproducible"), base: { sha: BASE1, inputs: [race("x.spec.ts > x", 1, [late])] } });
    expect(second.merged.unlisted).toEqual({ n: 1, rep: 1, base: 1, baseRep: 1 });
    expect(renderCheck(second.m)).toMatchObject({ title: "101 findings, 1 reproducible, 1 already on the default branch", conclusion: "neutral" });
    expect(renderCheck({ ...second.m, settings: failing("reproducible", true) }).conclusion).toBe("failure");
    // not on the default branch: it fails the check as before
    const own = await review(more, { prev: first.state, sha: SHA_B, settings: failing("reproducible"), base: { sha: BASE1, inputs: ON_BASE } });
    expect(own.merged.unlisted).toEqual({ n: 1, rep: 1, base: 0, baseRep: 0 });
    expect(renderCheck(own.m).conclusion).toBe("failure");
  });
});

// --------------------------------------------------------------------------------------------- ignore, pure

describe("github app: signatures the settings leave out (docs/github-app/README.md, \"Settings\")", () => {
  const rule = (kind: string, operation: string): IgnoreRule => ({ kind, operation });
  const withIgnore = (...ignore: IgnoreRule[]): RepoSettings => ({ ...DEFAULT_SETTINGS, ignore });

  it("the settings file: `ignore` takes a kind and an operation per entry, `baseline` and `check.fail_on_baseline` true or false", () => {
    const text = ["ignore:", "  - kind: witness:identical-in-flight", "    operation: POST /api/cart", "  - kind: request:duplicate", '    operation: "GET /api/items/*"', "baseline: false", "check:", "  fail_on: any", "  fail_on_baseline: true"].join("\n");
    expect(readSettings(text)).toEqual({
      settings: { ...DEFAULT_SETTINGS, baseline: false, check: { enabled: true, failOn: "any", failOnBaseline: true }, ignore: [rule("witness:identical-in-flight", "POST /api/cart"), rule("request:duplicate", "GET /api/items/*")] },
      warnings: [],
    });
    expect(DEFAULT_SETTINGS).toMatchObject({ baseline: true, ignore: [], check: { failOnBaseline: false } });
    expect(readSettings("ignore: []\nbaseline: true\n")).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
    // white space is read as a review writes it
    expect(readSettings('ignore:\n  - kind: " witness:overwrote-newer "\n    operation: "GET   /api/search"\n').settings.ignore).toEqual([rule("witness:overwrote-newer", "GET /api/search")]);
  });

  it("an entry that names no kind and operation is left out and said, so that a mistake never leaves out more than was meant", () => {
    const text = [
      "ignore:",
      "  - witness:identical-in-flight POST /api/cart",
      "  - kind: duplicate",
      "    operation: POST /a",
      "  - kind: witness:overwrote-newer",
      "  - kind: witness:overwrote-newer",
      '    operation: "GET /*/items/*"',
      "  - kind: witness:overwrote-newer",
      "    operation: GET /api/search",
      "    test: search.spec.ts",
      "  - kind: witness:overwrote-newer",
      "    operation: GET /api/search",
      `  - kind: witness:${"k".repeat(80)}`,
      "    operation: GET /x",
      "baseline: maybe",
      "check:",
      "  fail_on_baseline: 1",
    ].join("\n");
    const r = readSettings(text);
    // the one entry that is used is the last but one: the entry before it says the same and names a test too
    expect(r.settings).toEqual({ ...DEFAULT_SETTINGS, ignore: [rule("witness:overwrote-newer", "GET /api/search")] });
    const KIND = "ignore: a kind is written as a race report writes it, like witness:identical-in-flight; one entry was left out.";
    const OPERATION = 'ignore: an operation is written as a review shows it, like "POST /api/cart", with at most one "*" for any run of characters; one entry was left out.';
    const EXTRA = "ignore: an entry takes a kind and an operation and nothing else (test is not read); one entry was left out.";
    expect(r.warnings).toEqual(["check.fail_on_baseline must be true or false; using false.", "baseline must be true or false; using true.", "ignore takes entries with a kind and an operation; one entry was left out.", KIND, OPERATION, OPERATION, EXTRA, KIND]);
    // An entry that names a test as well is not read as an entry for every test: with nothing else in the file,
    // nothing is left out. (A key is repeated in the message only when it is a plain word.)
    const narrower = readSettings('ignore:\n  - kind: witness:overwrote-newer\n    operation: "*"\n    test: checkout.spec.ts\n');
    expect(narrower).toEqual({ settings: DEFAULT_SETTINGS, warnings: [EXTRA] });
    expect(readSettings('ignore:\n  - kind: witness:overwrote-newer\n    operation: "*"\n    "a b <c>": 1\n').warnings).toEqual(["ignore: an entry takes a kind and an operation and nothing else (another key is not read); one entry was left out."]);
    expect(readSettings("ignore: witness:overwrote-newer\n")).toEqual({ settings: DEFAULT_SETTINGS, warnings: ["ignore must be a list of entries, each with a kind and an operation."] });
    // thirty entries are kept
    const many = `ignore:\n${Array.from({ length: 35 }, (_, i) => `  - kind: request:duplicate\n    operation: POST /api/x${i}\n`).join("")}`;
    const kept = readSettings(many);
    expect(kept.settings.ignore).toHaveLength(30);
    expect(kept.warnings).toEqual(["ignore keeps its first 30 entries."]);
  });

  it("an operation matches as written, or with one * for any run of characters; whatever a rule and an operation hold, it is one pass", () => {
    expect(operationMatches("POST /api/cart", "POST /api/cart")).toBe(true);
    expect(operationMatches("POST /api/cart", "POST /api/cart/items")).toBe(false);
    expect(operationMatches("POST /api/cart", "post /api/cart")).toBe(false);
    expect(operationMatches("GET /api/items/*", "GET /api/items/:id")).toBe(true);
    expect(operationMatches("GET /api/items/*", "GET /api/items/")).toBe(true);
    expect(operationMatches("GET /api/items/*", "GET /api/items")).toBe(false);
    expect(operationMatches("* /health", "GET /health")).toBe(true);
    expect(operationMatches("GET /api/*/comments", "GET /api/posts/:id/comments")).toBe(true);
    // the two ends may not share characters
    expect(operationMatches("GET /api/*/api/x", "GET /api/x")).toBe(false);
    expect(operationMatches("*", "anything at all")).toBe(true);
    expect(operationMatches("*", "")).toBe(true);
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) operationMatches(`${"a".repeat(80)}*${"a".repeat(79)}`, "a".repeat(160));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("a signature the settings leave out is not listed, numbered or counted, and the review says how many were left out", async () => {
    const inputs = [...seeds(T_CART, 2, [IN_FLIGHT]), race("cart.spec.ts > cart > removes", 1, [IN_FLIGHT]), ...seeds(T_CHECKOUT, 2, [DUPLICATE]), ...seeds(T_SEARCH, 2, [{ d: "identical-in-flight", op: "POST /api/search", t: "witness" }])];
    const settings = withIgnore(rule("witness:identical-in-flight", "POST /api/cart"));
    const { m, state, merged } = await review(inputs, { settings });
    // in three tests' files, and one signature: one is left out
    expect(merged.ignored).toBe(1);
    expect(state.findings.map((f) => [f.n, f.kind, f.op])).toEqual([
      [1, "request:duplicate", "POST /api/orders"],
      [2, "witness:identical-in-flight", "POST /api/search"],
    ]);
    expect(state.next).toBe(3);
    const body = renderSummary(m)!;
    const said = "1 finding flagged at this commit is left out by `ignore` in `.github/genclass.yml`: not listed and not counted, here or in the check. The race report still shows it.";
    expect(body).toContain("**2 findings** in this pull request's tests at `aaaaaaa` · 2 reproducible · 4 tests read");
    expect(body).toContain(`${said}\n`);
    // above the fold nothing names it; the race report, which is the summariser's text for the files read, still does
    const [above, report] = body.split("<details>") as [string, string];
    expect(above).not.toContain("POST /api/cart");
    expect(report).toContain("`POST /api/cart` · `witness:identical-in-flight`");
    const check = renderCheck({ ...m, settings: { ...settings, check: { enabled: true, failOn: "any", failOnBaseline: false } } });
    expect(check).toMatchObject({ title: "2 findings, 2 reproducible", conclusion: "failure" });
    expect(check.summary).toContain(said);
    expect(hasFindings(m.summary, settings.ignore)).toBe(true);
  });

  it("when everything flagged is left out the check can be green, and says what it left out", async () => {
    const inputs = [...seeds(T_CART, 2, [IN_FLIGHT]), ...seeds(T_SEARCH, 2, [OVERWROTE]), ...seeds(T_CHECKOUT, 2, [])];
    // one entry by its operation, one for every operation of a kind
    const settings = { ...withIgnore(rule("witness:identical-in-flight", "POST /api/*"), rule("witness:overwrote-newer", "*")), check: { enabled: true, failOn: "any" as const, failOnBaseline: true } };
    const { m, state, merged } = await review(inputs, { settings, base: null, view: { state: "none", sha: null, files: 0, incomplete: false } });
    expect(merged.ignored).toBe(2);
    expect(state.findings).toEqual([]);
    expect(state.next).toBe(1);
    expect(hasFindings(m.summary, settings.ignore)).toBe(false);
    expect(hasFindings(m.summary, [])).toBe(true);
    const check = renderCheck(m);
    expect(check).toMatchObject({ status: "completed", conclusion: "success", title: "Nothing flagged in 3 tests, besides 2 left out by the settings" });
    expect(check.summary).toContain("**Nothing flagged** in 3 tests at `aaaaaaa`, besides 2 findings the settings leave out");
    expect(check.summary).toContain("2 findings flagged at this commit are left out by `ignore` in `.github/genclass.yml`: not listed and not counted, here or in the check. The race report still shows them.");
    // nothing to compare: nothing is said about a baseline
    expect(check.summary).not.toContain("baseline");
    expect(check.text).toContain("`witness:overwrote-newer`");
    // a kind that is not named, on an operation that is: not left out
    const other = await review(seeds(T_CART, 2, [{ d: "duplicate", op: "POST /api/cart" }]), { settings });
    expect(other.merged.ignored).toBe(0);
    expect(other.state.findings).toHaveLength(1);
  });

  it("the guide's second example comment (docs/github-app/README.md) is what the renderer writes for such files: grouped, compared and with one left out", async () => {
    const guide = readFileSync(new URL("../../docs/github-app/README.md", import.meta.url), "utf8");
    const example = /<!-- example: known findings -->\n```markdown\n([\s\S]*?)\n```/.exec(guide)![1]!;
    const fixture = (n: string) => ({ name: n, content: raceFile(n) });
    // the cart test flags a failing endpoint and the witness the settings leave out; two projects reach the double submit
    const head = [...seeds(T_CART, 2, [FAILING, IN_FLIGHT]), ...seeds(T_CHECKOUT, 2, [DUPLICATE]), ...seeds(`[mobile] ${T_CHECKOUT}`, 2, [DUPLICATE]), fixture("search-1.json"), fixture("search-2.json")];
    const settings = withIgnore(rule("witness:identical-in-flight", "POST /api/cart"));
    // the default branch's files: the reporter's fixtures, a double submit and a stale response
    const base = { sha: `8c1d2e7${"0".repeat(33)}`, inputs: ["checkout-1.json", "checkout-2.json", "search-1.json", "search-2.json"].map(fixture) };
    const { m } = await review(head, { sha: `4f2a9c1${"0".repeat(33)}`, settings, base });
    const body = renderSummary(m)!;
    const shown = example.split("\n").filter((l) => l.trim());
    expect(shown.length).toBeGreaterThanOrEqual(10);
    for (const line of shown) expect(body, line).toContain(line);
    // and in that order, with nothing between the lines that the example leaves out
    expect(body).toContain(`${example}\n`);
  });

  it("a finding listed before the setting named it goes with its number, which is not given out again; without the entry it is a new finding", async () => {
    const inputs = [...seeds(T_CART, 2, [IN_FLIGHT]), ...seeds(T_CHECKOUT, 2, [DUPLICATE])];
    const first = await review(inputs);
    expect(first.state.findings.map((f) => [f.n, f.op])).toEqual([
      [1, "POST /api/cart"],
      [2, "POST /api/orders"],
    ]);
    const marked: PrState = { ...first.state, inline: first.state.findings.map((f) => f.fp) };
    const settings = withIgnore(rule("witness:identical-in-flight", "POST /api/cart"));
    // while the commit has no race files, what is stored stays as it is
    const waiting = await mergeFindings(marked, null, SHA_B, { ignore: settings.ignore });
    expect(waiting.state.findings).toEqual(marked.findings);
    expect(waiting.ignored).toBe(0);
    const second = await review(inputs, { prev: marked, settings });
    expect(second.state.findings.map((f) => [f.n, f.op])).toEqual([[2, "POST /api/orders"]]);
    expect(second.state.inline).toEqual([first.state.findings[1]!.fp]);
    expect(second.merged.ignored).toBe(1);
    expect(second.state.next).toBe(3);
    expect(rows(renderSummary(second.m)!)).toEqual(["| 2 | New | Duplicate submit · `POST /api/orders` | checkout.spec.ts > checkout > places one order | 2 of 2 seeds, **reproducible** |"]);
    // also when it is not flagged at this commit: a row the settings leave out is not kept to say "not flagged now"
    const absent = await review(seeds(T_CHECKOUT, 2, [DUPLICATE]), { prev: marked, settings, sha: SHA_B });
    expect(absent.state.findings.map((f) => f.n)).toEqual([2]);
    expect(absent.merged.ignored).toBe(0);
    // the entry is taken away again: flagged, it is a finding like any that is new, under a number of its own
    const third = await review(inputs, { prev: second.state, sha: SHA_B });
    expect(third.state.findings.map((f) => [f.n, f.op, f.status])).toEqual([
      [2, "POST /api/orders", "still"],
      [3, "POST /api/cart", "new"],
    ]);
  });
});

// --------------------------------------------------------------------------------------------- reading the default branch

type Fake = ReturnType<typeof fakeGithub>;
const minute = (m: number): string => `2026-10-13T11:${String(m).padStart(2, "0")}:00Z`;
const json = (j: unknown): Response => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });

/** The read of the default branch as a review makes it: an installation's client of its own on the fake GitHub. */
function baseline(gh: Fake, settings: RepoSettings = DEFAULT_SETTINGS, prefer: number[] = []) {
  const { env } = githubSetup();
  const client = installationClient(githubApp(env)!, gh.fetch, now, INSTALLATION, REPO.id, MAX_BASELINE_CALLS + 4);
  return { client, read: () => baselineEvidence(client, "/repos/acme/shop", { branch: "main", repoId: REPO.id }, settings, { prefer }) };
}
/** The runs whose artifacts were asked for, in the order they were asked. */
const asked = (gh: Fake): number[] =>
  gh
    .apiCalls()
    .map((c) => /^\/repos\/acme\/shop\/actions\/runs\/(\d+)\/artifacts$/.exec(c.path))
    .filter((x) => x !== null)
    .map((x) => Number(x[1]));
const OTHER = () => ({ "playwright-report": racesZip() });

describe("github app: the race files of the default branch (src/github/evidence.ts baselineEvidence)", () => {
  it("the most recent commit of the default branch that has race files is read, by the reader a pull request's files go through", async () => {
    const gh = fakeGithub();
    const old = gh.addBaseRun(BASE1, undefined, { created_at: minute(1) });
    const mid = gh.addBaseRun(BASE2, { "genclass-races": racesZip({ "s.json": raceFile("search-2.json") }) }, { created_at: minute(5) });
    // the newest commit: its runs uploaded no race files
    const lint = gh.addBaseRun(BASE3, OTHER(), { created_at: minute(9), name: "lint", workflow_id: 2 });
    const { read, client } = baseline(gh);
    const b = await read();
    expect(b.sha).toBe(BASE2);
    expect(b.incomplete).toBe(false);
    expect(b.ci!.inputs.map((i) => i.name)).toEqual(["genclass-races/s.json"]);
    expect(b.ci!.artifacts).toEqual([{ name: "genclass-races", runId: mid.id, files: 1 }]);
    // one list of the branch's finished runs, and no commit's runs are listed again. Runs are asked for their
    // artifacts from the most recent: the lint run has none with the name, the next run has, and its commit is read
    // (which asks that run once more, by the reader a pull request's files go through)
    const lists = gh.apiCalls().filter((c) => c.path === "/repos/acme/shop/actions/runs");
    expect(lists).toHaveLength(1);
    expect(Object.fromEntries(lists[0]!.query)).toEqual({ branch: "main", status: "completed", per_page: "100", exclude_pull_requests: "true" });
    expect(asked(gh)).toEqual([lint.id, mid.id, mid.id]);
    expect(asked(gh)).not.toContain(old.id);
    // the artifact came from storage without a credential, as a pull request's does
    expect(gh.storage).toHaveLength(1);
    expect(gh.storage[0]!.headers.authorization).toBeUndefined();
    expect(client.calls()).toBe(5);
    // what a review keeps of it to compare by: per fingerprint the tests that flag it, and the tests that ran
    const index = await baselineIndex(summaryOf(b.ci!.inputs, DEFAULT_SETTINGS));
    expect([...index.flagged].map(([fp, tests]) => [fp, [...tests]])).toEqual([[await fingerprint("delivery:stale", "GET /api/search"), ["search.spec.ts > search > shows the results of the last query"]]]);
    expect([...index.ran]).toEqual(["search.spec.ts > search > shows the results of the last query"]);
  });

  it("only the branch's own runs count: a pull request's run filed under its name, a fork's, a dispatched one and another branch's are not a baseline", async () => {
    const rows: Record<string, unknown>[] = [];
    const artifacts = new Map<number, string>();
    const add = (id: number, sha: string, at: number, over: Record<string, unknown> = {}) => {
      rows.push({ id, name: "e2e", head_sha: sha, status: "completed", conclusion: "success", workflow_id: 1, created_at: minute(at), updated_at: minute(at + 1), head_branch: "main", event: "push", head_repository: { id: REPO.id }, ...over });
      artifacts.set(id, sha);
    };
    // every one of these uploaded race files, and each is more recent than the branch's own run
    add(1, SHA1, 30, { event: "pull_request" });
    add(2, SHA2, 29, { event: "pull_request", head_repository: { id: 99001 } });
    add(3, SHA3, 28, { event: "pull_request_target" });
    add(4, SHA_A, 27, { event: "workflow_dispatch" });
    add(5, SHA_B, 26, { head_branch: "feature" });
    add(6, SHA_C, 25, { head_repository: { id: 99001 } });
    add(7, BASE3, 24, { status: "in_progress", conclusion: null });
    add(8, BASE2, 23, { head_sha: "not a commit" });
    // the branch's own: its schedule, and before that a push
    add(9, BASE1, 20, { event: "schedule" });
    add(10, BASE1, 10);
    // GitHub's filter is not taken at its word: the list holds them all, whatever was asked
    const gh = fakeGithub({ answer: (c) => (c.method === "GET" && c.path === "/repos/acme/shop/actions/runs" ? json({ total_count: rows.length, workflow_runs: rows }) : undefined) });
    gh.runs.set(
      REPO.full_name,
      rows.map((r) => ({ id: Number(r.id), head_sha: artifacts.get(Number(r.id))!, workflow_id: 1, artifacts: { "genclass-races": racesZip() } })),
    );
    const b = await baseline(gh).read();
    expect(b.sha).toBe(BASE1);
    // the most recent of them shows the artifact, and the commit is read: of two runs of one workflow on it, the one
    // that finished last, as for a pull request
    expect(asked(gh)).toEqual([9, 9, 10]);
    expect(b.ci!.artifacts).toEqual([{ name: "genclass-races", runId: 9, files: 4 }]);
    // with nothing but the others there is no baseline, and nothing of theirs is asked for
    const none = fakeGithub({ answer: (c) => (c.method === "GET" && c.path === "/repos/acme/shop/actions/runs" ? json({ workflow_runs: rows.slice(0, 8) }) : undefined) });
    expect(await baseline(none).read()).toEqual({ sha: null, ci: null, incomplete: false });
    expect(asked(none)).toEqual([]);
    expect(await baseline(fakeGithub()).read()).toEqual({ sha: null, ci: null, incomplete: false });
  });

  it("race files that cannot be read are not a commit without race files: an older commit stands in, and the read is not whole", async () => {
    const gh = fakeGithub();
    gh.addBaseRun(BASE1, undefined, { created_at: minute(1) });
    gh.addBaseRun(BASE2, undefined, { created_at: minute(5), expired: ["genclass-races"] });
    const b = await baseline(gh).read();
    expect(b.sha).toBe(BASE1);
    expect(b.incomplete).toBe(true);
    // files that are not race files are not a baseline either
    const junk = fakeGithub();
    junk.addBaseRun(BASE2, { "genclass-races": racesZip({ "results.json": '{"suites":[]}' }) }, { created_at: minute(5) });
    expect(await baseline(junk).read()).toMatchObject({ sha: null, ci: null });
    // the `artifact` setting names the artifacts here as it does for a pull request
    const named = fakeGithub();
    named.addBaseRun(BASE1, { "races-main": racesZip() }, { created_at: minute(1) });
    expect((await baseline(named).read()).sha).toBeNull();
    expect((await baseline(named, { ...DEFAULT_SETTINGS, artifact: "races" }).read()).sha).toBe(BASE1);
  });

  it("the looking follows workflows, not commits: docs-only merges on top do not hide the commit that has race files", async () => {
    // as on genclass-dev/GenClass the day this was written: the four most recent commits ran CI and nothing else
    // (the end-to-end workflow has path filters), and the race files are on the fifth
    const shape = () => {
      const gh = fakeGithub();
      const older = gh.addBaseRun("9".repeat(40), undefined, { created_at: minute(1), workflow_id: 2, name: "e2e" });
      const ciE = gh.addBaseRun(BASE1, OTHER(), { created_at: minute(10), updated_at: minute(11), workflow_id: 1, name: "CI" });
      const e2e = gh.addBaseRun(BASE1, undefined, { created_at: minute(10), updated_at: minute(13), workflow_id: 2, name: "e2e" });
      const ci = [4, 3, 2, 1].map((i) => gh.addBaseRun(`${i}`.repeat(40), OTHER(), { created_at: minute(20 + i), workflow_id: 1, name: "CI" }));
      return { gh, older, ciE, e2e, ci };
    };
    const a = shape();
    const first = baseline(a.gh);
    expect(await first.read()).toMatchObject({ sha: BASE1, incomplete: false });
    // CI's two most recent runs show no race files, and CI is passed over from there on: the end-to-end run is next
    expect(asked(a.gh).slice(0, 3)).toEqual([a.ci[0]!.id, a.ci[1]!.id, a.e2e.id]);
    expect(asked(a.gh)).not.toContain(a.ci[2]!.id);
    expect(asked(a.gh)).not.toContain(a.ci[3]!.id);
    expect(asked(a.gh)).not.toContain(a.older.id);
    expect(first.client.calls()).toBeLessThanOrEqual(8);
    // told which workflow uploaded the pull request's own race files, it asks that workflow's most recent run first
    const b = shape();
    const hinted = baseline(b.gh, DEFAULT_SETTINGS, [2]);
    expect(await hinted.read()).toMatchObject({ sha: BASE1, incomplete: false });
    expect(asked(b.gh)).toEqual([b.e2e.id, b.e2e.id, b.ciE.id]);
    // the list, the run that names the commit, that commit's two runs, one download
    expect(hinted.client.calls()).toBe(5);
    // a workflow that is not on the default branch at all changes nothing
    const c = shape();
    expect(await baseline(c.gh, DEFAULT_SETTINGS, [77]).read()).toMatchObject({ sha: BASE1 });
  });

  it("a workflow is passed over after two runs without race files; at most ten runs are asked, and the whole costs at most twenty requests", async () => {
    // one workflow, six commits, and only the oldest run uploaded race files: after two misses it is not asked again
    const quiet = fakeGithub();
    for (let i = 0; i < 6; i++) quiet.addBaseRun(`${i}`.repeat(40), i === 0 ? undefined : OTHER(), { created_at: minute(i) });
    expect(await baseline(quiet).read()).toEqual({ sha: null, ci: null, incomplete: false });
    expect(asked(quiet)).toHaveLength(BASELINE_WORKFLOW_MISSES);
    // thirty workflows, none with race files, then one that has them: the looking stops at its limit and says so
    const busy = fakeGithub();
    for (let w = 1; w <= 30; w++) busy.addBaseRun(BASE2, OTHER(), { created_at: minute(40 - w), workflow_id: w, name: `w${w}` });
    busy.addBaseRun(BASE1, undefined, { created_at: minute(1), workflow_id: 99 });
    const { read, client } = baseline(busy);
    expect(await read()).toEqual({ sha: null, ci: null, incomplete: true });
    expect(asked(busy)).toHaveLength(MAX_BASELINE_PROBES);
    expect(client.calls()).toBe(1 + MAX_BASELINE_PROBES);
    // a commit with more runs than there are requests left for: what can be asked is, and the cap holds
    const wide = fakeGithub();
    for (let w = 1; w <= 25; w++) wide.addBaseRun(BASE1, w === 1 ? { "genclass-races": racesZip() } : OTHER(), { created_at: minute(9), updated_at: minute(40 - w), workflow_id: w, name: `w${w}` });
    const all = baseline(wide, DEFAULT_SETTINGS, [1]);
    const found = await all.read();
    expect(found.sha).toBe(BASE1);
    expect(all.client.calls()).toBeLessThanOrEqual(MAX_BASELINE_CALLS);
    // not every run of the commit could be asked, so race files may have gone unread
    expect(found.incomplete).toBe(true);
    // runs in which no job ran are not asked while the commit is looked for
    const skipped = fakeGithub();
    skipped.addBaseRun(BASE2, undefined, { created_at: minute(9), conclusion: "skipped" });
    const real = skipped.addBaseRun(BASE1, undefined, { created_at: minute(1) });
    expect((await baseline(skipped).read()).sha).toBe(BASE1);
    expect(asked(skipped)).toEqual([real.id, real.id]);
  });
});

// --------------------------------------------------------------------------------------------- through the webhook

type Setup = ReturnType<typeof githubSetup> & { gh: Fake };

/** The app installed on the repository, with this settings file on its default branch. */
async function installed(settings?: string, gh: Fake = fakeGithub()): Promise<Setup> {
  const s = githubSetup();
  if (settings !== undefined) gh.settings.set(REPO.full_name, settings);
  await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
  return { ...s, gh };
}

/** The end of a commit's test run, delivered: the word its review ended with. */
const finished = async (s: Setup, runId: number, sha: string, fetch = s.gh.fetch): Promise<string> => result(await deliver(s.env, "workflow_run", runEvent(runId, sha), { fetch }));

/**
 * A commit of pull request `number` whose test run uploaded these race files (default: the reporter's fixtures, a
 * double submit seen in both seeds and a stale response seen in one), and the word its review ended with.
 */
async function pushed(s: Setup, number: number, sha: string, files?: Record<string, string>, action = "opened"): Promise<string> {
  await pullRequest(s.env, s.gh, action, number, sha);
  const run = s.gh.addRun(sha, { "genclass-races": racesZip(files) });
  return finished(s, run.id, sha);
}

async function merge(s: Setup, number: number, sha: string): Promise<string> {
  const e = pullEvent("closed", number, sha, { state: "closed", merged: true });
  s.gh.pulls.set(`${REPO.full_name}#${number}`, e.pull_request);
  return result(await deliver(s.env, "pull_request", e, { fetch: s.gh.fetch }));
}

const stateOf = (s: Setup, number = 12) => parseState(String(s.sql.rows("SELECT state FROM github_prs WHERE number = ?", number)[0]!.state));
const lastRun = (s: Setup, sha: string) => s.gh.runs.get(REPO.full_name)!.filter((r) => r.head_sha === sha).at(-1)!;
/** How often the default branch's runs were listed. */
const baseLists = (gh: Fake): number => gh.calls.filter((c) => c.method === "GET" && c.path === "/repos/acme/shop/actions/runs" && c.query.get("branch") === "main").length;
const summaries = (s: Setup, number = 12): string[] => s.gh.posted(number).filter((b) => b.startsWith("<!-- genclass-bot:summary -->"));
const located = (file: string) => ({ location: { file, line: 12 } });
/** The fixtures' two findings with the tests' lines, and a failing endpoint in the cart test, seen in both seeds. */
const WITH_CART = (): Record<string, string> => ({
  "checkout-1.json": races(T_CHECKOUT, 1, [{ diagnosis: "duplicate", op: "POST /api/orders" }], located("tests/checkout.spec.ts")),
  "checkout-2.json": races(T_CHECKOUT, 2, [{ diagnosis: "duplicate", op: "POST /api/orders" }], located("tests/checkout.spec.ts")),
  "search-1.json": raceFile("search-1.json"),
  "search-2.json": raceFile("search-2.json"),
  "cart-1.json": races(T_CART, 1, [{ diagnosis: "failing", op: "GET /api/cart", trigger: "failure" }], located("tests/cart.spec.ts")),
  "cart-2.json": races(T_CART, 2, [{ diagnosis: "failing", op: "GET /api/cart", trigger: "failure" }], located("tests/cart.spec.ts")),
});
const NO_BASELINE = "No baseline was read: no workflow run on the default branch has race files this review can read, so a finding that is already there is listed like any other.";

describe("github app: reviews against the default branch's race files (src/github/handlers.ts header)", () => {
  it("findings that are all on the default branch: the check lists them and no comment is started; a finding of the pull request's own brings the comment, and the inline comment", async () => {
    const s = await installed();
    const base = s.gh.addBaseRun(BASE1);
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    expect(s.gh.posted(12)).toEqual([]);
    const [check] = s.gh.checksAt(SHA1);
    expect(check).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(check.output.title).toBe("2 findings, 1 reproducible, 2 already on the default branch");
    expect(check.output.summary).toContain("**2 findings** in this pull request's tests at `1111111` · 1 reproducible · 2 already on the default branch · 2 tests read");
    expect(check.output.summary).toContain("| 1 | Already on the default branch | Duplicate submit · `POST /api/orders` |");
    expect(check.output.summary).toContain("All 2 findings are already on the default branch: its race files at `ddddddd` flag the same kind and operation. They are not counted as new and get no inline comment.");
    // what it cost: the branch's finished runs listed once, one run's artifacts (asked once to find the commit and
    // once to read it), one download without a credential
    expect(baseLists(s.gh)).toBe(1);
    expect(s.gh.calls.filter((c) => c.path === `/repos/acme/shop/actions/runs/${base.id}/artifacts`)).toHaveLength(2);
    expect(s.gh.storage).toHaveLength(2);
    expect(s.gh.storage.every((x) => x.headers.authorization === undefined)).toBe(true);
    // every one of those calls carried a token minted for this repository, and only one token was minted
    expect(s.gh.apiCalls().every((c) => s.gh.tokens.has(c.auth.replace("Bearer ", "")))).toBe(true);
    expect(s.gh.calls.filter((c) => c.path.includes("/access_tokens"))).toHaveLength(1);
    // nothing is written about the default branch, and of its files the row keeps the commit and a mark per finding
    expect(s.gh.checksAt(BASE1)).toEqual([]);
    expect(stateOf(s)).toMatchObject({ v: 2, evidence: SHA1, base: BASE1 });
    expect(stateOf(s).findings.map((f) => [f.n, f.base])).toEqual([
      [1, true],
      [2, true],
    ]);

    // the next push: a failing endpoint of its own, on a test line the diff shows (as the checkout test's line is)
    s.gh.files.set(`${REPO.full_name}#12`, [
      { filename: "tests/cart.spec.ts", status: "modified", patch: "@@ -1,3 +1,40 @@\n x" },
      { filename: "tests/checkout.spec.ts", status: "modified", patch: "@@ -1,3 +1,40 @@\n x" },
    ]);
    expect(await pushed(s, 12, SHA2, WITH_CART(), "synchronize")).toBe("findings");
    const body = s.gh.summary(12)!;
    expect(body).toContain("**3 findings** in this pull request's tests at `2222222` · 2 reproducible · 1 new · 2 already on the default branch · 3 tests read");
    expect(rows(body)).toEqual([
      "| 3 | New | Failing endpoint · `GET /api/cart` | cart.spec.ts > cart > adds | 2 of 2 seeds, **reproducible** |",
      "| 1 | Already on the default branch | Duplicate submit · `POST /api/orders` | checkout.spec.ts > checkout > places one order | 2 of 2 seeds, **reproducible** |",
      "| 2 | Already on the default branch | Stale response · `GET /api/search` | search.spec.ts > search > shows the results of the last query | 1 of 2 seeds |",
    ]);
    expect(body).toContain("2 of the 3 findings are already on the default branch: its race files at `ddddddd` flag the same kind and operation.");
    expect(body).toContain("read 6 race files from the artifact `genclass-races` of this pull request's workflow run, and 4 race files of the default branch at `ddddddd`, never your source code.");
    expect(summaries(s)).toHaveLength(1);
    // one inline comment: on the cart test, not on the checkout test, whose finding the default branch has too
    expect(s.gh.reviews).toHaveLength(1);
    expect(s.gh.reviews[0]!.body.comments.map((c: { path: string }) => c.path)).toEqual(["tests/cart.spec.ts"]);
    // both reviews were within two minutes: the default branch was asked about once
    expect(baseLists(s.gh)).toBe(1);
    expect(s.gh.checksAt(SHA2).at(-1).output.title).toBe("3 findings, 2 reproducible, 2 already on the default branch");
  });

  it("the default branch's race files are looked for in the workflow that uploaded the pull request's own, whatever ran on top since", async () => {
    const s = await installed("comment: always\n");
    // the default branch: the end-to-end workflow (2) last ran five commits ago; four docs-only merges ran CI (1) since
    const e2e = s.gh.addBaseRun(BASE1, undefined, { created_at: "2026-10-13T10:00:00Z", workflow_id: 2, name: "e2e" });
    const ci = [1, 2, 3, 4].map((i) => s.gh.addBaseRun(`${i}`.repeat(39) + "f", { "playwright-report": racesZip() }, { created_at: `2026-10-13T10:0${i}:00Z`, workflow_id: 1, name: "CI" }));
    // the pull request's race files come from that same workflow
    await pullRequest(s.env, s.gh, "opened", 12, SHA1);
    const run = s.gh.addRun(SHA1, { "genclass-races": racesZip() }, { workflow_id: 2, name: "e2e" });
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(rows(s.gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["Already on the default branch", "Already on the default branch"]);
    expect(s.gh.summary(12)).toContain("its race files at `ddddddd` flag the same kind and operation");
    // no run of CI was asked for its artifacts: the end-to-end run was asked first, and it names the commit
    const askedOf = (id: number) => s.gh.calls.filter((c) => c.path === `/repos/acme/shop/actions/runs/${id}/artifacts`).length;
    expect(ci.map((r) => askedOf(r.id))).toEqual([0, 0, 0, 0]);
    expect(askedOf(e2e.id)).toBe(2);
  });

  it("`comment: always` lists them in a comment; `baseline: false` reads nothing of the default branch and says nothing of it", async () => {
    const always = await installed("comment: always\n");
    always.gh.addBaseRun(BASE1);
    expect(await pushed(always, 12, SHA1)).toBe("findings");
    expect(always.gh.summary(12)).toContain("| 1 | Already on the default branch | Duplicate submit · `POST /api/orders` |");
    const off = await installed("baseline: false\n");
    off.gh.addBaseRun(BASE1);
    expect(await pushed(off, 12, SHA1)).toBe("findings");
    expect(baseLists(off.gh)).toBe(0);
    expect(off.gh.storage).toHaveLength(1);
    expect(off.gh.summary(12)).toContain("| 1 | New | Duplicate submit · `POST /api/orders` |");
    expect(off.gh.summary(12)).not.toMatch(/baseline|default branch/i);
    expect(off.gh.checksAt(SHA1)[0].output.title).toBe("2 findings, 1 reproducible");
    expect(stateOf(off).base).toBeNull();

    // turned off after a comparison was made: at the next review no finding keeps its mark
    expect(rows(always.gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["Already on the default branch", "Already on the default branch"]);
    always.gh.settings.set(REPO.full_name, "comment: always\nbaseline: false\n");
    advance(121_000);
    expect(await finished(always, lastRun(always, SHA1).id, SHA1)).toBe("findings");
    expect(rows(always.gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["New", "New"]);
    expect(always.gh.summary(12)).not.toMatch(/baseline|default branch/i);
    expect(stateOf(always)).toMatchObject({ base: null });
    expect(stateOf(always).findings.every((f) => !f.base)).toBe(true);
  });

  it("a commit that waits for its test run shows the findings as they were compared, and says which commit that was with", async () => {
    const s = await installed("comment: always\n");
    s.gh.addBaseRun(BASE1);
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    // the next push, before its workflow runs exist: nothing is read of either branch
    const lists = baseLists(s.gh);
    expect(await result(await pullRequest(s.env, s.gh, "synchronize", 12, SHA2))).toBe("no race files");
    expect(baseLists(s.gh)).toBe(lists);
    const body = s.gh.summary(12)!;
    expect(body).toContain("No race files for `2222222`.");
    expect(rows(body).map((l) => l.split(" | ")[1])).toEqual(["Already on the default branch", "Already on the default branch"]);
    expect(body).toContain("The default branch's race files were not read this time: what was compared with them at `ddddddd` stands, and a finding first flagged since then is listed like any other.");
  });

  it("a pause set while the default branch's race files are read holds: that pass writes nothing more", async () => {
    let pause: (() => Promise<void>) | null = null;
    const gh = fakeGithub({
      answer: (c) => {
        if (pause && c.method === "GET" && c.query.get("branch") === "main") void pause();
        return undefined;
      },
    });
    const s = await installed("comment: always\n", gh);
    gh.addBaseRun(BASE1);
    await pullRequest(s.env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    // someone pauses the pull request while GitHub answers the list of the default branch's runs
    pause = async () => {
      pause = null;
      await savePr(s.env.DB!, REPO.id, 12, { paused: true }, now());
    };
    const before = gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("/access_tokens")).length;
    expect(await finished(s, run.id, SHA1)).toBe("paused on this pull request");
    expect(baseLists(gh)).toBe(1);
    expect(gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("/access_tokens"))).toHaveLength(before);
    expect(gh.posted(12)).toEqual([]);
    expect(stateOf(s).findings).toEqual([]);
  });

  it("no race files for the default branch: a review is what it was, and its comment and check say that no baseline was read; a pull request cannot supply one", async () => {
    const s = await installed();
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    const body = s.gh.summary(12)!;
    expect(body).toContain(`${NO_BASELINE}\n`);
    expect(rows(body).map((l) => l.split(" | ")[1])).toEqual(["New", "New"]);
    expect(body).toContain("**2 findings** in this pull request's tests at `1111111` · 1 reproducible · 2 tests read");
    expect(s.gh.checksAt(SHA1)[0].output.title).toBe("2 findings, 1 reproducible");
    expect(s.gh.checksAt(SHA1)[0].output.summary).toContain(NO_BASELINE);
    expect(baseLists(s.gh)).toBe(1);
    expect(stateOf(s).base).toBeNull();
    // Runs GitHub files under the branch's name that are not the branch's own: a pull request from a branch called
    // main (of this repository, and of a fork) and a dispatched run. Each uploaded race files with the same findings.
    s.gh.addBaseRun(BASE1, undefined, { event: "pull_request" });
    s.gh.addBaseRun(BASE2, undefined, { event: "pull_request", head_repository_id: 99001 });
    s.gh.addBaseRun(BASE3, undefined, { event: "workflow_dispatch" });
    advance(121_000);
    expect(await pushed(s, 12, SHA2, undefined, "synchronize")).toBe("findings");
    expect(baseLists(s.gh)).toBe(2);
    expect(s.gh.summary(12)).toContain(NO_BASELINE);
    expect(rows(s.gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["Still flagged", "Still flagged"]);
    // none of their artifacts was asked for
    expect(s.gh.storage).toHaveLength(2);
  });

  it("`check.fail_on`: a finding the default branch has too does not fail the pull request's check; one of its own does; `check.fail_on_baseline` makes both count", async () => {
    const s = await installed("check:\n  fail_on: reproducible\n");
    s.gh.addBaseRun(BASE1);
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    expect(s.gh.checksAt(SHA1).at(-1)).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(s.gh.checksAt(SHA1).at(-1).output.title).toBe("2 findings, 1 reproducible, 2 already on the default branch");
    expect(s.gh.checksAt(SHA1).at(-1).output.summary).toContain("They do not fail the check; `check.fail_on_baseline: true` makes them count.");
    expect(await pushed(s, 12, SHA2, WITH_CART(), "synchronize")).toBe("findings");
    expect(s.gh.checksAt(SHA2).at(-1)).toMatchObject({ status: "completed", conclusion: "failure" });

    const strict = await installed("check:\n  fail_on: reproducible\n  fail_on_baseline: true\n");
    strict.gh.addBaseRun(BASE1);
    expect(await pushed(strict, 12, SHA1)).toBe("findings");
    expect(strict.gh.checksAt(SHA1).at(-1)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(strict.gh.checksAt(SHA1).at(-1).output.summary).toContain("They count for `check.fail_on`, as `check.fail_on_baseline` asks.");
  });

  it("a known race that reaches a test that was clean on the default branch fails the check and gets the comment, as the pull request's own", async () => {
    const s = await installed("check:\n  fail_on: reproducible\n");
    const order = (test: string, seed: number, flagged: boolean) => races(test, seed, flagged ? [{ diagnosis: "duplicate", op: "POST /api/orders" }] : []);
    const DOUBLE = "checkout.spec.ts > checkout > double click";
    // the default branch: the double-click test shows the double submit, the plain checkout test runs without it
    s.gh.addBaseRun(BASE1, { "genclass-races": racesZip({ "d1.json": order(DOUBLE, 1, true), "d2.json": order(DOUBLE, 2, true), "p1.json": order(T_CHECKOUT, 1, false), "p2.json": order(T_CHECKOUT, 2, false) }) });
    // a pull request that leaves both as they are: neutral, no comment
    expect(await pushed(s, 12, SHA1, { "d1.json": order(DOUBLE, 1, true), "d2.json": order(DOUBLE, 2, true), "p1.json": order(T_CHECKOUT, 1, false), "p2.json": order(T_CHECKOUT, 2, false) })).toBe("findings");
    expect(s.gh.checksAt(SHA1).at(-1)).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(s.gh.posted(12)).toEqual([]);
    // a pull request after which the plain checkout test double-submits too, in both seeds
    expect(await pushed(s, 13, SHA2, { "d1.json": order(DOUBLE, 1, true), "d2.json": order(DOUBLE, 2, true), "p1.json": order(T_CHECKOUT, 1, true), "p2.json": order(T_CHECKOUT, 2, true) })).toBe("findings");
    const check = s.gh.checksAt(SHA2).at(-1);
    expect(check).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(check.output.title).toBe("1 finding, 1 reproducible");
    const body = s.gh.summary(13)!;
    expect(rows(body)).toEqual(["| 1 | New | Duplicate submit · `POST /api/orders` | 2 tests: checkout.spec.ts > checkout > double click; checkout.spec.ts > checkout > places one order | 2 of 2 seeds in the first, **reproducible** |"]);
    expect(body).toContain("Finding 1 is flagged there too, but here also in checkout.spec.ts > checkout > places one order, a test that ran there without it: it is listed as this pull request's.");
    expect(stateOf(s, 13).findings.map((f) => f.base)).toEqual([false]);
  });

  it("the default branch is asked about once for the reviews of two minutes, again after that, and at once when one of its runs ends; a comparison stands when its files can no longer be read", async () => {
    const s = await installed("comment: always\n");
    const base = s.gh.addBaseRun(BASE1);
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    const run = lastRun(s, SHA1);
    expect(baseLists(s.gh)).toBe(1);
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(baseLists(s.gh)).toBe(1);
    advance(121_000);
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(baseLists(s.gh)).toBe(2);
    // a run of the default branch ends: what was kept may be a commit behind, and is dropped
    expect(await result(await deliver(s.env, "workflow_run", runEvent(base.id, BASE1, { head_branch: "main", event: "push" }), { fetch: s.gh.fetch }))).toBe("no pull request at this commit");
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(baseLists(s.gh)).toBe(3);
    // the same comparison every time: the comment was written once and not edited
    expect(s.gh.calls.filter((c) => c.method === "PATCH" && c.path.includes("/issues/comments/"))).toEqual([]);

    // the artifact's retention runs out. The next push cannot be compared, and what was compared stands
    base.expired = ["genclass-races"];
    advance(121_000);
    expect(await pushed(s, 12, SHA2, WITH_CART(), "synchronize")).toBe("findings");
    const body = s.gh.summary(12)!;
    expect(rows(body).map((l) => l.split(" | ").slice(0, 2).join(" | "))).toEqual(["| 3 | New", "| 1 | Already on the default branch", "| 2 | Already on the default branch"]);
    expect(body).toContain("The default branch's race files were not read this time: what was compared with them at `ddddddd` stands, and a finding first flagged since then is listed like any other.");
    expect(body).not.toContain("race files of the default branch at");
    expect(stateOf(s).base).toBe(BASE1);
  });

  it("little of the job's time left: the default branch is not asked, the review is written all the same, and the next review compares", async () => {
    let slow = 0;
    const gh = fakeGithub({
      answer: () => {
        if (slow) advance(slow);
        return undefined;
      },
    });
    const s = await installed("comment: always\n", gh);
    gh.addBaseRun(BASE1);
    await pullRequest(s.env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    // GitHub takes two and a half seconds an answer: five answers into the review, 7.5 of the job's 20 seconds are left
    slow = 2_500;
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    slow = 0;
    expect(baseLists(gh)).toBe(0);
    const body = gh.summary(12)!;
    expect(body).toContain("No baseline was read: the default branch's race files could not be read this time, so a finding that is already there is listed like any other.");
    expect(rows(body).map((l) => l.split(" | ")[1])).toEqual(["New", "New"]);
    expect(gh.checksAt(SHA1).at(-1).output.title).toBe("2 findings, 1 reproducible");
    // nothing was kept of a read that did not happen: the next review asks, and the comment follows
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(baseLists(gh)).toBe(1);
    expect(rows(gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["Already on the default branch", "Already on the default branch"]);
    expect(summaries(s)).toHaveLength(1);
  });

  it("time runs out while the default branch is read: what was read until then is dropped, not used in part or kept, and the review is written", async () => {
    let lists = 0;
    const gh = fakeGithub({
      answer: (c) => {
        // the list of the branch's runs takes 15 seconds: 5 of the job's 20 are left for the review's own writes
        if (c.method === "GET" && c.query.get("branch") === "main" && lists++ === 0) advance(15_000);
        return undefined;
      },
    });
    const s = await installed("comment: always\n", gh);
    const base = gh.addBaseRun(BASE1);
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    // the runs were listed, and no artifact of theirs was asked for after it
    expect(baseLists(gh)).toBe(1);
    expect(gh.calls.filter((c) => c.path === `/repos/acme/shop/actions/runs/${base.id}/artifacts`)).toEqual([]);
    expect(gh.summary(12)).toContain("No baseline was read: the default branch's race files could not be read this time");
    expect(stateOf(s).base).toBeNull();
    // not kept as "there is none": the next review reads it
    expect(await finished(s, lastRun(s, SHA1).id, SHA1)).toBe("findings");
    expect(baseLists(gh)).toBe(2);
    expect(stateOf(s).base).toBe(BASE1);
  });

  it("GitHub cannot say what the default branch has: the review is written without the comparison and says so, nothing is kept of the failure, and a rate limit still ends the pass", async () => {
    const NOT_THIS_TIME = "No baseline was read: the default branch's race files could not be read this time, so a finding that is already there is listed like any other.";
    let answer: (() => Response) | null = () => new Response(JSON.stringify({ message: "x" }), { status: 502 });
    const gh = fakeGithub({ answer: (c) => (answer !== null && c.method === "GET" && c.query.get("branch") === "main" ? answer() : undefined) });
    const s = await installed("comment: always\n", gh);
    gh.addBaseRun(BASE1);
    await pullRequest(s.env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    // 5xx for the list of the default branch's runs (asked twice, as the client asks any read): a review all the same
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(baseLists(gh)).toBe(2);
    expect(gh.summary(12)).toContain(NOT_THIS_TIME);
    expect(rows(gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["New", "New"]);
    expect(s.sql.rows("SELECT lease, due FROM github_prs")).toEqual([{ lease: null, due: null }]);
    // not kept as an answer: GitHub is well again, and the next review compares at once
    answer = null;
    expect(await finished(s, run.id, SHA1)).toBe("findings");
    expect(baseLists(gh)).toBe(3);
    expect(rows(gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["Already on the default branch", "Already on the default branch"]);

    // GitHub's own no (Actions is turned off for the repository, say) is an answer: there is no baseline, for two minutes
    const off = fakeGithub({ answer: (c) => (c.method === "GET" && c.query.get("branch") === "main" ? new Response(JSON.stringify({ message: "x" }), { status: 403 }) : undefined) });
    const t = await installed("comment: always\n", off);
    expect(await pushed(t, 12, SHA1)).toBe("findings");
    expect(off.summary(12)).toContain(NO_BASELINE);
    expect(await finished(t, lastRun(t, SHA1).id, SHA1)).toBe("findings");
    expect(baseLists(off)).toBe(1);

    // a rate limit is the installation's: the review's own next request would be refused too, so the pass ends
    let limited = true;
    const busy = fakeGithub({
      answer: (c) => (limited && c.method === "GET" && c.query.get("branch") === "main" ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now().getTime() / 1000) + 600) } }) : undefined),
    });
    const u = await installed("comment: always\n", busy);
    busy.addBaseRun(BASE1);
    await pullRequest(u.env, busy, "opened", 12, SHA1);
    const limitedRun = busy.addRun(SHA1);
    expect(await finished(u, limitedRun.id, SHA1)).toBe("failed: rate_limited");
    expect(busy.posted(12)).toEqual([]);
    expect(u.sql.rows("SELECT lease, due IS NOT NULL AS due FROM github_prs")).toEqual([{ lease: null, due: 1 }]);
    limited = false;
  });

  it("a request for the default branch that hangs does not cost the review its result: it is not tried again, and the review is written", async () => {
    // the REST client gives a request ten seconds and tries a read once more: two such waits are the whole job
    for (const before of [0, 3_000, 5_000]) {
      let on = false;
      let first = true;
      let attempts = 0;
      const gh = fakeGithub({
        answer: (c) => {
          if (!on) return undefined;
          // the pull request's own read took `before` ms in all
          if (first) {
            first = false;
            advance(before);
          }
          if (c.method === "GET" && c.query.get("branch") === "main") {
            attempts++;
            advance(10_000);
            throw new Error("timeout");
          }
          return undefined;
        },
      });
      const s = await installed("comment: always\n", gh);
      gh.addBaseRun(BASE1);
      await pullRequest(s.env, gh, "opened", 12, SHA1);
      const run = gh.addRun(SHA1);
      on = true;
      expect(await finished(s, run.id, SHA1), String(before)).toBe("findings");
      on = false;
      expect(attempts, String(before)).toBe(1);
      expect(gh.checksAt(SHA1).at(-1).output.title, String(before)).toBe("2 findings, 1 reproducible");
      expect(gh.summary(12), String(before)).toContain("No baseline was read: the default branch's race files could not be read this time");
      expect(s.sql.rows("SELECT lease, due FROM github_prs"), String(before)).toEqual([{ lease: null, due: null }]);
      // nothing was kept of it: the next review asks again, and compares
      resetClock();
      expect(await finished(s, run.id, SHA1)).toBe("findings");
      expect(rows(gh.summary(12)!).map((l) => l.split(" | ")[1])).toEqual(["Already on the default branch", "Already on the default branch"]);
    }
  });
});

describe("github app: a pull request's row from before findings were grouped, through the webhook", () => {
  /** Pull request 180's race files: one witness, in one test under two Playwright projects. */
  const FILES = (): Record<string, string> => ({
    ...Object.fromEntries([1, 2].map((seed) => [`chromium-${seed}.json`, races(T_CHROMIUM, seed, [{ diagnosis: "overwrote-newer", op: "GET /api/search", trigger: "witness" }])])),
    ...Object.fromEntries([1, 2, 3, 4, 5].map((seed) => [`plain-${seed}.json`, races(T_SEARCH, seed, [{ diagnosis: "overwrote-newer", op: "GET /api/search", trigger: "witness" }])])),
  });

  it("the comment's two rows become one under the first number, the second number still works in a command, and the row is stored the new way", async () => {
    const s = await installed();
    expect(await pushed(s, 12, SHA1, FILES())).toBe("findings");
    // the row as the version before this one left it for these files: a finding per test, and a comment that lists two
    const old = [await v1Row(1, T_CHROMIUM, OVERWROTE), await v1Row(2, T_SEARCH, OVERWROTE, { seeds: [1, 2, 3, 4, 5], of: 5 })];
    await savePr(s.env.DB!, REPO.id, 12, { state: v1State(old, { evidence: SHA1, next: 3, checkHash: stateOf(s).checkHash, inline: [old[1]!.fp] }) }, now());
    expect(stateOf(s).v).toBe(1);

    // a command that names the second row, before any review by this version: it answers with the finding
    await deliver(s.env, "issue_comment", commentEvent(12, "@genclass-dev replay 2"), { fetch: s.gh.fetch });
    expect(s.gh.posted(12).at(-1)).toContain("**Replay, finding 1**: Witness, overwrote-newer on `GET /api/search`, in search.spec.ts > search > buggy page: results of the last query and 1 other test, flagged at `1111111`.");
    expect(s.gh.posted(12).at(-1)).toContain('`npx playwright test search.spec.ts -g "buggy page: results of the last query" --repeat-each 5`');
    // (a command reads the row; only a review writes it)
    expect(stateOf(s).v).toBe(1);

    // the commit's test run is read again
    expect(await finished(s, lastRun(s, SHA1).id, SHA1)).toBe("findings");
    const body = s.gh.summary(12)!;
    expect(rows(body)).toEqual([
      "| 1 | New | Witness, overwrote-newer · `GET /api/search` | 2 tests: search.spec.ts > search > buggy page: results of the last query; \\[chromium\\] search.spec.ts > search > buggy page: results of the last query | 5 of 5 seeds in the first, **reproducible** |",
    ]);
    expect(body).toContain("**1 finding** in this pull request's tests at `1111111` · 1 reproducible · 2 tests read");
    expect(body).toContain("Finding 1 was also listed as 2: rows with the same kind and operation are one finding now, and that number still names it in a command.");
    // the one comment, edited in place
    expect(summaries(s)).toHaveLength(1);
    const st = stateOf(s);
    expect(st).toMatchObject({ v: 2, next: 3, evidence: SHA1 });
    expect(st.findings.map((f) => [f.n, f.also, f.status, f.fp])).toEqual([[1, [2], "new", await fingerprint("witness:overwrote-newer", "GET /api/search")]]);
    expect(st.inline).toEqual([st.findings[0]!.fp]);

    // both numbers name the finding; a number that was never given names none
    for (const n of [1, 2]) {
      await deliver(s.env, "issue_comment", commentEvent(12, `@genclass-dev replay ${n}`), { fetch: s.gh.fetch });
      expect(s.gh.posted(12).at(-1), String(n)).toContain("**Replay, finding 1**:");
    }
    await deliver(s.env, "issue_comment", commentEvent(12, "@genclass-dev replay 3"), { fetch: s.gh.fetch });
    expect(s.gh.posted(12).at(-1)).toContain("There is no finding 3 on this pull request. Its findings are numbered 1:");
    // the next push adds a finding: it is number 3, not 2
    expect(await pushed(s, 12, SHA2, { ...FILES(), "cart.json": races(T_CART, 1, [{ diagnosis: "failing", op: "GET /api/cart", trigger: "failure" }]) }, "synchronize")).toBe("findings");
    expect(stateOf(s).findings.map((f) => [f.n, f.status])).toEqual([
      [1, "still"],
      [3, "new"],
    ]);
  });

  it("`issues: merge`: a finding that an issue from before the grouping lists is not filed again; one that has no issue is filed under its new fingerprint", async () => {
    const s = await installed("issues: merge\n");
    // an issue the app opened then, since closed: it lists the double submit under the fingerprint of its test and signature
    const then = await legacyFingerprint(T_CHECKOUT, "request|duplicate|POST /api/orders");
    s.gh.issues.push({ repo: REPO.full_name, number: 250, title: "Duplicate submit on POST /api/orders (GenClass, from #9)", body: `<!-- genclass-bot:issue -->\nPull request #9 was merged with 1 finding.\n\n<!-- genclass-bot:finding ${then} -->\n### Duplicate submit on \`POST /api/orders\`\n`, state: "closed" });
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    expect(await merge(s, 12, SHA1)).toBe("closed");
    expect(s.gh.issues).toHaveLength(1);

    const fresh = await installed("issues: merge\n");
    expect(await pushed(fresh, 12, SHA1)).toBe("findings");
    expect(await merge(fresh, 12, SHA1)).toBe("issue opened");
    expect(fresh.gh.issues).toHaveLength(1);
    expect(fresh.gh.issues[0]!.body).toContain(`<!-- genclass-bot:finding ${await fingerprint("request:duplicate", "POST /api/orders")} -->\n### Duplicate submit on \`POST /api/orders\``);
  });
});

describe("github app: `ignore` through the webhook (docs/github-app/README.md, \"Settings\")", () => {
  const SAID = (n: number) => `${n} finding${n === 1 ? "" : "s"} flagged at this commit ${n === 1 ? "is" : "are"} left out by \`ignore\` in \`.github/genclass.yml\`: not listed and not counted, here or in the check. The race report still shows ${n === 1 ? "it" : "them"}.`;

  it("a signature the default branch's settings leave out has no row and no number, and the comment and the check say that one was left out", async () => {
    const s = await installed("ignore:\n  - kind: request:duplicate\n    operation: POST /api/orders\n");
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    const body = s.gh.summary(12)!;
    expect(body).toContain("**1 finding** in this pull request's tests at `1111111` · 0 reproducible · 2 tests read");
    expect(rows(body)).toEqual(["| 1 | New | Stale response · `GET /api/search` | search.spec.ts > search > shows the results of the last query | 1 of 2 seeds |"]);
    expect(body).toContain(`${SAID(1)}\n`);
    expect(body.split("<details>")[0]).not.toContain("POST /api/orders");
    expect(body.split("<details>")[1]).toContain("`POST /api/orders` · `request:duplicate`");
    const check = s.gh.checksAt(SHA1).at(-1);
    expect(check.output.title).toBe("1 finding, 0 reproducible");
    expect(check.output.summary).toContain(SAID(1));
    expect(stateOf(s).findings.map((f) => [f.n, f.op])).toEqual([[1, "GET /api/search"]]);
    // a pull request cannot leave anything out for itself: the settings are the default branch's (no `ref` is ever sent)
    expect(s.gh.calls.filter((c) => c.path.endsWith("/contents/.github/genclass.yml")).every((c) => !c.query.has("ref"))).toBe(true);
  });

  it("everything flagged left out: a green check that says what it left out, no comment, nothing asked of the default branch, and no issue at the merge", async () => {
    const s = await installed(["ignore:", "  - kind: request:duplicate", "    operation: POST /api/orders", "  - kind: delivery:stale", '    operation: "GET /api/*"', "issues: merge", "check:", "  fail_on: any"].join("\n"));
    s.gh.addBaseRun(BASE1);
    expect(await pushed(s, 12, SHA1)).toBe("nothing flagged");
    const check = s.gh.checksAt(SHA1).at(-1);
    expect(check).toMatchObject({ status: "completed", conclusion: "success" });
    expect(check.output.title).toBe("Nothing flagged in 2 tests, besides 2 left out by the settings");
    expect(check.output.summary).toContain("**Nothing flagged** in 2 tests at `1111111`, besides 2 findings the settings leave out");
    expect(check.output.summary).toContain(SAID(2));
    expect(s.gh.posted(12)).toEqual([]);
    expect(baseLists(s.gh)).toBe(0);
    expect(stateOf(s).findings).toEqual([]);
    expect(await merge(s, 12, SHA1)).toBe("closed");
    expect(s.gh.issues).toEqual([]);
  });

  it("a finding that was listed before the setting named it leaves the comment at the next review, and the comment says what was left out", async () => {
    const s = await installed();
    expect(await pushed(s, 12, SHA1)).toBe("findings");
    expect(rows(s.gh.summary(12)!)).toHaveLength(2);
    // the setting is committed to the default branch; two minutes on, the app reads the file again
    s.gh.settings.set(REPO.full_name, "ignore:\n  - kind: request:duplicate\n    operation: POST /api/orders\n");
    advance(121_000);
    expect(await finished(s, lastRun(s, SHA1).id, SHA1)).toBe("findings");
    const body = s.gh.summary(12)!;
    expect(rows(body)).toEqual(["| 2 | New | Stale response · `GET /api/search` | search.spec.ts > search > shows the results of the last query | 1 of 2 seeds |"]);
    expect(body).toContain(SAID(1));
    expect(summaries(s)).toHaveLength(1);
    // its number is gone with it: a command that names it is told so
    await deliver(s.env, "issue_comment", commentEvent(12, "@genclass-dev replay 1"), { fetch: s.gh.fetch });
    expect(s.gh.posted(12).at(-1)).toContain("There is no finding 1 on this pull request. Its findings are numbered 2:");
  });
});
