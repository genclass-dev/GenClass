// HTML for https://genclass.dev/start (get a token), /start/open-source (the open-source parts, no account) and
// https://genclass.dev/dashboard/<secret> (the dashboard), and the shell and dashboard the account pages (src/account-pages.ts) reuse: /account/apps/<id> is this dashboard in its
// account mode (the account's projects in the header's switcher, the Connect dialog's ways in, the agent link, stats
// from the account API). Every plan includes the dashboard (billing/plans.json); a plan file that left it out would
// give the locked account mode (the key and the Connect dialog, the plans, no stats), and a locked private link is
// account-pages.ts lockedLinkPage. The dashboard sits in the Supabase Studio frame (src/studio.ts); /start, the 404
// and the sign-in pages keep genclass.dev's own look (shell below).
// No external scripts; styles and fonts only from Google Fonts. Inline <script>/<style> run under a per-response CSP
// nonce; dynamic text is inserted with textContent in scripts and escaped (esc) in server-rendered HTML.

import { demoData } from "./demo.js";
import { embed, esc } from "./escape.js";
import { COPY_JS, icon, ICON_LINKS, LOCK_JS, studioPage, THEME_COLOR_METAS, THEME_HEAD_JS, THEME_JS, themeButton, type ProductMenu, type RailItem } from "./studio.js";

export { embed, esc };

/** The first @genclass/runtime that reads project keys (tokens) and has `login`; earlier versions ignore a key. */
export const KEY_RUNTIME = "0.3.0-beta.0";
/** The first @genclass/runtime with interaction analytics (`analytics: true`); earlier versions ignore the option. */
export const ANALYTICS_RUNTIME = "0.3.0-beta.1";
/**
 * The runtime the snippets install: always the newest release on npm, prerelease or not (release.yml: set it with
 * RUNTIME_ON_NPM after each publish). The script tag pins it: the unversioned jsDelivr URL serves npm's `latest`
 * (0.2.x until 0.3.0, which ignores a key and analytics) and may serve an older release from the CDN cache. While it
 * is a prerelease, the npm and npx commands name its dist-tag (`@beta`): without it they install `latest`. At 0.3.0
 * set SNIPPET_RUNTIME to "0.3.0" and RUNTIME_PKG to "@genclass/runtime" (and RUNTIME_ON_NPM in wrangler.toml), then
 * deploy.
 */
export const SNIPPET_RUNTIME = "0.3.0-beta.5";
export const RUNTIME_PKG = "@genclass/runtime@beta";
export const CDN_SCRIPT = `https://cdn.jsdelivr.net/npm/@genclass/runtime@${SNIPPET_RUNTIME}`;
/** What local and private hosts do, as the runtime behaves (src/telemetry/config.ts) and PRIVACY.md says. */
const LOCAL_HOSTS =
  "Local hosts (localhost, *.local, *.test and private networks) do not send by default, token or not; telemetry: true or a telemetry options object opts them in.";
/** Said first while the runtime that reads keys is not on npm yet (RUNTIME_ON_NPM, auth.ts runtimeHasTokens). */
const NOT_ON_NPM = `<b>Not on npm yet.</b> Project keys ship in @genclass/runtime ${KEY_RUNTIME} (npm dist-tag <code>beta</code>), which is not published yet: until it is, the script tag below does not load, <code>npx ${RUNTIME_PKG}</code> fails and 0.2.x ignores the key.`;

/**
 * Headers for every HTML page. `account: true` (the account pages) allows same-origin form posts (the sign-out form)
 * and uses the referrer policy `same-origin`: with `no-referrer` browsers send `Origin: null` on a same-origin form
 * post, which the CSRF check refuses; `same-origin` still sends no referrer to any other site.
 */
export function securityHeaders(nonce: string, extra: Record<string, string> = {}, opts: { account?: boolean } = {}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": opts.account ? "same-origin" : "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' https://api.fontshare.com https://fonts.googleapis.com; font-src https://cdn.fontshare.com https://fonts.gstatic.com; connect-src 'self'; ` +
      `img-src 'self' data: https://genclass.dev; base-uri 'none'; form-action ${opts.account ? "'self'" : "'none'"}; frame-ancestors 'none'`,
    ...extra,
  };
}

/** The header logo, as on genclass.dev: the mark and the name set in type. */
export const LOGO =
  '<a class="logo" href="https://genclass.dev/"><img src="https://genclass.dev/brand/mark-64.png?v=2" alt="" width="24" height="24">GenClass</a>';

/** The MCP server for coding agents, pinned as its own install blocks pin it (packages/mcp/src/clients.ts). */
export const MCP_PKG = "@genclass/mcp@0.2.2";

/** The package names and URLs installPrompt names; passed in, so the page script runs the same function. */
export interface PromptNames {
  pkg: string;
  cdn: string;
  /** the agent link's module on the CDN, for pages without a bundler */
  agent: string;
  mcp: string;
}
export const PROMPT_NAMES: PromptNames = { pkg: RUNTIME_PKG, cdn: CDN_SCRIPT, agent: `${CDN_SCRIPT}/dist/agent.js`, mcp: MCP_PKG };

/**
 * What the Connect dialog's choices add to installPrompt; the dialog ticks DEFAULT_CHOICES, guard and heal both off is
 * observe, the overlay in development only.
 */
export interface InstallChoices {
  /** guard: GenClass may act when it is sure (drop a stale response, fix a CSS bug on the page), reversibly */
  guard?: boolean;
  /** with guard: mode heal, which also retries a failed request or serves its cached answer, hedges a slow call and rolls back a bad write */
  heal?: boolean;
  /** the devtools overlay on every host, the deployed site too (for demos and staging) */
  badge?: boolean;
  /** the agent link (a private dashboard link): the MCP server's production numbers and the Loop view */
  agentLink?: string | null;
  /** deploy with the project's own deploy command at the end */
  deploy?: boolean;
}

/**
 * What the Connect dialog and /start/open-source tick when they load: guard with heal, the mode genclass.dev
 * recommends. The prompt functions add nothing themselves (no choices is observe): the server renders a page's prompt
 * with these and the page script reads the boxes, so the prompt always says what the boxes say.
 */
export const DEFAULT_CHOICES = { guard: true, heal: true } as const;

// The palette, type, buttons, header and focus ring of genclass.dev (site/src/css/base.css and components.css), with
// the site's values: black ground, bone text, the GenClass mark's green and red-orange, square corners, 1px rules,
// Satoshi for text and JetBrains Mono for code. Like the site, every page here is dark only, whatever the visitor's
// system theme: no prefers-color-scheme rules and `color-scheme: dark`, so form controls and scrollbars are dark too.
// The token names are the light design's (--paper is the page, --ink the text), so every rule keeps working. Text
// colours are at least 4.5:1 on --paper, --panel and --code, UI colours (focus ring, input border, fills) at least
// 3:1 (test/pages.test.ts measures them). --accent #2FD07F is the site's green for text, fills and buttons, with
// --on-green #02140A on it; --warn #FF6B4A the red-orange for bug text (the site's --bad), --warn-f #FF5A36 its bug
// fills; --accent-t and --warn-t are their tints on black. --line is an input border at 4:1 (the site's
// --rule-strong is 2:1, fine for a divider, not for an empty field).
const CSS = `
:root{
  --paper:#000000;--panel:#0B0B0A;--ink:#F0F1E9;--ink2:#A0A196;--ink3:#88897F;--rule:#30312B;--rule2:#46463E;--line:#6E6F66;
  --accent:#2FD07F;--accent-x:#2FD07F;--accent-f:#2FD07F;--accent-t:#06140D;--warn:#FF6B4A;--warn-f:#FF5A36;--warn-t:#1C0A06;
  --bar:#A0A196;--bar2:#2FD07F;--bar3:#FF5A36;--ink-h:#FFFFFF;--green-h:#52DA95;--on-green:#02140A;--head:rgba(0,0,0,.75);
  --code:#131311;--codeink:#F0F1E9;
  --display:"Satoshi",ui-sans-serif,system-ui,sans-serif;--sans:"Satoshi",ui-sans-serif,system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:dark;
}
:root[data-theme="light"]{
  --paper:#ffffff;--panel:#f7f7f5;--ink:#141412;--ink2:#55564f;--ink3:#6b6c64;--rule:#e4e4df;--rule2:#d4d4cd;--line:#8a8b82;
  --accent:#0a7c4a;--accent-x:#0a7c4a;--accent-f:#0a7c4a;--accent-t:#eaf7f0;--warn:#c4320a;--warn-f:#e5484d;--warn-t:#fdeeea;
  --bar:#a0a196;--bar2:#22a06b;--bar3:#e5484d;--ink-h:#000000;--green-h:#086a3f;--on-green:#ffffff;--head:rgba(255,255,255,.8);
  --code:#f4f4f1;--codeink:#141412;
  color-scheme:light;
}
.th-moon{display:none}.th-sun{display:contents}
:root[data-theme="light"] .th-moon{display:contents}:root[data-theme="light"] .th-sun{display:none}
.thm{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid var(--rule2);background:transparent;color:var(--ink2);cursor:pointer}
.thm:hover{color:var(--ink);border-color:var(--ink3)}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper)}
body{background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
::selection{background:var(--accent-f);color:var(--on-green)}
html:has(header.top){scroll-padding-top:76px}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:1px solid var(--accent);outline-offset:3px}
.wrap{max-width:1240px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
header.top{position:sticky;top:0;z-index:20;background:var(--head);backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);border-bottom:1px solid var(--rule)}
@media (prefers-reduced-transparency:reduce){header.top{background:var(--paper)}}
header.top .wrap{display:flex;align-items:center;gap:22px;height:64px}
body:has(.app) header.top .wrap{max-width:1360px}
.logo{display:flex;align-items:center;gap:10px;flex:none;font:500 17px var(--display);letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.logo img{width:24px;height:24px;display:block}
header.top nav{margin-left:auto;display:flex;gap:22px;font-size:14px;color:var(--ink2);align-items:center}
header.top nav a{text-decoration:none;white-space:nowrap}
header.top nav a:not(.btn):hover,header.top nav .so button:hover,header.top nav a[aria-current=page]{color:var(--ink)}
header.top nav .btn{min-height:36px;font-size:14px;padding:0 14px}
header.top nav form.so{display:contents}
header.top nav .so button,button.lnk{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;white-space:nowrap}
@media (max-width:620px){header.top .wrap{gap:12px}header.top nav{gap:14px}header.top nav .hm{display:none}}
@media (max-width:420px){header.top nav .dc{display:none}}
@media (max-width:360px){header.top .wrap{gap:10px}}
h1,h2,h3{font-family:var(--display);text-wrap:balance}
h1{font-size:clamp(26px,4vw,40px);line-height:1.15;letter-spacing:-.04em;font-weight:500}
h2{font-size:17px;letter-spacing:-.015em;font-weight:500;margin-bottom:10px}
p.lead{color:var(--ink2);font-size:16px;max-width:62ch;margin-top:10px}
.muted{color:var(--ink3)}
.small{font-size:13px}
.mono{font-family:var(--mono)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:0;font:500 15px/1 var(--sans);cursor:pointer;border:1px solid var(--accent-f);background:var(--accent-f);color:var(--on-green);text-decoration:none;white-space:nowrap;transition:opacity .15s,border-color .15s,color .15s,transform .1s}
.btn:hover{opacity:.9}
.btn:active{transform:scale(.985)}
.btn:disabled{opacity:.6;cursor:progress}
.btn.green{background:var(--accent-f);border-color:var(--accent-f);color:var(--on-green)}
.btn.green:hover{opacity:.9}
.btn.ghost{background:transparent;color:var(--ink2);border-color:var(--rule2)}
.btn.ghost:hover{opacity:1;background:transparent;color:var(--ink);border-color:var(--ink3)}
.btn.sm{min-height:34px;padding:0 12px;font-size:13.5px}
@media (max-width:620px){.btn.sm{min-height:44px}}
input[type=text],input[type=password]{min-height:46px;padding:0 12px;border-radius:0;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:16px var(--sans);width:100%}
input[type=text]:focus-visible,input[type=password]:focus-visible{outline:1px solid var(--accent);outline-offset:0;border-color:var(--accent)}
::placeholder{color:var(--ink3);opacity:1}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:0;padding:clamp(16px,3vw,28px);min-width:0}
.grid{display:grid;gap:12px}
.kpis{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.cols{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.charts{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
@media (max-width:420px){.cols{grid-template-columns:1fr}}
.kpi .v{font-size:26px;font-weight:500;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.kpi .l{font-size:13px;color:var(--ink2)}
.kpi .s{font-size:12px;color:var(--ink3);margin-top:2px}
pre.code{background:var(--code);color:var(--codeink);border-radius:0;padding:12px 14px;font:13px/1.6 var(--mono);overflow-x:auto;white-space:pre}
.snip>*+*{margin-top:6px}
.snip .between{align-items:center}
.note{border:1px solid var(--rule);border-left:3px solid var(--warn);background:var(--panel);padding:12px 16px;border-radius:0;font-size:14px;color:var(--ink)}
.ok{border-left-color:var(--accent-f);background:var(--accent-t)}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rule2);border-radius:0;padding:3px 10px;font:500 12px var(--mono);color:var(--ink2)}
.pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ink3)}
.pill.live .dot{background:var(--accent-f)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tabs{display:inline-flex;border:1px solid var(--rule2);border-radius:0;overflow:hidden}
.tabs button{border:0;background:transparent;color:var(--ink2);padding:7px 12px;font:500 13px var(--sans);cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.bars{list-style:none;display:grid;gap:6px}
.bars li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:13px}
.bars .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.bars .n{font-variant-numeric:tabular-nums;color:var(--ink2)}
.bars .track{grid-column:1/-1;height:6px;border-radius:0;background:var(--rule)}
.bars .fill{height:6px;border-radius:0;background:var(--bar)}
.empty{color:var(--ink3);font-size:13px}
.chart svg{width:100%;height:120px;display:block}
.chart .axis{font-size:11px;color:var(--ink3);display:flex;justify-content:space-between;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{color:var(--ink3);font:500 12px var(--mono);text-transform:uppercase;letter-spacing:.06em}
td.mono{font-family:var(--mono)}
.tablewrap{overflow-x:auto;padding-left:6px;margin-left:-6px}
section{margin-top:22px}
details summary{cursor:pointer;font-weight:500}
footer{margin:36px 0 28px;color:var(--ink3);font-size:13px}
.hidden{display:none!important}
.skip{position:absolute;left:12px;top:-60px;z-index:30;background:var(--accent-f);color:var(--on-green);padding:10px 14px;border-radius:0;font-size:14px;text-decoration:none}
.skip:focus{top:12px}
[tabindex="-1"]:focus{outline:none}
.field{display:grid;gap:6px;max-width:520px}
.field label{font-size:14px;font-weight:500}
.stack>*+*{margin-top:12px}
.mt-xl{margin-top:44px}.mt-l{margin-top:28px}.mt-s{margin-top:12px}.big{font-size:16px}.brk{word-break:break-all}.h2l{font-size:20px}.between{justify-content:space-between;align-items:flex-end}.minw0{min-width:0}
`;

const SNIPPETS_JS = `
// ep: this collector's own ingest URL when it is not genclass.dev's (a self-hosted collector, private mode). Then every
// snippet names it, through window.GENCLASS_CONFIG or GenClass.init (a meta tag may only name same-origin URLs), and
// the CLI's init, which makes its token at genclass.dev, is left out.
function snippets(tok, ep){
  var cfg = function(o){ return '<script>window.GENCLASS_CONFIG = { ' + o + 'telemetry: { endpoint: "' + ep + '" } };</' + 'script>'; };
  return [
    ["Easy: one script tag", "Paste into your HTML. GenClass starts itself and protects the whole app.",
     (ep ? cfg("") + "\\n" : "") + '<script src="${CDN_SCRIPT}" data-token="' + tok + '" data-mode="heal"></' + 'script>'],
    ["Easy: with a bundler", ep ? "One line in your HTML head plus one import (npm i ${RUNTIME_PKG})." : "A meta tag plus one import (npm i ${RUNTIME_PKG}).",
     ep ? "<!-- in your HTML <head> -->\\n" + cfg('token: "' + tok + '", ') + '\\n\\n// in your entry file\\nimport "@genclass/runtime/auto/heal";'
        : '<meta name="genclass" content="token=' + tok + '">\\n\\n// in your entry file\\nimport "@genclass/runtime/auto/heal";'],
    ["Function-specific", "Protect only the functions you choose; the dashboard shows each by name.",
     'import { GenClass, protect } from "@genclass/runtime";\\n\\nGenClass.init({ token: "' + tok + '", scope: "functions", mode: "heal"' + (ep ? ', telemetry: { endpoint: "' + ep + '" }' : "") + ' });\\nconst save = protect("saveCart", saveCartImpl);']
  ].concat(ep ? [] : [["Automatic setup", "Run in your project folder: it detects your setup and wires GenClass (and a token) in for you.",
     'npx ${RUNTIME_PKG} init --mode heal']]);
}
function renderSnippets(host, tok, ep){
  host.textContent = "";
  snippets(tok, ep || "").forEach(function(s){
    var box = el("div", "snip"), pre = el("pre", "code", s[2]);
    var head = el("div", "row between"); var h = el("h2", null, s[0]); h.style.marginBottom = "0";
    head.appendChild(h); head.appendChild(copyBtn(function(){ return s[2]; }, s[0], function(){ return pre; })); box.appendChild(head);
    box.appendChild(el("p", "muted small", s[1])); box.appendChild(pre);
    host.appendChild(box);
  });
}
`;

export interface ShellOptions {
  /** Header links (HTML). Default: Home, Docs, Sign in, Add to my app. */
  nav?: string;
  /** No top header: the sign-in pages put the logo at the top of their own column. */
  bare?: boolean;
  /** An account page: the referrer policy `same-origin` (see securityHeaders), which the meta tag must repeat. */
  account?: boolean;
  /** The id the "Skip to content" link jumps to (default the <main> element; pages with a sidebar name their content). */
  skip?: string;
  /**
   * A sign-in page: the content in a column on the left, the self-healing sphere of genclass.dev/signin-mesh.js (the
   * same backdrop as /admin's sign-in) on the right. The script is the site's, loaded under this page's nonce.
   */
  mesh?: boolean;
  /** A page with a lock form (/start, the unlock page): the passkey and password helpers (studio.ts LOCK_JS). */
  lock?: boolean;
  /**
   * A public page meant to be found by search engines (the GitHub App's page, /github): `index, follow` instead of
   * the `noindex, nofollow` every other page of this worker carries. The response must send the same X-Robots-Tag.
   */
  index?: boolean;
}

/** genclass.dev's sign-in backdrop script; bump ?v= with site/public/signin-mesh.js (assets are cached immutably). */
export const MESH_SCRIPT = "https://genclass.dev/signin-mesh.js?v=2";

/** As on genclass.dev: Docs, Sign in, the theme button and one compact green button. Narrow screens drop Docs. */
const DEFAULT_NAV = `<a class="dc" href="https://genclass.dev/docs">Docs</a><a href="/login">Sign in</a>${themeButton("thm")}<a class="btn" href="/start">Get started</a>`;

/** The nav of /start itself and the unlock page: no button to the page you are on. */
export const QUIET_NAV = `<a class="dc" href="https://genclass.dev/docs">Docs</a><a href="/login">Sign in</a>${themeButton("thm")}`;

/** The page frame shared by every page this worker serves. */
export function shell(nonce: string, title: string, body: string, script: string, opts: ShellOptions = {}): string {
  const header = opts.bare ? "" : `<header class="top"><div class="wrap">${LOGO}
<nav>${opts.nav ?? DEFAULT_NAV}</nav></div></header>
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${opts.index ? "index, follow" : "noindex, nofollow"}">
<meta name="referrer" content="${opts.account ? "same-origin" : "no-referrer"}">
<title>${esc(title)}</title>
${ICON_LINKS}
${THEME_COLOR_METAS("#000000", "#ffffff")}
<script nonce="${nonce}">${THEME_HEAD_JS}</script>
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap">
<style nonce="${nonce}">${CSS}</style>
</head>
<body${opts.mesh ? ' class="mesh"' : ""}>
<a class="skip" href="#${esc(opts.skip ?? "main")}">Skip to content</a>
${header}<main class="wrap" id="main">${body}</main>
<script nonce="${nonce}">${COPY_JS}${THEME_JS}${opts.lock ? LOCK_JS : ""}${SNIPPETS_JS}${script}</script>
${opts.mesh ? `<canvas data-mesh aria-hidden="true"></canvas>\n<script nonce="${nonce}" src="${MESH_SCRIPT}" defer></script>\n` : ""}</body>
</html>`;
}

/** Header links for a signed-in page: the apps, the docs, and a sign-out form (POST /logout, same-origin). */
export const SIGNED_IN_NAV =
  '<a href="/account">Apps</a><a href="https://genclass.dev/docs">Docs</a><form method="post" action="/logout" class="so"><button type="submit">Sign out</button></form>';

// ------------------------------------------------------------------------------------------------- /start
// POST /start makes the app and its private link, protected by a passkey or a password (collector.ts, link-lock.ts), and
// /start/<secret> says the one command that connects it.

/** The command that connects an app: it finds the framework, installs the runtime and adds the import, asking once. */
export function setupCommand(token: string): string {
  return `npx ${RUNTIME_PKG} init --token ${token} --mode heal`;
}

/** The shortest prompt that gets a coding agent to do the same; --yes because an agent has no Y/n to answer. */
export function agentPrompt(token: string): string {
  return `Add GenClass to this web app: run \`${setupCommand(token)} --yes\` in the app's folder (ask me which folder if this one has no web app). Then start the app, check that it still works, and tell me what changed. \`npx ${RUNTIME_PKG} remove\` undoes it.`;
}

/**
 * Links that open a coding agent's app with the prompt filled in (owner, 2026-11-05: Codex and Claude, no Cursor). None
 * of them runs anything: the person reads the prompt and presses Enter. Codex: its app's codex://new
 * (developers.openai.com/codex/app/commands). Claude Code: the desktop app's claude://code/new
 * (support.claude.com/en/articles/14729294), and when that app is not there, the terminal's claude-cli://open
 * (code.claude.com/docs/en/deep-links), tried by the page's script after it.
 */
export function agentLinks(prompt: string): { label: string; href: string; fallback?: string }[] {
  const q = encodeURIComponent(prompt);
  return [
    { label: "Codex", href: `codex://new?prompt=${q}` },
    { label: "Claude Code", href: `claude://code/new?q=${q}`, fallback: `claude-cli://open?q=${q}` },
  ];
}

/** /start, the setup page and the unlock page: one centred column, a card, generous space. */
export const START_CSS = `
.st{max-width:440px;margin:clamp(40px,10vh,96px) auto 64px;display:grid;gap:20px}
.st h1{font-size:clamp(28px,4vw,36px);text-align:center}
.st .lead{text-align:center;margin:-8px auto 0}
.st-card{background:var(--panel);border:1px solid var(--rule);padding:clamp(20px,4vw,28px);display:grid;gap:18px}
.st-alt{text-align:center;color:var(--ink3);font-size:14px}
.fld{display:grid;gap:8px;border:0;min-width:0}
.fld label,.fld legend{font-size:14px;font-weight:500;color:var(--ink);padding:0}
.fld legend{margin-bottom:8px}
.lk-choice{display:none;gap:8px}
.js .lk-choice{display:grid;grid-template-columns:1fr 1fr}
.lk-choice label{display:flex;align-items:center;gap:10px;min-height:46px;padding:0 14px;border:1px solid var(--rule2);cursor:pointer;font-weight:400}
.lk-choice label:has(input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.lk-choice label.off{opacity:.5;cursor:not-allowed}
.lk-choice input{accent-color:var(--accent);margin:0}
[data-pw]{display:grid;gap:8px}
[data-pw][hidden]{display:none}
.js .lk-choice+[data-pw]{margin-top:10px}
.lk-err{font-size:14px;color:var(--warn)}
.lk-err:empty{display:none}
.st .btn.xl{min-height:50px;font-size:16px;width:100%}
.lk-ic{display:flex;justify-content:center;color:var(--accent)}
.lk-ic .ic{width:28px;height:28px}
.cmdbox{display:flex;align-items:center;gap:10px;background:var(--code);color:var(--codeink);padding:12px 14px;min-width:0}
.cmdbox code{flex:1;min-width:0;font:14px/1.5 var(--mono);overflow-wrap:anywhere}
.cmdbox .btn{flex:none}
.setup{max-width:640px;margin:clamp(40px,8vh,80px) auto 64px}
.setup h1{font-size:clamp(28px,4vw,36px)}
.setup-agents{align-items:center}
#appst:empty{display:none}
.setup-steps{margin:0;padding-left:20px;display:grid;gap:8px}
.setup-status{display:inline-flex;align-items:center;gap:8px}
.setup-status i{width:8px;height:8px;border-radius:50%;background:var(--warn);flex:none}
.setup-status.live i{background:var(--accent-f)}
`;

/**
 * The form's script: a passkey (made here, the browser asks) or the password, then POST /start as JSON and on to the
 * setup page. Without scripts the form posts the name and the password itself.
 */
const START_JS = `
(function(){
  var f = document.getElementById("f"), go = document.getElementById("go"), err = document.getElementById("err");
  if (!f || !window.fetch) return;
  gcLkWire(f);
  f.addEventListener("submit", function(ev){
    ev.preventDefault(); err.textContent = ""; go.disabled = true; var label = go.textContent; go.textContent = "Creating...";
    var name = (document.getElementById("nm").value || "").trim();
    gcLkBody(f, "/api/start/passkey", { name: name })
      .then(function(lock){ var b = { name: name }; for (var k in lock) b[k] = lock[k]; return gcLkPost("/start", b); })
      .then(function(j){ location.href = j.url; })
      .catch(function(e){ err.textContent = gcLkWhy(e); go.disabled = false; go.textContent = label; });
  });
})();`;

/** The fields that protect a link: a passkey or a password (the choice shows once scripts run; without them, the password). */
export function lockFields(o: { legend: string; autocomplete: "new-password" | "current-password" }): string {
  return `<fieldset class="fld"><legend>${esc(o.legend)}</legend>
<div class="lk-choice" role="radiogroup" aria-label="${esc(o.legend)}"><label><input type="radio" name="lock" value="passkey">Passkey</label><label><input type="radio" name="lock" value="password" checked>Password</label></div>
<div data-pw><label for="pw">Password</label><input type="password" id="pw" name="password" autocomplete="${o.autocomplete}" minlength="10" maxlength="256" placeholder="At least 10 characters" required></div>
</fieldset>`;
}

/** /start: name the app, protect its link with a passkey or a password, create. Signed in, /account/new answers instead. */
export function startPage(nonce: string, opts: { error?: string; name?: string } = {}): string {
  const body = `
<div class="st">
  <h1>Create your dashboard</h1>
  <p class="lead">Free. No sign-up.</p>
  <form id="f" class="st-card" method="post" action="/start" data-lock>
    <div class="fld"><label for="nm">App name</label><input type="text" id="nm" name="name" maxlength="80" placeholder="my-app" autocomplete="off" spellcheck="false" value="${esc(opts.name ?? "")}"></div>
    ${lockFields({ legend: "Protect it with", autocomplete: "new-password" })}
    <p id="err" class="lk-err" role="alert">${opts.error ? esc(opts.error) : ""}</p>
    <button class="btn green xl" id="go" type="submit">Create dashboard</button>
  </form>
  <p class="st-alt">Have an account? <a href="/login">Sign in</a></p>
  <p class="st-alt">Or set everything up with one command in your app's folder: <code>npx genclass</code>. <a href="https://genclass.dev/docs/cli">How it works</a></p>
</div>
<style nonce="${nonce}">${START_CSS}</style>`;
  return shell(nonce, "Create your dashboard | GenClass", body, START_JS, { account: true, nav: QUIET_NAV, lock: true });
}

export interface SetupView {
  token: string;
  secret: string;
  lastEvent: string | null;
  runtimeReady?: boolean;
  /** This collector's own ingest URL (self-hosted): the snippets name it, and the CLI, which uses genclass.dev, is left out. */
  endpoint?: string | null;
  /** The button's script already put the command on the clipboard. */
  copied?: boolean;
}

/** /start/<secret>: what to do next, and whether it has worked yet. The secret is the app's private dashboard link's. */
export function setupPage(nonce: string, v: SetupView): string {
  const cmd = setupCommand(v.token);
  const prompt = agentPrompt(v.token);
  const notYet = v.runtimeReady === true ? "" : `<p class="note small" id="notyet">${NOT_ON_NPM}</p>`;
  const agents = agentLinks(prompt)
    .map((a) => `<a class="btn ghost sm" data-app href="${esc(a.href)}"${a.fallback ? ` data-fallback="${esc(a.fallback)}"` : ""}>${esc(a.label)}</a>`)
    .join("");
  const connect = v.endpoint
    ? ""
    : `<section class="stack mt-l">
  <div class="cmdbox"><code id="cmd">${esc(cmd)}</code><span id="cmdc"></span></div>
  <div class="row setup-agents"><span class="small muted">Or let your agent do it:</span>${agents}<span id="promptc"></span></div>
  <p class="small muted" id="appst" aria-live="polite"></p>
</section>`;
  const body = `
<div class="setup">
<section class="stack">
  <h1>Your app is ready</h1>
  ${v.endpoint ? "" : `<p class="lead" id="lead">${v.copied ? "The command is on your clipboard. Paste it in your project's folder." : "Run this in your project's folder."}</p>`}
  ${notYet}
</section>
${connect}
<section class="stack mt-l">
  <ol class="setup-steps">
    <li><b>Run your app.</b></li>
    <li><b>Deploy it.</b> <span class="setup-status${v.lastEvent ? " live" : ""}" id="st" aria-live="polite"><i></i><span id="stt">${v.lastEvent ? "Connected." : "Waiting for your first visitor."}</span></span></li>
  </ol>
  <div class="row"><a class="btn green" href="/dashboard/${esc(v.secret)}">Open my dashboard</a><a class="btn ghost" id="save" href="/signup?next=${encodeURIComponent("/account?save=1")}">Save to an account</a></div>
  <p class="muted small">Bookmark this page to get back here.</p>
</section>
<details class="mt-l"${v.endpoint ? " open" : ""}><summary>Other ways to add it</summary><div class="stack mt-s"><div id="snips" class="stack"></div></div></details>
</div>
<style nonce="${nonce}">${START_CSS}</style>
<script type="application/json" id="cfg">${embed({ token: v.token, secret: v.secret, endpoint: v.endpoint ?? "", cmd, prompt, live: !!v.lastEvent })}</script>`;
  const script = `
(function(){
  var C = JSON.parse(document.getElementById("cfg").textContent);
  var cmdNode = document.getElementById("cmd");
  if (cmdNode) {
    document.getElementById("cmdc").appendChild(copyBtn(function(){ return C.cmd; }, "command", function(){ return cmdNode; }));
    var pc = copyBtn(function(){ return C.prompt; }, "prompt for your coding agent", function(){ return null; });
    pc.textContent = "Copy prompt"; pc.setAttribute("data-label", "Copy prompt");
    document.getElementById("promptc").appendChild(pc);
  }
  renderSnippets(document.getElementById("snips"), C.token, C.endpoint);
  // an agent's app: the prompt goes on the clipboard first, then each link in turn until the page loses focus (the
  // browser asked to open the app, or the app came to the front); Claude Code tries the desktop app, then the terminal
  var appst = document.getElementById("appst");
  function tryOpen(urls, done){
    var i = 0;
    (function next(){
      if (i >= urls.length) { done(false); return; }
      var u = urls[i++], hit = false;
      function on(){ hit = true; }
      window.addEventListener("blur", on); document.addEventListener("visibilitychange", on);
      try { location.href = u; } catch (e) {}
      setTimeout(function(){ window.removeEventListener("blur", on); document.removeEventListener("visibilitychange", on); if (hit) done(true); else next(); }, 1500);
    })();
  }
  [].slice.call(document.querySelectorAll("a[data-app]")).forEach(function(a){
    a.addEventListener("click", function(e){
      e.preventDefault();
      var name = a.textContent, copied = gcLegacyCopy(C.prompt), urls = [a.getAttribute("href")];
      if (a.getAttribute("data-fallback")) urls.push(a.getAttribute("data-fallback"));
      if (appst) appst.textContent = "Opening " + name + "...";
      tryOpen(urls, function(ok){
        if (!appst) return;
        appst.textContent = ok ? "The prompt is in " + name + ". Press Enter to run it." : name + " didn't open." + (copied ? " The prompt is copied: paste it into your agent." : " Use Copy prompt instead.");
      });
    });
  });
  // after signing up, /account?save=1 adds this app to the account (the link is kept in this tab only, never on a server)
  document.getElementById("save").addEventListener("click", function(){ try { sessionStorage.setItem("gc.save", C.secret); } catch (e) {} });
  if (C.live) return;
  var st = document.getElementById("st"), stt = document.getElementById("stt"), started = Date.now();
  function poll(){
    var age = Date.now() - started;
    if (age > 3600000) return;
    if (document.visibilityState === "hidden") { setTimeout(poll, 15000); return; }
    fetch("/api/projects/" + C.secret + "/status").then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      if (j && j.lastEvent) { st.classList.add("live"); stt.textContent = "Connected. Your first page load just arrived."; return; }
      setTimeout(poll, age < 120000 ? 5000 : 15000);
    }).catch(function(){ setTimeout(poll, 15000); });
  }
  setTimeout(poll, 3000);
})();`;
  return shell(nonce, "Your app is ready | GenClass", body, script, { account: true, nav: QUIET_NAV });
}

