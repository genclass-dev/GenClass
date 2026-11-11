// The order of things on the page, from what the page hands over to what a race file carries and back (src/steps.ts),
// and its place in the file (src/races.ts) and in the validator (src/schema.ts).
import { describe, expect, it } from "vitest";
import { buildRacesFile, racesFileText } from "../src/races.js";
import { parseRaces } from "../src/schema.js";
import { actionLabel, decodeSteps, encodeSteps, pageStepOf, readSteps, requestLabel, sequenceOf, stepsBytes, type PageStream, type StepEvent, type StepSequence } from "../src/steps.js";
import { RACES_LIMITS, STEPS_LIMITS } from "../src/types.js";

const act = (at: number, kind: string, target: string, key = ""): unknown[] => ["a", at, kind, target, key];
const stream = (id: string, raw: unknown[][], body?: number): PageStream => ({ id, steps: raw.map((r) => pageStepOf(r) ?? undefined), ...(body !== undefined ? { body } : {}) });
const short = (e: StepEvent): string => `${e.kind}:${e.label}#${e.n}@${e.t}${e.late ? "!" : ""}`;

describe("steps: names that are the same in every run", () => {
  it("a request is its method and path, ids as :id; another host by its name without the port; a retry keeps its suffix", () => {
    expect(requestLabel("GET /api/search#3")).toBe("GET /api/search");
    expect(requestLabel("GET /api/items/:id#12")).toBe("GET /api/items/:id");
    expect(requestLabel("PUT /api/notes/3f2b8c1e-9d4a-4c6b-8e1f-0a2b3c4d5e6f/title#2")).toBe("PUT /api/notes/:id/title");
    expect(requestLabel("POST localhost:8001/api/documents/42/notes/#1")).toBe("POST localhost/api/documents/:id/notes/");
    expect(requestLabel("POST localhost:8001/api/documents/42/notes/#1")).toBe(requestLabel("POST localhost:53211/api/documents/7/notes/#9"));
    expect(requestLabel("GET api.example.com#1")).toBe("GET api.example.com");
    expect(requestLabel("GET /api/search#3~retry2")).toBe("GET /api/search~retry2");
    expect(requestLabel("GET /api/search#3~hedge")).toBe("GET /api/search~hedge");
    // not a key of the agent entry's record
    for (const bad of ["", "GET /api/search", "#3", "GET#3", "GET /api/search#x", "GET /api/search#3~"]) expect(requestLabel(bad), bad).toBeNull();
    expect(requestLabel(`GET /${"z".repeat(400)}#1`)!.length).toBe(STEPS_LIMITS.label);
  });

  it("a user action is its kind, the key pressed and its target, never a value", () => {
    expect(actionLabel("click", 'button "Apply"', "")).toBe('click button "Apply"');
    expect(actionLabel("key", 'textbox "Search"', "Enter")).toBe('key Enter textbox "Search"');
    expect(actionLabel("type", ' input\n "Filter   tags" ', undefined)).toBe('type input "Filter tags"');
    expect(actionLabel(undefined, undefined, undefined)).toBe("action");
    expect(actionLabel("click", `button "${"x".repeat(400)}"`, "").length).toBe(STEPS_LIMITS.label);
  });

  it("what the page sends is read by shape; anything else is no step", () => {
    expect(pageStepOf(act(100, "click", 'button "Apply"'))).toEqual({ kind: "a", at: 100, name: 'click button "Apply"' });
    expect(pageStepOf(["s", 101, "GET /api/search#1"])).toEqual({ kind: "s", at: 101, name: "GET /api/search#1" });
    expect(pageStepOf(["r", 140.4, "GET /api/search#1"])).toEqual({ kind: "r", at: 140.4, name: "GET /api/search#1" });
    expect(pageStepOf(["x", 150, "GET /api/search#2"])).toEqual({ kind: "x", at: 150, name: "GET /api/search#2" });
    for (const bad of [null, "s", [], ["s"], ["s", "1", "GET /a#1"], ["s", NaN, "GET /a#1"], ["s", 1], ["s", 1, ""], ["s", 1, "x".repeat(601)], ["w", 1, "GET /a#1"], { k: "s" }]) expect(pageStepOf(bad)).toBeNull();
  });
});

