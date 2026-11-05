// The explore comparison (AGENT.md §5.1): where a difference shows (tiers), redactions, scenario grouping, snapshots
// that left fields out.
import { describe, expect, it } from "vitest";
import { compareRuns, fieldValue, groupRuns, nameDifference, sameScenario, sameValue, scenarioOf, shownField, strongestFirst } from "../src/compare.js";
import { ageless, agesIn, fieldShape, lineWeight, routeShape, sameAges } from "../src/text.js";
import type { ActStep, Run, Snapshot, Step } from "../src/types.js";
import { act, snap } from "./helpers.js";

let n = 0;
/** A run of an explore session: fifo (a baseline) or seeded, its actions and its final snapshot. */
function run(order: "fifo" | "seeded", acts: ActStep[], s: Snapshot, extra: Partial<Run> = {}): Run {
  const id = `r${++n}`;
  return { id, started: 0, lastSeen: 0, page: { url: "http://localhost:5173/list", route: "/list" }, schedule: { order, ...(order === "seeded" ? { seed: n } : {}) }, steps: acts, lost: 0, order: [], forced: 0, witnesses: [], errors: [], detections: [], interventions: [], checks: [], expectations: [], snapshot: s, snapshots: 1, ended: true, ...extra };
}
const click = act(0, "click", 'link "Next page"');
/** Two baselines and the seeded runs, all with the same steps unless given. */
function session(base: Snapshot, seeded: Snapshot[], acts: ActStep[] = [click]): Run[] {
  return [run("fifo", acts, base), run("fifo", acts, base), ...seeded.map((s) => run("seeded", acts, s))];
}

describe("compare: where a difference shows (AGENT.md §5.1)", () => {
  it("store values that differ while the page shows the same are internal state, not a race", () => {
    const base = snap({ "redux.api.provided.Doc.LIST": '2 items ["list(1)", "list(2)"]', "redux.api.queries.list(2).requestId": '"aaaa"' }, ["Page 2", "Item 11"]);
    const g = compareRuns(session(base, [snap({ "redux.api.provided.Doc.LIST": '2 items ["list(2)", "list(1)"]', "redux.api.queries.list(2).requestId": '"bbbb"' }, ["Page 2", "Item 11"]), base]))[0];
    expect(g.compared).toBe(2);
    expect(g.diffs).toHaveLength(1);
    expect(g.diffs[0].tier).toBe("internal");
    expect(g.diffs[0].fields.map((f) => f.name)).toEqual(["redux.api.provided.Doc.LIST", "redux.api.queries.list(2).requestId"]);
  });

  it("what the page shows, its form values, the requests it sent and its errors are visible: a race", () => {
    const base = snap({ "list.page": "2" }, ["Page 2"], { fields: { Search: "react" }, requests: { "GET /api/list": 2 } });
    const text = snap({ "list.page": "3" }, ["Page 3"], { fields: { Search: "react" }, requests: { "GET /api/list": 2 } });
    const field = snap({ "list.page": "2" }, ["Page 2"], { fields: { Search: "reac" }, requests: { "GET /api/list": 2 } });
    const requests = snap({ "list.page": "2" }, ["Page 2"], { fields: { Search: "react" }, requests: { "GET /api/list": 2, "PUT /api/orders": 1 } });
    const runs = session(base, [text, field, requests, base]);
    runs[5].errors.push({ t: 1, name: "TypeError", message: "x is undefined", chain: [] });
    const g = compareRuns(runs)[0];
    expect(g.diffs.map((d) => d.tier)).toEqual(["visible", "visible", "visible", "visible"]);
    // what the page shows and sends comes before the store values
    expect(g.diffs[0].textOnlyRun).toEqual(["Page 3"]);
    expect(g.diffs[1].fields[0]).toEqual({ where: "field", name: "Search", baseline: "react", run: "reac" });
    expect(g.diffs[2].fields[0]).toEqual({ where: "requests", name: "PUT /api/orders", baseline: "(absent)", run: "1" });
    expect(g.diffs[3].errors).toEqual(["x is undefined"]);
  });

  it("a cache refetching once more (a GET count) and an announcement a slower run let expire are internal, not a race", () => {
    const base = snap({ "doc.status": '"published"' }, ["Article", "Saved document", "Close"], { requests: { "GET /api/doc/:id": 3, "POST /api/doc/:id/publish": 2 }, live: ["Saved document", "Close"] });
    const later = snap({ "doc.status": '"published"' }, ["Article"], { requests: { "GET /api/doc/:id": 5, "POST /api/doc/:id/publish": 2 } });
    const g = compareRuns(session(base, [later]))[0];
    expect(g.diffs[0]).toMatchObject({ tier: "internal", textOnlyBaseline: [], announced: ["Saved document", "Close"], fields: [{ where: "requests", name: "GET /api/doc/:id", baseline: "3", run: "5" }] });
    // the same lines outside a live region are what the page shows: a race
    const shown = compareRuns(session({ ...base, live: undefined }, [later]))[0];
    expect(shown.diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: ["Saved document", "Close"] });
  });

  it("a witness only a seeded run had, with the same final state, is an overwrite repaired along the way", () => {
    const base = snap({ "search.results": "react!" }, ["Results for react"]);
    const runs = session(base, [base]);
    runs[2].witnesses.push({ kind: "overwrote-newer", t: 1, subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#2", overKind: "request" });
    expect(compareRuns(runs)[0].diffs[0]).toMatchObject({ tier: "transient", fields: [], witnesses: ["overwrote-newer search.results by GET /api/search"] });
  });
});

describe("compare: a redaction is never a difference (AGENT.md §5.1)", () => {
  it("[redacted] equals any value, alone or inside a summary; the rest of the summary still counts", () => {
    expect(sameValue("[redacted]", '"wE3kfQ8"')).toBe(true);
    expect(sameValue('"wEkfQq"', "[redacted]")).toBe(true);
    expect(sameValue("{id: 1, requestId: [redacted], status: \"fulfilled\"}", '{id: 1, requestId: "abc", status: "fulfilled"}')).toBe(true);
    expect(sameValue("{id: 1, requestId: [redacted], status: \"fulfilled\"}", '{id: 2, requestId: "abc", status: "fulfilled"}')).toBe(false);
    expect(sameValue("{id: 1, requestId: [redacted]}", '{id: 1, requestId: "abc", status: "pending"}')).toBe(false);
    expect(sameValue('"a"', '"b"')).toBe(false);
  });

  it("an opaque id redacted in the baselines and plain in a seeded run (it had no digit) is no race", () => {
    const base = snap({ "AuthProvider.external2.requestId": "[redacted]", "AuthProvider.external2.status": '"fulfilled"' }, ["Home"]);
    const g = compareRuns(session(base, [snap({ "AuthProvider.external2.requestId": '"pXkqLmZaRtWbYcNdQeVfG"', "AuthProvider.external2.status": '"fulfilled"' }, ["Home"])]))[0];
    expect(g.diffs).toEqual([]);
    // and between the baselines: a redaction flip is not noise either, so the field stays compared
    const flip = compareRuns([run("fifo", [click], base), run("fifo", [click], snap({ "AuthProvider.external2.requestId": '"pXkq"', "AuthProvider.external2.status": '"fulfilled"' }, ["Home"])), run("seeded", [click], snap({ "AuthProvider.external2.requestId": "[redacted]", "AuthProvider.external2.status": '"pending"' }, ["Home"]))])[0];
    expect(flip.noise).toEqual([]);
    expect(flip.diffs[0].fields.map((f) => f.name)).toEqual(["AuthProvider.external2.status"]);
  });

  it("many redactions in a row cost next to nothing, whatever the page sends (second review of PR 168)", () => {
    const t0 = Date.now();
    expect(sameValue("[redacted][redacted][redacted][redacted][redacted]!", "a".repeat(199))).toBe(false);
    expect(sameValue(`{${"[redacted]".repeat(20)}}`, `{${"a".repeat(198)}!`)).toBe(false);
    expect(sameValue("[redacted], [redacted], [redacted]", '"a", b, c')).toBe(true);
    expect(sameValue("[redacted][redacted]", "ab")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("records pooled under fresh ids match with a redacted value among them", () => {
    const a = snap({ "subs.aK3x.token": "[redacted]", "subs.aK3x.n": "1", "x.y": "1" });
    const b = snap({ "subs.Q9pz.token": '"plain"', "subs.Q9pz.n": "1", "x.y": "1" });
    const c = snap({ "subs.Zt7m.token": '"other"', "subs.Zt7m.n": "1", "x.y": "1" });
    expect(compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], c)])[0].diffs).toEqual([]);
  });
});

