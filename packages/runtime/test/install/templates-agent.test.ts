// @vitest-environment happy-dom
// The race on demand in templates/react-vite and templates/vue-vite (each README's "See the race on demand";
// docs/runtime/AGENT.md sections 1 and 3). The agent link sits inside the development check of each entry file and
// is loaded only when the URL asks for a schedule, so a normal dev page load sends nothing to the bridge. What the
// READMEs say the page then shows is checked against the runtime itself, with the templates' own mock data: under the
// README's `seeded:N` the answer for "b" lands after the answer for "be" whenever the two requests are in flight
// together (the list ends on the "b" cities), under `fifo` it never does, and an answer that is back before the next
// request starts is not held. react-vite runs its real `src/App.tsx` on React 19 (happy-dom), where the overwrite is a
// witness on the component's state; Vue is not installed here, so vue-vite's watcher is mirrored in plain code, where
// nothing is registered and there is no witness until the results go through `guard`. A fake clock and a fake server:
// no browser, no network.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import "../discover-register.js"; // React state discovery, as the zero-code entries register it
import { connectAgent, type AgentConnection } from "../../src/agent/index.js";
import { createRuntime } from "../../src/index.js";
import type { RuntimeImpl } from "../../src/runtime.js";
import { loadReact } from "../discover-react-load.js";
import { drain, FakeClock, FakeServer, ScriptedDecider, setup } from "../helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");
const req = createRequire(import.meta.url);
const G = globalThis as unknown as Record<string, unknown>;

/** Each template, its entry file and what its README says the console's witness list shows (tested below). */
const TEMPLATES = [
  { name: "react-vite", entry: "src/main.tsx", witnesses: "`__GENCLASS_AGENT__.witnesses()` lists the overwrite as an `overwrote-newer` witness on `App.state1`" },
  { name: "vue-vite", entry: "src/main.ts", witnesses: "`__GENCLASS_AGENT__.witnesses()` stays empty in this template" },
] as const;

/** The block each entry file ends with: development builds only, and only when the URL names a schedule. */
const LINK = /^if \(import\.meta\.env\.DEV && new URLSearchParams\(location\.search\)\.has\("genclass-schedule"\)\) \{\n {2}import\("@genclass\/runtime\/agent"\)\.then\(\(a\) => a\.connectAgent\(genclass\)\);\n\}$/m;

/** The condition of the entry file's agent block, evaluated for a page URL's `search` in a development build. */
function entryGate(name: string, entry: string): (search: string) => boolean {
  const m = /^if \((.+)\) \{\n {2}import\("@genclass\/runtime\/agent"\)/m.exec(read(`templates/${name}/${entry}`));
  if (!m) throw new Error(`templates/${name}/${entry} has no agent block`);
  const cond = new Function("location", `return ${m[1].replace("import.meta.env.DEV", "true")};`) as (l: { search: string }) => boolean;
  return (search) => cond({ search });
}

/** The template's mock API (mock-api.ts): its cities and its filter. */
function mockSearch(name: string): (q: string) => string[] {
  const m = /const CITIES = (\[[^\]]*\]);/.exec(read(`templates/${name}/mock-api.ts`));
  if (!m) throw new Error(`no CITIES in templates/${name}/mock-api.ts`);
  const cities = JSON.parse(m[1]) as string[];
  return (raw) => {
    const q = raw.trim().toLowerCase();
    return q ? cities.filter((c) => c.toLowerCase().startsWith(q)) : [];
  };
}

/** The README's "See the race on demand" section. */
function raceSection(name: string): string {
  const readme = read(`templates/${name}/README.md`);
  const a = readme.indexOf("\n## See the race on demand\n");
  if (a < 0) throw new Error(`templates/${name}/README.md has no "See the race on demand" section`);
  const b = readme.indexOf("\n## ", a + 1);
  return readme.slice(a, b < 0 ? undefined : b);
}

