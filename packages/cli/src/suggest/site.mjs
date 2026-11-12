// Facts about a live site for `genclass suggest`, measured with a handful of GET requests and three DNS lookups.
//
// Invariants:
// - Nothing here throws or rejects to the caller: every request and lookup is wrapped and timed. A failure leaves
//   that fact null, which the checks report as "unknown", never as a failure of the site.
// - Only public sites: an address that is not http or https, or whose host is localhost, a loopback or private
//   address, a single-label name, or ends in .local, .internal or .localhost, is refused before any request. The same
//   test runs on every redirect hop, so a public address cannot send the reader to a private one.
// - Only GET, with the user agent "genclass-cli (+https://genclass.dev)". Redirects are followed by hand (at most 5
//   hops) so each hop is a fact. Every request has a timeout (default 8 s) and at most 1 MB of a body is read.
// - Requests that do not depend on each other run in parallel; one address is requested once per run.
// - The address given is stored without its sign-in part (user:password@) and without its fragment. Error texts
//   come from a short fixed list or are an error code, never a server's own words.

import { resolveMx as nodeResolveMx, resolveTxt as nodeResolveTxt } from "node:dns/promises";

/**
 * @typedef {Object} HomeFacts
 * @property {number} status  the status of the last hop
 * @property {string} finalUrl  the address after redirects
 * @property {number} bytes  bytes of HTML read (at most 1 MB)
 * @property {string | null} title
 * @property {boolean} defaultTitle  the title is a framework's placeholder, such as "Vite + React"
 * @property {string | null} description  the meta description
 * @property {string | null} canonical
 * @property {string | null} lang
 * @property {boolean} viewport
 * @property {string[]} h1  the text of each h1 in the HTML the server sent
 * @property {{ title: string | null, description: string | null, image: string | null }} og
 * @property {string | null} twitterCard
 * @property {boolean} jsonLd
 * @property {boolean | null} favicon  a <link rel=icon> in the page, or /favicon.ico answers 200 with a file; null
 *   when the page has no link and /favicon.ico could not be requested
 * @property {boolean} noindex  a robots meta tag or an X-Robots-Tag header says noindex
 * @property {number} textChars  visible text in <body>: scripts, styles, noscript and tags removed, whitespace collapsed
 * @property {number} scripts  script tags that hold or load JavaScript
 * @property {boolean} testStripeKey  pk_test_ appears in the HTML
 * @property {boolean} stripe  the HTML loads js.stripe.com or holds a Stripe publishable key (live or test)
 * @property {boolean} mentionsPrice  the visible text holds a currency amount, "per month" or "/mo"
 * @property {boolean} pricingLink  a link whose address or text contains "pricing" or "plans"
 * @property {string | null} generator
 * @property {boolean} hsts  the answer has a Strict-Transport-Security header
 *
 * @typedef {Object} SiteFacts
 * @property {string} url  the address measured (as given when it was refused)
 * @property {string} origin
 * @property {string} host
 * @property {boolean} reachable  the home page answered, with any status
 * @property {string | null} error  why not, in a few words
 * @property {number} elapsedMs
 * @property {{ ok: boolean | null, httpRedirects: boolean | null }} https
 *   ok: the https address answered (false: refused or a bad certificate; null: could not be told);
 *   httpRedirects: http://host ends at an https address (null: http did not answer)
 * @property {{ other: string, joined: boolean | null }} www
 *   other: the www or bare twin of the host; joined: both end at one host (null: the twin did not answer)
 * @property {HomeFacts | null} home
 * @property {{ status: number | null, html: boolean, allowsAll: boolean | null, blockedAi: string[], sitemaps: string[] }} robots
 *   html: /robots.txt answered with an HTML page, not a robots file (a single-page app's catch-all does this);
 *   allowsAll: false when "User-agent: *" is disallowed from "/"; blockedAi: the AI crawlers disallowed from "/"
 * @property {{ url: string | null, status: number | null, valid: boolean | null, urls: number | null }} sitemap
 * @property {{ status: number | null, html: boolean }} llms
 * @property {{ status: number | null }} notFound  the answer for a path that cannot exist; 200 is a "soft 404"
 * @property {{ mx: boolean | null, spf: boolean | null, dmarc: boolean | null }} dns
 *   on the host without a leading "www."; null when a lookup failed for a reason other than "no records"
 */