describe("compare: scenario grouping (AGENT.md §5.1)", () => {
  const empty = snap({}, ["Saved"]);

  it("typed digits are blanked: a title unique to each run is one scenario", () => {
    const runs = [0, 1, 2, 3].map((i) => run(i < 2 ? "fifo" : "seeded", [act(0, "type", 'textbox "title"', `React guide 1 edit ${i + 1} ${12345 + i * 777}`), act(1, "click", 'button "Save"', undefined, { clicks: 2 })], empty));
    const { grouping, groups } = groupRuns(runs);
    expect(grouping).toBe("names");
    expect(groups.size).toBe(1);
    expect(compareRuns(runs)[0].compared).toBe(2);
  });

  it("a parenthesised count in a label, and a typing burst split when that label changed, are one scenario", () => {
    const one = [act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author (1)"', "re")];
    const split = [act(0, "click", 'combobox "author (1)"'), act(1, "type", 'combobox "author"', "r"), act(2, "type", 'combobox "author (1)"', "re")];
    expect(scenarioOf(run("fifo", one, empty), "names")).toBe(scenarioOf(run("fifo", split, empty), "names"));
    const runs = [run("fifo", one, empty), run("fifo", split, empty), run("seeded", one, empty), run("seeded", split, empty)];
    const g = compareRuns(runs);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ grouping: "names", compared: 2 });
    // the exact recording is what the report shows; the key is the normalised one
    expect(g[0].scenario).toBe('click combobox "author"\ntype combobox "author (1)" = re');
    expect(g[0].scenarioKey).toBe('click combobox "author"\ntype combobox "author" = re');
  });

  it("names that changed with the order fall back to action kinds and element roles, then to kinds alone", () => {
    const sort = (t: string) => [act(0, "click", 'div "TITLE"'), act(1, "click", t)];
    const roles = [run("fifo", sort('div "RANK"'), empty), run("fifo", sort('div "RANK"'), empty), run("seeded", sort('span "RANK"'), empty), run("seeded", sort('div "RANK"'), empty)];
    expect(compareRuns(roles)[0]).toMatchObject({ grouping: "roles", compared: 2, scenario: 'click div "TITLE"\nclick div "RANK"' });
    const kinds = [run("fifo", sort('columnheader "RANK"'), empty), run("fifo", sort('columnheader "RANK"'), empty), run("seeded", sort('span "RANK"'), empty)];
    expect(compareRuns(kinds)[0]).toMatchObject({ grouping: "kinds", compared: 1 });
  });

  it("the finest grouping that compares every comparable run wins; other routes and other steps stay apart", () => {
    const runs = [run("fifo", [click], empty), run("fifo", [click], empty), run("seeded", [click], empty), run("seeded", [act(0, "type", 'input "Search"', "x")], empty), run("seeded", [click], empty, { page: { url: "http://localhost:5173/other", route: "/other" } })];
    const g = compareRuns(runs);
    expect(g[0].grouping).toBe("names");
    expect(g.find((x) => x.route === "/list" && x.baselines.length === 2)!.compared).toBe(1);
    expect(g.filter((x) => x.compared === 0)).toHaveLength(2);
  });

  it("a replay with a label that changed with the order did the same steps", () => {
    const a = run("seeded", [act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author"', "re")], empty);
    const b = run("seeded", [act(0, "click", 'combobox "author (1)"'), act(1, "type", 'combobox "author (1)"', "re")], empty);
    const c = run("seeded", [act(0, "click", 'button "Delete"')], empty);
    expect(sameScenario(a, b)).toBe(true);
    expect(sameScenario(a, c)).toBe(false);
  });
});

describe("compare: snapshots that left store fields out (AGENT.md §2)", () => {
  it("a field missing from a snapshot that left fields out was not compared; the group says so", () => {
    const base = snap({ "a.x": "1", "z.deep.field": "2" }, ["Home"], { stateLeft: 40, stateTotal: 1040 });
    const cut = snap({ "a.x": "1" }, ["Home"], { stateLeft: 41, stateTotal: 1041 });
    const g = compareRuns(session(base, [cut]))[0];
    expect(g.diffs).toEqual([]);
    expect(g.truncated).toEqual({ runs: 3, left: 41, total: 1041 });
    // without a cut, a missing field is a difference (internal: the page is the same)
    const whole = compareRuns(session(snap({ "a.x": "1", "z.deep.field": "2" }, ["Home"]), [snap({ "a.x": "1" }, ["Home"])]))[0];
    expect(whole.diffs[0]).toMatchObject({ tier: "internal", fields: [{ where: "state", name: "z.deep.field", baseline: "2", run: "(absent)" }] });
    expect(whole.truncated).toBeUndefined();
  });
});

describe("compare: an age is one line within how long the session ran; nothing else moves on its own (AGENT.md §5.1)", () => {
  /** Baselines and a seeded run, the session lasting `ms` by the bridge's clock. */
  const timed = (base: string, later: string, ms = 0) => {
    const at = (t: number) => ({ started: t, lastSeen: t });
    return compareRuns([run("fifo", [click], snap({}, [base]), at(0)), run("fifo", [click], snap({}, [base]), at(ms / 2)), run("seeded", [click], snap({}, [later]), at(ms))])[0];
  };

  it("two baselines inside one minute and a run a minute later show the same page", () => {
    const g = timed("Edited 13 minutes ago", "Edited 14 minutes ago");
    expect(g.diffs).toEqual([]);
    expect(g.noise).toEqual([]);
  });

  it.each([
    ["13 minutes ago", "14 minutes ago"],
    ["26 minutes ago", "27 minutes ago"],
    ["59 minutes ago", "an hour ago"],
    ["44 minutes ago", "an hour ago"],
    ["a few seconds ago", "a minute ago"],
    ["just now", "a minute ago"],
    ["10m ago", "11m ago"],
    ["Basic Auth | Last updated 14 minutes ago | Created 4 November", "Basic Auth | Last updated 15 minutes ago | Created 4 November"],
    ["Created 3 days ago, edited 5 minutes ago", "Created 3 days ago, edited 6 minutes ago"],
  ])("%s against %s is one line", (a, b) => {
    expect(timed(a, b).diffs).toEqual([]);
  });

  it.each([
    ["just now", "3 days ago"],
    ["Last synced just now", "Last synced 3 days ago"],
    ["Deployed 2 minutes ago", "Deployed 9 months ago"],
    ["3 minutes ago", "an hour ago"],
    ["Order 456 placed 5 minutes ago", "Order 123 placed 3 minutes ago"],
    ["2 hours ago", "3 hours ago"],
  ])("%s against %s stays two lines", (a, b) => {
    expect(timed(a, b).diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: [a], textOnlyRun: [b] });
  });

  it("the tolerance is how long the session ran, plus the minute an age rolls over in", () => {
    expect(timed("Edited 3 minutes ago", "Edited 6 minutes ago").diffs[0]).toMatchObject({ tier: "visible" });
    expect(timed("Edited 3 minutes ago", "Edited 6 minutes ago", 150_000).diffs).toEqual([]);
    expect(timed("Edited 3 minutes ago", "Edited 6 minutes ago", 90_000).diffs[0]).toMatchObject({ tier: "visible" });
    const now = { min: 0, max: 0 };
    expect(sameAges(agesIn("26 minutes ago")!.ages, agesIn("27 minutes ago")!.ages, now)).toBe(true);
    expect(sameAges(agesIn("just now")!.ages, agesIn("3 days ago")!.ages, { min: 3_600_000, max: 3_600_000 })).toBe(false);
  });

  // what reads like a time and is a value a page can get wrong: main reports each, and so does this (review of PR 168)
  it.each([
    ["Your appointment: 4:00 PM", "Your appointment: 3:30 PM"],
    ["Departs 16:45 from gate 7", "Departs 14:30 from gate 7"],
    ["Length 4:12", "Length 3:45"],
    ["16:45", "14:30"],
    ["John 3:17", "John 3:16"],
    ["Score 21:18", "Score 21:15"],
    ["Arrives tomorrow", "Arrives today"],
    ["yesterday", "today"],
    ["Orders from last month", "Orders from last week"],
    ["Ships in 5 days", "Ships in 2 days"],
    ["Paid off in 6 months", "Paid off in 12 months"],
    ["Renews in 1 year", "Renews in 30 days"],
    ["5d", "3d"],
    ["15m", "10m"],
    ["14d", "12d"],
    ["7m", "8m"],
    ["Today at 3:27 PM", "Today at 3:28 PM"],
    ["version-1", "version-2"],
    ["2M", "3M"],
    ["Created 4 November", "Created 5 November"],
    ["3 min read", "4 min read"],
    ["Buy now", "Buy later"],
    ["Room 5m wide", "Room 6m wide"],
  ])("%s against %s is a race", (a, b) => {
    expect(agesIn(a)).toBeNull();
    expect(compareRuns(session(snap({}, ["Header", a]), [snap({}, ["Header", b]), snap({}, ["Header", a])]))[0].diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: [a], textOnlyRun: [b] });
  });

  it("a clock, a day and a short age are noise when the baselines themselves show them moving", () => {
    for (const [a, b, c] of [["Today at 3:27 PM", "Today at 3:28 PM", "Today at 3:29 PM"], ["7m", "8m", "9m"]]) {
      const g = compareRuns([run("fifo", [click], snap({}, [a])), run("fifo", [click], snap({}, [b])), run("seeded", [click], snap({}, [c]))])[0];
      expect(g.diffs).toEqual([]);
    }
  });

  it("one row more is a difference, and the report quotes the page's own words", () => {
    const g = compareRuns(session(snap({}, ["Edited 3 minutes ago"]), [snap({}, ["Edited 4 minutes ago", "Edited 5 minutes ago"])]))[0];
    expect(g.diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: [], textOnlyRun: ["Edited 5 minutes ago"] });
  });

  it("an age only moves forward, by about the time between two loads (second review of PR 168)", () => {
    // ten minutes on, an age can be ten minutes older, and not ten minutes younger
    expect(timed("Edited 2 minutes ago", "Edited 12 minutes ago", 600_000).diffs).toEqual([]);
    expect(timed("Edited 12 minutes ago", "Edited 2 minutes ago", 600_000).diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: ["Edited 12 minutes ago"], textOnlyRun: ["Edited 2 minutes ago"] });
    // and ten minutes on, one that stayed where it was has not moved: the page was not read then either
    const rendered = timed("Edited 2 minutes ago", "Edited 2 minutes ago", 600_000);
    expect(rendered.diffs).toEqual([]);
  });

  it("how long the runs' own loads took decides, not when the bridge last heard from them (second review of PR 168)", () => {
    const at = (started: number, lastSeen: number, t = 1000) => ({ started, lastSeen, snapshot: { t, state: {}, text: [] as string[], requests: {}, witnesses: 0, errors: 0, forced: 0 } });
    const page = (text: string, o: ReturnType<typeof at>) => ({ ...o, snapshot: { ...o.snapshot, text: [text] } });
    const session = (lastSeen: number) => [run("fifo", [click], snap({}, []), page("Edited 3 minutes ago", at(0, lastSeen))), run("fifo", [click], snap({}, []), page("Edited 3 minutes ago", at(5_000, lastSeen))), run("seeded", [click], snap({}, []), page("Edited 40 minutes ago", at(10_000, lastSeen)))];
    // reported an hour later, or a tab that keeps talking: the same race
    expect(compareRuns(session(11_000))[0].diffs[0].tier).toBe("visible");
    expect(compareRuns(session(3_600_000))[0].diffs[0].tier).toBe("visible");
  });

  it.each([
    ["Deleted 2 hours and 5 minutes ago", "Deleted 17 hours and 5 minutes ago"],
    ["Deleted 2 hours, 5 minutes ago", "Deleted 17 hours, 5 minutes ago"],
    ["1,000 days ago", "5 days ago"],
    ["2 days ago", "1,002 days ago"],
    ["a few years ago", "9 years ago"],
    ["a month ago", "40 days ago"],
    ["a few minutes ago", "30 minutes ago"],
    ["Updated minutes ago", "Updated hours ago"],
  ])("%s against %s are two ages (second review of PR 168)", (a, b) => {
    expect(agesIn(a)).not.toBeNull();
    expect(timed(a, b, 10_000).diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: [a], textOnlyRun: [b] });
  });

  it("the parts of an age are read as written", () => {
    expect(agesIn("2 hours and 5 minutes ago")!.ages).toEqual([{ lo: 7_500_000, hi: 7_500_000 }]);
    expect(agesIn("1,000 days ago")!.ages).toEqual([{ lo: 86_400_000_000, hi: 86_400_000_000 }]);
    expect(agesIn("1.5 hours ago")!.ages).toEqual([{ lo: 5_400_000, hi: 5_400_000 }]);
    expect(agesIn("Sand and water ago")).toBeNull();
  });

  it("a list whose rows all moved a minute pairs row by row, and a wrong row stands out", () => {
    const rows = (...n: number[]) => snap({}, n.map((m) => `Edited ${m} minutes ago`));
    expect(compareRuns(session(rows(2, 30, 60), [rows(3, 31, 61)]))[0].diffs).toEqual([]);
    expect(compareRuns(session(rows(2, 30, 60), [rows(3, 31, 200)]))[0].diffs[0]).toMatchObject({ textOnlyBaseline: ["Edited 60 minutes ago"], textOnlyRun: ["Edited 200 minutes ago"] });
  });

  it("an element named with an age is one scenario", () => {
    expect(ageless('button "Switch two a few seconds ago"')).toBe(ageless('button "Switch two a minute ago"'));
    const named = (t: string) => [act(0, "click", `button "Switch two ${t}"`)];
    const runs = [run("fifo", named("a few seconds ago"), snap({}, ["x"])), run("fifo", named("a minute ago"), snap({}, ["x"])), run("seeded", named("2 minutes ago"), snap({}, ["x"]))];
    expect(compareRuns(runs)[0]).toMatchObject({ grouping: "names", compared: 1 });
  });
});

