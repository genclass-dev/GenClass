// bench/late-load/run.mjs: what a page pays for GenClass loaded late (the README's "lite install"), against the
// first-line install and no GenClass.
//
// One app (templates/angular, an Angular SSR starter whose HttpClient uses fetch), the published runtime
// (@genclass/runtime, the version in RUNTIME below, from npm), four builds and six kinds of visit:
//   control                no GenClass anywhere
//   first                  the template as shipped: `import "@genclass/runtime/auto"` first in src/main.ts
//   late-import            no static import; a loader in src/main.ts that, after the load event and an idle
//                          callback, runs `import("@genclass/runtime/auto")` (a lazy chunk of the app's own build)
//   late-tag               the same loader adding the script tag instead (jsDelivr URL, served here from the installed
//                          package's dist/)
//   late-*-unsampled       the same two builds on a visit the loader's random draw leaves out
// The loaders are the README's, plus two performance.mark calls and a handle on the runtime for the harness. Every
// GenClass arm runs observe mode with the model on `preload: "lazy"`; the model is never downloaded here (every host
// but the app's and the routed jsDelivr files is aborted and listed), so this measures main-thread and first-load
// cost, not the model's memory or download. Cost only: nothing here is a detection rate.
//
// The page is opened as http://bench.example.com:<port> (mapped to 127.0.0.1 and treated as a secure origin), so the
// runtime's development-host defaults do not apply, as on a deployed site. Sizes are gzip -9 in bytes.
//
// Usage (on the VM, never on the Mac; Node 22.22.3 or 24.15 and later for Angular 22):
//   WORK=/data/late-load-work node bench/late-load/run.mjs [runs=9]
// Writes WORK/results.json (OUT= names another file) and prints the tables. Numbers: docs/runtime/RESULTS.md §28.

import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const WORK = process.env.WORK || "/data/late-load-work";
const APP = join(WORK, "app");
const RUNS = Number(process.argv[2] || 9);
const RUNTIME = "0.3.0-beta.6";
const HOST = "bench.example.com";
const TAG_URL = `https://cdn.jsdelivr.net/npm/@genclass/runtime@${RUNTIME}`;
const THROTTLE = 4;

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NG_CLI_ANALYTICS: "false" }, maxBuffer: 1 << 28 }).toString();

// ---- the four builds -------------------------------------------------------------------------------------------

const BOOT = `import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
`;

/** The README's loader around `start`'s body: 1 visit in 20, after the load event, in an idle callback. */
const loader = (body) => `${BOOT}
if (typeof window !== "undefined" && Math.random() < 0.05) {
  const start = () => {
    performance.mark("gc-inject");
${body}
  };
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(start, { timeout: 10000 }) : setTimeout(start, 3000));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle);
}
`;

const MAIN = {
  control: BOOT,
  // the template's own first line, with the model on lazy preload (./gc-config runs before it) and the runtime
  // reachable from the page for the harness
  first: `import "./gc-config";
import genclass from "@genclass/runtime/auto";
${BOOT}
(globalThis as any).__gc = genclass;
`,
  "late-import": loader(`    (globalThis as { GENCLASS_CONFIG?: object }).GENCLASS_CONFIG = { model: { preload: "lazy" } };
    void import("@genclass/runtime/auto").then((m) => {
      performance.mark("gc-loaded");
      (globalThis as any).__gc = m.default;
    });`),
  "late-tag": loader(`    const s = document.createElement("script");
    s.src = "${TAG_URL}";
    s.setAttribute("data-mode", "observe");
    s.setAttribute("data-preload", "lazy");
    s.onload = () => performance.mark("gc-loaded");
    document.head.appendChild(s);`),
};

const GC_CONFIG = `if (typeof window !== "undefined") (window as any).GENCLASS_CONFIG = { model: { preload: "lazy" } };
export {};
`;

