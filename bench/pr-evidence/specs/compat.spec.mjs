// One test per data layer and compat scenario, driven and judged exactly as compat/run.mjs drives a trial: the mock
// backend is reset with the trial's seed and scenario, the scenario's own `drive` gives the input, the page is left to
// settle, and the scenario's `oracle` says from the DOM and the server's state whether a user would see a bug. The test
// itself never fails on that verdict: it writes it to a file, and run.mjs joins it with what GenClass recorded for the
// same test and seed. This file imports Playwright and compat's harness only, nothing of GenClass.
//
// compat changes a scenario's data with the seed (the word typed, the backend's own delays), which is right for a
// matrix and wrong for "one test, run many times". With BENCH_DATA_SEEDS (flaky.mjs sets it) there is one test per
// data seed, and the repeat index changes nothing but GenClass's delays: every repeat of a test types the same word
// against a backend with the same delays.
import { test as base } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackend } from "../../../compat/harness/backend.mjs";
import { startFront } from "../../../compat/harness/front.mjs";
import { SCENARIOS, domSnapshotFn } from "../../../compat/harness/scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// which of compat's apps (setup.mjs builds it), and its data layers (compat/harness/apps.mjs)
const DEFAULT_LAYERS = { "react-vite": "state,tanstack,zustand,zustand-on,redux,apollo", "vue-vite": "pinia", "solid-vite": "signals", "plain-html": "fetch" };
const NAME = process.env.BENCH_APP ?? "react-vite";
const APP = resolve(HERE, "..", ".work", NAME, "dist");
const VERDICTS = process.env.BENCH_VERDICT_DIR;
const LAYERS = (process.env.BENCH_LAYERS ?? DEFAULT_LAYERS[NAME] ?? "").split(",").filter(Boolean);
const SCEN = (process.env.BENCH_SCENARIOS ?? "a,b,c,d,e,f,g,h").split(",").filter(Boolean);
/** Data seeds held fixed across repeats (null: the data follows the repeat index, as in compat's matrix). */
const DATA = process.env.BENCH_DATA_SEEDS ? process.env.BENCH_DATA_SEEDS.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0) : [null];

const test = base.extend({
  // one origin per worker: the mock backend and the built app behind it
  origin: [
    async ({}, use) => {
      if (!existsSync(join(APP, "index.html"))) throw new Error(`${APP} is not built: run node bench/pr-evidence/setup.mjs ${NAME}`);
      const backend = createBackend();
      const front = await startFront({ backend, staticDir: APP });
      await use({ backend, front });
      await front.close();
      backend.close();
    },
    { scope: "worker" },
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** As compat/run.mjs: nothing in flight on the mock server and the scenario's DOM unchanged for quietMs. */
async function settle(page, backend, { quietMs, maxMs }) {
  const t0 = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - t0 < maxMs) {
    const dom = JSON.stringify(await page.evaluate(domSnapshotFn));
    if (dom !== last || backend.inflight() > 0) {
      if (dom !== last) last = dom;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return { settled: true, ms: Date.now() - t0 };
    await sleep(100);
  }
  return { settled: false, ms: Date.now() - t0 };
}

for (const layer of LAYERS) {
  for (const s of SCEN) for (const data of DATA) {
    const sc = SCENARIOS[s];
    test(data === null ? `${layer} > ${s} > ${sc.name}` : `${layer} > ${s} > data ${data} > ${sc.name}`, async ({ page, context, origin }, testInfo) => {
      // `run` is which repeat this is (GenClass's seed follows it); `seed` is what the scenario's data is made from
      const run = testInfo.repeatEachIndex + 1;
      const seed = data ?? run;
      const out = { layer, scenario: s, kind: sc.kind, seed: run, ...(data === null ? {} : { data }), ok: false, bug: null };
      origin.backend.reset({ seed, scenario: s });
      try {
        await page.goto(`${origin.front.url}/?s=${s}&layer=${layer}`, { waitUntil: "load", timeout: 60_000 });
        await page.waitForSelector('#compat[data-ready="1"]', { timeout: 30_000 });
        await settle(page, origin.backend, { quietMs: 300, maxMs: 8_000 });
        await sc.drive(page, { seed, context });
        // 900 ms of quiet is longer than the longest chaos hold (600 ms), so a held request is not mistaken for quiet
        out.settle = await settle(page, origin.backend, { quietMs: 900, maxMs: 25_000 });
        const dom = await page.evaluate(domSnapshotFn);
        out.bug = sc.oracle(dom, origin.backend.snapshot(), { seed });
        out.ok = true;
      } catch (e) {
        out.error = String(e?.message ?? e).slice(0, 600);
      }
      if (VERDICTS) {
        mkdirSync(VERDICTS, { recursive: true });
        writeFileSync(join(VERDICTS, `${layer}__${s}${data === null ? "" : `__d${data}`}__s${run}.json`), JSON.stringify(out));
      }
    });
  }
}
