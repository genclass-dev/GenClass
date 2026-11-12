// A dashboard answer (GET /api/cli/app) with every part filled, for the tests of the views that read it.
import { fetchApp } from "../src/api.mjs";
import { fakeServer, HOST, SESSION } from "./helpers.js";

const row = (key: string, count: number) => ({ key, count });
export const NOW = Date.parse("2026-11-12T12:00:00Z");

/** The stats as genclass.dev sends them for an app on a plan with visitor analytics. */
export const STATS = {
  name: "shop",
  token: "gc_AbCdEfGhIjKlMnOpQrStUv",
  created: "2026-11-01T00:00:00.000Z",
  lastEvent: "2026-11-12T11:57:00.000Z",
  range: "7d",
  from: "2026-11-05T12:00:00.000Z",
  generated: "2026-11-12T12:00:00.000Z",
  totals: {
    sessions: 1204, decisions: 900, detections: 30, acted: 12, possible: 4, checks: 9, check_loads: 600, check_ms: 6000, visual_fix: 40,
    model_ready: 1190, model_load_failed: 6, modelLoadAvgMs: 1250, latency_ms_n: 300, latencyAvgMs: 12, failOpens: 2, hidden_skipped: 30, model_dropped: 10,
    records_sampled_out: 50, telemetry_dropped: 3, interventions: 12, actionLimits: 1, modelErrors: 6,
    ix_views: 3100, ix_sessions: 1000, ix_engaged_ms: 124_000_000, ix_click: 4000, ix_rage: 40, ix_dead: 22,
  },
  breakdowns: {
    detect_diagnosis: [row("duplicate", 14), row("stale", 11), row("failing", 3), row("expected", 2), row("odd_plugin_kind", 2)],
    detect_route: [row("/checkout", 16), row("/search", 11), row("/cart", 3)],
    detect_issue: [row("duplicate\t/checkout", 14), row("stale\t/search", 9), row("failing\t/cart", 3), row("stale\t/checkout", 2), row("odd_plugin_kind\t/a/very/long/page/address/that/goes/on/and/on/for/a/while", 2)],
    possible_diagnosis: [row("unusual", 4)],
    possible_issue: [row("unusual\t/", 4)],
    check_kind: [row("text-invisible", 6), row("image-broken", 3)],
    check_issue: [row("text-invisible\t/pricing", 6), row("image-broken\t/", 3)],
    check_fix: [row("applied", 5), row("undone", 1)],
    check_tier: [row("light", 200)],
    visual_setting: [row("on", 600)],
    intervention: [row("coalesce", 7), row("discard", 5)],
    action_outcome: [row("applied", 12), row("undone", 1)],
    mode: [row("guard", 1100), row("observe", 104)],
    backend: [row("webgpu", 900), row("wasm", 290)],
    runtime: [row("0.3.0-beta.6", 1100), row("0.3.0-beta.5", 104)],
    model_errors: [row("failed to fetch the model: 503", 6)],
    trigger: [row("delivery", 880), row("store", 20)],
    page_route: [row("/", 700), row("/checkout", 300), row("/search", 204)],
    ix_views: [row("/", 1500), row("/pricing", 700), row("/checkout", 500), row("/search", 250), row("/about", 100), row("/blog/a-rather-long-article-title-that-keeps-going-and-going", 50)],
    ix_engaged_ms: [row("/", 60_000_000), row("/pricing", 49_000_000), row("/checkout", 15_000_000)],
    ix_scroll: [row("/\t100", 600), row("/\t50", 1100), row("/pricing\t100", 350)],
    ix_ref: [row("google.com", 520), row("(direct)", 300), row("news.ycombinator.com", 120), row("bing.com", 40), row("reddit.com", 12), row("duckduckgo.com", 8)],
    ix_utm_campaign: [row("launch", 80)],
    ix_utm_source: [row("newsletter", 80)],
    ix_utm_medium: [row("email", 80)],
    ix_device: [row("desktop", 610), row("mobile", 360), row("tablet", 30)],
    ix_browser: [row("Chrome", 600), row("Safari", 300), row("Firefox", 70), row("Edge", 30)],
    ix_os: [row("macOS", 400), row("iOS", 300), row("Windows", 200), row("Android", 100)],
    ix_country: [row("CA", 700), row("US", 250), row("GB", 30), row("DE", 20)],
    ix_returning: [row("new", 640), row("returning", 360)],
    ix_click: [row("/\tbutton Buy now", 900), row("/pricing\tbutton Start", 500), row("/checkout\tbutton Pay", 400)],
    ix_rage: [row("/checkout\tbutton Pay", 31), row("/\tbutton Buy now", 9)],
    ix_dead: [row("/pricing\ta Compare plans", 22)],
    ix_path: [row("/ > /pricing > /checkout", 210), row("/ > /search", 90)],
    ix_nav: [row("/\t/pricing", 400), row("/pricing\t/checkout", 260)],
    ix_first: [row("/\tbutton Buy now", 500)],
  },
  distinct: { detect_route: 3, page_route: 3 },
  series: [0, 2, 1, 5, 3, 9, 10].map((d, i) => ({ bucket: `2026-11-0${6 + i}`.replace("2026-11-010", "2026-11-10").replace("2026-11-011", "2026-11-11").replace("2026-11-012", "2026-11-12"), sessions: 150 + i, decisions: 100, detections: d, acted: 1, possible: 0, checks: i % 2, ix_views: 400 + i, ix_sessions: 120 + i * 5 })),
  typeSeries: [],
  checkSeries: [],
  previous: { sessions: 1000, detections: 20, acted: 5, checks: 6, ix_views: 2500, ix_sessions: 900 },
  recent: [
    { t: "2026-11-12T11:57:00.000Z", route: "/search", fn: "loadResults", trigger: "delivery", diagnosis: "stale", action: "discard", ran: "discard", confidence: 0.94, mode: "guard", executed: true, acted: true, kind: "acted" },
    { t: "2026-11-12T11:20:00.000Z", route: "/checkout", fn: null, trigger: "delivery", diagnosis: "duplicate", action: "coalesce", ran: null, confidence: 0.88, mode: "observe", executed: false, acted: false, kind: "detect" },
    { t: "2026-11-12T03:00:00.000Z", route: "/a/very/long/page/address/that/goes/on/and/on/for/a/while", fn: null, trigger: "delivery", diagnosis: "odd_plugin_kind", action: null, ran: null, confidence: null, mode: "observe", executed: null, acted: null, kind: "detect" },
  ],
  visits: { sessions: 1000, pages: 3100, bounces: 420, entry: [row("/", 700), row("/pricing", 200), row("/blog/a-rather-long-article-title-that-keeps-going-and-going", 100)], exit: [row("/checkout", 300), row("/", 280)] },
  funnels: [{ name: "Buy", steps: ["/", "/pricing", "/checkout"], counts: [700, 310, 120] }],
  agent: {
    findings: [{ id: "f1", kind: "stale-write", route: "/search", found: "2026-11-11T10:00:00.000Z", explained: true, replayed: true, reproduced: true, reproducedN: 2, tested: true, proven: false, closed: false, updated: "2026-11-12T09:00:00.000Z" }],
    counts: { found: 3, reproduced: 2, tested: 1, proven: 1 },
    stages: { found: 3, explained: 3, reproduced: 2, fixed: 1, closed: 1, open: 2, continued: 1 },
    log: [{ at: "2026-11-12T09:00:00.000Z", t: "replay", id: "f1", kind: "stale-write", route: "/search", reproduced: true, runs: null, races: null, what: null }, { at: "2026-11-12T08:00:00.000Z", t: "explore", id: null, kind: null, route: "/search", reproduced: null, runs: 12, races: 2, what: null }],
    last: "2026-11-12T09:00:00.000Z",
  },
  dashboard_url: `${HOST}/account/apps/proj000000000001`,
};

