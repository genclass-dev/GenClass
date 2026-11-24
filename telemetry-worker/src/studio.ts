// The Supabase Studio frame every signed-in page and every app dashboard uses (the owner asked for Supabase's layout
// one to one, 2026-10-25): a 48px header (the organization and project switchers with their slash dividers, the
// Connect button, the search in the middle (owner, 2026-11-05) that opens the command menu, the theme button, help and
// the account menu), a 208px menu with icons and labels that stays open (the owner, 2026-11-12: the icon rail that
// widened on hover was distracting; on a phone it is the burger's drawer), an optional product menu for views with
// sub-pages, and the page on the canvas. The organization is the account and a project is an app (one key each).
// Tokens are Supabase Studio's dark theme (canvas #121212, surfaces #171717 / #1f1f1f, borders #2e2e2e, text #fafafa,
// #b4b4b4 and #898989, brand #3ecf8e, primary buttons #006239 with a 30% brand border, Inter for text and Source Code
// Pro for code, 6px corners), under the token names the dashboard's own CSS already uses (--paper is the canvas, --ink
// the text). Two deviations, for contrast the tests measure: input borders are #636363 (3:1 on the canvas; Supabase's
// #393939 is about 1.6:1) and the muted text #898989 stays at 4.5:1 or more on every surface.
// Two themes: dark by default, light under :root[data-theme="light"], picked before paint by THEME_HEAD_JS (the saved
// choice, else the system's) and switched by the header's theme button. No external scripts;
// fonts from Google Fonts only; no style attributes (the CSP allows styles by nonce only). Server-rendered text goes
// through esc(); the frame's script inserts text with textContent and never throws into the page (every lookup is
// null-checked, so the page scripts run the same in tests that render only <main>).
// Imports only escape.ts, so pages.ts, account-pages.ts and billing-pages.ts can all use it without an import cycle.

import { esc } from "./escape.js";

// --------------------------------------------------------------------------------------------- icons

/** Lucide's paths (ISC licence), drawn at stroke 1.5 as Studio draws them. */
const PATHS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  list: '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>',
  pointer:
    '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  loop: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  sparkles:
    '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** An inline icon (decorative: aria-hidden). */
export function icon(name: IconName, size = 16): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** Supabase's header divider: a thin forward slash in the strongest border colour. */
const DIVIDER =
  '<span class="sb-div" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M16 3.5 7.5 20.5"/></svg></span>';

/** genclass.dev's fonts: Geist for text, Geist Mono for code and night headlines, Newsreader for page titles by day. */
export const STUDIO_FONTS = "https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&family=Newsreader:opsz,wght@6..72,500&display=swap";

/** genclass.dev's mark, at the top of the sidebar (and in the header on a phone). */
const MARK = '<img src="https://genclass.dev/brand/mark.svg?v=9" alt="" width="24" height="24">';

/** The site's own icons (site/public/brand, apple-touch-icon.png), so every genclass.dev page shows the same one. */
export const ICON_LINKS =
  '<link rel="icon" href="https://genclass.dev/brand/mark.svg?v=9" type="image/svg+xml">' +
  '<link rel="icon" href="https://genclass.dev/brand/mark-32.png?v=9" sizes="32x32" type="image/png">' +
  '<link rel="icon" href="https://genclass.dev/brand/mark-64.png?v=9" sizes="64x64" type="image/png">' +
  '<link rel="apple-touch-icon" href="https://genclass.dev/apple-touch-icon.png">';

// --------------------------------------------------------------------------------------------- theme

/** Where the visitor's choice of theme is kept, on every genclass.dev page (the site uses the same key). */
export const THEME_KEY = "gc-theme";

/**
 * Runs first in <head>, before paint: `data-theme` on <html> is the saved choice ("light" or "dark"), else the system's,
 * and the `js` class marks a page whose scripts run. Every page this worker serves includes it under its nonce.
 */
export const THEME_HEAD_JS = `(function(){var d=document.documentElement,t=null;d.classList.add("js");try{t=localStorage.getItem("${THEME_KEY}")}catch(e){}if(t!=="light"&&t!=="dark")t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";d.setAttribute("data-theme",t)})();`;

/** The theme-color metas for both themes (the browser picks by the system's theme). */
export const THEME_COLOR_METAS = (dark: string, light: string): string =>
  `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">`;

/**
 * The theme button's behaviour, for every page: a click on [data-theme-toggle] flips the theme and saves it; with no
 * saved choice the page follows the system's theme as it changes.
 */
export const THEME_JS = `
(function(){
  var d = document.documentElement;
  function label(){ var t = d.getAttribute("data-theme"); [].slice.call(document.querySelectorAll("[data-theme-toggle]")).forEach(function(b){ b.setAttribute("aria-label", t === "light" ? "Switch to dark mode" : "Switch to light mode"); b.title = t === "light" ? "Dark mode" : "Light mode"; }); }
  document.addEventListener("click", function(e){
    var b = e.target && e.target.closest ? e.target.closest("[data-theme-toggle]") : null; if (!b) return;
    var t = d.getAttribute("data-theme") === "light" ? "dark" : "light";
    d.setAttribute("data-theme", t); try { localStorage.setItem("${THEME_KEY}", t); } catch (x) {}
    label();
  });
  try {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var follow = function(){ var saved = null; try { saved = localStorage.getItem("${THEME_KEY}"); } catch (x) {} if (saved !== "light" && saved !== "dark") { d.setAttribute("data-theme", mq.matches ? "light" : "dark"); label(); } };
    if (mq.addEventListener) mq.addEventListener("change", follow);
  } catch (x) {}
  label();
})();
`;

/** The header's theme button: a sun in dark mode, a moon in light mode (the CSS shows one). */
export function themeButton(cls: string): string {
  return `<button class="${cls}" type="button" data-theme-toggle aria-label="Switch theme"><span class="th-sun">${icon("sun", 15)}</span><span class="th-moon">${icon("moon", 15)}</span></button>`;
}

// --------------------------------------------------------------------------------------------- a protected link (client)

/**
 * The browser side of a protected private link (src/link-lock.ts), shared by /start, the unlock page and the Protect
 * dialog: base64url, a passkey made or used through an options URL, and a lock form's choice between a passkey and a
 * password (`[data-lock]` holds radios named "lock" and a `[data-pw]` field). Names start with gcLk so they never meet
 * the account pages' own helpers.
 */
export const LOCK_JS = `
function gcLkB2u(buf){ var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }
function gcLkU2b(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; }
function gcLkCan(){ return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
function gcLkPost(url, body){
  return fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body || {}) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error(j.error || "Something went wrong. Try again."); return j; }); });
}
function gcLkWhy(e){ if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return "Passkey cancelled."; var m = (e && e.message) || "Something went wrong. Try again."; return m.charAt(0).toUpperCase() + m.slice(1); }
function gcLkCreate(url, body){
  return gcLkPost(url, body).then(function(o){
    var pk = o.publicKey; pk.challenge = gcLkU2b(pk.challenge); pk.user.id = gcLkU2b(pk.user.id);
    (pk.excludeCredentials || []).forEach(function(c){ c.id = gcLkU2b(c.id); });
    return navigator.credentials.create({ publicKey: pk }).then(function(cr){
      if (!cr) throw new Error("No passkey was made.");
      return { id: o.id, credential: { type: cr.type, rawId: gcLkB2u(cr.rawId), response: { clientDataJSON: gcLkB2u(cr.response.clientDataJSON), attestationObject: gcLkB2u(cr.response.attestationObject) } } };
    });
  });
}
function gcLkGet(url){
  return gcLkPost(url, {}).then(function(o){
    var pk = o.publicKey; pk.challenge = gcLkU2b(pk.challenge);
    (pk.allowCredentials || []).forEach(function(c){ c.id = gcLkU2b(c.id); });
    return navigator.credentials.get({ publicKey: pk }).then(function(a){
      if (!a) throw new Error("No passkey was used.");
      return { id: o.id, credential: { type: a.type, rawId: gcLkB2u(a.rawId), response: { clientDataJSON: gcLkB2u(a.response.clientDataJSON), authenticatorData: gcLkB2u(a.response.authenticatorData), signature: gcLkB2u(a.response.signature), userHandle: a.response.userHandle ? gcLkB2u(a.response.userHandle) : null } } };
    });
  });
}
function gcLkKind(root){ var r = root.querySelector("input[name=lock]:checked"); return r ? r.value : "password"; }
function gcLkWire(root){
  var pw = root.querySelector("[data-pw]"), pk = root.querySelector("input[name=lock][value=passkey]"), pp = root.querySelector("input[name=lock][value=password]");
  if (pk && gcLkCan()) pk.checked = true;
  else if (pk) { pk.disabled = true; if (pp) pp.checked = true; var l = pk.closest("label"); if (l) l.classList.add("off"); }
  function sync(){ var v = gcLkKind(root), i = pw && pw.querySelector("input"); if (pw) pw.hidden = v !== "password"; if (i) i.required = v === "password"; }
  [].slice.call(root.querySelectorAll("input[name=lock]")).forEach(function(r){ r.addEventListener("change", sync); });
  sync();
}
function gcLkBody(root, url, extra){
  if (gcLkKind(root) === "passkey") return gcLkCreate(url, extra || {}).then(function(p){ return { passkey: p }; });
  var i = root.querySelector("[data-pw] input"); return Promise.resolve({ password: i ? i.value : "" });
}
`;

