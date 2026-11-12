// Shared by this package's tests: a throwaway project folder, a throwaway home for the CLI's session and notes, a
// stand-in for genclass.dev, and a way to read what a command printed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

export const HOST = "https://genclass.dev";
export const TOKEN = "gc_AbCdEfGhIjKlMnOpQrStUv";
export const SESSION = "gcs_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

const made: string[] = [];

/** A new empty folder, removed after the test. */
export function tempDir(prefix = "genclass-cli-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Writes files (relative path -> text) under `dir`. */
export function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A small Vite + React app the runtime CLI recognises. */
export function viteApp(dir: string, pkg: Record<string, unknown> = {}): void {
  write(dir, {
    "package.json": JSON.stringify({ name: "shop", private: true, type: "module", dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^5.0.0" }, ...pkg }, null, 2),
    "index.html": '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Shop</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
    "src/main.jsx": 'import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")).render(<h1>Shop</h1>);\n',
  });
}

/**
 * Before each test: a fresh config home (the CLI's session and notes go there, never to the real one) and the
 * default host. After each: every temp folder is removed.
 */
export function isolate(): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["XDG_CONFIG_HOME", "GENCLASS_HOST", "APPDATA", "CI"]) saved[k] = process.env[k];
    process.env.XDG_CONFIG_HOME = tempDir("genclass-cfg-");
    process.env.APPDATA = process.env.XDG_CONFIG_HOME;
    delete process.env.GENCLASS_HOST;
    process.env.CI = "1"; // no browser is opened by a test
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}

/** What was written to stdout while `fn` ran. */
export async function printed(fn: () => unknown): Promise<string> {
  let text = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as never);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return text;
}

type Answer = { status?: number; json?: unknown } | ((url: URL, init?: RequestInit) => { status?: number; json?: unknown });

/**
 * A stand-in for genclass.dev: `routes` maps "METHOD /path" (the path without its query) to an answer. A route that
 * is not listed answers 404. Every request is recorded.
 */
export function fakeServer(routes: Record<string, Answer>) {
  const calls: { method: string; path: string; query: string; auth: string | null; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    calls.push({ method, path: url.pathname, query: url.search, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = routes[`${method} ${url.pathname}`];
    const r = typeof a === "function" ? a(url, init) : a;
    if (!r) return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

export const ACCOUNT = { id: "acct0000000000000000001", email: "ada@example.com", github_login: null };

/** An app of the account as genclass.dev lists it. */
export const project = (over: Record<string, unknown> = {}) => ({ id: "proj000000000001", name: "shop", token: TOKEN, dashboard_url: `${HOST}/account/apps/proj000000000001`, created: "2026-11-01T00:00:00.000Z", last_event: null, first_event: null, ...over });

/** GET /api/cli/overview's answer. */
export const overview = (over: Record<string, unknown> = {}) => ({
  account: ACCOUNT,
  plan: { id: "free", name: "Free" },
  suggestions: { per_day: 3, shown: 3, used_today: 0, model: true },
  projects: [],
  github: { app: true, install_url: `${HOST}/github/install`, connect_url: `${HOST}/github/connect` },
  billing_url: `${HOST}/account/billing`,
  ...over,
});
