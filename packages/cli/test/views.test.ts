// `genclass analytics`, `problems`, `events`, `health`, `agent` and `report` (src/views.mjs): what the browser
// dashboard shows, as lines that fit a narrow terminal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run } from "../src/cli.mjs";
import { agentSetup, analytics, ANALYTICS_SECTIONS, bars, events, problems, renderAgent, renderAnalytics, renderEvents, renderHealth, renderProblems, report, time } from "../src/views.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, overview, printed, project, SESSION, tempDir, viteApp, write } from "./helpers.js";
import { appOf, LOCKED, NOW, plainLines, STATS, tooWide } from "./stats.js";

isolate();

/** What `fn` prints on a terminal `cols` wide. */
async function at(cols: number, fn: () => unknown): Promise<string> {
  const before = process.stdout.columns;
  process.stdout.columns = cols;
  try {
    return await printed(fn);
  } finally {
    process.stdout.columns = before;
  }
}

describe("genclass analytics (src/views.mjs renderAnalytics)", () => {
  it("the short view: the numbers and the top of the lists people look at first, on 58 columns", async () => {
    const app = await appOf();
    const said = await at(58, () => renderAnalytics(app, { now: NOW }));
    expect(tooWide(said)).toEqual([]);
    expect(said).toMatch(/Visits\s+1,000\s+Page views\s+3,100/);
    expect(said).toMatch(/Pages a visit\s+3\.1\s+Left at once\s+42%/);
    expect(said).toMatch(/Time on a page\s+40s\s+New visitors\s+64%/);
    expect(said).toContain("Page views are up 24% on the period before.");
    // a page: its views, the time on it, how many read to the end
    expect(said).toMatch(/\/\s+1,500\s+40s\s+40%/);
    expect(said).toMatch(/\/pricing\s+700\s+1m 10s\s+50%/);
    expect(said).toContain("and 1 more: npx genclass analytics pages");
    expect(said).toMatch(/google\.com\s+520/);
    expect(said).toMatch(/Direct or unknown\s+300/);
    expect(said).toMatch(/Canada\s+700/);
    // the click that did not seem to work is in the short view; the long lists are not
    expect(said).toMatch(/button Pay on \/checkout\s+31/);
    for (const later of ["Came in on", "Browsers", "Most clicked", "Paths through the site", "Campaigns"]) expect(said).not.toContain(later);
    expect(said).toContain("npx genclass analytics --all");
    for (const s of ANALYTICS_SECTIONS.slice(1)) expect(said).toContain(s);
  });

  it("--all and each part in full: nothing the dashboard's Visitors view has is missing", async () => {
    const app = await appOf();
    const all = await at(100, () => renderAnalytics(app, { now: NOW, all: true }));
    for (const part of ["Pages", "Came in on", "Left from", "Where they come from", "Campaigns", "Campaign sources", "Campaign mediums", "Devices", "Browsers", "Systems", "Countries", "New or returning", "Most clicked", "Clicked again and again", "Clicked with no effect", "Paths through the site", "From one page to the next", "First thing people use", "Funnels"]) expect(all).toContain(part);
    expect(all).not.toContain("more:");
    expect(all).toMatch(/\/ → \/pricing → \/checkout\s+210/);
    expect(all).toMatch(/\/pricing → \/checkout\s+260/);
    // a funnel: each step with the visits that reached it and its share of the first
    expect(all).toMatch(/\/pricing\s+310\s+44% of step 1/);
    expect(all).toMatch(/\/checkout\s+120\s+17% of step 1/);
    const sources = await at(58, () => renderAnalytics(app, { now: NOW, section: "sources" }));
    expect(sources).toMatch(/duckduckgo\.com\s+8/);
    expect(sources).toMatch(/launch\s+80/);
    expect(sources).not.toContain("Devices");
    expect(sources).not.toMatch(/Visits\s+1,000/);
    expect(tooWide(sources)).toEqual([]);
    for (const s of ANALYTICS_SECTIONS) expect(tooWide(await at(58, () => renderAnalytics(app, { now: NOW, section: s })))).toEqual([]);
    const funnels = await at(58, () => renderAnalytics(app, { now: NOW, section: "funnels" }));
    expect(funnels).toContain("npx genclass funnels");
  });

  it("a plan without visitor analytics is told which plan has them and the command that starts it; no visits says how they come on", async () => {
    const locked = await at(58, async () => renderAnalytics(await appOf(LOCKED), { now: NOW }));
    expect(locked).toContain("Visitor analytics come with the Team plan.");
    expect(locked).toContain("npx genclass plan");
    expect(locked).not.toContain("google.com");
    const none = await at(58, async () => renderAnalytics(await appOf({ totals: {}, breakdowns: {}, visits: { sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] } }), { now: NOW }));
    expect(none).toContain("No visits counted in this period.");
    expect(plainLines(none).join(" ").replace(/\s+/g, " ")).toContain("GenClass counts nothing from localhost.");
  });

  it("bars() and time(): a share of the whole, a label cut to the window, minutes and seconds", async () => {
    expect([time(900), time(41_000), time(65_400), time(600_000)]).toEqual(["1s", "41s", "1m 05s", "10m 00s"]);
    const said = await at(58, () => bars("T", [{ key: "a".repeat(200), count: 3 }, { key: "", count: 1 }], { whole: 4 }));
    expect(tooWide(said)).toEqual([]);
    expect(said).toMatch(/…\s+3\s+█+\s+75%/);
    expect(said).toMatch(/\(none\)\s+1\s+█+\s+25%/);
    expect(await printed(() => bars("T", []))).toBe("");
  });
});