/** A Supabase badge (rounded, mono, upper case): default, brand (green), warning (amber) or destructive. */
export function badge(text: string, kind: "default" | "brand" | "warning" | "destructive" = "default", id?: string): string {
  return `<span class="bdg${kind === "default" ? "" : ` ${kind}`}"${id ? ` id="${esc(id)}"` : ""}>${esc(text)}</span>`;
}

// --------------------------------------------------------------------------------------------- styles

/**
 * Studio's dark tokens under the dashboard's token names, the base elements, and the frame. Pages add their own CSS
 * after it (DASH_CSS, ORG_CSS, the billing CSS) and may use every token here.
 */
export const STUDIO_CSS = `
:root{
  --paper:#0C0E12;--panel:#14171D;--ink:#E9EBF1;--ink2:#AEB4C2;--ink3:#8B92A2;--rule:#222731;--rule2:#2C323D;--line:#5E6576;
  --accent:#3DDC97;--accent-x:#3DDC97;--accent-f:#E9EBF1;--accent-t:#10241B;--warn:#FF8A70;--warn-f:#FF6A4D;--warn-t:#2A1511;
  --bar:#8B92A2;--bar2:#3DDC97;--bar3:#FF6A4D;--ink-h:#ffffff;--green-h:#FFFFFF;--on-green:#0C0E12;--head:#0C0E12;
  --code:#101318;--codeink:#E9EBF1;
  --s75:#101318;--s200:#181C23;--s300:#232832;--ctl:#101318;--rule3:#3A414E;--brand-b:#E9EBF1;--amber:#F2C879;--amber-t:#2B2210;--ovl:#14171D;
  --side:#0F1116;--sage:#3DDC97;
  --display:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--num:var(--mono);--hw:600;--htrack:-.035em;
  --cb:#2C323D;--cb-h:#454C5A;--sel:rgba(61,220,151,.25);--brand-bh:#FFFFFF;--ph:#6C7383;--ok-b:#1F4A37;--amber-b:#4D3A12;--warn-b:#5C2A20;
  --dng-bg:#2A1511;--dng-b:#6B2C20;--dng-bg-h:#3A1B15;--dng-b-h:#B23B28;--av-bg:#10241B;--av-b:#1F4A37;--ovl-b:#2C323D;
  --shadow-m:0 12px 32px rgba(0,0,0,.5);--shadow-l:0 24px 64px rgba(0,0,0,.6);--shadow-r:12px 0 24px rgba(0,0,0,.35);--scrim:rgba(0,0,0,.66);--tour-scrim:rgba(0,0,0,.6);
  color-scheme:dark;
}
:root[data-theme="light"]{
  --paper:#FAF8F4;--panel:#FFFFFF;--ink:#15171F;--ink2:#4A4E5C;--ink3:#5F6473;--rule:#E6E2D9;--rule2:#DCD7CC;--line:#8A8D99;
  --accent:#0A6A49;--accent-x:#0A6A49;--accent-f:#15171F;--accent-t:#E9F2EC;--warn:#B53A25;--warn-f:#E0533B;--warn-t:#FBEDE9;
  --bar:#A9ACB6;--bar2:#0E865C;--bar3:#E0533B;--ink-h:#000000;--green-h:#2C2F3A;--on-green:#FAF8F4;--head:#FAF8F4;
  --code:#F3F0EA;--codeink:#15171F;
  --s75:#F5F2EC;--s200:#EFEBE3;--s300:#E9E5DC;--ctl:#FFFFFF;--rule3:#C9C3B6;--brand-b:#15171F;--amber:#7A5000;--amber-t:#FAF1DE;--ovl:#FFFFFF;
  --side:#F4F1EA;--sage:#4F7A6E;
  --display:"Newsreader","Iowan Old Style",Georgia,serif;--num:var(--sans);--hw:500;--htrack:-.02em;
  --cb:#DCD7CC;--cb-h:#B9B3A6;--sel:rgba(14,134,92,.18);--brand-bh:#2C2F3A;--ph:#8C8F9C;--ok-b:#BFDCCB;--amber-b:#EBD3A1;--warn-b:#F2C3B8;
  --dng-bg:#FBEDE9;--dng-b:#F2C3B8;--dng-bg-h:#F7DDD6;--dng-b-h:#E0533B;--av-bg:#E9F2EC;--av-b:#BFDCCB;--ovl-b:#E6E2D9;
  --shadow-m:0 12px 32px rgba(21,23,31,.10);--shadow-l:0 24px 64px rgba(21,23,31,.16);--shadow-r:12px 0 24px rgba(21,23,31,.06);--scrim:rgba(21,23,31,.35);--tour-scrim:rgba(21,23,31,.5);
  color-scheme:light;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper)}
body{background:var(--paper);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
::selection{background:var(--sel);color:var(--ink)}
.th-moon{display:none}
:root[data-theme="light"] .th-moon{display:contents}:root[data-theme="light"] .th-sun{display:none}
.th-sun{display:contents}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1,h2,h3{font-family:var(--sans);font-weight:600;letter-spacing:-.01em;text-wrap:balance}
h1{font-family:var(--display);font-weight:var(--hw);letter-spacing:var(--htrack);font-size:26px;line-height:1.2}
h2{font-size:15px;line-height:1.4}
h3{font-size:14px;line-height:1.4}
code,pre,.mono{font-family:var(--mono)}
.muted{color:var(--ink3)}
.small{font-size:13px}
.hidden{display:none!important}
.vh{display:none!important}
.skip{position:absolute;left:12px;top:-60px;z-index:90;background:var(--accent-f);color:var(--on-green);padding:8px 12px;font-size:13px;text-decoration:none}
.skip:focus{top:8px}
[tabindex="-1"]:focus{outline:none}
.sb [id]{scroll-margin-top:72px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.stack>*+*{margin-top:12px}
.mt-xl{margin-top:40px}.mt-l{margin-top:24px}.mt-s{margin-top:12px}.big{font-size:16px}.brk{word-break:break-all}.minw0{min-width:0}
.ic{display:block;flex:none}
/* buttons: genclass.dev's, square: primary is ink with a paper label in both themes, the second an outline */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 14px;border-radius:0;font:500 13.5px/1 var(--sans);cursor:pointer;border:1px solid var(--brand-b);background:var(--accent-f);color:var(--on-green);text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.btn:hover{background:var(--green-h);border-color:var(--brand-bh)}
.btn:disabled{opacity:.55;cursor:progress}
.btn.green{background:var(--accent-f);border-color:var(--brand-b);color:var(--on-green)}
.btn.green:hover{background:var(--green-h);border-color:var(--brand-bh)}
.btn.ghost,.btn.paper{background:var(--ctl);color:var(--ink);border-color:var(--cb)}
.btn.ghost:hover,.btn.paper:hover{background:var(--s200);border-color:var(--cb-h)}
.btn.text{background:transparent;border-color:transparent;color:var(--ink2)}
.btn.text:hover{background:var(--s200);color:var(--ink)}
.btn.danger{background:var(--dng-bg);border-color:var(--dng-b);color:var(--ink)}
.btn.danger:hover{background:var(--dng-bg-h);border-color:var(--dng-b-h)}
.btn.sm,.btn.tiny{min-height:28px;padding:0 10px;font-size:12.5px}
.btn.xl{min-height:42px;padding:0 20px;font-size:14.5px}
.btn .ic{width:14px;height:14px}
.btn.ico{padding:0;width:28px;min-height:28px}
@media (pointer:coarse){.btn,.btn.sm,.btn.tiny{min-height:40px}.btn.ico{width:40px}.js .sb-x{min-width:40px;min-height:40px;align-items:center;justify-content:center;margin:-10px -10px -10px 0}}
button.lnk{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer}
/* inputs: square, as on genclass.dev; the border at 3:1 for contrast */
input[type=text],input[type=email],input[type=password],input[type=url],input[type=date],input[type=search],select,textarea{min-height:36px;width:100%;padding:0 12px;border-radius:0;border:1px solid var(--line);background:var(--ctl);color:var(--ink);font:14px var(--sans)}
textarea{padding:8px 12px;min-height:80px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
input:disabled,select:disabled{opacity:.6}
::placeholder{color:var(--ph);opacity:1}
label{font-size:13px;color:var(--ink2)}
/* tables: quiet rules, the header row in small mono capitals */
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{color:var(--ink3);font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.06em;background:var(--s75)}
.tablewrap{overflow-x:auto}
pre.code{background:var(--code);color:var(--codeink);border:1px solid var(--rule);border-radius:8px;padding:12px 14px;font:13px/1.6 var(--mono);overflow-x:auto;white-space:pre}
.note{border:1px solid var(--amber-b);background:var(--amber-t);padding:10px 14px;border-radius:8px;font-size:13px;color:var(--ink)}
.note.ok,.ok{border-color:var(--ok-b);background:var(--accent-t)}
/* badges */
.bdg{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:0;border:1px solid var(--rule2);background:var(--s75);color:var(--ink2);font:500 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
.bdg.brand{border-color:var(--ok-b);background:var(--accent-t);color:var(--accent)}
.bdg.warning{border-color:var(--amber-b);background:var(--amber-t);color:var(--amber)}
.bdg.destructive{border-color:var(--warn-b);background:var(--warn-t);color:var(--warn)}
.bdg i{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
/* ---------- the frame: a full-height sidebar on the left (genclass.dev's mark and name, the workspace switcher, Get
   started, Home, the apps, the page's own menu, the plan card and Documentation), the header and the page on the right */
body.sb{min-height:100vh}
.sb-shell{display:flex;min-height:100vh}
.sb-col{flex:1;min-width:0;display:flex;flex-direction:column}
.sb-top{position:sticky;top:0;z-index:40;display:flex;align-items:center;height:56px;border-bottom:1px solid var(--rule);background:var(--head);padding:0 16px 0 20px;gap:6px}
.sb-home{display:none;align-items:center;justify-content:center;width:40px;height:56px;flex:none}
.sb-home img{width:22px;height:22px;display:block}
.sb-ib.sb-burger{display:none}
.sb-crumbs{display:flex;align-items:center;min-width:0;flex:0 1 auto;font-size:14px}
.sb-div{color:var(--rule3);display:flex;flex:none}
.sb-cr{display:flex;align-items:center;gap:6px;min-width:0;padding:0 6px;height:30px;color:var(--ink);text-decoration:none;background:none;border:0;font:500 14px var(--sans);cursor:pointer;white-space:nowrap}
.sb-cr:hover,.sb-cr[aria-expanded=true]{background:var(--s200)}
.sb-cr .nm{overflow:hidden;text-overflow:ellipsis;max-width:260px}
.sb-cr .ic{color:var(--ink3)}
.sb-cr.static{cursor:default}.sb-cr.static:hover{background:none}
.sb-acts{display:flex;align-items:center;gap:8px;margin-left:10px;flex:none}
.sb-right{display:flex;align-items:center;gap:8px;flex:none}
/* the search, in the middle of the header: wide, easy to see */
.sb-mid{flex:1 1 auto;display:flex;justify-content:center;min-width:0;padding:0 20px}
.sb-search{display:flex;align-items:center;gap:10px;width:100%;max-width:440px;height:36px;padding:0 8px 0 12px;border-radius:0;border:1px solid var(--cb);background:var(--ctl);color:var(--ink3);font:13.5px var(--sans);cursor:pointer;transition:border-color .15s,background .15s}
.sb-search:hover{border-color:var(--cb-h);color:var(--ink)}
.sb-search .ic{color:var(--ink3)}
.sb-search kbd{margin-left:auto;font:11px var(--mono);color:var(--ink3);padding:2px 6px;border:1px solid var(--cb);background:var(--paper)}
.sb-lk{display:inline-flex;align-items:center;color:var(--accent)}
.sb-lk .ic{width:13px;height:13px}
/* the tour: a spotlight on one part of the page and a card next to it */
.tour-spot{position:fixed;z-index:95;border-radius:4px;box-shadow:0 0 0 2px var(--accent),0 0 0 200vmax var(--tour-scrim);pointer-events:none;transition:top .25s ease,left .25s ease,width .25s ease,height .25s ease}
.tour-spot.mid{top:50%;left:50%;width:0;height:0;box-shadow:0 0 0 200vmax var(--tour-scrim)}
.tour-pop{position:fixed;z-index:96;width:min(320px,calc(100vw - 32px));background:var(--ovl);border:1px solid var(--ovl-b);border-radius:10px;box-shadow:var(--shadow-l);padding:18px 18px 14px;transition:top .25s ease,left .25s ease}
.tour-pop h2{font-size:15px;font-weight:500;margin-bottom:4px}
.tour-pop p{font-size:13.5px;color:var(--ink2)}
.tour-f{display:flex;align-items:center;gap:8px;margin-top:16px}
.tour-n{margin-right:auto;font:12px var(--mono);color:var(--ink3)}
.tour-pop [hidden]{display:none}
@media (prefers-reduced-motion:reduce){.tour-spot,.tour-pop{transition:none}}
/* a lock form: passkey or password */
.lk-choice{display:none;gap:8px}
.js .lk-choice{display:grid;grid-template-columns:1fr 1fr}
.lk-choice label{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--cb);border-radius:0;cursor:pointer;color:var(--ink);font-size:13.5px;background:var(--ctl)}
.lk-choice label:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.lk-choice label.off{opacity:.5;cursor:not-allowed}
.lk-choice input{accent-color:var(--accent);margin:0}
.lk-f{display:grid;gap:14px}
.lk-f [data-pw]{display:grid;gap:6px}
.lk-f [data-pw][hidden]{display:none}
.lk-err{font-size:13px;color:var(--warn);min-height:1em}
.lk-err:empty{display:none}
.sb-ib{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:0;border:1px solid var(--cb);background:var(--ctl);color:var(--ink2);cursor:pointer;text-decoration:none}
.sb-ib:hover{color:var(--ink);border-color:var(--cb-h)}
.sb-av{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:var(--av-bg);color:var(--ink);font:500 12px var(--sans);border:1px solid var(--av-b);cursor:pointer;text-transform:uppercase}
/* dropdowns (organization, project, help, account) */
.dd{position:relative;display:flex;align-items:center;min-width:0}
.dd-m{position:absolute;top:calc(100% + 6px);left:0;z-index:70;min-width:240px;max-width:min(340px,90vw);max-height:70vh;overflow:auto;background:var(--ovl);border:1px solid var(--ovl-b);border-radius:8px;padding:4px;box-shadow:var(--shadow-m)}
.dd-m.end{left:auto;right:0}
.dd-m[hidden]{display:none}
.dd-m .dd-l{display:block;padding:6px 8px 4px;font:12px var(--sans);color:var(--ink3)}
.dd-m a,.dd-m button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:4px;font:13px var(--sans);color:var(--ink2);text-decoration:none;background:none;border:0;cursor:pointer;text-align:left}
.dd-m a:hover,.dd-m button:hover,.dd-m a:focus-visible,.dd-m button:focus-visible{background:var(--s300);color:var(--ink);outline:none}
.dd-m a[aria-current] {color:var(--ink)}
.dd-m a[aria-current]::after{content:"";margin-left:auto;width:14px;height:14px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/14px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/14px no-repeat}
.dd-m hr{border:0;border-top:1px solid var(--ovl-b);margin:4px -4px}
.dd-m .who{padding:8px 8px 6px;font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.dd-m .who small{display:block;color:var(--ink3);font-size:12px}
.dd-m form{display:block}
.sb-body{display:flex;flex:1;min-height:0}
/* the sidebar: full height, its own ground; a phone opens it from the burger */
.sb-rail{position:sticky;top:0;align-self:flex-start;height:100vh;width:248px;flex:none;z-index:50}
.sb-side{position:absolute;inset:0 auto 0 0;width:248px;height:100%;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--rule)}
.sb-brand{display:flex;align-items:center;gap:10px;height:56px;padding:0 18px;flex:none;color:var(--ink);text-decoration:none;font:700 16px var(--sans);letter-spacing:-.02em}
.sb-brand img{width:24px;height:24px;display:block}
.sb-ws{margin:2px 12px 6px;flex:none}
.sb-ws .sb-cr{width:100%;height:42px;padding:0 10px;border:1px solid var(--cb);background:var(--ctl);gap:9px}
.sb-ws .sb-cr:hover,.sb-ws .sb-cr[aria-expanded=true]{border-color:var(--cb-h);background:var(--ctl)}
.sb-ws .sb-cr .nm{flex:1;text-align:left;font-size:13.5px}
.sb-ws .av{display:inline-grid;place-items:center;width:22px;height:22px;flex:none;background:var(--ink);color:var(--paper);font:600 11px var(--sans);text-transform:uppercase}
.sb-ws .dd-m{left:0;right:0;min-width:0}
.sb-scroll{flex:1;min-height:0;overflow:hidden auto;padding:6px 12px 8px;display:flex;flex-direction:column}
.sb-scroll>*{flex:none}
.sb-scroll>.snav{flex:1 0 auto}
.sb-rail nav{display:flex;flex-direction:column;gap:1px}
.sb-rail nav+nav{margin-top:6px}
.sb-rail a{display:flex;align-items:center;gap:10px;height:34px;min-height:34px;padding:0 10px;color:var(--ink2);text-decoration:none;font-size:14px;white-space:nowrap;border-left:2px solid transparent}
.sb-rail a .ic{width:18px;height:18px;color:var(--ink3)}
.sb-rail a:hover{background:var(--s200);color:var(--ink)}
.sb-rail a[aria-current=true],.sb-rail a[aria-current=page]{background:var(--s300);color:var(--ink);border-left-color:var(--ink)}
.sb-rail a[aria-current=true] .ic,.sb-rail a[aria-current=page] .ic{color:var(--ink)}
.sb-rail a .lbl{overflow:hidden;text-overflow:ellipsis}
.sb-rail a .cnt{margin-left:auto;font:11px var(--mono);color:var(--ink3)}
.sb-rail a .cnt.done{color:var(--accent)}
.sb-rail hr{border:0;border-top:1px solid var(--rule);margin:8px 2px}
.sb-rail .end{margin-top:auto;padding-top:8px}
.sb-gl{display:block;padding:14px 10px 6px;font:500 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-rail a.sb-app .dot{width:7px;height:7px;border-radius:50%;background:var(--ink3);flex:none;margin:0 5px}
.sb-rail a.sb-app .dot.live{background:var(--accent)}
.sb-rail a.sb-add{color:var(--ink3);font-size:13.5px}
/* the foot: the plan card (filled from /api/account/glance) and Documentation */
.sb-foot{flex:none;padding:10px 12px 14px;border-top:1px solid var(--rule);display:grid;gap:6px}
.sb-plan{border:1px solid var(--cb);background:var(--ctl);padding:12px;display:grid;gap:8px}
.sb-plan-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.sb-plan-h b{font:600 13.5px var(--sans)}
.sb-plan-h span{font:12px var(--mono);color:var(--ink3);white-space:nowrap}
.sb-plan p{font-size:12.5px;color:var(--ink2);line-height:1.4}
.sb-meter{height:4px;background:var(--s300);overflow:hidden}
.sb-meter i{display:block;height:100%;width:0;background:var(--ink);transition:width .3s}
.sb-plan .btn{width:100%}
.sb-plan[data-trial] .sb-plan-h span{color:var(--accent)}
.sb-foot a.sb-doc{height:32px;font-size:13.5px}
.sb-foot a.sb-doc .ext{margin-left:auto;width:13px;height:13px}
/* the product menu: Studio's second column, its title on top, groups under small labels */
.sb-menu{position:sticky;top:56px;align-self:flex-start;height:calc(100vh - 56px);width:240px;flex:none;border-right:1px solid var(--rule);background:var(--head);overflow-y:auto}
.sb-menu:not(:has(.sb-pm:not(.vh))){display:none}
.sb-pm .t{display:flex;align-items:center;height:52px;padding:0 20px;border-bottom:1px solid var(--rule);font:600 14px var(--sans);color:var(--ink)}
.sb-pm .g{padding:14px 12px 6px}
.sb-pm .g+.g{border-top:1px solid var(--rule)}
.sb-pm .gl{display:block;padding:0 8px 6px;font:12px var(--sans);color:var(--ink3)}
.sb-pm a{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:0;font-size:13.5px;color:var(--ink2);text-decoration:none}
.sb-pm a:hover{background:var(--s200);color:var(--ink)}
.sb-pm a[aria-current=true],.sb-pm a[aria-current=page]{background:var(--s300);color:var(--ink)}
.sb-pm a .ic{width:14px;height:14px;color:var(--ink3)}
/* the page */
main.wrap{flex:1;min-width:0}
.sb-page{max-width:1200px;margin:0 auto;padding:36px 44px 72px}
.sb-page.wide{max-width:1600px}
.sb-ph{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:24px}
.sb-ph h1{font-size:30px}
.sb-ph p{color:var(--ink3);font-size:14px;margin-top:4px;max-width:72ch}
.sb-ph .acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pnl{background:var(--panel);border:1px solid var(--rule);border-radius:10px;min-width:0}
.pnl-h{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--rule);min-height:48px}
.pnl-h h2,.pnl-h h3{font-size:14px;color:var(--ink)}
.pnl-h .aside{font-size:12px;color:var(--ink3)}
.pnl-b{padding:20px}
.pnl-f{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center;padding:12px 20px;border-top:1px solid var(--rule)}
.hs{font-size:18px;color:var(--ink);margin:40px 0 16px}
/* the modal (Connect, the command menu): an overlay once the script runs; without it, an ordinary section */
.sb-modal{margin-top:24px}
.js .sb-modal{display:none;margin:0}
.js .sb-modal.open{display:flex;position:fixed;inset:0;z-index:80;background:var(--scrim);align-items:flex-start;justify-content:center;padding:7vh 16px 16px;overflow:auto}
.sb-mbox{width:100%;max-width:860px;background:var(--paper);border:1px solid var(--ovl-b);border-radius:12px;box-shadow:var(--shadow-l);min-width:0}
.sb-mbox.sm{max-width:440px}
.sb-mh{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--rule)}
.sb-mh h2{font-size:16px}
.sb-mh p{font-size:13px;color:var(--ink3);margin-top:2px}
.sb-x{display:none}
.js .sb-x{display:inline-flex;background:none;border:0;color:var(--ink3);cursor:pointer;padding:2px;border-radius:4px}
.sb-x:hover{color:var(--ink)}
.sb-mb{padding:16px 20px 20px}
/* tabs: Studio's underlined tabs */
.sb-tabs{display:flex;gap:20px;border-bottom:1px solid var(--rule);overflow-x:auto;scrollbar-width:none}
.sb-tabs button{background:none;border:0;border-bottom:1px solid transparent;margin-bottom:-1px;padding:10px 0;font:14px var(--sans);color:var(--ink3);cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:center}
.sb-tabs button:hover{color:var(--ink2)}
.sb-tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink)}
.js .tabp:not(.on){display:none}
.tabp{padding-top:16px}
/* the command menu */
.sb-cmd .sb-mbox{max-width:620px}
.sb-cmd input[type=search]{border:0;border-bottom:1px solid var(--rule);border-radius:0;background:transparent;min-height:48px;padding:0 20px;outline:none}
.sb-cmd input[type=search]:focus-visible{outline:none;border-color:var(--rule)}
.sb-cmd ul{list-style:none;max-height:56vh;overflow:auto;padding:6px}
.sb-cmd li.gl{padding:8px 10px 4px;font-size:12px;color:var(--ink3)}
.sb-cmd li a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:0;color:var(--ink2);text-decoration:none;font-size:14px}
.sb-cmd li a:hover,.sb-cmd li a.on{background:var(--s300);color:var(--ink)}
.sb-cmd li a .ic{color:var(--ink3)}
.sb-cmd .none{padding:16px 20px;color:var(--ink3);font-size:13px}
@media (max-width:900px){
  .sb-page{padding:24px 20px 56px}
  .sb-menu{display:none}
  .sb-mid{padding:0 12px}
  .sb-search kbd{display:none}
}
@media (max-width:640px){
  .sb-mid{flex:0 0 auto;margin-left:auto;padding:0 4px}
  .sb-search{width:34px;height:34px;padding:0;justify-content:center}.sb-search span{display:none}
}
@media (max-width:1023px){
  .sb-ib.sb-burger{display:inline-flex}
  .sb-home{display:flex}
  .sb-top{padding:0 10px}
  .sb-ib,.sb-av{flex:none}
  .sb-rail{position:fixed;left:0;top:0;height:100vh;height:100dvh;width:0;z-index:60}
  .sb-side{width:0;border-right:0;visibility:hidden;overflow:hidden;transition:width .15s ease,visibility 0s .15s}
  body.sb-open .sb-side{width:272px;border-right:1px solid var(--rule);box-shadow:var(--shadow-r);visibility:visible;transition:width .15s ease}
  .sb-cr .nm{max-width:140px}
  .sb-acts .btn span{display:none}
  .sb-acts .btn{padding:0 8px}
}
@media (max-width:767px){.sb-page{padding:20px 16px 48px}.sb-crumbs .bdg{display:none}}
/* a phone: the header's groups closer together, so they fit from 360px without pushing the page sideways */
@media (max-width:480px){.sb-top{gap:2px;padding-right:8px}.sb-acts{margin-left:4px;gap:4px}.sb-right{gap:4px}.sb-mid{padding:0 2px}}
/* the narrowest phones: the theme follows the phone's own setting, so its button gives its room to Sign in and the menus */
@media (max-width:400px){.sb-right>span:first-child{display:none}}
/* a phone: fields at 16px so iOS does not zoom the page on focus, small labels at 12px */
@media (max-width:560px){
  .sb-acts .bdg{display:none}
  .sb-cr .nm{max-width:none}
  input[type=text],input[type=email],input[type=password],input[type=url],input[type=date],input[type=search],select,textarea{font-size:16px}
  .bdg{font-size:12px;height:22px}
  .sb-rail a .cnt{font-size:12px}
}
/* Sign in: its word, and on the narrowest phones its icon instead */
.sb-in .ic{display:none}
@media (max-width:360px){.sb-in .ic{display:block}.sb-in span{display:none}.btn.sb-in{padding:0 7px}}
/* the phone-only rail links (what the product menu holds there): the menu shows them from 901px */
@media (min-width:901px){.sb-rail a.ph-only{display:none}}
`;

