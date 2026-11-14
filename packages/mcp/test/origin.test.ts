// Several apps on one machine (AGENT.md §4.1, §4.2): findings and runs carry their page origin, status and findings
// group by it, `origin` keeps one app, and explore and replay slots are taken only by loads of their own app.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeApi } from "../src/api.js";
import { originFilter, originOfUrl } from "../src/origin.js";
import { Store } from "../src/store.js";
import { callTool } from "../src/tools.js";
import { act, snap } from "./helpers.js";

const SHOP = "http://localhost:5173";
const ADMIN = "http://localhost:3000";

function setup() {
  let t = 1_000_000;
  const store = new Store({ now: () => t });
  const api = makeApi(store, { url: "http://127.0.0.1:47357", port: 47357 });
  const tool = (name: string, args: Record<string, unknown> = {}) => callTool(name, args, { api: async (m, p) => api(m, p), now: () => t, cwd: process.cwd(), env: {} });
  /** A page load of `origin` (its hello carries that origin's URL, as a browser's does). */
  const load = (origin: string, route = "/", schedule?: unknown) => {
    const h = store.hello({ schema: "genclass-agent/1", page: { url: `${origin}${route}`, route }, runtime: { mode: "observe", model: "loading" }, ...(schedule ? { schedule } : {}) }, origin)!;
    return { ...h, send: (events: unknown[]) => store.events({ run: h.run, token: h.token, events }, origin) };
  };
  return { store, tool, load, tick: (ms: number) => (t += ms) };
}

const boom = (message = "Cannot read properties of undefined") => ({ t: "error", error: { t: 5, name: "TypeError", message, chain: [] } });

describe("origins: the filter an agent passes (AGENT.md §4.2)", () => {
  it("a bare port matches every origin on it; anything else is one exact origin; garbage is refused", () => {
    expect(originFilter("5173")!.test(SHOP)).toBe(true);
    expect(originFilter("5173")!.test("http://127.0.0.1:5173")).toBe(true);
    expect(originFilter("5173")!.test(ADMIN)).toBe(false);
    expect(originFilter("80")!.test("http://localhost")).toBe(true);
    expect(originFilter(SHOP)!.test(SHOP)).toBe(true);
    expect(originFilter("localhost:5173/search")!.test(SHOP)).toBe(true);
    expect(originFilter(`${SHOP}/`)!.label).toBe(SHOP);
    expect(originFilter(SHOP)!.test("http://127.0.0.1:5173")).toBe(false);
    expect(originFilter("not a url at all")).toBeNull();
    expect(originFilter(5173)).toBeNull();
    expect(originOfUrl("file:///x")).toBeUndefined();
  });
});