function prepare() {
  if (!existsSync(join(APP, "node_modules"))) {
    rmSync(APP, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    cpSync(join(REPO, "templates/angular"), APP, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
    pkg.dependencies["@genclass/runtime"] = RUNTIME;
    pkg.devDependencies["playwright"] = "1.63.0";
    writeFileSync(join(APP, "package.json"), JSON.stringify(pkg, null, 2));
    const ng = JSON.parse(readFileSync(join(APP, "angular.json"), "utf8"));
    ng.projects["genclass-angular-starter"].architect.build.options.security.allowedHosts.push(HOST);
    writeFileSync(join(APP, "angular.json"), JSON.stringify(ng, null, 2));
    console.log("npm install ...");
    sh("npm install --no-audit --no-fund", APP);
  }
  writeFileSync(join(APP, "src/gc-config.ts"), GC_CONFIG);
  for (const arm of Object.keys(MAIN)) {
    const out = join(APP, `dist-${arm}`);
    if (existsSync(out)) continue;
    writeFileSync(join(APP, "src/main.ts"), MAIN[arm]);
    console.log(`ng build (${arm}) ...`);
    sh("npx ng build", APP);
    renameSync(join(APP, "dist"), out);
  }
}

/** gzip -9 of every .js file the browser build wrote, and of the files the built index names (the first load). */
const browserDir = (build) => join(APP, `dist-${build}`, "genclass-angular-starter/browser");

function sizes(arm) {
  const dir = browserDir(arm);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  const gz = (f) => gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
  const html = readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const initial = files.filter((f) => html.includes(f));
  return {
    files: files.length,
    allGzip: files.reduce((n, f) => n + gz(f), 0),
    initialFiles: initial.length,
    initialGzip: initial.reduce((n, f) => n + gz(f), 0),
  };
}

// ---- servers ---------------------------------------------------------------------------------------------------

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function serve(arm) {
  const port = await freePort();
  const child = spawn("node", [join(APP, `dist-${arm}`, "genclass-angular-starter/server/server.mjs")], { cwd: APP, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `${HOST}:${port}` } });
      if (res.ok) return { arm, port, child, origin: `http://${HOST}:${port}` };
    } catch {}
  }
  child.kill();
  throw new Error(`server for ${arm} did not start:\n${out.slice(-1500)}`);
}

// ---- one visit -------------------------------------------------------------------------------------------------

const OBSERVERS = `
  window.__m = { lt: [], lcp: 0, fcp: 0, ev: [] };
  const ob = (type, fn, extra) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {} };
  ob("longtask", (e) => __m.lt.push([e.startTime, e.duration]));
  ob("largest-contentful-paint", (e) => (__m.lcp = e.startTime));
  ob("paint", (e) => { if (e.name === "first-contentful-paint") __m.fcp = e.startTime; });
  ob("event", (e) => __m.ev.push([e.name, e.startTime, e.duration]), { durationThreshold: 16 });
`;

const metrics = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