// --------------------------------------------------------------------------------------------- copy

/**
 * Copying, for every page: gcCopy copies through a temporary textarea, then the Clipboard API, and when both are
 * refused it selects the text in `node` (a hidden textarea is shown selected) so the person can copy it by hand;
 * copyBtn makes a Copy button; el makes an element with a class and text.
 */
export const COPY_JS = `
function gcSelect(node){
  try { var r = document.createRange(); r.selectNodeContents(node); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; } catch (e) { return false; }
}
// Copy text with the Clipboard API; when the browser refuses (no secure context, the document not focused, an embedded
// page), copy through a temporary textarea and execCommand, which works on the click itself; failing both, select the
// text in node so the person can copy it by hand (a textarea fallback is shown selected: one keystroke copies it).
// Focus goes back where it was (the button), so a keyboard user's next Tab continues from there.
function gcLegacyCopy(text){
  var prev = document.activeElement, ta = null;
  try {
    ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "0"; ta.style.left = "0"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus({ preventScroll: true }); ta.select(); ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch (e) { return false; }
  finally {
    try { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); if (prev && prev.focus && prev !== document.body) prev.focus({ preventScroll: true }); } catch (e) {}
  }
}
function gcCopy(b, text, node){
  var label = b.getAttribute("data-label") || b.textContent;
  b.setAttribute("data-label", label);
  function say(t){ b.textContent = t; clearTimeout(b.gcT); b.gcT = setTimeout(function(){ b.textContent = label; }, 2000); }
  function fallback(){
    if (node && node.tagName === "TEXTAREA") { node.hidden = false; node.focus(); node.select(); say("Selected, now copy"); return; }
    say(node && gcSelect(node) ? "Selected, now copy" : "Could not copy");
  }
  // the legacy path first: it needs the click's own activation, which the async Clipboard API's rejection would have spent
  if (gcLegacyCopy(text)) { say("Copied"); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function(){ say("Copied"); }, fallback);
  else fallback();
}
function copyBtn(getText, name, getNode){
  var b = document.createElement("button"); b.type = "button"; b.className = "btn sm ghost"; b.textContent = "Copy";
  if (name) b.setAttribute("aria-label", "Copy " + name);
  b.addEventListener("click", function(){ gcCopy(b, getText(), getNode ? getNode() : null); });
  return b;
}
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
`;

