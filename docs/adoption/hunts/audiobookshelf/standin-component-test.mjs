// Stand-in for the Cypress component spec in audiobookshelf.patch (client/cypress/tests/components/widgets/
// BookDetailsEdit.cy.js), used because this session could not download the Cypress binary (download.cypress.io is not
// reachable from the cloud environment). It mounts the same BookDetailsEdit.vue file with Vue 2.7's full build in
// Chromium, with the same real children (TextInputWithLabel, TextInput) and the same stubs, and replays the spec's two
// cases: type into the title, replace the libraryItem prop the way setProps does, read the inputs.
//
//   node docs/adoption/hunts/audiobookshelf/standin-component-test.mjs --client ~/targets/audiobookshelf/client [--runs 3]
//
// Prints PASS/FAIL per case per run. The real spec is what the sender runs (`npm test` in client/, with Chrome).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({ options: { client: { type: "string" }, runs: { type: "string", default: "3" } } });
const client = arg.client;

// an SFC to a component expression: its template string and its `export default {...}` object
function sfc(rel) {
  const src = readFileSync(join(client, rel), "utf8");
  const template = /<template>([\s\S]*)<\/template>/.exec(src)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(src)[1].replace("export default", "return");
  return `Object.assign((function(){${script}})(), { template: ${JSON.stringify(template)} })`;
}

const page = `<!doctype html><html><body><div id="app"></div>
<script>${readFileSync(join(client, "node_modules/vue/dist/vue.js"), "utf8")}</script>
<script>
Vue.config.productionTip = false; Vue.config.devtools = false;
Vue.prototype.$strings = ${readFileSync(join(client, "strings/en-us.json"), "utf8")};
Vue.prototype.$store = { state: { libraries: { filterData: {} } } };
const stub = { props: ["value"], template: "<div></div>" };
Vue.component("ui-text-input", ${sfc("components/ui/TextInput.vue")});
Vue.component("ui-text-input-with-label", ${sfc("components/ui/TextInputWithLabel.vue")});
for (const n of ["ui-multi-select-query-input", "ui-multi-select", "ui-rich-text-editor", "ui-checkbox", "widgets-series-input-widget"]) Vue.component(n, stub);
const BookDetailsEdit = ${sfc("components/widgets/BookDetailsEdit.vue")};
const libraryItem = { id: "li_1", mediaType: "book", media: { metadata: { title: "Original Title", subtitle: null, description: null, authors: [], narrators: [], genres: [], series: [], publishedYear: "2001", publisher: "Original Publisher", language: null, isbn: null, asin: null, explicit: false, abridged: false }, tags: [] } };
window.withMetadata = (item, metadata) => ({ ...item, media: { ...item.media, metadata: { ...item.media.metadata, ...metadata } } });
window.libraryItem = libraryItem;
window.mountIt = () => {
  document.getElementById("app").innerHTML = "<div id='root'></div>";
  window.host = new Vue({ data: { item: libraryItem }, render(h) { return h(BookDetailsEdit, { ref: "c", props: { libraryItem: this.item } }) } }).$mount("#root");
};
</script></body></html>`;

const browser = await chromium.launch();
const tally = { pass: 0, fail: 0 };
for (let run = 1; run <= Number(arg.runs); run++) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.setContent(page);
  const title = p.locator('input[placeholder="Title"]');
  const publisher = p.locator('input[placeholder="Publisher"]');

  // case 1: keeps unsaved edits when the same item is updated
  await p.evaluate(() => window.mountIt());
  await title.fill("Edited Title");
  await p.evaluate(() => (window.host.item = window.withMetadata(window.libraryItem, { publisher: "New Publisher" })));
  await p.waitForTimeout(50);
  const t1 = await title.inputValue();
  const p1 = await publisher.inputValue();
  const payload = await p.evaluate(() => JSON.stringify(window.host.$refs.c.checkForChanges().updatePayload));
  const ok1 = t1 === "Edited Title" && p1 === "New Publisher" && payload === JSON.stringify({ metadata: { title: "Edited Title" } });
  console.log(`run ${run} case "keeps unsaved edits when the same item is updated": title="${t1}" publisher="${p1}" payload=${payload} -> ${ok1 ? "PASS" : "FAIL"}`);

  // case 2: resets the form when a different item is loaded
  await p.evaluate(() => window.mountIt());
  await title.fill("Edited Title");
  await p.evaluate(() => (window.host.item = window.withMetadata({ ...window.libraryItem, id: "li_2" }, { title: "Other Title" })));
  await p.waitForTimeout(50);
  const t2 = await title.inputValue();
  const ok2 = t2 === "Other Title";
  console.log(`run ${run} case "resets the form when a different item is loaded": title="${t2}" -> ${ok2 ? "PASS" : "FAIL"}`);
  if (errors.length) console.log(`  pageerror: ${errors[0]}`);
  tally[ok1 ? "pass" : "fail"]++;
  tally[ok2 ? "pass" : "fail"]++;
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(tally));
