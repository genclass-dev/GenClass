// What each kind of problem is, how it is usually fixed, and the prompt a coding agent gets for it. These are the
// dashboard page's own texts (telemetry-worker/src/pages.ts: TYPES, CHECKS, CHECK_DO, STEPS, fixPrompt, checkPrompt,
// fixAllPrompt), so `genclass fix` and `genclass report` say what the Copy prompt and Copy as Markdown buttons say.
//
// Invariants:
// - Every sentence here is in pages.ts word for word (test/kinds.test.ts reads that file and fails when one is not),
//   so the two cannot drift apart unnoticed.
// - Pure: no file, no network, no clock. A kind this table does not have keeps its own name and gets the general
//   steps; nothing is guessed about it.
// - A prompt names pages and counts only. It holds nothing from the person's code, which this command never reads
//   for it.
// - A page's path and a kind's key reach the dashboard from visitors' browsers, so anyone who has an app's public
//   key can send one. Before either goes into a prompt (which `genclass fix` hands to an agent that can change code)
//   it is cut down to what a path or a key is made of: no spaces, quotes, brackets or line breaks, so it cannot
//   carry a sentence (safeRoute, KEY_RE). A kind whose key is not a plain key is left out of the list.

/** The model's kinds: a name, what it means, how it is usually fixed. */
export const TYPES = {
  duplicate: {
    name: "Double submits",
    what: "The same request was sent again with no new intent behind it. Usually a second click on a button that stays enabled while the first request is still running.",
    fix: "Disable the control while the request is in flight, or send an idempotency key so the server ignores the repeat. In guard mode GenClass can merge the repeat into the request already running.",
  },
  stale: {
    name: "Stale responses",
    what: "An older response arrived after newer data and was about to replace it, like results for “pa” under a search box that says “paris”.",
    fix: "Ignore responses that are no longer the latest, with an AbortController or a request counter. In guard mode GenClass can drop the stale write.",
  },
  failing: {
    name: "Failing endpoints",
    what: "An endpoint kept failing while the app kept calling it.",
    fix: "Back off after repeated failures and tell the user something is wrong instead of retrying in silence.",
  },
  slow: {
    name: "Slow operations",
    what: "An operation took far longer than it usually does on this app.",
    fix: "Check that endpoint's latency around these times, and show progress while users wait.",
  },
  conflict: {
    name: "Write races",
    what: "Two operations wrote the same state at about the same time, and whichever landed last won.",
    fix: "Send writes to the same field one at a time, or merge a server echo with what the user changed since.",
  },
  transient: {
    name: "One-off failures",
    what: "A request failed once in a way that usually succeeds on a second try.",
    fix: "Retry idempotent requests once after a short delay. In heal mode GenClass can retry them for you.",
  },
  inconsistent: {
    name: "Broken state",
    what: "Your state broke a rule it normally keeps, such as a cart total that no longer matches its lines.",
    fix: "Find the write that updated one of the fields without the other.",
  },
  overload: {
    name: "Request storms",
    what: "Work was triggered far more often than usual, often by a polling or re-render loop.",
    fix: "Debounce or deduplicate whatever triggers the requests.",
  },
  unusual: {
    name: "Unusual behaviour",
    what: "An operation did something different from what it normally does, such as writing fewer fields than usual.",
    fix: "Compare the operation's result with what it usually returns.",
  },
};