const USER_AGENT = "genclass-cli (+https://genclass.dev)";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY = 1024 * 1024;
const MAX_HOPS = 5;
const NOT_FOUND_PATH = "/genclass-check-404-b7f3k9q2x";

/** The crawlers AI assistants read sites with, as they name themselves in robots.txt. */
export const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "CCBot", "Bytespider"];

const DEFAULT_TITLES = new Set(
  ["Vite + React", "Vite + React + TS", "Vite + Vue", "Vite + Vue + TS", "Vite + Svelte", "Vite + Svelte + TS", "Vite + Preact", "Vite + Solid", "Vite + Lit", "Vite App", "Create Next App", "React App", "Welcome to Nuxt!", "Nuxt", "SvelteKit", "Welcome to SvelteKit", "Astro", "Welcome to Astro", "Astro Basics", "New Remix App", "New React Router App", "Create T3 App", "v0 App", "Lovable App", "Lovable Generated Project", "Document", "Home", "Untitled", "My App", "App"].map((t) =>
    t.toLowerCase(),
  ),
);

const NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•", euro: "€", pound: "£", yen: "¥", cent: "¢" };

// One tag, where a ">" inside a quoted attribute value does not end it.
const TAG_BODY = "(?:[^>\"']|\"[^\"]*\"|'[^']*')*";
const ANY_TAG = new RegExp(`<\\/?[a-zA-Z]${TAG_BODY}>|<![^>]*>`, "g");
const tagRe = (name) => new RegExp(`<${name}\\b(${TAG_BODY})>`, "gi");

const PRICE = /[$€£¥₹]\s?\d|\d\s?[€£]|\b\d[\d.,]*\s?(?:USD|EUR|GBP|CAD|AUD)\b|\bper\s+(?:month|year|user|seat)\b|\/\s?(?:mo|month|yr|year)\b/i;

// ---- addresses -----------------------------------------------------------------------------------------------------

/**
 * Whether a host name is one a public site can live at: not localhost, not a loopback, private or link-local
 * address (IPv4 or IPv6), not a single-label name, and not under .local, .internal or .localhost.
 * @param {string} hostname  as URL.hostname gives it (IPv6 in brackets is fine)
 * @returns {boolean}
 */
export function isPublicHost(hostname) {
  let h = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes(":")) return publicV6(h);
  if (/^\d+(?:\.\d+){3}$/.test(h)) return publicV4(h.split(".").map(Number));
  if (/^[\d.]+$/.test(h) || /^0x/.test(h)) return false;
  if (h === "localhost" || /\.(?:localhost|local|internal)$/.test(h)) return false;
  return h.includes(".");
}

function publicV4([a, b]) {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return a < 224;
}

function publicV6(h) {
  if (h === "::1" || h === "::") return false;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return publicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const dotted = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (dotted) return publicV4(dotted.slice(1).map(Number));
  return !/^f[cd]/.test(h) && !/^fe[89ab]/.test(h);
}

