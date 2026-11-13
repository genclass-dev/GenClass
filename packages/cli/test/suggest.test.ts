// `genclass suggest` as a whole (src/suggest/index.mjs, digest.mjs): a project folder, a stand-in site and the real
// collector in process. What is printed, what is sent, what a plan shows, and what is never sent.
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../../../telemetry-worker/src/collector.js";
import { cliToken, now, resetClock, setPlan, setup, signedIn } from "../../../telemetry-worker/test/account-helpers.js";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { readState } from "../src/state.mjs";
import { readNotes } from "../src/store.mjs";
import { CHECKS, runChecks } from "../src/suggest/checks.mjs";
import { buildDigest, describeDigest } from "../src/suggest/digest.mjs";
import { FREE_SHOWN, layOut, siteAddress, suggest, suggestionsPrompt } from "../src/suggest/index.mjs";
import { HOST, isolate, printed, tempDir, viteApp, write } from "./helpers.js";
import { tooWide } from "./stats.js";

isolate();
beforeEach(() => {
  resetClock();
});

type Env = Parameters<typeof handle>[1];

const SPA = `<!doctype html><html><head><meta charset="utf-8"><title>Vite + React</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`;

/**
 * One fetch for everything `suggest` asks: shop.example is a bare single-page-app shell that answers every address
 * with the app, genclass.dev is the collector in process, and the model's API answers through `model` (default: no
 * model reachable). Every request is recorded.
 */
function world(env: Env, model?: (init: RequestInit) => Response) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const u = new URL(url);
    if (u.origin === HOST) {
      return handle(new Request(url, { method: init?.method, headers: init?.headers, body: init?.body as never }), env, {
        now: () => now(),
        fetch: (async (_m: string, i?: RequestInit) => (model ? model(i!) : new Response("{}", { status: 503 }))) as never,
      });
    }
    if (u.hostname === "shop.example") return new Response(SPA, { status: 200, headers: { "content-type": "text/html" } });
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn, toSite: () => calls.filter((c) => c.url.includes("shop.example")), toGenclass: () => calls.filter((c) => c.url.startsWith(HOST)) };
}
const noDns = { resolveMx: async () => [], resolveTxt: async () => [] };
const deps = (w: ReturnType<typeof world>) => ({ fetchFn: w.fetchFn, dns: noDns, runGit: () => null });

/** A signed-in account, as `genclass login` leaves it. */
async function account(env: Env) {
  const me = await signedIn(env);
  saveCredentials({ host: HOST, access_token: await cliToken(env, me.cookie), account: { id: me.account.id, email: me.account.email, github_login: null } });
  return me;
}

