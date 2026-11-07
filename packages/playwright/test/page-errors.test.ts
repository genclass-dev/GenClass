// Page errors (src/races.ts, install.ts, summarize.ts): the agent entry's records of the page's uncaught errors become
// "page-error|<name>|<op>" signatures (never the runtime's trigger "error"), keeping only the name, the message's
// shape (the same function as @genclass/mcp's shape(), checked here against it), the request nearest to the error in
// its causal chain and whether it came from the page's origin. Third-party errors are left out and counted. In the
// report they are a group of their own with no confidence and their own footer paragraph; the model's paragraph and
// note are about the model only.

import { describe, expect, it } from "vitest";
import { shape as mcpShape } from "../../mcp/src/text.js";
import { NO_REQUEST, buildRacesFile, messageShape, pageErrorFacts, pageErrorLine, requestOf, sameOriginOf, signaturesOf, thirdPartyErrors } from "../src/races.js";
import { validateRaces } from "../src/schema.js";
import { CATEGORY_TITLES, buildSummary, categoryOf, summarize } from "../src/summarize.js";
import { PAGE_ERROR_TRIGGER, type GenClassRacesFile, type RaceSignature } from "../src/types.js";

const ORIGIN = "http://127.0.0.1:47431";
const v8 = (top: string) => `TypeError: Cannot read properties of undefined (reading 'items')\n    at ${top}\n    at async load (${ORIGIN}/app.js:40:3)`;
// as the agent entry records it: the runtime's error event message is "<name>: <message>"
const err = (over: Record<string, unknown> = {}) => ({
  name: "TypeError",
  message: "TypeError: Cannot read properties of undefined (reading 'items')",
  stack: v8(`render (${ORIGIN}/assets/index-3f2a.js:12:7)`),
  chain: ["promise", "GET /api/search#3", 'type searchbox "Search"'],
  pageOrigin: ORIGIN,
  ...over,
});

describe("page errors: the message shape is @genclass/mcp's", () => {
  it("agrees with packages/mcp/src/text.ts shape() on every case", () => {
    const corpus = [
      "Cannot read properties of undefined (reading 'items')",
      'Unexpected token "<" in JSON at position 0',
      "Request failed with status code 500",
      "Loading chunk 42 failed. (error: http://127.0.0.1:5173/assets/42.js)",
      "x is 3.14 and y is 2, not 10.5e3",
      "ids 123abc and abc123 and 0x1F",
      "  spaced\t\tout\n\nmessage  ",
      "it's 'quoted' and \"double\" and 'unclosed",
      "",
      "a".repeat(400),
      "Ünïcödé 12 ‘curly’ “quotes” 7",
    ];
    for (const s of corpus) expect(messageShape(s), JSON.stringify(s)).toBe(mcpShape(s));
  });
});

describe("page errors: what the file keeps", () => {
  it("the request nearest to the error in its causal chain, its retry suffix dropped, or no request", () => {
    expect(requestOf(["promise", "GET /api/search#3", "POST /api/orders#1"])).toBe("GET /api/search");
    expect(requestOf(["POST /api/orders#2~retry2"])).toBe("POST /api/orders");
    expect(requestOf(["GET api.other.test/v1/items#4~hedge"])).toBe("GET api.other.test/v1/items");
    expect(requestOf(['click button "GET /api/x#1"', "timer 300ms"])).toBe(NO_REQUEST);
    expect(requestOf([])).toBe(NO_REQUEST);
    expect(requestOf(undefined)).toBe(NO_REQUEST);
  });

  it("same origin from the top stack frame, in each browser's format; unknown without a frame that names a script", () => {
    expect(sameOriginOf(v8(`render (${ORIGIN}/app.js:1:2)`), ORIGIN)).toBe(true);
    expect(sameOriginOf(v8("track (https://cdn.analytics.example/t.js:1:9)"), ORIGIN)).toBe(false);
    expect(sameOriginOf(`render@${ORIGIN}/app.js:1:2\n@${ORIGIN}/app.js:9:1`, ORIGIN)).toBe(true);
    expect(sameOriginOf("track@https://cdn.analytics.example/t.js:1:9", ORIGIN)).toBe(false);
    expect(sameOriginOf(v8("chrome-extension://abcdef/content.js:3:4"), ORIGIN)).toBe(false);
    // native code or a bundler's own scheme on top: not known, so kept
    expect(sameOriginOf(v8("JSON.parse (<anonymous>)"), ORIGIN)).toBe("unknown");
    expect(sameOriginOf(v8("eval (webpack-internal:///./src/app.js:10:5)"), ORIGIN)).toBe("unknown");
    // a URL in the message is not a frame
    expect(sameOriginOf("Error: failed to load https://cdn.example/x.js", ORIGIN)).toBe("unknown");
    expect(sameOriginOf(undefined, ORIGIN)).toBe("unknown");
    expect(sameOriginOf(v8(`render (${ORIGIN}/app.js:1:2)`), undefined)).toBe("unknown");
  });

  it("pageErrorFacts: the name, the shape, the request and the origin verdict, nothing else", () => {
    expect(pageErrorFacts(err())).toEqual({ name: "TypeError", shape: "Cannot read properties of undefined (reading …)", op: "GET /api/search", sameOrigin: true });
    expect(pageErrorFacts(err({ name: undefined, message: undefined, stack: undefined, chain: undefined }))).toEqual({ name: "Error", shape: "", op: NO_REQUEST, sameOrigin: "unknown" });
    expect(pageErrorFacts(err({ message: "boom \u001b[31mred\u001b[0m \u202e" }))!.shape).toBe("boom red");
    expect(pageErrorFacts(null)).toBeNull();
    expect(pageErrorFacts("x")).toBeNull();
  });

  it("takes the runtime's name prefix off the message, once", () => {
    expect(pageErrorFacts(err({ message: "Cannot read properties of undefined (reading 'items')" }))!.shape).toBe("Cannot read properties of undefined (reading …)");
    expect(pageErrorFacts(err({ message: "TypeError: " }))!.shape).toBe("");
    expect(pageErrorFacts(err({ message: "TypeError" }))!.shape).toBe("");
    expect(pageErrorFacts(err({ name: "Error", message: "Error: Error: nested 2" }))!.shape).toBe("Error: nested N");
    // a rejection with a plain object: its keys and values are quoted, so only the structure is kept
    expect(pageErrorFacts(err({ name: "Error", message: 'Error: {"user":"jane","status":401}' }))!.shape).toBe("{…:…,…:N}");
  });

  it("the evidence line says what the file keeps", () => {
    expect(pageErrorLine(pageErrorFacts(err())!)).toBe("TypeError: Cannot read properties of undefined (reading …) (causal chain: GET /api/search)");
    expect(pageErrorLine({ name: "AbortError", shape: "", op: NO_REQUEST, sameOrigin: "unknown" })).toBe("AbortError (no message) (no request in its causal chain; origin unknown: no script URL in its stack)");
  });
});

