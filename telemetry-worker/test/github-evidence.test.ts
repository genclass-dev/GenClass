// The evidence a review is built from (src/github/evidence.ts), against the fake GitHub: how much one review reads and
// keeps whatever a workflow uploaded, which workflow runs of a commit it asks for artifacts and in what order, which
// artifact it reads after a re-run, and that no address in a race file's text reaches GitHub as a link, through the
// renderers of src/github/review.ts (docs/github-app/README.md, "Limits" and "Security").
import { beforeEach, describe, expect, it } from "vitest";
import { buildSummary, renderMarkdown, ZERO_WIDTH_SPACE as Z } from "../../packages/playwright/src/summarize.js";
import { RACES_LIMITS, type RacesFileInput } from "../../packages/playwright/src/types.js";
import { installationClient } from "../src/github/api.js";
import { githubApp } from "../src/github/config.js";
import { ciEvidence, MAX_ARTIFACTS, MAX_ASKED_RUNS, MAX_EVIDENCE_CALLS, MAX_INFLATED_BYTES, MAX_LISTED_RUNS, MAX_RACE_FILE_BYTES, MAX_RACE_FILES, MAX_REVIEW_SIGNATURES } from "../src/github/evidence.js";
import { emptyState, inlineComments, mergeFindings, renderCheck, renderFixBrief, renderIssue, renderReplay, renderSummary, summaryOf, testLocations, type ReviewModel } from "../src/github/review.js";
import { DEFAULT_SETTINGS } from "../src/github/settings.js";
import { now, resetClock, type Fetch } from "./account-helpers.js";
import { deliver, fakeGithub, githubSetup, INSTALLATION, installationCreated, pullRequest, raceFile, RACES, races, racesZip, REPO, result, runEvent, SHA1, STORAGE } from "./github-helpers.js";
import { makeZip } from "./github-zip-helper.js";

beforeEach(() => {
  resetClock();
});

type Fake = ReturnType<typeof fakeGithub>;

/** The collector as a review calls it: an installation's client on the fake GitHub, for the pull request's head commit. */
function collector(fetch: Fetch, o?: { firstRun?: number }) {
  const { env } = githubSetup();
  const client = installationClient(githubApp(env)!, fetch, now, INSTALLATION, REPO.id);
  return { client, read: () => ciEvidence(client, "/repos/acme/shop", SHA1, DEFAULT_SETTINGS, o) };
}

/** The runs whose artifacts were asked for, in the order they were asked. */
const asked = (gh: Fake): number[] =>
  gh
    .apiCalls()
    .map((c) => /^\/repos\/acme\/shop\/actions\/runs\/(\d+)\/artifacts$/.exec(c.path))
    .filter((m) => m !== null)
    .map((m) => Number(m[1]));

/** What a review holds of the race files: the characters of every input's content. */
const held = (inputs: readonly RacesFileInput[]): number => inputs.reduce((n, i) => n + (typeof i.content === "string" ? i.content.length : 0), 0);
const read = (inputs: readonly RacesFileInput[]): RacesFileInput[] => inputs.filter((i) => i.error === undefined);

/** A race file of exactly `bytes` bytes that validates: one signature, and the rest is a field no review reads. */
function padded(bytes: number, seed: number): string {
  const file = (pad: number) => races("t.spec.ts > t", seed, [{ diagnosis: "duplicate", op: "POST /a" }], { shadow: "s".repeat(pad) });
  return file(bytes - file(0).length);
}

const json = (j: unknown): Response => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
const minute = (m: number): string => `2026-10-13T11:${String(m).padStart(2, "0")}:00Z`;

/** A workflow run as GitHub lists it, with what the plain fake leaves out: when it ended, and how. */
function listedRun(id: number, workflow: number, ended: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `workflow ${workflow}`, head_sha: SHA1, status: "completed", conclusion: "success", html_url: `https://github.com/acme/shop/actions/runs/${id}`, workflow_id: workflow, created_at: minute(0), updated_at: minute(ended), ...over };
}

/**
 * A fake GitHub that lists the commit's runs as given. The runs themselves are the plain fake's, so their artifacts
 * are listed and downloaded as usual (`artifacts`: by run id; a run not named has none).
 */
function githubListing(rows: Record<string, unknown>[], artifacts: Record<number, Record<string, Uint8Array>> = {}, total = rows.length): Fake {
  const gh = fakeGithub({ answer: (c) => (c.method === "GET" && c.path === "/repos/acme/shop/actions/runs" ? json({ total_count: total, workflow_runs: rows }) : undefined) });
  gh.runs.set(
    REPO.full_name,
    rows.map((r) => ({ id: Number(r.id), head_sha: SHA1, artifacts: artifacts[Number(r.id)] ?? {} })),
  );
  return gh;
}

