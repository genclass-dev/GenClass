// GenClass goes first, before React, so it is installed before your app and its state are created.
// "@genclass/runtime/auto" observes (reports what it sees, never changes anything). To let it act, switch to
// "@genclass/runtime/auto/guard". Add ?genclass=off to the URL to turn it off for a page load.
import "@genclass/runtime/auto";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