describe("page errors: signatures and the file", () => {
  it("one page-error signature per name and request, confidence 1; third-party errors left out and counted", () => {
    const errors = [err(), err({ message: "Cannot read properties of null (reading 'id')" }), err({ stack: v8("x (https://cdn.analytics.example/t.js:1:1)") }), err({ name: "SyntaxError", message: "Unexpected token '<'", chain: ["load"] })];
    const sigs = signaturesOf([], [], 2, { errors });
    expect(sigs.map((s) => s.sig)).toEqual(["page-error|SyntaxError|no request", "page-error|TypeError|GET /api/search"]);
    expect(sigs[1]).toEqual({ sig: "page-error|TypeError|GET /api/search", trigger: PAGE_ERROR_TRIGGER, diagnosis: "TypeError", op: "GET /api/search", confidence: 1, evidence: "TypeError: Cannot read properties of undefined (reading …) (causal chain: GET /api/search)", seeds: [2] });
    expect(thirdPartyErrors(errors)).toBe(1);
    expect(thirdPartyErrors(undefined)).toBe(0);
  });

  it("the file carries the signatures and the third-party count, validates, and holds no message, stack or chain as is", () => {
    const fixture = { model: "skip" as const, agent: null, chaosApplied: null, serviceWorker: false };
    const errors = [err(), err({ stack: v8("x (https://cdn.analytics.example/t.js:1:1)") })];
    const file = buildRacesFile({ test: "t", seed: 1, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [], errors, fixture });
    expect(file.fixture).toEqual({ ...fixture, thirdPartyErrors: 1 });
    const text = JSON.stringify(file);
    for (const raw of ["'items'", "index-3f2a", "assets", "searchbox", "#3", "cdn.analytics", ORIGIN]) expect(text, raw).not.toContain(raw);
    const r = validateRaces(JSON.parse(text));
    expect(r.ok && r.file).toEqual(file);
    // no errors, no count: the file of a quiet page is what it was
    expect(buildRacesFile({ test: "t", seed: 1, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [], errors: [err()], fixture }).fixture).toEqual(fixture);
  });

  it("the validator checks thirdPartyErrors", () => {
    const base = { schema: "genclass-races/1", test: "t", seed: 1, signatures: [], fixture: { model: "skip", agent: null, chaosApplied: null, serviceWorker: false } };
    expect(validateRaces({ ...base, fixture: { ...base.fixture, thirdPartyErrors: 3 } })).toMatchObject({ ok: true, file: { fixture: { thirdPartyErrors: 3 } } });
    const bad = validateRaces({ ...base, fixture: { ...base.fixture, thirdPartyErrors: -2 } });
    expect(!bad.ok && bad.errors).toEqual(["fixture.thirdPartyErrors: expected a whole number when present, got -2"]);
  });
});