// ------------------------------------------------------------------------------------- /start/open-source
// GenClass's open-source parts with no account: the runtime in the app's pages, the agent link, the MCP server and the
// page check, all Apache-2.0. Nothing to sign in to: the runtime's anonymous diagnostics stay on (its decisions and
// counts from public hosts, no page text unless the app opts in; packages/runtime/TELEMETRY.md) and init makes the app's free dashboard
// link, sending only the package name. The quiet choice turns both off (telemetry: false, --no-telemetry), for teams
// that may send nothing to a hosted service. The page sends nothing either: its choices rewrite the prompt in the
// browser, with the server's own openSourcePrompt.

/**
 * What /start/open-source's choices add to openSourcePrompt; the page ticks DEFAULT_CHOICES, guard and heal both off
 * is observe, the overlay in development only.
 */
export interface OpenSourceChoices {
  /** guard: GenClass may act when it is sure (drop a stale response, fix a CSS bug on the page), reversibly */
  guard?: boolean;
  /** with guard: mode heal, which also retries a failed request or serves its cached answer, hedges a slow call and rolls back a bad write */
  heal?: boolean;
  /** the console-json sink: every record also as one JSON line on the console, for the app's own log shipper */
  logs?: boolean;
  /** the model and onnxruntime-web from the app's own host (`fetch-model`), not jsDelivr */
  selfHost?: boolean;
  /**
   * nothing to genclass.dev: `telemetry: false`, `data-telemetry="off"` and `--no-telemetry` (which means no token and
   * no dashboard link); off, the anonymous diagnostics stay on and init makes the app's free dashboard link
   */
  quiet?: boolean;
  /** deploy with the project's own deploy command at the end */
  deploy?: boolean;
}

/**
 * The prompt /start/open-source copies: installPrompt's steps without a token to paste or an agent link, with the
 * runtime's anonymous diagnostics on (the default: its decisions and counts from public hosts; init creates the app's
 * free dashboard link and keeps it in .genclass.local) or, with `quiet`, `telemetry: false` and `--no-telemetry` (the
 * runtime sends no data anywhere; it still downloads public files from jsDelivr unless the app serves them), the MCP
 * server on the developer's machine and the page check run locally. Pure and self-contained, like installPrompt: the
 * page script runs this same function.
 */
export function openSourcePrompt(c: OpenSourceChoices = {}, n: PromptNames = PROMPT_NAMES): string {
  const guard = !!c.guard;
  const heal = guard && !!c.heal;
  const mode = heal ? "heal" : guard ? "guard" : "";
  const logs = !!c.logs;
  const own = !!c.selfHost;
  const quiet = !!c.quiet;
  const dir = "/genclass-model/";
  // GenClass.init has automatic state discovery off unless asked (autoState: true, with the discover import first)
  const init = [...(quiet ? ["telemetry: false"] : []), "autoState: true"];
  if (mode) init.push(`mode: "${mode}"`, "visual: { on: true, fix: true }");
  if (own) init.push(`model: { baseUrl: "${dir}", ortWasmPaths: "${dir}ort/" }`);
  if (logs) init.push("sinks: [consoleJson()]");
  // the script tag carries all of it
  const attrs = quiet ? ['data-telemetry="off"'] : [];
  if (mode) attrs.push(`data-mode="${mode}"`, 'data-visual="fix"');
  if (own) attrs.push(`data-model="${dir}"`, `data-ort="${dir}ort/"`);
  if (logs) attrs.push('data-sink="console-json"');
  attrs.push('data-devtools="local"');
  const flags = [...(quiet ? ["--no-telemetry"] : []), ...(mode ? [`--mode ${mode}`] : []), ...(logs ? ["--sink console-json"] : []), ...(own ? [`--model-url ${dir}`] : []), "--yes"];
  // init writes no visual option: the prompt says where to add it
  const initAdds = mode ? 'visual: { on: true, fix: true } to the option file it writes (data-visual="fix" on the tag it writes; Astro gets a <meta name="genclass"> line instead: add visual=fix to its content)' : "";
  const local = '["localhost", "127.0.0.1"].includes(location.hostname)';
  // A step is a one-element array, numbered at the end (choices add steps); other lines are strings. No named inner
  // function: Wrangler's bundler (keepNames) would wrap it in a __name() helper that the page script, which runs this
  // function's source, lacks.
  const out: (string | [string])[] = [
    "Add GenClass's open-source parts to this web app (Apache-2.0, https://github.com/genclass-dev/GenClass): the @genclass/runtime library in its pages, which reports the bugs that never throw (double submits, stale responses that overwrite newer data, write races, visual bugs), and the @genclass/mcp server on this machine, so you, the coding agent, can see what happens on the dev pages, replay it and prove fixes. " +
      (quiet
        ? "No GenClass account and no token: nothing is sent to genclass.dev."
        : "No GenClass account and nothing to sign in to: step 2's init command (use it rather than the hand-written GenClass.init(), which has no token and so makes no dashboard link) creates the app's free dashboard link (it sends the package name, nothing else, and saves the private link in .genclass.local, which init adds to .gitignore; keep that link private), and GenClass's anonymous diagnostics stay on: its decisions and counts, no text from the page unless the app opts in, never from local hosts (every field: packages/runtime/TELEMETRY.md in that repository).") +
      " Do every step yourself.",
    "",
    [`Install the runtime with the project's package manager: npm install ${n.pkg} (or pnpm add / yarn add / bun add ${n.pkg}). A site with no build step (plain HTML pages, no bundler) installs nothing: it uses the script tags below.`],
    [
      (quiet
        ? "Start it as early as possible, with GenClass's anonymous diagnostics off (telemetry: false), so it sends no data anywhere"
        : "Start it as early as possible, with GenClass's anonymous diagnostics on (the default: its decisions and counts go to genclass.dev from public hosts, never from local ones)") +
        (own ? "" : `; the browser ${quiet ? "still " : ""}downloads its model and onnxruntime-web, public files, from cdn.jsdelivr.net (about 13 MB, 18 MB on WebGPU devices, then cached) unless the app serves them`) +
        ". With a bundler, in the browser entry (main.ts, the root layout or the root component), with the discover import first, before React, Redux or Zustand load:",
    ],
    '   import "@genclass/runtime/discover"; // first: lets GenClass find React, Redux and Zustand state',
    ...(logs ? ['   import { consoleJson } from "@genclass/runtime/sinks/console-json";'] : []),
    '   import { GenClass } from "@genclass/runtime";',
    `   const rt = GenClass.init({ ${init.join(", ")} });`,
    "   Without a bundler, in the <head> of every HTML page, before the page's own scripts:",
    `   <script src="${n.cdn}" ${attrs.join(" ")}></script>`,
    "   and in the page's scripts the handle (rt below) is GenClass.runtime.",
    `   (Or npx ${n.pkg} init ${flags.join(" ")} does steps 1 and 2 and shows the diff, with a bundler or plain HTML pages: it starts GenClass with its zero-code entry (the /auto import with an option file, or the script tag pinned with an integrity hash), which finds React, Redux and Zustand state by itself, and adds step 3's dev-only overlay; the handle is then GenClass.runtime${mode ? `; add ${initAdds}` : ""}${own ? "; run the fetch-model command below before it" : ""}.)`,
    [
      (heal
        ? "Mode heal, as chosen: when GenClass is sure, it acts with minimal steps that it logs: it drops a stale response, merges or blocks a duplicate submit, fixes a CSS bug on the page, retries a failed request or serves its cached answer, hedges a slow call, and rolls back a bad write or asks your store to resync; discards and rollbacks can be undone, and a breaker steps the mode down after repeated undos."
        : guard
          ? "Mode guard: when GenClass is sure, it acts with minimal, reversible steps (it drops a stale response or fixes a CSS bug on the page) and never changes a response."
          : "Mode observe, as chosen: GenClass reports and never changes what the app does.") +
        ' In development builds also mount the devtools overlay, which shows what GenClass sees on the page: if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt)); (Next.js: process.env.NODE_ENV === "development"; the script tag\'s data-devtools="local" does the same).',
    ],
    ['Connect the state that responses write (search results, carts, lists, forms), so GenClass sees each write with the response or click that caused it. React state, Redux stores (configureStore, or createStore with the Redux DevTools compose) and Zustand stores made with the devtools middleware are found automatically (the discover import with autoState: true above; the script tag and init\'s /auto import do it by default); otherwise create it with rt.atom("name", initial) or wrap the store you have with rt.guard("name", { get, set }), and write through the handle. Values one response writes together (a search\'s query and its results) go in one atom, written once per response, so GenClass can drop a stale response as one write: const search = rt.atom("search", { query: "", results: [] }); then search.set((s) => ({ ...s, query: data.q, results: data.results })) and render from search.subscribe.'],
    ['Development builds only, add the agent link: import { connectAgent } from "@genclass/runtime/agent"; if (import.meta.env.DEV) connectAgent(rt); (Next.js: process.env.NODE_ENV === "development"). It records what happens on local pages for the GenClass MCP server, talks only to 127.0.0.1 and is never part of a production build.'],
    `   Without a bundler, after the runtime's script tag: <script type="module">if (${local}) import("${n.agent}").then((a) => { const go = () => (GenClass.runtime ? a.connectAgent(GenClass.runtime) : setTimeout(go, 50)); go(); });</script>`,
    [`Add the GenClass MCP server to yourself: npx -y ${n.mcp} init writes .mcp.json for Claude Code (npx -y ${n.mcp} config <client> prints the block for Cursor, VS Code, Codex, Gemini CLI and others); then reload your MCP servers. It runs on this machine, its bridge listens on 127.0.0.1 only, and it needs no account${quiet ? ": leave GENCLASS_DASHBOARD and GENCLASS_REPORT unset (either one sends to a GenClass dashboard)" : "; in your own settings, not a file in the repository, set GENCLASS_DASHBOARD to the dashboard link from .genclass.local if you want genclass_analytics to read the app's production numbers, and set GENCLASS_REPORT to on to mirror what you find, replay and prove to that dashboard's Loop view; unset, the server sends nothing off this machine"}. init also prints setup lines for the app with a bare GenClass.init(): keep the setup from steps 2 and 5 instead. Its tools: genclass_status, genclass_findings, genclass_explain, genclass_replay, genclass_explore, genclass_scan.`],
    ...(logs
      ? [
          ['Findings print as [GenClass] lines in the browser console, and the console-json sink also prints each one as one JSON line, for the log shipper the app already uses. If the team has its own endpoint for them, the webhook sink sends batched POSTs there instead: import { webhook } from "@genclass/runtime/sinks/webhook"; sinks: [webhook({ url: "<the endpoint>" })], requests: { ignore: ["<the endpoint>"] } (so GenClass does not watch its own POSTs; data-sink="webhook:<the endpoint>" on the script tag does both). Ask me for that URL rather than inventing one.'] as [string],
        ]
      : []),
    ...(own
      ? [
          [`Serve the model from the app itself, so its pages download no model from a CDN: npx ${n.pkg} fetch-model public/genclass-model (the folder the project serves as-is: public/ for Vite, Next.js and Astro, static/ for SvelteKit), before init if you use init. It downloads the model and onnxruntime-web's files, checks the model files against the sizes and SHA-256 hashes its model card lists, and records onnxruntime-web's hashes in ort/ort.json; the model option above points at it. On a host with a 25 MiB per-file limit (Cloudflare), run fetch-model public/genclass-model --variant q8 --ort wasm instead and add device: "wasm" to the model option (data-device="wasm" on the script tag; init --model-url adds it when it finds only the WASM build). With a bundler nothing else loads from a CDN. Without one, the runtime's script and what it loads on demand (its model worker, onnxruntime-web's JavaScript, sinks, visual checks, the overlay, the agent link) still come from jsDelivr unless you serve the package's dist/ folder from the app and point the script tag and the agent link's import at it (data-base if they are in different folders).`] as [string],
        ]
      : []),
    [`Run the dev server and load a page to check that the app builds and runs without errors. Until the MCP server runs (your next conversation), the page logs a failed request to 127.0.0.1:47357: that is the agent link finding no server, and expected. In your next conversation, reload a dev page and genclass_status lists it. Then check a page for visual bugs with genclass_scan on its local URL, or from a terminal: npx ${n.pkg} scan http://localhost:5173/ --local (keep --local). It runs headless Chromium on this machine and needs Playwright: if the scan says it is missing, ask me before adding playwright as a dev dependency and downloading Chromium (about 600 MB): npm i -D playwright && npx playwright install chromium; or skip the scan and say so. Do not use hosted: true: it sends the page URL to GenClass's hosted page check, which is not open source.`],
    ...(c.deploy
      ? [["Deploy it, as chosen, with the command this project already uses (a deploy script in package.json, wrangler deploy for a Cloudflare Worker, vercel deploy --prod, and so on), then check that the deployed site serves the change."] as [string]]
      : []),
    [
      `Tell me what you changed${c.deploy ? " and where it is deployed" : ""}, ` +
        (quiet
          ? "that the app sets no GenClass token and has telemetry off, what it downloads from outside this network"
          : "whether init created the app's dashboard link (then it is in .genclass.local; keep it out of the repository), what the app sends to genclass.dev and what it downloads from outside this network") +
        ", and that a new conversation with you has the GenClass tools.",
    ],
  ];
  let k = 0;
  return out.map((l) => (typeof l === "string" ? l : `${++k}. ${l[0]}`)).join("\n");
}