// --------------------------------------------------------------------------------------------- the frame's script

/**
 * The frame's behaviour: dropdowns, the mobile rail, modals (with their tabs) and the command menu, and one delegated
 * handler for every [data-copy] button (data-target names the element to select when the clipboard is refused).
 * Pages open a modal with data-open="<id>" (data-tab="<tab id>" picks its tab) or gcModal(id, tab).
 */
const STUDIO_JS = `
document.documentElement.classList.add("js");
function gcClose(){
  [].slice.call(document.querySelectorAll(".dd-m:not([hidden])")).forEach(function(m){ m.hidden = true; var b = m.previousElementSibling; if (b) b.setAttribute("aria-expanded", "false"); });
}
function gcTab(btn){
  var list = btn.closest("[role=tablist]"); if (!list) return;
  [].slice.call(list.querySelectorAll("[role=tab]")).forEach(function(t){
    var on = t === btn, p = document.getElementById(t.getAttribute("aria-controls"));
    t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
    if (p) p.classList.toggle("on", on);
  });
}
var gcLastFocus = null;
function gcModal(id, tab){
  var m = document.getElementById(id); if (!m) return false;
  gcClose(); gcLastFocus = document.activeElement;
  [].slice.call(document.querySelectorAll(".sb-modal.open")).forEach(function(o){ if (o !== m) o.classList.remove("open"); });
  m.classList.add("open");
  if (tab) { var t = document.getElementById("tab-" + tab); if (t) gcTab(t); }
  var f = m.querySelector("[autofocus], input[type=search]") || m.querySelector(".sb-x");
  if (f) try { f.focus(); } catch (e) {}
  return true;
}
function gcUnmodal(){
  var open = [].slice.call(document.querySelectorAll(".sb-modal.open")); if (!open.length) return false;
  open.forEach(function(m){ m.classList.remove("open"); });
  // a dialog opened from the address (#connect) closes back to the page under it
  if (location.hash === "#connect") try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  if (gcLastFocus && gcLastFocus.focus) try { gcLastFocus.focus(); } catch (e) {}
  return true;
}
document.addEventListener("click", function(e){
  var t = e.target && e.target.closest ? e.target : null; if (!t) return;
  var dd = t.closest("[data-dd]");
  if (dd) {
    var m = dd.nextElementSibling, open = m && m.hidden;
    gcClose();
    if (m && open) { m.hidden = false; dd.setAttribute("aria-expanded", "true"); var f = m.querySelector("a,button"); if (f) try { f.focus(); } catch (x) {} }
    e.preventDefault(); return;
  }
  if (!t.closest(".dd-m")) gcClose();
  var op = t.closest("[data-open]");
  if (op && gcModal(op.getAttribute("data-open"), op.getAttribute("data-tab"))) { e.preventDefault(); return; }
  if (t.closest("[data-close]") || t.classList.contains("sb-modal")) { gcUnmodal(); return; }
  var tab = t.closest("[role=tab]"); if (tab) { gcTab(tab); return; }
  var cp = t.closest("[data-copy]");
  if (cp && typeof gcCopy === "function") {
    // the element to select by hand: data-target, else a copy-prompt block's hidden textarea
    var at = cp.getAttribute("data-target"), ta = cp.parentNode && cp.parentNode.querySelector ? cp.parentNode.querySelector("textarea.cp-text") : null;
    gcCopy(cp, cp.getAttribute("data-copy"), at ? document.getElementById(at) : ta);
    return;
  }
  var rl = t.closest(".sb-rail a");
  if (rl && e.detail) setTimeout(function(){ try { rl.blur(); } catch (x) {} }, 0);
  var bg = t.closest("[data-burger]");
  if (bg) { var on = !document.body.classList.contains("sb-open"); document.body.classList.toggle("sb-open", on); bg.setAttribute("aria-expanded", String(on)); return; }
  if (document.body && document.body.classList.contains("sb-open") && !t.closest(".sb-rail")) document.body.classList.remove("sb-open");
});
document.addEventListener("keydown", function(e){
  if (e.key === "Escape") { if (!gcUnmodal()) gcClose(); document.body && document.body.classList.remove("sb-open"); }
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { if (gcModal("m-cmd")) e.preventDefault(); }
  var tab = e.target && e.target.getAttribute && e.target.getAttribute("role") === "tab" ? e.target : null;
  if (tab && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    var all = [].slice.call(tab.closest("[role=tablist]").querySelectorAll("[role=tab]")), i = all.indexOf(tab);
    var nx = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]; gcTab(nx); nx.focus(); e.preventDefault();
  }
});
(function(){
  // the command menu: type to filter, arrows to move, Enter to go
  var box = document.getElementById("m-cmd"); if (!box) return;
  var q = box.querySelector("input[type=search]"), items = [].slice.call(box.querySelectorAll("li a")), none = box.querySelector(".none"), cur = 0;
  function vis(){ return items.filter(function(a){ return !a.parentNode.classList.contains("hidden"); }); }
  function mark(){ var v = vis(); items.forEach(function(a){ a.classList.remove("on"); }); if (v[cur]) v[cur].classList.add("on"); }
  function filter(){
    var s = (q.value || "").trim().toLowerCase();
    items.forEach(function(a){ a.parentNode.classList.toggle("hidden", !!s && a.textContent.toLowerCase().indexOf(s) < 0); });
    [].slice.call(box.querySelectorAll("li.gl")).forEach(function(g){
      var n = g.nextElementSibling, any = false;
      while (n && !n.classList.contains("gl")) { if (!n.classList.contains("hidden")) any = true; n = n.nextElementSibling; }
      g.classList.toggle("hidden", !any);
    });
    cur = 0; mark(); if (none) none.classList.toggle("hidden", vis().length > 0);
  }
  if (q) {
    q.addEventListener("input", filter);
    q.addEventListener("keydown", function(e){
      var v = vis();
      if (e.key === "ArrowDown") { cur = Math.min(cur + 1, v.length - 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { cur = Math.max(cur - 1, 0); mark(); e.preventDefault(); }
      else if (e.key === "Enter" && v[cur]) { e.preventDefault(); v[cur].click(); }
    });
  }
  items.forEach(function(a){ a.addEventListener("click", function(){ gcUnmodal(); if (q) { q.value = ""; filter(); } }); });
  filter();
})();
(function(){
  // the search's shortcut as this keyboard writes it
  try { if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) [].slice.call(document.querySelectorAll(".sb-search kbd")).forEach(function(k){ k.textContent = "Ctrl K"; }); } catch (e) {}
})();
(function(){
  // the tour: a walk through the parts marked data-tour="<order>|<title>|<text>" (data-tour-view: the dashboard view
  // to open first, through window.gcDash), shown once per page kind (body data-tour-auto) on a visitor's first visit,
  // and again from Help (data-tour-start). A dashboard with no data yet fills in the sample's stats for the walk
  // (gcDash.tourStart) and puts its own back at the end (gcDash.tourEnd). A part that is not on screen is skipped.
  var kind = document.body ? document.body.getAttribute("data-tour-auto") : null;
  var KEY = "gc-tour" + (kind ? "-" + kind : "");
  var spot = null, pop = null, list = [], at = 0, back = null, rail = null, sampled = false, dir = 1;
  var D = function(){ return window.gcDash || null; };
  function steps(){
    var s = [].slice.call(document.querySelectorAll("[data-tour]")).map(function(n){
      var p = n.getAttribute("data-tour").split("|"); return { i: Number(p[0]) || 0, t: p[1] || "", d: p[2] || "", n: n, v: n.getAttribute("data-tour-view") };
    });
    s.sort(function(a, b){ return a.i - b.i; });
    var hi = { t: "Welcome to GenClass", d: sampled ? "Your app hasn't sent data yet, so this tour fills in sample data to show where everything goes." : "Here's a quick look around. It takes a minute.", n: null };
    var connect = sampled && document.getElementById("hconnect");
    var bye = { t: "You're all set", d: connect ? "Connect your app and your own data takes the sample's place." : "Take the tour again any time from Help.", n: null, connect: !!connect };
    return [hi].concat(s, [bye]);
  }
  function seen(n){ var r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function done(){
    try { localStorage.setItem(KEY, "done"); } catch (e) {}
    if (spot) spot.remove(); if (pop) pop.remove(); spot = pop = null;
    if (rail) rail.classList.remove("tour");
    document.removeEventListener("keydown", key, true); window.removeEventListener("resize", place);
    var d = D(); if (d && d.tourEnd) try { d.tourEnd(); } catch (e) {}
    try { window.scrollTo(0, 0); } catch (e) {}
    if (back && back.focus) try { back.focus({ preventScroll: true }); } catch (e) {}
  }
  function key(e){
    if (!pop) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(at + 1, 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(at - 1, -1); }
  }
  function place(){
    if (!pop || !list[at]) return;
    // the layout viewport's own size (window.innerWidth grows with a page wider than a phone's screen)
    var s = list[at], de = document.documentElement, vw = de.clientWidth || window.innerWidth, vh = de.clientHeight || window.innerHeight, pw = pop.offsetWidth, ph = pop.offsetHeight, x, y;
    if (!s.n) { spot.className = "tour-spot mid"; spot.style.top = spot.style.left = "50%"; spot.style.width = spot.style.height = "0px"; pop.style.left = Math.max(16, (vw - pw) / 2) + "px"; pop.style.top = Math.max(16, (vh - ph) / 2) + "px"; return; }
    var r = s.n.getBoundingClientRect(), pad = 6;
    // the part of it on screen (a tall section is cut at the viewport)
    // (under the sticky header, unless the part is in the header)
    var hd = document.querySelector(".sb-top"), hb = hd && !hd.contains(s.n) ? hd.getBoundingClientRect().bottom + 4 : 0;
    var top = Math.max(r.top, hb), bottom = Math.min(r.bottom, vh - 8), left = Math.max(r.left, 0), right = Math.min(r.right, vw);
    spot.className = "tour-spot";
    var st = Math.max(top - pad, 0); spot.style.top = st + "px"; spot.style.left = (left - pad) + "px"; spot.style.width = (right - left + pad * 2) + "px"; spot.style.height = Math.max(0, bottom + pad - st) + "px";
    if (bottom - top > vh * 0.5) {
      // tall: beside it when there is room, else in its lower right corner
      if (vw - right > pw + 32) { x = right + 16; y = Math.min(Math.max(16, top + 24), vh - ph - 16); }
      else { x = right - pw - 24; y = bottom - ph - 24; }
    } else if (bottom + 14 + ph < vh) { y = bottom + 14; x = left + (right - left) / 2 - pw / 2; }
    else { y = top - 14 - ph; x = left + (right - left) / 2 - pw / 2; }
    pop.style.left = Math.min(Math.max(16, x), vw - pw - 16) + "px"; pop.style.top = Math.min(Math.max(16, y), vh - ph - 16) + "px";
  }
  function go(i, d){
    dir = d || 1;
    if (i < 0) return; if (i >= list.length) { done(); return; }
    var s = list[i], dash = D();
    if (s.n) {
      if (s.v && dash && dash.view) try { dash.view(s.v); } catch (e) {}
      if (!seen(s.n)) { go(i + dir, dir); return; }
    }
    at = i; var last = i === list.length - 1;
    if (rail) rail.classList.toggle("tour", !!(s.n && rail.contains(s.n)));
    pop.querySelector("h2").textContent = s.t; pop.querySelector("p").textContent = s.d;
    pop.querySelector(".tour-n").textContent = i === 0 || last ? "" : i + " / " + (list.length - 2);
    var prev = pop.querySelector("[data-prev]"), next = pop.querySelector("[data-next]"), skip = pop.querySelector("[data-skip]");
    prev.hidden = i === 0; skip.hidden = last;
    next.textContent = i === 0 ? "Show me" : last ? (s.connect ? "Connect my app" : "Done") : "Next";
    if (s.n && s.n.scrollIntoView) {
      var r = s.n.getBoundingClientRect();
      try { s.n.scrollIntoView({ block: r.height > (document.documentElement.clientHeight || window.innerHeight) * 0.5 ? "start" : "center" }); } catch (e) { try { s.n.scrollIntoView(); } catch (x) {} }
    }
    place(); setTimeout(place, 200);
    try { next.focus({ preventScroll: true }); } catch (e) {}
  }
  function build(){
    list = steps(); at = 0;
    spot = document.createElement("div"); spot.className = "tour-spot mid"; spot.setAttribute("aria-hidden", "true");
    pop = document.createElement("div"); pop.className = "tour-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-labelledby", "tour-h");
    pop.innerHTML = '<h2 id="tour-h"></h2><p></p><div class="tour-f"><span class="tour-n" aria-live="polite"></span><button class="btn sm text" type="button" data-skip>Skip</button><button class="btn sm ghost" type="button" data-prev>Back</button><button class="btn sm" type="button" data-next>Next</button></div>';
    pop.querySelector("[data-skip]").addEventListener("click", done);
    pop.querySelector("[data-prev]").addEventListener("click", function(){ go(at - 1, -1); });
    pop.querySelector("[data-next]").addEventListener("click", function(){
      var s = list[at];
      if (at === list.length - 1 && s && s.connect) { done(); if (typeof gcModal === "function") gcModal("m-connect"); return; }
      go(at + 1, 1);
    });
    document.body.appendChild(spot); document.body.appendChild(pop);
    document.addEventListener("keydown", key, true); window.addEventListener("resize", place);
    go(0, 1);
  }
  function start(){
    if (pop) done();
    gcClose(); gcUnmodal(); back = document.activeElement; rail = document.querySelector(".sb-rail");
    var d = D(), prep = d && d.tourStart ? d.tourStart() : null;
    Promise.resolve(prep).then(function(x){ sampled = !!x; build(); }, function(){ sampled = false; build(); });
  }
  window.gcTour = start;
  document.addEventListener("click", function(e){ var t = e.target && e.target.closest ? e.target.closest("[data-tour-start]") : null; if (t) { e.preventDefault(); start(); } });
  var seenTour = "done"; try { seenTour = localStorage.getItem(KEY); } catch (e) {}
  if (kind && !seenTour && window.innerWidth >= 768) setTimeout(function(){ if (!document.querySelector(".sb-modal.open")) start(); }, 700);
})();
(function(){
  // the Protect dialog of an open private link: a passkey or a password, then the page again (now protected)
  var f = document.getElementById("lk-form"); if (!f || typeof gcLkWire !== "function") return;
  var m = /^\\/dashboard\\/([A-Za-z0-9]{32})$/.exec(location.pathname); if (!m) return;
  var base = "/api/link/" + m[1] + "/lock", err = f.querySelector(".lk-err"), b = f.querySelector("button[type=submit]");
  gcLkWire(f);
  f.addEventListener("submit", function(e){
    e.preventDefault(); err.textContent = ""; b.disabled = true;
    gcLkBody(f, base + "/passkey", {}).then(function(body){ return gcLkPost(base, body); })
      .then(function(){ location.reload(); })
      .catch(function(x){ err.textContent = gcLkWhy(x); b.disabled = false; });
  });
})();

// the sidebar's plan card and Get started count, from the server's own words (GET /api/account/glance); without them
// the card keeps its plan's name and Plans and billing
(function(){
  var card = document.getElementById("sb-plan"), gs = document.getElementById("gs-n");
  if ((!card && !gs) || !window.fetch) return;
  // after the page's own requests (its stats first)
  setTimeout(function(){ fetch("/api/account/glance", { credentials: "same-origin", headers: { accept: "application/json" } }).then(function(r){ return r.ok ? r.json() : null; }).then(function(g){
    if (!g || !g.ok) return;
    if (gs && g.steps && g.steps.length) {
      var n = 0; g.steps.forEach(function(x){ if (x.done) n++; });
      gs.textContent = n + "/" + g.steps.length; if (n === g.steps.length) gs.classList.add("done");
    }
    if (!card) return;
    var nm = document.getElementById("sbp-n"), st = document.getElementById("sbp-s"), m = document.getElementById("sbp-m"), p = document.getElementById("sbp-p"), a = document.getElementById("sbp-a");
    if (nm && g.plan) nm.textContent = g.plan;
    if (st) st.textContent = g.status || "";
    if (g.trial) card.setAttribute("data-trial", "");
    if (m && g.apps && g.apps.of) { m.hidden = false; var bar = m.querySelector("i"); if (bar) bar.style.width = Math.min(100, Math.round((g.apps.used / g.apps.of) * 100)) + "%"; }
    if (p && g.note) { p.hidden = false; p.textContent = g.note; }
    if (a && g.action && g.action.href) { a.textContent = g.action.label; a.setAttribute("href", g.action.href); a.className = "btn sm" + (g.action.primary ? "" : " ghost"); }
  }).catch(function(){}); }, 400);
})();
`;