describe("compare: a POST count alone is no race without evidence of a write (AGENT.md §5.1)", () => {
  const counts = (n?: number) => snap({}, ["Same page"], { requests: n === undefined ? {} : { "POST /api/worktree/refresh": n } });
  const send = (t: number, key: string, extra: Partial<Extract<Step, { k: "send" }>> = {}): Step => ({ k: "send", t, key, ...extra });

  it("a read-only POST sent a different non-zero number of times, with the page the same, is internal", () => {
    const g = compareRuns(session(counts(3), [counts(2), counts(4)]))[0];
    expect(g.diffs.map((d) => d.tier)).toEqual(["internal", "internal"]);
    expect(shownField(g.diffs[0].fields[0])).toBe(false);
  });

  it("a POST the baselines send and a run never does, or only a run sends, stays a race (a lost save behind a request)", () => {
    const lost = compareRuns(session(counts(1), [counts()]))[0].diffs[0];
    expect(lost).toMatchObject({ tier: "visible", fields: [{ where: "requests", name: "POST /api/worktree/refresh", baseline: "1", run: "(absent)", evidence: "the baseline sends it and this run never does" }] });
    const extra = compareRuns(session(counts(), [counts(1)]))[0].diffs[0];
    expect(extra).toMatchObject({ tier: "visible", fields: [{ baseline: "(absent)", run: "1", evidence: "only this run sends it" }] });
    // sent through another request, as the page that lost its save did, it is the same
    const via = [click, send(10, "POST /api/worktree/refresh#1", { act: 0, via: "GET /api/config" })];
    expect(compareRuns([run("fifo", via, counts(1)), run("fifo", via, counts(1)), run("seeded", [click], counts())])[0].diffs[0].tier).toBe("visible");
  });

  it("the same count in a request the app sent from a response or a timer is internal too", () => {
    const via = [click, send(10, "POST /api/worktree/refresh#1", { act: 0, via: "GET /api/list" })];
    const more = [...via, send(20, "POST /api/worktree/refresh#2", { act: 0, via: "timer 0ms" })];
    expect(compareRuns([run("fifo", via, counts(1)), run("fifo", via, counts(1)), run("seeded", more, counts(2))])[0].diffs[0].tier).toBe("internal");
  });

  it("a double submit: two identical requests in flight are a write, whatever the page shows", () => {
    const runs = session(counts(1), [counts(2)]);
    runs[2].witnesses.push({ kind: "identical-in-flight", t: 1, subject: "POST /api/worktree/refresh", by: "POST /api/worktree/refresh#2", over: "POST /api/worktree/refresh#1", overKind: "request" });
    const d = compareRuns(runs)[0].diffs[0];
    expect(d.tier).toBe("visible");
    expect(d.fields[0].evidence).toBe("two identical requests in flight");
  });

  it("a double submit that never overlaps: a user action sent it directly more times than in the baseline", () => {
    const once = [click, send(10, "POST /api/orders#1", { act: 0 })];
    const twice = [click, send(10, "POST /api/orders#1", { act: 0 }), act(1, "click", 'link "Next page"'), send(90, "POST /api/orders#2", { act: 1 })];
    const c = (n: number) => snap({}, ["Same page"], { requests: { "POST /api/orders": n } });
    const d = compareRuns([run("fifo", once, c(1)), run("fifo", once, c(1)), run("seeded", twice, c(2))])[0];
    expect(d.compared).toBe(1);
    expect(d.diffs[0].tier).toBe("visible");
    expect(d.diffs[0].fields[0].evidence).toContain("directly 2 time(s), 1 in the baseline");
  });

  it("a write a run lost (the user's own request never went) is a difference too", () => {
    const sent = [click, send(10, "POST /api/orders#1", { act: 0 })];
    const c = (n?: number) => snap({}, ["Same page"], { requests: n ? { "POST /api/orders": n } : {} });
    expect(compareRuns([run("fifo", sent, c(1)), run("fifo", sent, c(1)), run("seeded", [click], c())])[0].diffs[0].tier).toBe("visible");
  });

  it("PUT, PATCH and DELETE counts stay what the page sends", () => {
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      const c = (n: number) => snap({}, ["Same page"], { requests: { [`${m} /api/doc`]: n } });
      expect(compareRuns(session(c(1), [c(2)]))[0].diffs[0].tier).toBe("visible");
    }
  });
});

