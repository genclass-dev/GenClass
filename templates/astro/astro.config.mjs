// @ts-check
import node from "@astrojs/node";
import genclass from "@genclass/astro";
import { defineConfig } from "astro/config";

// GenClass, in the browser only: the integration injects the runtime's one line into every page. genclass() observes
// (reports what it sees, never changes anything) and draws nothing on the page. To let it act, use
// genclass({ mode: "guard" }). Add ?genclass=off to the URL to turn it off for a page load.
// The Node adapter is here so the mock API route (src/pages/api/search.ts) also runs in the production build.
export default defineConfig({
  integrations: [genclass()],
  adapter: node({ mode: "standalone" }),
});