/** A function's own source for a page script, safe inside its <script> element (no "</script" left in it). */
function fnSource(fn: (...a: never[]) => unknown): string {
  return fn.toString().replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * One choice of a prompt's checkboxes (/start/open-source, the Connect dialog); a sub choice is indented, `on` ticks
 * it in the markup (DEFAULT_CHOICES). It is never disabled in the markup: a browser brings back only enabled boxes
 * with the page, so the page script disables it on pageshow, after that restore, while its parent is off (the prompts
 * ignore it then anyway).
 */
function choiceOpt(k: string, label: string, note: string, o: { sub?: boolean; on?: boolean } = {}): string {
  return `<label class="copt${o.sub ? " sub" : ""}"><input type="checkbox" data-choice="${k}"${o.on ? " checked" : ""}><span><b>${label}</b> ${note}</span></label>`;
}

/** The commands' agent link, before its development check (which is the bundler's: init writes the same one). */
const AGENT_LINK_HEAD = `// in the app's entry, after the lines init added
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";`;

/** The prompt block's styles on genclass.dev's palette (the dashboard's .copts and .cprompt, DASH_CSS, re-tokened). */
const OSS_CSS = `
.copts{display:grid;gap:6px;max-width:72ch}
fieldset.copts{border:0;padding:0;margin:0;min-width:0}
.copts legend{padding:0;margin-bottom:4px}
.cmds h3{font-size:17px;letter-spacing:-.015em;font-weight:500;margin:0}
.copt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--rule2);cursor:pointer;font-size:14px;color:var(--ink2);line-height:1.45}
.copt b{color:var(--ink);font-weight:500}
.copt input{margin-top:4px;accent-color:var(--accent)}
.copt.sub{margin-left:26px}
.copt:has(input:disabled){opacity:.55;cursor:default}
.copt:has(input:checked){border-color:var(--ink3)}
.cprompt{display:grid;justify-items:start;gap:10px}
.cprompt .btn.xl{min-height:52px;font-size:16px;padding:0 24px}
.cp-sub{font-size:14px;color:var(--ink2);max-width:64ch}
textarea.cp-text{width:100%;max-width:72ch;min-height:150px;padding:10px 12px;font:12.5px/1.5 var(--mono);color:var(--ink);background:var(--code);border:1px solid var(--rule2);border-radius:0;resize:vertical}
ul.facts{list-style:none;display:grid;gap:8px;max-width:72ch;color:var(--ink2);font-size:14px}
ul.facts li{padding-left:16px;position:relative}
ul.facts li::before{content:"";position:absolute;left:0;top:.62em;width:6px;height:6px;background:var(--accent-f)}
ul.facts code,.cmds p code{font:13px var(--mono);color:var(--ink)}
@media (max-width:560px){.cprompt .btn.xl{width:100%;white-space:normal;text-align:center;padding:10px 16px}.copt.sub{margin-left:14px}}
`;

/**
 * /start/open-source: GenClass's open-source parts with no account (openSourcePrompt behind one copy button, its
 * choices with DEFAULT_CHOICES ticked, what leaves the network, the commands). Its script rewrites the prompt in the
 * browser and sends nothing.
 */
export function openSourcePage(nonce: string): string {
  const d = DEFAULT_CHOICES;
  const prompt = openSourcePrompt(d);
  const cmd = (label: string, code: string) =>
    `<div class="snip"><div class="row between"><h3>${label}</h3><button class="btn sm ghost" type="button" data-copy="${esc(code)}" aria-label="Copy ${esc(label)}">Copy</button></div><pre class="code" tabindex="0">${esc(code)}</pre></div>`;
  const repo = "https://github.com/genclass-dev/GenClass";
  const body = `
<style nonce="${nonce}">${OSS_CSS}</style>
<section class="stack mt-xl">
  <h1>GenClass without an account</h1>
  <p class="lead">The open-source parts only, Apache-2.0: the runtime in your app's pages, and the MCP server and the
  page check on your machine. No sign-in and no token to paste: the runtime's anonymous diagnostics stay on, and the
  init command gives the app its free dashboard link; one choice below sends nothing to genclass.dev at all.</p>
</section>
<section class="card stack">
  <fieldset class="copts" id="choices">
    <legend class="cp-sub">What the prompt sets up (Guard and Heal are on: the heal mode; both off is observe, which only reports)</legend>
    ${choiceOpt("guard", "Guard", "GenClass fixes what it is sure of, reversibly: it drops a stale response, fixes a CSS bug on the page.", { on: d.guard })}
    ${choiceOpt("heal", "Heal", "With Guard: the heal mode, which also blocks a repeat, retries a failed request or serves its cached answer, hedges a slow call, and rolls back a bad write or asks your store to resync. Wrong interventions: 0.59% on held-out simulated apps at the default setting, 0.00% on held-out real apps (model 0.2.0).", { sub: true, on: d.heal })}
    ${choiceOpt("logs", "Findings in our own logs", "Each finding also goes to the console as one JSON line, for the log shipper you already run.")}
    ${choiceOpt("selfHost", "Serve the model ourselves", "The model and onnxruntime-web's wasm come from your app's host, not jsDelivr: for a strict Content-Security-Policy or a closed network. With script tags, the prompt says what else to serve.")}
    ${choiceOpt("quiet", "Nothing sent to genclass.dev", "No dashboard link, and the anonymous diagnostics off (telemetry: false): for teams that may send nothing to a hosted service.")}
    ${choiceOpt("deploy", "Deploy when done", "The agent deploys with the project's own deploy command.")}
  </fieldset>
  <div class="cprompt">
    <button class="btn green xl" type="button" id="cp" data-copy="${esc(prompt)}">Copy the prompt for your coding agent</button>
    <p class="cp-sub">Paste it into Claude Code, Cursor or Codex: it adds GenClass to your app and the MCP server to the agent, with nothing to sign up for.</p>
    <textarea class="cp-text" id="cpt" readonly hidden aria-label="The prompt, to copy by hand" rows="8">${esc(prompt)}</textarea>
  </div>
</section>
<section class="stack">
  <h2 class="h2l">What leaves your network</h2>
  <ul class="facts">
    <li>To genclass.dev, with the defaults: the package name, once, when <code>init</code> creates the app's free dashboard link (the link stays in <code>.genclass.local</code>, which init adds to <code>.gitignore</code>), and then the runtime's anonymous diagnostics from public hosts: its decisions and counts with the app's hostname and the route without ids, no text from the page unless the app opts in, never from local hosts (every field: <a href="${repo}/blob/main/packages/runtime/TELEMETRY.md">TELEMETRY.md</a>). With <b>Nothing sent to genclass.dev</b> ticked: nothing; there is no token, and <code>telemetry: false</code> turns the diagnostics off.</li>
    <li>Browsers download public files from jsDelivr (cdn.jsdelivr.net), once, then cached: the model and onnxruntime-web (about 13 MB on WASM, 18 MB on WebGPU) unless you serve them yourself, and on sites without a bundler the runtime's own files unless you serve its <code>dist/</code> folder. No app data goes with those requests.</li>
    <li>The MCP server runs on your machine and its bridge listens on 127.0.0.1 only; with <code>GENCLASS_DASHBOARD</code> and <code>GENCLASS_REPORT</code> unset it sends nothing off the machine, and it keeps what it records in <code>.genclass/agent</code> in the project, which git ignores. <code>genclass_scan</code> and <code>scan --local</code> check pages in headless Chromium on your machine. A page URL leaves it only with <code>hosted: true</code> (or <code>scan</code> without <code>--local</code> when Playwright or its Chromium is missing): it then goes to GenClass's hosted page check (genclass-scan.mehar-144.workers.dev), which is not open source.</li>
    <li>On developer machines, npm install and npx fetch packages from the npm registry (or your mirror), and the page check's Chromium comes from Playwright's download servers; <code>fetch-model</code> (to serve the model yourself) downloads the model and onnxruntime-web from jsDelivr, or from a mirror you name with <code>--from</code> and <code>--ort-from</code>.</li>
    <li>The runtime, the MCP server, the model's training code and the collector behind genclass.dev are on <a href="${repo}">GitHub</a> under the Apache-2.0 license; the model's weights are on npm as <code>@genclass/runtime-model</code> (Apache-2.0).</li>
  </ul>
</section>
<section class="stack cmds">
  <h2 class="h2l">Or run the commands yourself</h2>
  ${cmd("Add the runtime to your app", `npx ${RUNTIME_PKG} init --mode heal`)}
  ${cmd("Connect the dev pages to the MCP server: Vite", `${AGENT_LINK_HEAD}\nif (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime);`)}
  ${cmd("The same for Next.js and webpack", `${AGENT_LINK_HEAD.replace("the app's entry", "the app's entry (Next.js: instrumentation-client.ts)")}\nif (process.env.NODE_ENV === "development" && GenClass.runtime) connectAgent(GenClass.runtime);`)}
  ${cmd("Add the MCP server for Claude Code", `npx -y ${MCP_PKG} init`)}
  ${cmd("Check a page for visual bugs", `npx ${RUNTIME_PKG} scan http://localhost:5173/ --local`)}
  <p class="muted small">init shows the diff and asks before it writes; with <code>--no-telemetry</code> nothing is sent to genclass.dev, and without <code>--mode heal</code> the mode is observe. Other agents: <code>npx -y ${MCP_PKG} config &lt;client&gt;</code> prints the block for Cursor, VS Code, Codex, Gemini CLI and others; with <code>--no-telemetry</code> keep <code>GENCLASS_DASHBOARD</code> and <code>GENCLASS_REPORT</code> out of it; otherwise <code>GENCLASS_DASHBOARD</code> may name the link from <code>.genclass.local</code>, so <code>genclass_analytics</code> reads the app's production numbers. The scan needs Playwright (<code>npm i -D playwright &amp;&amp; npx playwright install chromium</code>).</p>
</section>
<footer>The link init makes is the free dashboard, with no account; <a href="/signup">create a free account</a> to keep several apps in one place.
Want a dashboard without sending data to us? The collector is open source too:
<a href="${repo}/blob/main/telemetry-worker/README.md#self-host-the-collector-private-mode">run it on your own Cloudflare account</a>.</footer>`;
  const script = `
(function(){
  var openSourcePrompt = ${fnSource(openSourcePrompt)};
  var NAMES = ${JSON.stringify(PROMPT_NAMES).replace(/</g, "\\u003c")};
  var box = document.getElementById("choices"), cp = document.getElementById("cp"), ta = document.getElementById("cpt");
  function on(k){ var i = box.querySelector('[data-choice="' + k + '"]'); return !!(i && i.checked && !i.disabled); }
  function now(){
    var p = openSourcePrompt({ guard: on("guard"), heal: on("heal"), logs: on("logs"), selfHost: on("selfHost"), quiet: on("quiet"), deploy: on("deploy") }, NAMES);
    cp.setAttribute("data-copy", p); ta.value = p;
  }
  function healFollows(){ var g = box.querySelector('[data-choice="guard"]'), h = box.querySelector('[data-choice="heal"]'); h.disabled = !g.checked; if (!g.checked) h.checked = false; }
  box.addEventListener("change", function(e){ if (e.target && e.target.getAttribute && e.target.getAttribute("data-choice") === "guard") healFollows(); now(); });
  [].forEach.call(document.querySelectorAll("[data-copy]"), function(b){
    b.addEventListener("click", function(){ gcCopy(b, b.getAttribute("data-copy"), b === cp ? ta : b.parentNode.parentNode.querySelector("pre")); });
  });
  // a browser can bring boxes back with the page (back, reload), ticked or unticked; Chromium does it after load, before
  // pageshow and without a change event, and skips disabled boxes: so heal (ticked in the markup) is disabled only on
  // pageshow, when a restored unticked guard also unticks it, and the prompt follows then
  function sync(){ healFollows(); now(); }
  now(); window.addEventListener("pageshow", sync);
})();`;
  return shell(nonce, "Use GenClass without an account | GenClass", body, script);
}

// ------------------------------------------------------------------------------------------------- 404

export function notFoundPage(nonce: string): string {
  return shell(
    nonce,
    "Dashboard not found | GenClass",
    `<section class="stack mt-xl"><h1>Dashboard not found</h1>
<p class="lead">This link does not match any GenClass dashboard. Check that you copied the whole link, or
<a href="/start">get a new token</a>.</p></section>`,
    "",
  );
}

// ------------------------------------------------------------------------------------------------- dashboard

// ---------------------------------------------------------------------------------------------- /dashboard
// The per-app dashboard, in the Supabase Studio frame (src/studio.ts): a project's views in the rail (Project
// overview, Problems, Pages, Actions, Activity, Visitors, Health, MCP, Loop, Integrations, Project Settings), the
// Visitors and Settings product menus, and the Connect dialog. Project overview follows Studio's project home: the
// name, its status, four stats, the problems chart on the right; then usage cards (page loads, problems,
// interventions, visits, one bar per hour or day), Get connected, and the problems that need attention, each with a
// Copy prompt button for a coding agent. Every view can be copied as Markdown for an agent.
// The copy is labels, not sentences (owner, 2026-11-05): no captions or numbering under charts and tables (their
// titles and hover tooltips say it), no explanations of what a button does, no disclosure text (the privacy policy
// and the header's Help menu hold it). The copied prompts and the Markdown keep their detail: an agent reads them.
// Chart colours come from genclass.dev's own hues, stepped into the dark chart lightness band (OKLCH L .48-.67): blue,
// the red-orange the site uses for bugs, a sky blue, amber (the site's warning colour) and violet, in that order. No
// green: green is the frame's brand colour (buttons, usage bars, what GenClass did), so a problem type never reads as
// it. Validated with the dataviz skill's validate_palette.js (adjacent pairs, as the stacks draw them) on 2026-10-17:
// on #000000 and #0B0B0A all checks pass, worst CVD ΔE 20.7 (deutan; tritan 7.3), normal-vision 24.8; every slot is
// also at least 3:1 on Studio's canvas #121212 and surface #1f1f1f (test/pages.test.ts measures them). The light
// steps of the same hues (:root[data-theme="light"], OKLCH L .43-.77) passed validate_palette.js --mode light on
// #ffffff and #f7f7f7 on 2026-11-05: worst CVD ΔE 18.4 (protan; tritan 6.2), normal-vision 22.8, every slot 3:1.
// Every colour this page sets is a token: the frame's (studio.ts STUDIO_CSS) or one of DASH_CSS's own, which are
// defined twice, dark first and then for :root[data-theme="light"].
// A bar draws only the types it has, so slots that are not palette neighbours can touch; the 2px canvas gap between
// segments, the legend, the hover breakdown and the table view carry identity there.
// Five problem types get a slot, the rest share "Other". The measured visual checks (never model findings) get one more
// slot of their own, hatched in the muted ink rather than a hue, so they never read as a model type. Possible issues
// (the lower-confidence tier) are drawn hollow:
// outlined bars in the muted ink (one series, so no legend) and ring keys in the type's colour; never in the
// confirmed counts.
// Every dynamic string goes through textContent.

export const DASH_CSS = `
/* the tour's sample data (no data yet): a badge says so while it is shown */
body.sampling::after{content:"Sample data";position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:97;padding:4px 12px;border-radius:999px;background:var(--accent-f);color:var(--on-green);font:500 12px var(--sans);letter-spacing:.02em;box-shadow:var(--shadow-m);pointer-events:none}
:root{--t1:#3987E5;--t2:#E8552F;--t3:#2AA3C7;--t4:#C98500;--t5:#B964C9;--t0:#88897F;--grid:#262626}
/* colours with no base token: the critical status, the status dot's halo, control and overlay borders, the tooltip's
   shadow, the row hover, badge and notice borders, the project card's hover */
:root{--bad:#f2555a;--halo:rgba(255,255,255,.06);--ctl-b:#393939;--ctl-bh:#4d4d4d;--ovl-b:#333333;--shadow:0 8px 24px rgba(0,0,0,.5);--row-h:#ffffff06;--accent-b:#0f5a37;--amber-b:#5c3d06;--warn-b:#5c2018;--card-h:#232323}
:root[data-theme="light"]{--t1:#2470D6;--t2:#D4502B;--t3:#1388AD;--t4:#A86C00;--t5:#A04FB5;--t0:#7C7D74;--grid:#ececec;--bad:#c8242b;--halo:rgba(0,0,0,.06);--ctl-b:#d4d4d4;--ctl-bh:#b5b5b5;--ovl-b:#e0e0e0;--shadow:0 8px 24px rgba(0,0,0,.12);--row-h:#00000005;--accent-b:#a7dcc1;--amber-b:#f0d08a;--warn-b:#f3b9ab;--card-h:#f7f7f7}
.cmdbox{display:flex;align-items:center;gap:10px;background:var(--code);padding:10px 12px;min-width:0;margin:8px 0}
.cmdbox code{flex:1;min-width:0;font:13.5px/1.5 var(--mono);overflow-wrap:anywhere}
.cmdbox .btn{flex:none}
/* the measured checks' key: hatched in the muted ink, never a problem type's hue */
:root{--chk:repeating-linear-gradient(135deg,var(--ink2) 0 2px,transparent 2px 4px)}
.find h3 .bdg,.adv h3 .bdg{margin-left:2px}
table.dt td .bdg{margin-left:8px;vertical-align:middle}
/* the page header: the project's name on the overview, the view's title elsewhere; the period and the tools */
.phead{display:flex;flex-wrap:wrap;gap:16px 24px;align-items:flex-start;justify-content:space-between;margin-bottom:28px}
.phead h1{font-size:30px;line-height:1.2;letter-spacing:-.02em;overflow-wrap:anywhere}
.phead #vtitle{font-size:24px}
.phead #vdesc{color:var(--ink3);margin-top:4px;max-width:72ch}
.tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}
.tools #updated{font-size:12px;color:var(--ink3);white-space:nowrap}
.ov-meta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:10px;font-size:13px;color:var(--ink3)}
/* the app's status under its name: Critical, Needs attention or Healthy, large, in red, amber or green */
.verdict{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:14px}
.verdict i{width:16px;height:16px;border-radius:50%;background:currentColor;box-shadow:0 0 0 5px var(--halo);flex:none}
.verdict b{font:600 40px/1.1 var(--display);letter-spacing:-.02em}
.verdict span{font-size:15px;color:var(--ink2)}
.verdict.ok{color:var(--accent)}
.verdict.warn{color:var(--amber)}
.verdict.bad{color:var(--bad)}
@media (max-width:560px){.verdict b{font-size:30px}}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--ink2)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--ink3);display:inline-block}
.live.on i{background:var(--accent)}
.seg{display:inline-flex;border:1px solid var(--ctl-b);border-radius:6px;overflow:hidden;background:var(--s75)}
.seg button{border:0;background:transparent;color:var(--ink2);height:26px;padding:0 10px;font:12px var(--sans);cursor:pointer}
.seg button+button{border-left:1px solid var(--ctl-b)}
.seg button:hover{color:var(--ink)}
.seg button[aria-pressed=true]{background:var(--s300);color:var(--ink)}
@media (pointer:coarse){.seg button{height:40px}}
/* Project overview: Studio's top section (name, stats; the chart on the right), usage cards, Get connected, issues */
.ovtop{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;align-items:start}
.statrow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin-top:0;border:1px solid var(--rule);border-radius:6px;background:var(--panel);overflow:hidden}
.statrow>div{padding:16px 18px;min-width:0;border-bottom:1px solid var(--rule)}
.statrow>div:nth-child(odd){border-right:1px solid var(--rule)}
.statrow>div:nth-last-child(-n+2){border-bottom:0}
.statrow .k{font:12px var(--mono);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2)}
.statrow .v{font:400 26px/1.15 var(--display);letter-spacing:-.02em;margin-top:8px;font-variant-numeric:tabular-nums}
.statrow .s{font-size:12.5px;color:var(--ink3);margin-top:4px}
.usage{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.ucard{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:18px 18px 12px;min-height:220px;min-width:0}
.ucard .k{font:12px var(--mono);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2)}
.ucard .v{font:400 22px var(--display);margin-top:4px;font-variant-numeric:tabular-nums}
.ucard .d{font-size:12px;color:var(--ink3);margin-top:2px}
.ucard svg{margin-top:auto;width:100%;height:110px;display:block}
.ucard .ax{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--ink3);margin-top:6px}
.uh{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin:48px 0 16px}
.prolock{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between;border:1px solid var(--accent-b,var(--rule));background:var(--accent-t,transparent);border-radius:12px;padding:16px 18px;margin:0 0 24px}.prolock p{margin:4px 0 0;color:var(--ink2);max-width:640px}
.uh h2{font-size:18px;color:var(--ink2)}
.uh h2 b{color:var(--ink);font-weight:400}
.getc{border:1px dashed var(--rule2);border-radius:6px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:var(--s75)}
.getc>*{display:flex;gap:12px;align-items:flex-start;padding:18px 20px;text-align:left;background:none;border:0;color:inherit;font:inherit;cursor:pointer;text-decoration:none;min-width:0}
.getc>*+*{border-left:1px solid var(--rule)}
.getc>*:hover{background:var(--s200)}
.getc .ic{color:var(--ink3);margin-top:2px}
.getc>*:hover .ic{color:var(--ink)}
.getc b{display:block;font-weight:400;font-size:14px;color:var(--ink)}
.adv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.adv article{display:flex;flex-direction:column;gap:10px;background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:16px 18px;min-width:0}
.adv article .top{display:flex;justify-content:space-between;gap:12px;align-items:center}
.adv article h3{display:flex;align-items:center;gap:8px;font-size:14px}
.adv article p{font-size:13px;color:var(--ink3);line-height:1.5}
.adv article .acts{display:flex;gap:8px;margin-top:auto;padding-top:4px}
.adv .none{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:48px 16px;border:1px solid var(--rule);border-radius:6px;color:var(--ink3);font-size:13px}
@media (max-width:1100px){.usage{grid-template-columns:repeat(2,minmax(0,1fr))}.adv{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.ovtop{grid-template-columns:minmax(0,1fr)}}
@media (max-width:620px){.usage,.adv,.getc{grid-template-columns:minmax(0,1fr)}.getc>*+*{border-left:0;border-top:1px solid var(--rule)}.statrow{grid-template-columns:minmax(0,1fr)}.statrow>div{border-right:0!important;border-bottom:1px solid var(--rule)!important}.statrow>div:last-child{border-bottom:0!important}}
/* sections are Studio panels: a header row and the content under it */
.blk{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:0 20px 20px;margin-top:20px;min-width:0}
.blk-h{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;justify-content:space-between;margin:0 -20px 16px;padding:12px 20px;border-bottom:1px solid var(--rule);min-height:48px}
.blk-h h2{font-size:14px;color:var(--ink);margin:0}
.blk-h .aside{font-size:12px;color:var(--ink3)}
.two{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));margin-top:20px}
.two>.blk{margin-top:0}
.ovtop .blk{margin-top:0}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--ink2);margin-top:4px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.key{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}
.key.ring{background:transparent;border:1.5px solid var(--ink3)}
.poss-fig{margin-top:28px}
.poss-h{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--rule)}
.poss-h h3{font-size:14px}
.poss-h .aside{font-size:12px;color:var(--ink3)}
.poss-note{font-size:13px;color:var(--ink3);max-width:80ch}
.find.poss .n{color:var(--ink2)}
table.dt td.poss-n{color:var(--ink3)}
figure{margin:0}
figcaption{font-size:12px;color:var(--ink3);margin-top:12px;line-height:1.5}
.plot{position:relative;margin-top:12px}
.plot svg{display:block;width:100%;height:auto;overflow:visible}
.plot text{font:11px var(--mono);fill:var(--ink3)}
.tip{position:absolute;pointer-events:none;background:var(--ovl);border:1px solid var(--ovl-b);border-radius:6px;padding:8px 10px;font-size:12px;min-width:160px;z-index:2;box-shadow:var(--shadow)}
.tip .t{font-size:12px;color:var(--ink);margin-bottom:5px}
.tip .r{display:flex;align-items:center;gap:8px;justify-content:space-between}
.tip .r span:first-child{display:inline-flex;align-items:center;gap:6px;color:var(--ink2)}
.tip .r b{font-variant-numeric:tabular-nums;font-weight:400}
/* Problems: one card per kind, as Studio's advisor cards */
.finds{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr));gap:16px}
.find{background:var(--s75);border:1px solid var(--rule);border-radius:6px;padding:16px 18px;display:grid;gap:10px;align-content:start;min-width:0}
.find .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.find h3{font-size:14px;display:flex;align-items:center;gap:8px}
.find .nw{text-align:right;white-space:nowrap}
.find .n{font:400 22px/1 var(--display);font-variant-numeric:tabular-nums}
.find p{font-size:13px;color:var(--ink2);line-height:1.55}
.find p.fix b{color:var(--ink);font-weight:500}
.find .acts{display:flex;gap:8px;flex-wrap:wrap}
.where{list-style:none;display:grid;gap:2px}
.where li{display:flex;justify-content:space-between;gap:12px;font:12px var(--mono);padding:3px 0;border-bottom:1px dashed var(--rule)}
.where li code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font:inherit;color:var(--ink2)}
.where li span{color:var(--ink3);font-variant-numeric:tabular-nums;flex:none}
.spark{display:block;width:100%;height:24px}
table.dt{width:100%;border-collapse:collapse;font-size:13px}
table.dt th{font:400 12px var(--sans);color:var(--ink3);background:var(--s75);text-align:left;padding:8px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}
table.dt td{padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:middle;white-space:nowrap}
table.dt tr:last-child td{border-bottom:0}
table.dt tbody tr:hover td{background:var(--row-h)}
table.dt .num{text-align:right;font-variant-numeric:tabular-nums}
table.dt td.route{font:12.5px var(--mono);max-width:260px;overflow:hidden;text-overflow:ellipsis;color:var(--ink2)}
table.dt td.wide{width:40%}
.blk .tablewrap,.blk>table.dt,.blk>div>table.dt{margin:0 -20px;width:calc(100% + 40px)}
.blk .tablewrap table.dt{width:100%;margin:0}
.blk table.dt th:first-child,.blk table.dt td:first-child{padding-left:20px}
.blk table.dt th:last-child,.blk table.dt td:last-child{padding-right:20px}
.mix{display:flex;gap:2px;height:6px}
.mix i{display:block;height:6px;border-radius:2px;min-width:3px}
.chip{display:inline-flex;align-items:center;gap:7px}
.did-a{color:var(--accent)}
dl.health{display:grid;grid-template-columns:minmax(150px,240px) minmax(0,1fr)}
dl.health dt,dl.health dd{padding:14px 0;border-bottom:1px solid var(--rule)}
dl.health dt:last-of-type,dl.health dd:last-of-type{border-bottom:0}
dl.health dt{font-size:13px;color:var(--ink3);padding-right:18px}
dl.health .v{font:400 16px var(--display)}
dl.health .s{font-size:12.5px;color:var(--ink3);margin-top:3px}
dl.health ul{list-style:none;margin-top:6px;display:grid;gap:2px;font:12px var(--mono);color:var(--ink2)}
.ok-t,.bad-t{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font:500 10px/1 var(--mono);text-transform:uppercase;letter-spacing:.05em;margin-left:10px;vertical-align:middle}
.ok-t{color:var(--accent);background:var(--accent-t);border:1px solid var(--accent-b)}
.bad-t{color:var(--amber);background:var(--amber-t);border:1px solid var(--amber-b)}
@media (max-width:560px){dl.health{grid-template-columns:1fr}dl.health dt{border-bottom:0;padding-bottom:0}}
.quiet{padding:28px 0;color:var(--ink3);font-size:13px;text-align:center}
details.more{border-top:1px solid var(--rule);padding:14px 0 0;margin-top:16px}
details.more summary{font-size:13px;color:var(--ink2);cursor:pointer}
details.more summary:hover{color:var(--ink)}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px 32px}
.kv h2{font-size:13px;color:var(--ink2);margin-bottom:8px}
.bars{list-style:none;display:grid;gap:6px}
.bars li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:12px}
.bars .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);color:var(--ink2)}
.bars .n{font-variant-numeric:tabular-nums;color:var(--ink3)}
.bars .track{grid-column:1/-1;height:4px;border-radius:2px;background:var(--s300)}
.bars .fill{height:4px;border-radius:2px;background:var(--accent)}
.empty{color:var(--ink3);font-size:12px}
/* Getting started (no data yet): Studio's onboarding panel */
.first{padding:24px}
.first h2{font-size:18px}
.steps{list-style:none;margin-top:20px;display:grid;gap:0;border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.steps li{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;background:var(--s75)}
.steps li+li{border-top:1px solid var(--rule)}
.steps .no{width:24px;height:24px;border-radius:50%;border:1px solid var(--rule2);display:flex;align-items:center;justify-content:center;font:12px var(--mono);color:var(--ink2)}
.steps b{font-weight:400;color:var(--ink);font-size:14px}
.steps li>div>span{display:block;font-size:13px;color:var(--ink3);margin-top:2px}
@media (max-width:620px){.steps li{grid-template-columns:28px minmax(0,1fr)}.steps li .btn{grid-column:2;justify-self:start}}
/* the Connect dialog: its status line, tabs, the key, the ways in, the copy-prompt blocks */
.cstat{display:flex;align-items:center;gap:9px;padding:10px 12px;margin-bottom:4px;font-size:13px;color:var(--ink2);border:1px solid var(--rule);border-radius:6px;background:var(--s75)}
.cstat i{width:8px;height:8px;border-radius:50%;background:var(--amber);flex:none;animation:gcpulse 1.6s ease-in-out infinite}
.cstat.on{color:var(--accent);border-color:var(--accent-b);background:var(--accent-t)}
.cstat.on i{background:var(--accent);animation:none}
@keyframes gcpulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.cstat i{animation:none}}
.connect .cnote,.cnote{margin:0 0 12px;padding:10px 14px;border:1px solid var(--amber-b);border-radius:6px;background:var(--amber-t);font-size:13px;line-height:1.5;color:var(--ink2)}
.cnote b{color:var(--amber);font-weight:500}
.connect .keyrow,.keyrow{display:grid;grid-template-columns:minmax(140px,200px) minmax(0,1fr);gap:8px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.keyrow:last-child{border-bottom:0}
.keyrow .k{font-size:13px;color:var(--ink2);padding-top:5px}
.kval{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;min-width:0}
.kval code{font:13px var(--mono);background:var(--ctl);border:1px solid var(--rule2);border-radius:6px;padding:5px 10px;overflow-wrap:anywhere;min-width:0}
.keyrow .kn{grid-column:2;font-size:12.5px;color:var(--ink3);max-width:70ch}
.connect .ways{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px}
.connect .way{border:1px solid var(--rule);border-radius:6px;padding:16px;min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-content:start;background:var(--s75)}
.connect .way>*{min-width:0}
.eb{font:12px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)}
.sh{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;color:var(--ink3);margin-top:4px}
.connect pre.code,.mcpc pre.code{white-space:pre-wrap;overflow-wrap:anywhere}
.fine{font-size:12px;color:var(--ink3);margin-top:12px;max-width:100ch;line-height:1.55}
.fine code,.cp-sub code{font-size:11.5px}
.kn .lnk,.fine .lnk{color:var(--ink2);text-decoration:underline;text-underline-offset:3px}
.kn .lnk:hover{color:var(--ink)}
.cprompt{padding:8px 0 4px;display:grid;justify-items:start;gap:10px}
/* the Connect dialog's choices: each a checkbox and one line of what it adds to the prompt */
.copts{display:grid;gap:6px;margin:4px 0 12px;max-width:72ch}
.copt{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--rule2);border-radius:6px;cursor:pointer;font-size:13px;color:var(--ink3);line-height:1.45}
.copt b{color:var(--ink);font-weight:500}
.copt input{margin-top:3px;accent-color:var(--accent)}
.copt.sub{margin-left:26px}
.copt:has(input:disabled){opacity:.55;cursor:default}
.copt:has(input:checked){border-color:var(--ink3)}
.cprompt .cp-sub{font-size:13px;color:var(--ink3);max-width:64ch;line-height:1.5}
.cprompt textarea.cp-text{width:100%;max-width:72ch;min-height:150px;padding:10px 12px;font:12.5px/1.5 var(--mono);color:var(--ink);background:var(--ctl);border:1px solid var(--rule2);border-radius:6px;resize:vertical}
.connect .cana{padding:0}
@media (max-width:560px){.cprompt .btn.xl{width:100%;white-space:normal;text-align:center;padding:10px 16px}.keyrow{grid-template-columns:1fr}.keyrow .kn{grid-column:1}}
/* MCP: the client picker, the options, the configuration, the tools */
.mcpc .clients{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.mcpc .clients button{height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--ctl-b);background:var(--s75);color:var(--ink2);font:13px var(--sans);cursor:pointer}
.mcpc .clients button:hover{color:var(--ink);border-color:var(--ctl-bh)}
.mcpc .clients button[aria-pressed=true]{background:var(--s300);color:var(--ink);border-color:var(--ctl-bh)}
.mcpc .opts{display:flex;flex-wrap:wrap;gap:8px 20px;margin:4px 0 14px;font-size:13px;color:var(--ink2)}
.mcpc .opts label{display:inline-flex;gap:8px;align-items:center;cursor:pointer;color:var(--ink2)}
.mcpc .opts input{accent-color:var(--accent);width:14px;height:14px}
.mcpc .where{margin:0 0 6px;border:0;font:12.5px var(--sans);color:var(--ink3);display:block}
.mcpc .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;align-items:center}
.mcpc .warn{font-size:12.5px;color:var(--amber);margin-top:10px}
.alink{display:grid;gap:10px}
.alink .err{font-size:13px;color:var(--warn)}
.alink .err:empty{display:none}
.tools-t td:first-child{font:12.5px var(--mono);color:var(--ink)}
table.dt.tools-t td{white-space:normal}
/* funnels: one row per step, the bar's length the share of the first step */
.fun{padding:14px 0;border-bottom:1px solid var(--rule)}
.fun h3{font-size:14px;margin-bottom:10px}
.fun table td.route{max-width:340px}
.fun .drop{font:12px var(--mono);color:var(--ink3)}
.funedit{display:grid;gap:14px;padding:16px 0;max-width:720px}
.funedit .fe{display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr) auto;gap:10px;align-items:start}
.funedit .acts{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.funedit .err{font-size:13px;color:var(--warn)}
@media (max-width:620px){.funedit .fe{grid-template-columns:1fr}}
.mainc{min-width:0}
.lock{padding:24px}
.lock h2{font-size:18px}
.lock p{font-size:14px;color:var(--ink2);margin-top:6px}
.lock .acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.lock .err{font-size:13px;color:var(--warn);margin-top:10px}
.lock .err:empty{display:none}
/* the closed loop: an SVG the script builds from the stats; one row per problem kind, the shared chain on the right */
.loop-foot{font-size:13px;color:var(--ink3);max-width:90ch;margin-top:14px;line-height:1.55}
.flowwrap{overflow-x:auto;margin-top:16px}
.flow{display:block;width:100%;min-width:760px;height:auto;font-family:var(--sans)}
.flow rect.node{fill:var(--s75);stroke:var(--rule2)}
.flow rect.node.gate{stroke:var(--warn)}
.flow rect.node.quiet{stroke-dasharray:4 3}
.flow rect.node.agent{stroke:var(--accent)}
.flow .nt{font:500 13.5px var(--sans);fill:var(--ink)}
.flow .nb{font:12px var(--sans);fill:var(--ink2)}
.flow .col{font:500 11px var(--mono);fill:var(--ink3);letter-spacing:.06em}
.flow .edge{fill:none;stroke:var(--ink3);stroke-width:1.2}
.flow .edge.dim{stroke-dasharray:5 4}
.flow marker path{fill:var(--ink3)}
/* the stages of the loop: the count of the period's findings that reached each, the back edges dashed */
.flow .nn{font:500 28px var(--sans);fill:var(--ink);font-variant-numeric:tabular-nums}
.flow .nn.off{fill:var(--ink3)}
.flow .el{font:11.5px var(--mono);fill:var(--ink3)}
.flow rect.node.stage.closed{stroke:var(--accent)}
.flow rect.node.stage.on{stroke:var(--ink2)}
.blk-h.sub{margin-top:44px;border-bottom-color:var(--rule)}
.blk-h.sub h3{font-size:17px;font-weight:500;margin:0}
.dash-only{display:contents}
`;

const DASH_JS = `
(function(){
  var P = JSON.parse(document.getElementById("project").textContent);
  var secret = location.pathname.split("/").filter(Boolean)[1] || "";
  var statsUrl = P.statsUrl || ("/api/projects/" + encodeURIComponent(secret));
  var range = "7d";
  try { var saved = localStorage.getItem("gc.dash.range"); if (/^(24h|7d|30d|90d|1y)$/.test(saved || "") && document.querySelector('.seg button[data-r="' + saved + '"]')) range = saved; } catch (e) {}
  var nf = new Intl.NumberFormat(), MCP = "${MCP_PKG}", shownS = null, sampling = false, gcShow = null, realS = null, loading = null;
  function fmt(n){ return nf.format(Math.round(n || 0)); }
  function plural(n, one, many){ return fmt(n) + " " + (Math.round(n) === 1 ? one : many); }
  var RANGE = { "24h": "In the last 24 hours", "7d": "In the last 7 days", "30d": "In the last 30 days", "90d": "In the last 90 days", "1y": "In the last year" };
  var PREV = { "24h": "the 24 hours before", "7d": "the previous 7 days", "30d": "the previous 30 days", "90d": "the previous 90 days", "1y": "the year before" };
  var TYPES = {
    duplicate: { name: "Double submits", c: "--t1",
      what: "The same request was sent again with no new intent behind it. Usually a second click on a button that stays enabled while the first request is still running.",
      fix: "Disable the control while the request is in flight, or send an idempotency key so the server ignores the repeat. In guard mode GenClass can merge the repeat into the request already running." },
    stale: { name: "Stale responses", c: "--t2",
      what: "An older response arrived after newer data and was about to replace it, like results for \\u201cpa\\u201d under a search box that says \\u201cparis\\u201d.",
      fix: "Ignore responses that are no longer the latest, with an AbortController or a request counter. In guard mode GenClass can drop the stale write." },
    failing: { name: "Failing endpoints", c: "--t3",
      what: "An endpoint kept failing while the app kept calling it.",
      fix: "Back off after repeated failures and tell the user something is wrong instead of retrying in silence." },
    slow: { name: "Slow operations", c: "--t4",
      what: "An operation took far longer than it usually does on this app.",
      fix: "Check that endpoint's latency around these times, and show progress while users wait." },
    conflict: { name: "Write races", c: "--t5",
      what: "Two operations wrote the same state at about the same time, and whichever landed last won.",
      fix: "Send writes to the same field one at a time, or merge a server echo with what the user changed since." },
    transient: { name: "One-off failures", c: "--t0",
      what: "A request failed once in a way that usually succeeds on a second try.",
      fix: "Retry idempotent requests once after a short delay. In heal mode GenClass can retry them for you." },
    inconsistent: { name: "Broken state", c: "--t0",
      what: "Your state broke a rule it normally keeps, such as a cart total that no longer matches its lines.",
      fix: "Find the write that updated one of the fields without the other." },
    overload: { name: "Request storms", c: "--t0",
      what: "Work was triggered far more often than usual, often by a polling or re-render loop.",
      fix: "Debounce or deduplicate whatever triggers the requests." },
    unusual: { name: "Unusual behaviour", c: "--t0",
      what: "An operation did something different from what it normally does, such as writing fewer fields than usual.",
      fix: "Compare the operation's result with what it usually returns." }
  };
  var SLOTS = ["duplicate", "stale", "failing", "slow", "conflict"], BASE_SLOTS = SLOTS;
  var ACTIONS = { coalesce: "Merged a repeated request", discard: "Dropped a stale write", defer: "Waited for related requests", delay: "Delayed a request",
    retry: "Retried a failed request", serve_cached: "Answered from cache", block: "Blocked a request", hedge: "Sent a backup request", rollback: "Rolled back a write", resync: "Re-synced state",
    check_fix: "Fixed a measured check" };
  // a card shows the usual fix's first sentence; the copied prompts and the Markdown keep all of it
  function first(s){ var i = (s || "").search(/\\. [A-Z]/); return i < 0 ? s || "" : s.slice(0, i + 1); }
  function T(k){ return TYPES[k] || { name: k && k !== "(unknown)" ? k.charAt(0).toUpperCase() + k.slice(1) : "Other", c: "--t0", what: "", fix: "" }; }
  function slotOf(k){ return SLOTS.indexOf(k) >= 0 ? k : "other"; }
  function colorOf(slot){ return slot === "checks" ? CHK : "var(" + (slot === "other" ? "--t0" : TYPES[slot].c) + ")"; }
  function slotName(slot){ return slot === "other" ? "Other" : slot === "checks" ? "Measured checks" : TYPES[slot].name; }
  function key(color){ var s = el("span", "key"); s.style.background = color; return s; }
  function ago(iso){
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return Math.round(s) + " s ago"; if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " days ago";
  }
  function label(b, hourly){
    var d = new Date(hourly ? b + ":00:00Z" : b + "T00:00:00Z");
    return hourly ? d.toLocaleTimeString([], { hour: "numeric" }) : d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  }
  function share(a, b){ if (!b) return "-"; var r = 100 * a / b; return (r > 99.5 && a < b ? Math.floor(r * 10) / 10 : Math.round(r)) + "%"; }
  function sum(list){ return (list || []).reduce(function(s, x){ return s + x.count; }, 0); }
  function map(list){ var m = {}; (list || []).forEach(function(x){ m[x.key] = (m[x.key] || 0) + x.count; }); return m; }
  // distinct keys in the period (breakdown lists stop at their top 25)
  function count(S, m){ var d = S.distinct || {}; return d[m] != null ? d[m] : (S.breakdowns[m] || []).length; }
  function ring(color){ var s = el("span", "key ring"); s.style.borderColor = color; return s; }
  function issues(B, m){
    var out = {};
    (B[m || "detect_issue"] || []).forEach(function(x){
      var i = x.key.indexOf("\\t"); if (i < 0) return;
      var d = x.key.slice(0, i), r = x.key.slice(i + 1);
      (out[d] = out[d] || []).push({ route: r, count: x.count });
    });
    return out;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs){ var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function niceMax(v){ if (v <= 4) return 4; var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  // ---------- the tiles
  function delta(now, before){
    if (!before && !now) return "";
    if (!before) return "none in " + PREV[range];
    var d = now - before; if (!d) return "same as " + PREV[range];
    return (d > 0 ? "\\u2191 " : "\\u2193 ") + fmt(Math.abs(d)) + " vs " + PREV[range];
  }
  function stat(label0, value, sub){
    var d = el("div"); d.appendChild(el("div", "k", label0)); d.appendChild(el("div", "v", value)); if (sub) d.appendChild(el("div", "s", sub)); return d;
  }
  // the app's status: Healthy with no problems in the period; Critical when 100 or more were not fixed live, or
  // problems not fixed live reached 5% of page loads; otherwise Needs attention
  function verdict(S){
    // the measured checks count as problems too; a check fix still in place counts as fixed live
    var T0 = S.totals, n = problemsOf(S), open = Math.max(0, n - (T0.interventions || 0) - checkFixed(S)), loads = T0.sessions || 0;
    var host = document.getElementById("verdict"); if (!host) return;
    var v = !n ? ["ok", "Healthy", "No problems " + lower(RANGE[S.range])]
      : open >= 100 || (loads && open / loads >= 0.05) ? ["bad", "Critical", plural(open, "problem", "problems") + " not fixed live"]
      : ["warn", "Needs attention", open ? plural(open, "problem", "problems") + " not fixed live" : "All fixed live, not yet in the code"];
    host.classList.remove("ok", "warn", "bad"); host.classList.add(v[0]);
    document.getElementById("verdictt").textContent = v[1];
    document.getElementById("verdicts").textContent = v[2];
  }
  function tiles(S){
    var T0 = S.totals, B = S.breakdowns, host = document.getElementById("tiles"); host.textContent = "";
    var ready = T0.model_ready || 0, failed = T0.model_load_failed || 0, modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0;
    var outcomes = map(B.action_outcome), applied = outcomes.applied || T0.interventions || 0, undone = outcomes.undone || 0, prev = S.previous || {}, checks = T0.checks || 0, fixed = checkFixed(S);
    var d = delta(problemsOf(S), (prev.detections || 0) + (prev.checks || 0));
    host.appendChild(stat("Problems found", fmt(problemsOf(S)) + (S.demo ? "+" : ""), S.demo ? "detected in production" : d));
    var seenPages = count(S, "page_route");
    host.appendChild(stat("Pages affected", S.locked && S.locked.problems ? "Pro" : fmt(problemPages(S)), seenPages ? "of " + plural(seenPages, "page", "pages") : ""));
    if (S.demo) host.appendChild(stat("Fixed live", fmt(T0.interventions), ""));
    else host.appendChild(stat("Stopped by GenClass", fmt((T0.interventions || 0) + fixed), acting ? (applied ? Math.round(100 * undone / applied) + "% undone" : "") : "Observe mode"));
    host.appendChild(stat("Model loaded", share(ready, ready + failed), ready ? "average " + (T0.modelLoadAvgMs >= 1000 ? (T0.modelLoadAvgMs / 1000).toFixed(1) + " s" : fmt(T0.modelLoadAvgMs) + " ms") : ""));
  }
  // ---------- problems over time
  function trend(S){
    var host = document.getElementById("trendplot"), leg = document.getElementById("legend"), tbl = document.getElementById("trendtable");
    host.textContent = ""; leg.textContent = ""; tbl.textContent = "";
    var hourly = S.range === "24h";
    // the measured checks are one more slot, from the series (never folded into a model type or Other)
    var chk = {}; (S.series || []).forEach(function(b){ chk[b.bucket] = b.checks || 0; });
    var rows = (S.typeSeries || []).map(function(b){
      var o = { bucket: b.bucket, total: 0, parts: {} };
      Object.keys(b.counts).forEach(function(k){ var s = slotOf(k); o.parts[s] = (o.parts[s] || 0) + b.counts[k]; o.total += b.counts[k]; });
      if (chk[b.bucket]) { o.parts.checks = chk[b.bucket]; o.total += chk[b.bucket]; }
      return o;
    });
    var order = SLOTS.concat(["other", "checks"]).filter(function(s){ return rows.some(function(r){ return r.parts[s]; }); });
    var total = rows.reduce(function(s, r){ return s + r.total; }, 0);
    document.getElementById("trendn").textContent = plural(total, "problem", "problems");
    var poss = {}, ptotal = 0;
    (S.series || []).forEach(function(b){ poss[b.bucket] = b.possible || 0; ptotal += b.possible || 0; });
    if (total || ptotal) trendTable(tbl, rows, order, hourly, poss, ptotal);
    if (!total) { host.appendChild(el("p", "quiet", "No problems found in this period.")); return; }
    if (order.length > 1 || order[0] === "checks") order.forEach(function(s){ var x = el("span"); x.appendChild(key(colorOf(s))); x.appendChild(document.createTextNode(slotName(s))); leg.appendChild(x); });
    var W = 720, H = 210, PL = 30, PB = 24, PT = 6, n = rows.length, plotW = W - PL, plotH = H - PB - PT;
    var max = niceMax(Math.max.apply(null, rows.map(function(r){ return r.total; })));
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Problems found per " + (hourly ? "hour" : "day") + " by type" });
    // the measured checks' hatch (the legend's --chk, as an SVG pattern)
    var defs = svg("defs"), pat = svg("pattern", { id: "chkp", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    pat.appendChild(svg("rect", { width: 4, height: 4, fill: "var(--panel)" })); pat.appendChild(svg("rect", { width: 2, height: 4, fill: "var(--ink2)" })); defs.appendChild(pat); g.appendChild(defs);
    [0, max / 2, max].forEach(function(v){
      var y = PT + plotH - plotH * v / max;
      g.appendChild(svg("line", { x1: PL, x2: W, y1: y, y2: y, stroke: v ? "var(--grid)" : "var(--rule2)", "stroke-width": 1 }));
      if (v === Math.round(v)) { var t = svg("text", { x: PL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(v); g.appendChild(t); }
    });
    var step = plotW / n, bw = Math.max(2, Math.min(28, step * 0.64));
    var tip = el("div", "tip hidden");
    rows.forEach(function(r, i){
      var x = PL + i * step + (step - bw) / 2, y = PT + plotH, drawn = order.filter(function(s){ return r.parts[s]; });
      drawn.forEach(function(s, j){
        var h = plotH * r.parts[s] / max; y -= h;
        g.appendChild(svg("rect", { x: x, y: y, width: bw, height: Math.max(1, h), rx: j === drawn.length - 1 ? 3 : 0, fill: s === "checks" ? "url(#chkp)" : colorOf(s), stroke: "var(--paper)", "stroke-width": drawn.length > 1 ? 2 : 0, "data-slot": s }));
      });
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        var lt = svg("text", { x: PL + i * step + step / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      }
      var hit = svg("rect", { x: PL + i * step, y: PT, width: step, height: plotH, fill: "transparent", tabindex: 0 });
      function show(){
        tip.textContent = ""; tip.appendChild(el("div", "t", label(r.bucket, hourly) + ": " + plural(r.total, "problem", "problems")));
        order.forEach(function(s){ if (!r.parts[s]) return; var row = el("div", "r"); var a = el("span"); a.appendChild(key(colorOf(s))); a.appendChild(document.createTextNode(slotName(s))); row.appendChild(a); row.appendChild(el("b", null, fmt(r.parts[s]))); tip.appendChild(row); });
        tip.classList.remove("hidden");
        var box = host.getBoundingClientRect(), left = (PL + i * step + step / 2) / W * box.width;
        tip.style.left = Math.min(Math.max(0, left - 80), box.width - 170) + "px"; tip.style.top = "0px";
      }
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", function(){ tip.classList.add("hidden"); }); hit.addEventListener("blur", function(){ tip.classList.add("hidden"); });
      g.appendChild(hit);
    });
    host.appendChild(g); host.appendChild(tip);
  }
  function trendTable(tbl, rows, order, hourly, poss, ptotal){
    var tb = el("table", "dt"), hr = el("tr"); hr.appendChild(el("th", null, hourly ? "Hour" : "Day")); order.forEach(function(s){ hr.appendChild(el("th", null, slotName(s))); }); hr.appendChild(el("th", null, "Total"));
    if (ptotal) hr.appendChild(el("th", null, "Possible"));
    var th = el("thead"); th.appendChild(hr); tb.appendChild(th); var body = el("tbody");
    rows.forEach(function(r){ var tr = el("tr"); tr.appendChild(el("td", null, label(r.bucket, hourly))); order.forEach(function(s){ tr.appendChild(el("td", null, fmt(r.parts[s] || 0))); }); tr.appendChild(el("td", null, fmt(r.total))); if (ptotal) tr.appendChild(el("td", "poss-n", fmt(poss[r.bucket] || 0))); body.appendChild(tr); });
    tb.appendChild(body); var wrap = el("div", "tablewrap"); wrap.appendChild(tb); tbl.appendChild(wrap);
  }
  // ---------- possible issues over time: one series, hollow bars in the muted ink, its own axis
  function possibleTrend(S){
    var host = document.getElementById("possplot"), fig = document.getElementById("possfig"); host.textContent = "";
    var hourly = S.range === "24h", rows = (S.series || []).map(function(b){ return { bucket: b.bucket, n: b.possible || 0 }; });
    var total = rows.reduce(function(s, r){ return s + r.n; }, 0);
    document.getElementById("possn").textContent = plural(total, "possible issue", "possible issues");
    fig.classList.toggle("hidden", !total);
    if (!total) return;
    var W = 720, H = 120, PL = 30, PB = 24, PT = 6, n = rows.length, plotW = W - PL, plotH = H - PB - PT;
    var max = niceMax(Math.max.apply(null, rows.map(function(r){ return r.n; })));
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Possible issues (lower confidence) per " + (hourly ? "hour" : "day") });
    [0, max].forEach(function(v){
      var y = PT + plotH - plotH * v / max;
      g.appendChild(svg("line", { x1: PL, x2: W, y1: y, y2: y, stroke: v ? "var(--grid)" : "var(--rule2)", "stroke-width": 1 }));
      var t = svg("text", { x: PL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(v); g.appendChild(t);
    });
    var step = plotW / n, bw = Math.max(2, Math.min(28, step * 0.64)), tip = el("div", "tip hidden");
    rows.forEach(function(r, i){
      var x = PL + i * step + (step - bw) / 2;
      if (r.n) { var h = Math.max(2, plotH * r.n / max); g.appendChild(svg("rect", { x: x + 0.75, y: PT + plotH - h + 0.75, width: Math.max(1, bw - 1.5), height: h - 0.75, rx: 2, fill: "var(--panel)", stroke: "var(--ink3)", "stroke-width": 1.5 })); }
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        var lt = svg("text", { x: PL + i * step + step / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      }
      var hit = svg("rect", { x: PL + i * step, y: PT, width: step, height: plotH, fill: "transparent", tabindex: 0 });
      function show(){
        tip.textContent = ""; tip.appendChild(el("div", "t", label(r.bucket, hourly) + ": " + plural(r.n, "possible issue", "possible issues")));
        var row = el("div", "r"), a = el("span"); a.appendChild(ring("var(--ink3)")); a.appendChild(document.createTextNode("Not counted as problems")); row.appendChild(a); tip.appendChild(row);
        tip.classList.remove("hidden");
        var box = host.getBoundingClientRect(), left = (PL + i * step + step / 2) / W * box.width;
        tip.style.left = Math.min(Math.max(0, left - 80), box.width - 170) + "px"; tip.style.top = "0px";
      }
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", function(){ tip.classList.add("hidden"); }); hit.addEventListener("blur", function(){ tip.classList.add("hidden"); });
      g.appendChild(hit);
    });
    host.appendChild(g); host.appendChild(tip);
  }

  // ---------- one card per kind of problem
  function spark(S, d, check){
    var vals = ((check ? S.checkSeries : S.typeSeries) || []).map(function(b){ return b.counts[d] || 0; }), n = vals.length, max = Math.max.apply(null, vals) || 1;
    var g = svg("svg", { viewBox: "0 0 " + (n * 10) + " 24", preserveAspectRatio: "none", "class": "spark", "aria-hidden": "true" });
    g.appendChild(svg("line", { x1: 0, x2: n * 10, y1: 23.5, y2: 23.5, stroke: "var(--rule)", "stroke-width": 1 }));
    vals.forEach(function(v, i){ if (!v) return; var h = Math.max(2, 22 * v / max); g.appendChild(svg("rect", { x: i * 10 + 3, y: 23 - h, width: 4, height: h, rx: 1, fill: check ? "var(--ink2)" : colorOf(slotOf(d)) })); });
    return g;
  }
  // where a kind of problem happened: the type x page counts, else the pages of the recent rows
  function whereOf(S, k){
    var w = (issues(S.breakdowns)[k] || []).slice().sort(function(a, b){ return b.count - a.count; });
    if (w.length) return w;
    var m = {};
    (S.recent || []).forEach(function(r){ if (r.kind === "detect" && r.diagnosis === k && r.route) m[r.route] = (m[r.route] || 0) + 1; });
    return Object.keys(m).map(function(r){ return { route: r, count: m[r] }; }).sort(function(a, b){ return b.count - a.count; });
  }
  function lower(s){ return s.charAt(0).toLowerCase() + s.slice(1); }
  // page loads the agent needs: it says what to do, then waits for them itself, so nobody has to type "done"
  var WAIT = "When a step needs page loads on the dev page, tell me in one line exactly what to do there (for example: reload it and repeat the search fast), then wait for the loads yourself: check every 10 seconds (sleep 10 in a shell in between), for up to 5 minutes, instead of ending your turn.";
  // what a coding agent gets from Copy prompt for one kind of problem: what, where, the usual fix, the MCP steps
  function fixPrompt(k, n, where){
    var t = T(k), pages = where.slice(0, 4).map(function(w){ return w.route + " (" + fmt(w.count) + ")"; }).join(", ");
    var out = ["Fix a problem GenClass found in production in this web app (" + P.name + "): " + lower(t.name) + ", " + plural(n, "time", "times") + " " + lower(RANGE[range]) + (pages ? ", on " + pages : "") + ".", ""];
    if (t.what) out.push("What it means: " + t.what);
    if (t.fix) out.push("How it is usually fixed: " + t.fix);
    out.push("", "Use the GenClass MCP server (" + MCP + "; the project's MCP page in the GenClass dashboard says how to add it):",
      "1. genclass_findings, then genclass_explain on the finding that matches. " + stepFor(k, where.length ? where[0].route : "the page"),
      "   " + WAIT,
      "2. Find the code behind it and fix it; keep the regression test genclass_explain generates.",
      "3. Replay the recorded order again with genclass_replay: it must say not reproduced.",
      "4. Tell me what you changed, the test you added and the replay's verdict.");
    return out.join("\\n");
  }
  // one prompt for every kind of problem in the period, and the checks on the dev page: the loop for each (reproduce,
  // fix, prove), from one paste
  function fixAllPrompt(S){
    var list = problemList(S), checks = list.some(function(x){ return x.check; });
    var out = ["Fix the problems GenClass found in this web app (" + P.name + ") and prove each fix, with the GenClass MCP server (" + MCP + "; the project's MCP page in the GenClass dashboard says how to add it).", "", "In production, " + lower(RANGE[range]) + ":"];
    list.forEach(function(x){
      var t = infoOf(x), w = whereFor(S, x);
      out.push("- " + t.name + (x.check ? " (measured check " + x.key + ")" : "") + ", " + plural(x.count, "time", "times") + (w.length ? ", on " + w.slice(0, 3).map(function(v){ return v.route; }).join(", ") : "") + "." + (t.fix ? " Usual fix: " + t.fix : ""));
    });
    out.push("- And every " + (checks ? "other " : "") + "check genclass_findings lists from the dev page (unreadable text, a scroll lock left on, a page that stops taking clicks).", "",
      "1. genclass_status: the dev page must be connected; if it is not, tell me what to open.",
      "2. For each problem: genclass_findings, then genclass_explain; reproduce it with genclass_explore or genclass_replay. " + (checks ? "A measured check is a measurement, not a recorded order: run genclass_scan on its page instead, which lists it with the element, its selector and a suggested CSS change. " : "") + WAIT,
      "3. Fix the cause in the code, small and idiomatic; keep the regression test genclass_explain generates.",
      "4. Replay the recorded order again: it must say not reproduced." + (checks ? " For a measured check, genclass_scan on its page must no longer list it." : ""),
      "5. Sum up in one line per problem: what it was, the proof, the fix.");
    return out.join("\\n");
  }
  function fixAll(S){
    var any = problemList(S).length > 0;
    ["fixall", "fixall2"].forEach(function(id){ var b = document.getElementById(id); if (!b) return; b.classList.toggle("hidden", !any); b.setAttribute("data-copy", any ? fixAllPrompt(S) : ""); });
  }
  function promptBtn(k, n, where, cls){
    var b = el("button", cls || "btn sm ghost", "Copy prompt"); b.type = "button";
    b.setAttribute("data-copy", fixPrompt(k, n, where)); b.setAttribute("aria-label", "Copy a prompt to fix " + lower(T(k).name));
    return b;
  }
  // ---------- measured visual checks (runtime 0.3.0-beta.5, docs/runtime/VISUAL.md): deterministic measurements with
  // fixed thresholds, never a model finding. Their own kind on every view: a "Measured check" badge, a hatched key and
  // their own slot in the problems chart, their own prompt (genclass_scan measures the page again). Counts only reach the
  // dashboard: never a selector, element text, colour or URL.
  var CHECKS = {
    "image-broken": { name: "Broken images", what: "An image failed to load or decode, so visitors saw an empty box or the browser's broken-image icon.", fix: "Fix the image's URL or the file it points to, and give images that matter a fallback." },
    "image-css-broken": { name: "Broken background images", what: "A background image set in CSS answered with an error, so its element showed without it (Chromium reports these).", fix: "Fix the url() in the stylesheet or the file it points to." },
    "media-failed": { name: "Video or audio that failed", what: "A video or audio element failed with a network or decoding error, or the browser could not play its format.", fix: "Check the media URL and offer a format every browser plays." },
    "stylesheet-failed": { name: "Stylesheets that failed", what: "A stylesheet did not load (an error, or a page served instead of CSS), so part of the page was unstyled.", fix: "Fix the stylesheet's URL or what the server answers for it (status and content type)." },
    "font-failed": { name: "Fonts that failed", what: "A web font failed to load, so its text fell back to another font.", fix: "Fix the font file's URL, format or CORS headers, and keep a close fallback in font-family." },
    "icon-font-failed": { name: "Missing icons", what: "An icon font failed to load, so icons showed as empty boxes or as their names.", fix: "Fix the icon font's URL or CORS headers, or draw the icons as inline SVG." },
    "csp-blocked": { name: "Blocked by the CSP", what: "The page's Content-Security-Policy blocked a stylesheet, a font or an image the page uses.", fix: "Allow that source in the policy (style-src, font-src, img-src), or serve the file from an allowed origin." },
    "text-invisible": { name: "Invisible text", what: "Text drawn in almost its background's colour (contrast under 1.5:1) in the visitor's own colour scheme, so nobody could read it.", fix: "Set the text colour and the background together on the same selector, the dark-mode variant included. In guard mode with visual fixes on, GenClass applies a readable colour on the visitor's screen.", live: true },
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
    "pointer-events-leak": { name: "Page stopped taking clicks", what: "pointer-events: none was left on the page's html or body with nothing open, so nothing on the page responded to clicks.", fix: "Clear the click block in the same code path that sets it, failure and cancel paths included (a finally block). In guard mode with visual fixes on, GenClass removes the leaked declaration on the visitor's screen.", live: true },
    "scroll-lock-stuck": { name: "Scroll locked", what: "overflow: hidden (or a fixed body) was left on the page with no dialog or menu open, so the page stopped scrolling.", fix: "Remove the lock in the same code path that closes the dialog, menu or notice, error and cancel paths included. In guard mode with visual fixes on, GenClass removes the leaked lock on the visitor's screen.", live: true },
    "control-unreachable": { name: "Controls out of reach", what: "A button or link stayed under another element (a sticky footer, a cookie bar) even at the end of the page, so it could not be clicked.", fix: "Leave room for the fixed element (padding at the bottom of the page) or move the control out from under it." },
    "focus-obscured": { name: "Focused element hidden", what: "An element reached with the keyboard, or a link's target, ended up hidden behind a sticky header or another layer.", fix: "Add scroll-padding-top (or scroll-margin) for the sticky header, or keep the layer out of the way." },
    "dialog-covered": { name: "Dialogs under other layers", what: "A dialog opened behind another element, so parts of it, or its buttons, could not be seen or clicked.", fix: "Put the dialog above everything else: the top layer (a dialog element opened with showModal()), or a z-index above the other layer's stacking context." },
    "request-stalled": { name: "Requests that never finished", what: "A request stayed pending while a control waited on it, so visitors were stuck with a spinner or a disabled button.", fix: "Give the request a timeout (AbortSignal.timeout) and show an error with a retry when it runs out." },
    "ad-heavy": { name: "Ads covering content", what: "Ads took more of the screen than the Coalition for Better Ads standards allow, or one covered the content as an overlay.", fix: "Reserve each ad's space in the layout and keep in-content ads out of fixed overlays. GenClass reports these and leaves the ads alone." },
    "text-warped": { name: "Warped text", what: "Text on screen that could not be read as text: squeezed or stretched, overlapping other text, or its letters spread apart.", fix: "Remove the transform, letter-spacing or fixed height that distorts it, and let the text wrap." }
  };
  // what to do on the dev page so the check measures it again (the rest: load the page and use it as visitors do)
  var CHECK_DO = {
    "scroll-lock-stuck": "Open and close every dialog, menu and notice on the page, error and cancel paths included, then try to scroll.",
    "pointer-events-leak": "Run every action that blocks clicks while it works, the failing path too (a bad input, the network off), then click something.",
    "click-blocked": "Open and close the overlays on the page, then click the controls under where they were.",
    "request-stalled": "Repeat the action with the request held up (genclass_explore with slow_ms), and watch what the control does while it waits.",
    "dialog-covered": "Open each dialog on the page.",
    "focus-obscured": "Tab through the page and follow its in-page links.",
    "control-unreachable": "Scroll to the end of the page on a phone-sized window.",
    "text-invisible": "Check the page in light and dark mode, and the hover and focus states of what it names.",
    "page-overflow-x": "Load the page in a phone-sized window.",
    "viewport-meta-missing": "Load the page in a phone-sized window."
  };
  var CHK = "var(--chk)";
  function CK(k){ return CHECKS[k] || { name: k ? k.charAt(0).toUpperCase() + k.slice(1).replace(/-/g, " ") : "Other check", what: "", fix: "" }; }
  function checkList(S){ return (S.breakdowns.check_kind || []).filter(function(x){ return x.count > 0; }); }
  function checkWhere(S, k){ return (issues(S.breakdowns, "check_issue")[k] || []).slice().sort(function(a, b){ return b.count - a.count; }); }
  // check fixes still in place when their page loads ended (applied minus undone), at most one per finding
  function checkFixed(S){ var o = map(S.breakdowns.check_fix); return Math.min(S.totals.checks || 0, Math.max(0, (o.applied || 0) - (o.undone || 0))); }
  // every kind of problem in the period, the model's and the measured checks', the most frequent first
  function problemList(S){
    var out = (S.breakdowns.detect_diagnosis || []).filter(function(x){ return x.key !== "expected"; }).map(function(x){ return { key: x.key, count: x.count, check: false }; });
    checkList(S).forEach(function(x){ out.push({ key: x.key, count: x.count, check: true }); });
    return out.sort(function(a, b){ return b.count - a.count; });
  }
  function infoOf(x){ return x.check ? CK(x.key) : T(x.key); }
  function whereFor(S, x){ return x.check ? checkWhere(S, x.key) : whereOf(S, x.key); }
  function keyOf(x){ return key(x.check ? CHK : colorOf(slotOf(x.key))); }
  function problemsOf(S){ return (S.totals.detections || 0) + (S.totals.checks || 0); }
  // the pages with a problem of either kind: the model's (every one, past the top 25 too) and the checks' pages
  function problemPages(S){
    var seen = {}, n = 0;
    (S.breakdowns.detect_route || []).forEach(function(x){ if (!seen[x.key]) { seen[x.key] = 1; n++; } });
    var more = Math.max(0, count(S, "detect_route") - n);
    (S.breakdowns.check_issue || []).forEach(function(x){ var r = x.key.slice(x.key.indexOf("\\t") + 1); if (!seen[r]) { seen[r] = 1; n++; } });
    return n + more;
  }
  function badge(){ var b = el("span", "bdg", "Measured check"); b.title = "A measurement with a fixed threshold, not a model finding"; return b; }
  // what a coding agent gets from Copy prompt for one measured check: what was measured, where, the usual fix, and the
  // MCP steps that measure the page again
  function checkPrompt(k, n, where){
    var t = CK(k), pages = where.slice(0, 4).map(function(w){ return w.route + " (" + fmt(w.count) + ")"; }).join(", "), top = where.length ? where[0].route : "the page";
    var out = ["Fix a problem GenClass measured in production in this web app (" + P.name + "): " + lower(t.name) + " (the measured check " + k + "), " + plural(n, "time", "times") + " " + lower(RANGE[range]) + (pages ? ", on " + pages : "") + ".", ""];
    if (t.what) out.push("What it measured: " + t.what);
    if (t.fix) out.push("How it is usually fixed: " + t.fix);
    out.push("This is a measured check (a measurement against a fixed threshold, not a model finding): it says what was wrong on the page; the cause is in the code or the CSS.",
      "", "Use the GenClass MCP server (" + MCP + "; the project's MCP page in the GenClass dashboard says how to add it):",
      "1. genclass_scan on " + top + " (the dev server's URL, or the deployed page): it runs the same checks and lists this one with the element, its selector, what it measured and a suggested CSS change. With the dev page connected, genclass_findings lists it too, as kind check. " + (CHECK_DO[k] || "Load the page and use it as visitors do."),
      "   " + WAIT,
      "2. Find the code or CSS behind it and fix it at the cause (the suggested CSS is a starting point, not a patch).",
      "3. Run genclass_scan on the page again, after the same steps: it must not list " + k + " any more.",
      "4. Tell me what you changed and what genclass_scan listed before and after.");
    return out.join("\\n");
  }
  function checkBtn(k, n, where, cls){
    var b = el("button", cls || "btn sm ghost", "Copy prompt"); b.type = "button";
    b.setAttribute("data-copy", checkPrompt(k, n, where)); b.setAttribute("aria-label", "Copy a prompt to fix " + lower(CK(k).name));
    return b;
  }
  function problemBtn(x, where, cls){ return x.check ? checkBtn(x.key, x.count, where, cls) : promptBtn(x.key, x.count, where, cls); }
  function cards(S){
    var host = document.getElementById("issues"); host.textContent = "";
    var list = problemList(S);
    document.getElementById("issuesempty").classList.toggle("hidden", list.length > 0);
    list.forEach(function(x){
      var t = infoOf(x), c = el("article", "find" + (x.check ? " chk" : ""));
      var top = el("div", "top"), h = el("h3"); h.appendChild(keyOf(x)); h.appendChild(document.createTextNode(t.name)); if (x.check) h.appendChild(badge()); top.appendChild(h);
      var nw = el("div", "nw"); nw.appendChild(el("span", "n", fmt(x.count))); top.appendChild(nw); c.appendChild(top);
      c.appendChild(spark(S, x.key, x.check));
      var where = whereFor(S, x);
      if (where.length) {
        var ul = el("ul", "where");
        where.slice(0, 4).forEach(function(w){ var li = el("li"); li.appendChild(el("code", null, w.route)); li.appendChild(el("span", null, fmt(w.count))); ul.appendChild(li); });
        c.appendChild(ul);
      }
      if (t.fix) { var f = el("p", "fix"); f.appendChild(el("b", null, "Fix: ")); f.appendChild(document.createTextNode(first(t.fix))); c.appendChild(f); }
      var acts = el("div", "acts"); acts.appendChild(problemBtn(x, where)); c.appendChild(acts);
      host.appendChild(c);
    });
  }
  // Project overview: the kinds of problems that need attention first (Studio's advisor cards), each with its prompt
  function advisor(S){
    var host = document.getElementById("advisor"); if (!host) return; host.textContent = "";
    var list = problemList(S);
    var lead = document.getElementById("advn");
    if (lead) lead.textContent = list.length ? "Needs attention" : "No problems";
    if (!list.length) { var none = el("div", "none"); none.appendChild(el("p", null, "Nothing broke " + lower(RANGE[range]) + ".")); host.appendChild(none); return; }
    list.slice(0, 3).forEach(function(x){
      var t = infoOf(x), a = el("article"), top = el("div", "top"), h = el("h3");
      h.appendChild(keyOf(x)); h.appendChild(document.createTextNode(t.name)); if (x.check) h.appendChild(badge()); top.appendChild(h);
      top.appendChild(el("span", "bdg" + (x.count >= 10 ? " destructive" : " warning"), plural(x.count, "time", "times"))); a.appendChild(top);
      var where = whereFor(S, x);
      if (where.length) a.appendChild(el("p", "mono", where.slice(0, 2).map(function(w){ return w.route; }).join(", ")));
      var acts = el("div", "acts"), v = el("a", "btn sm ghost", "View"); v.href = "#found"; v.setAttribute("data-goto", "found");
      acts.appendChild(problemBtn(x, where)); acts.appendChild(v); a.appendChild(acts);
      host.appendChild(a);
    });
  }
  // Project overview: four usage cards (Studio's request charts), one bar per hour or day
  function usage(S){
    var host = document.getElementById("usage"); if (!host) return; host.textContent = "";
    // Problems found: the model's detections and the measured checks, per bucket and in total
    var hourly = S.range === "24h", rows = (S.series || []).map(function(b){ var o = {}; for (var k in b) o[k] = b[k]; o.problems = (b.detections || 0) + (b.checks || 0); return o; }), T0 = S.totals, prev = S.previous || {};
    var lead = document.getElementById("ulead"); if (lead) lead.textContent = fmt(T0.sessions);
    var ix = (T0.ix_sessions || 0) > 0 || rows.some(function(b){ return b.ix_sessions; });
    // the number is the period's total (exact, from the totals); the bars are the series, one per hour or day
    [["Page loads", "sessions", "var(--accent)", prev.sessions, T0.sessions], ["Problems found", "problems", "var(--t2)", typeof prev.detections === "number" ? prev.detections + (prev.checks || 0) : prev.detections, problemsOf(S)],
     ["Stepped in", "acted", "var(--accent)", prev.acted, T0.interventions],
     ix ? ["Visits", "ix_sessions", "var(--accent)", prev.ix_sessions, T0.ix_sessions] : ["Possible issues", "possible", "var(--ink3)", null, T0.possible]].forEach(function(c){
      var total = typeof c[4] === "number" ? c[4] : rows.reduce(function(s, b){ return s + (b[c[1]] || 0); }, 0), card = el("div", "ucard");
      card.appendChild(el("div", "k", c[0])); card.appendChild(el("div", "v", fmt(total)));
      card.appendChild(el("div", "d", typeof c[3] === "number" ? delta(total, c[3]) || "\\u00a0" : "\\u00a0"));
      var n = Math.max(rows.length, 1), max = Math.max.apply(null, rows.map(function(b){ return b[c[1]] || 0; }).concat([1]));
      var g = svg("svg", { viewBox: "0 0 " + (n * 10) + " 100", preserveAspectRatio: "none", role: "img", "aria-label": c[0] + " per " + (hourly ? "hour" : "day") });
      g.appendChild(svg("line", { x1: 0, x2: n * 10, y1: 99.5, y2: 99.5, stroke: "var(--rule2)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
      rows.forEach(function(b, i){
        var v = b[c[1]] || 0; if (!v) return;
        var h = Math.max(2, 96 * v / max), r = svg("rect", { x: i * 10 + 1.5, y: 99 - h, width: 7, height: h, rx: 1, fill: c[2] });
        var tt = svg("title", {}); tt.textContent = label(b.bucket, hourly) + ": " + fmt(v); r.appendChild(tt); g.appendChild(r);
      });
      card.appendChild(g);
      var ax = el("div", "ax"); ax.appendChild(el("span", null, rows.length ? label(rows[0].bucket, hourly) : "")); ax.appendChild(el("span", null, rows.length ? label(rows[rows.length - 1].bucket, hourly) : "")); card.appendChild(ax);
      host.appendChild(card);
    });
  }
  // the lower-confidence tier: its own cards (ring keys), never merged into the ones above
  function possibleCards(S){
    var B = S.breakdowns, host = document.getElementById("possible"), byIssue = issues(B, "possible_issue"); host.textContent = "";
    var list = (B.possible_diagnosis || []).filter(function(x){ return x.key !== "expected"; });
    document.getElementById("possible-s").classList.toggle("hidden", !list.length);
    list.forEach(function(x){
      var t = T(x.key), c = el("article", "find poss");
      var top = el("div", "top"), h = el("h3"); h.appendChild(ring(colorOf(slotOf(x.key)))); h.appendChild(document.createTextNode(t.name)); top.appendChild(h);
      var nw = el("div", "nw"); nw.appendChild(el("span", "n", fmt(x.count))); top.appendChild(nw); c.appendChild(top);
      var where = (byIssue[x.key] || []).slice().sort(function(a, b){ return b.count - a.count; });
      if (where.length) {
        var ul = el("ul", "where");
        where.slice(0, 4).forEach(function(w){ var li = el("li"); li.appendChild(el("code", null, w.route)); li.appendChild(el("span", null, fmt(w.count))); ul.appendChild(li); });
        c.appendChild(ul);
      }
      host.appendChild(c);
    });
  }

  // ---------- pages, actions, health
  function pages(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("pages"), byIssue = issues(B), byPoss = issues(B, "possible_issue"); host.textContent = "";
    var routes = {};
    function at(route){ return routes[route] = routes[route] || { route: route, total: 0, parts: {}, poss: 0 }; }
    Object.keys(byIssue).forEach(function(d){ byIssue[d].forEach(function(w){ var r = at(w.route); var s = slotOf(d); r.parts[s] = (r.parts[s] || 0) + w.count; r.total += w.count; }); });
    if (!Object.keys(routes).length) (B.detect_route || []).forEach(function(x){ at(x.key).total += x.count; });
    var byCheck = issues(B, "check_issue");
    Object.keys(byCheck).forEach(function(k){ byCheck[k].forEach(function(w){ var r = at(w.route); r.parts.checks = (r.parts.checks || 0) + w.count; r.total += w.count; }); });
    if (Object.keys(byPoss).length) Object.keys(byPoss).forEach(function(d){ byPoss[d].forEach(function(w){ at(w.route).poss += w.count; }); });
    else (B.possible_route || []).forEach(function(x){ at(x.key).poss += x.count; });
    var list = Object.keys(routes).map(function(k){ return routes[k]; });
    list.sort(function(a, b){ return b.total - a.total || b.poss - a.poss; });
    if (!list.length) { host.appendChild(el("p", "quiet", "No problems on any page in this period.")); return; }
    var anyPoss = list.some(function(r){ return r.poss; });
    var max = list[0].total || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Page")); hr.appendChild(el("th", "num", "Problems")); hr.appendChild(el("th", null, "By type"));
    if (anyPoss) hr.appendChild(el("th", "num", "Possible"));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 8).forEach(function(r){
      var tr = el("tr"); var rc = el("td", "route", r.route); rc.title = r.route; tr.appendChild(rc); tr.appendChild(el("td", "num", fmt(r.total)));
      var td = el("td", "wide"), mix = el("div", "mix"), parts = SLOTS.concat(["other", "checks"]).filter(function(s){ return r.parts[s]; });
      if (!parts.length && r.total) { var i0 = el("i"); i0.style.width = (100 * r.total / max) + "%"; i0.style.background = "var(--t0)"; i0.title = "Not broken down by type: " + fmt(r.total); mix.appendChild(i0); }
      parts.forEach(function(s){ var i = el("i"); i.style.width = (100 * r.parts[s] / max) + "%"; i.style.background = colorOf(s); i.title = slotName(s) + ": " + fmt(r.parts[s]); mix.appendChild(i); });
      td.appendChild(mix); tr.appendChild(td);
      if (anyPoss) tr.appendChild(el("td", "num poss-n", r.poss ? fmt(r.poss) : "-"));
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
    var notes = [], withPage = T0.detectionsWithPage;
    if (typeof withPage === "number" && T0.detections > withPage) notes.push(plural(T0.detections - withPage, "problem", "problems") + " arrived without a page.");
    var possWithPage = T0.possibleWithPage;
    if (anyPoss && typeof possWithPage === "number" && (T0.possible || 0) > possWithPage) notes.push(plural(T0.possible - possWithPage, "possible issue", "possible issues") + " arrived without a page.");
    if (typeof T0.checksWithPage === "number" && (T0.checks || 0) > T0.checksWithPage) notes.push(plural(T0.checks - T0.checksWithPage, "measured check", "measured checks") + " arrived without a page.");
    if (notes.length) host.appendChild(el("figcaption", null, notes.join(" ")));
  }
  function acted(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("acted"); host.textContent = "";
    var modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0, list = (B.intervention || []).slice(), cf = map(B.check_fix);
    // the measured checks' runtime fixes (one reversible CSS change each), counted apart from the model's actions
    if (cf.applied) { list.push({ key: "check_fix", count: cf.applied }); list.sort(function(a, b){ return b.count - a.count; }); }
    if (!list.length) {
      host.appendChild(el("p", "quiet", acting ? "Nothing to stop in this period." : "Observe mode: GenClass only reports."));
      return;
    }
    var max = list[0].count || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Action")); hr.appendChild(el("th", "num", "Times")); hr.appendChild(el("th", null, ""));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 8).forEach(function(x){
      var tr = el("tr"), name = el("td", null, ACTIONS[x.key] || x.key); if (x.key === "check_fix") name.appendChild(badge()); tr.appendChild(name); tr.appendChild(el("td", "num", fmt(x.count)));
      var td = el("td", "wide"), mix = el("div", "mix"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--accent-f)"; mix.appendChild(i); td.appendChild(mix); tr.appendChild(td);
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
    var o = map(B.action_outcome), applied = o.applied || T0.interventions || 0, notes = [];
    if (applied || !cf.applied) notes.push(plural(o.undone || 0, "change", "changes") + " undone" + (applied ? " (" + Math.round(100 * (o.undone || 0) / applied) + "%)" : "") + (o.failed ? ", " + plural(o.failed, "action", "actions") + " failed" : "") + ".");
    if (cf.applied) notes.push(plural(cf.undone || 0, "check fix", "check fixes") + " undone.");
    host.appendChild(el("figcaption", null, notes.join(" ")));
  }
  function row(dl, label0, value, sub, flag){
    dl.appendChild(el("dt", null, label0)); var dd = el("dd"), v = el("div", "v", value);
    if (flag) v.appendChild(el("span", flag[0] === "ok" ? "ok-t" : "bad-t", flag[1]));
    dd.appendChild(v); if (sub) dd.appendChild(el("div", "s", sub)); dl.appendChild(dd); return dd;
  }
  function health(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("health"); host.textContent = "";
    var dl = el("dl", "health"), ready = T0.model_ready || 0, failed = T0.model_load_failed || 0;
    var errs = (B.model_errors && B.model_errors.length) ? B.model_errors : (B.model_error_events || []);
    row(dl, "Model loads", ready + failed ? share(ready, ready + failed) + " succeeded" : "-", plural(ready, "load", "loads") + ", " + plural(failed, "failure", "failures"), (ready + failed) && failed / (ready + failed) > 0.02 ? ["bad", "needs a look"] : ready ? ["ok", "healthy"] : null);
    var be = B.backend || [], beTot = sum(be);
    row(dl, "Where it ran", be.length ? be.map(function(x){ return (x.key === "webgpu" ? "WebGPU" : x.key === "wasm" ? "WASM" : x.key) + " " + Math.round(100 * x.count / beTot) + "%"; }).join(", ") : "-", T0.modelLoadAvgMs ? "average load " + (T0.modelLoadAvgMs >= 1000 ? (T0.modelLoadAvgMs / 1000).toFixed(1) + " s" : fmt(T0.modelLoadAvgMs) + " ms") : "");
    // from the decision records that arrived: routine ones are sampled (0.3.0), so the average leans towards the rest
    var sampled = (T0.records_sampled_out || 0) + (T0.records_capped || 0) > 0;
    row(dl, "Decision time", T0.latency_ms_n ? fmt(T0.latencyAvgMs) + " ms" : "-", T0.latency_ms_n ? "average of " + plural(T0.latency_ms_n, "record", "records") + (sampled ? ", sampled" : "") : "");
    row(dl, "Ran without a decision", fmt(T0.failOpens), "", T0.failOpens ? null : ["ok", "none"]);
    var hs = T0.hidden_skipped || 0, md = T0.model_dropped || 0;
    row(dl, "Not checked", fmt(hs + md), hs + md ? [hs ? fmt(hs) + " in hidden tabs" : "", md ? fmt(md) + " over the decision rate limit" : ""].filter(Boolean).join(", ") : "", hs + md ? null : ["ok", "none"]);
    if (T0.actionLimits) row(dl, "Action limits reached", fmt(T0.actionLimits), "");
    var so = T0.records_sampled_out || 0, rc = T0.records_capped || 0, td = T0.telemetry_dropped || 0;
    if (so + rc + td) row(dl, "Records not sent", fmt(so + rc + td), [so ? fmt(so) + " routine decisions sampled out" : "", rc ? fmt(rc) + " over the per-page cap" : "", td ? fmt(td) + " dropped in the browser" : ""].filter(Boolean).join(", "));
    if (errs.length) {
      var dd = row(dl, "Load errors", plural(sum(errs), "error", "errors"), "", null), ul = el("ul");
      errs.slice(0, 4).forEach(function(x){ var li = el("li", null, fmt(x.count) + " \\u00D7 " + x.key); li.title = x.key; ul.appendChild(li); });
      dd.appendChild(ul);
    }
    // the measured checks' coverage (runtime 0.3.0-beta.5): the counts above are read against it
    var vs = map(B.visual_setting), cl = T0.check_loads || 0, tiers = map(B.check_tier);
    if (cl || vs.on || vs.local) {
      var cs = cl ? [plural(cl, "page load", "page loads") + " ran them", tiers.light ? fmt(tiers.light) + " on the light tier" : "", T0.visual_fix ? fmt(T0.visual_fix) + " with fixes on" : "", T0.check_ms ? "about " + fmt(T0.check_ms / cl) + " ms each" : ""].filter(Boolean).join(", ")
        : "Off on public hosts. Turn on with visual: true (data-visual=on).";
      row(dl, "Measured checks", T0.sessions ? share(cl, T0.sessions) + " of page loads" : fmt(cl), cs, cl ? null : ["bad", "not running"]);
    }
    var rv = B.runtime || [];
    if (rv.length) row(dl, "Runtime versions", rv.slice(0, 3).map(function(x){ return x.key; }).join(", "), rv.length > 1 ? "more than one version is live" : "");
    host.appendChild(dl);
  }
  function recent(S){
    var tb = document.getElementById("recent"); tb.textContent = "";
    (S.recent || []).forEach(function(r){
      var tr = el("tr");
      var t = el("td", null, new Date(r.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })); t.title = r.t; tr.appendChild(t);
      tr.appendChild(el("td", "route", [r.route, r.fn ? "fn " + r.fn : null].filter(Boolean).join("  ") || "-"));
      var w = el("td"), ch = el("span", "chip"); ch.appendChild(key(colorOf(slotOf(r.diagnosis)))); ch.appendChild(document.createTextNode(r.diagnosis ? T(r.diagnosis).name : (r.trigger || "-"))); w.appendChild(ch); tr.appendChild(w);
      tr.appendChild(el("td", null, typeof r.confidence === "number" ? Math.round(r.confidence * 100) + "%" : "-"));
      var did = r.kind === "acted" && r.executed && r.ran && r.ran !== "deliver" && r.ran !== "send" && r.ran !== "apply";
      tr.appendChild(el("td", did ? "did-a" : null, did ? (ACTIONS[r.ran] || r.ran) : "Reported"));
      tr.appendChild(el("td", null, r.mode || "-"));
      tb.appendChild(tr);
    });
    document.getElementById("recent0").classList.toggle("hidden", (S.recent || []).length > 0);
  }
  function advanced(S){
    var B = S.breakdowns, host = document.getElementById("adv"); host.textContent = "";
    [["Triggers", B.trigger], ["Diagnoses", B.diagnosis], ["Routes", B.route], ["Pages", B.page_route], ["Functions", B.fn],
     ["Model load states", B.model_state], ["Decision latency", B.latency_bucket], ["Fail-opens", B.fail_open], ["Modes", B.mode], ["Model versions", B.model_version],
     ["Hosts", B.host], ["Possible issues", B.possible_diagnosis], ["Action limits", B.action_limits],
     ["Measured checks", B.check_kind], ["Checks setting", B.visual_setting]].forEach(function(p){
      var c = el("div"); c.appendChild(el("h2", null, p[0]));
      if (!p[1] || !p[1].length) { c.appendChild(el("p", "empty", "None in this period.")); host.appendChild(c); return; }
      var max = Math.max.apply(null, p[1].map(function(x){ return x.count; })) || 1, ul = el("ul", "bars");
      p[1].slice(0, 10).forEach(function(x){ var li = el("li"); var k = el("span", "k", x.key); k.title = x.key; li.appendChild(k); li.appendChild(el("span", "n", fmt(x.count))); var tr = el("span", "track"); var fi = el("span", "fill"); fi.style.display = "block"; fi.style.width = Math.max(2, 100 * x.count / max) + "%"; tr.appendChild(fi); li.appendChild(tr); ul.appendChild(li); });
      c.appendChild(ul); host.appendChild(c);
    });
  }

  // ---------- interaction analytics (runtime \`interactions\` events: only apps that turned them on)
  function dur(ms){
    var s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min" + (s % 60 ? " " + (s % 60) + " s" : "");
    return (s / 3600).toFixed(1) + " h";
  }
  function pairs(list){ return (list || []).map(function(x){ var i = x.key.indexOf("\\t"); return i < 0 ? null : { route: x.key.slice(0, i), key: x.key.slice(i + 1), count: x.count }; }).filter(Boolean); }
  function ixTable(host, list, head, empty){
    host.textContent = "";
    if (!list.length) { host.appendChild(el("p", "quiet", empty)); return; }
    var max = list[0].count || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Page")); hr.appendChild(el("th", null, "Element")); hr.appendChild(el("th", "num", head)); hr.appendChild(el("th", null, ""));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 10).forEach(function(x){
      var tr = el("tr"), rc = el("td", "route", x.route); rc.title = x.route; tr.appendChild(rc);
      var kc = el("td", "route", x.key); kc.title = x.key; tr.appendChild(kc);
      tr.appendChild(el("td", "num", fmt(x.count)));
      var td = el("td", "wide"), mix = el("div", "mix"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--accent-f)"; mix.appendChild(i); td.appendChild(mix); tr.appendChild(td);
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
  }
  // a.b.c(-pre.n) older than b.c.d(-pre.n); unreadable versions are not older
  function vOlder(a, b){
    var re = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-[a-z]+\\.(\\d+))?/i, x = re.exec(a || ""), y = re.exec(b || ""), i;
    if (!x || !y) return false;
    for (i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] < +y[i];
    if (x[4] === undefined || y[4] === undefined) return x[4] !== undefined && y[4] === undefined;
    return +x[4] < +y[4];
  }
  // under the setup button: the app's runtime versions that predate analytics (they ignore analytics: true)
  function ixOld(B){
    var old = (B.runtime || []).map(function(x){ return x.key; }).filter(function(v){ return vOlder(v, "${ANALYTICS_RUNTIME}"); });
    document.getElementById("ixold").textContent = old.length ? " This app runs " + old.slice(0, 3).join(", ") + "." : "";
  }
  // a key as people read it: direct, other sites, unknown; a country code as its name
  var REGION = null; try { REGION = new Intl.DisplayNames([], { type: "region" }); } catch (e) {}
  function nice(k, country){
    if (k === "(direct)") return "Direct or unknown";
    if (k === "(other)") return "Other";
    if (k === "(unknown)") return "Unknown";
    if (country && REGION && /^[A-Z]{2}$/.test(k)) { try { return REGION.of(k) + " (" + k + ")"; } catch (e) {} }
    return k;
  }
  /** A table of keys with their count, their share of the total and a bar; the first n rows. */
  function listTable(host, list, head, unit, total, empty, n, country){
    host.textContent = "";
    if (!list || !list.length) { host.appendChild(el("p", "quiet", empty)); return; }
    var max = list[0].count || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    [head, unit, "Share", ""].forEach(function(h, i){ hr.appendChild(el("th", i === 1 || i === 2 ? "num" : null, h)); });
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, n || 10).forEach(function(x){
      var tr = el("tr"), kc = el("td", "route", nice(x.key, country)); kc.title = x.key; tr.appendChild(kc);
      tr.appendChild(el("td", "num", fmt(x.count)));
      tr.appendChild(el("td", "num", share(x.count, total)));
      var td = el("td", "wide"), mix = el("div", "mix"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--t1)"; mix.appendChild(i); td.appendChild(mix); tr.appendChild(td);
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
  }
  /** Visits per hour or day: one bar each. */
  function visitChart(host, S){
    var hourly = S.range === "24h", rows = (S.series || []).map(function(b){ return { bucket: b.bucket, n: b.ix_sessions || 0 }; });
    if (!rows.some(function(r){ return r.n; })) return;
    var W = 720, H = 130, PL = 34, PB = 24, PT = 6, n = rows.length, plotW = W - PL, plotH = H - PB - PT;
    var max = niceMax(Math.max.apply(null, rows.map(function(r){ return r.n; })));
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Visits per " + (hourly ? "hour" : "day") });
    [0, max].forEach(function(v){
      var y = PT + plotH - plotH * v / max;
      g.appendChild(svg("line", { x1: PL, x2: W, y1: y, y2: y, stroke: v ? "var(--grid)" : "var(--rule2)", "stroke-width": 1 }));
      var t = svg("text", { x: PL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(v); g.appendChild(t);
    });
    var step = plotW / n, bw = Math.max(2, Math.min(28, step * 0.64));
    rows.forEach(function(r, i){
      var x = PL + i * step + (step - bw) / 2;
      if (r.n) { var h = Math.max(2, plotH * r.n / max), b = svg("rect", { x: x, y: PT + plotH - h, width: bw, height: h, rx: 2, fill: "var(--t1)" }); var tt = svg("title", {}); tt.textContent = label(r.bucket, hourly) + ": " + plural(r.n, "visit", "visits"); b.appendChild(tt); g.appendChild(b); }
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        var lt = svg("text", { x: PL + i * step + step / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      }
    });
    var fig = el("figure", "mt-l"), plot = el("div", "plot"); plot.appendChild(g); fig.appendChild(plot);
    host.appendChild(fig);
  }
  // Free sees the totals only (src/dashboard.ts stripProblems): the problem sections give way to one banner with the
  // way to Pro, so an empty list never reads as "no problems"
  function proLock(S){
    var lock = S.locked && S.locked.problems, b = document.getElementById("prolock");
    if (b) b.classList.toggle("hidden", !lock);
    if (!lock) return;
    ["found", "possible-s", "where", "recent-s", "advisor", "adv-s", "fixall2"].forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.add("hidden"); });
    var h = document.getElementById("advn"); if (h && h.parentNode) h.parentNode.classList.add("hidden");
    var m = document.getElementById("prolockmsg"), a = document.getElementById("prolocka"), plan = lock.plan || "Pro";
    if (m) m.textContent = "Every problem, the pages it happens on, what GenClass did about it and a fix prompt for your coding agent come with " + plan + "." + (lock.trial_days ? " " + lock.trial_days + " days free, then cancel any time." : "");
    if (a) {
      if (typeof lock.upgrade_url === "string" && lock.upgrade_url.indexOf("https://") === 0) a.href = lock.upgrade_url;
      var t = a.querySelector("span"); if (t) t.textContent = lock.trial_days ? "Start your " + lock.trial_days + "-day free trial" : "Upgrade to " + plan;
    }
  }
  var IX_SECTIONS = ["clicks", "ix-sources", "ix-devices", "ix-sessions", "ix-entry", "ix-funnels"];
  function visits(S){
    var B = S.breakdowns, T0 = S.totals, views = T0.ix_views || 0, on = views > 0 || (B.ix_click || []).length > 0;
    var V = S.visits || { sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] }, nv = V.sessions || T0.ix_sessions || 0;
    // the app's plan leaves visitor analytics out (the server sent none: src/dashboard.ts stripAnalytics): the view
    // says which plan shows them, and nothing else of it is drawn
    var lock = S.locked && S.locked.analytics, lk = document.getElementById("ixlock");
    if (lk) lk.classList.toggle("hidden", !lock);
    if (lock) {
      ["ixsetup", "ixsum", "ixpages"].concat(IX_SECTIONS).forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.add("hidden"); });
      var lm = document.getElementById("ixlockmsg"), la = document.getElementById("ixlocka"), cl = document.getElementById("c-visits");
      if (lm) lm.textContent = "Visitor analytics (visits, sources, devices, funnels and clicks) " + (lock.plan ? "come with the " + lock.plan + " plan" : "are not part of this app's plan") + ". If your app has them turned on they are still counted, and the last 90 days show here once the plan includes them.";
      if (la && typeof lock.upgrade_url === "string" && lock.upgrade_url.indexOf("https://") === 0) la.href = lock.upgrade_url;
      if (cl) cl.textContent = "";
      return;
    }
    // off: the Visitors view is the setup (the copy-prompt button); on: the setup hides and every section shows
    document.getElementById("ixsetup").classList.toggle("hidden", on);
    ["ixsum", "ixpages"].forEach(function(id){ document.getElementById(id).classList.toggle("hidden", !on); });
    IX_SECTIONS.forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.toggle("hidden", !on || (!nv && /^ix-(sources|devices|entry)$/.test(id))); });
    var cv = document.getElementById("c-visits"); if (cv) cv.textContent = on ? fmt(views) : "";
    if (!on) return ixOld(B);
    var dl = el("dl", "health"), prev = (S.previous || {}).ix_views;
    row(dl, "Page views", fmt(views), typeof prev === "number" && prev ? (views >= prev ? "+" : "") + share(views - prev, prev) + " on the previous period" : "");
    row(dl, "Time on page", views ? dur((T0.ix_engaged_ms || 0) / views) : "-", "average per view");
    row(dl, "Clicks", fmt(T0.ix_click || 0), views ? (Math.round(10 * (T0.ix_click || 0) / views) / 10) + " per view" : "");
    row(dl, "Rage clicks", fmt(T0.ix_rage || 0), "", T0.ix_rage ? ["bad", "worth a look"] : ["ok", "none"]);
    row(dl, "Dead clicks", fmt(T0.ix_dead || 0), "", T0.ix_dead ? ["bad", "worth a look"] : ["ok", "none"]);
    var sumh = document.getElementById("ixsum"); sumh.textContent = ""; sumh.appendChild(dl);
    var eng = map(B.ix_engaged_ms), reach = {};
    pairs(B.ix_scroll).forEach(function(x){ (reach[x.route] = reach[x.route] || {})[x.key] = x.count; });
    var host = document.getElementById("ixpages"); host.textContent = "";
    var list = (B.ix_views || []).slice().sort(function(a, b){ return b.count - a.count; });
    if (list.length) {
      var tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
      ["Page", "Views", "Time on page", "Read half", "Read to the end"].forEach(function(h, i){ hr.appendChild(el("th", i ? "num" : null, h)); });
      hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
      list.slice(0, 12).forEach(function(x){
        var tr = el("tr"), rc = el("td", "route", x.key); rc.title = x.key; tr.appendChild(rc);
        var r = reach[x.key] || {};
        tr.appendChild(el("td", "num", fmt(x.count)));
        tr.appendChild(el("td", "num", x.count ? dur((eng[x.key] || 0) / x.count) : "-"));
        tr.appendChild(el("td", "num", share(Math.min(r["50"] || 0, x.count), x.count)));
        tr.appendChild(el("td", "num", share(Math.min(r["100"] || 0, x.count), x.count)));
        body.appendChild(tr);
      });
      tb.appendChild(body); host.appendChild(tb);
    }
    ixTable(document.getElementById("ixclicks"), pairs(B.ix_click), "Clicks", "No clicks recorded in this period.");
    var flags = pairs(B.ix_rage).map(function(x){ return { route: x.route, key: x.key + "  (rage)", count: x.count }; })
      .concat(pairs(B.ix_dead).map(function(x){ return { route: x.route, key: x.key + "  (dead)", count: x.count }; }))
      .sort(function(a, b){ return b.count - a.count; });
    ixTable(document.getElementById("ixflags"), flags, "Clicks", "No rage or dead clicks in this period.");
    // sources, campaigns
    var ns = T0.ix_sessions || nv;
    listTable(document.getElementById("ixref"), B.ix_ref, "Source", "Visits", ns, "No visits recorded in this period.", 10);
    var utm = [];
    [["source", "Source"], ["medium", "Medium"], ["campaign", "Campaign"]].forEach(function(f){ (B["ix_utm_" + f[0]] || []).slice(0, 5).forEach(function(x){ utm.push({ key: f[1] + ": " + x.key, count: x.count }); }); });
    listTable(document.getElementById("ixutm"), utm, "utm value", "Visits", ns, "No campaign visits in this period.", 15);
    // devices
    var dev = document.getElementById("ixdev"); dev.textContent = "";
    [["ix_device", "Device"], ["ix_browser", "Browser"], ["ix_os", "Operating system"], ["ix_country", "Country"], ["ix_returning", "New or returning"]].forEach(function(d){
      var box = el("div"); box.appendChild(el("h2", null, d[1])); var t = el("div"); box.appendChild(t);
      listTable(t, (B[d[0]] || []).map(function(x){ return d[0] === "ix_returning" ? { key: x.key === "new" ? "New" : "Returning", count: x.count } : x; }), d[1], "Visits", sum(B[d[0]]) || ns, "Nothing recorded.", 8, d[0] === "ix_country");
      dev.appendChild(box);
    });
    // sessions
    var se = document.getElementById("ixsess"); se.textContent = "";
    if (!nv) {
      se.appendChild(el("p", "quiet", "Visits need the newest ${RUNTIME_PKG}."));
    } else {
      var sd = el("dl", "health"), pv = (S.previous || {}).ix_sessions, ret = map(B.ix_returning);
      row(sd, "Visits", fmt(nv), typeof pv === "number" && pv ? delta(T0.ix_sessions || nv, pv) : "");
      row(sd, "Visits per day", S.range === "24h" ? fmt(nv) + " in 24 h" : fmt(nv / Math.max(1, (S.series || []).length)), "");
      row(sd, "Pages per visit", V.sessions ? (Math.round(10 * V.pages / V.sessions) / 10).toString() : "-", "");
      row(sd, "One-page visits", V.sessions ? share(V.bounces, V.sessions) : "-", "bounce rate");
      if ((ret.new || 0) + (ret.returning || 0)) row(sd, "Returning", share(ret.returning || 0, (ret.new || 0) + (ret.returning || 0)), "");
      se.appendChild(sd);
      visitChart(se, S);
    }
    listTable(document.getElementById("ixentry"), V.entry, "Page", "Visits", V.sessions, "No visits recorded in this period.", 10);
    listTable(document.getElementById("ixexit"), V.exit, "Page", "Visits", V.sessions, "No visits recorded in this period.", 10);
    funnels(S, list);
    moves(S);
  }
  // navigation paths (ANALYTICS.md section 11): entries, steps, how views were reached, first interactions, exits, paths
  var NAVS = { load: "page load", reload: "reload", back_forward: "browser back/forward (page load)", push: "in-app link", back: "in-app back", forward: "in-app forward", pop: "in-app back or forward" };
  function moves(S){
    var B = S.breakdowns, T0 = S.totals, views = T0.ix_views || 0, entries = T0.ix_entry || 0, exits = T0.ix_exit || 0;
    var arrive = (B.ix_arrive || []).filter(function(x){ return x.key.indexOf("\\t") < 0; });
    var on = entries > 0 || arrive.length > 0 || (B.ix_nav || []).length > 0;
    var sec = document.getElementById("moves"); if (sec) sec.classList.toggle("hidden", !on);
    if (!on) return;
    var am = map(arrive), hist = (am.back || 0) + (am.forward || 0) + (am.pop || 0) + (am.back_forward || 0);
    var dl = el("dl", "health");
    row(dl, "Page loads", fmt(entries), "");
    row(dl, "Steps between pages", fmt(sum(B.ix_nav || [])), entries ? (Math.round(10 * sum(B.ix_nav || []) / entries) / 10) + " per page load" : "");
    row(dl, "Back and forward", views ? share(hist, views) + " of views" : "-", arrive.length ? arrive.slice().sort(function(a, b){ return b.count - a.count; }).slice(0, 4).map(function(x){ return (NAVS[x.key] || x.key) + " " + share(x.count, views); }).join(", ") : "");
    row(dl, "Page load ends", fmt(exits), entries ? share(Math.min(exits, entries), entries) + " of page loads" : "");
    var mh = document.getElementById("ixmoves"); mh.textContent = ""; mh.appendChild(dl);
    var ph = document.getElementById("ixpaths"); ph.textContent = "";
    var paths = (B.ix_path || []).slice().sort(function(a, b){ return b.count - a.count; });
    if (paths.length) {
      var tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
      ["Path (first 5 pages)", "Page loads", ""].forEach(function(h, i){ hr.appendChild(el("th", i === 1 ? "num" : null, h)); });
      hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody"), max = paths[0].count || 1;
      paths.slice(0, 10).forEach(function(x){
        var tr = el("tr"), pc = el("td", "route", x.key); pc.title = x.key; tr.appendChild(pc);
        tr.appendChild(el("td", "num", fmt(x.count)));
        var td = el("td", "wide"), mix = el("div", "mix"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--accent-f)"; mix.appendChild(i); td.appendChild(mix); tr.appendChild(td);
        body.appendChild(tr);
      });
      tb.appendChild(body); ph.appendChild(tb);
    }
    var sh = document.getElementById("ixsteps"); sh.textContent = "";
    var gaps = map(B.ix_nav_ms), steps = pairs(B.ix_nav).sort(function(a, b){ return b.count - a.count; });
    if (steps.length) {
      var tb2 = el("table", "dt"), hd2 = el("thead"), hr2 = el("tr");
      ["From", "To", "Steps", "Time before the step"].forEach(function(h, i){ hr2.appendChild(el("th", i > 1 ? "num" : null, h)); });
      hd2.appendChild(hr2); tb2.appendChild(hd2); var body2 = el("tbody");
      steps.slice(0, 12).forEach(function(x){
        var tr = el("tr"), a = el("td", "route", x.route), b = el("td", "route", x.key); a.title = x.route; b.title = x.key; tr.appendChild(a); tr.appendChild(b);
        tr.appendChild(el("td", "num", fmt(x.count)));
        tr.appendChild(el("td", "num", x.count ? dur((gaps[x.route + "\\t" + x.key] || 0) / x.count) : "-"));
        body2.appendChild(tr);
      });
      tb2.appendChild(body2); sh.appendChild(tb2);
    }
    var xh = document.getElementById("ixexits"); xh.textContent = "";
    var vm = map(B.ix_views), em = map(B.ix_entry), xm = map(B.ix_exit), fn = map(B.ix_first_n), fms = map(B.ix_first_ms), back = {}, firsts = {};
    pairs(B.ix_arrive).forEach(function(x){ if (x.key === "back" || x.key === "forward" || x.key === "pop" || x.key === "back_forward") back[x.route] = (back[x.route] || 0) + x.count; });
    pairs(B.ix_first).forEach(function(x){ if (!firsts[x.route] || firsts[x.route].count < x.count) firsts[x.route] = x; });
    var list = (B.ix_views || []).slice().sort(function(a, b){ return b.count - a.count; });
    if (!list.length) return;
    var tb3 = el("table", "dt"), hd3 = el("thead"), hr3 = el("tr");
    ["Page", "Page loads started", "Page loads ended", "End rate", "Back/forward", "First interaction", "Time to it"].forEach(function(h, i){ hr3.appendChild(el("th", i && i !== 5 ? "num" : null, h)); });
    hd3.appendChild(hr3); tb3.appendChild(hd3); var body3 = el("tbody");
    list.slice(0, 12).forEach(function(x){
      var tr = el("tr"), rc = el("td", "route", x.key); rc.title = x.key; tr.appendChild(rc);
      tr.appendChild(el("td", "num", fmt(em[x.key] || 0)));
      tr.appendChild(el("td", "num", fmt(xm[x.key] || 0)));
      tr.appendChild(el("td", "num", share(Math.min(xm[x.key] || 0, x.count), x.count)));
      tr.appendChild(el("td", "num", share(Math.min(back[x.key] || 0, x.count), x.count)));
      var f = firsts[x.key], fc = el("td", "route", f ? f.key : "-"); if (f) fc.title = f.key + " (" + fmt(f.count) + " views)"; tr.appendChild(fc);
      tr.appendChild(el("td", "num", fn[x.key] ? dur((fms[x.key] || 0) / fn[x.key]) : "-"));
      body3.appendChild(tr);
    });
    tb3.appendChild(body3); xh.appendChild(tb3);
  }
  // ---------- funnels: the app's funnels, the visits that reached each step in order, and their editor
  var funnelsUrl = P.funnelsUrl || ("/api/projects/" + encodeURIComponent(secret) + "/funnels"), editing = false, lastS = null;
  function funnels(S, pagesByViews){
    lastS = S;
    var host = document.getElementById("ixfun"), F = S.funnels || []; host.textContent = "";
    if (!F.length && !editing) host.appendChild(el("p", "quiet", "No funnels yet."));
    F.forEach(function(f, fi){
      var box = el("div", "fun"); box.appendChild(el("h3", null, f.name));
      var first = f.counts[0] || 0, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
      ["Step", "Page", "Visits", "Of step 1", "From the step before", ""].forEach(function(h, i){ hr.appendChild(el("th", i >= 2 && i <= 4 ? "num" : null, h)); });
      hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
      f.steps.forEach(function(st, i){
        var n = f.counts[i] || 0, tr = el("tr");
        tr.appendChild(el("td", null, String(i + 1)));
        var rc = el("td", "route", st); rc.title = st; tr.appendChild(rc);
        tr.appendChild(el("td", "num", fmt(n)));
        tr.appendChild(el("td", "num", i ? share(n, first) : "-"));
        tr.appendChild(el("td", "num", i ? share(n, f.counts[i - 1] || 0) : "-"));
        var td = el("td", "wide"), mix = el("div", "mix"), b = el("i"); b.style.width = (first ? 100 * n / first : 0) + "%"; b.style.background = "var(--t1)"; mix.appendChild(b); td.appendChild(mix); tr.appendChild(td);
        body.appendChild(tr);
      });
      tb.appendChild(body); var wrap = el("div", "tablewrap"); wrap.appendChild(tb); box.appendChild(wrap);
      var drop = 0, at = -1;
      for (var i = 1; i < f.steps.length; i++) { var d = (f.counts[i - 1] || 0) - (f.counts[i] || 0); if (d > drop) { drop = d; at = i; } }
      if (at > 0) box.appendChild(el("p", "drop mt-s", "Most visits are lost between step " + at + " and step " + (at + 1) + ": " + plural(drop, "visit", "visits") + "."));
      host.appendChild(box);
    });
    var ed = document.getElementById("ixfunedit"); ed.textContent = "";
    // a member of the app's team reads the funnels; the owner edits them
    if (P.member) return;
    if (!editing) {
      var b = el("button", "btn ghost sm", F.length ? "Edit funnels" : "Add a funnel"); b.type = "button";
      b.addEventListener("click", function(){ editing = true; funnels(lastS, pagesByViews); var f0 = document.querySelector("#ixfunedit input"); if (f0) f0.focus(); });
      var acts = el("div", "mt-s"); acts.appendChild(b); ed.appendChild(acts);
      return;
    }
    var form = el("form", "funedit"); form.setAttribute("novalidate", "");
    var rows = F.length ? F.map(function(f){ return { name: f.name, steps: f.steps.join("\\n") }; })
      : [{ name: "Funnel 1", steps: (pagesByViews || []).slice(0, 3).map(function(x){ return x.key; }).join("\\n") }];
    function addRow(r){
      var fe = el("div", "fe"), nm = el("input"), ta = el("textarea"), rm = el("button", "btn ghost sm", "Remove");
      nm.type = "text"; nm.value = r.name; nm.maxLength = 60; nm.setAttribute("aria-label", "Funnel name");
      ta.value = r.steps; ta.setAttribute("aria-label", "Pages in order, one per line"); ta.placeholder = "/products/:id\\n/cart\\n/checkout"; ta.spellcheck = false;
      rm.type = "button"; rm.addEventListener("click", function(){ fe.remove(); });
      fe.appendChild(nm); fe.appendChild(ta); fe.appendChild(rm); list.appendChild(fe);
    }
    var list = el("div", "stack"); form.appendChild(el("p", "muted small", "One page per line, 2 to 6 pages. End with * to match every page under it."));
    form.appendChild(list); rows.forEach(addRow);
    var acts2 = el("div", "acts"), save = el("button", "btn green sm", "Save funnels"), add = el("button", "btn ghost sm", "Add another"), cancel = el("button", "btn ghost sm", "Cancel"), err = el("p", "err");
    save.type = "submit"; add.type = "button"; cancel.type = "button"; err.setAttribute("role", "alert");
    add.addEventListener("click", function(){ if (list.children.length < 5) addRow({ name: "Funnel " + (list.children.length + 1), steps: "" }); });
    cancel.addEventListener("click", function(){ editing = false; funnels(lastS, pagesByViews); });
    acts2.appendChild(save); acts2.appendChild(add); acts2.appendChild(cancel); form.appendChild(acts2); form.appendChild(err);
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var out = [].slice.call(list.children).map(function(fe){
        return { name: fe.querySelector("input").value, steps: fe.querySelector("textarea").value.split(/\\n+/).map(function(x){ return x.trim(); }).filter(Boolean) };
      }).filter(function(f){ return f.steps.length; });
      save.disabled = true; err.textContent = "";
      fetch(funnelsUrl, { method: "PUT", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify({ funnels: out }) })
        .then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j && j.error || "HTTP " + r.status); return j; }); })
        .then(function(){ editing = false; load(); })
        .catch(function(x){ err.textContent = "Not saved: " + x.message + "."; })
        .then(function(){ save.disabled = false; });
    });
    ed.appendChild(form);
  }

  // ---------- the closed loop, by problem: this app's problems, what the agent does with each, the shared fix, prove, ship
  var STEPS = {
    stale: function(r){ return "genclass_explore with focus on the request behind " + r + ": the same steps, its responses delivered later; genclass_replay of the stale order: reproduced. The generated test asserts the newest query's results stay."; },
    duplicate: function(r){ return "genclass_replay of the double click on " + r + "; the identical-in-flight witness names both requests. The generated test asserts one request per click."; },
    conflict: function(r){ return "genclass_explore reorders the overlapping writes on " + r + "; the overwrote-newer witness names the field. The generated test asserts the newer value stays."; },
    failing: function(r){ return "genclass_analytics local: the failure streak and p95 of the endpoint behind " + r + "; genclass_explore with slow_ms shows what the page does while it fails. The test asserts the visible error state."; },
    transient: function(r){ return "genclass_analytics local: when the endpoint behind " + r + " fails once; genclass_explore with slow_ms. The test asserts the retry and what the user sees."; },
    slow: function(r){ return "genclass_analytics local: p95 and the slow runs behind " + r + "; genclass_explore with slow_ms for what the page shows while it waits."; },
    inconsistent: function(r){ return "genclass_explore on " + r + "; the relation that broke (a count against its list) is the generated test's assertion."; },
    overload: function(r){ return "genclass_analytics local: the hot request rate on " + r + "; the generated test asserts the request count once the trigger is debounced."; }
  };
  function stepFor(k, r){ return (STEPS[k] || function(x){ return "genclass_explain on the finding from " + x + ", then genclass_replay of the recorded order; the generated test asserts what the operation normally writes."; })(r); }
  function wrapText(t, max){
    var words = String(t).split(" "), lines = [], cur = "";
    words.forEach(function(w){ if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); });
    if (cur) lines.push(cur); return lines;
  }
  function node(g, x, y, w, h, cls, title, lines, color, data){
    var r = svg("rect", { x: x, y: y, width: w, height: h, rx: 2, "class": "node" + (cls ? " " + cls : "") }); g.appendChild(r);
    if (color) g.appendChild(svg("rect", { x: x, y: y, width: 4, height: h, fill: color }));
    var t = svg("text", { x: x + 14, y: y + 20, "class": "nt" }); t.textContent = title; g.appendChild(t);
    var body = svg("text", { x: x + 14, y: y + 38, "class": "nb" });
    lines.slice(0, 5).forEach(function(l, i){ var ts = svg("tspan", { x: x + 14, dy: i ? 13.5 : 0 }); ts.textContent = l; body.appendChild(ts); });
    g.appendChild(body);
    if (data) for (var k in data) r.setAttribute("data-" + k, data[k]);
    return r;
  }
  function edge(g, d, dim){ g.appendChild(svg("path", { d: d, "class": "edge" + (dim ? " dim" : ""), "marker-end": "url(#fa)" })); }
  // which of the agent's finding kinds answer a dashboard diagnosis (the rest match any kind on the page)
  var AGENT_KINDS = { stale: ["stale-write", "race"], duplicate: ["duplicate-request"], conflict: ["race", "stale-write"], failing: ["error"], transient: ["error"], slow: ["error"], overload: ["error"] };
  function agentFor(A, k, where){
    var kinds = AGENT_KINDS[k], list = (A && A.findings) || [];
    var byKind = list.filter(function(f){ return !kinds || kinds.indexOf(f.kind) >= 0; });
    var onPage = byKind.filter(function(f){ return where.some(function(w){ return w.route === f.route; }); });
    return (onPage.length ? onPage : where.length ? [] : byKind)[0] || null;
  }
  function agentLine(f){
    if (f.proven) return "Agent: " + f.id + " on " + f.route + " reproduced, test written, fix proven " + ago(f.proven) + ".";
    var parts = [];
    if (f.found) parts.push("found " + ago(f.found));
    if (f.reproduced === true) parts.push("replay reproduced"); else if (f.reproduced === false) parts.push("replay not reproduced");
    if (f.tested) parts.push("test written");
    return "Agent: " + f.id + " on " + f.route + ": " + (parts.join(", ") || "reported") + ".";
  }
  function loop(S){
    var B = S.breakdowns, T0 = S.totals, prev = S.previous || {}, A = S.agent || null, host = document.getElementById("loopsvg"); if (!host) return;
    host.textContent = "";
    var byIssue = issues(B), recentBy = {};
    (S.recent || []).forEach(function(r){ if (r.kind === "detect" && r.diagnosis && r.route) { var m = recentBy[r.diagnosis] = recentBy[r.diagnosis] || {}; m[r.route] = (m[r.route] || 0) + 1; } });
    var list = (B.detect_diagnosis || []).filter(function(x){ return x.key !== "expected"; }).slice(0, 5);
    // Observe sits under the last problem row, and never above the bottom of Ship (its return edge would cross Prove)
    var n = Math.max(list.length, 1), R = 118, NH = 102, W = 1000, obsY = Math.max(n * R + 28, 24 + 2 * R + NH + 14), H = obsY + 72 + 8;
    host.setAttribute("viewBox", "0 0 " + W + " " + H);
    var defs = svg("defs"), m = svg("marker", { id: "fa", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    m.appendChild(svg("path", { d: "M0 0L10 5L0 10z" })); defs.appendChild(m); host.appendChild(defs);
    var g = svg("g"); host.appendChild(g);
    ["Problem", "Agent", "Every fix"].forEach(function(t, i){ var c = svg("text", { x: [0, 370, 740][i], y: 12, "class": "col" }); c.textContent = t.toUpperCase(); g.appendChild(c); });
    if (!list.length) {
      node(g, 0, 24, 300, NH, "quiet", "Nothing broke in this period", [], null, { s: "problem", k: "none" });
      node(g, 370, 24, 300, NH, "quiet", "Nothing to hand to an agent", [], null, { s: "agent", k: "none" });
      edge(g, "M300 75 H370");
    }
    list.forEach(function(x, i){
      var y = 24 + i * R, t = T(x.key), color = colorOf(slotOf(x.key));
      var where = (byIssue[x.key] || []).slice().sort(function(a, b2){ return b2.count - a.count; });
      if (!where.length && recentBy[x.key]) where = Object.keys(recentBy[x.key]).map(function(r){ return { route: r, count: recentBy[x.key][r] }; }).sort(function(a, b2){ return b2.count - a.count; });
      var pages = where.slice(0, 2).map(function(w2){ return w2.route + " (" + fmt(w2.count) + ")"; }).join(", ");
      var lines = []; if (pages) lines.push("on " + pages);
      var af = agentFor(A, x.key, where);
      if (af) wrapText(agentLine(af), 46).slice(0, 2).forEach(function(l){ lines.push(l); });
      node(g, 0, y, 300, NH, af ? "agent" : null, t.name + ": " + fmt(x.count), lines, color, { s: "problem", k: x.key, agent: af ? af.id : "" });
      var top = where.length ? where[0].route : "the page";
      node(g, 370, y, 300, NH, null, "Reproduce, then write the test", wrapText(stepFor(x.key, top), 46).slice(0, 4), null, { s: "agent", k: x.key });
      edge(g, "M300 " + (y + 51) + " H370");
      edge(g, "M670 " + (y + 51) + " C 705 " + (y + 51) + ", 705 75, 740 75");
    });
    var C = (A && A.counts) || {}, proven = ((A && A.findings) || []).filter(function(f){ return f.proven; }).sort(function(a, b2){ return b2.proven < a.proven ? -1 : 1; })[0];
    var fixLines = wrapText("Edit the code from genclass_explain's evidence.", 40);
    if (C.tested) fixLines = fixLines.concat(wrapText("Your agent wrote " + plural(C.tested, "regression test", "regression tests") + " in this period.", 40));
    node(g, 740, 24, 260, NH, null, "Fix", fixLines, null, { s: "fix" });
    var proveLines = wrapText("Replay after the fix: not reproduced.", 40);
    if (proven) proveLines = proveLines.concat(wrapText("Last fix proven: " + proven.id + " on " + proven.route + ", " + ago(proven.proven) + ".", 40));
    node(g, 740, 24 + R, 260, NH, null, "Prove", proveLines, null, { s: "prove" });
    node(g, 740, 24 + 2 * R, 260, NH, "gate", "Ship: a person decides", wrapText("Review, merge, deploy.", 40), "var(--warn)", { s: "ship" });
    edge(g, "M870 " + (24 + NH) + " V " + (24 + R)); edge(g, "M870 " + (24 + R + NH) + " V " + (24 + 2 * R));
    var d = (T0.detections || 0) - (prev.detections || 0);
    var trend = prev.detections || T0.detections ? "Problems " + (d < 0 ? "down " + fmt(-d) : d > 0 ? "up " + fmt(d) : "unchanged") + " vs " + PREV[range] + "." : "Nothing to compare with yet.";
    node(g, 0, obsY, 300, 64, "quiet", "Observe: " + plural(T0.sessions || 0, "page load", "page loads") + " watched", [plural(T0.decisions || 0, "decision", "decisions") + ".", trend], null, { s: "observe" });
    edge(g, "M870 " + (24 + 2 * R + NH) + " V " + (obsY + 32) + " H 300", true);
    var lbl = svg("text", { x: 320, y: obsY + 28, "class": "nb" }); lbl.textContent = "then this list shrinks"; g.appendChild(lbl);
    edge(g, "M150 " + obsY + " V " + (24 + (n - 1) * R + NH + 8));
    var foot = document.getElementById("loop-foot");
    if (foot) foot.textContent = A && A.last
      ? "Your agent reported " + plural(C.found || (A.findings || []).length, "finding", "findings") + " in this period, the last " + ago(A.last) + "."
      : "No agent has reported on this app in this period. Set GENCLASS_REPORT in " + MCP + " to turn reporting on.";
  }
  // ---------- the stages of the loop: how many of the period's findings reached each, and the two ways back
  var STAGES = [
    ["found", "Issue found", "Handed to the agent."],
    ["reproduced", "Reproduced", "genclass_replay shows the bug."],
    ["fixed", "Fix proven", "The replay no longer shows it."],
    ["closed", "Closed", "A test guards it."]
  ];
  function stages(S){
    var A = S.agent || {}, G = A.stages || {}, host = document.getElementById("loopstages"); if (!host) return;
    host.textContent = "";
    var on = !!(A.last || (A.log && A.log.length) || (A.findings && A.findings.length));
    var W = 1000, NW = 178, NH = 108, Y = 14, X = [0, 274, 548, 822], H = Y + NH + 76;
    host.setAttribute("viewBox", "0 0 " + W + " " + H);
    var defs = svg("defs"), m = svg("marker", { id: "fb", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    m.appendChild(svg("path", { d: "M0 0L10 5L0 10z" })); defs.appendChild(m); host.appendChild(defs);
    var g = svg("g"); host.appendChild(g);
    STAGES.forEach(function(st, i){
      var x = X[i], n = G[st[0]] || 0, cls = "node stage" + (on && n ? " on" : "") + (st[0] === "closed" && on && n ? " closed" : "") + (on ? "" : " quiet");
      var r = svg("rect", { x: x, y: Y, width: NW, height: NH, rx: 2, "class": cls, "data-stage": st[0], "data-n": on ? String(n) : "" }); g.appendChild(r);
      var t = svg("text", { x: x + 14, y: Y + 20, "class": "nt" }); t.textContent = st[1]; g.appendChild(t);
      var num = svg("text", { x: x + 14, y: Y + 54, "class": "nn" + (on ? "" : " off") }); num.textContent = on ? fmt(n) : "\u2013"; g.appendChild(num);
      var body = svg("text", { x: x + 14, y: Y + 74, "class": "nb" });
      wrapText(st[2], 27).slice(0, 3).forEach(function(l, j){ var ts = svg("tspan", { x: x + 14, dy: j ? 13.5 : 0 }); ts.textContent = l; body.appendChild(ts); });
      g.appendChild(body);
    });
    // forward: what moves an issue to the next stage
    [["replay", 0], ["fix, replay", 1], ["write test", 2]].forEach(function(e, i){
      var x1 = X[i] + NW, x2 = X[i + 1], ym = Y + NH / 2;
      g.appendChild(svg("path", { d: "M" + x1 + " " + ym + " H" + x2, "class": "edge", "marker-end": "url(#fb)" }));
      var l = svg("text", { x: (x1 + x2) / 2, y: ym - 8, "class": "el", "text-anchor": "middle" }); l.textContent = e[0]; g.appendChild(l);
    });
    // round again: a replay after a fix that still reproduces it goes back to Reproduced
    var yb = Y + NH, c1 = X[2] + NW / 2, c2 = X[1] + NW / 2;
    g.appendChild(svg("path", { d: "M" + c1 + " " + yb + " V" + (yb + 26) + " H" + c2 + " V" + (yb + 3), "class": "edge dim", "marker-end": "url(#fb)", "data-edge": "continue" }));
    var cl = svg("text", { x: (c1 + c2) / 2, y: yb + 22, "class": "el", "text-anchor": "middle" });
    cl.textContent = "still reproduces: round again" + (on ? " (" + fmt(G.continued || 0) + ")" : ""); g.appendChild(cl);
    // the loop closes: production is watched again, the next issue starts at the left
    var l1 = X[3] + NW / 2, l2 = X[0] + NW / 2;
    g.appendChild(svg("path", { d: "M" + l1 + " " + yb + " V" + (yb + 56) + " H" + l2 + " V" + (yb + 3), "class": "edge dim", "marker-end": "url(#fb)", "data-edge": "loop" }));
    var ll = svg("text", { x: (l1 + l2) / 2, y: yb + 52, "class": "el", "text-anchor": "middle" });
    ll.textContent = on ? "production is watched again \u00b7 " + plural(G.open || 0, "issue open now", "issues open now") : "production is watched again \u00b7 reporting is off (GENCLASS_REPORT)";
    g.appendChild(ll);
  }
  // ---------- the agent's log, mirrored from the MCP server
  var STEP = { found: "Found", explain: "Evidence read", armed: "Replay armed", replay: "Replay", test: "Test written", explore: "Explore", cleared: "Cleared" };
  var KINDN = { "stale-write": "stale response", race: "race", "duplicate-request": "duplicate request", error: "error", detection: "detection", check: "check", expectation: "expectation", intervention: "intervention" };
  function outcome(e){
    switch (e.t) {
      case "found": return "open";
      case "explain": return "genclass_explain: the evidence in causal order";
      case "armed": return "waiting for the next page load";
      case "replay": return e.reproduced === true ? "reproduced: the bug is still there" : e.reproduced === false ? "not reproduced: the fix holds" : "inconclusive";
      case "test": return "guards the fix";
      case "explore": return plural(e.runs || 0, "page load", "page loads") + " compared, " + plural(e.races || 0, "race", "races") + " found";
      case "cleared": return (e.what || "all") + " cleared on the developer's machine";
    }
    return "";
  }
  function agentLog(S){
    var tb = document.getElementById("agentlog"); if (!tb) return;
    tb.textContent = "";
    var log = (S.agent && S.agent.log) || [];
    log.forEach(function(e){
      var tr = el("tr"); tr.setAttribute("data-t", e.t);
      var t = el("td", null, new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })); t.title = e.at; tr.appendChild(t);
      tr.appendChild(el("td", null, STEP[e.t] || e.t));
      tr.appendChild(el("td", "mono", e.id ? e.id + (e.kind ? " \u00b7 " + (KINDN[e.kind] || e.kind) : "") : "\u2013"));
      tr.appendChild(el("td", "route", e.route || "\u2013"));
      tr.appendChild(el("td", e.t === "replay" ? (e.reproduced === false ? "did-a" : null) : e.t === "test" ? "did-a" : null, outcome(e)));
      tb.appendChild(tr);
    });
    var empty = document.getElementById("agentlog0"); if (empty) empty.classList.toggle("hidden", log.length > 0);
  }

  // ---------- Copy as Markdown: the period's numbers as a short report a person or a coding agent can read
  function markdown(S){
    var T0 = S.totals, B = S.breakdowns, out = [];
    out.push("# " + P.name + " (GenClass dashboard)", "", RANGE[S.range] + ", to " + String(S.generated).slice(0, 16).replace("T", " ") + " UTC.", "");
    out.push("| Metric | Value |", "| --- | ---: |");
    var cf = map(B.check_fix);
    [["Page loads", T0.sessions], ["Decisions", T0.decisions], ["Problems found", problemsOf(S)], ["Of them measured checks (not model findings)", T0.checks], ["Possible issues (lower confidence, not problems)", T0.possible],
     ["Pages with a problem", problemPages(S)], ["Times GenClass stepped in", T0.interventions], ["Measured checks fixed on visitors' screens", cf.applied], ["Visits", T0.ix_sessions], ["Page views", T0.ix_views]].forEach(function(r){
      if (typeof r[1] === "number") out.push("| " + r[0] + " | " + fmt(r[1]) + " |");
    });
    var list = (B.detect_diagnosis || []).filter(function(x){ return x.key !== "expected"; });
    out.push("", "## Problems by type", "");
    if (!list.length) out.push("None in this period.", "");
    list.forEach(function(x){
      var t = T(x.key), w = whereOf(S, x.key).slice(0, 4);
      out.push("### " + t.name + ": " + fmt(x.count), "");
      if (t.what) out.push(t.what, "");
      if (w.length) out.push("Pages: " + w.map(function(p){ return "\`" + p.route + "\` (" + fmt(p.count) + ")"; }).join(", "), "");
      if (t.fix) out.push("Fix: " + t.fix, "");
    });
    var cl = checkList(S);
    if (cl.length) out.push("## Measured checks by kind", "", "Measurements with fixed thresholds, not model findings: genclass_scan on the page lists each one with its element and a suggested CSS change.", "");
    cl.forEach(function(x){
      var t = CK(x.key), w = checkWhere(S, x.key).slice(0, 4);
      out.push("### " + t.name + " (" + x.key + "): " + fmt(x.count), "");
      if (t.what) out.push(t.what, "");
      if (w.length) out.push("Pages: " + w.map(function(p){ return "\`" + p.route + "\` (" + fmt(p.count) + ")"; }).join(", "), "");
      if (t.fix) out.push("Fix: " + t.fix, "");
    });
    var acts = (B.intervention || []).slice();
    if (cf.applied) acts.push({ key: "check_fix", count: cf.applied });
    if (acts.length) {
      out.push("## What GenClass did", "", "| Action | Times |", "| --- | ---: |");
      acts.slice(0, 8).forEach(function(x){ out.push("| " + (ACTIONS[x.key] || x.key) + " | " + fmt(x.count) + " |"); });
      out.push("");
    }
    var rec = (S.recent || []).slice(0, 10);
    if (rec.length) {
      out.push("## Latest detections", "", "| Time (UTC) | Page | What | Confidence | GenClass |", "| --- | --- | --- | ---: | --- |");
      rec.forEach(function(r){
        var did = r.kind === "acted" && r.executed && r.ran && r.ran !== "deliver" && r.ran !== "send" && r.ran !== "apply";
        out.push("| " + String(r.t).slice(0, 16).replace("T", " ") + " | " + (r.route || "-") + " | " + (r.diagnosis ? T(r.diagnosis).name : (r.trigger || "-")) + " | " + (typeof r.confidence === "number" ? Math.round(r.confidence * 100) + "%" : "-") + " | " + (did ? (ACTIONS[r.ran] || r.ran) : "Reported") + " |");
      });
      out.push("");
    }
    out.push("Counts only: GenClass stores no text from the app's pages. Guide: https://genclass.dev/docs/dashboard");
    return out.join("\\n");
  }

  // ---------- MCP: how a coding agent reads this project through @genclass/mcp, the agent link, the prompt
  // The agent link is the dashboard link the MCP server reads production numbers from (GENCLASS_DASHBOARD): on a
  // private link, this page's own address; in an account, one the person creates here (shown once).
  var agentLink = P.account ? null : secret === "sample" ? "sample" : location.origin + "/dashboard/" + secret;
  var CLIENTS = [["claude-code", "Claude Code"], ["cursor", "Cursor"], ["vscode", "VS Code"], ["codex", "Codex"], ["claude-desktop", "Claude Desktop"], ["windsurf", "Windsurf"], ["gemini", "Gemini CLI"]];
  var mcpOpt = { client: "claude-code", link: true, report: false };
  try { var mc = localStorage.getItem("gc.mcp.client"); if (CLIENTS.some(function(c){ return c[0] === mc; })) mcpOpt.client = mc; } catch (e) {}
  function mcpEnv(){
    var e = {};
    if (mcpOpt.link && agentLink) e.GENCLASS_DASHBOARD = agentLink;
    if (mcpOpt.report && agentLink && agentLink !== "sample") e.GENCLASS_REPORT = "on";
    return e;
  }
  function mcpName(id){ return (CLIENTS.filter(function(c){ return c[0] === id; })[0] || CLIENTS[0])[1]; }
  function mcpConfig(id){
    var env = mcpEnv(), keys = Object.keys(env), srv = { command: "npx", args: ["-y", MCP] }, priv = !!env.GENCLASS_DASHBOARD && agentLink !== "sample";
    if (keys.length) srv.env = env;
    function j(v){ return JSON.stringify(v, null, 2); }
    // where: the prompt's full instruction; at: the short label the page shows over the block
    var mine = " (your own file, so the link stays out of the repository)";
    switch (id) {
      case "claude-code": return { where: priv ? "Run it in the project folder. Without --scope the server and its link stay in your own Claude Code settings, out of .mcp.json." : "Run it in the project folder. --scope project writes .mcp.json, so everyone on the project gets the server.",
        at: priv ? "In the project folder (stays out of .mcp.json):" : "In the project folder:", code: "claude mcp add " + (priv ? "" : "--scope project ") + "genclass " + keys.map(function(k){ return "-e " + k + "=" + env[k] + " "; }).join("") + "-- npx -y " + MCP };
      case "cursor": return { where: priv ? "~/.cursor/mcp.json" + mine + ":" : ".cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project:", at: priv ? "~/.cursor/mcp.json:" : ".cursor/mcp.json:", code: j({ mcpServers: { genclass: srv } }) };
      case "vscode": return { where: priv ? "Command palette, MCP: Open User Configuration" + mine + ":" : ".vscode/mcp.json in the project:", at: priv ? "MCP: Open User Configuration:" : ".vscode/mcp.json:", code: j({ servers: { genclass: srv } }) };
      case "codex": return { where: "~/.codex/config.toml. The first start downloads the package, so allow 30 seconds:", at: "~/.codex/config.toml:", code: "[mcp_servers.genclass]\\ncommand = \\"npx\\"\\nargs = [\\"-y\\", \\"" + MCP + "\\"]\\nstartup_timeout_sec = 30" + (keys.length ? "\\n\\n[mcp_servers.genclass.env]\\n" + keys.map(function(k){ return k + " = \\"" + env[k] + "\\""; }).join("\\n") : "") };
      case "claude-desktop": return { where: "Settings, Developer, Edit Config (claude_desktop_config.json):", at: "claude_desktop_config.json:", code: j({ mcpServers: { genclass: srv } }) };
      case "windsurf": return { where: "~/.codeium/windsurf/mcp_config.json:", at: "~/.codeium/windsurf/mcp_config.json:", code: j({ mcpServers: { genclass: srv } }) };
      default: return { where: priv ? "~/.gemini/settings.json" + mine + ":" : ".gemini/settings.json in the project, or ~/.gemini/settings.json for every project:", at: priv ? "~/.gemini/settings.json:" : ".gemini/settings.json:", code: j({ mcpServers: { genclass: srv } }) };
    }
  }
  function mcpPrompt(){
    var id = mcpOpt.client, c = mcpConfig(id), prod = !!mcpEnv().GENCLASS_DASHBOARD;
    var out = ["Connect this project to GenClass through its MCP server (" + MCP + "), so you can read this app's production problems and see what happens inside its pages while you develop.", "",
      "1. Add the server to " + mcpName(id) + ". " + c.where, "", c.code, ""];
    if (prod && agentLink !== "sample") out.push("Keep the dashboard link out of files you commit: anyone with it can read this app's stats.", "");
    out.push("2. Reload " + mcpName(id) + "'s MCP servers, then call genclass_setup and add the development-only lines it prints (connectAgent in the dev build). Start the dev server and load a page.");
    out.push(prod ? "3. Call genclass_status to check that the page is connected, then genclass_analytics with source \\"production\\" for this app's numbers: page loads, problems by type and page, the latest decisions."
      : "3. Call genclass_status to check that the page is connected. Production numbers need GENCLASS_DASHBOARD, the agent link from this project's MCP page in the GenClass dashboard.");
    out.push("4. Tell me what you changed and what genclass_status" + (prod ? " and genclass_analytics" : "") + " report.");
    return out.join("\\n");
  }
  function mcpRender(host){
    host.textContent = "";
    var bar = el("div", "clients"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Coding agent");
    CLIENTS.forEach(function(c){
      var b = el("button", null, c[1]); b.type = "button"; b.setAttribute("aria-pressed", String(c[0] === mcpOpt.client));
      b.addEventListener("click", function(){ mcpOpt.client = c[0]; try { localStorage.setItem("gc.mcp.client", c[0]); } catch (e) {} mcpAll(); });
      bar.appendChild(b);
    });
    host.appendChild(bar);
    var opts = el("div", "opts");
    function opt(k, text, env, off){
      var l = el("label"), i = el("input"); i.type = "checkbox"; i.checked = !off && !!mcpOpt[k]; i.disabled = !!off; l.title = env;
      i.addEventListener("change", function(){ mcpOpt[k] = i.checked; mcpAll(); });
      l.appendChild(i); l.appendChild(document.createTextNode(text)); opts.appendChild(l);
    }
    opt("link", "Production numbers", "GENCLASS_DASHBOARD", !agentLink);
    opt("report", "Report findings", "GENCLASS_REPORT", !agentLink || agentLink === "sample");
    host.appendChild(opts);
    var c = mcpConfig(mcpOpt.client);
    host.appendChild(el("p", "where", c.at)); host.appendChild(el("pre", "code", c.code));
    if (!agentLink) host.appendChild(el("p", "warn", "No agent link yet: local pages only."));
    var acts = el("div", "acts"), cp = el("button", "btn sm", "Copy prompt"), cc = el("button", "btn sm ghost", "Copy config");
    cp.type = "button"; cc.type = "button";
    cp.setAttribute("data-copy", mcpPrompt()); cp.setAttribute("aria-label", "Copy the prompt that sets up the MCP server in " + mcpName(mcpOpt.client));
    cc.setAttribute("data-copy", c.code); cc.setAttribute("aria-label", "Copy the configuration");
    acts.appendChild(cp); acts.appendChild(cc); host.appendChild(acts);
  }
  function mcpAll(){ [].slice.call(document.querySelectorAll("[data-mcp]")).forEach(mcpRender); }
  // the agent link boxes (MCP view, Project Settings): show the link once it is known; Create makes one (account mode)
  function alinkShow(){
    // the JSON this page reads, at the agent link's API address (the link's secret is the key; the sample is open)
    var ju = document.getElementById("jsonurl");
    if (ju && agentLink) ju.textContent = "curl -s \\"" + (agentLink === "sample" ? location.origin + "/api/projects/sample" : agentLink.replace("/dashboard/", "/api/projects/")) + "?range=7d\\"";
    [].slice.call(document.querySelectorAll(".alink")).forEach(function(box){
      var out = box.querySelector(".alink-out"), code = box.querySelector(".alink-out code"), cb = box.querySelector(".alink-out [data-copy]"), st = box.querySelector(".alink-st"), b = box.querySelector("[data-mklink]");
      if (!agentLink) return;
      if (code) code.textContent = agentLink;
      if (cb) cb.setAttribute("data-copy", agentLink);
      if (out) out.classList.remove("hidden");
      if (st && P.account) st.textContent = "On. Copy it now: it is shown once.";
      if (b) { b.disabled = false; b.textContent = "New agent link"; b.setAttribute("data-on", "1"); b.removeAttribute("data-armed"); }
    });
  }
  document.addEventListener("click", function(e){
    var b = e.target && e.target.closest ? e.target.closest("[data-delproj]") : null; if (!b || !P.account) return;
    var err = b.parentNode && b.parentNode.nextElementSibling;
    // the first click asks, the second (within 6 s) deletes the project and opens the Projects page
    if (b.getAttribute("data-armed") !== "1") {
      b.setAttribute("data-armed", "1"); b.textContent = "Confirm: delete this project and its data";
      setTimeout(function(){ if (b.getAttribute("data-armed") === "1" && !b.disabled) { b.removeAttribute("data-armed"); b.textContent = "Delete project"; } }, 6000);
      return;
    }
    b.disabled = true; if (err) err.textContent = "";
    fetch("/api/account/projects/" + encodeURIComponent(P.id), { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete" }) })
      .then(function(r){ if (r.ok) { location.href = "/account?deleted=project"; return; } return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error((j && j.error) || "HTTP " + r.status); }); })
      .catch(function(x){ if (err) err.textContent = "Not deleted: " + x.message + "."; b.disabled = false; b.removeAttribute("data-armed"); b.textContent = "Delete project"; });
  });
  document.addEventListener("click", function(e){
    var b = e.target && e.target.closest ? e.target.closest("[data-mklink]") : null; if (!b || !P.account) return;
    var box = b.closest(".alink"), err = box ? box.querySelector(".err") : null;
    // a link already exists: the first click asks, the second (within 6 s) replaces it and the old one stops working
    if (b.getAttribute("data-on") === "1" && b.getAttribute("data-armed") !== "1") {
      var was = b.textContent; b.setAttribute("data-armed", "1"); b.textContent = "Confirm: the old link stops working";
      setTimeout(function(){ if (b.getAttribute("data-armed") === "1" && !b.disabled) { b.removeAttribute("data-armed"); b.textContent = was; } }, 6000);
      return;
    }
    b.disabled = true; if (err) err.textContent = "";
    makeAgentLink().catch(function(x){ if (err) err.textContent = "Not created: " + x.message + "."; b.disabled = false; b.removeAttribute("data-armed"); });
  });
  // a new agent link (auth.ts makeLink): shown on the MCP page and in Project Settings, and named by the Connect prompt
  function makeAgentLink(){
    return fetch("/api/account/projects/" + encodeURIComponent(P.id) + "/link", { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error((j && j.error) || "HTTP " + r.status); return j; }); })
      .then(function(j){ agentLink = j.dashboardUrl; mcpOpt.link = true; alinkShow(); mcpAll(); promptNow(); });
  }
  // ---------- the Connect dialog's choices: its prompt is installPrompt, the server's own function, with them
  var installPrompt = ${fnSource(installPrompt)};
  var NAMES = ${JSON.stringify(PROMPT_NAMES).replace(/</g, "\\u003c")};
  var choiceBox = document.getElementById("cchoices");
  function choiceOn(k){ var i = choiceBox && choiceBox.querySelector('[data-choice="' + k + '"]'); return !!(i && i.checked && !i.disabled); }
  function promptNow(){
    var b = document.getElementById("cpinstall"), t = document.getElementById("cpinstallt"); if (!b || !choiceBox) return;
    var p = installPrompt(P.token, P.endpoint || null, { guard: choiceOn("guard"), heal: choiceOn("heal"), badge: choiceOn("badge"), deploy: choiceOn("deploy"), agentLink: choiceOn("agent") ? agentLink : null }, NAMES);
    b.setAttribute("data-copy", p); if (t) t.value = p;
  }
  if (choiceBox) choiceBox.addEventListener("change", function(e){
    var i = e.target, k = i && i.getAttribute ? i.getAttribute("data-choice") : null, err = choiceBox.querySelector(".err"); if (!k) return;
    if (k === "guard") { var h = choiceBox.querySelector('[data-choice="heal"]'); if (h) { h.disabled = !i.checked; if (!i.checked) h.checked = false; } }
    if (k === "agent" && i.checked && !agentLink && P.account) {
      // ticking it makes the link: the first time, or a new one that replaces the app's (the label says which)
      i.disabled = true; if (err) err.textContent = "";
      makeAgentLink().then(function(){ i.disabled = false; promptNow(); }, function(x){ i.disabled = false; i.checked = false; if (err) err.textContent = "No agent link: " + x.message + "."; promptNow(); });
      return;
    }
    promptNow();
  });
  // a browser can bring boxes back with the page (back, reload), ticked or unticked; Chromium does it after load, before
  // pageshow and without a change event, and skips disabled boxes: so heal (ticked in the markup) is disabled only on
  // pageshow, when a restored unticked guard also unticks it, and the prompt follows then
  function choicesSync(){ var g0 = choiceBox.querySelector('[data-choice="guard"]'), h0 = choiceBox.querySelector('[data-choice="heal"]'); if (g0 && h0) { h0.disabled = !g0.checked; if (!g0.checked) h0.checked = false; } var a0 = choiceBox.querySelector('[data-choice="agent"]'); if (a0 && a0.checked && !agentLink) a0.checked = false; promptNow(); }
  if (choiceBox) { promptNow(); window.addEventListener("pageshow", choicesSync); }

  function render(S){
    shownS = S;
    // the recorded demo's kinds get the chart's slots while its estimate is shown (src/demo.ts), else the model's five
    SLOTS = S.demo && P.demo ? P.demo.slots : BASE_SLOTS;
    var live = !!S.lastEvent, st = document.getElementById("status"), stt = document.getElementById("statust"), hs = document.getElementById("hstatus");
    if (st) st.classList.toggle("on", live);
    if (stt) stt.textContent = live ? "Last event " + ago(S.lastEvent) : "Waiting for the first event";
    if (hs) { hs.className = "bdg " + (live ? "brand" : "warning"); if (hs.lastChild) hs.lastChild.textContent = live ? "Live" : "Waiting"; }
    // a private link has no account to poll: the Connect dialog's status line follows the stats instead
    if (!P.account) {
      var cs = document.getElementById("cstatus"), cst = document.getElementById("cstatust"), cp = document.getElementById("cpoll");
      if (cs) cs.classList.toggle("on", live);
      if (cst) cst.textContent = live ? "Connected. Last event " + ago(S.lastEvent) : "Waiting for the first event";
      if (cp) cp.classList.add("hidden");
    }
    document.getElementById("updated").textContent = "Updated " + new Date(S.generated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    document.getElementById("nodata").classList.toggle("hidden", live);
    document.getElementById("content").classList.toggle("hidden", !live);
    ["period", "mdcopy", "verdict"].forEach(function(id){ var n = document.getElementById(id); if (n) n.classList.toggle("hidden", !live); });
    if (!live) return;
    verdict(S); tiles(S); usage(S); advisor(S); fixAll(S); trend(S); possibleTrend(S); cards(S); possibleCards(S); pages(S); acted(S); health(S); stages(S); agentLog(S); loop(S); recent(S); visits(S); advanced(S); proLock(S);
    var B2 = S.breakdowns, T2 = S.totals;
    function put(id, t){ var n = document.getElementById(id); if (n) n.textContent = t; }
    put("c-trend", fmt(problemsOf(S)));
    put("c-found", String(problemList(S).length));
    put("c-pages", String(problemPages(S)));
    put("c-did", fmt((T2.interventions || 0) + (map(B2.check_fix).applied || 0)));
  }

  if (P.demo) {
    Object.keys(P.demo.types).forEach(function(k){ var t = P.demo.types[k]; TYPES[k] = { name: t.name, c: t.c, what: t.what, fix: t.fix }; STEPS[k] = function(r){ return t.step.replace("{page}", r); }; });
    Object.keys(P.demo.actions).forEach(function(k){ ACTIONS[k] = P.demo.actions[k]; });
  }
  document.getElementById("pname").textContent = P.name;
  // Views: each rail or product-menu link opens one view (the parts marked data-v with it; a part may name several);
  // the header stays. The hash names the link, so a view can be linked to and the back button works. #connect (and
  // #setup, its old name) opens the Connect dialog over the overview.
  (function(){
    var VIEW = { top: "overview", trend: "overview", usage: "overview", advisor: "overview", getc: "overview", found: "problems", "possible-s": "problems", where: "pages", did: "pages",
      "recent-s": "activity", visits: "visitors", "ix-sources": "visitors", "ix-devices": "visitors", "ix-sessions": "visitors", "ix-entry": "visitors", "ix-funnels": "visitors", clicks: "visitors", moves: "visitors",
      "health-s": "health", adv: "health", loop: "loop", mcp: "mcp", "mcp-tools": "mcp", "mcp-json": "mcp", settings: "settings", keys: "settings", delproj: "settings", forwarding: "forwarding", "export": "export" };
    // each view's title; a second entry would be a one-line description under it (none today)
    var TITLE = {
      problems: ["Problems"], pages: ["Pages and actions"], activity: ["Activity"], visitors: ["Visitors"], health: ["Health"],
      loop: ["Closed loop"], mcp: ["MCP"], settings: ["Project Settings"], forwarding: ["Integrations"], "export": ["Export"]
    };
    var PARENT = { "export": "settings" }, SCROLL = { did: 1, "possible-s": 1, "ix-sources": 1, "ix-devices": 1, "ix-sessions": 1, "ix-entry": 1, "ix-funnels": 1, clicks: 1, moves: 1, keys: 1, usage: 1, advisor: 1, getc: 1, adv: 1, "mcp-tools": 1, "mcp-json": 1, delproj: 1 };
    var links = [].slice.call(document.querySelectorAll(".snav a, .sb-pm a"));
    var parts = [].slice.call(document.querySelectorAll("[data-v]"));
    var current = null;
    function has(s, v){ return (" " + s.getAttribute("data-v") + " ").indexOf(" " + v + " ") >= 0; }
    function inRail(a){ return !!(a.closest && a.closest(".snav")); }
    function hrefOf(a){ return (a.getAttribute("href") || "").slice(1); }
    function show(id, jump){
      if (id === "connect" || id === "setup") { if (!current) show("top", false); return typeof gcModal === "function" && gcModal("m-connect", id === "setup" ? "fw" : null); }
      var v = VIEW[id];
      if (!v || !parts.some(function(s){ return has(s, v); })) return false;
      current = v;
      parts.forEach(function(s){ s.classList.toggle("vh", !has(s, v)); });
      var rv = PARENT[v] || v;
      var r = links.filter(function(a){ return inRail(a) && hrefOf(a) === id; })[0] || links.filter(function(a){ return inRail(a) && VIEW[hrefOf(a)] === rv; })[0];
      var m = links.filter(function(a){ return !inRail(a) && hrefOf(a) === id; })[0] || links.filter(function(a){ return !inRail(a) && VIEW[hrefOf(a)] === v; })[0];
      links.forEach(function(a){ a.setAttribute("aria-current", String(a === r || a === m)); });
      var t = TITLE[v], vt = document.getElementById("vtitle"), vd = document.getElementById("vdesc");
      if (vt) { vt.textContent = t ? t[0] : ""; vt.classList.toggle("hidden", !t); }
      if (vd) { vd.textContent = t && t[1] ? t[1] : ""; vd.classList.toggle("hidden", !(t && t[1])); }
      document.title = (t ? t[0] + " | " : "") + P.name + " | GenClass dashboard";
      if (document.body) document.body.classList.remove("sb-open");
      if (jump) { var tg = document.getElementById(id); if (SCROLL[id] && tg && tg.scrollIntoView) tg.scrollIntoView(); else if (window.scrollTo) window.scrollTo(0, 0); }
      return true;
    }
    function go(e, id){
      if (!show(id, true)) return;
      if (e) e.preventDefault();
      try { history.replaceState(null, "", "#" + id); } catch (x) {}
    }
    document.addEventListener("click", function(e){
      var a = e.target && e.target.closest ? e.target.closest("a[data-goto], .snav a, .sb-pm a") : null; if (!a) return;
      var id = a.getAttribute("data-goto") || (hrefOf(a) && (a.getAttribute("href") || "").charAt(0) === "#" ? hrefOf(a) : "");
      if (id) go(e, id);
    });
    window.addEventListener("hashchange", function(){ show(location.hash.slice(1), true); });
    if (!show(location.hash.slice(1), false)) show("top", false);
    gcShow = function(id){ return show(id, true); };
  })();
  mcpAll(); alinkShow();
  var mdb = document.getElementById("mdcopy");
  if (mdb) mdb.addEventListener("click", function(){ if (shownS) gcCopy(mdb, markdown(shownS), null); });
  var btn = document.getElementById("refresh");
  function load(){
    btn.disabled = true;
    return (loading = fetch(statsUrl + "?range=" + range, { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
      .then(function(r){
        if (r.status === 401 && P.account) location.href = "/login?next=" + encodeURIComponent(location.pathname);
        if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
      })
      .then(function(S){ realS = S; if (!sampling) render(S); })
      .catch(function(e){ document.getElementById("updated").textContent = "Could not load stats (" + e.message + "). Retrying in a minute."; })
      .then(function(){ btn.disabled = false; }));
  }
  document.querySelectorAll(".seg button").forEach(function(b){
    b.setAttribute("aria-pressed", String(b.getAttribute("data-r") === range));
    b.addEventListener("click", function(){
      range = b.getAttribute("data-r");
      try { localStorage.setItem("gc.dash.range", range); } catch (e) {}
      document.querySelectorAll(".seg button").forEach(function(o){ o.setAttribute("aria-pressed", String(o === b)); });
      load();
    });
  });
  btn.addEventListener("click", load);
  setInterval(function(){ if (document.visibilityState === "visible") load(); }, 60000);
  // the tour (studio.ts) walks every view: with no data yet it fills the page with the sample's stats on the way, and
  // puts back what was there at the end
  window.gcDash = {
    view: function(id){ return gcShow ? gcShow(id) : false; },
    tourStart: function(){
      // decided on this app's own stats (the last load, waited for), never on the sample a tour left on the page
      return Promise.resolve(loading).then(function(){
        if (realS && realS.lastEvent) return false;
        return fetch("/api/projects/sample?range=7d", { headers: { accept: "application/json" }, credentials: "same-origin" })
          .then(function(r){ return r.ok ? r.json() : null; })
          .then(function(S){ if (!S) return false; sampling = true; document.body.classList.add("sampling"); render(S); return true; });
      }).catch(function(){ return false; });
    },
    tourEnd: function(){
      if (gcShow) gcShow("top");
      if (!sampling) return;
      sampling = false; document.body.classList.remove("sampling"); load();
    }
  };
  load();
})();`;

// The Connect dialog's status line (account mode): it polls the account's project list every 5 s until this app's
// first batch arrives, then refreshes the page's stats (the overview's Getting started gives way to the data). The
// dialog's Copy buttons are the frame's (studio.ts, one delegated handler).
const CONNECT_JS = `
(function(){
  var P = JSON.parse(document.getElementById("project").textContent);
  var box = document.getElementById("connect"); if (!box) return;
  var st = document.getElementById("cstatus"), stt = document.getElementById("cstatust"), poll = document.getElementById("cpoll");
  // "at 14:02" today; "Oct 11, 2:02 PM" on another day, so a week-old first event does not read as this afternoon
  function when(iso){
    var d = new Date(iso), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? "at " + t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + t;
  }
  function show(p){
    if (!p || !p.last_event) { stt.textContent = "Waiting for the first event"; return false; }
    st.classList.add("on"); if (poll) poll.classList.add("hidden");
    stt.textContent = p.first_event ? "Connected. First event " + when(p.first_event) : "Connected. Last event " + when(p.last_event);
    return true;
  }
  if (show({ last_event: P.lastEvent, first_event: P.firstEvent })) return;
  var done = false;
  function tick(){
    if (done || document.visibilityState !== "visible") return;
    fetch("/api/account/projects", { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(j){
        var p = (j.projects || []).filter(function(x){ return x.id === P.id; })[0];
        if (!done && show(p)) { done = true; clearInterval(timer); var rb = document.getElementById("refresh"); if (rb) rb.click(); }
      })
      .catch(function(){ /* keep waiting; the next tick tries again */ });
  }
  var timer = setInterval(tick, 5000);
  // a hidden tab does not poll; check at once when the person comes back from their editor or terminal
  document.addEventListener("visibilitychange", tick);
})();`;

export interface DashboardOptions {
  /** This collector's own ingest URL when it is self-hosted (ownEndpoint): the snippets name it. */
  endpoint?: string | null;
  /** The origin account dashboards live on (AUTH_ORIGIN), for the link in the analytics prompt; default genclass.dev. */
  origin?: string;
  /**
   * Owned-app mode (/account/apps/<id>): the account's projects (the header's switcher), the signed-in person (the
   * account menu; the organization is named after them) and the plan's name (the organization's badge).
   */
  account?: { apps: { id: string; name: string }[]; current: string; email: string | null; plan?: string | null };
  /** The project's id (account mode). */
  id?: string;
  /**
   * Account mode: the signed-in account is a member of the app's team, not its owner (src/team.ts). The page is
   * read-only: no agent link button, no funnel editor, no Delete project (the server refuses each with a 404 anyway).
   */
  member?: boolean;
  /** When the app's first batch arrived (account mode; null while waiting). */
  firstEvent?: string | null;
  /** Account mode: whether the app's private dashboard link still opens these stats (the footer says so). */
  privateLink?: boolean;
  /**
   * Whether a @genclass/runtime that reads project keys (KEY_RUNTIME or later, any dist-tag) is on npm (RUNTIME_ON_NPM);
   * until then the Connect dialog, and the setup notes of a private-link dashboard, say so first.
   */
  runtimeReady?: boolean;
  /** Account mode: the time ranges the account's plan shows (src/plans.ts); default 24 h, 7 and 30 days. */
  ranges?: string[];
  /** Account mode: how many days the plan keeps this app's data (the footer says it); default 90. */
  keepDays?: number;
  /** Account mode: plan-dependent sections (forwarding, export; src/billing-pages.ts) and their script. */
  extra?: { html: string; script: string };
  /**
   * Account mode, locked: the account's plan has no dashboard (a plan file without it; none today). The page keeps
   * the app's key and the Connect section and links the plans; no stats are loaded.
   */
  locked?: boolean;
  /**
   * A private link (no account): its lock endpoint and whether it is protected (src/link-lock.ts). Open, the header
   * offers Protect; protected, the crumb shows a lock.
   */
  link?: { locked: boolean } | null;
}

const RANGE_LABELS: Record<string, string> = { "24h": "24 h", "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year" };
/** Short labels when a plan shows more than three ranges (five buttons fit the toolbar only this way). */
const RANGE_SHORT: Record<string, string> = { "24h": "24h", "7d": "7d", "30d": "30d", "90d": "90d", "1y": "1y" };

function rangeButtons(ranges: string[]): string {
  const short = ranges.length > 3;
  return ranges
    .map((r) => {
      const label = esc(RANGE_LABELS[r] ?? r);
      return `<button type="button" data-r="${esc(r)}" aria-pressed="${r === "7d"}"${short ? ` aria-label="${label}" title="${label}">${esc(RANGE_SHORT[r] ?? r)}` : `>${label}`}</button>`;
    })
    .join("");
}

/**
 * This collector's own ingest URL when it is not genclass.dev's: a collector self-hosted from wrangler.selfhost.toml
 * (private mode), or `wrangler dev`. Its snippets then name it, or the pages would send to genclass.dev.
 */
export function ownEndpoint(env: { DASHBOARD_ORIGIN?: string; AUTH_ORIGIN?: string }): string | null {
  const o = (env.DASHBOARD_ORIGIN || env.AUTH_ORIGIN || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s"'<>]+$/.test(o) && o !== "https://genclass.dev" ? `${o}/v1/events` : null;
}

/** The origin dashboard links use (DashboardOptions.origin, default genclass.dev). */
const ORIGIN_OF = (o: DashboardOptions): string => (o.origin ?? "https://genclass.dev").replace(/\/+$/, "");

/**
 * The organization's name in the Studio frame: an account has no name of its own, so it is named after the person,
 * as Studio names a personal organization ("ada's Org"); "Personal" when there is nothing to name it after.
 */
export function orgName(who: string | null | undefined): string {
  const base = (who ?? "").replace(/^@/, "").split("@")[0]!.trim();
  return base ? `${base}'s Org` : "Personal";
}

/**
 * The prompt the "Copy the prompt for your coding agent" buttons copy: install or upgrade the runtime, turn analytics on
 * with this app's token wherever GenClass is configured, consent, a dev-server check, and where the numbers appear.
 */
export function analyticsPrompt(token: string, where: string, endpoint: string | null = null): string {
  return [
    "Turn on GenClass visitor analytics in this web app: page views, visits, where visitors come from, devices and funnels, on the app's GenClass dashboard.",
    "",
    `1. Install or upgrade the runtime to the newest beta with the project's package manager: npm install ${RUNTIME_PKG} (or pnpm add / yarn add / bun add). 0.2.x has no analytics. If GenClass is not set up in this app yet, run npx ${RUNTIME_PKG} init --mode heal first.`,
    `2. Turn analytics on where GenClass is configured, with this app's token ${token}:`,
    `   - GenClass.init({ ... }) in code: add analytics: true, for example GenClass.init({ token: "${token}", analytics: true }).`,
    "   - The config object in genclass.config.ts or genclass.config.js (which init writes): add analytics: true to it.",
    `   - <meta name="genclass" content="..."> in the HTML head: add analytics=on, for example content="token=${token}, analytics=on".`,
    '   - The script tag (cdn.jsdelivr.net/npm/@genclass/runtime): add data-analytics="on".',
    ...(endpoint ? [`   Keep telemetry: { endpoint: "${endpoint}" } in that config: this app's collector is self-hosted.`] : []),
    '3. Consent: if the app has a cookie or consent banner, or visitors in the EU, EEA or UK, leave analytics off in the config and start them once the visitor accepts analytics: GenClass.runtime?.analytics?.start() (import { GenClass } from "@genclass/runtime"; window.GenClass.runtime with the script tag). Call .stop() if they withdraw consent.',
    "4. Run the dev server once and load a page to check the app builds and runs without errors. Local hosts (localhost, private networks) send nothing by default, so the numbers come from the deployed site, whose browser console then shows \"[GenClass] Interaction analytics are on\".",
    `5. Tell me what you changed, and that the numbers appear on ${where} about a minute after the first visits to the deployed site.`,
  ].join("\n");
}

/**
 * The prompt the Connect dialog's Framework tab copies, the whole integration from one paste: install the runtime (or
 * the script tags of a site with no build step) and start it with this project's key, the mode and overlay the dialog's
 * choices pick, the state responses write (one atom per response), the agent link for development builds, the GenClass
 * MCP server in the coding agent (with the agent link when chosen), a dev-server check, and a deploy when chosen.
 * Pure, and it names nothing outside its arguments: the page script runs this same function (its source) when a
 * choice changes, so the server's prompt and the dialog's stay one text.
 */
export function installPrompt(token: string, endpoint: string | null = null, c: InstallChoices = {}, n: PromptNames = PROMPT_NAMES): string {
  const guard = !!c.guard;
  const heal = guard && !!c.heal;
  const mode = heal ? "heal" : guard ? "guard" : "";
  const badge = !!c.badge;
  const link = c.agentLink || "";
  // GenClass.init has automatic state discovery off unless asked (autoState: true, with the discover import first)
  const init = [`token: "${token}"`, "autoState: true"];
  if (mode) init.push(`mode: "${mode}"`, "visual: { on: true, fix: true }");
  if (endpoint) init.push(`telemetry: { endpoint: "${endpoint}" }`);
  // the script tag carries the mode, the visual fixes and the overlay; a self-hosted collector's endpoint, which it
  // cannot carry, goes in GENCLASS_CONFIG
  const cfg = endpoint ? [`telemetry: { endpoint: "${endpoint}" }`] : [];
  const tag = `<script src="${n.cdn}" data-token="${token}"${mode ? ` data-mode="${mode}" data-visual="fix"` : ""}${badge ? " data-devtools" : ' data-devtools="local"'}></script>`;
  const local = '["localhost", "127.0.0.1"].includes(location.hostname)';
  const out = [
    "Add GenClass to this web app with its project key, so the app's GenClass dashboard shows what breaks for its users in production (double submits, stale responses, failing endpoints, write races), and so you, the coding agent, can see what happens on the dev pages, replay it and prove fixes. Do every step yourself.",
    "",
    `1. Install the runtime with the project's package manager: npm install ${n.pkg} (or pnpm add / yarn add / bun add ${n.pkg}). A site with no build step (plain HTML pages, no bundler) installs nothing: it uses the script tags below.`,
    `2. Start it as early as possible, with this project's key ${token}. With a bundler, in the browser entry (main.ts, the root layout or the root component), with the discover import first, before React, Redux or Zustand load:`,
    '   import "@genclass/runtime/discover"; // first: lets GenClass find React, Redux and Zustand state',
    '   import { GenClass } from "@genclass/runtime";',
    `   const rt = GenClass.init({ ${init.join(", ")} });`,
    "   Without a bundler, in the <head> of every HTML page, before the page's own scripts:",
    ...(cfg.length ? [`   <script>window.GENCLASS_CONFIG = { ${cfg.join(", ")} };</script>`] : []),
    `   ${tag}`,
    "   and in the page's scripts the handle (rt below) is GenClass.runtime.",
    `   The key is public: it can only add telemetry to this app, so it belongs in front-end code. (With a bundler, npx ${n.pkg} init --token ${token}${mode ? ` --mode ${mode}` : ""} --yes does steps 1 and 2 and shows the diff.)`,
    (heal
      ? "3. Mode heal, as chosen on the dashboard: when GenClass is sure, it acts with minimal steps that it logs: it drops a stale response, merges or blocks a duplicate submit, fixes a CSS bug on the page, retries a failed request or serves its cached answer, hedges a slow call, and rolls back a bad write or asks your store to resync; discards and rollbacks can be undone, and a breaker steps the mode down after repeated undos."
      : guard
        ? "3. Mode guard, as chosen on the dashboard: when GenClass is sure, it acts with minimal, reversible steps (it drops a stale response or fixes a CSS bug on the page) and never changes a response."
        : "3. Mode observe, as chosen on the dashboard: GenClass reports and never changes what the app does.") +
      (badge
        ? ' Mount the devtools overlay on every host, the deployed site too, as chosen on the dashboard, so visitors see what GenClass does: import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt)); (the script tag\'s data-devtools does the same).'
        : ' In development builds also mount the devtools overlay, which shows what GenClass sees on the page: if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt)); (Next.js: process.env.NODE_ENV === "development"; the script tag\'s data-devtools="local" does the same).'),
    '4. Connect the state that responses write (search results, carts, lists, forms), so GenClass sees each write with the response or click that caused it. React state, Redux stores (configureStore, or createStore with the Redux DevTools compose) and Zustand stores made with the devtools middleware are found automatically (the discover import with autoState: true above; the script tag and init\'s /auto import do it by default); otherwise create it with rt.atom("name", initial) or wrap the store you have with rt.guard("name", { get, set }), and write through the handle. Values one response writes together (a search\'s query and its results) go in one atom, written once per response, so GenClass can drop a stale response as one write: const search = rt.atom("search", { query: "", results: [] }); then search.set((s) => ({ ...s, query: data.q, results: data.results })) and render from search.subscribe.',
    '5. Development builds only, add the agent link: import { connectAgent } from "@genclass/runtime/agent"; if (import.meta.env.DEV) connectAgent(rt); (Next.js: process.env.NODE_ENV === "development"). It records what happens on local pages for the GenClass MCP server and is never part of a production build.',
    `   Without a bundler, after the runtime's script tag: <script type="module">if (${local}) import("${n.agent}").then((a) => { const go = () => (GenClass.runtime ? a.connectAgent(GenClass.runtime) : setTimeout(go, 50)); go(); });</script>`,
    link
      ? `6. Add the GenClass MCP server to yourself with this project's agent link, in your own settings rather than a file in the repository (anyone with the link can read this app's stats). Claude Code: claude mcp add genclass -e GENCLASS_DASHBOARD=${link} -e GENCLASS_REPORT=on -- npx -y ${n.mcp} (other agents: npx -y ${n.mcp} config <client> prints the block; add those two env values to it). GENCLASS_REPORT=on mirrors what you find, replay and prove to the dashboard's Loop view. Its tools: genclass_status, genclass_findings, genclass_explain, genclass_replay, genclass_explore, genclass_scan, genclass_analytics.`
      : `6. Add the GenClass MCP server to yourself: npx -y ${n.mcp} init writes .mcp.json for Claude Code (npx -y ${n.mcp} config <client> prints the block for Cursor, VS Code, Codex, Gemini CLI and others); then reload your MCP servers. Its tools: genclass_status, genclass_findings, genclass_explain, genclass_replay, genclass_explore, genclass_scan.`,
    "7. Run the dev server and load a page to check that the app builds and runs without errors; genclass_status lists a dev page once you load it with the MCP server running (a new MCP server loads in your next conversation). Local hosts (localhost, private networks) send nothing to the dashboard by default, so the first production events come from the deployed site.",
    ...(c.deploy
      ? ["8. Deploy it, as chosen on the dashboard, with the command this project already uses (a deploy script in package.json, wrangler deploy for a Cloudflare Worker, vercel deploy --prod, and so on), then check that the deployed site serves the change."]
      : []),
    `${c.deploy ? 9 : 8}. Tell me what you changed${c.deploy ? " and where it is deployed" : ""}, and that a new conversation with you has the GenClass tools.`,
  ];
  return out.join("\n");
}

/** One big primary button that copies analyticsPrompt, and one short line under it. */
function promptBlock(token: string, where: string, endpoint: string | null, sub: string): string {
  const prompt = analyticsPrompt(token, where, endpoint);
  return `<div class="cprompt"><button class="btn green xl" type="button" data-copy="${esc(prompt)}" aria-label="Copy the prompt for your coding agent">Copy prompt</button><p class="cp-sub">${sub}</p><textarea class="cp-text" readonly hidden aria-label="The prompt, to copy by hand" rows="8">${esc(prompt)}</textarea></div>`;
}

interface ConnectOptions {
  token: string;
  /** Account mode: the CLI's login and the status line that polls. */
  account: boolean;
  runtimeReady: boolean;
  endpoint: string | null;
  /** The analytics tab's copy-prompt block (promptBlock). */
  analytics: string;
  /** The MCP tab (the page script renders it; the locked page has no script for it). Default true. */
  mcp?: boolean;
  /**
   * The choices above the prompt (guard with heal, both ticked when the page loads, the badge on every host, the agent
   * link, deploy), which the dashboard's page script turns into the prompt; none on the locked page, whose prompt
   * keeps the ticked defaults. `agent`: the agent link choice, and whether choosing it replaces a link the app already
   * has (account mode), or names this private link (private mode).
   */
  choices?: { agent: "new" | "replace" | "this" | null };
}

/**
 * The Connect section (Studio's Connect dialog): a status line, then tabs. Framework: a prompt for a coding agent and
 * the ways in (the CLI: login in an account, init with the key on a private link; or the key pasted into code, a script
 * tag or a meta tag). API Keys: the project key. MCP: the agent's MCP server (rendered by the page script). Analytics:
 * the analytics prompt. Every snippet is server-rendered, in both modes.
 */
function connectSection(c: ConnectOptions): string {
  const { token, endpoint } = c;
  const t = esc(token);
  // a self-hosted collector's endpoint goes in GenClass.init or window.GENCLASS_CONFIG (a meta tag may only name
  // same-origin URLs, src/cdn/config.ts)
  const ep = endpoint ? `, telemetry: { endpoint: "${endpoint}" }` : "";
  const cfg = (o: string) => `<script>window.GENCLASS_CONFIG = { ${o}telemetry: { endpoint: "${endpoint}" } };</script>`;
  const init = `import { GenClass } from "@genclass/runtime";\n\nGenClass.init({ token: "${token}", mode: "heal"${ep} });`;
  const tag = `${endpoint ? `${cfg("")}\n` : ""}<script src="${CDN_SCRIPT}" data-token="${token}" data-mode="heal"></script>`;
  const meta = endpoint
    ? `<!-- in your HTML <head> -->\n${cfg(`token: "${token}", `)}\n\n// in your entry file\nimport "@genclass/runtime/auto/heal";`
    : `<meta name="genclass" content="token=${token}">\n\n// in your entry file\nimport "@genclass/runtime/auto/heal";`;
  let n = 0;
  const snip = (label: string, name: string, code: string) => {
    const id = `csnip${++n}`;
    return `<div><div class="sh"><span>${label}</span><button class="btn sm ghost" type="button" data-copy="${esc(code)}" data-target="${id}" aria-label="Copy ${name}">Copy</button></div><pre class="code" id="${id}" tabindex="0" aria-label="${esc(label)}">${esc(code)}</pre></div>`;
  };
  const notYet = c.runtimeReady
    ? ""
    : `<p class="cnote" id="cnote"><b>Not on npm yet.</b> Project keys need @genclass/runtime ${KEY_RUNTIME}, which is not published yet.</p>`;
  const d = DEFAULT_CHOICES;
  const install = installPrompt(token, endpoint, d);
  const ch = c.choices;
  const opt = choiceOpt;
  const agentNote = !ch?.agent ? "" : ch.agent === "this" ? "uses this private link" : ch.agent === "replace" ? "replaces the agent link" : "makes an agent link";
  const choices = ch
    ? `<div class="copts" id="cchoices" role="group" aria-label="What the prompt sets up">
  ${opt("guard", "Guard", "fixes what it is sure of", { on: d.guard })}
  ${opt("heal", "Heal", "With Guard: the heal mode, which also blocks a repeat, retries a failed request or serves its cached answer, hedges a slow call, and rolls back a bad write or asks your store to resync (0.59% wrong interventions on held-out simulated apps, 0.00% on real, model 0.2.0)", { sub: true, on: d.heal })}
  ${opt("badge", "Badge on the live site", "overlay on every host")}
  ${ch.agent ? opt("agent", "Connect my agent to production", agentNote) : ""}
  ${opt("deploy", "Deploy when done", "")}
  <p class="err" role="alert"></p>
</div>`
    : "";
  const ask = `${choices}<div class="cprompt"><button class="btn green xl" type="button" id="cpinstall" data-copy="${esc(install)}" aria-label="Copy the prompt for your coding agent">Copy prompt</button><p class="cp-sub">Paste it into your coding agent.</p><textarea class="cp-text" id="cpinstallt" readonly hidden aria-label="The prompt, to copy by hand" rows="8">${esc(install)}</textarea></div>`;
  // the terminal: login in an account (it picks this project), init with the key on a private link; neither for a
  // self-hosted collector (the CLI makes its tokens at genclass.dev)
  const cli = endpoint
    ? ""
    : `<div class="way">
      <div class="eb">Terminal</div>
      ${c.account ? snip("In the app's folder", "the login command", `npx ${RUNTIME_PKG} login`) : snip("In the app's folder", "the setup command", setupCommand(token))}
    </div>`;
  const ways = `<div class="ways">
    ${cli}
    <div class="way">
      <div class="eb">${endpoint ? "Add the key and this collector's endpoint" : "Or add the key"}</div>
      ${snip("In code", "the init code", init)}
      ${snip("Script tag", "the script tag", tag)}
      ${snip(endpoint ? "With a bundler" : "Meta tag, with a bundler", endpoint ? "the bundler setup" : "the meta tag", meta)}
    </div>
  </div>`;
  const key = `<div class="kval"><code id="ckey">${t}</code><button class="btn sm ghost" type="button" data-copy="${t}" data-target="ckey" aria-label="Copy the project API key">Copy</button></div>`;
  const tab = (id: string, label: string, on: boolean) =>
    `<button type="button" role="tab" id="tab-${id}" aria-controls="tp-${id}" aria-selected="${on}"${on ? "" : ' tabindex="-1"'}>${label}</button>`;
  return `<section class="connect" id="connect" aria-labelledby="connect-h">
  ${notYet}
  <p class="cstat" id="cstatus" aria-live="polite"><i></i><span id="cstatust">Waiting for the first event</span></p>
  <div class="sb-tabs" role="tablist" aria-label="Ways to connect">${tab("fw", "Framework", true)}${tab("keys", "API Keys", false)}${c.mcp === false ? "" : tab("mcp", "MCP", false)}${c.analytics ? tab("ana", "Analytics", false) : ""}</div>
  <div class="tabp on" role="tabpanel" id="tp-fw" aria-labelledby="tab-fw">
  ${ask}
  ${ways}
  <p class="fine">Local hosts do not send by default.<span id="cpoll"> Checking every 5 seconds.</span></p>
  </div>
  <div class="tabp" role="tabpanel" id="tp-keys" aria-labelledby="tab-keys">
  <div class="keyrow">
    <div class="k">Project API key</div>
    ${key}
    <p class="kn">Safe to use in front-end code.</p>
  </div>
  </div>
  ${
    c.mcp === false
      ? ""
      : `<div class="tabp" role="tabpanel" id="tp-mcp" aria-labelledby="tab-mcp">
  <div class="mcpc" data-mcp></div>
  <p class="fine"><a class="lnk" href="#mcp" data-goto="mcp" data-close>Open the MCP page</a></p>
  </div>`
  }
  ${
    c.analytics
      ? `<div class="tabp" role="tabpanel" id="tp-ana" aria-labelledby="tab-ana">
  <div class="cana"><div class="eb">Visitor analytics</div>${c.analytics}</div>
  <p class="fine" id="canalytics">Needs @genclass/runtime ${ANALYTICS_RUNTIME} or later.</p>
  </div>`
      : ""
  }
</section>`;
}

/** The Connect section in Studio's dialog (opened by the header's Connect button, #connect, Getting started). */
function connectDialog(c: ConnectOptions): string {
  return `<div class="sb-modal" id="m-connect" role="dialog" aria-modal="true" aria-labelledby="connect-h"><div class="sb-mbox">
<div class="sb-mh"><div><h2 id="connect-h">Connect to your project</h2></div><button class="sb-x" type="button" data-close aria-label="Close">${icon("x", 16)}</button></div>
<div class="sb-mb">${connectSection(c)}</div></div></div>`;
}

/**
 * The agent link box (MCP and Project Settings): the dashboard link the MCP server reads production numbers from.
 * Account mode: none yet, or one made before (kept only as a hash); Create makes one and shows it once. A private
 * link is its own agent link; the page script fills it in.
 */
function agentAccess(acct: boolean, privateLink: boolean, member = false): string {
  const out =
    '<div class="alink-out hidden"><div class="kval"><code></code><button class="btn sm ghost" type="button" data-copy="" aria-label="Copy the agent link">Copy</button></div></div>';
  if (!acct)
    return `<div class="alink"><div class="keyrow"><div class="k">Agent link</div><div class="kval"><span class="alink-st">This page's address</span></div>
<p class="kn">Keep it private.</p></div>${out}</div>`;
  // a member of the app's team: the link is the owner's to make
  if (member)
    return `<div class="alink"><div class="keyrow"><div class="k">Agent link</div><div class="kval"><span class="alink-st">The app's owner makes it.</span></div></div></div>`;
  return `<div class="alink"><div class="keyrow"><div class="k">Agent link</div><div class="kval"><span class="alink-st">${privateLink ? "On" : "None yet."}</span></div>
<p class="kn">Read only. Keep it private.</p></div>
${out}<div class="row"><button class="btn sm" type="button" data-mklink${privateLink ? ' data-on="1"' : ""}>${privateLink ? "New agent link" : "Create agent link"}</button></div><p class="err" role="alert"></p></div>`;
}

/** What the MCP server gives a coding agent (packages/mcp/src/tools.ts), for the MCP view's table. */
const MCP_TOOLS: [string, string][] = [
  ["genclass_analytics", "Production and local numbers"],
  ["genclass_findings", "What broke on local pages"],
  ["genclass_explain", "One finding in causal order, with a test"],
  ["genclass_explore", "Re-runs with the network reordered"],
  ["genclass_replay", "Replays one exact order"],
  ["genclass_status", "Connected pages"],
  ["genclass_setup", "The dev-build setup lines"],
  ["genclass_clear", "Forgets what was recorded"],
];

/** The MCP view: connect a coding agent (client, options, configuration, prompt), the agent link, the tools, the data. */
function mcpView(acct: boolean, privateLink: boolean, member = false): string {
  return `<div id="mcp" data-v="mcp" data-tour="74|Your coding agent|Connect Claude Code or Codex so it can read these problems and fix them." data-tour-view="mcp">
<section class="blk">
  <div class="blk-h"><h2>Connect your agent</h2><span class="aside">${MCP_PKG}</span></div>
  <div class="mcpc" data-mcp></div>
</section>
<section class="blk" id="mcp-access">
  <div class="blk-h"><h2>Agent access</h2><span class="aside">GENCLASS_DASHBOARD</span></div>
  ${agentAccess(acct, privateLink, member)}
</section>
<section class="blk" id="mcp-tools">
  <div class="blk-h"><h2>Tools</h2><span class="aside">${MCP_TOOLS.length}</span></div>
  <div class="tablewrap"><table class="dt tools-t"><thead><tr><th>Tool</th><th>Does</th></tr></thead><tbody>
  ${MCP_TOOLS.map(([n, d]) => `<tr><td>${n}</td><td>${esc(d)}</td></tr>`).join("\n  ")}
  </tbody></table></div>
</section>
<section class="blk" id="mcp-json">
  <div class="blk-h"><h2>JSON</h2><span class="aside">Read only</span></div>
  <pre class="code" id="jsonurl">${member ? "Ask the app's owner for the agent link." : "Create an agent link first."}</pre>
</section>
</div>`;
}

export function dashboardPage(
  nonce: string,
  project: { name: string; token: string; created: string; lastEvent: string | null },
  opts: DashboardOptions = {},
): string {
  const acct = opts.account;
  if (acct && opts.locked) return lockedDashboardPage(nonce, project, { ...opts, account: acct });
  const waiting = !project.lastEvent;
  // a member of the app's team (never without an account): the owner-only controls are left out
  const member = !!acct && opts.member === true;
  const owner = !!acct && !!opts.id && !member;
  const base = acct
    ? { ...project, id: opts.id, firstEvent: opts.firstEvent ?? null, statsUrl: `/api/account/projects/${opts.id}/stats`, funnelsUrl: `/api/account/projects/${opts.id}/funnels`, account: true, ...(member ? { member: true } : {}), ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) }
    : opts.endpoint
      ? { ...project, endpoint: opts.endpoint }
      : project;
  const demo = demoData(project.name);
  // the recorded demo's project (src/demo.ts): its stats come with the estimate; the page needs the kinds' names
  const data = demo ? { ...base, demo: { types: demo.types, actions: demo.actions, slots: demo.slots } } : base;
  const t = esc(project.token);
  const keep = opts.keepDays ?? 90;
  const where = acct && opts.id ? `this app's GenClass dashboard, under Visitors (${ORIGIN_OF(opts)}/account/apps/${opts.id}#visits)` : "this app's GenClass dashboard (the private link I opened it from), under Visitors";
  // what a new app's dashboard says first: the same one command as /start/<secret> (a self-hosted collector has no CLI)
  const firstStep = opts.endpoint
    ? `<div><b>Add the key</b></div><button class="btn sm" type="button" data-open="m-connect" data-tab="fw">Connect</button>`
    : `<div class="minw0"><b>Install</b><div class="cmdbox"><code id="ncmd">${esc(setupCommand(project.token))}</code><button class="btn sm" type="button" data-copy="${esc(setupCommand(project.token))}" data-target="ncmd" aria-label="Copy the command">Copy</button></div></div><button class="btn sm ghost" type="button" data-open="m-connect" data-tab="fw">Other ways</button>`;
  const connect = connectDialog({
    token: project.token,
    account: !!acct,
    runtimeReady: opts.runtimeReady === true,
    endpoint: opts.endpoint ?? null,
    analytics: promptBlock(project.token, where, opts.endpoint ?? null, "Paste it into your coding agent."),
    choices: { agent: member ? null : acct ? (opts.privateLink ? "replace" : "new") : "this" },
  });
  const settings = `<div id="settings" data-v="settings" data-tour="78|Settings|Your project key, links, and the rest." data-tour-view="settings">
<section class="blk">
  <div class="blk-h"><h2>General</h2></div>
  <div class="keyrow"><div class="k">Project name</div><div class="kval"><span>${esc(project.name)}</span></div></div>
  ${acct && opts.id ? `<div class="keyrow"><div class="k">Project ID</div><div class="kval"><code id="sid">${esc(opts.id)}</code><button class="btn sm ghost" type="button" data-copy="${esc(opts.id)}" data-target="sid" aria-label="Copy the project ID">Copy</button></div></div>` : ""}
  <div class="keyrow"><div class="k">Created</div><div class="kval"><span>${project.created ? esc(project.created.slice(0, 10)) : "-"}</span></div></div>
  <div class="keyrow"><div class="k">Data kept</div><div class="kval"><span id="keep">${keep >= 365 ? "1 year" : `${keep} days`}</span></div></div>
  <div class="keyrow"><div class="k">Owner</div><div class="kval"><span>${member ? "Your team's owner" : acct ? esc(orgName(acct.email)) : "Private link"}</span>${acct ? "" : '<a class="btn sm ghost" href="/login?next=%2Faccount%3Fclaim%3D1">Add to an account</a>'}</div></div>
</section>
<section class="blk" id="keys">
  <div class="blk-h"><h2>API keys</h2></div>
  <div class="keyrow"><div class="k">Project key</div><div class="kval"><code id="skey">${t}</code><button class="btn sm ghost" type="button" data-copy="${t}" data-target="skey" aria-label="Copy the project key">Copy</button></div>
  <p class="kn">Safe to use in front-end code. <button class="lnk" type="button" data-open="m-connect" data-tab="fw">How to add it</button></p></div>
</section>
<section class="blk">
  <div class="blk-h"><h2>Agent access</h2><span class="aside">For @genclass/mcp</span></div>
  ${agentAccess(!!acct, !!opts.privateLink, member)}
</section>
${
  owner
    ? `<section class="blk" id="delproj">
  <div class="blk-h"><h2>Delete project</h2><span class="aside">Cannot be undone</span></div>
  <p class="poss-note">Deletes ${esc(project.name)} and all its data.</p>
  <div class="row mt-s"><button class="btn danger" type="button" data-delproj>Delete project</button></div><p class="err" role="alert"></p>
</section>`
    : ""
}
</div>`;
  // the rail (Studio's project navigation), the product menus of the views with sub-pages, the command menu's extras
  const rail: RailItem[][] = [
    [{ href: "#top", label: "Project overview", icon: "home", count: "c-trend" }],
    [
      { href: "#found", label: "Problems", icon: "alert", count: "c-found" },
      { href: "#where", label: "Pages", icon: "file", count: "c-pages" },
      { href: "#did", label: "Actions", icon: "shield", count: "c-did" },
      { href: "#recent-s", label: "Activity", icon: "list" },
    ],
    [
      { href: "#visits", label: "Visitors", icon: "pointer", count: "c-visits", id: "nav-visits" },
      { href: "#health-s", label: "Health", icon: "heart" },
    ],
    [
      { href: "#mcp", label: "MCP", icon: "bot" },
      { href: "#loop", label: "Closed loop", icon: "loop" },
      ...(opts.extra ? [{ href: "#forwarding", label: "Integrations", icon: "blocks" } as RailItem] : []),
    ],
  ];
  const menus: ProductMenu[] = [
    {
      title: "Problems",
      view: "problems pages",
      groups: [
        { label: "Found", items: [{ href: "#found", label: "Problems found" }, { href: "#possible-s", label: "Possible issues" }] },
        { label: "Where", items: [{ href: "#where", label: "Pages" }, { href: "#did", label: "Actions" }] },
      ],
    },
    {
      title: "Visitors",
      view: "visitors",
      groups: [
        {
          label: "Analytics",
          items: [
            { href: "#visits", label: "Overview" },
            { href: "#ix-sessions", label: "Sessions" },
            { href: "#ix-sources", label: "Sources" },
            { href: "#ix-devices", label: "Devices" },
            { href: "#ix-entry", label: "Entry and exit pages" },
            { href: "#ix-funnels", label: "Funnels" },
          ],
        },
        { label: "Behaviour", items: [{ href: "#clicks", label: "Clicks" }, { href: "#moves", label: "Navigation" }] },
      ],
    },
    {
      title: "Project Settings",
      view: "settings forwarding export",
      groups: [
        { label: "Configuration", items: [{ href: "#settings", label: "General" }, { href: "#keys", label: "API keys" }] },
        ...(opts.extra ? [{ label: "Data", items: [{ href: "#forwarding", label: "Integrations" }, { href: "#export", label: "Export" }] }] : []),
        ...(owner ? [{ label: "Danger zone", items: [{ href: "#delproj", label: "Delete project" }] }] : []),
      ],
    },
  ];
  const body = `
<script type="application/json" id="project">${embed(data)}</script>
<div class="sb-page" id="mc" tabindex="-1">
<header class="phead" id="top">
  <div class="minw0">
    <h1 id="pname" data-v="overview"></h1>
    <div class="verdict hidden" id="verdict" data-v="overview" role="status" data-tour="50|At a glance|Your app's health in one line." data-tour-view="top"><i></i><b id="verdictt"></b><span id="verdicts"></span></div>
    <h1 id="vtitle" class="hidden"></h1>
    <p id="vdesc" class="hidden"></p>
    <div class="ov-meta" data-v="overview"><span class="live" id="status"><i></i><span id="statust">Loading</span></span><span>Project key <code>${t}</code></span></div>
  </div>
  <div class="tools" data-v="overview problems pages activity visitors health loop"><span id="updated"></span><div id="period"${waiting ? ' class="hidden"' : ""} data-tour="56|Time range|Look at the last day, week or month." data-tour-view="top"><div class="seg" role="group" aria-label="Time range">${rangeButtons(opts.ranges ?? ["24h", "7d", "30d"])}</div></div><button class="btn sm ghost" id="refresh" type="button">Refresh</button><button class="btn sm ghost hidden" id="mdcopy" type="button" aria-label="Copy this period as Markdown" data-tour="58|Share a report|Copy this period as a short report for your team or your agent." data-tour-view="top">Copy as Markdown</button></div>
</header>
${connect}
<section id="nodata" class="blk first hidden" data-v="overview problems pages activity visitors health loop">
  <h2>Connect your app</h2>
  <ol class="steps">
    <li><span class="no">1</span>${firstStep}</li>
    <li><span class="no">2</span><div><b>Deploy and load a page</b><span>Local hosts do not send by default.</span></div><span class="bdg warning"><i></i>Waiting</span></li>
    <li><span class="no">3</span><div><b>Connect your agent</b></div><a class="btn sm ghost" href="#mcp" data-goto="mcp">Set up MCP</a></li>
    <li><span class="no">4</span><div><b>Turn on analytics</b></div><button class="btn sm ghost" type="button" data-open="m-connect" data-tab="ana">Copy prompt</button></li>
  </ol>
</section>
<div id="content" class="hidden">
<div class="prolock hidden" id="prolock"><div class="minw0"><b>Free shows the totals</b><p id="prolockmsg"></p></div><a class="btn" id="prolocka" href="/account/billing"><span>Start your free trial</span></a></div>
<div class="ovtop" data-v="overview">
  <div class="minw0">
    <div class="statrow" id="tiles" data-tour="52|Key numbers|Problems found, pages affected, and what GenClass stopped." data-tour-view="top"></div>
  </div>
  <section class="blk" id="trend" data-tour="54|Problems over time|One bar per day, split by type. Hover a bar for details." data-tour-view="top">
    <div class="blk-h"><h2>Problems found</h2><span class="aside" id="trendn"></span></div>
    <figure>
      <div class="legend" id="legend"></div>
      <div class="plot" id="trendplot"></div>
    </figure>
    <figure class="poss-fig hidden" id="possfig">
      <div class="poss-h"><h3>Possible issues</h3><span class="aside" id="possn"></span></div>
      <div class="plot" id="possplot"></div>
    </figure>
    <details class="more"><summary>Table view</summary><div id="trendtable" class="mt-s"></div></details>
  </section>
</div>
<div class="uh" data-v="overview"><h2><b id="ulead"></b> page loads</h2></div>
<div class="usage" id="usage" data-v="overview"></div>
<div class="uh" data-v="overview"><h2>Get connected</h2></div>
<div class="getc" id="getc" data-v="overview">
  <button type="button" data-open="m-connect" data-tab="fw">${icon("plug", 18)}<div><b>Install GenClass</b></div></button>
  <a href="#mcp" data-goto="mcp">${icon("bot", 18)}<div><b>Connect your agent</b></div></a>
  <button type="button" data-open="m-connect" data-tab="ana">${icon("pointer", 18)}<div><b>Turn on analytics</b></div></button>
</div>
<div class="uh" data-v="overview"><h2 id="advn">Needs attention</h2><div class="acts"><button class="btn sm hidden" type="button" id="fixall2" data-copy="" aria-label="Copy one prompt for your coding agent to fix every problem">Fix all</button><a class="btn sm ghost" href="#found" data-goto="found">All problems</a></div></div>
<div class="adv" id="advisor" data-v="overview" data-tour="60|Needs attention|The problems to fix first, each with a prompt for your coding agent." data-tour-view="advisor"></div>
<section class="blk" id="found" data-v="problems" data-tour="62|Problems|Every kind of problem, where it happened, and how to fix it." data-tour-view="found">
  <div class="blk-h"><h2>Problems found</h2><button class="btn sm hidden" type="button" id="fixall" data-copy="" aria-label="Copy one prompt for your coding agent to fix every problem">Fix all</button></div>
  <div class="finds" id="issues"></div>
  <p class="quiet hidden" id="issuesempty">No problems in this period.</p>
</section>
<section class="blk hidden" id="possible-s" data-v="problems">
  <div class="blk-h"><h2>Possible issues</h2><span class="aside">Lower confidence</span></div>
  <div class="finds" id="possible"></div>
</section>
<div class="two" id="where" data-v="pages" data-tour="64|Pages|Which pages have problems, worst first." data-tour-view="where">
  <section class="blk"><div class="blk-h"><h2>Pages</h2></div><div id="pages"></div></section>
  <section class="blk" id="did" data-tour="66|Actions|Where GenClass stepped in, and what it did." data-tour-view="did"><div class="blk-h"><h2>Actions</h2></div><div id="acted"></div></section>
</div>
<section class="blk" id="health-s" data-v="health" data-tour="72|Health|Is GenClass running well on your visitors' devices." data-tour-view="health-s">
  <div class="blk-h"><h2>Health</h2></div>
  <div id="health"></div>
</section>
<section class="blk" id="adv-s" data-v="health">
  <div class="blk-h"><h2>All breakdowns</h2><span class="aside">Top 10 each</span></div>
  <div class="kv" id="adv"></div>
</section>
<section class="blk" id="recent-s" data-v="activity" data-tour="68|Activity|The latest detections, newest first." data-tour-view="recent-s">
  <div class="blk-h"><h2>Recent activity</h2><span class="aside">Latest 50</span></div>
  <div class="tablewrap"><table class="dt"><thead><tr><th>Time</th><th>Page / function</th><th>What</th><th class="num">Confidence</th><th>GenClass</th><th>Mode</th></tr></thead>
  <tbody id="recent"></tbody></table></div>
  <p class="quiet hidden" id="recent0">Nothing detected in this period.</p>
</section>
<section class="blk" id="visits" data-v="visitors" data-tour="70|Visitors|Visits, sources, devices and funnels." data-tour-view="visits">
  <div class="blk-h"><h2>Overview</h2></div>
  <div id="ixlock" class="hidden"><p class="quiet" id="ixlockmsg"></p><p class="mt-l"><a class="btn" id="ixlocka" href="/account/billing"><span>See the plans</span></a></p></div>
  <div id="ixsetup" class="hidden">${promptBlock(project.token, where, opts.endpoint ?? null, "Analytics are off. Paste the prompt into your coding agent.")}<p class="fine" id="ixver">Needs @genclass/runtime ${ANALYTICS_RUNTIME} or later.<span id="ixold"></span></p></div>
  <div id="ixsum"></div>
  <div id="ixpages" class="mt-l"></div>
</section>
<section class="blk hidden" id="ix-sessions" data-v="visitors">
  <div class="blk-h"><h2>Sessions</h2></div>
  <div id="ixsess"></div>
</section>
<div class="two hidden" id="ix-sources" data-v="visitors">
  <section class="blk"><div class="blk-h"><h2>Sources</h2></div><div id="ixref"></div></section>
  <section class="blk"><div class="blk-h"><h2>Campaigns</h2></div><div id="ixutm"></div></section>
</div>
<section class="blk hidden" id="ix-devices" data-v="visitors">
  <div class="blk-h"><h2>Devices</h2></div>
  <div class="kv" id="ixdev"></div>
</section>
<div class="two hidden" id="ix-entry" data-v="visitors">
  <section class="blk"><div class="blk-h"><h2>Entry pages</h2></div><div id="ixentry"></div></section>
  <section class="blk"><div class="blk-h"><h2>Exit pages</h2></div><div id="ixexit"></div></section>
</div>
<section class="blk hidden" id="ix-funnels" data-v="visitors">
  <div class="blk-h"><h2>Funnels</h2></div>
  <div id="ixfun"></div>
  <div id="ixfunedit"></div>
</section>
<div class="two hidden" id="clicks" data-v="visitors">
  <section class="blk"><div class="blk-h"><h2>Most clicked</h2></div><div id="ixclicks"></div></section>
  <section class="blk"><div class="blk-h"><h2>Rage and dead clicks</h2></div><div id="ixflags"></div></section>
</div>
<section class="blk hidden" id="moves" data-v="visitors">
  <div class="blk-h"><h2>Navigation</h2></div>
  <div id="ixmoves"></div>
  <div id="ixpaths" class="mt-l"></div>
  <div id="ixsteps" class="mt-l"></div>
  <div id="ixexits" class="mt-l"></div>
</section>
<section class="blk" id="loop" data-v="loop" aria-labelledby="loop-h" data-tour="76|Closed loop|How your agent finds, fixes and proves each problem." data-tour-view="loop">
  <div class="blk-h"><h2 id="loop-h">Closed-loop development</h2></div>
  <div class="flowwrap"><svg class="flow" id="loopstages" role="img" aria-labelledby="loop-h"></svg></div>
  <div class="blk-h sub"><h3 id="agentlog-h">Agent log</h3><span class="aside">Latest 50</span></div>
  <div class="tablewrap"><table class="dt" aria-labelledby="agentlog-h"><thead><tr><th>Time</th><th>Step</th><th>Finding</th><th>Page</th><th>Outcome</th></tr></thead>
  <tbody id="agentlog"></tbody></table></div>
  <p class="quiet hidden" id="agentlog0">No agent steps in this period. Set <code>GENCLASS_REPORT</code> to see them here.</p>
  <div class="blk-h sub"><h3 id="loopkinds-h">By problem</h3></div>
  <div class="flowwrap"><svg class="flow" id="loopsvg" role="img" aria-labelledby="loopkinds-h"></svg></div>
  <p class="loop-foot" id="loop-foot"></p>
</section>
</div>
${mcpView(!!acct, !!opts.privateLink, member)}
${settings}
${opts.extra?.html ?? ""}
</div>`;
  return studioPage(nonce, {
    title: `${project.name} | GenClass dashboard`,
    account: !!acct,
    org: acct ? { name: orgName(acct.email), plan: acct.plan ?? "Free", href: "/account" } : null,
    projects: acct?.apps ?? [],
    project: { name: project.name, id: acct?.current },
    status: `<span class="bdg ${waiting ? "warning" : "brand"}" id="hstatus"><i></i><span>${waiting ? "Waiting" : "Live"}</span></span>`,
    connect: waiting ? "primary" : "default",
    user: acct ? { label: acct.email ?? "Your account", sub: orgName(acct.email) } : null,
    rail,
    railEnd: [{ href: "#settings", label: "Project Settings", icon: "settings" }],
    railLabel: "Project",
    menus,
    commands: [
      { group: "Actions", label: "Connect to your project", href: "#connect", icon: "plug" },
      { group: "Actions", label: "Set up the MCP server", href: "#mcp", icon: "bot" },
      ...(acct ? [{ group: "Actions", label: "New project", href: "/account/new", icon: "plus" as const }] : []),
      { group: "Help", label: "Dashboard guide", href: "https://genclass.dev/docs/dashboard", icon: "book" },
    ],
    css: DASH_CSS,
    body,
    script: acct ? DASH_JS + CONNECT_JS + (opts.extra?.script ?? "") : DASH_JS,
    tour: "dashboard",
    link: acct ? null : (opts.link ?? null),
  });
}

/**
 * /account/apps/<id> for an account whose plan has no dashboard (a plan file without it; none today): the app's name,
 * the plans, then the Connect section (connecting is free: the app's data is collected so the dashboard starts with
 * it). No stats are fetched.
 */
function lockedDashboardPage(
  nonce: string,
  project: { name: string; token: string; created: string; lastEvent: string | null },
  opts: DashboardOptions & { account: NonNullable<DashboardOptions["account"]> },
): string {
  const data = { ...project, id: opts.id, firstEvent: opts.firstEvent ?? null, account: true, locked: true };
  const body = `
<script type="application/json" id="project">${embed(data)}</script>
<div class="sb-page" id="mc" tabindex="-1">
<header class="phead" id="top"><div class="minw0"><h1 id="pname">${esc(project.name)}</h1></div></header>
<section class="blk lock" id="lock" aria-labelledby="lock-h">
  <h2 id="lock-h">This app's plan has no dashboard.</h2>
  <div class="acts"><a class="btn green" href="/account/billing">See plans</a></div>
</section>
<section class="blk">
  <div class="blk-h"><h2 id="connect-h">Connect to your project</h2></div>
  ${connectSection({ token: project.token, account: true, runtimeReady: opts.runtimeReady === true, endpoint: opts.endpoint ?? null, analytics: "", mcp: false })}
</section>
</div>`;
  return studioPage(nonce, {
    title: `${project.name} | GenClass dashboard`,
    account: true,
    org: { name: orgName(opts.account.email), plan: opts.account.plan ?? null, href: "/account" },
    projects: opts.account.apps,
    project: { name: project.name, id: opts.account.current },
    user: { label: opts.account.email ?? "Your account", sub: orgName(opts.account.email) },
    rail: [[{ href: "#top", label: "Project overview", icon: "home", current: true }]],
    railEnd: [{ href: "/account/billing", label: "Plans", icon: "receipt" }],
    railLabel: "Project",
    css: DASH_CSS,
    body,
    script: CONNECT_JS,
  });
}