describe("compare: generated field names compare with themselves (AGENT.md §5.1)", () => {
  it.each([
    ["el-id-2476-32", "el-id-*-32"],
    ["a4c96c66-7e2d-4492-8fdc-a0ae74f21c69-input", "*-input"],
    [":r1a:", "*"],
    ["radix-:r3:-trigger", "radix-*-trigger"],
    ["field_abc123", "field_*"],
    ["Notes a4c96c66-7e2d-4492-8fdc-a0ae74f21c69", "Notes *"],
  ])("%s has the shape %s", (name, shape) => expect(fieldShape(name)).toBe(shape));

  it.each(["Address line 2", "address-2", "Search flows...", "input", "phone2", "What would you like to modify or add?"])("%s is a label or a small number: as it is", (name) => expect(fieldShape(name)).toBe(name));

  // a name that looks generated and is the same in both baselines is a name (review of PR 168): main reports each swap
  it.each([
    [{ "qty-100": "1", "qty-200": "2" }, { "qty-100": "2", "qty-200": "1" }],
    [{ "qty-100": "1", "qty-200": "2" }, { "qty-100": "3", "qty-200": "2" }],
    [{ user_ab12cd: "Alice", user_cd34ef: "Bob" }, { user_ab12cd: "Bob", user_cd34ef: "Alice" }],
    [{ ":r1:": "billing@x", ":r2:": "shipping@x" }, { ":r1:": "shipping@x", ":r2:": "billing@x" }],
    [{ "el-id-2476-32": "one" }, { "el-id-9999-32": "two" }],
    [{ "Address line 2": "A" }, { "Address line 2": "B" }],
  ])("fields %j against %j are a race", (a, b) => {
    const page = (fields: Record<string, string>) => snap({}, ["Page"], { fields });
    expect(compareRuns(session(page(a), [page(b)]))[0].diffs[0].tier).toBe("visible");
  });

  it("a name both baselines have stays a name when a new row beside it differs (second review of PR 168)", () => {
    const page = (fields: Record<string, string>) => snap({}, ["Page"], { fields });
    const a = page({ "qty-100": "1", "qty-200": "2", "qty-9001": "3" });
    const b = page({ "qty-100": "1", "qty-200": "2", "qty-9002": "3" });
    const swap = compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], page({ "qty-100": "2", "qty-200": "1", "qty-9003": "3" }))])[0];
    expect(swap.diffs[0].tier).toBe("visible");
    expect(swap.diffs[0].fields.map((f) => f.name)).toEqual(["qty-100", "qty-200"]);
    // the new row's value noisy too: its own shape is noise, and a wrong qty-100 is not
    const noisy = compareRuns([run("fifo", [click], a), run("fifo", [click], page({ "qty-100": "1", "qty-200": "2", "qty-9002": "9" })), run("seeded", [click], page({ "qty-100": "7", "qty-200": "2", "qty-9003": "3" }))])[0];
    expect(noisy.noise).toEqual(["field qty-*"]);
    expect(noisy.diffs[0].fields).toEqual([{ where: "field", name: "qty-100", baseline: "1", run: "7" }]);
    // and the new rows still compare with each other, by value, without the rows that stayed
    const same = compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], page({ "qty-100": "1", "qty-200": "2", "qty-9003": "3" }))])[0];
    expect(same.diffs).toEqual([]);
    const wrong = compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], page({ "qty-100": "1", "qty-200": "2", "qty-9003": "8" }))])[0].diffs[0].fields[0];
    expect(wrong).toEqual({ where: "field", name: "qty-*", baseline: "3", run: "8", except: ["qty-100", "qty-200"] });
    expect(fieldValue({ "qty-100": "1", "qty-200": "2", "qty-9004": "8" }, "qty-*", wrong.except)).toBe("8");
  });

  it("a replay reads a field by its name first, then by its shape", () => {
    expect(fieldValue({ "qty-100": "1", "qty-200": "2" }, "qty-100")).toBe("1");
    expect(fieldValue({ "Name*": "x" }, "Name*")).toBe("x");
    expect(fieldValue({ "el-id-1234-32": "x" }, "el-id-*-32")).toBe("x");
  });

  it("a field made for this load is the same field in the next", () => {
    const fields = (id: string, uuid: string, v = "unchecked") => snap({}, ["Page"], { fields: { [`el-id-${id}-32`]: v, [`${uuid}-input`]: "## note" } });
    const a = fields("2476", "a4c96c66-7e2d-4492-8fdc-a0ae74f21c69");
    const b = fields("6882", "a1248d55-c1d6-4b61-81cc-eb485d53044e");
    const c = fields("611", "2dfbe8ca-6dcb-47a6-8b60-52a489ebedf5");
    const g = compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], c)])[0];
    expect(g.diffs).toEqual([]);
    expect(g.noise).toEqual([]);
    // and its value still counts
    const d = fields("4156", "06990567-774d-455a-a865-e36a1a23d74f", "checked");
    expect(compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], d)])[0].diffs[0]).toMatchObject({ tier: "visible", fields: [{ where: "field", name: "el-id-*-32", baseline: "unchecked", run: "checked" }] });
  });

  it("fields of one shape pool their values, and a replay reads them back the same way", () => {
    expect(fieldValue({ "el-id-1-32": "a", "x-1234-input": "b", "x-5678-input": "a" }, "x-*-input")).toBe("[a | b]");
    expect(fieldValue({ "x-1234-input": "b" }, "x-*-input")).toBe("b");
    expect(fieldValue({ other: "b" }, "x-*-input")).toBeUndefined();
    const notes = (a: string, b: string, u: string, v: string) => snap({}, ["Page"], { fields: { [`${u}-input`]: a, [`${v}-input`]: b } });
    const u = ["a4c96c66-7e2d-4492-8fdc-a0ae74f21c69", "a1248d55-c1d6-4b61-81cc-eb485d53044e", "2dfbe8ca-6dcb-47a6-8b60-52a489ebedf5", "06990567-774d-455a-a865-e36a1a23d74f", "7e4645cb-210e-48b1-9f17-8233dc03b5ee", "740a74eb-9d5a-4f21-97b4-e3c746ef0b99"];
    const g = compareRuns([run("fifo", [click], notes("x", "y", u[0], u[1])), run("fifo", [click], notes("y", "x", u[2], u[3])), run("seeded", [click], notes("x", "y", u[4], u[5]))])[0];
    expect(g.diffs).toEqual([]);
  });

  it("two labels that differ in a number stay two fields", () => {
    const a = snap({}, ["Page"], { fields: { "Address line 1": "a", "Address line 2": "b" } });
    const b = snap({}, ["Page"], { fields: { "Address line 1": "b", "Address line 2": "a" } });
    expect(compareRuns(session(a, [b]))[0].diffs[0].fields.map((f) => f.name)).toEqual(["Address line 1", "Address line 2"]);
  });
});