describe("github app: what one review reads and keeps (docs/github-app/README.md, \"Limits\")", () => {
  it("six artifacts of 32 files of 256 KB each: a file over 64 KB is not unzipped, and nothing of it is kept", async () => {
    const file = padded(256 * 1024, 1);
    expect(new TextEncoder().encode(file).length).toBe(256 * 1024);
    const zip = makeZip(Array.from({ length: 32 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.json`, data: file })));
    // 8 MB of race files in an archive of a few tens of KB: the download caps do not see it
    expect(zip.length).toBeLessThan(100_000);
    const gh = fakeGithub();
    gh.addRun(SHA1, Object.fromEntries(Array.from({ length: MAX_ARTIFACTS }, (_, i) => [`genclass-${i + 1}`, zip])));
    const ci = await collector(gh.fetch).read();
    expect(MAX_RACE_FILE_BYTES).toBe(64 * 1024);
    expect(ci.artifacts.map((a) => a.files)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(ci.inputs).toHaveLength(6 * 32);
    expect(ci.inputs.every((i) => i.error === "not read: larger than 64 KB")).toBe(true);
    expect(held(ci.inputs)).toBe(0);
  });

  it("race files are read up to 4 MB for one review, however many artifacts they come in, and the rest are not downloaded", async () => {
    // 60,000 bytes each: 69 of them are 4.14 MB, and the 70th would pass 4 MB (4,194,304 bytes)
    const zip = (n: number) => makeZip(Array.from({ length: 32 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.json`, data: padded(60_000, n * 100 + i) })));
    const gh = fakeGithub();
    gh.addRun(SHA1, Object.fromEntries(Array.from({ length: MAX_ARTIFACTS }, (_, i) => [`genclass-${i + 1}`, zip(i)])));
    const ci = await collector(gh.fetch).read();
    expect(MAX_INFLATED_BYTES).toBe(4 * 1024 * 1024);
    expect(read(ci.inputs)).toHaveLength(69);
    expect(ci.artifacts.map((a) => a.files)).toEqual([32, 32, 5]);
    // the files of the third artifact that did not fit are listed with why, once each, and one note says it for the review
    const unread = ci.inputs.filter((i) => i.error !== undefined);
    expect(unread).toHaveLength(27);
    expect(unread.every((i) => i.error === "not read: over 4 MB of race files in one review")).toBe(true);
    expect(ci.notes).toEqual(["Race files are read up to 4 MB for one review, unzipped; the rest were not read."]);
    // the other three artifacts were not asked for at all
    expect(gh.storage).toHaveLength(3);
    // what is held is what a review uses: a few hundred characters a file, not the 60,000 it came as
    expect(held(ci.inputs)).toBeLessThan(69 * 400);
    for (const i of read(ci.inputs)) expect(JSON.parse(String(i.content))).toMatchObject({ schema: "genclass-races/1", test: "t.spec.ts > t", signatures: [{ diagnosis: "duplicate", op: "POST /a" }] });
    expect(read(ci.inputs).some((i) => String(i.content).includes("shadow"))).toBe(false);
  });

  it("a file the zip reader starts on and does not keep counts too: lying sizes cannot buy more than the review's 4 MB", async () => {
    // each entry claims 60,000 bytes and holds one more: it is unzipped up to its claim, dropped, and counted
    const lying = makeZip(Array.from({ length: 32 }, (_, i) => ({ name: `f${i}.json`, data: "x".repeat(60_001), declaredSize: 60_000 })));
    const gh = fakeGithub();
    gh.addRun(SHA1, Object.fromEntries(Array.from({ length: MAX_ARTIFACTS }, (_, i) => [`genclass-${i + 1}`, lying])));
    const ci = await collector(gh.fetch).read();
    expect(ci.inputs.filter((i) => i.error === "not read: corrupt entry")).toHaveLength(69);
    expect(ci.inputs.filter((i) => i.error === "not read: over 4 MB of race files in one review")).toHaveLength(27);
    expect(ci.inputs).toHaveLength(96);
    expect(gh.storage).toHaveLength(3);
    expect(held(ci.inputs)).toBe(0);
  });

  it("at most 2000 signatures for one review: a file that would pass it is not read, one that fits still is", async () => {
    const full = (f: number) => races(`f${f}.spec.ts > t`, 1, Array.from({ length: RACES_LIMITS.signatures }, (_, i) => ({ diagnosis: "duplicate", op: `POST /api/${f}/${i}` })));
    const files: Record<string, string> = {};
    for (let f = 0; f < 12; f++) files[`f${String(f).padStart(2, "0")}.json`] = full(f);
    // after them in the archive: a file that flags nothing, and one with more signatures than a file may hold
    files["g-quiet.json"] = races("quiet.spec.ts > t", 1, []);
    files["h-over.json"] = races("over.spec.ts > t", 1, Array.from({ length: RACES_LIMITS.signatures + 1 }, (_, i) => ({ diagnosis: "duplicate", op: `POST /api/over/${i}` })));
    const gh = fakeGithub();
    gh.addRun(SHA1, { "genclass-races": racesZip(files) });
    const ci = await collector(gh.fetch).read();
    expect(MAX_REVIEW_SIGNATURES).toBe(2000);
    expect(ci.inputs.filter((i) => i.error !== undefined).map((i) => [i.name, i.error])).toEqual([
      ["genclass-races/f10.json", "not read: over 2000 signatures in one review"],
      ["genclass-races/f11.json", "not read: over 2000 signatures in one review"],
    ]);
    expect(ci.notes).toEqual(["Race files are read up to 2000 signatures for one review; 2 files over that were not read."]);
    const summary = buildSummary(ci.inputs);
    expect(summary.files).toBe(11);
    expect(summary.totals.signatures).toBe(2000);
    expect(summary.tests.some((t) => t.test === "quiet.spec.ts > t")).toBe(true);
    // the file over the format's own limit is listed with the validator's reason, its signatures never looked at
    expect(summary.skipped.find((s) => s.name === "genclass-races/h-over.json")?.errors).toEqual(["signatures: expected at most 200 signatures, got 201"]);
  });

  it("what is kept of a file that validates gives the same report as the file itself; one that does not validate is kept as it came", async () => {
    const chaos = { latencyMs: [0, 600], reorder: true, routes: ["r".repeat(5000)] };
    const files: Record<string, string> = Object.fromEntries(RACES.map((n) => [n, raceFile(n)]));
    files["cart.json"] = races("cart.spec.ts > cart > adds", 3, [{ diagnosis: "stale", op: "GET /api/cart", trigger: "delivery" }], { chaos, mode: "observe", model: { state: "ready" }, location: { file: "tests/cart.spec.ts", line: 9 } });
    files["package.json"] = '{"name":"not-a-race-file"}';
    const gh = fakeGithub();
    gh.addRun(SHA1, { "genclass-races": racesZip(files) });
    const ci = await collector(gh.fetch).read();
    expect(ci.state).toBe("ready");
    expect(ci.notes).toEqual([]);
    expect(ci.inputs.every((i) => i.error === undefined)).toBe(true);
    const asItCame = Object.entries(files).map(([name, content]) => ({ name: `genclass-races/${name}`, content }));
    expect(renderMarkdown(buildSummary(ci.inputs))).toBe(renderMarkdown(buildSummary(asItCame)));
    // the test's place in the repository is still there for the inline comments
    expect(testLocations(ci.inputs).get("cart.spec.ts > cart > adds")).toEqual({ file: "tests/cart.spec.ts", line: 9 });
    // without the fields that may hold anything and that no review reads
    const cart = JSON.parse(String(ci.inputs.find((i) => i.name.endsWith("/cart.json"))!.content));
    expect(cart.chaos).toEqual({ latencyMs: [0, 600], reorder: true });
    expect(ci.inputs.some((i) => String(i.content).includes('"shadow"'))).toBe(false);
    expect(held(ci.inputs)).toBeLessThan(Object.values(files).join("").length - 5000);
    expect(ci.inputs.find((i) => i.name.endsWith("/package.json"))!.content).toBe(files["package.json"]);
  });

  it("no more than 600 race files: the files over that are listed, the review says so, and nothing more is downloaded", async () => {
    const zip = (n: number) => makeZip(Array.from({ length: 250 }, (_, i) => ({ name: `f${String(i).padStart(3, "0")}.json`, data: races(`a${n}.spec.ts > t${i}`, 1, []) })));
    const gh = fakeGithub();
    gh.addRun(SHA1, { "genclass-1": zip(1), "genclass-2": zip(2), "genclass-3": zip(3), "genclass-4": zip(4) });
    const ci = await collector(gh.fetch).read();
    expect(read(ci.inputs)).toHaveLength(MAX_RACE_FILES);
    expect(ci.artifacts.map((a) => a.files)).toEqual([250, 250, 100]);
    expect(ci.inputs.filter((i) => i.error === "not read: over 600 race files in one review")).toHaveLength(150);
    expect(ci.notes).toEqual(["Only 600 race files are read for one review; the rest were not read."]);
    expect(gh.storage).toHaveLength(3);
  });

  it("six artifacts are read; a seventh in another of the commit's runs is not, and the review says so", async () => {
    const one = (n: number) => racesZip({ "a.json": races(`t${n}.spec.ts > t`, 1, []) });
    const gh = fakeGithub();
    // the oldest run, asked last: it holds the seventh artifact
    gh.addRun(SHA1, { "genclass-7": one(7) }, { name: "more e2e", workflow_id: 2 });
    for (let i = 0; i < 5; i++) gh.addRun(SHA1, {}, { name: `job ${i}`, workflow_id: 10 + i });
    gh.addRun(SHA1, Object.fromEntries(Array.from({ length: MAX_ARTIFACTS }, (_, i) => [`genclass-${i + 1}`, one(i + 1)])));
    const ci = await collector(gh.fetch).read();
    expect(ci.artifacts).toHaveLength(MAX_ARTIFACTS);
    expect(gh.storage).toHaveLength(MAX_ARTIFACTS);
    // the other runs were still asked after the sixth artifact was read: that is how the seventh was found
    expect(asked(gh)).toHaveLength(7);
    expect(ci.notes).toEqual(['Only the first 6 artifacts whose name starts with "genclass" were read.']);
  });

  it("through the webhook: the check and the comment carry the note about what was not read", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const zip = (n: number) => makeZip(Array.from({ length: 32 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.json`, data: padded(60_000, n * 100 + i) })));
    const run = gh.addRun(SHA1, Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`genclass-${i + 1}`, zip(i)])));
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    const note = "Note: Race files are read up to 4 MB for one review, unzipped; the rest were not read.";
    expect(gh.checksAt(SHA1).at(-1).output.summary).toContain(note);
    expect(gh.summary(12)).toContain(note);
    expect(gh.summary(12)).toContain("`not read: over 4 MB of race files in one review`");
    expect(gh.storage).toHaveLength(3);
  });
});

describe("github app: the workflow runs of a commit (docs/github-app/README.md, \"Limits\")", () => {
  it("20 runs on the commit, the one that uploaded race files the oldest: it is asked, within the request budget", async () => {
    const gh = fakeGithub();
    const uploader = gh.addRun(SHA1);
    for (let i = 0; i < 19; i++) gh.addRun(SHA1, { coverage: racesZip() }, { name: `job ${i}`, workflow_id: 10 + i });
    const { client, read: collect } = collector(gh.fetch);
    const ci = await collect();
    expect(ci.state).toBe("ready");
    expect(ci.artifacts).toEqual([{ name: "genclass-races", runId: uploader.id, files: 4 }]);
    expect(ci.notes).toEqual([]);
    // every run of the commit comes in one request, and every one of the 20 is asked: 1 + 20 + 1 download
    expect(gh.apiCalls()[0]!.query.get("per_page")).toBe(String(MAX_LISTED_RUNS));
    expect(asked(gh)).toHaveLength(20);
    expect(client.calls()).toBe(22);
    expect(client.calls()).toBeLessThanOrEqual(MAX_EVIDENCE_CALLS);
    // the eight newest are still what a review shows of the runs
    expect(ci.runs).toHaveLength(8);
  });

  it("through the webhook: the review started by that run reads it, among 20 runs", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const uploader = gh.addRun(SHA1);
    for (let i = 0; i < 19; i++) gh.addRun(SHA1, { coverage: racesZip() }, { name: `job ${i}`, workflow_id: 10 + i });
    expect(await result(await deliver(env, "workflow_run", runEvent(uploader.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA1).at(-1).output.title).toBe("2 findings, 1 reproducible");
    expect(gh.summary(12)).toContain("**2 findings**");
  });

  it("45 runs, the run with the race files the last to finish: it is asked first, and 30 runs are asked in all", async () => {
    // 12 workflows; workflow 1 ran once (run 5001, the lowest id) and ended last, the other 11 ran 4 times each
    const rows = [listedRun(5001, 1, 30)];
    for (let i = 0; i < 44; i++) rows.push(listedRun(5002 + i, 2 + (i % 11), i % 29));
    const gh = githubListing(rows, { 5001: { "genclass-races": racesZip() } });
    const { client, read: collect } = collector(gh.fetch);
    const ci = await collect();
    expect(ci.state).toBe("ready");
    expect(ci.artifacts).toEqual([{ name: "genclass-races", runId: 5001, files: 4 }]);
    const order = asked(gh);
    expect(order[0]).toBe(5001);
    expect(order).toHaveLength(MAX_ASKED_RUNS);
    // one run of each of the 12 workflows before a second run of any
    const workflowOf = new Map(rows.map((r) => [Number(r.id), Number(r.workflow_id)]));
    expect(new Set(order.slice(0, 12).map((id) => workflowOf.get(id))).size).toBe(12);
    // 1 list of runs, 30 lists of artifacts, 1 download; what was left unasked are older runs of workflows already asked
    expect(client.calls()).toBe(32);
    expect(client.calls()).toBeLessThanOrEqual(MAX_EVIDENCE_CALLS);
    expect(ci.notes).toEqual([]);
  });

  it("no race files in the runs asked, and runs left unasked: the notes say how many were asked and how many were not", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => listedRun(5001 + i, 1 + (i % 12), i % 29));
    const gh = githubListing(rows, { 5001: { "playwright-report": racesZip() } });
    const { client, read: collect } = collector(gh.fetch);
    const ci = await collect();
    expect(ci.state).toBe("none");
    expect(ci.notes).toEqual([
      'No artifact whose name starts with "genclass" in 30 completed workflow runs on this commit.',
      "Of the 45 completed workflow runs listed for this commit, the artifacts of 30 were looked at, the most recently finished first; the other 15 were not.",
    ]);
    expect(client.calls()).toBe(31);
  });

  it("more workflows than runs asked: a workflow none of whose runs was asked is said, also when race files were read", async () => {
    // 40 workflows, one run each; the uploader ended last
    const rows = Array.from({ length: 40 }, (_, i) => listedRun(5001 + i, 1 + i, i === 0 ? 50 : i));
    const gh = githubListing(rows, { 5001: { "genclass-races": racesZip() } });
    const ci = await collector(gh.fetch).read();
    expect(ci.state).toBe("ready");
    expect(asked(gh)[0]).toBe(5001);
    expect(ci.notes).toEqual(["Of the 40 completed workflow runs listed for this commit, the artifacts of 30 were looked at, the most recently finished first; the other 10 were not."]);
  });

  it("the order: the most recently finished run of each workflow, then their other runs, then runs in which no job ran; a run named by the caller before all", async () => {
    const rows = [
      listedRun(1, 100, 5),
      listedRun(2, 100, 20),
      listedRun(3, 200, 10, { conclusion: "failure" }),
      listedRun(4, 300, 25, { conclusion: "skipped" }),
      listedRun(5, 200, 1),
      listedRun(6, 400, 26, { status: "in_progress", conclusion: null }),
      listedRun(7, 500, 24, { conclusion: "action_required" }),
    ];
    const gh = githubListing(rows);
    const ci = await collector(gh.fetch).read();
    expect(asked(gh)).toEqual([2, 3, 1, 5, 4, 7]);
    // a run is still going and nothing was read: the review waits
    expect(ci.state).toBe("pending");
    const named = githubListing(rows);
    await collector(named.fetch, { firstRun: 5 }).read();
    expect(asked(named)).toEqual([5, 2, 3, 1, 4, 7]);
    // a run that is not one of the commit's completed runs changes nothing
    const other = githubListing(rows);
    await collector(other.fetch, { firstRun: 6 }).read();
    expect(asked(other)).toEqual([2, 3, 1, 5, 4, 7]);
  });

  it("a run named by the caller is read even when 40 workflows finished after it", async () => {
    const rows = Array.from({ length: 41 }, (_, i) => listedRun(5001 + i, 1 + i, i));
    const without = githubListing(rows, { 5001: { "genclass-races": racesZip() } });
    expect((await collector(without.fetch).read()).state).toBe("none");
    const gh = githubListing(rows, { 5001: { "genclass-races": racesZip() } });
    const ci = await collector(gh.fetch, { firstRun: 5001 }).read();
    expect(ci.state).toBe("ready");
    expect(asked(gh)[0]).toBe(5001);
  });

  it("whether the commit's runs are still going is worked out from every run listed, not from the newest eight", async () => {
    const gh = fakeGithub();
    gh.runs.set(REPO.full_name, [{ id: 5001, head_sha: SHA1, status: "in_progress", conclusion: null }, ...Array.from({ length: 12 }, (_, i) => ({ id: 5002 + i, head_sha: SHA1, name: `job ${i}`, workflow_id: 10 + i }))]);
    const ci = await collector(gh.fetch).read();
    expect(ci.state).toBe("pending");
    expect(asked(gh)).toHaveLength(12);
    expect(ci.notes).toEqual([]);
  });

  it("60 runs and none with race files: 30 are asked, in 31 requests, and the commit's count is said when GitHub lists fewer runs than it has", async () => {
    const gh = fakeGithub();
    for (let i = 0; i < 60; i++) gh.addRun(SHA1, {}, { name: `job ${i}`, workflow_id: 10 + i });
    const { client, read: collect } = collector(gh.fetch);
    const ci = await collect();
    expect(asked(gh)).toHaveLength(MAX_ASKED_RUNS);
    expect(client.calls()).toBe(31);
    expect(ci.state).toBe("none");
    expect(ci.notes[1]).toBe("Of the 60 completed workflow runs listed for this commit, the artifacts of 30 were looked at, the most recently finished first; the other 30 were not.");
    const more = githubListing(Array.from({ length: 100 }, (_, i) => listedRun(5001 + i, 1 + (i % 3), i % 50)), {}, 250);
    const partial = await collector(more.fetch).read();
    expect(partial.notes.at(-1)).toBe("This commit has 250 workflow runs; the 100 GitHub lists first were looked at.");
  });

  it("a renamed repository, where GitHub redirects every list and each costs two requests: fewer runs are asked, and the budget holds", async () => {
    const gh = fakeGithub({
      answer: (c, url) =>
        c.method === "GET" && /\/actions\/runs(?:\/\d+\/artifacts)?$/.test(c.path) && !url.searchParams.has("moved")
          ? new Response(null, { status: 301, headers: { location: `${url.origin}${url.pathname}?moved=1&${url.searchParams}` } })
          : undefined,
    });
    for (let i = 0; i < 59; i++) gh.addRun(SHA1, {}, { name: `job ${i}`, workflow_id: 10 + i });
    // added last: the newest, so the first asked
    const uploader = gh.addRun(SHA1);
    const { client, read: collect } = collector(gh.fetch);
    const ci = await collect();
    expect(ci.artifacts).toEqual([{ name: "genclass-races", runId: uploader.id, files: 4 }]);
    expect(client.calls()).toBeLessThanOrEqual(MAX_EVIDENCE_CALLS);
    expect(client.calls()).toBe(33);
    expect(new Set(asked(gh)).size).toBe(15);
    expect(ci.notes).toEqual(["Of the 60 completed workflow runs listed for this commit, the artifacts of 15 were looked at, the most recently finished first; the other 45 were not."]);
  });
});

describe("github app: the artifacts of a run that was run again", () => {
  /** Run 5001 lists these artifacts, in this order, and each downloads as its own archive. */
  function rerun(listed: { id: number; created_at: string; size?: number }[], zips: Record<number, Uint8Array>) {
    const gh = fakeGithub({
      answer: (c) =>
        c.method === "GET" && c.path === "/repos/acme/shop/actions/runs/5001/artifacts"
          ? json({ total_count: listed.length, artifacts: listed.map((a) => ({ id: a.id, name: "genclass-races", size_in_bytes: a.size ?? zips[a.id]!.length, expired: false, created_at: a.created_at })) })
          : undefined,
    });
    gh.runs.set(REPO.full_name, [{ id: 5001, head_sha: SHA1 }]);
    const downloaded: number[] = [];
    const fetch: Fetch = async (u, i) => {
      if (!u.startsWith(`${STORAGE}/a/`)) return gh.fetch(u, i);
      const id = Number(u.split("/").pop());
      downloaded.push(id);
      return new Response(zips[id], { status: 200 });
    };
    return { gh, fetch, downloaded };
  }
  // as GitHub listed the two attempts of a real run: the older artifact first, with the higher id
  const first = { id: 12596407632, created_at: "2026-10-25T10:49:33Z" };
  const second = { id: 12596358500, created_at: "2026-10-25T10:55:54Z" };
  const zips = {
    [first.id]: racesZip({ "attempt-1.json": raceFile("checkout-1.json") }),
    [second.id]: racesZip({ "attempt-2.json": races("checkout.spec.ts > checkout > places one order", 1, []) }),
  };

  it("of two artifacts with one name, the one created last is read, wherever GitHub lists it", async () => {
    for (const listed of [[first, second], [second, first]]) {
      const { fetch, downloaded } = rerun(listed, zips);
      const ci = await collector(fetch).read();
      expect(downloaded).toEqual([second.id]);
      expect(ci.inputs.map((i) => i.name)).toEqual(["genclass-races/attempt-2.json"]);
      expect(ci.artifacts).toEqual([{ name: "genclass-races", runId: 5001, files: 1 }]);
      expect(buildSummary(ci.inputs).totals.signatures).toBe(0);
    }
  });

  it("an older attempt's artifact never stands in for the newest one when that cannot be read", async () => {
    const { fetch, downloaded } = rerun([first, { ...second, size: 5 * 1024 * 1024 }], zips);
    const ci = await collector(fetch).read();
    expect(downloaded).toEqual([]);
    expect(ci.inputs).toEqual([]);
    expect(ci.notes).toEqual(['The artifact "genclass-races" is larger than this review reads (4 MB); upload only the race files (test-results/genclass).']);
  });

  it("without a time (ids only), the higher id is read", async () => {
    const { fetch, downloaded } = rerun([{ id: 7, created_at: "" }, { id: 9, created_at: "" }], { 7: zips[first.id]!, 9: zips[second.id]! });
    await collector(fetch).read();
    expect(downloaded).toEqual([9]);
  });
});

describe("github app: no address in a race file's text reaches GitHub as a link (docs/github-app/README.md, \"Security\")", () => {
  const SHA = "a".repeat(40);
  const LINKS = { docs: "https://example.test/docs", setup: "https://example.test/setup", app: "https://genclass.dev/github", origin: "https://genclass.dev" };
  // an issue on another repository (GitHub would leave "mentioned this" there), and plain addresses in every form it links
  const TEST = "cart.spec.ts > regression https://github.com/vercel/next.js/issues/1 www.evil.example (http://evil.example/login)";
  const EVIDENCE = "see https://github.com/some-org/some-repo/pull/2 and www.evil.example/path, _www.evil.example or HTTPS://EVIL.EXAMPLE";
  const location = { file: "tests/cart.spec.ts", line: 7 };

  function race(seed: number): RacesFileInput {
    const signature = (trigger: string, diagnosis: string, op: string) => ({ sig: `${trigger}|${diagnosis}|${op}`, trigger, diagnosis, op, confidence: 0.95, evidence: EVIDENCE, seeds: [seed] });
    return {
      name: `cart-s${seed}.json`,
      content: JSON.stringify({
        schema: "genclass-races/1",
        test: TEST,
        seed,
        signatures: [signature("request", "duplicate", "POST https://api.evil.example/orders"), signature("request", "odd www.evil.example", "GET /x")],
        mode: "observe http://evil.example",
        fixture: { model: "skip", agent: "www.evil.example unreachable", chaosApplied: null, serviceWorker: false },
        location,
      }),
    };
  }

  /**
   * What GitHub could still turn into a link: the text outside code (fenced blocks and code spans, where it links
   * nothing), without the links the app itself writes, which are whole markdown links to its own pages.
   */
  function linkable(markdown: string): string {
    return markdown
      .replace(/^```[\s\S]*?^```/gm, "")
      .replace(/`+[^`\n]*`+/g, "")
      .replace(/\]\((?:https:\/\/example\.test\/(?:docs|setup)|https:\/\/genclass\.dev)[^)\s]*\)/g, "]");
  }
  const NO_ADDRESS = /:\/\/|www\./i;

  async function review() {
    const inputs = [race(1), race(2)];
    const summary = summaryOf(inputs, DEFAULT_SETTINGS);
    const merged = await mergeFindings(emptyState(), summary, SHA);
    // a note carries a workflow's name, which a fork chooses
    const notes = ['The artifacts of the workflow run "e2e https://evil.example www.evil.example" could not be listed.'];
    const m: ReviewModel = { repo: "acme/shop", number: 12, headSha: SHA, mention: "genclass-dev", ci: { state: "ready", runs: [], artifacts: [{ name: "genclass-races", runId: 1, files: 2 }], inputs, notes }, summary, findings: merged.view, production: null, settings: DEFAULT_SETTINGS, warnings: [], links: LINKS };
    return { m, state: merged.state, inputs };
  }

  it("the summary comment and the check run", async () => {
    const { m } = await review();
    const body = renderSummary(m)!;
    const check = renderCheck(m);
    for (const [what, text] of [["comment", body], ["check summary", check.summary], ["check text", check.text]] as const) {
      expect(text.length, what).toBeGreaterThan(100);
      expect(linkable(text), what).not.toMatch(NO_ADDRESS);
    }
    // the text is all there, with the invisible break in it
    expect(body).toContain(`cart.spec.ts > regression https:${Z}//github.com/vercel/next.js/issues/1 www${Z}.evil.example (http:${Z}//evil.example/login)`);
    expect(body).toContain(`> see https:${Z}//github.com/some-org/some-repo/pull/2 and www${Z}.evil.example/path, \\_www${Z}.evil.example or HTTPS:${Z}//EVIL.EXAMPLE`);
    expect(body).toContain(`Detection, odd www${Z}.evil.example`);
    expect(body).toContain(`Note: The artifacts of the workflow run "e2e https:${Z}//evil.example www${Z}.evil.example" could not be listed.`);
    expect(check.summary).toContain(`Note: The artifacts of the workflow run "e2e https:${Z}//evil.example www${Z}.evil.example" could not be listed.`);
    expect(check.text).toContain(`mode observe http:${Z}//evil.example`);
    // an operation is shown as code, where GitHub links nothing, as it was written
    expect(body).toContain("`POST https://api.evil.example/orders`");
    // the links the app writes itself are still links
    expect(body).toContain("[What the lines mean](https://example.test/docs)");
    expect(body).toContain("[Setup and settings](https://example.test/setup)");
    const none = renderCheck({ ...m, summary: null, findings: [], ci: { ...m.ci, state: "none", artifacts: [], inputs: [] } });
    expect(none.summary).toMatch(/\]\(https:\/\/example\.test\/(?:docs|setup)\)/);
    expect(linkable(none.summary)).not.toMatch(NO_ADDRESS);
  });

  it("an inline comment, the replay and fix replies, and an issue's body", async () => {
    const { m, state, inputs } = await review();
    const finding = state.findings.find((f) => f.c === "duplicate")!;
    const evidence = m.findings.find((f) => f.fp === finding.fp)!.now!.evidence;
    const inline = inlineComments(m, state, testLocations(inputs), new Map([[location.file, [[1, 20]] as [number, number][]]]));
    expect(inline.length).toBeGreaterThan(0);
    const at = { repo: "acme/shop", number: 12, headSha: SHA, mention: "genclass-dev", links: LINKS };
    const texts: [string, string][] = [
      ...inline.map((c, i): [string, string] => [`inline comment ${i}`, c.body]),
      ["replay", renderReplay(finding, { ...at, evidence })],
      ["fix brief", renderFixBrief(finding, { ...at, evidence, asker: "ada" })],
      ["issue", renderIssue(state.findings, { ...at, merged: true }).body],
    ];
    for (const [what, text] of texts) {
      expect(text.length, what).toBeGreaterThan(100);
      expect(linkable(text), what).not.toMatch(NO_ADDRESS);
    }
    const quoted = `> see https:${Z}//github.com/some-org/some-repo/pull/2 and www${Z}.evil.example/path, \\_www${Z}.evil.example or HTTPS:${Z}//EVIL.EXAMPLE`;
    expect(inline[0]!.body).toContain(quoted);
    expect(texts[inline.length]![1]).toContain(quoted);
    expect(texts[inline.length + 1]![1]).toContain(quoted);
    expect(texts[inline.length + 2]![1]).toContain(`- Test: cart.spec.ts > regression https:${Z}//github.com/vercel/next.js/issues/1 www${Z}.evil.example (http:${Z}//evil.example/login)`);
    // the app's own links are still links
    expect(texts[inline.length]![1]).toContain("[What the lines mean](https://example.test/docs)");
    expect(texts[inline.length + 1]![1]).toContain("[how to set it up](https://example.test/setup#fix)");
  });

  it("through the webhook: what is posted for a fork's race files holds no address outside code but the app's own links", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1, { head: { sha: SHA1, ref: "patch-1", repo: { id: 99001, full_name: "mallory/shop" } } });
    const run = gh.addRun(SHA1, { "genclass-races": racesZip({ "one.json": String(race(1).content), "two.json": String(race(2).content) }) }, { name: "e2e https://evil.example www.evil.example" });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    // the app's own links go to its guide in this repository and to its own pages, as whole markdown links
    const own = (text: string): string => linkable(text).replace(/\]\(https:\/\/(?:github\.com\/genclass-dev\/GenClass\/|genclass\.dev)[^)\s]*\)/g, "]");
    const posted = [gh.summary(12)!, gh.checksAt(SHA1).at(-1).output.summary, gh.checksAt(SHA1).at(-1).output.text];
    for (const text of posted) {
      expect(text.length).toBeGreaterThan(100);
      expect(own(text)).not.toMatch(NO_ADDRESS);
    }
    expect(posted[0]).toContain(`https:${Z}//github.com/vercel/next.js/issues/1`);
    expect(posted[0]).toMatch(/\]\(https:\/\/github\.com\/genclass-dev\/GenClass\/[^)]*\)/);
  });
});