describe("genclass problems, events and health (src/views.mjs)", () => {
  it("problems: what it was, where, each kind on each page, what GenClass did, on 58 columns", async () => {
    const app = await appOf();
    const said = await at(58, () => renderProblems(app, { now: NOW }));
    expect(tooWide(said)).toEqual([]);
    // the model's findings and the measured checks together, and what was stopped on the visitor's screen
    expect(said).toMatch(/Problems found\s+39\s+Fixed live\s+16/);
    expect(said).toMatch(/Possible\s+4\s+Pages affected\s+5/);
    expect(said).toContain("That is up 50% on the period before.");
    expect(said).toMatch(/the same request went out twice\s+14/);
    expect(said).toMatch(/old data replaced newer data\s+11/);
    // a kind this program has no words for keeps its name, readable; `expected` is not a problem
    expect(said).toMatch(/odd plugin kind\s+2/);
    expect(said).not.toContain("expected");
    expect(said).toMatch(/14\s+the same request went out twice on \/checkout/);
    // a row too long for the window puts its page on the next line
    expect(plainLines(said).some((l) => /^\s+on \/a\/very\/long/.test(l))).toBe(true);
    expect(said).toMatch(/Invisible text\s+6/);
    expect(said).toMatch(/7\s+Merged a repeated request/);
    expect(said).toMatch(/4\s+Fixed a measured check/);
    expect(said).toContain("1 undone");
    expect(said).toContain("npx genclass fix");
    expect(said).not.toContain("Possible problems");
    expect(await at(58, () => renderProblems(app, { now: NOW, all: true }))).toMatch(/Possible problems[\s\S]+an operation behaved unlike it normal…\s+4\s/);
    // nothing found
    const clean = await at(58, async () => renderProblems(await appOf({ totals: { sessions: 10 }, breakdowns: {}, previous: {} }), { now: NOW }));
    expect(clean).toContain("No problems found in this period.");
    const never = await at(58, async () => renderProblems(await appOf({ totals: {}, breakdowns: {}, previous: {} }), { now: NOW }));
    expect(plainLines(never).join(" ").replace(/\s+/g, " ")).toContain("GenClass sends nothing from localhost");
    // an app that only reports is told what guard mode adds
    const observe = await at(58, async () => renderProblems(await appOf({ breakdowns: { ...STATS.breakdowns, intervention: [], check_fix: [], mode: [{ key: "observe", count: 9 }] } }), { now: NOW }));
    expect(observe).toContain("GenClass only reports here (observe mode).");
  });

  it("events: one per line, newest first, with what GenClass did under the ones it handled", async () => {
    const app = await appOf();
    const said = await at(58, () => renderEvents(app, { now: NOW }));
    expect(tooWide(said)).toEqual([]);
    const lines = plainLines(said);
    const first = lines.findIndex((l) => /3 min ago\s+stale\s+94%\s+\/search/.test(l));
    expect(first).toBeGreaterThan(-1);
    expect(lines[first + 1]).toMatch(/→ Dropped a stale write/);
    expect(said).toMatch(/40 min ago\s+duplicate\s+88%\s+\/checkout/);
    // reported only: no line under it; no confidence: none shown
    expect(lines[lines.findIndex((l) => l.includes("duplicate")) + 1]).not.toContain("→");
    expect(said).toMatch(/9 h ago\s+odd plugin ki…\s+\/a\/very/);
    expect(said).toContain("npx genclass export");
    const all = await at(58, () => renderEvents(app, { now: NOW, all: true }));
    const flatAll = plainLines(all).join(" ").replace(/\s+/g, " ");
    expect(flatAll).toContain("mode guard • trigger delivery • fn loadResults");
    expect(flatAll).toContain("mode observe • trigger delivery • reported");
    expect(tooWide(all)).toEqual([]);
    expect(await at(58, async () => renderEvents(await appOf({ recent: [] }), { now: NOW }))).toContain("No events in this period.");
  });

  it("health: how GenClass itself runs, in the dashboard's rows; --all adds every breakdown", async () => {
    const app = await appOf();
    const said = await at(58, () => renderHealth(app, { now: NOW }));
    expect(tooWide(said)).toEqual([]);
    const flat = plainLines(said).join(" ").replace(/\s+/g, " ");
    expect(flat).toContain("Model loads 99% succeeded • 1,190 loads, 6 failures • healthy");
    // almost all of them is never rounded up to "100%"
    const most = plainLines(await at(58, async () => renderHealth(await appOf({ totals: { ...STATS.totals, model_ready: 3352, model_load_failed: 9 } }), { now: NOW }))).join(" ");
    expect(most).toContain("99.7% succeeded");
    expect(flat).toContain("Where it ran WebGPU 76%, WASM 24% • average load 1.3 s");
    expect(flat).toContain("Decision time 12 ms • average of 300 records, sampled");
    expect(flat).toContain("No decision 2 times the app carried on without one");
    expect(flat).toContain("Not checked 40 • 30 in hidden tabs, 10 over the decision rate limit");
    expect(flat).toContain("Records not sent 53 • 50 routine decisions sampled out, 3 dropped in the browser");
    expect(flat).toContain("6 × failed to fetch the model: 503");
    expect(flat).toContain("Visual checks ran on 50% of page loads • 200 on the light tier • 40 with fixes on • about 10 ms each");
    expect(flat).toContain("Runtime versions 0.3.0-beta.6, 0.3.0-beta.5 • more than one version is live");
    expect(flat).toContain("Mode guard 91%, observe 9%");
    expect(said).not.toContain("Triggers");
    const all = await at(58, () => renderHealth(app, { now: NOW, all: true }));
    expect(all).toMatch(/Triggers[\s\S]+delivery\s+880/);
    expect(tooWide(all)).toEqual([]);
    expect(await at(58, async () => renderHealth(await appOf({ totals: {}, breakdowns: {} }), { now: NOW }))).toContain("No page load in this period");
  });
});

