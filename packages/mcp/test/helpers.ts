// Test helpers: page-like HTTP calls to a bridge (with an Origin header, as a browser sends), recorded runs, and a
// per-test directory for the bridge's API token.
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActStep, Snapshot, Step } from "../src/types.js";

export function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: any }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(data), host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        let json: unknown = null;
        try {
          json = t ? JSON.parse(t) : null;
        } catch {
          json = t;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

export function options(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "OPTIONS", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

export const PAGE = { origin: "http://localhost:5173" };

/** What a current page runtime says it can run (hello `caps`, genclass-agent/1). */
export const CAPS = ["lifo", "ranked", "reverse", "delaySeed", "net"];

/** A page load: hello, then a function that sends events for its run (with its token). */
export async function page(port: number, route = "/search", schedule?: unknown, origin = PAGE.origin, caps?: string[]) {
  const h = await post(port, "/v1/hello", hello(route, schedule, caps), { origin });
  const { run, token } = h.json as { run: string; token: string };
  return {
    run,
    token,
    schedule: h.json.schedule,
    send: (events: unknown[]) => post(port, "/v1/events", { run, token, events }, { origin }),
  };
}

export function tokenDir(): string {
  return mkdtempSync(join(tmpdir(), "gc-token-"));
}

export function act(i: number, kind: string, target: string, value?: string, extra: Partial<ActStep> = {}): ActStep {
  return { k: "act", i, t: i * 100, kind, target, ...(value !== undefined ? { value } : {}), ...extra };
}

export function snap(state: Record<string, string>, text: string[] = [], extra: Partial<Snapshot> = {}): Snapshot {
  return { t: 1000, state, text, requests: {}, witnesses: 0, errors: 0, forced: 0, ...extra };
}

export function hello(route = "/search", schedule: unknown = undefined, caps?: string[]) {
  return { schema: "genclass-agent/1", page: { url: `http://localhost:5173${route}`, route, title: "App" }, runtime: { mode: "observe", model: "ready" }, ...(schedule ? { schedule } : {}), ...(caps ? { caps } : {}) };
}

export function steps(...s: Step[]): Step[] {
  return s;
}

/** The three searches typing "react" sends (request keys in start order). */
export const SEARCHES = ["GET /api/search#1", "GET /api/search#2", "GET /api/search#3"];

/**
 * Their timing log as a page sends it (genclass-agent/1 `net`): sent at 10, 30 and 50 ms, ready 100 ms later (so all
 * three overlap), delivered 30 ms apart in `order`; `extra` entries are appended.
 */
export function searchLog(order: string[], extra: Record<string, unknown>[] = []) {
  return [...SEARCHES.map((key, i) => ({ key, n: i, s: 10 + 20 * i, r: 110 + 20 * i, d: 200 + 30 * order.indexOf(key) })), ...extra];
}

/** One load of the search scenario: typing, the deliveries in `order` with their log, then the state it settled in. */
export function searchLoad(order: string[], results = "react!", text = ["Results for react"], extra: Record<string, unknown>[] = []) {
  return [
    { t: "steps", steps: [act(0, "type", 'searchbox "Search"', "react", { count: 5, dur: 400 })], order, net: searchLog(order, extra) },
    { t: "snapshot", snapshot: snap({ "search.results": results, "search.input": "react" }, text) },
  ];
}
