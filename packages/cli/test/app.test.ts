// `genclass dashboard` (src/app.mjs): the app's numbers as lines, and which app is shown.
import { describe, expect, it } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { dashboard, fit, KINDS, render, signInAgain, spark } from "../src/app.mjs";
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

  it("a long period's chart is folded to the window, and rows come largest first whatever order the server sent", async () => {
    expect(fit([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(fit([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([6, 15, 7]);
    const cols = process.stdout.columns;
    try {
      process.stdout.columns = 58;
      const long = { ...APP, range: "90d", series: Array.from({ length: 90 }, (_, i) => i), problems: [{ key: "stale\t/", count: 3 }, { key: "scroll_lock\t/a/very/long/page/address/that/goes/on", count: 151 }, { key: "duplicate\t/", count: 164 }] };
      const said = await printed(() => render(long as never, { steps: [] } as never, { now: NOW }));
      const lines = said.split("\n").map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
      // an address is the one thing that cannot be folded
      expect(Math.max(...lines.filter((l) => !l.includes("https://")).map((l) => l.length))).toBeLessThanOrEqual(58);
      const order = ["the same request went out twice", "scroll_lock", "old data replaced newer data"].map((w) => said.indexOf(w));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order[0]).toBeGreaterThan(-1);
    } finally {
      process.stdout.columns = cols;
    }
  });

  it("short by default: the numbers, the top five problems in plain words, one line per other part", async () => {
    const said = await printed(() => render(APP as never, STATE as never, { now: NOW }));
    expect(said).toContain("last 7 days · last page 3 hours ago");
    expect(said).toMatch(/Page loads\s+1,204\s+Problems found\s+17\n/);
    expect(said).toMatch(/Problems\s+▁▃▂▇▅▁█\s+over the period/);
    expect(said).toMatch(/Handled\s+3\s+Visual checks\s+9/);
    // what happened in plain words first, then the page; largest first
    expect(said).toMatch(/12\s+the same request went out twice\s+\/checkout\n/);
    expect(said).toMatch(/4\s+old data replaced newer data\s+\/orders\/:id\n/);
    expect(said.indexOf("the same request went out twice")).toBeLessThan(said.indexOf("old data replaced newer data"));
    expect(said).not.toContain("…");
    expect(said).toContain("and 1 more: npx genclass dashboard --all");
    expect(said).not.toContain("odd-plugin-kind");
    expect(said).not.toContain("Possible problems");
    expect(said).toMatch(/6\s+text-overflow\s+\/pricing/);
    expect(said).toMatch(/Visitors\s+312 visits · 1,020 page views · 41% left after one page/);
    expect(said).toContain("came in on / (201), /pricing (60)");
    expect(said).toMatch(/Coding agent\s+5 found · 3 reproduced · 2 fixed · 1 with a test/);
    expect(said).toMatch(/GitHub App\s+reviewing · 4 pull requests so far/);
    expect(said).toMatch(/Suggestions\s+7 to do, 2 urgent · checked 2 days ago · npx genclass suggest/);
    expect(said).toContain(`${HOST}/account/apps/proj000000000001`);
    expect(said.split("\n").length).toBeLessThan(31);
    // every row on request: a kind the model's vocabulary does not have is shown by its own name, with no made-up words
    const all = await printed(() => render(APP as never, STATE as never, { now: NOW, all: true }));
    expect(all).toMatch(/1\s+odd-plugin-kind\s+\(page unknown\)\n/);
    expect(all).toContain("Possible problems (lower confidence)");
    expect(all).toMatch(/1 hour ago\s+duplicate\s+\/checkout\s+handled/);
    // with every row, the kind's own name follows the page
    expect(all).toMatch(/12\s+the same request went out twice\s+\/checkout\s+duplicate\n/);
    expect(Object.keys(KINDS)).toEqual(["stale", "conflict", "duplicate", "inconsistent", "failing", "slow", "overload", "unusual", "transient"]);
  });

  it("an app with nothing yet says what fills it; a plan without visitor analytics says which plan has them", async () => {
    const empty = { ...APP, lastEvent: null, totals: { visits: 0, found: 0, handled: 0, possible: 0, checks: 0, pageViews: 0 }, series: [0, 0], problems: [], possible: [], checks: [], recent: [], visitors: null, visitorsPlan: { plan: "Team", upgradeUrl: `${HOST}/account/billing` }, agent: { found: 0, reproduced: 0, fixed: 0, closed: 0, open: 0, last: null } };
    const said = await printed(() => render(empty as never, { steps: [{ id: "agent", state: "todo", detail: "" }] } as never, { now: NOW }));
    expect(said).toContain("Nothing received yet. GenClass sends nothing from localhost");
    expect(said.replace(/\s+/g, " ")).toContain(`visitor analytics come with the Team plan: ${HOST}/account/billing`);
    expect(said).toContain("not connected yet: npx genclass setup");
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
    expect(JSON.parse(await printed(async () => expect(await dashboard({ cwd: dir, json: true }, { runGit: () => null })).toBe(1)))).toEqual({ ok: false, error: "not signed in", run: "npx genclass login" });
    saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
    const two = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project(), project({ id: "proj000000000002", name: "blog", token: "gc_ZyXwVuTsRqPoNmLkJiHgFe" })] }) } });
    const which = await printed(async () => expect(await dashboard({ cwd: dir }, { runGit: () => null, fetchFn: two.fetchFn })).toBe(2));
    expect(which).toContain('npx genclass dashboard --app "shop"');
    expect(which).toContain('npx genclass dashboard --app "blog"');
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

describe("genclass login: a sign-in from before dashboards is approved once more (src/app.mjs signInAgain)", () => {
  it("signed out, or with a sign-in that can show dashboards, the usual login runs (null)", async () => {
    expect(await signInAgain({}, { fetchFn: fakeServer({}).fetchFn })).toBeNull();
    saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
    // a sign-in approved for everything the command does: one question, the newest thing a terminal is approved for
    const current = fakeServer({ "GET /api/cli/account": { json: { plan: { id: "free", name: "Free" } } } });
    let asked = 0;
    expect(await signInAgain({}, { fetchFn: current.fetchFn, signIn: async () => (asked++, "done") })).toBeNull();
    expect(current.calls.map((c) => c.path)).toEqual(["/api/cli/account"]);
    expect(current.calls[0]!.auth).toBe(`Bearer ${SESSION}`);
    // a server without that route is asked the one before it. It looks at the sign-in before the app: a current
    // one gets "not found" for the id no app has
    const fine = fakeServer({ "GET /api/cli/app": { status: 404, json: { ok: false, error: "not found" } } });
    expect(await signInAgain({}, { fetchFn: fine.fetchFn, signIn: async () => (asked++, "done") })).toBeNull();
    expect(asked).toBe(0);
    expect(fine.calls.map((c) => `${c.path}${c.query}`)).toEqual(["/api/cli/account", "/api/cli/app?id=-&range=24h"]);
    // a server that cannot be reached, or one without the route, changes nothing either
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await signInAgain({}, { fetchFn: down, signIn: async () => (asked++, "done") })).toBeNull();
    expect(asked).toBe(0);
  });

  it("an old sign-in is signed in again instead of answering 'already signed in'", async () => {
    saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
    const old = fakeServer({ "GET /api/cli/app": { status: 403, json: { ok: false, error: "sign in again: npx genclass login", reauth: true } } });
    const seen: object[] = [];
    const said = await printed(async () => expect(await signInAgain({ noBrowser: true }, { fetchFn: old.fetchFn, signIn: async (o) => (seen.push(o), "done") })).toBe(0));
    expect(seen).toEqual([{ noBrowser: true }]);
    expect(said.replace(/\s+/g, " ")).toContain("One more approval in the browser");
    // an approval that is not given is exit 1, and nothing else is tried
    expect(await printed(async () => expect(await signInAgain({}, { fetchFn: old.fetchFn, signIn: async () => "skipped" })).toBe(1))).toContain("signed in");
    // a sign-in that can show dashboards but is from before the plan, alerts and questions is old too: `login` is
    // where the command sends such a person, so "already signed in" there would be a dead end
    const before = fakeServer({ "GET /api/cli/account": { status: 403, json: { ok: false, error: "sign in again: genclass login", reauth: true } }, "GET /api/cli/app": { status: 404, json: { ok: false, error: "not found" } } });
    seen.length = 0;
    const again = await printed(async () => expect(await signInAgain({}, { fetchFn: before.fetchFn, signIn: async (o) => (seen.push(o), "done") })).toBe(0));
    expect(seen).toHaveLength(1);
    expect(before.calls.map((c) => c.path)).toEqual(["/api/cli/account"]);
    expect(again.replace(/\s+/g, " ")).toContain("the page lists what the terminal can do");
  });
});