describe("compare: a baseline with no added delay (AGENT.md §5.1)", () => {
  const delay = { minMs: 0, maxMs: 600 };
  const slowRun = (s: Snapshot, label = "slow") => run("fifo", [click], s, { schedule: { order: "fifo", delay, label } });
  const plainRun = (s: Snapshot) => run("fifo", [click], s, { schedule: { order: "fifo", label: "baseline without added delay" } });
  const seed = (s: Snapshot, label = "seed") => run("seeded", [click], s, { schedule: { order: "seeded", seed: 1, delay, label } });
  const page = (...text: string[]) => snap({}, text);

  it("a bug that needs only a slow response: both slow baselines show it, the correct runs are not listed as racing", () => {
    const wrong = page("Mango note", "Maple note");
    const right = page("Mango note");
    const g = compareRuns([slowRun(wrong, "baseline 1"), slowRun(wrong, "baseline 2"), plainRun(right), seed(right), seed(right), seed(wrong)])[0];
    expect(g.baselines).toHaveLength(2);
    expect(g.plainBaseline).toBeDefined();
    expect(g.compared).toBe(3);
    // the runs like the plain baseline, and the run like the slow ones, are one of the two known endings
    expect(g.diffs).toEqual([]);
    expect(g.delay).toMatchObject({ tier: "visible", of: 2, differing: 2, label: "baseline 1", textOnlyRun: ["Maple note"], textOnlyBaseline: [] });
  });

  it("with no difference from the plain baseline there is nothing to say, and a seeded difference is a race as ever", () => {
    const ok = page("Results for react");
    const g = compareRuns([slowRun(ok), slowRun(ok), plainRun(ok), seed(page("Results for reac")), seed(ok)])[0];
    expect(g.delay).toBeUndefined();
    expect(g.diffs).toHaveLength(1);
    expect(g.diffs[0]).toMatchObject({ tier: "visible", textOnlyRun: ["Results for reac"] });
  });

  it("a run unlike both is listed against what it differs from", () => {
    const g = compareRuns([slowRun(page("A", "wrong")), slowRun(page("A", "wrong")), plainRun(page("A")), seed(page("A", "third"))])[0];
    expect(g.diffs[0]).toMatchObject({ tier: "visible", textOnlyRun: ["third"] });
    expect(g.diffs[0].textOnlyBaseline).toEqual([]);
  });

  it("one slow baseline unlike the plain one is one load against one load: noise, named apart, no race", () => {
    const stale = page("draft-one");
    const fresh = page("draft-two");
    const g = compareRuns([slowRun(stale, "baseline 1"), slowRun(fresh, "baseline 2"), plainRun(fresh), seed(stale, "seed 1"), seed(fresh, "seed 2")])[0];
    expect(g.delay).toBeUndefined();
    expect(g.diffs).toEqual([]);
    expect(g.look?.lines).toEqual([{ text: "draft-one", only: "slow", runs: 1 }, { text: "draft-two", only: "plain", runs: 1 }]);
  });

  it("a correct page with a random two-value tip: no race, whichever way it fell (review of PR 168)", () => {
    const a = page("Home", "Tip: press save often");
    const b = page("Home", "Tip: drag and drop files");
    for (const runs of [
      [slowRun(a), slowRun(b), plainRun(a), seed(a), seed(b), seed(b)],
      [slowRun(b), slowRun(a), plainRun(a), seed(a), seed(b), seed(b)],
    ]) {
      const g = compareRuns(runs)[0];
      expect(g.delay).toBeUndefined();
      expect(g.diffs).toEqual([]);
      expect(g.look?.lines.map((l) => l.text).sort()).toEqual(["Tip: drag and drop files", "Tip: press save often"]);
    }
  });

  it("three values are noise (a clock, an id, a random tip): nothing to name", () => {
    const tips = compareRuns([slowRun(page("Tip: press save often")), slowRun(page("Tip: drag and drop files")), plainRun(page("Tip: use the keyboard")), seed(page("Tip: press save often"))])[0];
    expect(tips.delay).toBeUndefined();
    expect(tips.look).toBeUndefined();
    const three = compareRuns([slowRun(page("Run brisk-1")), slowRun(page("Run brisk-2")), plainRun(page("Run brisk-3")), seed(page("Run brisk-4"))])[0];
    expect(three.delay).toBeUndefined();
    expect(three.diffs).toEqual([]);
    const counter = compareRuns([slowRun(page("3")), slowRun(page("4")), plainRun(page("4")), seed(page("5"))])[0];
    expect(counter.delay).toBeUndefined();
    expect(counter.diffs).toEqual([]);
  });

  it("a line one slow baseline shows, content or a label, and an error only it had: noise, named apart", () => {
    const line = compareRuns([slowRun(page("Home", "Flow creation error")), slowRun(page("Home")), plainRun(page("Home")), seed(page("Home", "Flow creation error")), seed(page("Home"))])[0];
    expect(line.delay).toBeUndefined();
    expect(line.diffs).toEqual([]);
    expect(line.look?.lines).toEqual([{ text: "Flow creation error", only: "slow", runs: 1 }]);
    const label = compareRuns([slowRun(page("Home", "docs/")), slowRun(page("Home")), plainRun(page("Home")), seed(page("Home"))])[0];
    expect(label.noise).toEqual(['text "docs/"']);
    expect(label.delay).toBeUndefined();
    const oops = (r: Run) => {
      r.errors.push({ t: 1, name: "ResizeObserver", message: "loop completed", chain: [] });
      return r;
    };
    const error = compareRuns([oops(slowRun(page("Home"))), slowRun(page("Home")), plainRun(page("Home")), oops(seed(page("Home")))])[0];
    expect(error.delay).toBeUndefined();
    expect(error.diffs).toEqual([]);
    expect(error.look?.errors).toEqual(["loop completed"]);
  });

  it("an error in both slow baselines and not the plain one is what a slow response does", () => {
    const oops = (r: Run) => {
      r.errors.push({ t: 1, name: "AxiosError", message: "status code 400", chain: [] });
      return r;
    };
    const g = compareRuns([oops(slowRun(page("Home"))), oops(slowRun(page("Home"))), plainRun(page("Home")), oops(seed(page("Home")))])[0];
    expect(g.delay).toMatchObject({ differing: 2, of: 2, errors: ["status code 400"] });
  });

  it("a form value and a write: in both slow baselines a race, in one of them worth a look", () => {
    const f = (v: string) => snap({}, ["Page"], { fields: { Search: v } });
    const both = compareRuns([slowRun(f("reac")), slowRun(f("reac")), plainRun(f("react")), seed(f("react"))])[0];
    expect(both.delay).toMatchObject({ differing: 2, fields: [{ where: "field", name: "Search", baseline: "react", run: "reac" }] });
    expect(both.diffs).toEqual([]);
    const one = compareRuns([slowRun(f("reac")), slowRun(f("react")), plainRun(f("react")), seed(f("reac")), seed(f("react"))])[0];
    expect(one.delay).toBeUndefined();
    expect(one.noise).toEqual(["field Search"]);
    expect(one.look?.fields).toEqual([{ where: "field", name: "Search", baseline: "react", run: "reac" }]);
    const n = (c?: number) => snap({}, ["Page"], { requests: c ? { "POST /api/flows": c } : {} });
    const read = compareRuns([slowRun(n(1)), slowRun(n(2)), plainRun(n(1)), seed(n(2))])[0];
    expect(read.noise).toEqual(["requests POST /api/flows"]);
    expect(read.delay).toBeUndefined();
    expect(read.look?.fields[0]).toMatchObject({ where: "requests", name: "POST /api/flows", baseline: "1", run: "2" });
    // sent by both slow baselines and not without the delay: one side never sent it, a race
    const lost = compareRuns([slowRun(n(1)), slowRun(n(1)), plainRun(n()), seed(n())])[0];
    expect(lost.delay).toMatchObject({ differing: 2, fields: [{ where: "requests", name: "POST /api/flows", baseline: "(absent)", run: "1" }] });
    expect(lost.diffs).toEqual([]);
  });

  it("a count of writes that only changed with the delay is worth a look: a save queue sends fewer when answers are slow", () => {
    for (const m of ["POST", "PUT"]) {
      const n = (c: number) => snap({}, ["Page"], { requests: { [`${m} /api/doc`]: c } });
      const g = compareRuns([slowRun(n(2)), slowRun(n(2)), plainRun(n(4)), seed(n(2))])[0];
      expect(g.delay).toBeUndefined();
      expect(g.diffs).toEqual([]);
      expect(g.look?.writes[0]).toMatchObject({ name: `${m} /api/doc`, baseline: "4", run: "2" });
    }
    // and a seeded run that differs from the slow baselines is no less a race for looking like the plain one
    const n = (c: number) => snap({}, ["Page"], { requests: { "PUT /api/doc": c } });
    expect(compareRuns([slowRun(n(2)), slowRun(n(2)), plainRun(n(4)), seed(n(4))])[0].diffs[0].tier).toBe("visible");
  });

  it("the same direct double submit in both slow baselines and not without the delay is a race", () => {
    const steps = (k: number): Step[] => [click, ...Array.from({ length: k }, (_, i): Step => ({ k: "send", t: i + 1, key: `POST /api/save#${i + 1}`, act: i }))];
    const n = (c: number) => snap({}, ["Page"], { requests: { "POST /api/save": c } });
    const mk = (c: number, delayed: boolean) => run("fifo", steps(c), n(c), delayed ? { schedule: { order: "fifo", delay } } : { schedule: { order: "fifo" } });
    const g = compareRuns([mk(2, true), mk(2, true), mk(1, false), run("seeded", steps(2), n(2), { schedule: { order: "seeded", seed: 1, delay } })])[0];
    expect(g.delay).toMatchObject({ differing: 2, fields: [{ name: "POST /api/save", baseline: "1", run: "2" }] });
  });

  it("the plain load alone on an error page is that load's: no race, no finding, named apart (second review of PR 168)", () => {
    const ok = page("Home", "Saved");
    const g = compareRuns([slowRun(ok), slowRun(ok), plainRun(page("Home", "Saved", "Something went wrong")), seed(ok), seed(ok)])[0];
    expect(g.delay).toBeUndefined();
    expect(g.diffs).toEqual([]);
    expect(g.look?.lines).toEqual([{ text: "Something went wrong", only: "plain-alone", runs: 0 }]);
    // a form field only it has, and an error only it threw, the same
    const f = compareRuns([slowRun(ok), slowRun(ok), plainRun(snap({}, ["Home", "Saved"], { fields: { Retry: "1" } })), seed(ok)])[0];
    expect(f.delay).toBeUndefined();
    const threw = plainRun(ok);
    threw.errors.push({ t: 1, name: "Error", message: "Network down", chain: [] });
    expect(compareRuns([slowRun(ok), slowRun(ok), threw, seed(ok)])[0].delay).toBeUndefined();
    // a seeded run that shows that line is listed: the headline did not say it
    const same = compareRuns([slowRun(ok), slowRun(ok), plainRun(page("Home", "Saved", "Something went wrong")), seed(page("Home", "Saved", "Something went wrong"))])[0];
    expect(same.diffs[0]).toMatchObject({ tier: "visible", textOnlyRun: ["Something went wrong"] });
    // with a line from the slow side, it stands beside it as what the plain load shows
    const both = compareRuns([slowRun(page("Mango note", "Maple note")), slowRun(page("Mango note", "Maple note")), plainRun(page("Mango note", "All notes")), seed(page("Mango note", "All notes"))])[0];
    expect(both.delay).toMatchObject({ textOnlyRun: ["Maple note"], textOnlyBaseline: ["All notes"] });
    expect(both.diffs).toEqual([]);
  });

  it("the plain load unlike every other load: reported, and it says only that load differs (second review of PR 168)", () => {
    const ok = page("Home", "Saved");
    const alone = compareRuns([slowRun(ok), slowRun(ok), plainRun(page("Home", "Something went wrong")), seed(ok), seed(ok)])[0];
    expect(alone.delay).toMatchObject({ oneLoad: true, textOnlyRun: ["Saved"], textOnlyBaseline: ["Something went wrong"] });
    // a reordered run on its side: two loads say so
    const sided = compareRuns([slowRun(page("Lost")), slowRun(page("Lost")), plainRun(page("Saved")), seed(page("Saved")), seed(page("Lost"))])[0];
    expect(sided.delay?.oneLoad).toBeUndefined();
    // every slow load wrong and only the plain one right looks the same, which is why it stays reported
    const every = compareRuns([slowRun(page("Lost")), slowRun(page("Lost")), plainRun(page("Saved")), seed(page("Lost"))])[0];
    expect(every.delay).toMatchObject({ oneLoad: true, textOnlyRun: ["Lost"] });
  });

  it("a direct double submit is a race, and not also worth a look (second review of PR 168)", () => {
    const steps = (k: number): Step[] => [click, ...Array.from({ length: k }, (_, i): Step => ({ k: "send", t: i + 1, key: `POST /api/pay#${i + 1}`, act: i }))];
    const n = (c: number) => snap({}, ["Page"], { requests: { "POST /api/pay": c } });
    const mk = (c: number, delayed: boolean) => run("fifo", steps(c), n(c), delayed ? { schedule: { order: "fifo", delay } } : { schedule: { order: "fifo" } });
    const g = compareRuns([mk(2, true), mk(2, true), mk(1, false), run("seeded", steps(2), n(2), { schedule: { order: "seeded", seed: 1, delay } })])[0];
    expect(g.delay?.fields[0]).toMatchObject({ name: "POST /api/pay" });
    expect(g.look?.writes ?? []).toEqual([]);
  });

  it("a price one slow baseline alone shows is named, unpaired or against another price; a counter that moved a little and a symbol are not", () => {
    const price = compareRuns([slowRun(page("Home", "$12.00")), slowRun(page("Home")), plainRun(page("Home")), seed(page("Home"))])[0];
    expect(price.look?.lines).toEqual([{ text: "$12.00", only: "slow", runs: 0 }]);
    const two = compareRuns([slowRun(page("Home", "$12.00")), slowRun(page("Home", "$45.00")), plainRun(page("Home", "$45.00")), seed(page("Home", "$12.00"))])[0];
    expect(two.look?.lines).toEqual([{ text: "$12.00", only: "slow", runs: 1 }]);
    expect(compareRuns([slowRun(page("Home", "41")), slowRun(page("Home", "42")), plainRun(page("Home", "42")), seed(page("Home", "42"))])[0].look).toBeUndefined();
    expect(compareRuns([slowRun(page("Home", "·")), slowRun(page("Home")), plainRun(page("Home")), seed(page("Home"))])[0].look).toBeUndefined();
  });

  it("a number a little off from the plain one, in both slow baselines, is a counter between loads: worth a look", () => {
    for (const [slow, plain] of [["Uptime 41", "Uptime 42"], ["4,102 users online", "4,105 users online"]]) {
      const g = compareRuns([slowRun(page(slow)), slowRun(page(slow)), plainRun(page(plain)), seed(page(slow))])[0];
      expect(g.delay).toBeUndefined();
      expect(g.look?.drift).toEqual([[slow, plain]]);
    }
    // far off is a difference
    const far = compareRuns([slowRun(page("Total 41")), slowRun(page("Total 41")), plainRun(page("Total 7")), seed(page("Total 41"))])[0];
    expect(far.delay).toMatchObject({ textOnlyRun: ["Total 41"], textOnlyBaseline: ["Total 7"] });
  });

  it("without added delay every fifo run is a baseline and there is no third", () => {
    const ok = page("x");
    const g = compareRuns([run("fifo", [click], ok), run("fifo", [click], ok), run("seeded", [click], ok)])[0];
    expect(g.baselines).toHaveLength(2);
    expect(g.plainBaseline).toBeUndefined();
    expect(g.delay).toBeUndefined();
  });

  it("two slow baselines still make the verdict when the plain one did other steps", () => {
    const ok = page("x");
    const g = compareRuns([slowRun(ok), slowRun(ok), run("fifo", [act(0, "type", 'input "Other"', "x")], page("y"), { schedule: { order: "fifo" } }), seed(page("z"))]);
    const judged = g.find((x) => x.baselines.length === 2)!;
    expect(judged.compared).toBe(1);
    expect(judged.diffs[0].textOnlyRun).toEqual(["z"]);
    expect(g.find((x) => x.plainBaseline && x.missingBaseline)?.runs).toBe(1);
  });
});

