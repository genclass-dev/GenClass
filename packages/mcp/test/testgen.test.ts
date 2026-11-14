// Regression tests from findings (AGENT.md §5.3) and the text rules (§6).
import { describe, expect, it } from "vitest";
import { actionLines, locator, parseTarget, regressionTest } from "../src/testgen.js";
import { clean, pathShape, q } from "../src/text.js";
import type { Finding, Run } from "../src/types.js";
import { act } from "./helpers.js";

function run(steps: Run["steps"], url = "http://localhost:5173/search?q=1&genclass-schedule=fifo#/tab"): Run {
  return { id: "r1", started: 0, lastSeen: 0, page: { url, route: "/search" }, schedule: null, steps, lost: 0, order: ["GET /api/search#2", "GET /api/search#1"], forced: 0, witnesses: [], errors: [], detections: [], interventions: [], checks: [], expectations: [], snapshots: 1, ended: false };
}

function finding(kind: Finding["kind"], evidence: Record<string, unknown>): Finding {
  return { id: "f1", key: "k", kind, title: "t", route: "/search", count: 1, runs: ["r1"], first: 0, last: 0, evidence, replays: [], run: "r1" };
}

describe("testgen (AGENT.md §5.3)", () => {
  it("targets: the runtime's element descriptions become Playwright locators", () => {
    expect(parseTarget('button "Place order"')).toEqual({ role: "button", name: "Place order" });
    expect(locator('button "Place order"')).toBe('page.getByRole("button", { name: "Place order", exact: true }).or(page.locator("[name=\\"Place order\\"], [id=\\"Place order\\"]")).first()');
    const field = locator('input "q"');
    expect(field).toContain('page.getByLabel("q", { exact: true }).or(page.getByPlaceholder("q", { exact: true })).or(page.getByTitle("q", { exact: true }))');
    expect(field).toContain('page.locator("[name=\\"q\\"], [id=\\"q\\"]")');
    expect(locator('li "Milk"')).toBe('page.getByText("Milk", { exact: true }).first()');
    expect(locator(undefined)).toBe('page.locator("body").first()');
    expect(locator("range")).toBe('page.locator("input[type=\\"range\\"]").first()');
  });

  it("a name the runtime truncated matches by its prefix (built at run time from a string literal)", () => {
    expect(locator('link "How to fix race conditions in React app…"')).toBe('page.getByRole("link", { name: new RegExp("^How to fix race conditions in React app") }).first()');
    expect(locator('li "Price (USD) and more…"')).toBe('page.getByText(new RegExp("^Price \\\\(USD\\\\) and more")).first()');
  });

  it("actions: typing at the recorded pace, a continued burst types only the new characters, a double click, a nameless target", () => {
    const S = locator('input "Search"');
    const lines = actionLines([
      act(0, "type", 'input "Search"', "rea", { count: 3, dur: 200 }),
      act(1, "type", 'input "Search"', "react", { count: 2, dur: 50 }),
      act(2, "click", 'button "Pay"'),
      act(3, "click", 'button "Pay"', undefined, { clicks: 2 }),
      act(4, "change", 'checkbox "Gift"', "checked"),
      act(5, "type", 'input "Card"', "[redacted]"),
      act(6, "click", "button"),
    ]);
    expect(lines).toEqual([
      `await ${S}.fill("");`,
      `await ${S}.pressSequentially("rea", { delay: 100 });`,
      `await ${S}.pressSequentially("ct", { delay: 50 });`,
      `await ${locator('button "Pay"')}.dblclick();`,
      `await ${locator('checkbox "Gift"')}.check();`,
      `await ${locator('input "Card"')}.fill("example"); // the recorded value was redacted`,
      '// TODO: the recorded element "button" had no name; check that this locator finds it',
      'await page.locator("button").first().click();',
    ]);
  });

  it("a stale-write test replays the recorded order and asserts no stale overwrite on the field, whatever its record id", () => {
    const t = regressionTest(finding("stale-write", { subject: "notes.byId.8f3a9c2e.body" }), run([act(0, "type", 'searchbox "Search"', "react")]), { order: "given", given: ["GET /api/search#2", "GET /api/search#1"] })!;
    expect(t).toContain('const SCHEDULE = {"order":"given","given":["GET /api/search#2","GET /api/search#1"]};');
    expect(t).toContain('await page.goto(APP + "/search?q=1#/tab");');
    expect(t).toContain('const SUBJECT = new RegExp("^notes\\\\.byId\\\\.[^.]+\\\\.body$");');
    expect(t).toContain('w.kind === "overwrote-newer" && SUBJECT.test(w.subject)');
    expect(t).toContain('getByRole("searchbox", { name: "Search", exact: true })');
    expect(t).not.toContain("could not derive");
  });

  it("a race test asserts every kind of difference it has, and never passes asserting nothing", () => {
    const onlyRun = regressionTest(finding("race", { fields: [], textOnlyBaseline: [], textOnlyRun: ["Something went wrong"], errors: ["TypeError: x is undefined at 12"], witnesses: [] }), run([]), { order: "seeded", seed: 3 })!;
    expect(onlyRun).toContain('expect(snap.text, "the page does not show what only the failing order showed").not.toContain("Something went wrong");');
    expect(onlyRun).toContain('shape(e.message) === "TypeError: x is undefined at N"');
    const nothing = regressionTest(finding("race", { fields: [], textOnlyBaseline: [], textOnlyRun: [], errors: [], witnesses: [] }), run([]), { order: "seeded", seed: 3 })!;
    expect(nothing).toContain('expect(false, "GenClass could not derive a generic assertion');
    // what the page showed decides; store values that differed along with it (often a cache's bookkeeping) and
    // witnesses are not asserted, so the test passes once the page is right
    const base = regressionTest(finding("race", { fields: [{ where: "field", name: "Search", baseline: "react", run: "reac" }, { where: "state", name: "api.queries.search.requestId", baseline: "a1", run: "b2" }], textOnlyBaseline: ["Results for react"], textOnlyRun: [], errors: [], witnesses: ["overwrote-newer api.provided.List by GET /api/search"] }), run([]), { order: "seeded", seed: 3 })!;
    expect(base).toContain('expect(snap.fields?.["Search"], "as with responses in request order").toBe("react");');
    expect(base).toContain('expect(snap.text, "the page shows what it shows with responses in request order").toContain("Results for react");');
    expect(base).not.toContain("requestId");
    expect(base).not.toContain("api.provided");
  });

  it("a race on fresh record ids asserts the records' values; a field only the failing run had must be absent", () => {
    const t = regressionTest(finding("race", { fields: [{ where: "state", name: "todos.entities.*.title", baseline: "Buy milk", run: "Buy mil" }, { where: "state", name: "ui.error", baseline: "(absent)", run: "oops" }], textOnlyBaseline: [], textOnlyRun: [], errors: [], witnesses: [] }), run([]), { order: "seeded", seed: 2 })!;
    expect(t).toContain('expect(stateValue(snap.state, "todos.entities.*.title"), "as with responses in request order").toBe("Buy milk");');
    expect(t).toContain('expect(snap.state["ui.error"], "as with responses in request order").toBeUndefined();');
    expect(t).toContain('const re = new RegExp("^" + name.split(".").map((s) => (s === "*" ? "[^.]+" : s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"))).join("\\\\.") + "$");');
  });

  it("an error test matches the error by name and shape, so a changing number in the message cannot hide it", () => {
    const t = regressionTest(finding("error", { name: "Error", message: "Error: Order 4312 not found  " }), run([]), { order: "given", given: [] })!;
    expect(t).toContain('e.name === "Error" && shape(e.message) === "Error: Order N not found"');
  });

  it("page strings cannot break out of the generated code", () => {
    const evil = '"); require("child_process").exec("rm -rf ~"); ("';
    const t = regressionTest(finding("error", { name: "Error", message: evil }), run([act(0, "click", `button "${evil}"`)]), undefined)!;
    // every occurrence is inside a JSON string literal: the quote is escaped
    expect(t).not.toContain('("rm -rf ~"); ("');
    expect(t).toContain('\\"); require(\\"child_process\\")');
  });

  it("clean and q: printable, single line, capped, quoted, no invisible text", () => {
    expect(clean("a\u0000b\nc\u001b[2Jd‮e", 100)).toBe("a b cd e"); // an ANSI sequence is removed, other controls become a space
    expect(clean("x".repeat(300), 10)).toHaveLength(10);
    expect(q('he said "hi"\nnew line')).toBe('"he said \\"hi\\" new line"');
    expect(clean("a\u{E0041}\u{E0042}b️c")).toBe("abc");
    expect(q("ok\u{E0049}")).not.toMatch(/\uDB40/);
    expect(clean("😀".repeat(5), 3)).toBe("😀😀…");
  });

  it("pathShape blanks id-like segments only", () => {
    expect(pathShape("notes.byId.8f3a9c2e.body")).toBe("notes.byId.*.body");
    expect(pathShape("todos.entities.Zt7m9.title")).toBe("todos.entities.*.title");
    expect(pathShape("orders.42.total")).toBe("orders.*.total");
    expect(pathShape("search.results")).toBe("search.results");
    expect(pathShape("user.address2.city")).toBe("user.address2.city");
  });

  it("a field with a generated name is found by the rest of its name; a line with a relative time is no assertion", () => {
    const r = run([act(0, "click", 'button "Go"')]);
    const t = regressionTest(finding("race", { fields: [{ where: "field", name: "el-id-*-33", baseline: "default two", run: "default one" }], textOnlyBaseline: ["Edited 3 minutes ago", "Stable line"], textOnlyRun: ["an hour ago", "Stale line"] }), r, { order: "seeded", seed: 2 })!;
    expect(t).toContain('expect(fieldValue(snap.fields, "el-id-*-33"), "as with responses in request order").toBe("default two");');
    expect(t).toContain("const fieldValue = ");
    expect(t).toContain('toContain("Stable line")');
    expect(t).toContain('not.toContain("Stale line")');
    expect(t).not.toContain("minutes ago");
    expect(t).not.toContain("an hour ago");
    // the helper in the generated file compiles and finds the field whatever its generated part is
    const src = /const fieldValue = [\s\S]*?\n {2}\};/.exec(t)![0].replace(/: Record<string, string> = \{\}/, " = {}").replace(/: string\[\]/g, "").replace(/: string/g, "");
    const fieldValue = new Function(`${src}; return fieldValue;`)() as (f: Record<string, string>, n: string) => string | undefined;
    expect(fieldValue({ "el-id-6882-33": "x", other: "y" }, "el-id-*-33")).toBe("x");
    expect(fieldValue({ other: "y" }, "el-id-*-33")).toBeUndefined();
  });

  it("a field with nothing but a generated name gets a note, not a regex that matches every field (review of PR 168)", () => {
    const r = run([act(0, "click", 'button "Go"')]);
    const t = regressionTest(finding("race", { fields: [{ where: "field", name: "*", baseline: "billing@x", run: "other@x" }] }), r, { order: "seeded", seed: 2 })!;
    expect(t).not.toContain("fieldValue");
    expect(t).toContain("has only a generated name");
    expect(t).toContain("could not derive a generic assertion");
  });

  it("a line with a clock or a day in it is a value and is asserted; only an age is left out", () => {
    const r = run([act(0, "click", 'button "Go"')]);
    const t = regressionTest(finding("race", { textOnlyBaseline: ["Your appointment: 4:00 PM", "Edited 3 minutes ago"], textOnlyRun: ["Arrives today"] }), r, { order: "seeded", seed: 2 })!;
    expect(t).toContain('toContain("Your appointment: 4:00 PM")');
    expect(t).toContain('not.toContain("Arrives today")');
    expect(t).not.toContain("minutes ago");
  });
});