/** The address to measure, or why it is refused. A bare host gets https:// in front. */
function normalise(input) {
  let s = typeof input === "string" ? input.trim() : "";
  if (!s) return { error: "no address given" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // "example.com:8080" is a host and a port; "mailto:me@example.com" or "javascript:..." is another scheme.
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/i.test(s)) return { error: "not an http or https address" };
    s = `https://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "not a valid address" };
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "not an http or https address", u };
  if (!isPublicHost(u.hostname)) return { error: "not a public address: the checks are for a site on the internet", u };
  return { u };
}

// ---- requests ------------------------------------------------------------------------------------------------------

/** A short, fixed description of a failed request: "timeout" or an error code such as ENOTFOUND. */
function errorName(e) {
  try {
    const name = e && typeof e === "object" ? String(e.name ?? "") : "";
    if (name === "AbortError" || name === "TimeoutError") return "timeout";
    const code = e && typeof e === "object" ? ((e.cause && typeof e.cause === "object" && e.cause.code) ?? e.code) : null;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(code)) return code;
  } catch {
    /* fall through */
  }
  return "request failed";
}

function headerReader(headers) {
  return (name) => {
    try {
      if (headers && typeof headers.get === "function") {
        const v = headers.get(name);
        return v == null ? null : String(v);
      }
      if (headers && typeof headers === "object") {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return String(headers[key]);
      }
    } catch {
      /* no header */
    }
    return null;
  };
}

/** At most `max` bytes of a response's body, as text. */
async function readBody(res, max) {
  try {
    const body = res.body;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      const chunks = [];
      let n = 0;
      while (n < max) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const take = value.length > max - n ? value.subarray(0, max - n) : value;
        chunks.push(take);
        n += take.length;
      }
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        /* the stream is already closed */
      }
      const all = new Uint8Array(n);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      return { text: new TextDecoder("utf-8").decode(all), bytes: n };
    }
    if (typeof res.text === "function") {
      const bytes = new TextEncoder().encode(String(await res.text()));
      const cut = bytes.length > max ? bytes.subarray(0, max) : bytes;
      return { text: new TextDecoder("utf-8").decode(cut), bytes: cut.length };
    }
  } catch {
    /* an unreadable body is an empty one */
  }
  return { text: "", bytes: 0 };
}

/**
 * One GET, never followed, never rejecting.
 * @returns {Promise<{ ok: true, status: number, header: (name: string) => string | null, text: string, bytes: number } | { ok: false, error: string }>}
 */
async function getOnce(fetchFn, url, timeoutMs) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "not a valid address" };
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !isPublicHost(u.hostname)) return { ok: false, error: "not a public address" };

  const ctrl = new AbortController();
  let timer = null;
  const timeout = new Promise((done) => {
    timer = setTimeout(() => {
      try {
        ctrl.abort();
      } catch {
        /* already gone */
      }
      done({ ok: false, error: "timeout" });
    }, timeoutMs);
  });
  const work = (async () => {
    try {
      const res = await fetchFn(url, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.8" } });
      const status = Number(res && res.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) return { ok: false, error: "request failed" };
      const header = headerReader(res.headers);
      if (status >= 300 && status < 400 && header("location")) {
        try {
          if (res.body && typeof res.body.cancel === "function") Promise.resolve(res.body.cancel()).catch(() => {});
        } catch {
          /* nothing to cancel */
        }
        return { ok: true, status, header, text: "", bytes: 0 };
      }
      const body = await readBody(res, MAX_BODY);
      return { ok: true, status, header, text: body.text, bytes: body.bytes };
    } catch (e) {
      return { ok: false, error: errorName(e) };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** GET with redirects followed by hand. `chain` lists each hop; `res` is the last answer. */
async function follow(get, url) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await get(current);
    if (!res.ok) return { ok: false, error: res.error, chain, finalUrl: current, res: null };
    chain.push({ url: current, status: res.status });
    const location = res.status >= 300 && res.status < 400 ? res.header("location") : null;
    if (!location) return { ok: true, error: null, chain, finalUrl: current, res };
    try {
      const next = new URL(location, current);
      next.hash = "";
      current = next.href;
    } catch {
      return { ok: true, error: null, chain, finalUrl: current, res };
    }
  }
  return { ok: false, error: "too many redirects", chain, finalUrl: current, res: null };
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Whether an answer is an HTML page (by its content type or its first characters). */
function looksHtml(res) {
  const type = (res.header("content-type") || "").toLowerCase();
  return type.includes("text/html") || /^\s*(?:<!doctype html|<html[\s>])/i.test(res.text.slice(0, 500));
}

// ---- HTML ----------------------------------------------------------------------------------------------------------

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();
const textOf = (fragment) => collapse(decodeEntities(fragment.replace(ANY_TAG, " ")));

/** The attributes of one tag, names in lower case, values with entities decoded. */
function attrs(inside) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of inside.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Remove whole elements whose content is not page text; one left open (a body cut at 1 MB) is removed to the end. */
function dropElements(html, names) {
  const closed = new RegExp(`<(${names})\\b${TAG_BODY}>[\\s\\S]*?<\\/\\1\\s*>`, "gi");
  const open = new RegExp(`<(?:${names})\\b${TAG_BODY}>[\\s\\S]*$`, "i");
  return html.replace(closed, " ").replace(open, " ");
}

function absolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * The facts one HTML page holds. Pure: no requests.
 * @param {string} html
 * @param {string} [baseUrl]  the page's address, to make relative addresses in it absolute
 * @returns {{ title: string | null, defaultTitle: boolean, description: string | null, canonical: string | null, lang: string | null, viewport: boolean, h1: string[], og: { title: string | null, description: string | null, image: string | null }, twitterCard: string | null, jsonLd: boolean, iconLink: boolean, noindex: boolean, textChars: number, scripts: number, testStripeKey: boolean, stripe: boolean, mentionsPrice: boolean, pricingLink: boolean, generator: string | null }}
 */
export function parseHtml(html, baseUrl) {
  const source = String(html ?? "");
  const doc = source.replace(/<!--[\s\S]*?-->/g, " ");
  const plain = dropElements(doc, "script|style|noscript|template");
  const base = typeof baseUrl === "string" ? baseUrl : "";
  const value = (v) => {
    const t = typeof v === "string" ? collapse(v) : "";
    return t ? t : null;
  };

  const headEnd = plain.search(/<\/head\s*>|<body\b/i);
  const head = headEnd >= 0 ? plain.slice(0, headEnd) : plain;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head) || /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(dropElements(plain, "svg"));
  const title = titleMatch ? value(textOf(titleMatch[1])) : null;

  const metas = [...plain.matchAll(tagRe("meta"))].map((m) => attrs(m[1]));
  const meta = (...keys) => {
    for (const key of keys) {
      for (const a of metas) {
        const name = (a.name || a.property || "").toLowerCase();
        if (name === key && value(a.content)) return value(a.content);
      }
    }
    return null;
  };
  const links = [...plain.matchAll(tagRe("link"))].map((m) => attrs(m[1]));
  const rel = (a) => (a.rel || "").toLowerCase().split(/\s+/);
  const canonical = links.find((a) => rel(a).includes("canonical") && value(a.href));
  const ogImage = meta("og:image", "og:image:url", "og:image:secure_url");

  const htmlTag = /<html\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(doc);
  const lang = htmlTag ? value(attrs(htmlTag[1]).lang) : null;

  const h1 = [];
  for (const m of plain.matchAll(new RegExp(`<h1\\b${TAG_BODY}>([\\s\\S]*?)<\\/h1\\s*>`, "gi"))) {
    if (h1.length < 20) h1.push(textOf(m[1]).slice(0, 200));
  }

  const bodyStart = /<body\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(plain);
  let body = bodyStart ? plain.slice(bodyStart.index + bodyStart[0].length) : plain.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ");
  const bodyEnd = body.search(/<\/body\s*>/i);
  if (bodyEnd >= 0) body = body.slice(0, bodyEnd);
  const text = textOf(body);

  let scripts = 0;
  for (const m of doc.matchAll(tagRe("script"))) {
    const type = (attrs(m[1]).type || "").toLowerCase();
    if (!type || type === "module" || type.includes("javascript")) scripts++;
  }

  let pricingLink = false;
  for (const m of plain.matchAll(new RegExp(`<a\\b(${TAG_BODY})>([\\s\\S]*?)<\\/a\\s*>`, "gi"))) {
    if (/pricing|\bplans\b/i.test(attrs(m[1]).href || "") || /pricing|\bplans\b/i.test(textOf(m[2]))) {
      pricingLink = true;
      break;
    }
  }

  const robotsMeta = metas.filter((a) => /^(?:robots|googlebot)$/i.test(a.name || "")).map((a) => a.content || "");

  return {
    title,
    defaultTitle: title !== null && DEFAULT_TITLES.has(title.toLowerCase()),
    description: meta("description"),
    canonical: canonical ? absolute(collapse(canonical.href), base || undefined) : null,
    lang,
    viewport: meta("viewport") !== null,
    h1,
    og: { title: meta("og:title"), description: meta("og:description"), image: ogImage ? absolute(ogImage, base || undefined) : null },
    twitterCard: meta("twitter:card"),
    jsonLd: /<script\b[^>]*type\s*=\s*["']?application\/ld\+json/i.test(doc),
    iconLink: links.some((a) => rel(a).includes("icon") && value(a.href) !== null),
    noindex: robotsMeta.some((content) => /\b(?:noindex|none)\b/i.test(content)),
    textChars: text.length,
    scripts,
    testStripeKey: /(?<![A-Za-z0-9_])pk_test_[A-Za-z0-9]{6,}/.test(source),
    stripe: /js\.stripe\.com|(?<![A-Za-z0-9_])pk_(?:live|test)_[A-Za-z0-9]{6,}/.test(source),
    mentionsPrice: PRICE.test(text),
    pricingLink,
    generator: meta("generator"),
  };
}

// ---- robots.txt ----------------------------------------------------------------------------------------------------

/**
 * Parse robots.txt into its groups. A group is one or more User-agent lines in a row and the Allow and Disallow
 * lines after them; a User-agent line after a rule starts a new group. Other lines (Sitemap, Crawl-delay) do not
 * end a group. Agent names are kept in lower case.
 * @param {string} text
 * @returns {{ groups: { agents: string[], rules: { allow: boolean, path: string }[] }[], sitemaps: string[] }}
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let naming = false;
  for (const raw of String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !naming) {
        current = { agents: [], rules: [] };
        groups.push(current);
        naming = true;
      }
      if (value) current.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      naming = false;
      if (current) current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "sitemap" && value) {
      sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

const coversEverything = (path) => path === "/" || path === "/*" || path === "*";

/**
 * Whether a parsed robots.txt keeps a crawler out of the whole site. The groups that name the crawler decide; only
 * when none does, the "*" groups do. A crawler is kept out when its groups hold "Disallow: /" and no "Allow: /".
 * An empty "Disallow:" allows everything.
 * @param {{ groups: { agents: string[], rules: { allow: boolean, path: string }[] }[] }} robots  from parseRobots
 * @param {string} agent  the crawler's name, such as "GPTBot", or "*"
 * @returns {boolean}
 */
export function robotsBlocks(robots, agent) {
  const name = String(agent).toLowerCase();
  const groups = robots && Array.isArray(robots.groups) ? robots.groups : [];
  const token = (a) => a.replace(/[^a-z0-9_-].*$/, "");
  const named = name === "*" ? [] : groups.filter((g) => g.agents.some((a) => token(a) === name));
  const use = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  let blocked = false;
  let allowed = false;
  for (const group of use) {
    for (const rule of group.rules) {
      if (!coversEverything(rule.path)) continue;
      if (rule.allow) allowed = true;
      else blocked = true;
    }
  }
  return blocked && !allowed;
}

// ---- DNS -----------------------------------------------------------------------------------------------------------

/** records, or [] when the name has none, or null when the lookup failed or timed out. */
async function lookup(fn, host, timeoutMs) {
  let timer = null;
  const timeout = new Promise((done) => {
    timer = setTimeout(() => done(null), timeoutMs);
  });
  const work = (async () => {
    try {
      const records = await fn(host);
      return Array.isArray(records) ? records : [];
    } catch (e) {
      const code = e && typeof e === "object" ? e.code : null;
      return code === "ENODATA" || code === "ENOTFOUND" ? [] : null;
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const txtStartsWith = (records, prefix) => records.some((chunks) => (Array.isArray(chunks) ? chunks.join("") : String(chunks)).trim().toLowerCase().startsWith(prefix));

// ---- the facts -----------------------------------------------------------------------------------------------------

/**
 * SiteFacts for a site nothing is known about: not reachable, every measured fact null. `collectSiteFacts` starts
 * from this, and tests can start from it to build facts by hand.
 * @param {string} [url]
 * @returns {SiteFacts}
 */
export function emptySiteFacts(url) {
  let origin = "";
  let host = "";
  let href = typeof url === "string" ? url : "";
  try {
    const u = new URL(href);
    u.username = "";
    u.password = "";
    u.hash = "";
    href = u.href;
    origin = u.origin === "null" ? "" : u.origin;
    host = u.hostname.toLowerCase();
  } catch {
    /* not an address: keep what was given */
  }
  return {
    url: href,
    origin,
    host,
    reachable: false,
    error: null,
    elapsedMs: 0,
    https: { ok: null, httpRedirects: null },
    www: { other: "", joined: null },
    home: null,
    robots: { status: null, html: false, allowsAll: null, blockedAi: [], sitemaps: [] },
    sitemap: { url: null, status: null, valid: null, urls: null },
    llms: { status: null, html: false },
    notFound: { status: null },
    dns: { mx: null, spf: null, dmarc: null },
  };
}

/**
 * Measure a live site: its home page, its https and www redirects, robots.txt, the sitemap, llms.txt, the answer for
 * a missing page, and the mail records of its domain. Never rejects.
 * @param {string} url  the production address (https://example.com); a bare host is read as https://
 * @param {{ fetchFn?: typeof fetch, dns?: { resolveMx(host: string): Promise<any[]>, resolveTxt(host: string): Promise<string[][]> }, timeoutMs?: number, now?: () => number }} [opts]
 * @returns {Promise<SiteFacts>}
 */
export async function collectSiteFacts(url, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const clock = () => {
    try {
      const t = typeof o.now === "function" ? o.now() : Date.now();
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  };
  const started = clock();
  const target = normalise(url);
  const facts = emptySiteFacts(target.u ? target.u.href : typeof url === "string" ? url.trim().slice(0, 300).replace(/\/\/[^/@\s]*@/, "//") : "");
  if (target.error || !target.u) {
    facts.error = target.error || "not a valid address";
    return facts;
  }
  try {
    await measure(facts, target.u, o);
  } catch {
    if (!facts.reachable && !facts.error) facts.error = "request failed";
  }
  facts.elapsedMs = Math.max(0, Math.round(clock() - started));
  return facts;
}

async function measure(facts, u, o) {
  const fetchFn = typeof o.fetchFn === "function" ? o.fetchFn : typeof fetch === "function" ? fetch : null;
  const timeoutMs = typeof o.timeoutMs === "number" && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (!fetchFn) {
    facts.error = "no fetch in this Node version";
    return;
  }
  const pending = new Map();
  /** One request per address per run. */
  const get = (address) => {
    let p = pending.get(address);
    if (!p) {
      p = getOnce(fetchFn, address, timeoutMs);
      pending.set(address, p);
    }
    return p;
  };

  const host = u.hostname.toLowerCase();
  const origin = u.origin;
  const isIp = /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":");
  const port = u.port ? `:${u.port}` : "";
  const secure = u.protocol === "https:";
  const httpsUrl = `https://${host}${secure ? port : ""}/`;
  const httpUrl = `http://${host}${secure ? "" : port}/`;
  const twinHost = isIp ? "" : host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  facts.www.other = twinHost;

  const home = follow(get, u.href);

  const homeTask = home.then(async (r) => {
    if (!r.ok || !r.res) {
      facts.error = r.error || "request failed";
      return;
    }
    facts.reachable = true;
    const page = parseHtml(r.res.text, r.finalUrl);
    const { iconLink, ...rest } = page;
    let favicon = iconLink ? true : null;
    if (!iconLink) {
      const icon = await follow(get, `${origin}/favicon.ico`);
      if (icon.ok && icon.res) favicon = icon.res.status === 200 && icon.res.bytes > 0 && !looksHtml(icon.res);
    }
    facts.home = {
      status: r.res.status,
      finalUrl: r.finalUrl,
      bytes: r.res.bytes,
      ...rest,
      favicon,
      noindex: page.noindex || /\b(?:noindex|none)\b/i.test(r.res.header("x-robots-tag") || ""),
      hsts: Boolean(r.res.header("strict-transport-security")),
    };
  });

  const httpsTask = get(httpsUrl).then((r) => {
    facts.https.ok = r.ok ? true : /^(?:ECONNREFUSED|CERT_|ERR_TLS|ERR_SSL|EPROTO|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_|HOSTNAME_MISMATCH)/.test(r.error) ? false : null;
  });

  const httpTask = follow(get, httpUrl).then((r) => {
    facts.https.httpRedirects = r.ok ? r.chain.length > 1 && r.finalUrl.startsWith("https://") : null;
  });

  const twinTask = !twinHost
    ? Promise.resolve()
    : Promise.all([follow(get, `${u.protocol}//${twinHost}${port}/`), home]).then(([twin, mine]) => {
        if (!twin.ok || !mine.ok) return;
        facts.www.joined = hostOf(twin.finalUrl) === hostOf(mine.finalUrl);
      });

  const robotsTask = follow(get, `${origin}/robots.txt`).then(async (r) => {
    if (r.ok && r.res) {
      const status = r.res.status;
      facts.robots.status = status;
      if (status === 200) {
        facts.robots.html = looksHtml(r.res);
        const parsed = facts.robots.html ? { groups: [], sitemaps: [] } : parseRobots(r.res.text);
        facts.robots.allowsAll = !robotsBlocks(parsed, "*");
        facts.robots.blockedAi = AI_CRAWLERS.filter((name) => robotsBlocks(parsed, name));
        const sitemaps = [];
        for (const s of parsed.sitemaps) {
          try {
            const address = new URL(s, origin);
            if ((address.protocol === "http:" || address.protocol === "https:") && sitemaps.length < 20) sitemaps.push(address.href);
          } catch {
            /* not an address */
          }
        }
        facts.robots.sitemaps = sitemaps;
      } else if (status >= 400 && status < 500 && status !== 429) {
        // No robots.txt: crawlers read that as "everything is allowed".
        facts.robots.allowsAll = true;
      }
    }
    const address = facts.robots.sitemaps[0] || `${origin}/sitemap.xml`;
    facts.sitemap.url = address;
    const s = await follow(get, address);
    if (!s.ok || !s.res) return;
    facts.sitemap.status = s.res.status;
    if (s.res.status !== 200 || /\.gz(?:$|\?)/i.test(s.finalUrl)) return;
    const valid = /<(?:urlset|sitemapindex)[\s>]/i.test(s.res.text);
    facts.sitemap.valid = valid;
    facts.sitemap.urls = valid ? (s.res.text.match(/<loc[\s>]/gi) || []).length : null;
  });

  const llmsTask = follow(get, `${origin}/llms.txt`).then((r) => {
    if (!r.ok || !r.res) return;
    facts.llms.status = r.res.status;
    facts.llms.html = r.res.status === 200 && looksHtml(r.res);
  });

  const missingTask = follow(get, `${origin}${NOT_FOUND_PATH}`).then((r) => {
    if (r.ok && r.res) facts.notFound.status = r.res.status;
  });

  const dns = o.dns && typeof o.dns === "object" ? o.dns : { resolveMx: nodeResolveMx, resolveTxt: nodeResolveTxt };
  const mailHost = host.replace(/^www\./, "");
  const dnsTask = isIp
    ? Promise.resolve()
    : Promise.all([lookup((h) => dns.resolveMx(h), mailHost, timeoutMs), lookup((h) => dns.resolveTxt(h), mailHost, timeoutMs), lookup((h) => dns.resolveTxt(h), `_dmarc.${mailHost}`, timeoutMs)]).then(([mx, txt, dmarc]) => {
        // A single MX record of "." says the domain takes no mail.
        facts.dns.mx = mx === null ? null : mx.some((r) => r && typeof r.exchange === "string" && r.exchange !== "" && r.exchange !== ".");
        facts.dns.spf = txt === null ? null : txtStartsWith(txt, "v=spf1");
        facts.dns.dmarc = dmarc === null ? null : txtStartsWith(dmarc, "v=dmarc1");
      });

  const settled = await Promise.allSettled([homeTask, httpsTask, httpTask, twinTask, robotsTask, llmsTask, missingTask, dnsTask]);
  if (!facts.reachable && !facts.error) facts.error = settled.some((s) => s.status === "rejected") ? "request failed" : "no answer";
  if (facts.reachable) facts.error = null;
}