describe("steps: one sequence per test", () => {
  it("counts each action and each request from 1 in the order they were done or sent, and gives a response its request's number", () => {
    const seq = sequenceOf([
      stream("1", [
        act(1000, "click", 'button "lamp"'),
        ["s", 1001, "GET /api/items/:id#1"],
        act(1030, "click", 'button "lamp"'),
        ["s", 1031, "GET /api/items/:id#2"],
        ["r", 1090, "GET /api/items/:id#2"],
        ["r", 1140, "GET /api/items/:id#1"],
        ["s", 1150, "GET /api/slow#1"],
        ["x", 1190, "GET /api/slow#1"],
      ]),
    ]);
    expect(seq.bodyKnown).toBe(false);
    expect(seq.events.map(short)).toEqual([
      'a:click button "lamp"#1@0',
      "s:GET /api/items/:id#1@1",
      'a:click button "lamp"#2@30',
      "s:GET /api/items/:id#2@31",
      "r:GET /api/items/:id#2@90",
      "r:GET /api/items/:id#1@140",
      "s:GET /api/slow#1@150",
      "x:GET /api/slow#1@190",
    ]);
  });

  it("page loads are merged by time, each keeping its own order, and the numbering goes on across them", () => {
    // the second page load starts its own keys at #1: it is the test's second and third GET /api/me
    const first = stream("1", [["s", 1000, "GET /api/me#1"], ["r", 1040, "GET /api/me#1"], act(1100, "click", 'link "Next"')]);
    const second = stream("2", [["s", 1200, "GET /api/me#1"], ["s", 1201, "GET /api/me#2"], ["r", 1230, "GET /api/me#2"], ["r", 1260, "GET /api/me#1"]]);
    expect(sequenceOf([second, first]).events.map(short)).toEqual(['s:GET /api/me#1@0', "r:GET /api/me#1@40", 'a:click link "Next"#1@100', "s:GET /api/me#2@200", "s:GET /api/me#3@201", "r:GET /api/me#3@230", "r:GET /api/me#2@260"]);
    // two pages at once: one order by time; a page's own order is kept even where its rounded times say otherwise
    const a = stream("a", [["s", 10, "GET /a#1"], ["r", 30, "GET /a#1"]]);
    const b = stream("b", [["s", 20, "GET /b#1"], ["r", 19, "GET /b#1"]]);
    expect(sequenceOf([a, b]).events.map((e) => `${e.kind}:${e.label}`)).toEqual(["s:GET /a", "s:GET /b", "r:GET /b", "r:GET /a"]);
    // times never go back
    expect(sequenceOf([b]).events.map((e) => e.t)).toEqual([0, 0]);
  });

  it("what landed after the test's own code comes last and is marked late", () => {
    const seq = sequenceOf([stream("1", [["s", 100, "GET /a#1"], ["s", 101, "GET /b#1"], ["r", 150, "GET /b#1"], ["r", 400, "GET /a#1"]], 3)]);
    expect(seq.bodyKnown).toBe(true);
    expect(seq.events.map(short)).toEqual(["s:GET /a#1@0", "s:GET /b#1@1", "r:GET /b#1@50", "r:GET /a#1@300!"]);
    // a page load first heard of after the test's code (body 0) is late as a whole, whatever its times
    const late = stream("2", [["s", 90, "GET /c#1"]], 0);
    expect(sequenceOf([late, stream("1", [["s", 100, "GET /a#1"]])]).events.map(short)).toEqual(["s:GET /a#1@0", "s:GET /c#1@0!"]);
  });

  it("a response whose request was never handed over, a key sent twice and a hole in the list are left out", () => {
    const s: PageStream = { id: "1", steps: [pageStepOf(["r", 5, "GET /lost#1"])!, undefined, pageStepOf(["s", 10, "GET /a#1"])!, pageStepOf(["s", 11, "GET /a#1"])!, pageStepOf(["s", 12, "not a key"])!, pageStepOf(["r", 20, "GET /a#1"])!] };
    expect(sequenceOf([s]).events.map(short)).toEqual(["s:GET /a#1@5", "r:GET /a#1@15"]);
    expect(sequenceOf([])).toEqual({ events: [], bodyKnown: false });
  });
});