// --------------------------------------------------------------------------------------------- the document

/** A link in the rail: its icon, its label (shown when the rail widens) and an optional count (an element id). */
export interface RailItem {
  href: string;
  label: string;
  icon: IconName;
  /** id of a count element the page script fills (e.g. "c-found"). */
  count?: string;
  current?: boolean;
  /** an element id for the link */
  id?: string;
  /** only in the rail below 901px, where the product menu that holds it is hidden; never in the command menu */
  phoneOnly?: boolean;
}

/** A product menu: a title and groups of links; `view` shows it only with that view (data-v). */
export interface ProductMenu {
  title: string;
  view?: string;
  groups: { label?: string; items: { href: string; label: string; icon?: IconName; current?: boolean }[] }[];
}

export interface StudioOptions {
  title: string;
  /** An account page: the referrer policy `same-origin` (pages.ts securityHeaders), which the meta tag repeats. */
  account?: boolean;
  /** The organization crumb (the account, its plan) or null on a private link. */
  org: { name: string; plan: string | null; href: string } | null;
  /** The account's projects (apps), for the project switcher and the command menu. */
  projects?: { id: string; name: string }[];
  /** The project crumb on a project's pages; `id` marks it current in the switcher. */
  project?: { name: string; id?: string } | null;
  /** A badge after the project crumb (e.g. the live status), as HTML. */
  status?: string;
  /** The header's Connect button: Studio makes it primary while a project is new. */
  connect?: "primary" | "default" | null;
  /** The signed-in person (the account menu), or null: a Sign in button. */
  user: { label: string; sub?: string } | null;
  /** The rail: groups (a rule between them) and the items pinned to its foot. */
  rail: RailItem[][];
  railEnd?: RailItem[];
  /** The rail's accessible name. */
  railLabel: string;
  /** Product menus (each shown with its view, or always). */
  menus?: ProductMenu[];
  /** Extra command-menu entries, by group. */
  commands?: { group: string; label: string; href: string; icon?: IconName }[];
  /** The page, inside <main>; its first element should be the page's own container. */
  body: string;
  /** The page's script (after the frame's). */
  script: string;
  /** The page's own CSS, after the frame's. */
  css?: string;
  /** Show the tour on a visitor's first visit to this kind of page (e.g. "dashboard"); Help > Take the tour always can. */
  tour?: string;
  /**
   * A private dashboard link (no organization). Protected, the crumb shows a lock; open, the header offers Protect (a
   * passkey or a password), whose script finds the link's lock endpoint from the address (the secret is never written
   * into the page).
   */
  link?: { locked: boolean } | null;
  /** Which workspace link is the page's own: Get started, Home (the apps), or none (an app's pages mark the app). */
  here?: "start" | "home" | null;
}