/** The seed the README tells the reader to open. */
function readmeSeed(name: string): number {
  const m = /\/\?genclass-schedule=seeded:(\d+)\b/.exec(raceSection(name));
  if (!m) throw new Error(`templates/${name}/README.md names no ?genclass-schedule=seeded:N`);
  return Number(m[1]);
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

describe("templates: the agent link is in the development check and asked for by the URL (CONTRACT §16; AGENT.md §1, §3)", () => {
  for (const t of TEMPLATES) {
    it(`${t.name}/${t.entry}: one block, inside import.meta.env.DEV, only with ?genclass-schedule, on the template's runtime`, () => {
      const code = read(`templates/${t.name}/${t.entry}`)
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      // GenClass is still the first import (the one line)
      expect(code.split("\n").find((l) => l.startsWith("import "))).toBe('import genclass from "@genclass/runtime/auto";');
      expect(code).toMatch(LINK);
      // and nowhere else: no static import of the agent entry, no other call
      expect(code.replace(LINK, "")).not.toMatch(/@genclass\/runtime\/agent|connectAgent/);
      // its condition, evaluated: a dev page load without the parameter does not load the link
      const open = entryGate(t.name, t.entry);
      expect([open(""), open("?q=be"), open("?genclass-schedule=seeded:1"), open("?genclass-schedule=fifo")]).toEqual([false, false, true, true]);
    });
  }

  it("the parameter the entry files check is the one connectAgent reads", async () => {
    const s = setup({ mode: undefined, extraGlobal: { location: { href: "http://localhost:5173/?genclass-schedule=seeded:3", pathname: "/", hostname: "localhost", search: "?genclass-schedule=seeded:3" } } });
    s.server.on("POST", "/v1/hello", { error: "network", latency: 0 });
    const c = connectAgent(s.rt);
    expect(c.schedule).toEqual({ order: "seeded", seed: 3 });
    await s.clock.advance(10);
    expect(c.connected).toBe(false);
    c.disconnect();
  });

  for (const t of TEMPLATES) {
    it(`${t.name}/README.md: the steps, the counts from its mock data, the witnesses, the controls, the planted race called a self-test`, () => {
      const s = raceSection(t.name).replace(/\s+/g, " ");
      const search = mockSearch(t.name);
      expect(s).toContain("`npm run dev`");
      expect(s).toMatch(/\/\?genclass-schedule=seeded:\d+/);
      expect(s).toContain("`be`");
      // the counts the page shows, from the mock's own cities
      expect(s).toContain(`${WORDS[search("b").length]} cities`);
      expect(s).toContain(search("be").join(" and "));
      // the console's witness list, and the request keys the runtime gives the two searches
      expect(s).toContain(t.witnesses);
      expect(s).toContain("`GET /api/search#1` (the request for \"b\")");
      expect(s).toContain("`GET /api/search#2` (the request for \"be\")");
      expect(s).toContain("?genclass-schedule=fifo");
      expect(s).toContain("try a few");
      expect(s).toContain(`the last block of \`${t.entry}\``);
      expect(s).toContain("self-test");
      expect(s).toMatch(/claude mcp add genclass -- npx -y @genclass\/mcp@\d+\.\d+\.\d+/);
      expect(s).toContain("genclass_setup");
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------- React

interface Page {
  rt: RuntimeImpl;
  clock: FakeClock;
  server: FakeServer;
  conn: AgentConnection | null;
  container: HTMLElement;
  root: { render(n: unknown): void; unmount(): void };
}

let page: Page | null = null;
const realFetch = G.fetch;

afterEach(async () => {
  if (page) {
    try {
      page.root.unmount();
    } catch {
      /* ignore */
    }
    page.rt.destroy();
  }
  page = null;
  G.fetch = realFetch;
  delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
  await drain();
});

/** templates/react-vite/src/App.tsx compiled as Vite would (TSX, the automatic JSX runtime), on the React copy react-dom uses. */
function reactApp(React: unknown): unknown {
  const { code } = transformSync(read("templates/react-vite/src/App.tsx"), { loader: "tsx", format: "cjs", jsx: "automatic" });
  const jsx = req("react/jsx-runtime"); // loaded after loadReact: it requires that same React
  const mod: { exports: { default?: unknown } } = { exports: {} };
  const need = (id: string): unknown => {
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return jsx;
    throw new Error(`App.tsx imports ${id}`);
  };
  new Function("require", "module", "exports", code)(need, mod, mod.exports);
  return mod.exports.default;
}

/**
 * The react-vite page in development: the runtime first (observe, React discovery on, typing recorded), then React
 * renders <StrictMode><App /></StrictMode> as src/main.tsx does, then the agent link when the condition of src/main.tsx's
 * agent block holds for the page's URL. No MCP server: its hello is refused. `latency` is the mock's answer time per
 * query.
 */
async function reactPage(schedule: string | null, latency: Record<string, number>): Promise<Page> {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  G.fetch = server.fetch;
  delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  history.replaceState(null, "", schedule === null ? "/" : `/?genclass-schedule=${schedule}`);
  const search = mockSearch("react-vite");
  server.on("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { q, results: search(q) }, latency: latency[q] ?? 100 };
  });
  server.on("POST", "/v1/hello", { error: "network", latency: 0 });
  const rt = createRuntime({
    clock,
    global: globalThis,
    decider: new ScriptedDecider(),
    mode: "observe",
    report: "silent",
    autoState: true as never,
    observe: { fetch: true, xhr: false, user: true, untrustedEvents: true, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false },
  }) as RuntimeImpl;
  const R = loadReact(false);
  const App = reactApp(R.React);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = R.client.createRoot(container) as Page["root"];
  root.render(R.React.createElement(R.React.StrictMode, null, R.React.createElement(App)));
  await drain(8);
  const conn = entryGate("react-vite", "src/main.tsx")(location.search) ? connectAgent(rt) : null;
  page = { rt, clock, server, conn, container, root };
  return page;
}

/**
 * What a keystroke does to the controlled input: its new value, set through the element's own setter (past the value
 * tracker React puts on the node), and an input event (React's onChange).
 */
async function typeInto(p: Page, value: string): Promise<void> {
  const input = p.container.querySelector("input") as HTMLInputElement;
  let proto: object | null = Object.getPrototypeOf(input);
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "value"))) proto = Object.getPrototypeOf(proto);
  desc!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await p.clock.advance(0);
}

/** Type "b", then "be" `gapMs` later, and wait until every answer is delivered (a hold never outlasts 1.5 s). */
async function typeBe(p: Page, gapMs: number): Promise<string[]> {
  await typeInto(p, "b");
  await p.clock.advance(gapMs);
  await typeInto(p, "be");
  await p.clock.advance(3000);
  await drain(8);
  expect(p.server.hits.get("GET /api/search")).toBe(2);
  return Array.from(p.container.querySelectorAll("main li"), (li) => li.textContent ?? "");
}

const witnessLines = (c: AgentConnection | null): string[] => (c ? c.witnesses().map((w) => `${w.kind} ${w.subject}: ${w.by} over ${w.over}`) : []);

describe("templates/react-vite: what the race on demand shows (CONTRACT §16; AGENT.md §2, §3), with the real App.tsx", () => {
  const search = mockSearch("react-vite");
  const B = search("b");
  const BE = search("be");

  it("the mock's data: seven cities for \"b\", two for \"be\"", () => {
    expect(B).toHaveLength(7);
    expect(BE).toEqual(["Berlin", "Bern"]);
  });

  // "be" is typed 60 ms after "b"; each pair is [answer time for "b", answer time for "be"], all in the mock's 50-900 ms
  for (const [b, be] of [
    [200, 300], // without a schedule "b" lands first and the list is right
    [600, 100], // without a schedule "b" lands last
    [100, 850],
  ]) {
    it(`the README's seed, answers in ${b} and ${be} ms: the list ends on the "b" cities and the overwrite is a witness`, async () => {
      const seed = readmeSeed("react-vite");
      const p = await reactPage(`seeded:${seed}`, { b, be });
      expect(p.conn?.schedule).toEqual({ order: "seeded", seed });
      expect(await typeBe(p, 60)).toEqual(B);
      expect(p.conn?.recorded().order).toEqual(["GET /api/search#2", "GET /api/search#1"]);
      expect(p.conn?.recorded().forced).toBe(0);
      // App.state1: the second useState in App.tsx (the results), found by automatic state discovery
      expect(witnessLines(p.conn)).toEqual(["overwrote-newer App.state1: GET /api/search#1 over GET /api/search#2"]);
      expect(p.conn?.connected).toBe(false); // no MCP server: nothing waited for it
    });
  }

  it("fifo: the same typing ends on the \"be\" cities and records no witness", async () => {
    const p = await reactPage("fifo", { b: 600, be: 100 });
    expect(await typeBe(p, 60)).toEqual(BE);
    expect(p.conn?.recorded().order).toEqual(["GET /api/search#1", "GET /api/search#2"]);
    expect(witnessLines(p.conn)).toEqual([]);
  });

  it("without the parameter the link is not connected, and with these answer times the list is right", async () => {
    const p = await reactPage(null, { b: 200, be: 300 });
    expect(p.conn).toBeNull();
    expect(G.__GENCLASS_AGENT__).toBeUndefined();
    expect(await typeBe(p, 60)).toEqual(BE);
  });

  it("an answer that is back before \"be\" is typed is not held: the README's seed then ends on the \"be\" cities", async () => {
    const p = await reactPage(`seeded:${readmeSeed("react-vite")}`, { b: 50, be: 100 });
    expect(await typeBe(p, 150)).toEqual(BE);
    expect(witnessLines(p.conn)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ Vue

describe("templates/vue-vite: what the race on demand shows (CONTRACT §16; AGENT.md §2, §3), its watcher mirrored", () => {
  const search = mockSearch("vue-vite");

  /**
   * src/App.vue's watcher on `q`, writing the results with what `results` returns (in place of `results.value = ...`,
   * set up before any typing, as the component's setup does); the page's URL names the schedule. Types "b", then "be"
   * 60 ms later, and returns the connection once every answer is delivered.
   */
  async function vuePage(schedule: string, latency: Record<string, number>, results: (s: ReturnType<typeof setup>) => (v: string[]) => void): Promise<AgentConnection> {
    const s = setup({ mode: undefined, extraGlobal: { location: { href: `http://localhost:5173/?genclass-schedule=${schedule}`, pathname: "/", hostname: "localhost", search: `?genclass-schedule=${schedule}` } } });
    s.server.on("GET", "/api/search", ({ url }) => {
      const q = url.searchParams.get("q") ?? "";
      return { body: { q, results: search(q) }, latency: latency[q] ?? 100 };
    });
    s.server.on("POST", "/v1/hello", { error: "network", latency: 0 });
    const c = connectAgent(s.rt);
    const write = results(s);
    const watcher = (v: string): void => {
      if (!v) return void write([]);
      void s
        .fetch(`/api/search?q=${encodeURIComponent(v)}`)
        .then((r) => r.json())
        .then((r: { results: string[] }) => write(r.results));
    };
    watcher("b");
    await s.clock.advance(60);
    watcher("be");
    await s.clock.advance(3000);
    return c;
  }

  it("the README's seed: the list ends on the \"b\" cities, and with the results in a plain ref there is no witness", async () => {
    let results: string[] = [];
    const c = await vuePage(`seeded:${readmeSeed("vue-vite")}`, { b: 200, be: 300 }, () => (v) => (results = v));
    expect(results).toEqual(search("b"));
    expect(c.recorded().order).toEqual(["GET /api/search#2", "GET /api/search#1"]);
    expect(c.witnesses()).toEqual([]);
    c.disconnect();
  });

  it("fifo: the same typing ends on the \"be\" cities", async () => {
    let results: string[] = [];
    const c = await vuePage("fifo", { b: 600, be: 100 }, () => (v) => (results = v));
    expect(results).toEqual(search("be"));
    c.disconnect();
  });

  it("with the results registered through guard, the overwrite is an overwrote-newer witness", async () => {
    let results: string[] = [];
    const c = await vuePage(`seeded:${readmeSeed("vue-vite")}`, { b: 200, be: 300 }, (s) => {
      const store = s.rt.guard("results", { get: () => results, set: (x: string[]) => (results = x) });
      return (v) => store.set(v);
    });
    expect(results).toEqual(search("b"));
    expect(witnessLines(c)).toEqual(["overwrote-newer results: GET /api/search#1 over GET /api/search#2"]);
    c.disconnect();
  });
});