describe("genclass agent (src/views.mjs agentSetup, renderAgent)", () => {
  it("agentSetup reads only GenClass's own entry: connected, production numbers, reports, and a link left in the repository", () => {
    const dir = tempDir();
    const home = tempDir();
    expect(agentSetup(dir, home)).toEqual({ files: [], production: false, reports: false, inRepo: false });
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "x", env: { GENCLASS_DASHBOARD: "nope" } }, genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.2.2"] } } }) });
    expect(agentSetup(dir, home)).toEqual({ files: [".mcp.json"], production: false, reports: false, inRepo: false });
    // the link in the person's own Claude Code settings for this folder: production numbers, nothing in the repository
    write(home, { ".claude.json": JSON.stringify({ projects: { [dir]: { mcpServers: { genclass: { command: "npx", env: { GENCLASS_DASHBOARD: `${HOST}/dashboard/${"a".repeat(32)}`, GENCLASS_REPORT: "on" } } } } } }) });
    expect(agentSetup(dir, home)).toEqual({ files: [".mcp.json"], production: true, reports: true, inRepo: false });
    // the sample dashboard is not production, and "on" without a link reports nowhere
    write(home, { ".claude.json": JSON.stringify({ projects: { [dir]: { mcpServers: { genclass: { env: { GENCLASS_DASHBOARD: "sample", GENCLASS_REPORT: "on" } } } } } }) });
    expect(agentSetup(dir, home)).toMatchObject({ production: false, reports: false });
    // a link written into the project's own file is said
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "npx", env: { GENCLASS_DASHBOARD: `${HOST}/dashboard/${"b".repeat(32)}` } } } }) });
    expect(agentSetup(dir, home)).toMatchObject({ production: true, inRepo: true });
    write(dir, { ".mcp.json": "{ not json" });
    expect(agentSetup(dir, tempDir())).toEqual({ files: [], production: false, reports: false, inRepo: false });
  });

  it("the view: how it is connected here, the loop's stages, the findings, and the log with --all", async () => {
    const app = await appOf();
    const said = await at(58, () => renderAgent(app, { files: [".mcp.json"], production: false, reports: false, inRepo: false }, { now: NOW }));
    expect(tooWide(said)).toEqual([]);
    const flat = plainLines(said).join(" ").replace(/\s+/g, " ");
    expect(flat).toContain("Connected here yes • .mcp.json");
    expect(flat).toContain("Production numbers off • npx genclass agent link gives the agent the live site's numbers");
    expect(flat).toContain("3 found → 2 reproduced → 1 fix proven → 1 closed");
    expect(flat).toContain("2 open now • 1 still reproduced after a fix");
    expect(flat).toContain("stale-write on /search reproduced • test written • open • 3 hours ago");
    expect(flat).toContain("Its log, 2 steps: add --all");
    const all = await at(58, () => renderAgent(app, { files: [".mcp.json"], production: true, reports: true, inRepo: true }, { now: NOW, all: true }));
    const flatAll = plainLines(all).join(" ").replace(/\s+/g, " ");
    expect(flatAll).toContain("Production numbers on");
    expect(flatAll).toContain("Keep it out of what you commit");
    expect(flatAll).toContain("replay stale-write on /search reproduced");
    expect(flatAll).toContain("explore /search 12 page loads, 2 races");
    expect(tooWide(all)).toEqual([]);
    // another folder's app: only what was reported; nothing reported says how reporting comes on
    const empty = await at(58, async () => renderAgent(await appOf({ agent: { findings: [], log: [], stages: {}, counts: {}, last: null } }), { files: [], production: false, reports: false, inRepo: false }, { now: NOW }));
    expect(empty).toContain("Nothing reported in this period.");
    expect(empty).toContain("npx genclass agent link");
    expect(await at(58, async () => renderAgent(await appOf(), null, { now: NOW }))).not.toContain("Connected here");
  });
});