const railLink = (r: RailItem): string =>
  `<a href="${esc(r.href)}"${r.id ? ` id="${esc(r.id)}"` : ""}${r.phoneOnly ? ' class="ph-only"' : ""}${r.current ? ' aria-current="true"' : ""} title="${esc(r.label)}">${icon(r.icon, 20)}<span class="lbl">${esc(r.label)}</span>${
    r.count ? `<span class="cnt" id="${esc(r.count)}"></span>` : ""
  }</a>`;

function productMenu(m: ProductMenu): string {
  const groups = m.groups
    .map(
      (g) =>
        `<div class="g">${g.label ? `<span class="gl">${esc(g.label)}</span>` : ""}${g.items
          .map((i) => `<a href="${esc(i.href)}"${i.current ? ' aria-current="true"' : ""}>${i.icon ? icon(i.icon, 14) : ""}${esc(i.label)}</a>`)
          .join("")}</div>`,
    )
    .join("");
  return `<nav class="sb-pm"${m.view ? ` data-v="${esc(m.view)}"` : ""} aria-label="${esc(m.title)}"><div class="t">${esc(m.title)}</div>${groups}</nav>`;
}

/**
 * The workspace switcher at the top of the sidebar: the organization (the account) with its plan, and its pages; on a
 * private link a static "Private link" box.
 */