/** The answer as the command reads it (src/api.mjs fetchApp), with `over` merged into what the server sends. */
export async function appOf(over: Record<string, unknown> = {}) {
  const server = fakeServer({ "GET /api/cli/app": { json: { ...STATS, ...over } } });
  const app = await fetchApp({ access_token: SESSION, host: HOST }, "proj000000000001", "7d", { fetchFn: server.fetchFn });
  if (!app.ok) throw new Error("the fixture did not load");
  return app;
}

/** The stats as a plan without visitor analytics gets them. */
export const LOCKED = {
  totals: Object.fromEntries(Object.entries(STATS.totals).filter(([k]) => !k.startsWith("ix_"))),
  breakdowns: Object.fromEntries(Object.entries(STATS.breakdowns).filter(([k]) => !k.startsWith("ix_"))),
  visits: { sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] },
  funnels: [],
  locked: { analytics: { plan: "Team", upgrade_url: `${HOST}/account/billing` } },
};

/** Every printed line without colour. */
export const plainLines = (text: string): string[] => text.split("\n").map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
/** The longest printed line that holds no address (an address is the one thing that cannot be folded). */
export const widest = (text: string): number => Math.max(0, ...plainLines(text).filter((l) => !/https?:\/\//.test(l)).map((l) => l.length));
/** The printed lines that are wider than `max` (addresses apart): none, on a terminal that wide. */
export const tooWide = (text: string, max = 58): string[] => plainLines(text).filter((l) => !/https?:\/\//.test(l) && l.length > max);