/** A project with a few things missing, so that several checks fail whatever the site says. */
function project() {
  const dir = tempDir();
  viteApp(dir, { dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", stripe: "^17.0.0" } });
  write(dir, { ".env": "SESSION_SECRET=kq7Zr2mVx9Lp4Ws8Tn3Yb6Hd\n" });
  return dir;
}

describe("genclass suggest: addresses, the digest and the layout (src/suggest/index.mjs, digest.mjs)", () => {
  it("a site address is an http or https origin; anything else is none", () => {
    expect([siteAddress("shop.example"), siteAddress(" https://shop.example/ "), siteAddress("http://shop.example/app"), siteAddress("https://shop.example:8443")]).toEqual(["https://shop.example", "https://shop.example", "http://shop.example/app", "https://shop.example:8443"]);
    for (const bad of ["", null, undefined, "localhost", "not a url", "ftp://shop.example", "javascript:alert(1)", "shop"]) expect(siteAddress(bad as never), String(bad)).toBeNull();
  });

  it("the digest holds the failed checks and five things about the app, cleaned, and nothing else", () => {
    const ESC = String.fromCharCode(27);
    const results = [
      { id: "title", area: "launch", title: `A title${ESC}[31m with an escape`, weight: 4, status: "fail", evidence: [`the title is "Vite + React"\u0007`, "x".repeat(400), "third", "fourth"], why: "w", fix: "f", prompt: "p", extra: "not sent" },
      { id: "https", area: "launch", title: "ok", weight: 5, status: "pass", evidence: ["passes"] },
      { id: "staging", area: "launch", title: "?", weight: 3, status: "unknown", evidence: [] },
      { id: "email-spf", area: "email", title: "n/a", weight: 3, status: "skip", evidence: [] },
    ];
    const d = buildDigest({ name: "shop", framework: "Vite + React", site: "https://shop.example", payments: "stripe", hosting: null, about: `Polar Parts. Sled parts${ESC}[2J shipped across Canada. ${"y".repeat(400)}` }, results as never);
    expect(d).toEqual({
      // what the site says it is about (its title and description), cut and cleaned: the design ideas fit the company with it
      app: { name: "shop", framework: "Vite + React", site: "https://shop.example", payments: "stripe", hosting: null, about: expect.stringMatching(/^Polar Parts\. Sled parts shipped across Canada\. y+…$/) },
      checks: [{ id: "title", area: "launch", title: "A title with an escape", weight: 4, evidence: ['the title is "Vite + React"', `${"x".repeat(159)}…`, "third"] }],
      passed: 1,
      unknown: 1,
    });
    expect(d.app.about!.length).toBe(300);
    expect(describeDigest(d).join(" ")).toMatch(/The 1 check that failed.*its name, its framework, its address, its site's title and description, its payment provider\..*No source code/);
    // every key the server reads, and no more
    expect(Object.keys(d.checks[0]!).sort()).toEqual(["area", "evidence", "id", "title", "weight"]);
  });

  it("without a server the order is by weight and the first one is open; with one, its order and its words", () => {
    const r = (id: string, weight: number) => ({ id, area: "search", title: id, weight, status: "fail", evidence: [], why: `why ${id}`, fix: `fix ${id}`, prompt: `prompt ${id}` });
    const results = [r("a", 1), r("b", 5), r("c", 3), r("d", 4), { ...r("e", 5), status: "pass" }];
    const local = layOut(results as never, null);
    expect(local.map((i) => [i.n, i.id, i.open])).toEqual([[1, "b", true], [2, "d", false], [3, "c", false], [4, "a", false]]);
    expect(FREE_SHOWN).toBe(1);
    expect(local[0]).toMatchObject({ why: "why b", step: "fix b", prompt: "prompt b", fromModel: false });
    // the server's plan: its order, its words where it has some, the catalog's where it has none, the rest held back
    const plan = { items: [{ id: "c", why: "for your shop", step: "do this", prompt: "tell it" }, { id: "a", why: null, step: null, prompt: null }, { id: "zzz", why: "x", step: "x", prompt: "x" }], lockedIds: ["d", "b"] };
    const laid = layOut(results as never, plan as never);
    expect(laid.map((i) => [i.id, i.open])).toEqual([["c", true], ["a", true], ["d", false], ["b", false]]);
    expect(laid[0]).toMatchObject({ why: "for your shop", step: "do this", prompt: "tell it", fromModel: true });
    expect(laid[1]).toMatchObject({ why: "why a", step: "fix a", fromModel: false });
  });
});

describe("genclass suggest: end to end (src/suggest/index.mjs header)", () => {
  it("--no-model sends nothing to genclass.dev: the site and the repository are measured and the checks' own order is printed", async () => {
    const { env } = setup();
    await account(env);
    const dir = project();
    const w = world(env);
    let code = -1;
    const out = await printed(async () => (code = await suggest({ cwd: dir, url: "shop.example", noModel: true }, deps(w))));
    expect(code).toBe(0);
    expect(w.toGenclass()).toEqual([]);
    expect(w.toSite().length).toBeGreaterThan(3);
    expect(w.toSite().every((c) => c.method === "GET")).toBe(true);
    expect(out).toMatch(/\d+ of \d+ checks pass\. \d+ to do/);
    expect(out).toContain("--no-model: nothing was sent");
    // the first one in full, with what was measured; the rest counted, with the way to Pro (the owner's call, 2026-11-12)
    expect(out).toMatch(/1 {2}\S/);
    expect(out).toContain("Ask your agent");
    expect(out.match(/^ {6}Ask your agent$/gm)).toHaveLength(1);
    expect(out).not.toContain('"Vite + React"');
    expect(out.replace(/\s+/g, " ")).toMatch(/ PRO \d+ more suggestions for this app: \d+ from your checks, each with a prompt for your coding agent\. Start: npx genclass upgrade/);
    // the last run is remembered outside the project, and the status shows it
    const notes = readNotes(dir);
    expect(notes.site).toBe("https://shop.example");
    expect(notes.suggest).toMatchObject({ failed: expect.any(Number), urgent: expect.any(Number) });
    expect(notes.suggest.failed).toBeGreaterThan(5);
    const st = await readState({ cwd: dir, offline: true }, { runGit: () => null });
    expect(st.steps.find((s) => s.id === "suggestions")).toMatchObject({ state: "waiting" });
  });

  it("signed in with --yes: the digest goes to genclass.dev, Free gets the plan for one and the count of the rest, and no code or secret is in what was sent", async () => {
    const { env } = setup();
    await account(env);
    const dir = project();
    const w = world(env);
    let code = -1;
    const text = await printed(async () => (code = await suggest({ cwd: dir, url: "https://shop.example", yes: true, json: true }, deps(w))));
    expect(code).toBe(0);
    const j = JSON.parse(text);
    expect(j).toMatchObject({ site: "https://shop.example", source: "checks", plan: { id: "free", name: "Free" }, upgrade_url: `${HOST}/account/billing?plan=team&from=cli`, ideas: [], designs: [] });
    // Free: the first one in full, the rest counted and not listed
    expect(j.failed).toHaveLength(1);
    expect(j.failed[0]).toMatchObject({ n: 1, why: expect.any(String), do: expect.any(String), prompt: expect.any(String) });
    expect(j.more.checks).toBeGreaterThan(4);
    // heaviest first
    expect(j.failed[0].weight).toBe(5);
    const ids = new Set(CHECKS.map((c: { id: string }) => c.id));
    expect(j.failed.every((f: any) => ids.has(f.id))).toBe(true);
    // one request to genclass.dev: the digest
    const sent = w.toGenclass();
    expect(sent.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /api/cli/suggest"]);
    const body = sent[0]!.body;
    expect(Object.keys(body).sort()).toEqual(["app", "checks", "passed", "unknown"]);
    expect(Object.keys(body.app).sort()).toEqual(["about", "framework", "hosting", "name", "payments", "site"]);
    expect(body.app).toMatchObject({ name: "shop", framework: "Vite + React", site: "https://shop.example", payments: "stripe", hosting: null });
    expect(body.checks).toHaveLength(j.failed.length + j.more.checks);
    // the secret in .env was found, and its value went nowhere: not to the server, not into the output
    expect(body.checks.some((f: any) => f.id === "env-committed" || f.id === "secrets-in-repo" || f.id === "env-example")).toBe(true);
    for (const blob of [JSON.stringify(sent), text]) expect(blob.includes("kq7Zr2mVx9Lp4Ws8Tn3Yb6Hd")).toBe(false);
    // no file's contents either
    expect(JSON.stringify(sent)).not.toMatch(/createRoot|react-dom\/client|<div id=/);
  });

  it("the model's ideas and website designs: Free sees how many and the same plan again; Pro sees them, each design with its site and a whole prompt", async () => {
    const { env, sql } = setup({ OPENAI_API_KEY: "sk-test-0123456789abcdef0123" });
    const me = await account(env);
    const dir = project();
    let runs = 0;
    const design = { title: "Bold outdoor retail", inspired_by: "https://www.patagonia.com", why: "A store that sells gear for the cold, like yours.", prompt: "Redesign the home page of this Vite and React shop in the style of a premium outdoor store: full-width photography, a short headline over it, large product cards in a three-column grid. ".repeat(3) };
    const model = (init: RequestInit) => {
      // the server checks that a design's site answers before it keeps the design
      if ((init.method ?? "GET").toUpperCase() === "GET") return new Response("ok", { status: 200 });
      runs++;
      const failed = JSON.parse(JSON.parse(String(init.body)).messages[1].content).failed as { id: string }[];
      const items = failed.map((c) => ({ id: c.id, why: `For this shop: ${c.id}.`, step: `First: ${c.id}.`, prompt: `Agent: ${c.id}.` }));
      const ideas = ["A size guide for sleds", "Shipping times on the product page"].map((t) => ({ title: t, why: `why ${t}`, step: `step ${t}`, prompt: `prompt ${t}` }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items, ideas, designs: [design] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const w = world(env, model);
    // Free: the first suggestion, and the rest counted, ideas and designs included, with Pro's trial
    const free = (await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true }, deps(w)))).replace(/\s+/g, " ");
    expect(free).toMatch(/ PRO \d+ more suggestions for this app: \d+ from your checks, 2 ideas from the model, 1 website design inspired by sites like yours, each with a prompt for your coding agent\. 3 days free, then \$15 \/ developer \/ month\. Cancel any time\. Start: npx genclass upgrade/);
    expect(free).not.toContain("A size guide for sleds");
    expect(free).not.toContain("patagonia");
    expect(runs).toBe(1);
    // Free again: the plan from the first run, said so, and no new model run
    const again = (await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true }, deps(w)))).replace(/\s+/g, " ");
    expect(again).toMatch(/This is your plan from \w+ \d+: on Free it stays this one\. Pro writes it again every time you run this\./);
    expect(runs).toBe(1);
    // Pro (here GenClass's grant): every item, the ideas marked as not measured, the design with its site and its whole prompt
    setPlan(sql, me.account.id, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString(), comp_plan: "team" });
    const cols = process.stdout.columns;
    process.stdout.columns = 58;
    let paid = "";
    try {
      paid = await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true, all: true }, deps(w)));
    } finally {
      process.stdout.columns = cols;
    }
    expect(tooWide(paid)).toEqual([]);
    const flat = paid.replace(/\s+/g, " ");
    expect(flat).toContain("Ideas from the model Not measured: judged from your app and its site.");
    expect(flat).toContain("A size guide for sleds");
    expect(flat).toContain("Website designs The model's choice of sites that fit what you do.");
    expect(flat).toContain("Bold outdoor retail Inspired by https://www.patagonia.com");
    expect(flat).toContain(`Prompt for Claude (copy it all) ${design.prompt.trim()}`);
    expect(flat).not.toContain("more suggestions for this app");
    expect(runs).toBe(2);
    const j = JSON.parse(await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true, json: true }, deps(w))));
    expect(j.designs).toEqual([{ title: design.title, inspired_by: "https://www.patagonia.com", why: design.why, prompt: design.prompt.trim() }]);
    expect(j.ideas.map((i: any) => i.title)).toEqual(["A size guide for sleds", "Shipping times on the product page"]);
  });

  it("with a model on the server and Team: the model's order and words for every item", async () => {
    const { env, sql } = setup({ OPENAI_API_KEY: "sk-test-0123456789abcdef0123" });
    const me = await account(env);
    setPlan(sql, me.account.id, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString(), comp_plan: "team" });
    const dir = project();
    const model = (init: RequestInit) => {
      const failed = JSON.parse(JSON.parse(String(init.body)).messages[1].content).failed as { id: string }[];
      const items = [...failed].reverse().map((c) => ({ id: c.id, why: `For this shop: ${c.id}.`, step: `First: ${c.id}.`, prompt: `Agent: ${c.id}.` }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const w = world(env, model);
    const j = JSON.parse(await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true, json: true }, deps(w))));
    expect(j).toMatchObject({ source: "model", plan: { id: "team", name: "Pro" }, upgrade_url: null, more: { checks: 0, ideas: 0, designs: 0 } });
    expect(j.failed.every((f: any) => !f.locked && f.why === `For this shop: ${f.id}.` && f.do === `First: ${f.id}.` && f.prompt === `Agent: ${f.id}.`)).toBe(true);
    // the model's order, which was the reverse of what was sent
    const sentIds = w.toGenclass()[0]!.body.checks.map((c: any) => c.id);
    expect(j.failed.map((f: any) => f.id)).toEqual([...sentIds].reverse());
    // printed for a person: every item, the first five in full, and no paywall line
    const out = await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true }, deps(w)));
    expect(out).toContain("The plan is written for your app.");
    expect(out.match(/^ {6}Ask your agent$/gm)).toHaveLength(5);
    expect(out).toContain("npx genclass suggest --all");
    expect(out).not.toContain("come with the Team plan");
    const all = await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true, all: true }, deps(w)));
    expect(all.match(/^ {6}Ask your agent$/gm)).toHaveLength(j.failed.length);
  });

  it("signed out, or without --yes and without a terminal, nothing is sent; a site that cannot be read leaves the repository's checks", async () => {
    const { env } = setup();
    const dir = project();
    const w = world(env);
    const out = await printed(async () => suggest({ cwd: dir, url: "https://shop.example" }, deps(w)));
    expect(w.toGenclass()).toEqual([]);
    expect(out).toContain("npx genclass login");
    // signed in, no --yes, no terminal: asking is impossible, so it is not sent
    await account(env);
    const w2 = world(env);
    const out2 = await printed(async () => suggest({ cwd: tempDir() && project(), url: "https://shop.example" }, deps(w2)));
    expect(w2.toGenclass()).toEqual([]);
    expect(out2).toContain("nothing was sent");
    // a dead site: said so, exit code 1 because the address was asked for, and the repository is still checked
    const w3 = world(env);
    let code = -1;
    const out3 = await printed(async () => (code = await suggest({ cwd: project(), url: "https://gone.example", noModel: true }, deps(w3))));
    expect(code).toBe(1);
    expect(out3).toContain("Could not read https://gone.example");
    expect(out3).toMatch(/\d+ of \d+ checks pass/);
    // not an address at all
    expect(await suggest({ cwd: dir, url: "not an address", noModel: true }, deps(w3))).toBe(2);
  });

  it("every check in the catalog has plain words and the same ids the server accepts", () => {
    const r = runChecks({ repo: null, site: null });
    expect(r.map((x: { id: string }) => x.id)).toEqual(CHECKS.map((c: { id: string }) => c.id));
    for (const c of CHECKS as { id: string; title: string; why: string; fix: string; prompt: string; weight: number }[]) {
      expect(c.id, c.id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      for (const t of [c.title, c.why, c.fix, c.prompt]) {
        expect(t.length, c.id).toBeGreaterThan(10);
        expect(t, c.id).not.toMatch(/[—–]/);
      }
      expect(c.weight >= 1 && c.weight <= 5, c.id).toBe(true);
    }
    expect(new Set(CHECKS.map((c: { id: string }) => c.id)).size).toBe(CHECKS.length);
    expect(CHECKS.length).toBeLessThanOrEqual(60);
  });
});

describe("genclass suggest: every item to a coding agent in one prompt (src/suggest/index.mjs suggestionsPrompt)", () => {
  it("each item the plan shows with its reason, step and prompt, the rest by title, in order, with how to check", () => {
    const items = [
      { n: 1, title: "No sitemap", evidence: "GET /sitemap.xml 404", open: true, why: "Search engines miss pages.", step: "Add a sitemap.", prompt: "Add a sitemap.xml that lists every page." },
      { n: 2, title: "No error page", evidence: null, open: false },
    ];
    const p = suggestionsPrompt(items, "https://shop.example");
    expect(p).toContain("GenClass checked this repository and the live site https://shop.example and found 2 things to fix");
    expect(p).toContain("run `npx genclass suggest --json`");
    expect(p).toContain("1. No sitemap (found: GET /sitemap.xml 404)\n   Why: Search engines miss pages.\n   First step: Add a sitemap.\n   Add a sitemap.xml that lists every page.");
    expect(p).toContain("2. No error page\n   Look at what this check measures");
    expect(p.indexOf("1. No sitemap")).toBeLessThan(p.indexOf("2. No error page"));
    expect(suggestionsPrompt([items[0]!])).toContain("GenClass checked this repository and found 1 thing to fix");
  });
});