describe("compare: only the tokens that varied are blanked (AGENT.md §5.1)", () => {
  const base = (l: string) => snap({}, ["Page", l]);

  it("a number that varied between the baselines hides no other token of that line", () => {
    const g = compareRuns([run("fifo", [click], base("12 items, version-1")), run("fifo", [click], base("13 items, version-1")), run("seeded", [click], base("14 items, version-1")), run("seeded", [click], base("12 items, version-2"))])[0];
    expect(g.noise).toEqual(['text "N items, version-1"']);
    expect(g.diffs).toHaveLength(1);
    expect(g.diffs[0].textOnlyRun).toEqual(["12 items, version-2"]);
  });

  it("a bare counter that varied hides neither a word with a digit nor a number both baselines show", () => {
    const page = (counter: string, other: string) => snap({}, [counter, other]);
    const words = compareRuns([run("fifo", [click], page("3", "version-1")), run("fifo", [click], page("4", "version-1")), run("seeded", [click], page("5", "version-2"))])[0];
    expect(words.diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: ["version-1"], textOnlyRun: ["version-2"] });
    const stable = compareRuns([run("fifo", [click], page("3", "12")), run("fifo", [click], page("4", "12")), run("seeded", [click], page("5", "13"))])[0];
    expect(stable.diffs[0].textOnlyBaseline).toEqual(["12"]);
  });

  it("a counter pairs with a counter, whatever order the lines came in", () => {
    const a = snap({}, ["version-1", "3"]);
    const b = snap({}, ["4", "version-2"]);
    const g = compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], snap({}, ["5", "file-9"]))])[0];
    expect(g.noise.sort()).toEqual(['text "N"', 'text "version-N"']);
    expect(g.diffs[0].textOnlyRun).toEqual(["file-9"]);
  });

  it("another number on a line that varied may drift a little, and no further (review of PR 168)", () => {
    const noiseCase = (a: string, b: string, c: string) => compareRuns([run("fifo", [click], base(a)), run("fifo", [click], base(b)), run("seeded", [click], base(c))])[0];
    expect(noiseCase("CPU 12% memory 40%", "CPU 13% memory 40%", "CPU 13% memory 41%").diffs).toEqual([]);
    expect(noiseCase("3 online, 12 open", "3 online, 13 open", "4 online, 13 open").diffs).toEqual([]);
    expect(noiseCase("Order 123 total 40", "Order 124 total 40", "Order 125 total 90").diffs[0].textOnlyRun).toEqual(["Order 125 total 90"]);
    expect(noiseCase("12 items, version-1", "13 items, version-1", "13 items, version-2").diffs[0].textOnlyRun).toEqual(["13 items, version-2"]);
    expect(noiseCase("3 results for apple", "4 results for apple", "3 results for banana").diffs[0].textOnlyRun).toEqual(["3 results for banana"]);
  });

  it("tokens of different shapes at one position stand for any token holding a digit (generated ids)", () => {
    const g = compareRuns([run("fifo", [click], base("Order a1b2c3 placed")), run("fifo", [click], base("Order 9f3 placed")), run("seeded", [click], base("Order z7 placed"))])[0];
    expect(g.diffs).toEqual([]);
    expect(g.noise).toEqual(['text "Order * placed"']);
  });

  it("a number with a comma is one number (second review of PR 168)", () => {
    const noiseCase = (a: string, b: string, c: string) => compareRuns([run("fifo", [click], base(a)), run("fifo", [click], base(b)), run("seeded", [click], base(c))])[0];
    expect(noiseCase("Total $1,000 items 3", "Total $1,000 items 4", "Total $3,000 items 4").diffs[0].textOnlyRun).toEqual(["Total $3,000 items 4"]);
    expect(noiseCase("Total $1,000 items 3", "Total $1,000 items 4", "Total $1,005 items 4").diffs).toEqual([]);
    expect(noiseCase("1,2,3 items 3", "1,2,3 items 4", "1,2,9 items 4").diffs[0].tier).toBe("visible");
  });

  it("the report writes a noisy line from the line itself, capitals and all", () => {
    const g = compareRuns([run("fifo", [click], base("New Flow 1 of Nine")), run("fifo", [click], base("New Flow 2 of Nine")), run("seeded", [click], base("New Flow 3 of Nine"))])[0];
    expect(g.noise).toEqual(['text "New Flow N of Nine"']);
    expect(g.diffs).toEqual([]);
  });

  it("a line one baseline shows and the other does not is noise as it is, not by shape", () => {
    const g = compareRuns([run("fifo", [click], base("Order 7")), run("fifo", [click], snap({}, ["Page"])), run("seeded", [click], base("Order 8"))])[0];
    expect(g.diffs[0]).toMatchObject({ tier: "visible", textOnlyRun: ["Order 8"] });
  });
});