async function visit(browser, server, arm, dist) {
  const build = arm.replace(/-unsampled$/, "");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const blocked = [];
  let telemetry = 0;
  let tagFiles = 0;
  await context.route((url) => url.host !== `${HOST}:${server.port}`, (route) => {
    const u = new URL(route.request().url());
    if (u.host === "cdn.jsdelivr.net" && u.pathname === `/npm/@genclass/runtime@${RUNTIME}`) {
      tagFiles++;
      return route.fulfill({ path: join(dist, "genclass.global.min.js"), contentType: "application/javascript", headers: { "access-control-allow-origin": "*" } });
    }
    const m = new RegExp(`^/npm/@genclass/runtime@${RUNTIME.replace(/\./g, "\\.")}/dist/(.+)$`).exec(u.pathname);
    if (u.host === "cdn.jsdelivr.net" && m && existsSync(join(dist, m[1]))) {
      tagFiles++;
      return route.fulfill({ path: join(dist, m[1]), contentType: "application/javascript", headers: { "access-control-allow-origin": "*" } });
    }
    if (u.hostname === "genclass.dev") {
      telemetry++;
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    blocked.push(u.origin + u.pathname);
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  await page.addInitScript(OBSERVERS);
  // the loader's draw: the sampled visit, or one it leaves out
  if (build.startsWith("late-")) await page.addInitScript(`Math.random = () => ${arm.endsWith("-unsampled") ? 0.99 : 0.01};`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  await page.goto(server.origin + "/", { waitUntil: "load" });
  await page.waitForTimeout(6000);
  const a = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
    const res = performance.getEntriesByType("resource").filter((r) => /\.js($|\?)|@genclass\/runtime/.test(r.name));
    return {
      load: nav.loadEventEnd, dcl: nav.domContentLoadedEventEnd, fcp: __m.fcp, lcp: __m.lcp, lt: __m.lt.slice(),
      inject: mark("gc-inject"), loaded: mark("gc-loaded"),
      jsBeforeLoad: res.filter((r) => r.responseEnd <= nav.loadEventEnd).length, jsAfterLoad: res.filter((r) => r.responseEnd > nav.loadEventEnd).length,
      afterLoadNames: res.filter((r) => r.responseEnd > nav.loadEventEnd).map((r) => r.name),
    };
  });
  const mA = await metrics(cdp);

  // the search box: two bursts of quick typing (every keystroke is one request, answered in 50 to 900 ms)
  const tI = await page.evaluate(() => performance.now());
  const input = page.locator("input");
  await input.click();
  await page.keyboard.type("lon", { delay: 80 });
  await page.waitForTimeout(2500);
  await input.fill("");
  await page.keyboard.type("ber", { delay: 80 });
  await page.waitForTimeout(2500);
  const b = await page.evaluate((tI) => ({ ev: __m.ev.filter((e) => e[1] >= tI), lt: __m.lt.filter((e) => e[0] >= tI), results: document.querySelectorAll("li").length }), tI);
  const mB = await metrics(cdp);
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await metrics(cdp)).JSHeapUsedSize;
  // what the runtime saw, read after every cost number: summary().requests needs the measured checks' chunk, which
  // rt.checkNow() loads (a lazy file, outside the costs above)
  const seen = await page.evaluate(async () => {
    const rt = window.__gc ?? window.GenClass?.runtime ?? null;
    if (!rt) return { hasRuntime: false };
    const sum = (o) => Object.values(o ?? {}).reduce((n, v) => n + v, 0);
    try {
      await rt.checkNow?.();
      const s = rt.summary();
      return { hasRuntime: true, requests: s.requests?.requests ?? null, ok2xx: s.requests?.["2xx"] ?? null, detections: sum(s.detections), possible: sum(s.possibleDetections), model: s.model?.state ?? null, rtErrors: s.errors };
    } catch (e) {
      return { hasRuntime: true, error: String(e).slice(0, 200) };
    }
  });
  await context.close();

  // gzip -9 of the JavaScript fetched after the load event and before the typing (the late loader's download)
  const fileOf = (url) => {
    const u = new URL(url);
    if (u.host === "cdn.jsdelivr.net") return u.pathname.includes("/dist/") ? join(dist, u.pathname.split("/dist/")[1]) : join(dist, "genclass.global.min.js");
    return join(browserDir(build), u.pathname.split("/").pop());
  };
  const jsAfterLoadGzip = a.afterLoadNames.reduce((n, url) => { const p = fileOf(url); return n + (existsSync(p) ? gzipSync(readFileSync(p), { level: 9 }).length : 0); }, 0);

  const tbt = (lt) => lt.reduce((n, [, d]) => n + Math.max(0, d - 50), 0);
  const afterLoad = a.lt.filter(([s]) => s >= a.load);
  return {
    arm, load: a.load, dcl: a.dcl, fcp: a.fcp, lcp: a.lcp,
    ltBeforeLoad: a.lt.length - afterLoad.length, tbtBeforeLoad: tbt(a.lt.filter(([s]) => s < a.load)),
    ltAfterLoad: afterLoad.length, tbtAfterLoad: tbt(afterLoad), longestAfterLoad: Math.max(0, ...afterLoad.map(([, d]) => d)),
    scriptMsToIdle: mA.ScriptDuration * 1000, taskMsToIdle: mA.TaskDuration * 1000,
    inject: a.inject, loaded: a.loaded, jsBeforeLoad: a.jsBeforeLoad, jsAfterLoad: a.jsAfterLoad, jsAfterLoadGzip,
    scriptMsTyping: (mB.ScriptDuration - mA.ScriptDuration) * 1000, taskMsTyping: (mB.TaskDuration - mA.TaskDuration) * 1000,
    worstEventMs: Math.max(0, ...b.ev.map((e) => e[2])), ltTyping: b.lt.length,
    results: b.results, hasRuntime: !!seen.hasRuntime, requests: seen.requests ?? null, ok2xx: seen.ok2xx ?? null, detections: seen.detections ?? null, possible: seen.possible ?? null, model: seen.model ?? null, rtErrors: seen.rtErrors ?? null, seenError: seen.error ?? null,
    heapMB: heap / 1048576, telemetry, tagFiles, blocked: [...new Set(blocked)], errors,
  };
}

// ---- run -------------------------------------------------------------------------------------------------------

const median = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const range = (xs) => { const s = xs.filter((x) => x != null); return s.length ? [Math.min(...s), Math.max(...s)] : null; };
const f = (x, d = 0) => (x == null ? "-" : x.toFixed(d));

prepare();
const size = Object.fromEntries(Object.keys(MAIN).map((arm) => [arm, sizes(arm)]));
const dist = join(APP, "node_modules/@genclass/runtime/dist");
const tagGzip = gzipSync(readFileSync(join(dist, "genclass.global.min.js")), { level: 9 }).length;
const tagRaw = readFileSync(join(dist, "genclass.global.min.js")).length;

const { chromium } = createRequire(join(APP, "package.json"))("playwright");
const servers = {};
for (const build of Object.keys(MAIN)) servers[build] = await serve(build);
for (const build of ["late-import", "late-tag"]) servers[`${build}-unsampled`] = servers[build];
const ARMS = ["control", "first", "late-import", "late-import-unsampled", "late-tag", "late-tag-unsampled"];
const origins = [...new Set(Object.values(servers).map((s) => s.origin))];
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${origins.join(",")}`] });
const runs = [];
try {
  for (const arm of ARMS) await visit(browser, servers[arm], arm, dist); // one warm-up visit per arm, discarded
  for (let i = 0; i < RUNS; i++) {
    for (const arm of ARMS) {
      const r = await visit(browser, servers[arm], arm, dist);
      runs.push(r);
      console.log(`run ${i + 1}/${RUNS} ${arm.padEnd(22)} load ${f(r.load)} lcp ${f(r.lcp)} script ${f(r.scriptMsToIdle)} ltAfter ${r.ltAfterLoad} longest ${f(r.longestAfterLoad)} typing ${f(r.scriptMsTyping)} worstEv ${f(r.worstEventMs)} req ${r.requests} det ${r.detections}`);
    }
  }
} finally {
  await browser.close();
  for (const s of new Set(Object.values(servers))) s.child.kill();
}

const KEYS = ["load", "dcl", "fcp", "lcp", "ltBeforeLoad", "tbtBeforeLoad", "ltAfterLoad", "tbtAfterLoad", "longestAfterLoad", "scriptMsToIdle", "taskMsToIdle", "inject", "loaded", "jsBeforeLoad", "jsAfterLoad", "jsAfterLoadGzip", "scriptMsTyping", "taskMsTyping", "worstEventMs", "ltTyping", "results", "requests", "ok2xx", "detections", "possible", "rtErrors", "heapMB", "telemetry", "tagFiles"];
const summary = {};
for (const arm of ARMS) {
  const rs = runs.filter((r) => r.arm === arm);
  summary[arm] = Object.fromEntries(KEYS.map((k) => [k, { median: median(rs.map((r) => r[k])), range: range(rs.map((r) => r[k])) }]));
  summary[arm].hasRuntime = rs.filter((r) => r.hasRuntime).length + "/" + rs.length;
  summary[arm].blocked = [...new Set(rs.flatMap((r) => r.blocked))];
  summary[arm].errors = [...new Set(rs.flatMap((r) => r.errors))];
  summary[arm].model = [...new Set(rs.map((r) => r.model))];
  summary[arm].seenError = [...new Set(rs.map((r) => r.seenError).filter(Boolean))];
}
const versions = { node: process.version, chromium: (await (async () => { const b = await chromium.launch(); const v = b.version(); await b.close(); return v; })()), runtime: RUNTIME, angular: JSON.parse(readFileSync(join(APP, "node_modules/@angular/core/package.json"), "utf8")).version, throttle: THROTTLE, runs: RUNS };
writeFileSync(join(WORK, process.env.OUT || "results.json"), JSON.stringify({ versions, size, tag: { gzip: tagGzip, raw: tagRaw }, summary, runs }, null, 1));

console.log("\n" + JSON.stringify(versions));
console.log(`script tag file: ${tagGzip} B gzip, ${tagRaw} B minified`);
console.log("\nbuilds (browser .js, gzip -9):");
for (const arm of Object.keys(MAIN)) console.log(`  ${arm.padEnd(12)} first load ${size[arm].initialGzip} B in ${size[arm].initialFiles} files; all ${size[arm].allGzip} B in ${size[arm].files} files`);
console.log("\nmedians [min..max] over " + RUNS + " runs, ms unless said:");
console.log("  " + "".padEnd(18) + ARMS.map((a) => a.padEnd(30)).join(""));
for (const k of KEYS) console.log("  " + k.padEnd(18) + ARMS.map((arm) => { const s = summary[arm][k]; return `${f(s.median, 1)} [${s.range ? f(s.range[0], 1) + ".." + f(s.range[1], 1) : "-"}]`.padEnd(30); }).join(""));
for (const arm of ARMS) console.log(`${arm}: runtime present ${summary[arm].hasRuntime}; blocked ${JSON.stringify(summary[arm].blocked)}; errors ${JSON.stringify(summary[arm].errors)}; model ${JSON.stringify(summary[arm].model)}; summary errors ${JSON.stringify(summary[arm].seenError)}`);