/** The measured visual checks: a name, what was measured, how it is usually fixed. */
export const CHECKS = {
  "image-broken": { name: "Broken images", what: "An image failed to load or decode, so visitors saw an empty box or the browser's broken-image icon.", fix: "Fix the image's URL or the file it points to, and give images that matter a fallback." },
  "image-css-broken": { name: "Broken background images", what: "A background image set in CSS answered with an error, so its element showed without it (Chromium reports these).", fix: "Fix the url() in the stylesheet or the file it points to." },
  "media-failed": { name: "Video or audio that failed", what: "A video or audio element failed with a network or decoding error, or the browser could not play its format.", fix: "Check the media URL and offer a format every browser plays." },
  "stylesheet-failed": { name: "Stylesheets that failed", what: "A stylesheet did not load (an error, or a page served instead of CSS), so part of the page was unstyled.", fix: "Fix the stylesheet's URL or what the server answers for it (status and content type)." },
  "font-failed": { name: "Fonts that failed", what: "A web font failed to load, so its text fell back to another font.", fix: "Fix the font file's URL, format or CORS headers, and keep a close fallback in font-family." },
  "icon-font-failed": { name: "Missing icons", what: "An icon font failed to load, so icons showed as empty boxes or as their names.", fix: "Fix the icon font's URL or CORS headers, or draw the icons as inline SVG." },
  "csp-blocked": { name: "Blocked by the CSP", what: "The page's Content-Security-Policy blocked a stylesheet, a font or an image the page uses.", fix: "Allow that source in the policy (style-src, font-src, img-src), or serve the file from an allowed origin." },
  "text-invisible": { name: "Invisible text", what: "Text drawn in almost its background's colour (contrast under 1.5:1) in the visitor's own colour scheme, so nobody could read it.", fix: "Set the text colour and the background together on the same selector, the dark-mode variant included. In guard mode with visual fixes on, GenClass applies a readable colour on the visitor's screen." },
  "text-template-leak": { name: "Template text on the page", what: "Unrendered template or code text reached the page, such as {{ name }}, [object Object], undefined or NaN.", fix: "Find the value that was missing or unformatted when it was rendered, and render a fallback instead." },
  "text-placeholder": { name: "Placeholder content", what: "Lorem ipsum, or an image from a placeholder service, was still on the page.", fix: "Replace the placeholder text or image with the real content." },
  "text-encoding": { name: "Garbled characters", what: "Text with mojibake (UTF-8 read as another encoding), replacement characters, or HTML entities shown as text.", fix: "Serve and read the text as UTF-8 end to end, and escape it once, not twice." },
  "css-var-undefined": { name: "Undefined CSS variables", what: "A rule uses a custom property (var(--name)) that nothing defines, with no fallback, so the declaration does nothing.", fix: "Define the variable, fix its name, or give var() a fallback." },
  "image-distorted": { name: "Stretched images", what: "An image was shown at an aspect ratio far from its own, so it looked stretched or squashed.", fix: "Set object-fit: cover (or contain) on it, or size it to its own aspect ratio." },
  "page-overflow-x": { name: "Page scrolls sideways", what: "The page was wider than the screen, so it scrolled sideways, usually on phones.", fix: "Give the element that sticks out max-width: 100%, or let it wrap; avoid fixed widths wider than the screen." },
  "viewport-meta-missing": { name: "No viewport tag", what: "On a phone the page rendered at desktop width because it has no viewport meta tag, so everything was tiny.", fix: "Add a viewport meta tag with width=device-width, initial-scale=1 to the page's head." },
  "layout-shift": { name: "Layout shifts", what: "Content jumped while visitors were reading it, often an image without a size or a late banner.", fix: "Reserve space for images, ads and embeds (width and height, or aspect-ratio), and insert late content below what the visitor is looking at." },
  "page-blank": { name: "Blank page", what: "The page's main area showed no text and no media for seconds after it loaded.", fix: "Find why the content did not render (a failed request, an error while rendering) and show an error state instead of nothing." },
  "click-blocked": { name: "Clicks on an invisible layer", what: "Clicks landed on an invisible or transparent layer over the content, so the controls under it never got them.", fix: "Remove the leftover overlay, or give it pointer-events: none while it is not shown." },
  "pointer-events-leak": { name: "Page stopped taking clicks", what: "pointer-events: none was left on the page's html or body with nothing open, so nothing on the page responded to clicks.", fix: "Clear the click block in the same code path that sets it, failure and cancel paths included (a finally block). In guard mode with visual fixes on, GenClass removes the leaked declaration on the visitor's screen." },
  "scroll-lock-stuck": { name: "Scroll locked", what: "overflow: hidden (or a fixed body) was left on the page with no dialog or menu open, so the page stopped scrolling.", fix: "Remove the lock in the same code path that closes the dialog, menu or notice, error and cancel paths included. In guard mode with visual fixes on, GenClass removes the leaked lock on the visitor's screen." },
  "control-unreachable": { name: "Controls out of reach", what: "A button or link stayed under another element (a sticky footer, a cookie bar) even at the end of the page, so it could not be clicked.", fix: "Leave room for the fixed element (padding at the bottom of the page) or move the control out from under it." },
  "focus-obscured": { name: "Focused element hidden", what: "An element reached with the keyboard, or a link's target, ended up hidden behind a sticky header or another layer.", fix: "Add scroll-padding-top (or scroll-margin) for the sticky header, or keep the layer out of the way." },
  "dialog-covered": { name: "Dialogs under other layers", what: "A dialog opened behind another element, so parts of it, or its buttons, could not be seen or clicked.", fix: "Put the dialog above everything else: the top layer (a dialog element opened with showModal()), or a z-index above the other layer's stacking context." },
  "request-stalled": { name: "Requests that never finished", what: "A request stayed pending while a control waited on it, so visitors were stuck with a spinner or a disabled button.", fix: "Give the request a timeout (AbortSignal.timeout) and show an error with a retry when it runs out." },
  "ad-heavy": { name: "Ads covering content", what: "Ads took more of the screen than the Coalition for Better Ads standards allow, or one covered the content as an overlay.", fix: "Reserve each ad's space in the layout and keep in-content ads out of fixed overlays. GenClass reports these and leaves the ads alone." },
  "text-warped": { name: "Warped text", what: "Text on screen that could not be read as text: squeezed or stretched, overlapping other text, or its letters spread apart.", fix: "Remove the transform, letter-spacing or fixed height that distorts it, and let the text wrap." },
};