describe("compare: the evidence in reading order (AGENT.md §5.1)", () => {
  it("lines of real content come before short labels and counts, and one run's list keeps them", () => {
    expect(["Maple note 8", "row-040", "Total 41", "Components", "New Flow (1)"].map(lineWeight)).toEqual([2, 1, 1, 1, 2]);
    expect(["41", "156k", "33%", "·", "/", "$0.00"].map(lineWeight)).toEqual([0, 0, 0, 0, 0, 0]);
    const g = compareRuns(session(snap({}, ["Home"]), [snap({}, ["Home", "41", "·", "Components", "Maple note 8"])]))[0];
    expect(g.diffs[0].textOnlyRun).toEqual(["Maple note 8", "Components", "41", "·"]);
    expect(nameDifference(g.diffs[0])).toBe('it shows "Maple note 8", which the baseline does not');
  });

  it("the name goes to the page's content, then an error, a form value, a label, a write, a count", () => {
    const base = { fields: [], textOnlyBaseline: [], textOnlyRun: [], errors: [] };
    const write = { where: "requests" as const, name: "PUT /x", baseline: "1", run: "2" };
    const form = { where: "field" as const, name: "Search", baseline: "a", run: "b" };
    expect(nameDifference({ ...base, textOnlyRun: ["41"], fields: [write] })).toContain('"PUT /x"');
    expect(nameDifference({ ...base, textOnlyBaseline: ["Components"], fields: [write] })).toContain('"Components"');
    expect(nameDifference({ ...base, textOnlyBaseline: ["Components"], fields: [form] })).toContain('"Search"');
    expect(nameDifference({ ...base, errors: ["boom"], fields: [form] })).toContain('"boom"');
    expect(nameDifference({ ...base, errors: ["boom"], textOnlyBaseline: ["Maple note 8"] })).toContain('"Maple note 8"');
  });

  it("the run that shows the page's content is read first", () => {
    const counts = { label: "counts", fields: [], textOnlyBaseline: ["41"], textOnlyRun: [], errors: [] };
    const content = { label: "content", fields: [], textOnlyBaseline: [], textOnlyRun: ["Maple note 8"], errors: [] };
    expect(strongestFirst([counts, content]).map((d) => d.label)).toEqual(["content", "counts"]);
  });
});

describe("compare: routes and optional actions (AGENT.md §5.1)", () => {
  const page = snap({}, ["Saved"]);
  const at = (route: string) => ({ page: { url: `http://localhost:5173${route}`, route } });

  it.each([
    ["/session/ses_e58736abdffeddC6WIDC8dXc3z", "/session/*"],
    ["/c/8f3a9c2e-7e2d-4492-8fdc-a0ae74f21c69", "/c/*"],
    ["/server/aHR0cDovLzEyNy4wLjAuMTo0MTEwMg/session/ses_e58736abdffeddC6WIDC8dXc3z", "/server/*/session/*"],
    ["/workflow/FlWEvnXpnxjGWWIU", "/workflow/*"],
    ["/items/123", "/items/*"],
  ])("%s has the shape %s", (route, shape) => expect(routeShape(route)).toBe(shape));

  it.each(["/", "/notes", "/settings/global-variables", "/v2/items", "/docs/GettingStarted", "/page2", "/step-1"])("%s is a place: as it is", (route) => expect(routeShape(route)).toBe(route));

  it("a page with a fresh path on every load is one group", () => {
    const ids = ["ses_e58736abdffeddC6WIDC8dXc3z", "ses_e585feb52ffemqvLUXoKnNxD72", "ses_e5a1e4c7dffe0B2xPqLwV9yT4m"];
    const g = compareRuns([run("fifo", [click], page, at(`/session/${ids[0]}`)), run("fifo", [click], page, at(`/session/${ids[1]}`)), run("seeded", [click], snap({}, ["Lost"]), at(`/session/${ids[2]}`))]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ compared: 1, route: `/session/${ids[0]}` });
    expect(g[0].diffs[0].textOnlyRun).toEqual(["Lost"]);
  });

  it("an action only some loads did does not split the session, and the grouping says so", () => {
    const keys = [act(0, "key", 'body "x"'), act(1, "key", 'body "x"')];
    const withClick = [act(0, "click", 'button "Edit here"'), ...keys];
    const g = compareRuns([run("fifo", keys, page), run("fifo", withClick, page), run("seeded", keys, page), run("seeded", withClick, page)]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ grouping: "optional", compared: 2 });
    expect(g[0].diffs).toEqual([]);
  });

  it("the same at the end of the steps, up to two actions, and never a load that did nothing", () => {
    const steps = [act(0, "click", 'button "Save"'), act(1, "click", 'button "Save"', undefined, { clicks: 2 })];
    const more = [...steps, act(2, "submit", 'form "Create"')];
    expect(compareRuns([run("fifo", steps, page), run("fifo", more, page), run("seeded", more, page)])[0]).toMatchObject({ grouping: "optional", compared: 1 });
    const far = [...steps, act(2, "submit", 'form "Create"'), act(3, "click", 'button "A"'), act(4, "click", 'button "B"')];
    expect(compareRuns([run("fifo", steps, page), run("fifo", far, page), run("seeded", far, page)]).some((x) => x.grouping === "optional")).toBe(false);
    expect(compareRuns([run("fifo", [], page), run("fifo", [click], page), run("seeded", [click], page)]).some((x) => x.grouping === "optional")).toBe(false);
  });
});

