// The tree view's request count, without GenClass (docs/adoption/hunts/prometheus-mantine-ui.md, section 7).
// Opens the query page with the tree view shown, N times, and counts the /api/v1/query requests each tree node sends
// and how many the browser reports aborted. Plain Playwright: nothing is injected, delayed or reordered.
//
//   node docs/adoption/hunts/prometheus-mantine-ui/requests.mjs [--app http://localhost:4173] [--runs 8]
//
// Run it against the unfixed build and the fixed build (`vite preview` of each, both proxied to the same Prometheus).

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    app: { type: "string", default: "http://localhost:4173" },
    runs: { type: "string", default: "8" },
    expr: { type: "string", default: "sum by (job) (up) + count by (job) (go_goroutines)" },
  },
});
const APP = arg.app.replace(/\/$/, "");
// The tree's own requests: /query?query=<node> with no time= or stats= (the table's requests carry both).
const isTreeNode = (u) => /\/api\/v1\/query\?query=[^&]*$/.test(u) && !/query=time\(\)/.test(decodeURIComponent(u));
const browser = await chromium.launch();
const runs = [];
for (let i = 0; i < Number(arg.runs); i++) {
  const page = await browser.newPage();
  const sent = [];
  const aborted = [];
  page.on("request", (r) => isTreeNode(r.url()) && sent.push(decodeURIComponent(r.url().split("query=")[1]).replace(/\+/g, " ")));
  page.on("requestfailed", (r) => isTreeNode(r.url()) && aborted.push(decodeURIComponent(r.url().split("query=")[1]).replace(/\+/g, " ")));
  await page.goto(`${APP}/query?g0.expr=${encodeURIComponent(arg.expr)}&g0.show_tree=1&g0.tab=table`);
  // every node shows its result count once its own request has answered
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('[class*="_nodeText_"]')];
    return nodes.length > 0 && nodes.every((n) => /results?/.test(n.nextElementSibling?.textContent ?? ""));
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(500);
  const nodes = await page.locator('[class*="_nodeText_"]').count();
  runs.push({ nodes, sent: sent.length, aborted: aborted.length, sentQueries: sent, abortedQueries: aborted });
  await page.close();
}
await browser.close();
const sum = (k) => runs.reduce((a, r) => a + r[k], 0);
console.log(JSON.stringify({ app: APP, expr: arg.expr, runs: runs.length, nodes: runs[0]?.nodes, sentTotal: sum("sent"), abortedTotal: sum("aborted"), perRun: runs }, null, 2));