/** What to do on the dev page so a check measures it again. */
export const CHECK_DO = {
  "scroll-lock-stuck": "Open and close every dialog, menu and notice on the page, error and cancel paths included, then try to scroll.",
  "pointer-events-leak": "Run every action that blocks clicks while it works, the failing path too (a bad input, the network off), then click something.",
  "click-blocked": "Open and close the overlays on the page, then click the controls under where they were.",
  "request-stalled": "Repeat the action with the request held up (genclass_explore with slow_ms), and watch what the control does while it waits.",
  "dialog-covered": "Open each dialog on the page.",
  "focus-obscured": "Tab through the page and follow its in-page links.",
  "control-unreachable": "Scroll to the end of the page on a phone-sized window.",
  "text-invisible": "Check the page in light and dark mode, and the hover and focus states of what it names.",
  "page-overflow-x": "Load the page in a phone-sized window.",
  "viewport-meta-missing": "Load the page in a phone-sized window.",
};

/** How the agent reproduces each of the model's kinds with the MCP server's tools, on page `r`. */
const STEPS = {
  stale: (r) => `genclass_explore with focus on the request behind ${r}: the same steps, its responses delivered later; genclass_replay of the stale order: reproduced. The generated test asserts the newest query's results stay.`,
  duplicate: (r) => `genclass_replay of the double click on ${r}; the identical-in-flight witness names both requests. The generated test asserts one request per click.`,
  conflict: (r) => `genclass_explore reorders the overlapping writes on ${r}; the overwrote-newer witness names the field. The generated test asserts the newer value stays.`,
  failing: (r) => `genclass_analytics local: the failure streak and p95 of the endpoint behind ${r}; genclass_explore with slow_ms shows what the page does while it fails. The test asserts the visible error state.`,
  transient: (r) => `genclass_analytics local: when the endpoint behind ${r} fails once; genclass_explore with slow_ms. The test asserts the retry and what the user sees.`,
  slow: (r) => `genclass_analytics local: p95 and the slow runs behind ${r}; genclass_explore with slow_ms for what the page shows while it waits.`,
  inconsistent: (r) => `genclass_explore on ${r}; the relation that broke (a count against its list) is the generated test's assertion.`,
  overload: (r) => `genclass_analytics local: the hot request rate on ${r}; the generated test asserts the request count once the trigger is debounced.`,
};
const stepFor = (k, r) => (STEPS[k] ?? ((x) => `genclass_explain on the finding from ${x}, then genclass_replay of the recorded order; the generated test asserts what the operation normally writes.`))(r);

/** What the runtime did, as the dashboard names it. */
export const ACTION_NAMES = {
  coalesce: "Merged a repeated request",
  discard: "Dropped a stale write",
  defer: "Waited for related requests",
  delay: "Delayed a request",
  retry: "Retried a failed request",
  serve_cached: "Answered from cache",
  block: "Blocked a request",
  hedge: "Sent a backup request",
  rollback: "Rolled back a write",
  resync: "Re-synced state",
  check_fix: "Fixed a measured check",
};