describe("steps: what a file holds, and reading it back", () => {
  const events = (n: number): StepEvent[] =>
    Array.from({ length: n }, (_, i) => ({ kind: (["a", "s", "r", "x"] as const)[i % 4], label: i % 4 === 0 ? `click button "b${i % 12}"` : `GET /api/r${i % 7}`, n: 1 + (i >> 3), t: i * 13 }));

  it("labels once each in order of first appearance, steps as kind, label, number and ms since the step before", () => {
    const seq: StepSequence = {
      bodyKnown: true,
      events: [
        { kind: "a", label: 'click button "Apply"', n: 1, t: 0 },
        { kind: "s", label: "POST /api/orders", n: 1, t: 4 },
        { kind: "s", label: "POST /api/orders", n: 2, t: 4 },
        { kind: "r", label: "POST /api/orders", n: 2, t: 42 },
        { kind: "r", label: "POST /api/orders", n: 1, t: 300, late: true },
      ],
    };
    const steps = encodeSteps(seq, { max: 300, bytes: 5000 })!;
    expect(steps).toEqual({ labels: ['click button "Apply"', "POST /api/orders"], order: "a0.1+0 s1.1+4 s1.2+0 r1.2+38 r1.1+258", body: 4 });
    expect(decodeSteps(steps)).toEqual(seq.events);
    expect(readSteps(JSON.parse(JSON.stringify(steps)))).toEqual(steps);
  });

  it("more steps than the count or the bytes allow: the beginning is kept and `cut` says how many were left out", () => {
    const seq: StepSequence = { events: events(500), bodyKnown: false };
    const byCount = encodeSteps(seq, { max: 300, bytes: 1e6 })!;
    expect(decodeSteps(byCount)).toEqual(seq.events.slice(0, 300));
    expect(byCount.cut).toBe(200);
    expect(byCount.body).toBeUndefined();
    const byBytes = encodeSteps(seq, { max: 300, bytes: 1500, more: 7 })!;
    const kept = decodeSteps(byBytes).length;
    expect(kept).toBeGreaterThan(50);
    expect(kept).toBeLessThan(300);
    expect(stepsBytes(byBytes)).toBeLessThanOrEqual(1500);
    expect(byBytes.cut).toBe(500 - kept + 7);
    expect(decodeSteps(byBytes)).toEqual(seq.events.slice(0, kept));
    // one step more would not fit
    expect(stepsBytes(encodeSteps({ ...seq, events: seq.events.slice(0, kept + 1) }, { max: 300, bytes: 1e6, more: 500 - (kept + 1) + 7 })!)).toBeGreaterThan(1500);
    // never more than the format holds, whatever is asked for
    expect(decodeSteps(encodeSteps({ events: events(STEPS_LIMITS.steps + 50), bodyKnown: false }, { max: 1e9, bytes: 1e9 })!)).toHaveLength(STEPS_LIMITS.steps);
    const manyLabels: StepSequence = { bodyKnown: false, events: Array.from({ length: STEPS_LIMITS.labels + 20 }, (_, i) => ({ kind: "a" as const, label: `click button "b${i}"`, n: 1, t: i })) };
    expect(encodeSteps(manyLabels, { max: 1e9, bytes: 1e9 })!.labels).toHaveLength(STEPS_LIMITS.labels);
  });

  it("nothing to write: no steps, a count of 0, or no room for one", () => {
    expect(encodeSteps({ events: [], bodyKnown: true }, { max: 300, bytes: 5000 })).toBeUndefined();
    expect(encodeSteps({ events: events(10), bodyKnown: false }, { max: 0, bytes: 5000 })).toBeUndefined();
    expect(encodeSteps({ events: events(10), bodyKnown: false }, { max: 300, bytes: 20 })).toBeUndefined();
    expect(encodeSteps({ events: events(10), bodyKnown: false }, { max: 300, bytes: -5 })).toBeUndefined();
  });

  it("the reader takes only what it knows and refuses the rest whole", () => {
    const good = { labels: ["GET /a", 'click button "b"'], order: "s0.1+0 a1.1+5 r0.1+30", body: 2, cut: 4 };
    expect(readSteps({ ...good, extra: true })).toEqual(good);
    expect(readSteps({ labels: ["GET /a"], order: "s0.1+0", cut: 0 })).toEqual({ labels: ["GET /a"], order: "s0.1+0" });
    const bad: unknown[] = [
      null,
      "s0.1+0",
      [],
      { labels: ["GET /a"] },
      { labels: "GET /a", order: "s0.1+0" },
      { labels: ["GET /a"], order: "" },
      { labels: ["GET /a"], order: "s0.1+0 " },
      { labels: ["GET /a"], order: "s1.1+0" },
      { labels: ["GET /a"], order: "s0.0+0" },
      { labels: ["GET /a"], order: "w0.1+0" },
      { labels: ["GET /a"], order: "s0.1" },
      { labels: ["GET /a"], order: "s0.1+0", body: 2 },
      { labels: ["GET /a"], order: "s0.1+0", body: -1 },
      { labels: ["GET /a"], order: "s0.1+0", cut: 1.5 },
      { labels: [""], order: "s0.1+0" },
      { labels: [7], order: "s0.1+0" },
      { labels: ["x".repeat(STEPS_LIMITS.label + 1)], order: "s0.1+0" },
      { labels: Array.from({ length: STEPS_LIMITS.labels + 1 }, (_, i) => `GET /r${i}`), order: "s0.1+0" },
      { labels: ["GET /a"], order: Array.from({ length: STEPS_LIMITS.steps + 1 }, () => "s0.1+0").join(" ") },
    ];
    for (const b of bad) expect(readSteps(b), JSON.stringify(b)?.slice(0, 80)).toBeNull();
  });
});