describe("testgen: a file an agent can run as it is (AGENT.md §5.3)", () => {
  const typing = [act(0, "type", 'searchbox "Search"', "react", { count: 5, dur: 400 })];
  const baseline = (id: string, text: string[]): Run => ({ ...run([]), id, snapshot: { t: 900, state: {}, text, requests: {}, witnesses: 0, errors: 0, forced: 0 } });

  it("opens with what it needs and the command that runs it", () => {
    const t = regressionTest(finding("stale-write", { subject: "search.results" }), run(typing), { order: "given", given: [] })!;
    const head = t.split("\n").slice(0, 2);
    expect(head[0]).toBe("// Needs @playwright/test and the app's dev server running (its dev build calls connectAgent from @genclass/runtime/agent).");
    expect(head[1]).toBe("// Run: GENCLASS_APP_URL=http://localhost:5173 npx playwright test genclass-f1.spec.ts");
  });

  it("declares only the records its assertions read, never a void line", () => {
    const stale = regressionTest(finding("stale-write", { subject: "search.results" }), run(typing), { order: "given", given: [] })!;
    expect(stale).toContain("const witnesses = await page.evaluate");
    expect(stale).not.toContain("const errors =");
    expect(stale).not.toContain("const snap =");
    expect(stale).not.toContain("void ");
    const err = regressionTest(finding("error", { name: "TypeError", message: "boom" }), run([]), { order: "given", given: [] })!;
    expect(err).toContain("const errors = await page.evaluate");
    expect(err).not.toContain("const witnesses =");
    expect(err).not.toContain("const snap =");
  });

  it("a locator used more than once is one constant", () => {
    const t = regressionTest(finding("stale-write", { subject: "search.results" }), run(typing), { order: "given", given: [] })!;
    const loc = locator('searchbox "Search"');
    expect(t).toContain(`  const searchSearchbox = ${loc};`);
    expect(t).toContain('  await searchSearchbox.fill("");');
    expect(t).toContain('  await searchSearchbox.pressSequentially("react", { delay: 100 });');
    expect(t.split(loc).length - 1).toBe(1);
    // used once: inline, no constant
    const once = regressionTest(finding("error", { name: "E", message: "m" }), run([act(0, "click", 'button "Pay now"')]), undefined)!;
    expect(once).toContain(`await ${locator('button "Pay now"')}.click();`);
    expect(once).not.toMatch(/const \w+Button = /);
  });

  it("constant names keep letters and digits only, end with the role, and never clash", () => {
    const acts = [act(0, "click", 'button "Delete"'), act(1, "click", 'button "Delete"'), act(2, "click", 'link "delete"'), act(3, "click", 'link "delete"'), act(4, "click", 'button "2024: report"'), act(5, "click", 'button "2024: report"'), act(6, "click", "switch"), act(7, "click", "switch")];
    const t = regressionTest(finding("error", { name: "E", message: "m" }), run(acts), undefined)!;
    expect(t).toContain("const deleteButton = ");
    expect(t).toContain("const deleteLink = ");
    expect(t).toContain("const el2024ReportButton = ");
    expect(t).toContain("const switchEl = ");
    const evil = '"); process.exit(1); ("';
    const e = regressionTest(finding("error", { name: "E", message: "m" }), run([act(0, "click", `button "${evil}"`), act(1, "click", `button "${evil}"`)]), undefined)!;
    expect(e).toMatch(/const processExit1Button = page\.getByRole\("button", \{ name: "\\"\); process\.exit\(1\); \(\\"", exact: true \}\)/);
  });

  it("a race test holds the page to what the baselines showed: the lines the failing run lacked, then those naming what was typed; no TODO then", () => {
    const ev = { fields: [], textOnlyBaseline: [], textOnlyRun: ["reac one"], errors: [], witnesses: [], baselines: ["r7", "r8"] };
    const base = [baseline("r7", ["Search", "Results for react", "react one", "Updated 2 minutes ago react"]), baseline("r8", ["Search", "Results for react", "react one", "Updated 3 minutes ago react"])];
    const t = regressionTest(finding("race", ev), run(typing), { order: "seeded", seed: 3 }, base)!;
    expect(t).toContain("// what the page shows with responses in request order (baseline runs r7, r8): the fixed page keeps showing it");
    expect(t).toContain('expect(snap.text, "the page shows what it shows with responses in request order").toContain("Results for react");');
    expect(t).toContain('toContain("react one")');
    expect(t).not.toContain('toContain("Search")'); // names nothing the user typed
    expect(t).not.toContain("minutes ago"); // an age is never asserted
    expect(t).toContain('not.toContain("reac one")');
    expect(t).not.toContain("TODO");
    // without the baselines (cleared), only the evidence's own lines; nothing positive: the TODO stays
    const bare = regressionTest(finding("race", ev), run(typing), { order: "seeded", seed: 3 })!;
    expect(bare).not.toContain('toContain("Results for react")');
    expect(bare).toContain("// TODO: assert what the user should see");
  });

  it("other findings keep one marked place for the domain assertion", () => {
    const t = regressionTest(finding("duplicate-request", { subject: "POST /api/pay" }), run([act(0, "click", 'button "Pay"')]), undefined)!;
    expect(t.match(/TODO/g)).toHaveLength(1);
    expect(t).toContain('// TODO: assert what the user should see after these steps, e.g. await expect(page.getByText("...")).toBeVisible();');
  });

  it("every variant is valid TypeScript", async () => {
    const { transform } = await import("esbuild");
    const ev = { fields: [{ where: "state", name: "todos.entities.*.title", baseline: "Buy milk", run: "Buy mil" }, { where: "field", name: "el-id-*-33", baseline: "a", run: "b" }], textOnlyBaseline: ["Results for react"], textOnlyRun: ["x"], errors: ["TypeError: y"], witnesses: [] };
    const variants = [
      regressionTest(finding("race", ev), run(typing), { order: "seeded", seed: 1 }, [baseline("r7", ["Results for react"])]),
      regressionTest(finding("stale-write", { subject: "a.b" }), run(typing), undefined),
      regressionTest(finding("duplicate-request", { subject: "POST /x" }), run([act(0, "click", 'button "A"'), act(1, "click", 'button "A"', undefined, { clicks: 2 })]), undefined),
      regressionTest(finding("error", { name: "E", message: 'it said "no"' }), run([act(0, "change", 'checkbox "Gift"', "checked"), act(1, "change", 'checkbox "Gift"', "unchecked")]), undefined),
    ];
    for (const v of variants) await expect(transform(v!, { loader: "ts" })).resolves.toBeTruthy();
  });
});