describe("compare: requests to other sites (AGENT.md §5.1)", () => {
  const count = (requests: Record<string, number>) => snap({}, ["Same page"], { requests });
  const STARS = "GET api.github.com/repos/x/y";

  it("nothing led to a safe one: left out of the counts, and named once; a write stays, whoever's it is", () => {
    const g = compareRuns(session(count({ [STARS]: 1, "POST discord.com/api/track": 1 }), [count({ [STARS]: 2, "POST discord.com/api/track": 2 })]))[0];
    expect(g.thirdParty).toEqual(["GET api.github.com/repos/x/y"]);
    expect(g.diffs[0]).toMatchObject({ tier: "internal", fields: [{ name: "POST discord.com/api/track", baseline: "1", run: "2" }] });
    // from localhost a hosted API of the page's own looks just like that: a write only one side sent is a race
    expect(compareRuns(session(count({ "POST api.example.com/orders": 1 }), [count({})]))[0].diffs[0].tier).toBe("visible");
  });

  it("a user action led to it, or the page's own origin came from its answer: it stays", () => {
    const byUser: Step[] = [click, { k: "send", t: 1, key: `${STARS}#1`, act: 0 }];
    const a = compareRuns([run("fifo", byUser, count({ [STARS]: 1 })), run("fifo", byUser, count({ [STARS]: 1 })), run("seeded", byUser, count({ [STARS]: 2 }))])[0];
    expect(a.thirdParty).toBeUndefined();
    expect(a.diffs[0].fields[0].name).toBe(STARS);
    const asked: Step[] = [click, { k: "send", t: 1, key: `${STARS}#1` }, { k: "send", t: 2, key: "GET /api/own#1", via: STARS }];
    const b = compareRuns([run("fifo", asked, count({ [STARS]: 1 })), run("fifo", asked, count({ [STARS]: 1 })), run("seeded", asked, count({ [STARS]: 2 }))])[0];
    expect(b.thirdParty).toBeUndefined();
  });

  describe("a stale write from a hosted API (second review of PR 168)", () => {
    const API = "api.acme.test";
    const page = { page: { url: "http://localhost:5173/shop", route: "/shop" } };
    const shown = (line: string, value: string, sigs: string[]) => snap({ "cart.count": value }, ["Shop", line], { requests: Object.fromEntries(sigs.map((x) => [x, 1])) });
    const writes = (keys: string[]): Step[] => [click, ...keys.flatMap((key, i): Step[] => [{ k: "send", t: i + 1, key: `${key}#1`, ...(key.startsWith("POST") ? { act: 0 } : {}) }, { k: "write", t: 10 + i, store: "s", paths: ["cart.count"], by: `${key}#1` }])];
    const over = (by: string): Run["witnesses"] => [{ kind: "overwrote-newer", t: 1, subject: "cart.count", by: `${by}#1`, over: `POST ${API}/cart/add#1`, overKind: "request" }];

    it.each([
      ["4", "3", "4", "3"],
      ["$4.00", "$3.00", "4", "3"],
      ["$45.00", "$12.00", "45", "12"],
    ])("the load's GET lands over the POST's answer: bare %s against %s is a race", (right, wrong, a, b) => {
      const GET = `GET ${API}/cart`;
      const POST = `POST ${API}/cart/add`;
      const sigs = [GET, POST];
      const g = compareRuns([run("fifo", writes([GET, POST]), shown(right, a, sigs), page), run("fifo", writes([GET, POST]), shown(right, a, sigs), page), run("seeded", writes([POST, GET]), shown(wrong, b, sigs), { ...page, witnesses: over(GET) })])[0];
      expect(g.diffs[0]).toMatchObject({ tier: "visible", textOnlyRun: [wrong] });
      expect(g.diffs[0].otherSite).toBeUndefined();
    });

    it("two different GETs writing one field, and a witness on it with one writer, are a race too", () => {
      const A = `GET ${API}/stats/fast`;
      const B = `GET ${API}/stats/slow`;
      const sigs = [A, B];
      const g = compareRuns([run("fifo", writes([A, B]), shown("41", "41", sigs), page), run("fifo", writes([A, B]), shown("41", "41", sigs), page), run("seeded", writes([B, A]), shown("40", "40", sigs), page)])[0];
      expect(g.diffs[0].tier).toBe("visible");
      const one = writes([A]);
      const withWitness = compareRuns([run("fifo", one, shown("41", "41", [A]), page), run("fifo", one, shown("41", "41", [A]), page), run("seeded", one, shown("40", "40", [A]), { ...page, witnesses: over(A) })])[0];
      expect(withWitness.diffs[0].tier).toBe("visible");
    });

    it("a count on the page that is not the field's digits stays a race, whichever field another site wrote", () => {
      const A = `GET ${API}/stars`;
      const steps = writes([A]);
      const g = compareRuns([run("fifo", steps, shown("41", "156328", [A]), page), run("fifo", steps, shown("41", "156328", [A]), page), run("seeded", steps, shown("40", "null", [A]), page)])[0];
      expect(g.diffs[0].tier).toBe("visible");
    });

    it.each(["host.docker.internal:8000", "192.168.1.10:8000", "10.0.0.5:8000", "172.20.0.2:8000", "0.0.0.0:8000", "backend:8000", "api.local:8000", "svc.internal"])("%s is the page's own network, never another site", (host) => {
      const sig = `GET ${host}/x`;
      const count = (n: number) => snap({}, ["Page"], { requests: { [sig]: n } });
      expect(compareRuns(session(count(1), [count(2)]))[0].thirdParty).toBeUndefined();
    });
  });

  it("the page's own machine, a sibling host and a write are never another site's count", () => {
    const local = "GET localhost:3000/api/x";
    expect(compareRuns(session(count({ [local]: 1 }), [count({ [local]: 2 })]))[0].thirdParty).toBeUndefined();
    const sibling = "GET api.acme.com/x";
    const on = { page: { url: "https://app.acme.com/list", route: "/list" } };
    expect(compareRuns([run("fifo", [click], count({ [sibling]: 1 }), on), run("fifo", [click], count({ [sibling]: 1 }), on), run("seeded", [click], count({ [sibling]: 2 }), on)])[0].thirdParty).toBeUndefined();
    const put = "PUT api.example.com/x";
    expect(compareRuns(session(count({ [put]: 1 }), [count({ [put]: 2 })]))[0].diffs[0].tier).toBe("visible");
  });

  it("a bare count on the page beside the store field another site's response wrote: that site answered differently", () => {
    const wrote: Step[] = [click, { k: "send", t: 1, key: `${STARS}#1` }, { k: "write", t: 2, store: "s", paths: ["stars.count"], by: `${STARS}#1` }];
    const shown = (text: string[], stars: string) => snap({ "stars.count": stars }, text, { requests: { [STARS]: 1 } });
    const d = compareRuns([run("fifo", wrote, shown(["Home", "156k"], "156328")), run("fifo", wrote, shown(["Home", "156k"], "156328")), run("seeded", wrote, shown(["Home"], "null"))])[0].diffs[0];
    expect(d).toMatchObject({ tier: "internal", otherSite: true, textOnlyBaseline: ["156k"] });
    // real content beside it stays a race, and so does a count no other site's response wrote
    const more = compareRuns([run("fifo", wrote, shown(["Home", "156k"], "156328")), run("fifo", wrote, shown(["Home", "156k"], "156328")), run("seeded", wrote, shown(["Maple note"], "null"))])[0].diffs[0];
    expect(more.tier).toBe("visible");
    const own = compareRuns([run("fifo", [click], shown(["Home", "156k"], "156328")), run("fifo", [click], shown(["Home", "156k"], "156328")), run("seeded", [click], shown(["Home"], "null"))])[0].diffs[0];
    expect(own.tier).toBe("visible");
    // two requests of one signature can answer out of order: a stale cart count from a hosted API is a race (review of PR 168)
    const CART = "GET api.example.com/cart";
    const twice: Step[] = [{ k: "send", t: 1, key: `${CART}#1` }, { k: "send", t: 2, key: `${CART}#2` }, { k: "write", t: 3, store: "cart", paths: ["cart.count"], by: `${CART}#2` }];
    const cart = (n: number) => snap({ "cart.count": String(n) }, ["Home", String(n)], { requests: { [CART]: 2 } });
    expect(compareRuns([run("fifo", twice, cart(4)), run("fifo", twice, cart(4)), run("seeded", twice, cart(3))])[0].diffs[0].tier).toBe("visible");
  });
});
