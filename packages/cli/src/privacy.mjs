// `genclass privacy`: what this project's GenClass setup sends from its visitors' browsers, to whom, what it keeps on
// their devices and for how long, read from the project's own files. The answer to "is it compliant?" is "you choose
// how GenClass runs"; this command says what the current choice is, in words a privacy policy or a record of
// processing can take, and the exact lines that make GenClass send and keep nothing.
//
// Invariants:
// - Read only, and local: it reads the project's files and nothing else. No request is made, nothing is written but
//   the --out file the person names, and it needs no sign-in and no plan (a privacy answer is never paywalled).
// - Every sentence about what is sent is a fact from packages/runtime/TELEMETRY.md and the README's
//   Content-Security-Policy section, chosen by the options found in the project. The setup is read from text, so it
//   says when a value could not be read ("not found in the project's files") instead of guessing a safe answer.
// - It is not legal advice and says so: the guidance names the rules and the regulators' readings, and leaves the
//   call to the person.

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { c, out } from "../../runtime/bin/lib/ui.mjs";
import { clean, good, header, note, para, warn, width, wrap } from "./tui.mjs";

const TELEMETRY_DOC = "https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md";
const PRIVACY_DOC = "https://github.com/genclass-dev/GenClass/blob/main/PRIVACY.md";
const CSP_DOC = "https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting";

