// Untrusted text from pages (docs/runtime/AGENT.md section 6). Everything a page sends (URLs, element names, typed
// values, error messages, store summaries, page text) is data for the agent, never an instruction to it: a page can
// show anything, and an attacker who controls a page's content or a server's response controls these strings. So:
// control characters and ANSI escapes are removed, whitespace collapsed, every string capped, and tool output puts
// page text inside quoted fields under a header that says what it is. Nothing here makes a string safe to obey; it
// keeps it short, printable and visibly quoted.

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Invisible characters that can carry hidden text: tag characters, variation selectors, soft hyphen, format chars. */
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u{FE00}-\u{FE0F}\u{00AD}\u{180E}\p{Co}]/gu;

/** One line of page text: printable, single-spaced, at most `max` characters. */
export function clean(v: unknown, max = 200): string {
  if (v === undefined || v === null) return "";
  let s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : safeJson(v);
  s = s.replace(ANSI, "").replace(CONTROL, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  // by code points, so a cut never leaves half a surrogate pair
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : s;
}

/** A multi-line block (stack traces): lines cleaned one by one, at most `lines` of them. */
export function cleanBlock(v: unknown, lines = 12, max = 200): string[] {
  if (typeof v !== "string") return [];
  return v
    .split(/\r?\n/)
    .map((l) => clean(l, max))
    .filter(Boolean)
    .slice(0, lines);
}

/** Page text quoted for output: JSON string quoting, so it can never close the quote or start a new line. */
export function q(v: unknown, max = 200): string {
  return JSON.stringify(clean(v, max));
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

export function str(v: unknown, max = 200): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** "1.2 s" / "340 ms". */
export function ms(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "?";
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : `${Math.round(v)} ms`;
}

/** "3 minutes ago" from wall-clock ms. */
export function ago(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** A request key's signature: "GET /api/search#3" → "GET /api/search". */
export function sigOf(key: string): string {
  const i = key.lastIndexOf("#");
  return i > 0 ? key.slice(0, i) : key;
}

/**
 * A state path with id-like segments as "*" ("notes.byId.8f3a9c2e.body" → "notes.byId.*.body"): numbers, UUIDs, long
 * hex, and tokens of 5+ characters with at least two digits and two letters ("Zt7m9", not "address2"). One bug on a
 * new record each run stays one finding.
 */
export function pathShape(path: string): string {
  return path
    .split(".")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || (seg.length >= 5 && /^[\w-]+$/.test(seg) && (seg.match(/\d/g)?.length ?? 0) >= 2 && (seg.match(/[a-z]/gi)?.length ?? 0) >= 2) ? "*" : seg))
    .join(".");
}

/** Normalise a message for grouping: numbers and quoted values do not make two errors different. */
export function shape(s: string): string {
  return s
    .replace(/"[^"]*"|'[^']*'/g, "…")
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * A route segment that names a record, not a place: what pathShape() calls an id, or a long token of mixed-case letters
 * ("FlWEvnXpnxjGWWIU": a generated id can come without a digit; "GettingStarted" has too few capitals to look like one).
 */
function routeIdLike(seg: string): boolean {
  if (pathShape(seg) === "*") return true;
  return seg.length >= 12 && /^[\w-]+$/.test(seg) && (seg.match(/[A-Z]/g)?.length ?? 0) >= 4 && (seg.match(/[a-z]/g)?.length ?? 0) >= 4;
}

/**
 * A route with id-like segments as "*" ("/c/8f3a9c2e-…" → "/c/*"): a page that gets a new path on every load (a fresh
 * session, a new document) is one page to a schedule, a scenario group and a finding key.
 */
export function routeShape(route: string): string {
  return route
    .split("/")
    .map((seg) => (seg && routeIdLike(seg) ? "*" : seg))
    .join("/");
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A form field's name with its generated part as "*": "el-id-2476-32" → "el-id-*-32", "<uuid>-input" → "*-input",
 * ":r1a:" → "*". A name made for this page load compares with itself on the next one. Only a name without spaces is an
 * identifier (a UUID is one anywhere): "Address line 2" is a label, and "address-2" keeps its small number, which tells
 * two fields apart rather than two loads.
 */
export function fieldShape(name: string): string {
  const s = name.replace(UUID, "*").replace(/:[rR][0-9a-zA-Z]*:|«[rR][0-9a-zA-Z]*»/g, "*");
  if (/\s/.test(s)) return s;
  return s
    .split(/([-_.:])/)
    .map((t) => (/^\d{3,}$/.test(t) || /^[0-9a-f]{8,}$/i.test(t) || (t.length >= 5 && (t.match(/\d/g)?.length ?? 0) >= 2 && (t.match(/[a-z]/gi)?.length ?? 0) >= 2) ? "*" : t))
    .join("");
}

const SPAN = String.raw`(?:\d+|an?|a few|few|several)\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)\b\.?`;
/** "13 minutes ago", "an hour ago", "a few seconds ago", "10m ago", "2h 5m ago", "less than a minute ago". */
const AGO = new RegExp(String.raw`(?<![\w.])(?:(?:less than|about|over|almost|nearly)\s+)?${SPAN}(?:(?:\s+and)?[\s,]+${SPAN})*\s+ago\b`, "gi");
/** "in 5 minutes", "in an hour". */
const AHEAD = new RegExp(String.raw`\bin\s+(?:(?:less than|about|over|almost|nearly)\s+)?${SPAN}`, "gi");
/** "just now", "moments ago", "yesterday", "today", "last week". */
const WORDS = /\b(?:just now|right now|moments? ago|seconds ago|minutes ago|hours ago|yesterday|today|tomorrow|last (?:week|month|year))\b/gi;
/** "3:27 PM", "15:27", "15:27:04": what a clock shows moves on the same way ("Today at 3:27 PM"). */
const CLOCK = /(?<![\w:.+-])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*[ap]\.?m\b\.?)?(?![\w:])/gi;
/** A whole line that is only "now" or a short age ("7m", "2h"; not "2M", a count): one token beside a row, as lists show it. */
const SHORT_AGE = /^(?:[Nn]ow|\d+(?:s|m|h|d|w|mo|y))$/;

/** What timeless() puts in place of a relative time. */
export const WHEN = "<when>";

/**
 * A page line with its relative times replaced by one token: "Edited 13 minutes ago" and "Edited 14 minutes ago" are the
 * same line, whatever the baselines did. These words move with the clock, not with the order of responses: two baselines
 * inside one minute agree, and a run one minute later would differ. A rule about the shape of text, in English (other
 * languages are compared as they are, and fall to the baselines' own noise); it says nothing about any bug.
 */
export function timeless(line: string): string {
  const t = line.trim();
  if (SHORT_AGE.test(t)) return WHEN;
  return line.replace(AGO, WHEN).replace(AHEAD, WHEN).replace(WORDS, WHEN).replace(CLOCK, WHEN);
}

/**
 * How much a page line says, for putting evidence in order: 2 real content (two words or more), 1 a short label
 * ("Components", "draft-one", "Total 41"), 0 a count or a symbol ("41", "156k", "33%", "·", "/").
 */
export function lineWeight(line: string): 0 | 1 | 2 {
  const words = line.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w) && !/^[\d.,$€£]+\p{L}{0,3}%?$/u.test(w));
  return words.length >= 2 ? 2 : words.length === 1 ? 1 : 0;
}