describe("steps: in the race file", () => {
  const base = { test: "t", seed: 1, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [] };
  const sequence: StepSequence = { bodyKnown: true, events: [{ kind: "a", label: 'click button "Apply"', n: 1, t: 0 }, { kind: "s", label: "POST /api/orders", n: 1, t: 4 }, { kind: "r", label: "POST /api/orders", n: 1, t: 42 }] };

  it("the status and the steps are written last, and the validator carries both", () => {
    const file = buildRacesFile({ ...base, status: "failed", steps: { sequence, max: 300, bytes: 5000 } });
    expect(Object.keys(file).slice(-2)).toEqual(["status", "steps"]);
    expect(file.status).toBe("failed");
    expect(file.steps).toEqual({ labels: ['click button "Apply"', "POST /api/orders"], order: "a0.1+0 s1.1+4 r1.1+38", body: 3 });
    const read = parseRaces(racesFileText(file));
    expect(read.ok && read.file).toEqual(file);
    // without them the file is what it always was
    const plain = buildRacesFile(base);
    expect("status" in plain || "steps" in plain).toBe(false);
    expect(buildRacesFile({ ...base, steps: { sequence, max: 0, bytes: 5000 } }).steps).toBeUndefined();
    expect(buildRacesFile({ ...base, steps: { sequence: { events: [], bodyKnown: false }, max: 300, bytes: 5000 } }).steps).toBeUndefined();
  });

  it("a status or steps the validator cannot read are left out; the file and its signatures stay", () => {
    const file = buildRacesFile({ ...base, witnesses: [{ kind: "overwrote-newer", subject: "x", by: "GET /a#1", over: "GET /a#2", overKind: "request" }], status: "passed", steps: { sequence, max: 300, bytes: 5000 } });
    const odd = parseRaces(JSON.stringify({ ...file, status: "flaky", steps: { labels: ["GET /a"], order: "q0.1+0" } }));
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    expect(odd.file.signatures).toHaveLength(1);
    expect("status" in odd.file || "steps" in odd.file).toBe(false);
    for (const status of ["passed", "failed", "timedOut", "interrupted"]) {
      const r = parseRaces(JSON.stringify({ ...file, status }));
      expect(r.ok && r.file.status).toBe(status);
    }
  });

  it("the steps go into the room the signatures leave: none is left out for them, and the file stays within its limit", () => {
    const long: StepSequence = { bodyKnown: false, events: Array.from({ length: 2000 }, (_, i) => ({ kind: "s" as const, label: `GET /api/${"p".repeat(100)}${i % 300}`, n: 1 + Math.floor(i / 300), t: i })) };
    const witnesses = Array.from({ length: 60 }, (_, i) => ({ kind: "overwrote-newer", subject: `store.field${i}`, by: `GET /api/r${i}/items#1`, over: `GET /api/r${i}/items#2`, overKind: "request", change: "x".repeat(150) }));
    const without = buildRacesFile({ ...base, witnesses });
    const withSteps = buildRacesFile({ ...base, witnesses, steps: { sequence: long, max: 2000, bytes: 40 * 1024 } });
    expect(withSteps.signatures).toEqual(without.signatures);
    expect(withSteps.dropped).toBe(without.dropped);
    const size = Buffer.byteLength(racesFileText(withSteps), "utf8");
    expect(size).toBeLessThanOrEqual(RACES_LIMITS.bytes);
    expect(withSteps.steps!.cut).toBeGreaterThan(0);
    expect(decodeSteps(withSteps.steps!).length).toBeGreaterThan(20);
    expect(parseRaces(racesFileText(withSteps)).ok).toBe(true);
    // no room at all: the file is written without steps
    const full = Array.from({ length: 400 }, (_, i) => ({ kind: "overwrote-newer", subject: `s${i}`, by: `GET /api/r${i}/${"y".repeat(250)}#1`, over: "GET /b#2", overKind: "request", change: "x".repeat(180) }));
    const packed = buildRacesFile({ ...base, witnesses: full, steps: { sequence: long, max: 2000, bytes: 40 * 1024 } });
    expect(Buffer.byteLength(racesFileText(packed), "utf8")).toBeLessThanOrEqual(RACES_LIMITS.bytes);
    expect(packed.signatures).toEqual(buildRacesFile({ ...base, witnesses: full }).signatures);
  });

  it("the default: 300 steps in about 5 KB", () => {
    const typical: StepSequence = { bodyKnown: true, events: Array.from({ length: 900 }, (_, i) => ({ kind: (["s", "r"] as const)[i % 2], label: `GET /api/notifications/${["list", "count", "unread"][i % 3]}`, n: 1 + (i >> 1), t: i * 200 })) };
    const file = buildRacesFile({ ...base, steps: { sequence: typical, max: 300, bytes: 5 * 1024 } });
    expect(decodeSteps(file.steps!)).toHaveLength(300);
    expect(file.steps!.cut).toBe(600);
    expect(stepsBytes(file.steps!)).toBeLessThan(5 * 1024);
  });
});
