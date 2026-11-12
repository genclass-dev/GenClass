// `genclass dashboard` (src/app.mjs): the app's numbers as lines, and which app is shown.
import { describe, expect, it } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { dashboard, KINDS, render, spark } from "../src/app.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, overview, printed, project, SESSION, tempDir, viteApp } from "./helpers.js";

isolate();

const NOW = Date.parse("2026-11-12T12:00:00Z");
const APP = {
  ok: true,
  name: "shop",
  range: "7d",
  lastEvent: "2026-11-12T09:00:00.000Z",
  totals: { visits: 1204, found: 17, handled: 3, possible: 4, checks: 9, pageViews: 3100 },
  previous: { found: 9, visits: 1000 },
  series: [0, 2, 1, 5, 3, 0, 6],
  problems: [
    { key: "duplicate\t/checkout", count: 12 },
    { key: "stale\t/orders/:id", count: 4 },
    { key: "failing\t/cart", count: 1 },
    { key: "slow\t/search", count: 1 },
    { key: "conflict\t/settings", count: 1 },
    { key: "odd-plugin-kind\t", count: 1 },
  ],
  possible: [{ key: "unusual\t/", count: 4 }],
  checks: [{ key: "text-overflow\t/pricing", count: 6 }, { key: "image-broken\t/", count: 3 }],
  kinds: [],
  recent: [{ at: "2026-11-12T11:00:00.000Z", kind: "duplicate", route: "/checkout", handled: true }],
  visitors: { visits: 312, pages: 1020, bounces: 128, entry: [{ key: "/", count: 201 }, { key: "/pricing", count: 60 }] },
  visitorsPlan: null,
  agent: { found: 5, reproduced: 3, fixed: 2, closed: 1, open: 3, last: null },
  dashboardUrl: `${HOST}/account/apps/proj000000000001`,
};
const STATE = { steps: [{ id: "agent", state: "done", detail: ".mcp.json" }, { id: "github-app", state: "done", detail: "reviewing · 4 pull requests so far" }, { id: "suggestions", state: "waiting", detail: "7 to do, 2 urgent · checked 2 days ago" }] };

describe("genclass dashboard: the view (src/app.mjs render, spark)", () => {
  it("spark() scales to the tallest bucket and draws nothing for nothing", () => {
    expect(spark([0, 1, 2, 4, 8])).toBe("▁▂▃▅█");
    expect(spark([3, 3])).toBe("██");
    expect(spark([0, 0, 0])).toBe("");
    expect(spark([])).toBe("");
  });

  it("short by default: the numbers, the top five problems in plain words, one line per other part", async () => {
    const said = await printed(() => render(APP as never, STATE as never, { now: NOW }));
    expect(said).toContain("last 7 days · last page 3 hours ago");
    expect(said).toMatch(/Visits watched\s+1,204\s+Problems found\s+17\s+▁▃▂▇▅▁█/);
    expect(said).toMatch(/Handled\s+3\s+Visual checks\s+9/);
    expect(said).toMatch(/12\s+duplicate\s+\/checkout\s+the same request went out twice/);
    expect(said).toMatch(/4\s+stale\s+\/orders\/:id\s+old data replaced newer data/);
    expect(said).toContain("and 1 more: genclass dashboard --all");
    expect(said).not.toContain("odd-plugin-kind");
    expect(said).not.toContain("Possible problems");
    expect(said).toMatch(/6\s+text-overflow\s+\/pricing/);
    expect(said).toMatch(/Visitors\s+312 visits · 1,020 page views · 41% left after one page/);
    expect(said).toContain("came in on / (201), /pricing (60)");
    expect(said).toMatch(/Coding agent\s+5 found · 3 reproduced · 2 fixed · 1 with a test/);
    expect(said).toMatch(/GitHub App\s+reviewing · 4 pull requests so far/);
    expect(said).toMatch(/Suggestions\s+7 to do, 2 urgent · checked 2 days ago · genclass suggest/);
    expect(said).toContain(`${HOST}/account/apps/proj000000000001`);
    expect(said.split("\n").length).toBeLessThan(30);
    // every row on request: a kind the model's vocabulary does not have is shown by its own name, with no made-up words
    const all = await printed(() => render(APP as never, STATE as never, { now: NOW, all: true }));
    expect(all).toMatch(/1\s+odd-plugin-kind\s+\(page unknown\)\n/);
    expect(all).toContain("Possible problems (lower confidence)");
    expect(all).toMatch(/1 hour ago\s+duplicate\s+\/checkout\s+handled/);
    expect(Object.keys(KINDS)).toEqual(["stale", "conflict", "duplicate", "inconsistent", "failing", "slow", "overload", "unusual", "transient"]);
  });

  it("an app with nothing yet says what fills it; a plan without visitor analytics says which plan has them", async () => {
    const empty = { ...APP, lastEvent: null, totals: { visits: 0, found: 0, handled: 0, possible: 0, checks: 0, pageViews: 0 }, series: [0, 0], problems: [], possible: [], checks: [], recent: [], visitors: null, visitorsPlan: { plan: "Team", upgradeUrl: `${HOST}/account/billing` }, agent: { found: 0, reproduced: 0, fixed: 0, closed: 0, open: 0, last: null } };
    const said = await printed(() => render(empty as never, { steps: [{ id: "agent", state: "todo", detail: "" }] } as never, { now: NOW }));
    expect(said).toContain("Nothing received yet. GenClass sends nothing from localhost");
    expect(said).toContain(`visitor analytics come with the Team plan: ${HOST}/account/billing`);
    expect(said).toContain("not connected yet: genclass setup");
    expect(said).not.toContain("Problems\n");
    const clean = await printed(() => render({ ...empty, lastEvent: APP.lastEvent, totals: { ...empty.totals, visits: 40 } } as never, { steps: [] } as never, { now: NOW }));
    expect(clean).toContain("No problems found in this period.");
  });
});