describe("origins: findings and status, grouped by app (AGENT.md §4.2)", () => {
  it("the same error on the same route of two apps is two findings, each with its origin", () => {
    const { store, load } = setup();
    load(SHOP).send([boom()]);
    load(ADMIN).send([boom()]);
    load(SHOP).send([boom()]);
    const list = store.ranked();
    expect(list).toHaveLength(2);
    expect(list.map((f) => [f.origin, f.count])).toEqual(
      expect.arrayContaining([
        [SHOP, 2],
        [ADMIN, 1],
      ]),
    );
  });

  it("genclass_findings prints one header per app, and origin (an origin or a port) keeps one", async () => {
    const { tool, load } = setup();
    load(SHOP, "/search").send([boom("search broke")]);
    load(ADMIN, "/users").send([boom("users broke")]);
    const all = (await tool("genclass_findings")).text;
    expect(all).toContain(`${SHOP}:\n- f1 [error] "/search"`);
    expect(all).toContain(`${ADMIN}:\n- f2 [error] "/users"`);
    // the origin is said once per app, not on every finding
    expect(all.split(SHOP).length - 1).toBe(1);
    const shop = (await tool("genclass_findings", { origin: "5173" })).text;
    expect(shop).toContain("1 finding(s) on port 5173");
    expect(shop).toContain("search broke");
    expect(shop).not.toContain("users broke");
    const admin = (await tool("genclass_findings", { origin: ADMIN })).text;
    expect(admin).toContain("users broke");
    expect(admin).not.toContain("search broke");
    expect((await tool("genclass_findings", { origin: "9999" })).text).toContain("No findings match on port 9999");
    const bad = await tool("genclass_findings", { origin: "a b c" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("origin must be a page origin");
  });

  it("genclass_status groups page loads by app with their counts, splits the findings by app, and a filter names the others", async () => {
    const { tool, load } = setup();
    load(SHOP, "/search").send([{ t: "steps", steps: [act(0, "click", 'button "Go"')], order: [] }, { t: "snapshot", snapshot: snap({}) }]);
    load(SHOP, "/cart").send([boom()]);
    load(ADMIN, "/users").send([{ t: "witness", witness: { kind: "overwrote-newer", t: 9, subject: "users.list", by: "GET /api/users#1", over: "GET /api/users#2", overKind: "request" } }]);
    const st = (await tool("genclass_status")).text;
    expect(st).toContain(`Findings: ${SHOP} 1 error; ${ADMIN} 1 stale-write (genclass_findings {origin})`);
    expect(st).toContain(`${SHOP} · 2 run(s), 2 active:\n- r1 "/search"`);
    expect(st).toContain(`${ADMIN} · 1 run(s), 1 active:\n- r3 "/users"`);
    const one = (await tool("genclass_status", { origin: "3000" })).text;
    expect(one).toContain("1 active page(s), 1 recorded run(s) on port 3000");
    expect(one).toContain("Findings: 1 stale-write (genclass_findings)");
    expect(one).not.toContain('"/cart"');
    expect(one).toContain(`Also on this machine: ${SHOP} (2 run(s))`);
    expect((await tool("genclass_status", { origin: "::" })).isError).toBe(true);
  });

  it("one app only: no split counts, one header for its loads", async () => {
    const { tool, load } = setup();
    load(SHOP, "/a").send([boom()]);
    const st = (await tool("genclass_status")).text;
    expect(st).toContain("Findings: 1 error (genclass_findings)");
    expect(st).toContain(`${SHOP} · 1 run(s), 1 active:`);
    expect(st).not.toContain("Also on this machine");
  });

  it("genclass_explain names the finding's app", async () => {
    const { tool, load } = setup();
    load(ADMIN, "/users").send([boom()]);
    expect((await tool("genclass_explain", { id: "f1" })).text).toContain(`# f1 · error · "/users" on ${ADMIN} ·`);
  });
});

describe("origins: explore and replay slots stay with their app (AGENT.md §5)", () => {
  it("an explore without a route belongs to the app of its first load: another app's page on the same path gets no slot", () => {
    const { store, load } = setup();
    store.armExplore({ runs: 1 });
    expect(load(SHOP, "/").schedule).toMatchObject({ order: "fifo" });
    expect(load(ADMIN, "/").schedule).toBeNull();
    expect(load(SHOP, "/").schedule).toMatchObject({ order: "fifo" });
    expect(store.latestExplore()!.origin).toBe(SHOP);
  });

  it("an armed replay is taken only by a load of the finding's app", () => {
    const { store, load } = setup();
    const r = load(SHOP, "/search");
    r.send([{ t: "steps", steps: [act(0, "type", 'searchbox "Search"', "react")], order: ["GET /api/search#2", "GET /api/search#1"] }, { t: "witness", witness: { kind: "overwrote-newer", t: 9, subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#2", overKind: "request" } }]);
    const f = store.ranked()[0];
    const arm = store.armReplay(f.id);
    expect(arm).toMatchObject({ origin: SHOP });
    expect(load(ADMIN, "/search").schedule).toBeNull();
    expect(load(SHOP, "/search").schedule).toMatchObject({ order: "given" });
  });

  it("a finding saved before origins were kept gets its run's, and an origin survives a restart", () => {
    const { store, load } = setup();
    load(SHOP, "/x").send([boom()]);
    const f = store.ranked()[0];
    delete f.origin;
    expect(store.findingOrigin(f)).toBe(SHOP);
    const dir = mkdtempSync(join(tmpdir(), "gc-origin-"));
    const a = new Store({ dir });
    a.hello({ schema: "genclass-agent/1", page: { url: `${ADMIN}/u`, route: "/u" } }, ADMIN);
    const run = [...a.runs.values()][0];
    a.events({ run: run.id, token: run.token, events: [boom()] }, ADMIN);
    a.save();
    const b = new Store({ dir });
    expect(b.ranked()[0].origin).toBe(ADMIN);
    expect(b.ranked({ origin: originFilter("3000")!.test })).toHaveLength(1);
    expect(b.ranked({ origin: originFilter("5173")!.test })).toHaveLength(0);
  });
});