/** Text that sets GenClass up: an import or script tag of the runtime, its init, its config, its meta tag. */
const REF = /@genclass\/runtime|GenClass\.init\s*\(|GENCLASS_CONFIG|<meta[^>]+name=["']genclass["']|genclass\.global(?:\.min)?\.js/;

/** Tests, fixtures and end-to-end specs: they import GenClass without shipping it. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|e2e|fixtures?|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The options that decide what is sent and kept, read from a project's GenClass files (text, not executed). */
export function readSetupText(text) {
  const t = String(text ?? "");
  const has = (re) => re.test(t);
  // the mode: the import names it (/auto/guard, /auto/heal), else a mode option or the script tag's data-mode
  const mode = has(/@genclass\/runtime\/auto\/heal|mode\s*[:=]\s*["']heal["']|data-mode=["']heal["']|mode=heal/)
    ? "heal"
    : has(/@genclass\/runtime\/auto\/guard|mode\s*[:=]\s*["']guard["']|data-mode=["']guard["']|mode=guard/)
      ? "guard"
      : "observe";
  const endpoint = /endpoint\s*:\s*["'`](https?:\/\/[^"'`\s]+)["'`]/.exec(t)?.[1] ?? null;
  const telemetryOff = has(/telemetry\s*:\s*false|data-telemetry=["']off["']|telemetry=off/);
  const analytics = has(/analytics\s*:\s*(?:true|\{)|data-analytics=["'](?:on|true)["']|analytics=on/);
  const situation = has(/situation\s*:\s*true/);
  const visual = has(/visual\s*:\s*(?:true|\{\s*[^}]*on\s*:\s*true)|data-visual=["'](?:on|true)["']/);
  const visualFix = visual && has(/fix\s*:\s*true/);
  const modelOff = has(/model\s*:\s*false|data-model=["']off["']/);
  const baseUrl = /baseUrl\s*:\s*["'`]([^"'`\s]+)["'`]/.exec(t)?.[1] ?? null;
  const persistOff = has(/persist\s*:\s*false/);
  const persistSession = has(/persist\s*:\s*["']session["']/);
  const sinkHosts = [...t.matchAll(/webhook:(https?:\/\/[^"'`\s,\]]+)/g)].map((m) => hostOf(m[1])).filter(Boolean);
  return {
    mode,
    telemetry: telemetryOff ? "off" : endpoint ? "own" : "on",
    endpoint: endpoint ? hostOf(endpoint) : null,
    analytics,
    situation,
    visual: visual ? (visualFix ? "on, with fixes" : "on") : "local",
    model: modelOff ? "off" : baseUrl ? (/^https?:\/\//.test(baseUrl) ? "other" : "self") : "cdn",
    modelHost: baseUrl && /^https?:\/\//.test(baseUrl) ? hostOf(baseUrl) : null,
    learn: persistOff ? "none" : persistSession ? "session" : "local",
    sinks: [...new Set(sinkHosts)],
    agentLink: has(/connectAgent\s*\(/),
  };
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

/**
 * The project's setup: where GenClass is added, the options found, the app's token (whether it reports to a
 * dashboard). `deps.inspect` is the runtime CLI's inspectProject (tests pass their own).
 */
export async function readSetup(o = {}, deps = {}) {
  const inspect = deps.inspect ?? (await import("../../runtime/bin/lib/init.mjs")).inspectProject;
  const st = inspect({ cwd: o.cwd });
  const cwd = st.cwd ?? resolve(o.cwd ?? ".");
  const files = [...new Set([...(st.marked ?? []), ...(st.files ?? [])])];
  const used = [];
  let text = "";
  for (const f of files) {
    let t;
    try {
      t = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    // a test that imports GenClass does not ship to visitors: only the app's own files say what they run
    if (!REF.test(t) || TEST_FILE.test(relative(cwd, f))) continue;
    used.push(relative(cwd, f) || f);
    text += `\n${t}`;
    if (used.length >= 20) break;
  }
  return {
    cwd,
    app: st.project?.name ?? null,
    framework: st.project?.label || null,
    installed: used.length > 0,
    files: used,
    token: !!st.token,
    ...readSetupText(text),
  };
}

/**
 * What the setup means, as rows of plain sentences: what leaves the visitor's browser and where it goes, what stays on
 * their device, the opt-outs, the guidance per region, the lines that make it send and keep nothing, and the
 * Content-Security-Policy it needs. Pure.
 */
export function dataMap(s) {
  const sent = [];
  const kept = [];
  if (s.telemetry === "on") {
    sent.push({
      to: "genclass.dev (GenClass's collector, a Cloudflare Worker; stored in Cloudflare R2)",
      what: `Diagnostics about GenClass's own decisions: the site's hostname, the page route with ids replaced (no query or fragment), the mode, each decision's kind, confidence and outcome, counts and timings, a random id that is new on every page load, and the device class (CPU cores, memory, GPU, connection type). The collector adds the visitor's country from the request and stores no IP address, user agent, cookie or header.${s.situation ? " Situation text is on (include: { situation: true }): it can hold query strings, the page title, error messages, the first 40 characters typed into ordinary inputs and short state values, after the redactor." : " No page text."}${s.visual !== "local" ? " With the visual checks on: counts per check and page, never selectors, text, colours or URLs." : ""}`,
      why: `Model evaluation and training by GenClass's maintainers${s.token ? ", and this app's dashboard" : ""}.`,
      keep: "90 days (1 year for an app on a plan with a year of history).",
    });
    if (s.analytics && s.token) {
      sent.push({
        to: "genclass.dev, for this app's dashboard only (never used for training)",
        what: "Interaction analytics: per page view the route, engaged time, scroll milestones, clicks, rage and dead clicks per element (named from markup, never its text); per visit a random visit id, the referring host and utm values, device class, browser and OS families, and whether the browser visited before.",
        why: "This app's visitor analytics.",
        keep: "90 days.",
      });
    }
  } else if (s.telemetry === "own") {
    sent.push({
      to: `${s.endpoint ?? "your own endpoint"} (your own collector: telemetry.endpoint)`,
      what: `The same diagnostics batches GenClass's collector would get${s.analytics ? ", and the interaction analytics" : ""}. Nothing reaches genclass.dev.`,
      why: "Whatever your collector does with them.",
      keep: "As your collector keeps them.",
    });
  }
  if (s.model === "cdn") {
    sent.push({
      to: "cdn.jsdelivr.net (a public CDN)",
      what: "Nothing about the visitor: the browser downloads the model files and ONNX Runtime's wasm from it, so the CDN receives the visitor's IP address and user agent, as any CDN does.",
      why: "To run the on-device model.",
      keep: "jsDelivr's own logs.",
    });
  } else if (s.model === "other") {
    sent.push({ to: `${s.modelHost} (model.baseUrl)`, what: "Nothing about the visitor: the model files are downloaded from it, so it receives the visitor's IP address.", why: "To run the on-device model.", keep: "That host's logs." });
  }
  for (const h of s.sinks) sent.push({ to: `${h} (a webhook sink)`, what: "Each finding's route, diagnosis and action, with the redacted evidence text by default (it can hold short fragments of what users typed). Telemetry opt-outs and GPC do not turn sinks off.", why: "Your own alerting.", keep: "As that endpoint keeps it." });
  if (s.agentLink) sent.push({ to: "127.0.0.1 on the developer's machine (the coding-agent link)", what: "Development builds only, on development hosts: the recording goes to GenClass's MCP server on the same machine. Inert on any page not served from the developer's machine.", why: "Debugging with a coding agent.", keep: "On the developer's machine." });

  if (s.learn === "local") kept.push({ where: "localStorage (genclass:learn)", what: "Learned flows behind GenClass's expectation reports: request signatures, routes, field names, hashed action labels, counts and timings; never element text or values. It never leaves the browser.", off: "learn: { persist: false }" });
  else if (s.learn === "session") kept.push({ where: "sessionStorage (genclass:learn)", what: "Learned flows and transition profiles for the tab's session, never element text or values. It never leaves the browser.", off: "learn: { persist: false }" });
  if (s.analytics && (s.token || s.telemetry === "own")) kept.push({ where: "localStorage (genclass.analytics.*)", what: "A random visit id for 30 minutes and a flag that the browser visited before.", off: "analytics: false" });
  if (s.model !== "off") kept.push({ where: "Cache Storage", what: "The model files, so they are not downloaded again.", off: "model: false (no model: GenClass then only observes without a diagnosis)" });

  const optOuts = [
    "Global Privacy Control (navigator.globalPrivacyControl): nothing is collected from that browser",
    "?genclass=no-telemetry in the address, for one page load (?genclass=off turns GenClass off)",
    'localStorage "genclass.telemetry" = "off", per browser and site',
  ];

  const sendsToGenClass = s.telemetry === "on";
  const eu = [];
  if (sendsToGenClass) eu.push("Telemetry is on: the runtime reads facts from the visitor's device and sends them to GenClass, which also uses them to improve its model. Regulators read ePrivacy Article 5(3) as covering scripts that send device information, not only cookies (EDPB Guidelines 2/2023), and the audience-measurement exemptions (CNIL, ICO) do not cover a recipient that reuses data for itself. The careful choice for EU, EEA and UK visitors is telemetry off, or GenClass started only after consent.");
  if (s.analytics && (s.token || s.telemetry === "own")) eu.push("Analytics are on: they are not strictly necessary for the service, so start them off there and call runtime.analytics.start() after consent, unless you rely on an exemption you have checked.");
  if (s.model === "cdn") eu.push("The model comes from jsDelivr, which receives visitors' IP addresses. A German court awarded damages over an IP address sent to a font CDN without consent (LG Munich I, 3 O 17493/20, 2022). Serving the model from your own site removes that recipient.");
  if (s.learn !== "none") eu.push("Learned flows are stored on the device. Storing is in Article 5(3)'s scope as well as reading, even when nothing leaves the browser; learn: { persist: false } stores nothing.");
  if (!eu.length) eu.push("In this setup GenClass sends nothing from the visitor's browser and stores nothing beyond what is listed. Name it in your privacy policy as code that runs in the page; there is no recipient to disclose.");

  const us = [
    "Global Privacy Control is honoured for every visitor, wherever they are. GenClass does not sell or share data for advertising.",
    sendsToGenClass ? "Under the CCPA, a vendor that receives personal information needs a service-provider contract; GenClass's data processing terms are not published yet, so if you need one before they are, use telemetry off." : "Nothing reaches GenClass, so there is no vendor to contract with for the runtime.",
    "Health, finance and children's sites: use telemetry off (TELEMETRY.md says the same). There is no business associate agreement for HIPAA.",
  ];

  const strict = [];
  if (s.telemetry === "on") strict.push(["telemetry: false", "nothing goes to genclass.dev (the dashboard stays empty)", "npx genclass init --no-telemetry"]);
  if (s.analytics) strict.push(["analytics: false", "no visitor analytics, and no visit id in localStorage", null]);
  if (s.model === "cdn") strict.push(['model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" }', "the model is served from your own site: no CDN sees your visitors", "npx @genclass/runtime@beta fetch-model public/genclass-model"]);
  if (s.learn !== "none") strict.push(["learn: { persist: false }", "nothing is stored on the device between page loads", null]);
  if (s.situation) strict.push(["telemetry: { include: { situation: false } }", "no page text, even with telemetry on", null]);

  const csp = [];
  if (s.telemetry === "on") csp.push("connect-src https://genclass.dev");
  if (s.telemetry === "own" && s.endpoint) csp.push(`connect-src https://${s.endpoint}`);
  if (s.model === "cdn") csp.push("connect-src https://cdn.jsdelivr.net");
  if (s.model === "other" && s.modelHost) csp.push(`connect-src https://${s.modelHost}`);
  if (s.model !== "off") csp.push("script-src 'wasm-unsafe-eval'", "worker-src 'self' (blob: for the script tag)");
  for (const h of s.sinks) csp.push(`connect-src https://${h}`);

  return { sent, kept, optOuts, eu, us, strict, csp };
}

/** The data map as Markdown, for a privacy policy, a record of processing or a vendor questionnaire. */
export function markdown(s, m, today = new Date().toISOString().slice(0, 10)) {
  const L = [];
  L.push(`# GenClass in ${s.app ?? "this app"}: what it sends and keeps`, "");
  L.push(`Generated by \`genclass privacy\` on ${today} from the project's files (${s.files.length ? s.files.map((f) => `\`${f}\``).join(", ") : "none found"}). Not legal advice.`, "");
  L.push("## Setup", "");
  L.push(`| | |`, `|---|---|`);
  for (const [k, v] of setupRows(s)) L.push(`| ${k} | ${v} |`);
  L.push("", "## What leaves the visitor's browser", "");
  if (!m.sent.length) L.push("Nothing.", "");
  else {
    L.push("| Recipient | What | Why | Kept |", "|---|---|---|---|");
    for (const x of m.sent) L.push(`| ${x.to} | ${x.what} | ${x.why} | ${x.keep} |`);
    L.push("");
  }
  L.push("Never sent in any setting: typed values of password, payment, one-time-code or secret-named inputs, cookies, request or response headers and bodies, storage contents, IP addresses or user agents (the collector does not store them).", "");
  L.push("## What stays on the visitor's device", "");
  if (!m.kept.length) L.push("Nothing.", "");
  else {
    L.push("| Where | What | Turn off |", "|---|---|---|");
    for (const x of m.kept) L.push(`| ${x.where} | ${x.what} | \`${x.off}\` |`);
    L.push("");
  }
  L.push("## Opt-outs GenClass honours", "", ...m.optOuts.map((x) => `- ${x}`), "");
  L.push("## EU, EEA and UK", "", ...m.eu.map((x) => `- ${x}`), "");
  L.push("## United States", "", ...m.us.map((x) => `- ${x}`), "");
  if (m.strict.length) {
    L.push("## To send and keep nothing", "", "Options for `GenClass.init()` or `window.GENCLASS_CONFIG` (the file `genclass init` wrote):", "");
    for (const [opt, what, cmd] of m.strict) L.push(`- \`${opt}\`: ${what}${cmd ? ` (\`${cmd}\`)` : ""}`);
    L.push("");
  }
  if (m.csp.length) L.push("## Content-Security-Policy", "", ...m.csp.map((x) => `- \`${x}\``), "");
  L.push("## Sources", "", `- What is sent, field by field: ${TELEMETRY_DOC}`, `- GenClass's privacy policy: ${PRIVACY_DOC}`, `- Content-Security-Policy and self-hosting: ${CSP_DOC}`, "");
  return L.join("\n");
}

function setupRows(s) {
  return [
    ["GenClass", s.installed ? `added (${s.files.slice(0, 3).join(", ")}${s.files.length > 3 ? ", ..." : ""})` : "not found in the project's files"],
    ["Mode", s.mode === "observe" ? "observe: reports only, changes nothing" : `${s.mode}: may change how the page handles responses`],
    ["Diagnostics", s.telemetry === "off" ? "off" : s.telemetry === "own" ? `to your own collector (${s.endpoint})` : "on (the default), to genclass.dev"],
    ["Dashboard", s.token ? "this app's key is set: diagnostics also fill its dashboard" : "no app key"],
    ["Page text", s.situation ? "on (include: { situation: true })" : "off (the default)"],
    ["Analytics", s.analytics ? (s.token || s.telemetry === "own" ? "on" : "asked for, but they need the app's key or your own endpoint") : "off (the default)"],
    ["Visual checks", s.visual === "local" ? "on localhost only (the default)" : s.visual],
    ["Model", s.model === "cdn" ? "from cdn.jsdelivr.net (the default)" : s.model === "self" ? "from your own site" : s.model === "other" ? `from ${s.modelHost}` : "off"],
    ["Stored on the device", s.learn === "none" ? "nothing (learn: { persist: false })" : s.learn === "session" ? "learned flows, for the tab's session" : "learned flows, in localStorage (the default)"],
  ];
}

/**
 * `genclass privacy [--md] [--out file] [--json]`. Exit 0; 1 when GenClass is not in the project (the map is still
 * printed: it shows what the defaults would do).
 */
export async function privacy(o = {}, deps = {}) {
  const s = await readSetup(o, deps);
  const m = dataMap(s);
  if (o.json) {
    out(JSON.stringify({ ok: true, setup: s, ...m }, null, 2));
    return s.installed ? 0 : 1;
  }
  if (o.md || o.out) {
    const md = markdown(s, m, deps.today);
    if (o.out) {
      try {
        writeFileSync(resolve(o.out), md);
      } catch (e) {
        warn(`Could not write ${clean(o.out, 80)}: ${clean(e?.message ?? e, 120)}`);
        return 1;
      }
      good(`Wrote ${clean(o.out, 80)}: the data map as Markdown, for your privacy policy or a vendor questionnaire.`);
      return s.installed ? 0 : 1;
    }
    out(md);
    return s.installed ? 0 : 1;
  }
  header({ app: s.app, framework: s.framework });
  out();
  note("What GenClass sends from your visitors' browsers, and what it keeps there, read from this project's files. Not legal advice.");
  if (!s.installed) {
    out();
    warn("GenClass is not in this project's files yet. This is what the defaults do once it is added.");
  }
  out();
  const rows = setupRows(s);
  const wKey = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    const lines = wrap(v, width() - 6 - wKey);
    out(`  ${c.gray(k.padEnd(wKey))}  ${lines[0]}`);
    for (const l of lines.slice(1)) out(`  ${" ".repeat(wKey)}  ${l}`);
  }
  section("What leaves your visitors' browsers");
  if (!m.sent.length) out(`    ${c.green("Nothing.")}`);
  for (const x of m.sent) {
    para(x.to, "    ", c.bold);
    para(x.what, "      ");
    para(`Why: ${x.why} Kept: ${x.keep}`, "      ", c.gray);
  }
  section("What stays on their device");
  if (!m.kept.length) out(`    ${c.green("Nothing.")}`);
  for (const x of m.kept) {
    para(x.where, "    ", c.bold);
    para(`${x.what} Off: ${x.off}`, "      ");
  }
  section("Opt-outs it honours");
  for (const x of m.optOuts) bullet(x);
  section("EU, EEA and UK visitors");
  for (const x of m.eu) bullet(x);
  section("US visitors");
  for (const x of m.us) bullet(x);
  if (m.strict.length) {
    section("To send and keep nothing");
    para("Add these options to the file genclass init wrote (window.GENCLASS_CONFIG) or to GenClass.init():", "    ", c.gray);
    for (const [opt, what, cmd] of m.strict) {
      para(opt, "    ", c.cyan);
      para(`${what}${cmd ? `. Run: ${cmd}` : ""}`, "      ", c.gray);
    }
  }
  if (m.csp.length) {
    section("If your site has a Content-Security-Policy");
    for (const x of m.csp) para(x, "    ");
  }
  out();
  note(`For your privacy policy or a vendor questionnaire: genclass privacy --out genclass-privacy.md. Every field, one by one: ${TELEMETRY_DOC}`);
  out();
  return s.installed ? 0 : 1;
}

/** A list item: its first line behind a dash, the rest under its first word. */
function bullet(text) {
  const lines = wrap(text, width() - 8);
  out(`    - ${lines[0] ?? ""}`);
  for (const l of lines.slice(1)) out(`      ${l}`);
}

function section(title) {
  out();
  out(`  ${c.bold(title)}`);
}