function workspace(o: StudioOptions): string {
  return o.org
    ? `<div class="dd sb-org sb-ws"><button class="sb-cr" type="button" data-dd aria-haspopup="menu" aria-expanded="false"><span class="av" aria-hidden="true">${esc((o.org.name.replace(/^@/, "").charAt(0) || "?").toUpperCase())}</span><span class="nm">${esc(o.org.name)}</span>${
        o.org.plan ? badge(o.org.plan) : ""
      }${icon("chevrons", 14)}</button><div class="dd-m" role="menu" hidden><span class="dd-l">Organization</span><a href="${esc(o.org.href)}" aria-current="true">${esc(
        o.org.name,
      )}</a><hr><a href="/account">${icon("box", 14)}All apps</a><a href="/account/billing">${icon("receipt", 14)}Billing</a><a href="/account#settings">${icon(
        "settings",
        14,
      )}Account settings</a></div></div>`
    : `<div class="sb-ws"><span class="sb-cr static sb-org">${o.link?.locked ? `<span class="sb-lk" title="Protected">${icon("lock", 13)}</span>` : ""}<span class="nm">Private link</span>${badge("Free")}</span></div>`;
}

/** The header: the project switcher (or the page's name), Connect; search, the theme, help and the account. */
function header(o: StudioOptions): string {
  const p = o.project;
  let projectMenu = "";
  if (p) {
    const list = (o.projects ?? []).map((x) => `<a href="/account/apps/${esc(x.id)}"${x.id === p.id ? ' aria-current="true"' : ""}>${esc(x.name)}</a>`).join("");
    projectMenu = o.org
      ? `<div class="dd"><button class="sb-cr" type="button" data-dd aria-haspopup="menu" aria-expanded="false"><span class="nm" id="hname">${esc(p.name)}</span>${icon(
          "chevrons",
          14,
        )}</button><div class="dd-m" role="menu" hidden><span class="dd-l">Apps</span>${list}<hr><a href="/account">${icon("box", 14)}All apps</a><a href="/account/new">${icon(
          "plus",
          14,
        )}New app</a></div></div>`
      : `<span class="sb-cr static"><span class="nm" id="hname">${esc(p.name)}</span></span>`;
  } else {
    projectMenu = `<span class="sb-cr static"><span class="nm">${esc(o.title.split(" | ")[0] ?? "")}</span></span>`;
  }
  const protect = o.link && !o.link.locked ? `<button class="btn sm ghost" type="button" data-open="m-protect" id="hprotect">${icon("lock", 14)}<span>Protect</span></button>` : "";
  const connect = o.connect
    ? `<button class="btn sm${o.connect === "primary" ? "" : " ghost"}" type="button" data-open="m-connect" id="hconnect" data-tour="30|Connect|Add GenClass to your app in one step.">${icon("plug", 14)}<span>Connect</span></button>`
    : "";
  const acts = connect || o.status || protect ? `<div class="sb-acts">${o.status ?? ""}${protect}${connect}</div>` : "";
  const help = `<div class="dd" data-tour="90|Help|Docs, feedback, and this tour again."><button class="sb-ib" type="button" data-dd aria-haspopup="menu" aria-expanded="false" aria-label="Help">${icon("help", 15)}</button><div class="dd-m end" role="menu" hidden><button type="button" data-tour-start>${icon(
    "compass",
    14,
  )}Take the tour</button><a href="https://genclass.dev/docs">${icon("book", 14)}Docs</a><a href="https://discord.gg/kN9kRnFtZm">${icon("message", 14)}Discord</a><a href="https://github.com/genclass-dev/GenClass/issues/new">${icon(
    "sparkles",
    14,
  )}Send feedback</a><a href="https://github.com/genclass-dev/GenClass/issues/new?title=False%20detection%3A%20">${icon("alert", 14)}Report a false detection</a>${
    o.org ? "" : `<a href="/start">${icon("plus", 14)}New dashboard</a>`
  }<hr><a href="https://genclass.dev/privacy">${icon("shield", 14)}Privacy</a><a href="https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md">${icon("file", 14)}What is collected</a></div></div>`;
  const me = o.user
    ? `<div class="dd"><button class="sb-av" type="button" data-dd aria-haspopup="menu" aria-expanded="false" aria-label="Account">${esc((o.user.label.replace(/^@/, "").charAt(0) || "?").toUpperCase())}</button><div class="dd-m end" role="menu" hidden><div class="who">${esc(
        o.user.label,
      )}${o.user.sub ? `<small>${esc(o.user.sub)}</small>` : ""}</div><hr><a href="/account">${icon("box", 14)}All apps</a><a href="/account#settings">${icon("settings", 14)}Account settings</a><a href="/account/billing">${icon(
        "receipt",
        14,
      )}Billing</a><hr><form method="post" action="/logout"><button type="submit">${icon("logout", 14)}Sign out</button></form></div></div>`
    : `<a class="btn sm ghost sb-in" href="/login" aria-label="Sign in">${icon("user", 14)}<span>Sign in</span></a>`;
  return `<header class="sb-top">
<button class="sb-ib sb-burger" type="button" data-burger aria-label="Menu" aria-expanded="false">${icon("menu", 15)}</button>
<a class="sb-home" href="${o.user ? "/account" : "https://genclass.dev/"}" aria-label="${o.user ? "All apps" : "GenClass"}">${MARK}</a>
<nav class="sb-crumbs" aria-label="Breadcrumb" data-tour="${o.org ? "10|Your apps|Switch apps here or in the menu." : "10|Your app|You're looking at this app's dashboard."}">${projectMenu}</nav>
${acts}
<div class="sb-mid"><button class="sb-search" type="button" data-open="m-cmd" aria-label="Search" data-tour="20|Search|Find any page, problem or setting.">${icon("search", 15)}<span>Search pages, problems, settings…</span><kbd>⌘K</kbd></button></div>
<div class="sb-right">
<span data-tour="80|Light or dark|Pick the look you like.">${themeButton("sb-ib")}</span>
${help}
${me}
</div>
</header>`;
}

