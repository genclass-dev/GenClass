// GenClass goes first, before React, so it is installed before your app and its state are created.
// "@genclass/runtime/auto" observes (reports what it sees, never changes anything). To let it act, switch to
// "@genclass/runtime/auto/guard". Add ?genclass=off to the URL to turn it off for a page load.
import genclass from "@genclass/runtime/auto";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The devtools overlay, in development only (not in your production bundle).
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));

// The race on demand (README, "See the race on demand"), in development only: with ?genclass-schedule=seeded:1 in the
// URL, the agent link delivers the search answers in that order. Without the parameter it is not loaded, so a page
// load sends nothing to the MCP server's address (127.0.0.1:47357). For a coding agent's explore, drop the URL check
// so that every dev page load connects.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("genclass-schedule")) {
  import("@genclass/runtime/agent").then((a) => a.connectAgent(genclass));
}