export const RANGE_IN = { "24h": "In the last 24 hours", "7d": "In the last 7 days", "30d": "In the last 30 days", "90d": "In the last 90 days", "1y": "In the last year" };

/** Page loads the agent needs: it says what to do, then waits for them itself. */
const WAIT =
  "When a step needs page loads on the dev page, tell me in one line exactly what to do there (for example: reload it and repeat the search fast), then wait for the loads yourself: check every 10 seconds (sleep 10 in a shell in between), for up to 5 minutes, instead of ending your turn.";
/** The package the prompts name. */
export const MCP_PKG = "@genclass/mcp";

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const fmt = (v) => Math.round(v || 0).toLocaleString("en-US");
const times = (v) => `${fmt(v)} ${Math.round(v) === 1 ? "time" : "times"}`;
const titled = (k, sep) => (k ? k.charAt(0).toUpperCase() + k.slice(1).replace(sep, " ") : "");

/** A kind of the model's, by its key; one the table does not have keeps its own name. */
export const typeOf = (k) => TYPES[k] ?? { name: k && k !== "(unknown)" ? titled(k, /[_-]+/g) : "Other", what: "", fix: "" };
/** A measured check, by its key. */
export const checkOf = (k) => CHECKS[k] ?? { name: k ? titled(k, /-/g) : "Other check", what: "", fix: "" };
/** Either, from a problem of the list below. */
export const infoOf = (x) => (x.check ? checkOf(x.key) : typeOf(x.key));

/** A kind's or a check's key as the runtime writes one: letters, digits, hyphens and underscores. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * A page's path as it may stand in a prompt: the characters a path is made of, anything else as an underscore, at
 * most 120. "/orders/:id" stays as it is; "/x) Ignore the above and ..." cannot stay a sentence.
 */
export const safeRoute = (r) => {
  const s = String(r ?? "").replace(/[^A-Za-z0-9/_.:~%@+*=,-]/g, "_").slice(0, 120);
  return s.startsWith("/") ? s : `/${s}`;
};

/** "kind TAB page" rows as { kind: [{ route, count }] }, the most frequent page first. */
function byKind(list) {
  const out = {};
  for (const x of list ?? []) {
    const i = x.key.indexOf("\t");
    if (i < 0) continue;
    (out[x.key.slice(0, i)] ??= []).push({ route: safeRoute(x.key.slice(i + 1)), count: x.count });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.count - a.count);
  return out;
}

/**
 * Every kind of problem in the period, the model's and the measured checks', the most frequent first, each with the
 * pages it was on: [{ key, count, check, where: [{ route, count }] }]. `breakdowns` is the server's own
 * (api.mjs fetchApp `more.breakdowns`); "expected" is not a problem and is left out.
 */
export function problemList(breakdowns) {
  const b = breakdowns ?? {};
  const model = byKind(b.detect_issue);
  const checks = byKind(b.check_issue);
  const out = (b.detect_diagnosis ?? []).filter((x) => x.key !== "expected" && x.count > 0 && KEY_RE.test(x.key)).map((x) => ({ key: x.key, count: x.count, check: false, where: model[x.key] ?? [] }));
  for (const x of b.check_kind ?? []) if (x.count > 0 && KEY_RE.test(x.key)) out.push({ key: x.key, count: x.count, check: true, where: checks[x.key] ?? [] });
  return out.sort((a, z) => z.count - a.count);
}