describe("genclass dashboard: which app (src/app.mjs dashboard)", () => {
  it("signed out it hands over to the runtime CLI's command; signed in with no app in this folder it lists the account's", async () => {
    const dir = tempDir();
    viteApp(dir);
    let fell = 0;
    expect(await dashboard({ cwd: dir }, { runGit: () => null, fallback: async () => (fell++, 7) })).toBe(7);
    expect(fell).toBe(1);
    expect(JSON.parse(await printed(async () => expect(await dashboard({ cwd: dir, json: true }, { runGit: () => null })).toBe(1)))).toEqual({ ok: false, error: "not signed in", run: "genclass login" });
    saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
    const two = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project(), project({ id: "proj000000000002", name: "blog", token: "gc_ZyXwVuTsRqPoNmLkJiHgFe" })] }) } });
    const which = await printed(async () => expect(await dashboard({ cwd: dir }, { runGit: () => null, fetchFn: two.fetchFn })).toBe(2));
    expect(which).toContain('genclass dashboard --app "shop"');
    expect(which).toContain('genclass dashboard --app "blog"');
    expect(two.calls.map((c) => c.path)).toEqual(["/api/cli/overview"]);
    // named: that app is asked for, by its id, with the period
    const named = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project(), project({ id: "proj000000000002", name: "blog", token: "gc_ZyXwVuTsRqPoNmLkJiHgFe" })] }) }, "GET /api/cli/app": { json: { name: "blog", range: "30d", totals: { sessions: 5 }, series: [], breakdowns: {}, recent: [], visits: {}, agent: {}, dashboard_url: `${HOST}/account/apps/proj000000000002` } } });
    const view = await printed(async () => expect(await dashboard({ cwd: dir, app: "Blog", range: "30d" }, { runGit: () => null, fetchFn: named.fetchFn })).toBe(0));
    expect(named.calls.map((c) => `${c.path}${c.query}`)).toEqual(["/api/cli/overview", "/api/cli/app?id=proj000000000002&range=30d"]);
    expect(view).toContain("last 30 days");
    expect(view).toContain("blog");
    // an account with one app needs no name; a server without the route says so and gives the browser link
    const one = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) } });
    const older = await printed(async () => expect(await dashboard({ cwd: dir }, { runGit: () => null, fetchFn: one.fetchFn })).toBe(1));
    expect(older).toContain("cannot show a dashboard in the terminal yet");
    expect(older).toContain(`${HOST}/account/apps/proj000000000001`);
    // an address from the server that is not on its own host is never printed
    const evil = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) }, "GET /api/cli/app": { json: { name: "shop", totals: {}, dashboard_url: "https://evil.example/x" } } });
    expect(await printed(async () => expect(await dashboard({ cwd: dir }, { runGit: () => null, fetchFn: evil.fetchFn })).toBe(0))).not.toContain("evil.example");
  });
});