const fx = { model: "skip" as const, agent: null, chaosApplied: 2, serviceWorker: false };
const pageError = (seed: number, name = "TypeError", op = "GET /api/search"): RaceSignature => ({ sig: `page-error|${name}|${op}`, trigger: "page-error", diagnosis: name, op, confidence: 1, evidence: `${name}: Cannot read properties of undefined (reading …) (causal chain: ${op})`, seeds: [seed] });
const witness = (seed: number): RaceSignature => ({ sig: "witness|overwrote-newer|GET /api/search", trigger: "witness", diagnosis: "overwrote-newer", op: "GET /api/search", confidence: 1, evidence: "w", seeds: [seed] });
const stale = (seed: number): RaceSignature => ({ sig: "delivery|stale|GET /api/search", trigger: "delivery", diagnosis: "stale", op: "GET /api/search", confidence: 0.93, evidence: "m", seeds: [seed] });
const file = (test: string, seed: number, signatures: RaceSignature[], extra: Partial<GenClassRacesFile> = {}): GenClassRacesFile => ({ schema: "genclass-races/1", test, seed, signatures, mode: "observe", model: { state: "off" }, fixture: fx, ...extra });

describe("report: page errors", () => {
  it("their own group, row and footer paragraph, no confidence, reproducible across seeds; no model paragraph without model lines", () => {
    expect(categoryOf("TypeError", "page-error")).toBe("page-error");
    expect(categoryOf("stale", "page-error")).toBe("page-error");
    expect(CATEGORY_TITLES["page-error"]).toBe("Page errors (uncaught, recorded without the model)");
    const md = summarize([
      { name: "a1.json", content: file("checkout", 1, [pageError(1)]) },
      { name: "a2.json", content: file("checkout", 2, [pageError(2)]) },
    ]);
    expect(md).toContain("| Other detections | 0 | 0 |\n| Page errors (uncaught, recorded without the model) | 1 | 1 |\n\n");
    expect(md).toContain("**Page errors (uncaught, recorded without the model)**\n\n- **Reproducible**: 2 of 2 seeds (1, 2) · `GET /api/search` · `page-error:TypeError`\n  > TypeError: Cannot read properties of undefined (reading …) (causal chain: GET /api/search)\n");
    expect(md).not.toContain("· confidence");
    expect(md).not.toContain("diagnosis by GenClass's on-device model");
    expect(md).not.toContain("Witnesses");
    expect(md).toContain('\n---\n\nLines under "Page errors (uncaught, recorded without the model)" are uncaught errors and unhandled rejections the runtime recorded in the page');
    expect(md).toContain("They carry no confidence: an error is listed when it was thrown. Reproducible: seen in 2 or more seeds of the same test.");
  });

  it("with model lines and witnesses: every paragraph, the model's first, and the model's counts are its own", () => {
    const md = summarize([{ name: "a.json", content: file("t", 1, [stale(1), pageError(1), witness(1)], { model: { state: "ready" }, fixture: { ...fx, model: "load" } }) }]);
    const footer = md.slice(md.lastIndexOf("\n---\n"));
    const at = ["Each line is a diagnosis by GenClass's on-device model", 'Lines under "Page errors', 'Lines under "Witnesses'].map((p) => footer.indexOf(p));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).toContain("`delivery:stale` · confidence 0.93\n");
    expect(md).toContain("`page-error:TypeError`\n");
  });

  it("an error named like a model label is still a page error, and 'expected' is not dropped", () => {
    const s = buildSummary([{ name: "a.json", content: file("t", 1, [pageError(1, "expected", "no request")]) }]);
    expect(s.tests[0].signatures.map((x) => [x.category, x.sig])).toEqual([["page-error", "page-error|expected|no request"]]);
    expect(s.totals.byCategory["page-error"]).toEqual({ signatures: 1, reproducible: 0 });
  });

  it("totals: the page-error group is counted only when present, so a report without one is unchanged", () => {
    expect(Object.keys(buildSummary([{ name: "a.json", content: file("t", 1, [witness(1)]) }]).totals.byCategory)).toEqual(["duplicate", "stale", "failing", "other", "witness"]);
    expect(Object.keys(buildSummary([{ name: "a.json", content: file("t", 1, [pageError(1)]) }]).totals.byCategory)).toEqual(["duplicate", "stale", "failing", "other", "page-error", "witness"]);
  });

  it("the model's note: a page error does not say the model checked the run, and the note says what was flagged", () => {
    const loading = { model: { state: "loading" }, fixture: { ...fx, model: "load" as const } };
    const md = summarize([
      { name: "a.json", content: file("t", 1, [pageError(1)], loading) },
      { name: "b.json", content: file("t", 2, [witness(2)], loading) },
    ]);
    // the witness file is not counted (as before page errors existed); the page-error file is
    expect(md).toContain("Note: in 1 of 2 files for this test nothing but page errors or measured checks was flagged and the model was not ready when the fixture collected (loading), so those runs may not have been checked.\n");
    expect(buildSummary([{ name: "a.json", content: file("t", 1, [pageError(1)], loading) }]).tests[0].modelNotReady).toEqual({ files: 1, states: ["loading"], others: 1 });
  });

  it("the fixture's note: a page error comes from the agent entry, so it counts as checked there", () => {
    const s = buildSummary([{ name: "a.json", content: file("t", 1, [pageError(1)], { fixture: { ...fx, serviceWorker: true } }) }]);
    expect(s.tests[0].unchecked).toEqual({ files: 0, reasons: [] });
  });
});