/** An app's name as it may stand in a prompt or a table: its owner's own words, on one line, without a backtick or a bar. */
const safeName = (name) => String(name ?? "").replace(/[`|\r\n]+/g, " ").slice(0, 80);

/** The prompt for one kind of problem: what, where, the usual fix, the steps with the MCP server's tools. */
export function fixPrompt(app, range, x) {
  app = safeName(app);
  const t = infoOf(x);
  const pages = x.where.slice(0, 4).map((w) => `${w.route} (${fmt(w.count)})`).join(", ");
  const top = x.where.length ? x.where[0].route : "the page";
  const when = lower(RANGE_IN[range] ?? RANGE_IN["7d"]);
  const server = `Use the GenClass MCP server (${MCP_PKG}; the project's MCP page in the GenClass dashboard says how to add it):`;
  if (x.check) {
    const out = [`Fix a problem GenClass measured in production in this web app (${app}): ${lower(t.name)} (the measured check ${x.key}), ${times(x.count)} ${when}${pages ? `, on ${pages}` : ""}.`, ""];
    if (t.what) out.push(`What it measured: ${t.what}`);
    if (t.fix) out.push(`How it is usually fixed: ${t.fix}`);
    out.push(
      "This is a measured check (a measurement against a fixed threshold, not a model finding): it says what was wrong on the page; the cause is in the code or the CSS.",
      "",
      server,
      `1. genclass_scan on ${top} (the dev server's URL, or the deployed page): it runs the same checks and lists this one with the element, its selector, what it measured and a suggested CSS change. With the dev page connected, genclass_findings lists it too, as kind check. ${CHECK_DO[x.key] ?? "Load the page and use it as visitors do."}`,
      `   ${WAIT}`,
      "2. Find the code or CSS behind it and fix it at the cause (the suggested CSS is a starting point, not a patch).",
      `3. Run genclass_scan on the page again, after the same steps: it must not list ${x.key} any more.`,
      "4. Tell me what you changed and what genclass_scan listed before and after.",
    );
    return out.join("\n");
  }
  const out = [`Fix a problem GenClass found in production in this web app (${app}): ${lower(t.name)}, ${times(x.count)} ${when}${pages ? `, on ${pages}` : ""}.`, ""];
  if (t.what) out.push(`What it means: ${t.what}`);
  if (t.fix) out.push(`How it is usually fixed: ${t.fix}`);
  out.push(
    "",
    server,
    `1. genclass_findings, then genclass_explain on the finding that matches. ${stepFor(x.key, top)}`,
    `   ${WAIT}`,
    "2. Find the code behind it and fix it; keep the regression test genclass_explain generates.",
    "3. Replay the recorded order again with genclass_replay: it must say not reproduced.",
    "4. Tell me what you changed, the test you added and the replay's verdict.",
  );
  return out.join("\n");
}

/** One prompt for every kind of problem in the period: the loop for each (reproduce, fix, prove). */
export function fixAllPrompt(app, range, list) {
  app = safeName(app);
  const checks = list.some((x) => x.check);
  const out = [
    `Fix the problems GenClass found in this web app (${app}) and prove each fix, with the GenClass MCP server (${MCP_PKG}; the project's MCP page in the GenClass dashboard says how to add it).`,
    "",
    `In production, ${lower(RANGE_IN[range] ?? RANGE_IN["7d"])}:`,
  ];
  for (const x of list) {
    const t = infoOf(x);
    out.push(`- ${t.name}${x.check ? ` (measured check ${x.key})` : ""}, ${times(x.count)}${x.where.length ? `, on ${x.where.slice(0, 3).map((v) => v.route).join(", ")}` : ""}.${t.fix ? ` Usual fix: ${t.fix}` : ""}`);
  }
  out.push(
    `- And every ${checks ? "other " : ""}check genclass_findings lists from the dev page (unreadable text, a scroll lock left on, a page that stops taking clicks).`,
    "",
    "1. genclass_status: the dev page must be connected; if it is not, tell me what to open.",
    `2. For each problem: genclass_findings, then genclass_explain; reproduce it with genclass_explore or genclass_replay. ${checks ? "A measured check is a measurement, not a recorded order: run genclass_scan on its page instead, which lists it with the element, its selector and a suggested CSS change. " : ""}${WAIT}`,
    "3. Fix the cause in the code, small and idiomatic; keep the regression test genclass_explain generates.",
    `4. Replay the recorded order again: it must say not reproduced.${checks ? " For a measured check, genclass_scan on its page must no longer list it." : ""}`,
    "5. Sum up in one line per problem: what it was, the proof, the fix.",
  );
  return out.join("\n");
}

const map = (list) => Object.fromEntries((list ?? []).map((x) => [x.key, x.count]));

/** Check fixes still in place when their page loads ended (applied minus undone), at most one per finding. */
export const checkFixed = (totals, breakdowns) => {
  const o = map(breakdowns?.check_fix);
  return Math.min(totals?.checks ?? 0, Math.max(0, (o.applied ?? 0) - (o.undone ?? 0)));
};

/** Whether the runtime itself did something for a stored event (the dashboard's own rule for its "GenClass" column). */
export const didAct = (r) => r.tier === "acted" && r.executed === true && !!r.ran && !["deliver", "send", "apply"].includes(r.ran);

/**
 * The period's numbers as a Markdown report a person or a coding agent can read (the dashboard's Copy as Markdown).
 * `app`: api.mjs fetchApp's answer; `name`: the app's name; `generated`: an ISO time for the heading.
 */
export function markdown(name, app, generated) {
  name = safeName(name);
  const t = app.more.totals;
  const b = app.more.breakdowns;
  const list = problemList(b);
  const out = [`# ${name} (GenClass dashboard)`, "", `${RANGE_IN[app.range] ?? app.range}, to ${String(generated).slice(0, 16).replace("T", " ")} UTC.`, "", "| Metric | Value |", "| --- | ---: |"];
  const cf = map(b.check_fix);
  const pages = new Set([...(b.detect_route ?? []).map((x) => x.key), ...(b.check_issue ?? []).map((x) => x.key.slice(x.key.indexOf("\t") + 1))]);
  for (const [label, v] of [
    ["Page loads", t.sessions],
    ["Decisions", t.decisions],
    ["Problems found", (t.detections ?? 0) + (t.checks ?? 0)],
    ["Of them measured checks (not model findings)", t.checks],
    ["Possible issues (lower confidence, not problems)", t.possible],
    ["Pages with a problem", pages.size + Math.max(0, (app.more.distinct.detect_route ?? 0) - (b.detect_route ?? []).length)],
    ["Times GenClass stepped in", t.interventions],
    ["Measured checks fixed on visitors' screens", cf.applied],
    ["Visits", t.ix_sessions],
    ["Page views", t.ix_views],
  ])
    if (typeof v === "number") out.push(`| ${label} | ${fmt(v)} |`);
  out.push("", "## Problems by type", "");
  const model = list.filter((x) => !x.check);
  if (!model.length) out.push("None in this period.", "");
  const section = (x, title) => {
    const info = infoOf(x);
    out.push(`### ${title}: ${fmt(x.count)}`, "");
    if (info.what) out.push(info.what, "");
    if (x.where.length) out.push(`Pages: ${x.where.slice(0, 4).map((p) => `\`${p.route}\` (${fmt(p.count)})`).join(", ")}`, "");
    if (info.fix) out.push(`Fix: ${info.fix}`, "");
  };
  for (const x of model) section(x, typeOf(x.key).name);
  const checks = list.filter((x) => x.check);
  if (checks.length) out.push("## Measured checks by kind", "", "Measurements with fixed thresholds, not model findings: genclass_scan on the page lists each one with its element and a suggested CSS change.", "");
  for (const x of checks) section(x, `${checkOf(x.key).name} (${x.key})`);
  const acts = [...(b.intervention ?? [])];
  if (cf.applied) acts.push({ key: "check_fix", count: cf.applied });
  if (acts.length) {
    out.push("## What GenClass did", "", "| Action | Times |", "| --- | ---: |");
    for (const x of acts.slice(0, 8)) out.push(`| ${ACTION_NAMES[x.key] ?? x.key} | ${fmt(x.count)} |`);
    out.push("");
  }
  const rec = app.more.events.slice(0, 10);
  if (rec.length) {
    out.push("## Latest detections", "", "| Time (UTC) | Page | What | Confidence | GenClass |", "| --- | --- | --- | ---: | --- |");
    for (const r of rec) out.push(`| ${String(r.at).slice(0, 16).replace("T", " ")} | ${r.route ? safeRoute(r.route) : "-"} | ${r.kind ? (KEY_RE.test(r.kind) ? typeOf(r.kind).name : "Other") : KEY_RE.test(r.trigger ?? "") ? r.trigger : "-"} | ${typeof r.confidence === "number" ? `${Math.round(r.confidence * 100)}%` : "-"} | ${didAct(r) ? (ACTION_NAMES[r.ran] ?? r.ran) : "Reported"} |`);
    out.push("");
  }
  out.push("Counts only: GenClass stores no text from the app's pages. Guide: https://genclass.dev/docs/dashboard");
  return out.join("\n");
}