describe("the views as commands (src/cli.mjs run, src/views.mjs)", () => {
  /** A signed-in project folder whose app is in the account, and a server that answers for it. */
  function signedIn(stats: Record<string, unknown> = STATS) {
    const dir = tempDir();
    viteApp(dir);
    write(dir, { "index.html": `<!doctype html><html><head><meta name="genclass-token" content="${project().token}"></head><body></body></html>` });
    saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
    const server = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project({ last_event: "2026-11-12T11:57:00.000Z" })] }) }, "GET /api/cli/app": { json: stats } });
    return { dir, deps: { fetchFn: server.fetchFn, runGit: () => null, now: NOW }, server };
  }

  it("each view finds the app by name, prints its part, and gives the same as JSON", async () => {
    const { deps, server } = signedIn();
    const o = { app: "shop", cwd: tempDir() };
    let code = -1;
    const a = await printed(async () => (code = await analytics(o, deps)));
    expect(code).toBe(0);
    expect(a).toMatch(/Visits\s+1,000/);
    expect(server.calls.filter((c) => c.path === "/api/cli/app").map((c) => c.query)).toEqual(["?id=proj000000000001&range=7d"]);
    const j = JSON.parse(await printed(async () => expect(await analytics({ ...o, json: true }, deps)).toBe(0)));
    expect(j).toMatchObject({ ok: true, app: "shop", range: "7d", visitors: { visits: 1000 }, funnels: [{ name: "Buy" }] });
    expect(Object.keys(j.breakdowns).every((k) => k.startsWith("ix_"))).toBe(true);
    expect(JSON.parse(await printed(() => problems({ ...o, json: true }, deps)))).toMatchObject({ ok: true, totals: { found: 30, stepped_in: 16 }, interventions: [{ key: "coalesce", count: 7 }, { key: "discard", count: 5 }] });
    const ev = JSON.parse(await printed(() => events({ ...o, json: true }, deps)));
    expect(ev.events[0]).toEqual({ at: "2026-11-12T11:57:00.000Z", route: "/search", fn: "loadResults", kind: "stale", confidence: 0.94, mode: "guard", trigger: "delivery", tier: "acted", handled: true, executed: true, action: "discard", ran: "discard" });
    // no app of that name: the account's apps, each as a command that runs
    const which = await printed(async () => expect(await analytics({ app: "nope", cwd: o.cwd }, deps)).toBe(2));
    expect(which).toContain('npx genclass analytics --app "shop"');
  });

  it("report: Markdown and nothing else on the screen, or into the file --out names", async () => {
    const { deps } = signedIn();
    const dir = tempDir();
    const said = await printed(async () => expect(await report({ app: "shop", cwd: dir }, deps)).toBe(0));
    expect(said.startsWith("# shop (GenClass dashboard)\n")).toBe(true);
    expect(said).not.toContain("────");
    expect(await printed(async () => expect(await report({ app: "shop", cwd: dir, out: "r.md" }, deps)).toBe(0))).toContain("Wrote r.md");
    expect(readFileSync(join(dir, "r.md"), "utf8")).toBe(said);
    expect(JSON.parse(await printed(() => report({ app: "shop", cwd: dir, json: true }, deps))).markdown).toBe(said.trimEnd());
  });

  it("a part of analytics that does not exist, and a word after a command that takes none, say so", async () => {
    signedIn();
    const errs: string[] = [];
    const spy = (await import("vitest")).vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (errs.push(String(s)), true)) as never);
    try {
      expect(await run(["analytics", "nonsense"])).toBe(2);
      expect(errs.join("")).toContain("there is no part");
      expect(errs.join("")).toContain("pages, sources, devices, clicks, paths, funnels");
      errs.length = 0;
      expect(await run(["health", "extra"])).toBe(2);
      expect(errs.join("")).toContain("unknown command");
      errs.length = 0;
      expect(await run(["problms"])).toBe(2);
      expect(errs.join("")).toContain("Did you mean");
      expect(errs.join("")).toContain("npx genclass problems");
    } finally {
      spy.mockRestore();
    }
  });
});
