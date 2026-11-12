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
import { FREE_SHOWN, layOut, siteAddress, suggest } from "../src/suggest/index.mjs";
import { HOST, isolate, printed, tempDir, viteApp, write } from "./helpers.js";

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
    const d = buildDigest({ name: "shop", framework: "Vite + React", site: "https://shop.example", payments: "stripe", hosting: null }, results as never);
    expect(d).toEqual({
      app: { name: "shop", framework: "Vite + React", site: "https://shop.example", payments: "stripe", hosting: null },
      checks: [{ id: "title", area: "launch", title: "A title with an escape", weight: 4, evidence: ['the title is "Vite + React"', `${"x".repeat(159)}…`, "third"] }],
      passed: 1,
      unknown: 1,
    });
    expect(describeDigest(d).join(" ")).toMatch(/The 1 check that failed.*its name, its framework, its address, its payment provider\..*No source code/);
    // every key the server reads, and no more
    expect(Object.keys(d.checks[0]!).sort()).toEqual(["area", "evidence", "id", "title", "weight"]);
  });

  it("without a server the order is by weight and the first three are open; with one, its order and its words", () => {
    const r = (id: string, weight: number) => ({ id, area: "search", title: id, weight, status: "fail", evidence: [], why: `why ${id}`, fix: `fix ${id}`, prompt: `prompt ${id}` });
    const results = [r("a", 1), r("b", 5), r("c", 3), r("d", 4), { ...r("e", 5), status: "pass" }];
    const local = layOut(results as never, null);
    expect(local.map((i) => [i.n, i.id, i.open])).toEqual([[1, "b", true], [2, "d", true], [3, "c", true], [4, "a", false]]);
    expect(FREE_SHOWN).toBe(3);
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
    // the empty shell and the placeholder title are found, each with what was measured
    expect(out).toMatch(/1 {2}\S/);
    expect(out).toContain('"Vite + React"');
    expect(out).toContain("Ask your agent");
    // three in full; the rest by title, with where the plans are
    expect(out.match(/^ {6}Ask your agent$/gm)).toHaveLength(3);
    expect(out).toContain("come with the Team plan");
    // the last run is remembered outside the project, and the status shows it
    const notes = readNotes(dir);
    expect(notes.site).toBe("https://shop.example");
    expect(notes.suggest).toMatchObject({ failed: expect.any(Number), urgent: expect.any(Number) });
    expect(notes.suggest.failed).toBeGreaterThan(5);
    const st = await readState({ cwd: dir, offline: true }, { runGit: () => null });
    expect(st.steps.find((s) => s.id === "suggestions")).toMatchObject({ state: "waiting" });
  });

  it("signed in with --yes: the digest goes to genclass.dev, Free gets the plan for three, and no code or secret is in what was sent", async () => {
    const { env } = setup();
    await account(env);
    const dir = project();
    const w = world(env);
    let code = -1;
    const text = await printed(async () => (code = await suggest({ cwd: dir, url: "https://shop.example", yes: true, json: true }, deps(w))));
    expect(code).toBe(0);
    const j = JSON.parse(text);
    expect(j).toMatchObject({ site: "https://shop.example", source: "checks", plan: { id: "free", name: "Free" }, upgrade_url: `${HOST}/account/billing` });
    expect(j.failed.length).toBeGreaterThan(5);
    expect(j.failed.slice(0, 3).every((f: any) => f.why && f.do && f.prompt && !f.locked)).toBe(true);
    expect(j.failed.slice(3).every((f: any) => f.locked === true && !("why" in f) && Array.isArray(f.evidence))).toBe(true);
    expect(j.failed.map((f: any) => f.n)).toEqual(j.failed.map((_: unknown, i: number) => i + 1));
    // heaviest first
    expect(j.failed[0].weight).toBe(5);
    const ids = new Set(CHECKS.map((c: { id: string }) => c.id));
    expect(j.failed.every((f: any) => ids.has(f.id))).toBe(true);
    // one request to genclass.dev: the digest
    const sent = w.toGenclass();
    expect(sent.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /api/cli/suggest"]);
    const body = sent[0]!.body;
    expect(Object.keys(body).sort()).toEqual(["app", "checks", "passed", "unknown"]);
    expect(body.app).toEqual({ name: "shop", framework: "Vite + React", site: "https://shop.example", payments: "stripe", hosting: null });
    expect(body.checks.map((c: any) => c.id).sort()).toEqual(j.failed.map((f: any) => f.id).sort());
    // the secret in .env was found, and its value went nowhere: not to the server, not into the output
    expect(j.failed.some((f: any) => f.id === "env-committed" || f.id === "secrets-in-repo" || f.id === "env-example")).toBe(true);
    for (const blob of [JSON.stringify(sent), text]) expect(blob.includes("kq7Zr2mVx9Lp4Ws8Tn3Yb6Hd")).toBe(false);
    // no file's contents either
    expect(JSON.stringify(sent)).not.toMatch(/createRoot|react-dom\/client|<div id=/);
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
    expect(j).toMatchObject({ source: "model", plan: { id: "team", name: "Team" }, upgrade_url: null });
    expect(j.failed.every((f: any) => !f.locked && f.why === `For this shop: ${f.id}.` && f.do === `First: ${f.id}.` && f.prompt === `Agent: ${f.id}.`)).toBe(true);
    // the model's order, which was the reverse of what was sent
    const sentIds = w.toGenclass()[0]!.body.checks.map((c: any) => c.id);
    expect(j.failed.map((f: any) => f.id)).toEqual([...sentIds].reverse());
    // printed for a person: every item, the first five in full, and no paywall line
    const out = await printed(async () => suggest({ cwd: dir, url: "https://shop.example", yes: true }, deps(w)));
    expect(out).toContain("The plan is written for your app.");
    expect(out.match(/^ {6}Ask your agent$/gm)).toHaveLength(5);
    expect(out).toContain("genclass suggest --all");
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
    expect(out).toContain("genclass login");
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