/** The Protect dialog of an open private link: a passkey (when the browser has them) or a password. */
function protectDialog(): string {
  return `<div class="sb-modal" id="m-protect" role="dialog" aria-modal="true" aria-labelledby="m-protect-h"><div class="sb-mbox sm">
<div class="sb-mh"><h2 id="m-protect-h">Protect this dashboard</h2><button class="sb-x" type="button" data-close aria-label="Close">${icon("x", 16)}</button></div>
<form class="sb-mb lk-f" id="lk-form" data-lock>
<div class="lk-choice" role="radiogroup" aria-label="Protect with"><label><input type="radio" name="lock" value="passkey">Passkey</label><label><input type="radio" name="lock" value="password" checked>Password</label></div>
<div data-pw><label for="lk-pw">Password</label><input type="password" id="lk-pw" name="password" autocomplete="new-password" minlength="10" placeholder="At least 10 characters"></div>
<p class="lk-err" role="alert"></p>
<div class="row"><button class="btn" type="submit">${icon("lock", 14)}Protect</button><button class="btn ghost" type="button" data-close>Not now</button></div>
</form></div></div>`;
}

/** The command menu: every rail link, the product menus, the projects and the page's own commands. */
function commandMenu(o: StudioOptions): string {
  const groups: Record<string, string[]> = {};
  const add = (g: string, label: string, href: string, ic: IconName) => (groups[g] ??= []).push(`<li><a href="${esc(href)}">${icon(ic, 16)}${esc(label)}</a></li>`);
  for (const r of [...o.rail.flat(), ...(o.railEnd ?? [])]) if (!r.phoneOnly) add(o.project ? "Project" : "Organization", r.label, r.href, r.icon);
  for (const m of o.menus ?? []) for (const g of m.groups) for (const i of g.items) add(m.title, i.label, i.href, i.icon ?? "file");
  for (const c of o.commands ?? []) add(c.group, c.label, c.href, c.icon ?? "file");
  for (const p of o.projects ?? []) add("Apps", p.name, `/account/apps/${p.id}`, "box");
  const list = Object.entries(groups)
    .map(([g, items]) => `<li class="gl">${esc(g)}</li>${items.join("")}`)
    .join("");
  return `<div class="sb-modal sb-cmd" id="m-cmd" role="dialog" aria-modal="true" aria-label="Command menu"><div class="sb-mbox">
<input type="search" placeholder="Search pages, problems, settings…" aria-label="Search" autocomplete="off" spellcheck="false">
<ul>${list}</ul><p class="none hidden">No results.</p></div></div>`;
}

/**
 * How much larger than written the frame draws everything (the owner, 2026-11-12: the dashboard looked "a bit too
 * zoomed out"). CSS `zoom` would do it, but it also scales viewport units (the menu ran past the window) and the
 * positions the scripts set from measurements (the tour landed off center), so the lengths themselves are scaled.
 */
export const FRAME_SCALE = 1.1;

/**
 * `css` with every length in px multiplied by `k` (to a tenth of a pixel), so the page is drawn that much larger, as a
 * browser zoom would draw it. Lengths of 2px or less (hairlines, outlines, focus rings) and the conditions of @media
 * rules (the breakpoints are the window's own size) stay as written.
 */
export function scaleCss(css: string, k: number = FRAME_SCALE): string {
  if (k === 1) return css;
  return css
    .split(/(@media[^{]*\{)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(^|[^\w.#-])(-?)(\d*\.?\d+)px\b/g, (m, pre: string, sign: string, n: string) => {
            const v = Number(n);
            return v <= 2 ? m : `${pre}${sign}${Math.round(v * k * 10) / 10}px`;
          }),
    )
    .join("");
}

/** From this window width up the frame is drawn FRAME_SCALE larger; a phone keeps the sizes as written (they fit 375px). */
export const SCALE_FROM_PX = 768;

/**
 * `html` with each of its <style> elements followed, inside the same element, by its CSS scaled (scaleCss) for windows
 * SCALE_FROM_PX wide and wider, which overrides the written sizes there; scripts and markup are left as they are.
 */
const scaleStyles = (html: string): string =>
  html.replace(/(<style nonce="[^"]*">)([\s\S]*?)(<\/style>)/g, (_m, a: string, css: string, b: string) => `${a}${css}@media (min-width:${SCALE_FROM_PX}px){${sizesOnly(scaleCss(css))}}${b}`);

/**
 * The scaled copy without the custom properties that hold no length (the colour tokens and the like): the written ones
 * apply as they are, so the page keeps one set of tokens. Every other declaration stays, so the copy cascades as the
 * written CSS does; rules left empty are dropped.
 */
const sizesOnly = (css: string): string =>
  css
    .replace(/--[\w-]+:[^;{}]*(;|(?=\}))/g, (d) => (/\dpx/.test(d) ? d : ""))
    .replace(/[^{};]+\{\}/g, "");

/**
 * The whole document: head (fonts, the frame's CSS, the page's CSS), the header, the rail, the product menus, <main>
 * with the page, the command menu, and one script (the copy helpers, the frame, the page). On a window SCALE_FROM_PX
 * wide or wider, every <style> in it is drawn FRAME_SCALE larger than written (scaleStyles).
 */
export function studioPage(nonce: string, o: StudioOptions): string {
  const rail = o.rail.map((g) => g.map(railLink).join("")).join("<hr>");
  const end = o.railEnd?.length ? `<div class="end">${o.railEnd.map(railLink).join("")}</div>` : "";
  const here = o.here ?? null;
  const cur = (on: boolean): string => (on ? ' aria-current="page"' : "");
  // signed in: Get started (its steps done, from /api/account/glance), Home (the apps), each app, New app
  const work = o.org
    ? `<nav class="sb-nav" aria-label="Workspace"><a href="/account/get-started"${cur(here === "start")}>${icon("rocket", 18)}<span class="lbl">Get started</span><span class="cnt" id="gs-n"></span></a><a href="/account"${cur(here === "home")}>${icon("home", 18)}<span class="lbl">Home</span></a><span class="sb-gl">Apps</span>${(o.projects ?? [])
        .map((x) => `<a class="sb-app" href="/account/apps/${esc(x.id)}"${cur(!!o.project && o.project.id === x.id)}>${icon("box", 16)}<span class="lbl">${esc(x.name)}</span></a>`)
        .join("")}<a class="sb-add" href="/account/new">${icon("plus", 16)}<span class="lbl">New app</span></a></nav>`
    : "";
  // the plan card: the server's words for the plan (filled from /api/account/glance), and Plans and billing
  const plan = o.org
    ? `<div class="sb-plan" id="sb-plan"><div class="sb-plan-h"><b id="sbp-n">${esc(o.org.plan ?? "Free")}</b><span id="sbp-s">plan</span></div><div class="sb-meter" id="sbp-m" hidden><i></i></div><p id="sbp-p" hidden></p><a class="btn sm ghost" id="sbp-a" href="/account/billing">Plans and billing</a></div>`
    : "";
  const side = `<div class="sb-side"><a class="sb-brand" href="${o.user ? "/account" : "https://genclass.dev/"}">${MARK}<span>GenClass</span></a>
${workspace(o)}
<div class="sb-scroll">${work}${o.project ? `<span class="sb-gl">${esc(o.project.name)}</span>` : ""}<nav class="snav" id="snav" aria-label="${esc(o.railLabel)}" data-tour="40|Menu|Every part of your dashboard. Let's open each one.">${rail}${end}</nav></div>
<div class="sb-foot">${plan}<nav aria-label="Help"><a class="sb-doc" href="https://genclass.dev/docs" target="_blank" rel="noopener">${icon("book", 18)}<span class="lbl">Documentation</span><span class="ext">${icon("external", 13)}</span></a></nav></div>
</div>`;
  const menus = o.menus?.length ? `<aside class="sb-menu">${o.menus.map(productMenu).join("")}</aside>` : "";
  return scaleStyles(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="${o.account ? "same-origin" : "no-referrer"}">
<title>${esc(o.title)}</title>
${ICON_LINKS}
${THEME_COLOR_METAS("#0C0E12", "#FAF8F4")}
<script nonce="${nonce}">${THEME_HEAD_JS}</script>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${STUDIO_FONTS}">
<style nonce="${nonce}">${STUDIO_CSS}${o.css ?? ""}</style>
</head>
<body class="sb"${o.tour ? ` data-tour-auto="${esc(o.tour)}"` : ""}>
<a class="skip" href="#mc">Skip to content</a>
<div class="sb-shell">
<div class="sb-rail">${side}</div>
<div class="sb-col">
${header(o)}
<div class="sb-body">
${menus}
<main class="wrap" id="main">${o.body}</main>
</div>
</div>
</div>
${commandMenu(o)}
${o.link && !o.link.locked ? protectDialog() : ""}
<script nonce="${nonce}">${COPY_JS}${THEME_JS}${o.link && !o.link.locked ? LOCK_JS : ""}${STUDIO_JS}${o.script}</script>
</body>
</html>`);
}
