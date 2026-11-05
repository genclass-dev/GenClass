// The explore verdict (docs/runtime/AGENT.md section 5). Runs of the same scenario (the same user actions on the same
// route) differ only in when their responses were delivered. The fifo runs are the baselines: responses in the order
// their requests started, as on a fast, serial network. With added latency (`slow_ms`) there are two slow baselines and
// one with no added delay, so a bug that needs only a slow response has something to differ from. Whatever differs
// between the two slow baselines is noise and is ignored, by shape as well as by value:
//   - a store field whose value differs between them;
//   - the children of a store object whose keys differ between them (new records get new ids on every run): there,
//     records are compared by their values, not by their keys;
//   - in a page line, the tokens that differ at their position (times, counters, ids), and no other token of that line;
//   - a page line only one of them shows.
// Unless the baseline with no added delay settles it: when two slow baselines show two different values and it shows
// one of them, the other is what a slow response did, not noise. (A clock or an id would differ in all three. A bare
// number is left out of this: a counter can land on the same value by chance.) It also decides a line of real content
// only one of them shows, and an error only one of them had; a short label only one of them shows stays noise.
// A value the runtime redacted ("[redacted]") equals any value: whether an opaque id is redacted depends on the id
// itself, so a redaction is never a difference.
//
// A difference between the baseline with no added delay and the slow baselines is reported as what a slow response alone
// does (GroupReport.delay). A seeded run's difference from the slow baselines beyond that depends on network timing. It
// is sorted by where it shows, from the evidence the run recorded:
//   visible    what the page shows (its text, its form values), the writes it sent, or an error only it had: a race;
//   internal   store values, counts of safe requests (GET: a cache refetching once more), counts of POST requests with
//              nothing recorded that makes them a write (POST often reads) or announcements (lines in ARIA live regions:
//              a toast a slower run let expire) only, while the page showed the same as the baseline: reported apart,
//              never as a race (a cache's bookkeeping, such as request ids and lists of cache keys, depends on arrival
//              order by construction and never reaches the page);
//   transient  the same final state, but an older response overwrote newer data along the way (a later response
//              repaired it): reported apart, never as a race.
// A POST count counts as a write only when the run recorded two identical requests in flight together that the baseline
// did not, or a user action sent it directly a different number of times. PUT, PATCH and DELETE counts always do.
// Requests to another site leave the counts unless a user action or a request to the page's own origin led to them.
//
// Scenarios are grouped by route (id-like segments blanked) and recorded actions: element names with digits blanked and
// parenthesised counts dropped, consecutive typing into one field as one burst; when that leaves reordered runs without
// two baselines to compare with (a label that changed with the order), by action kinds and element roles, then by action
// kinds alone, then with up to two actions only some loads did (a dialog to dismiss). A group without two baselines
// cannot tell noise from a race and gives no verdict.
//
// Text shapes are matched here, and none of them is a bug pattern: relative times (text.ts timeless(), compared by shape
// whatever the baselines did, because they move with the clock), generated field names and route segments (fieldShape(),
// routeShape()), tokens holding digits. Whether anything is a bug is only ever asked of the page itself: does what it
// shows depend on the timing of its responses?

import type { ActStep, Run, Snapshot } from "./types.js";
import { fieldShape, lineWeight, pathShape, q, routeShape, sigOf, timeless } from "./text.js";

/** The runtime's redaction placeholder (packages/runtime/src/util.ts REDACTED). */
export const REDACTED = "[redacted]";

/**
 * How a session's runs were grouped: by element names, by action kinds and element roles, by action kinds only, or by
 * action kinds with up to two actions only some loads did.
 */
export type Grouping = "names" | "roles" | "kinds" | "optional";
const GROUPINGS: Grouping[] = ["names", "roles", "kinds", "optional"];

/** Where a seeded run's difference from the baseline shows (see the header). */
export type Tier = "visible" | "internal" | "transient";

const blankDigits = (s: string): string => s.replace(/\d+/g, "N");

/** Tags whose ARIA role is "generic": which of them takes a click can depend on what the page rendered first. */
const GENERIC = new Set(["div", "span", "b", "i", "u", "s", "small", "bdi", "bdo", "samp", "data"]);

/** A target's name for grouping: relative times as one token, parenthesised counts dropped ('combobox "author (1)"' → 'combobox "author"'), digits blanked. */
function targetName(t: string | undefined): string {
  return blankDigits(timeless(t ?? "").replace(/\s*\(\d+\)/g, "")).trim();
}

/** A target's role: 'button "Save"' → button; a generic container (div, span, ...) → element. */
function targetRole(t: string | undefined): string {
  const role = (t ?? "").split(/[\s"]/)[0] ?? "";
  return GENERIC.has(role) ? "element" : role;
}

/** One action as a scenario line at a grouping level. */
function actLine(a: ActStep, level: Grouping | "exact"): string {
  const clicks = a.clicks && a.clicks > 1 ? ` ×${a.clicks}` : "";
  if (level === "exact") return `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}${clicks}`;
  if (level === "names") return `${a.kind} ${targetName(a.target)}${a.value !== undefined ? ` = ${blankDigits(a.value)}` : ""}${clicks}`;
  if (level === "roles") return `${a.kind} ${targetRole(a.target)}${clicks}`;
  return `${a.kind}${clicks}`;
}

/**
 * The scenario a run performed: its user actions, in order (typing bursts with their final value). `exact` is the
 * recorded text; the other levels are what explore groups by: consecutive typing into the same field (at that level)
 * is one burst, so a burst the recording split when the field's label changed under it is one action again.
 */
export function scenarioOf(run: Run, level: Grouping | "exact" = "exact"): string {
  const acts = run.steps.filter((s): s is ActStep => s.k === "act");
  const out: string[] = [];
  let prevType: string | null = null;
  for (const a of acts) {
    const line = actLine(a, level);
    if (level !== "exact" && a.kind === "type") {
      const field = actLine({ ...a, value: undefined }, level);
      if (prevType === field) {
        out[out.length - 1] = line;
        continue;
      }
      prevType = field;
    } else prevType = null;
    out.push(line);
  }
  return out.join("\n");
}

/** Two runs did the same steps: the same actions by name, or (a label that changed with the order) by kind and role. */
export function sameScenario(a: Run, b: Run): boolean {
  return scenarioOf(a, "names") === scenarioOf(b, "names") || scenarioOf(a, "roles") === scenarioOf(b, "roles");
}

/**
 * Two recorded values are equal, a redaction being equal to anything: "[redacted]" against any value, or a summary
 * with "[redacted]" inside it against one with any text in its place ('{id: 1, token: [redacted]}').
 */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return fits(a, b) || fits(b, a);
}

/** One value inside a summary, as describe() writes it: a quoted string, a bare token, or another redaction. */
const ONE_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|[^,\s{}\[\]]+|\[redacted\])`;

/** `pattern` with its "[redacted]" standing for the whole value, or each one inside it for one value, matches `s`. */
function fits(pattern: string, s: string): boolean {
  if (pattern === REDACTED) return true;
  if (!pattern.includes(REDACTED)) return false;
  const re = new RegExp(`^${pattern.split(REDACTED).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(ONE_VALUE)}$`);
  return re.test(s);
}

/** Two lists of values are the same multiset, a redacted value matching any one value. */
function sameValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const rest = [...b];
  const left: string[] = [];
  for (const v of a) {
    const i = rest.indexOf(v);
    if (i >= 0) rest.splice(i, 1);
    else left.push(v);
  }
  for (const v of left) {
    const i = rest.findIndex((w) => sameValue(v, w));
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}

export interface FieldDiff {
  where: "state" | "field" | "requests";
  name: string;
  baseline: string;
  run: string;
  /** A POST count: what the run recorded that makes the difference a write (without it, POST counts are internal). */
  evidence?: string;
}

export interface RunDiff {
  run: string;
  label: string;
  /** Where the difference shows: what the page shows or sends (a race), store values only, or along the way only. */
  tier: Tier;
  /** Form values and request counts first (what the page shows and sends), then store values. */
  fields: FieldDiff[];
  /** Page text lines only the baseline shows, and only this run shows (announcements apart, below). */
  textOnlyBaseline: string[];
  textOnlyRun: string[];
  /**
   * How many times each of those lines appeared in the baseline and in this run: lines are compared as counts (a
   * product name the page always shows once, and a stale result shows a second time, is "only in the run"), so a
   * replay's verdict counts too (store.ts raceVerdict).
   */
  textCounts?: Record<string, { baseline: number; run: number }>;
  /** Lines of live regions (status messages, alerts, toasts) only the baseline, or only this run, showed. */
  announced?: string[];
  /** Errors this run had and the baselines did not (by message). */
  errors: string[];
  /** Witnesses this run had and the baselines did not ("overwrote-newer search.results by GET /api/search"). */
  witnesses: string[];
  /** Responses this run delivered only because their hold ran out (it may not have followed its schedule). */
  forced: number;
  /** Its page text differs only in a bare count, beside a store field another site's response wrote: internal, not a race. */
  otherSite?: boolean;
}

/**
 * The value keyed() gives a state name in a raw snapshot: a "*" segment (records under a noisy parent) pools the
 * matching records' values, sorted and joined, as the comparison did. Undefined when nothing matches.
 */
export function stateValue(state: Record<string, string>, name: string): string | undefined {
  if (!name.split(".").includes("*")) return state[name];
  const re = new RegExp(`^${name.split(".").map((s) => (s === "*" ? "[^.]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.")}$`);
  const list = Object.entries(state)
    .filter(([k]) => re.test(k))
    .map(([, v]) => v);
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : `[${list.sort().join(" | ")}]`;
}

/** The value keyed() gives a form field's shape in a raw snapshot: fields of one shape pool, sorted and joined. */
export function fieldValue(fields: Record<string, string> | undefined, name: string): string | undefined {
  const list = Object.entries(fields ?? {})
    .filter(([k]) => fieldShape(k) === name)
    .map(([, v]) => v);
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : `[${list.sort().join(" | ")}]`;
}

/** The run's snapshot was taken after its last user action (a final state, not the page as it loaded). */
export function settledAfterActs(r: Run): boolean {
  if (!r.snapshot) return false;
  let last = -Infinity;
  for (const s of r.steps) if (s.k === "act") last = Math.max(last, s.t);
  return r.snapshot.t >= last;
}

/** Did the run end in a different state (not only a witness along the way)? */
export function endedDifferently(d: RunDiff): boolean {
  return d.fields.length > 0 || d.textOnlyBaseline.length > 0 || d.textOnlyRun.length > 0 || d.errors.length > 0;
}

/** Requests with a safe method (RFC 9110: GET, HEAD, OPTIONS) change nothing the server keeps: a cache refetching once more. */
const SAFE = /^(GET|HEAD|OPTIONS)\s/;

/** POST is the one unsafe method that often only reads ("POST /counts", GraphQL): its count alone says nothing. */
const POST = /^POST\s/;

/** A difference the page shows or sends: a form value, the count of a write (PUT, PATCH, DELETE, a POST with evidence). */
export const shownField = (f: FieldDiff): boolean => f.where === "field" || (f.where === "requests" && !SAFE.test(f.name) && (!POST.test(f.name) || !!f.evidence));

/**
 * Did the difference reach what the page shows or sends (its text outside announcements, form values, unsafe
 * requests) or throw? A race.
 */
export function visibleDiff(d: Pick<RunDiff, "fields" | "textOnlyBaseline" | "textOnlyRun" | "errors">): boolean {
  return d.fields.some(shownField) || d.textOnlyBaseline.length > 0 || d.textOnlyRun.length > 0 || d.errors.length > 0;
}

/** The weight of the most telling line a run's difference shows (real content before labels before counts). */
function bestLine(d: Pick<RunDiff, "textOnlyBaseline" | "textOnlyRun">): number {
  return Math.max(-1, ...[...d.textOnlyBaseline, ...d.textOnlyRun].map(lineWeight));
}

/** Runs in the order their evidence should be read: real page content first, then errors, form values, labels, writes, counts. */
export function strongestFirst<T extends Pick<RunDiff, "fields" | "textOnlyBaseline" | "textOnlyRun" | "errors">>(diffs: T[]): T[] {
  const score = (d: T): number => (bestLine(d) === 2 ? 5 : d.errors.length ? 4 : d.fields.some((f) => f.where === "field") ? 3 : bestLine(d) === 1 ? 2 : d.fields.some(shownField) ? 1 : 0);
  return diffs.map((d, i) => ({ d, i, s: score(d) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.d);
}

/** What a run's difference comes down to, in one phrase (the most telling evidence first; page strings quoted). */
export function nameDifference(d: Pick<RunDiff, "fields" | "textOnlyBaseline" | "textOnlyRun" | "errors">): string {
  const line = (weight: number): string | null => {
    const inRun = d.textOnlyRun.find((l) => lineWeight(l) === weight);
    if (inRun !== undefined) return `it shows ${q(inRun, 80)}, which the baseline does not`;
    const inBase = d.textOnlyBaseline.find((l) => lineWeight(l) === weight);
    return inBase !== undefined ? `it does not show ${q(inBase, 80)}, which the baseline does` : null;
  };
  const field = d.fields.find((f) => f.where === "field");
  const write = d.fields.find(shownField);
  return (
    line(2) ??
    (d.errors.length ? `an error only there: ${q(d.errors[0], 100)}` : null) ??
    (field ? `form field ${q(field.name, 60)} is ${q(field.run, 60)}, ${q(field.baseline, 60)} in the baseline` : null) ??
    line(1) ??
    (write ? `requests sent to ${q(write.name, 80)}: ${q(write.run, 20)}, ${q(write.baseline, 20)} in the baseline` : null) ??
    line(0) ??
    "what it sent or showed differs"
  );
}

export interface GroupReport {
  route: string;
  /** The scenario as the group's first baseline (else its first run) recorded it. */
  scenario: string;
  /** The scenario at the grouping level: what the group's runs have in common (finding keys use it). */
  scenarioKey: string;
  /** How the session's runs were grouped (the same for every group of a session). */
  grouping: Grouping;
  baselines: string[];
  runs: number;
  /** Reordered runs compared with two baselines (0 without two baselines). */
  compared: number;
  /** Baseline-vs-baseline differences, ignored as noise. */
  noise: string[];
  /** Every reordered run that differed, each with its tier. */
  diffs: RunDiff[];
  /** No baseline among the runs: nothing to compare with. */
  missingBaseline: boolean;
  /** Only one baseline: noise cannot be told apart, so no verdict (the differences are in `unfiltered`). */
  insufficientBaselines: boolean;
  unfiltered: RunDiff[];
  /** Runs whose snapshot left store fields out (its budget), and the most left out of how many. */
  truncated?: { runs: number; left: number; total: number };
  /** The baseline with no added delay, when the session has one in this group. */
  plainBaseline?: string;
  /**
   * What a slow response alone does: the first slow baseline that ended differently from the baseline with no added delay
   * (`textOnlyBaseline` is what that baseline shows, `textOnlyRun` what the slow one shows), and how many of them did.
   * Only when it reached the page, its form values, its writes or its errors.
   */
  delay?: RunDiff & { of: number; differing: number };
  /** Counts of POST requests a slow baseline sent differently from the one with no added delay, with nothing that makes them writes. */
  delayCounts?: FieldDiff[];
  /** Requests to other sites left out of the counts (nothing the user did or the page's own origin asked for led to them). */
  thirdParty?: string[];
}

export function multiset(lines: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function onlyIn(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [l, n] of a) for (let i = b.get(l) ?? 0; i < n; i++) out.push(l);
  return out;
}

const DIGIT_TOKEN = /[\w.:/-]*\d[\w.:/-]*/g;

/** A page line with tokens that hold a digit blanked: "Order #A7F3KQ placed 12:01:04" → "Order #N placed N". */
export const lineShape = (l: string): string => l.replace(DIGIT_TOKEN, "N");

const tokensOf = (l: string): string[] => l.match(DIGIT_TOKEN) ?? [];
const tokenShape = (t: string): string => t.replace(/\d+/g, "N");
const kindOf = (l: string): string => l.replace(DIGIT_TOKEN, tokenShape);

/** What may stand at one digit-holding position of a noisy line: this very token, or any token of a shape ("": any). */
type Slot = { exact: string } | { shape: string };

/** Which tokens varied between two lines of one shape; the others stay exact ("12 items, version-1" / "13 items, version-1"). */
function slotsOf(a: string[], b: string[]): Slot[] {
  return a.map((t, i) => (t === b[i] ? { exact: t } : { shape: tokenShape(t) === tokenShape(b[i]) ? tokenShape(t) : "" }));
}

const fitsSlots = (slots: Slot[], tokens: string[]): boolean => slots.every((s, i) => ("exact" in s ? s.exact === tokens[i] : !s.shape || tokenShape(tokens[i]) === s.shape));

/** A noisy line for the report: the tokens that varied as "N" or "*", the others as they are. */
function slotsText(line: string, slots: Slot[]): string {
  let i = 0;
  return line.replace(DIGIT_TOKEN, (t) => {
    const s = slots[i++];
    return !s ? t : "exact" in s ? s.exact : s.shape || "*";
  });
}

/** Page lines the baselines say nothing about: lines only some of them show, and lines with a token that varied. */
interface LineNoise {
  exact: Set<string>;
  slots: Map<string, Slot[][]>;
  /** The noisy lines as the report writes them. */
  labels: Set<string>;
  /** Lines every baseline shows the same: a token that varied elsewhere does not make them noise. */
  stable: Set<string>;
  /** Lines the baseline with no added delay settled: what a slow baseline showed → what it and the other slow baseline showed. */
  settled: Map<string, string>;
  /** Lines of real content only one slow baseline shows, which it settled too: what they should show or should not. */
  belongs: Set<string>;
  doesNotBelong: Set<string>;
}

const isNoiseLine = (n: LineNoise, l: string): boolean => {
  if (n.exact.has(l)) return true;
  if (n.stable.has(l)) return false;
  const tokens = tokensOf(l);
  return !!n.slots.get(lineShape(l))?.some((s) => fitsSlots(s, tokens));
};

/** What differs between the slow baselines' lines, and what the baseline with no added delay (when there is one) settles. */
function lineNoise(base: Map<string, number>[], plain: Map<string, number> | null): LineNoise {
  const n: LineNoise = { exact: new Set(), slots: new Map(), labels: new Set(), stable: new Set(), settled: new Map(), belongs: new Set(), doesNotBelong: new Set() };
  const b0 = base[0];
  for (const l of b0.keys()) if (base.every((b) => b.has(l))) n.stable.add(l);
  // it shows one of the two values: the other one is not noise (it shows either, or a third: noise)
  const settle = (x: string, y: string): boolean => {
    if (!plain || plain.has(x) === plain.has(y)) return false;
    n.settled.set(plain.has(x) ? y : x, plain.has(x) ? x : y);
    return true;
  };
  for (const b of base.slice(1)) {
    const fromFirst = onlyIn(b0, b);
    const unpaired = new Set<number>(fromFirst.keys());
    const left: string[] = [];
    for (const y of onlyIn(b, b0)) {
      // its own kind first ("3" with "4", not with "version-1"), then any line of the shape (generated ids of two forms)
      const i = [...unpaired].find((k) => kindOf(fromFirst[k]) === kindOf(y)) ?? [...unpaired].find((k) => lineShape(fromFirst[k]) === lineShape(y));
      if (i === undefined) {
        left.push(y);
        continue;
      }
      unpaired.delete(i);
      const x = fromFirst[i];
      const varied = tokensOf(x).filter((t, k) => t !== tokensOf(y)[k]);
      // a bare number can land on the same value by chance (a counter): only words are settled
      if (varied.some((t) => /\p{L}{2,}/u.test(t)) && settle(x, y)) continue;
      const shape = lineShape(x);
      const list = n.slots.get(shape) ?? [];
      const slots = slotsOf(tokensOf(x), tokensOf(y));
      list.push(slots);
      n.slots.set(shape, list);
      n.labels.add(slotsText(x, slots));
    }
    const rest = [...unpaired].map((k) => fromFirst[k]);
    // as many lines gone as came: one value in place of another, for the baseline with no added delay to settle
    const swapped = rest.length === left.length;
    const keep = rest.flatMap((x, i) => (swapped && settle(x, left[i]) ? [] : swapped ? [x, left[i]] : [x]));
    if (!swapped) keep.push(...left);
    for (const l of keep) {
      // a line only one of them shows has two values at most, so it agreeing with one says little: a short label stays
      // noise (a tree one load expanded). A line of real content is a page that ended differently: it decides that too
      if (plain && lineWeight(l) === 2) (plain.has(l) ? n.belongs : n.doesNotBelong).add(l);
      else n.exact.add(l);
    }
  }
  return n;
}

const byWeight = (lines: string[]): string[] => lines.map((l, i) => ({ l, i, w: lineWeight(l) })).sort((a, b) => b.w - a.w || a.i - b.i).map((x) => x.l);

/** Parents ("todos.entities") whose child keys differ between two key sets (record ids made fresh each run). */
function noisyParents(a: Iterable<string>, b: Iterable<string>): Set<string> {
  const kids = (paths: Iterable<string>) => {
    const m = new Map<string, Set<string>>();
    for (const p of paths) {
      const segs = p.split(".");
      for (let i = 1; i < segs.length; i++) {
        const parent = segs.slice(0, i).join(".");
        let k = m.get(parent);
        if (!k) m.set(parent, (k = new Set()));
        k.add(segs[i]);
      }
    }
    return m;
  };
  const ka = kids(a);
  const kb = kids(b);
  const out = new Set<string>();
  for (const parent of new Set([...ka.keys(), ...kb.keys()])) {
    const x = ka.get(parent);
    const y = kb.get(parent);
    if (!x || !y) continue; // the parent itself is new in one: its own parent is the noisy one
    if (x.size !== y.size || [...x].some((k) => !y.has(k))) out.add(parent);
  }
  // keep the shallowest: under a noisy parent, every deeper key is a record's own
  return new Set([...out].filter((p) => ![...out].some((q) => q !== p && p.startsWith(`${q}.`))));
}

/** A state path under a noisy parent, with the record key blanked: "todos.entities.aK3x.title" → "todos.entities.*.title". */
function underNoisy(path: string, noisy: Set<string>): string | null {
  const segs = path.split(".");
  for (let i = 1; i < segs.length; i++) {
    const parent = segs.slice(0, i).join(".");
    if (noisy.has(parent)) return [...segs.slice(0, i), "*", ...segs.slice(i + 1)].join(".");
  }
  return null;
}

/**
 * A snapshot as comparable entries: `state <path>`, `field <label>`, `requests <sig>` → its values. Under a noisy
 * parent the records are compared as a multiset of values per blanked path (`state todos.entities.*.title`).
 */
function keyed(s: Snapshot | undefined, noisy: Set<string>, leftOut?: Set<string>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!s) return m;
  for (const [k, v] of Object.entries(s.state)) {
    const blank = underNoisy(k, noisy);
    const name = `state ${blank ?? k}`;
    const list = m.get(name);
    if (list) list.push(v);
    else m.set(name, [v]);
  }
  // a generated field name ("el-id-2476-32") compares with itself in the next load; fields of one shape pool their values
  for (const [k, v] of Object.entries(s.fields ?? {})) {
    const name = `field ${fieldShape(k)}`;
    const list = m.get(name);
    if (list) list.push(v);
    else m.set(name, [v]);
  }
  for (const [k, v] of Object.entries(s.requests)) if (!leftOut?.has(k)) m.set(`requests ${k}`, [String(v)]);
  return m;
}

/** An entry's values as one string (a pooled multiset sorted and joined, as stateValue() reads it back). */
const shown = (v: string[] | undefined): string => (!v ? "(absent)" : v.length === 1 ? v[0] : `[${[...v].sort().join(" | ")}]`);

function witnessesOf(run: Run): string[] {
  return run.witnesses.map((w) => `${w.kind} ${pathShape(w.subject)} by ${sigOf(w.by)}`);
}

/**
 * Group runs by route (id-like segments blanked: a page with a new path on every load is one page) and the scenario at
 * one level; only runs whose snapshot came after their steps.
 */
function groupAt(runs: Run[], level: Grouping): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = `${routeShape(r.page.route)}\n${scenarioOf(r, level)}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  return level === "optional" ? mergeOptional(groups) : groups;
}

/** The most actions only some loads did, for two of them to count as the same steps at the last grouping level. */
const OPTIONAL_ACTIONS = 2;

/** Is `a` what `b` did with at most OPTIONAL_ACTIONS more actions (a dialog dismissed, a tooltip clicked)? `a` did something. */
function withOptional(a: string[], b: string[]): boolean {
  if (!a.length || b.length <= a.length || b.length - a.length > OPTIONAL_ACTIONS) return false;
  let i = 0;
  for (const x of b) if (x === a[i]) i++;
  return i === a.length;
}

/** Groups (at the kinds level) whose actions are another group's with an optional action or two left out join that group. */
function mergeOptional(groups: Map<string, Run[]>): Map<string, Run[]> {
  const entries = [...groups.entries()].map(([k, runs]) => ({ k, route: k.slice(0, k.indexOf("\n")), acts: scenarioOf(runs[0], "kinds").split("\n").filter(Boolean), runs }));
  const out = new Map<string, Run[]>();
  for (const e of [...entries].sort((x, y) => y.acts.length - x.acts.length)) {
    const into = [...out.keys()].find((k) => {
      const t = entries.find((o) => o.k === k)!;
      return t.route === e.route && withOptional(e.acts, t.acts);
    });
    if (into) out.get(into)!.push(...e.runs);
    else out.set(e.k, [...e.runs]);
  }
  return out;
}

const isFifo = (r: Run): boolean => r.schedule?.order === "fifo";
const isSlow = (r: Run): boolean => (r.schedule?.delay?.maxMs ?? 0) > 0;

/**
 * Which runs are baselines. With added latency, the fifo runs that have it (noise is what differs between two runs under
 * the same conditions) and apart from them the fifo run without it; without added latency, every fifo run.
 */
function baselinesOf(g: Run[], session: Run[]): { base: Run[]; plain: Run | null } {
  const fifo = g.filter(isFifo);
  if (!session.some((r) => isFifo(r) && isSlow(r))) return { base: fifo, plain: null };
  return { base: fifo.filter(isSlow), plain: fifo.find((r) => !isSlow(r)) ?? null };
}

/** How well a grouping serves: reordered runs that share a group with two baselines, then the plain baseline beside them. */
function comparable(groups: Map<string, Run[]>, session: Run[]): number {
  let n = 0;
  for (const g of groups.values()) {
    const { base, plain } = baselinesOf(g, session);
    if (base.length >= 2) n += 2 * g.filter((r) => !isFifo(r)).length + (plain ? 1 : 0);
  }
  return n;
}

/**
 * Group a session's runs: the finest level that compares as many reordered runs with two baselines as any level does
 * (a label that changed with the response order splits the runs by name, not by kind and role).
 */
export function groupRuns(runs: Run[]): { grouping: Grouping; groups: Map<string, Run[]> } {
  const settled = runs.filter(settledAfterActs);
  const levels = GROUPINGS.map((level) => ({ level, groups: groupAt(settled, level) }));
  const best = Math.max(...levels.map((l) => comparable(l.groups, settled)));
  const pick = levels.find((l) => comparable(l.groups, settled) === best) ?? levels[0];
  return { grouping: pick.level, groups: pick.groups };
}

/** POST counts: what a run recorded that makes a different count a write, compared with the run it is measured against. */
function writeEvidence(sig: string, ref: Run, r: Run): string | undefined {
  const inFlight = (x: Run) => x.witnesses.some((w) => w.kind === "identical-in-flight" && (w.subject === sig || sigOf(w.by) === sig));
  if (inFlight(r) !== inFlight(ref)) return "two identical requests in flight";
  const direct = (x: Run) => x.steps.filter((s) => s.k === "send" && sigOf(s.key) === sig && s.act !== undefined && s.via === undefined).length;
  if (direct(r) !== direct(ref)) return `a user action sent it directly ${direct(r)} time(s), ${direct(ref)} in the baseline`;
  return undefined;
}

/** Fields a request wrote in a run ("write" steps name the request by its key). */
function writtenBy(r: Run, sigs: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const s of r.steps) if (s.k === "write" && s.by && sigs.has(sigOf(s.by))) for (const p of s.paths) out.add(p);
  return out;
}

/**
 * Errors a run's own are measured against: any baseline's. With a baseline with no added delay, an error only one slow
 * baseline had is what a slow response did, as a page line would be: only one in it, or in every slow baseline, is the page's.
 */
function baselineErrors(base: Run[], plain: Run | null): Set<string> {
  const of = (r: Run) => r.errors.map((e) => e.message);
  if (!plain) return new Set(base.flatMap(of));
  return new Set([...of(plain), ...base.flatMap(of).filter((m) => base.every((b) => of(b).includes(m)))]);
}

/** A request signature's host, when it is another origin's ("GET api.github.com/repos/x" → "api.github.com"). */
const hostOf = (sig: string): string | null => /^[A-Z]+ ([^/\s]+)(?:\/|$)/.exec(sig)?.[1] ?? null;

/** The last two labels of a host: the page's own API on a sibling host is not a third party ("api.acme.com", "app.acme.com"). */
const siteOf = (host: string): string => host.split(".").slice(-2).join(".");
const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Requests to other sites in a group of runs that nothing else depends on: none was led to by a user action, and no
 * request to the page's own origin came from one. Their count says nothing about this page (analytics, a star count,
 * an invite badge). The page's own machine (a backend on another port) and its sibling hosts are never other sites.
 */
function thirdPartyOf(g: Run[]): Set<string> {
  const out = new Set<string>();
  const kept = new Set<string>();
  for (const r of g) {
    let pageHost = "";
    try {
      pageHost = new URL(r.page.url).hostname;
    } catch {
      continue; // no URL to tell another site by
    }
    const foreign = (sig: string): boolean => {
      const h = hostOf(sig)?.replace(/:\d+$/, "");
      return !!h && !LOCAL.test(h) && siteOf(h) !== siteOf(pageHost);
    };
    // PUT, PATCH and DELETE are writes wherever they go
    for (const sig of Object.keys(r.snapshot?.requests ?? {})) if (foreign(sig) && !/^(?:PUT|PATCH|DELETE)\s/.test(sig)) out.add(sig);
    for (const s of r.steps) {
      if (s.k !== "send") continue;
      const sig = sigOf(s.key);
      if (foreign(sig) && s.act !== undefined) kept.add(sig);
      if (!foreign(sig) && s.via && hostOf(s.via)) kept.add(s.via);
    }
  }
  for (const sig of kept) out.delete(sig);
  return out;
}

/** One side a run is compared with: a baseline's entries and lines (timeless), and the run they came from. */
interface Side {
  run: Run;
  keys: Map<string, string[]>;
  text: Map<string, number>;
  live: Set<string>;
}

interface Context {
  noisy: Set<string>;
  leftOut: Set<string>;
  noiseName: Set<string>;
  /** Entries that differ between the slow baselines where the baseline with no added delay settled which value holds. */
  settledNames: Set<string>;
  lines: LineNoise;
  /** A timeless line → the first way a run wrote it (reports quote the page). */
  raw: Map<string, string>;
  /** Errors and witnesses of every baseline: a run's own are the others. */
  errors: Set<string>;
  witnesses: Set<string>;
  cut: boolean;
  /** The baseline with no added delay: a run that shows what it shows is not racing, whatever the slow baselines show. */
  plain: Side | null;
}

const timelessLines = (lines: string[] | undefined, raw: Map<string, string>): string[] =>
  (lines ?? []).map((l) => {
    const t = timeless(l);
    if (!raw.has(t)) raw.set(t, l);
    return t;
  });

/** A run's difference from one side, beyond noise; null when it has none. */
function diffRun(ref: Side, r: Run, c: Context): RunDiff | null {
  const rk = keyed(r.snapshot, c.noisy, c.leftOut);
  const runCut = (r.snapshot?.stateLeft ?? 0) > 0;
  const fields: FieldDiff[] = [];
  for (const name of new Set([...ref.keys.keys(), ...rk.keys()])) {
    if (c.noiseName.has(name)) continue;
    const a = ref.keys.get(name);
    const v = rk.get(name);
    if (a && v && sameValues(a, v)) continue;
    const sp = name.indexOf(" ");
    const where = name.slice(0, sp) === "state" ? "state" : name.slice(0, sp) === "field" ? "field" : "requests";
    // a store field missing from a snapshot that left fields out was not compared, not lost
    if (where === "state" && ((!a && c.cut) || (!v && runCut))) continue;
    // the same as the baseline with no added delay: what a slow response did, reported there
    if (where !== "state" && c.plain) {
      const p = c.plain.keys.get(name);
      if ((!p && !v) || (p && v && sameValues(p, v))) continue;
    }
    const f: FieldDiff = { where, name: name.slice(sp + 1), baseline: shown(a), run: shown(v) };
    if (where === "requests" && POST.test(f.name)) {
      const evidence = writeEvidence(f.name, c.settledNames.has(name) && c.plain ? c.plain.run : ref.run, r);
      if (evidence) f.evidence = evidence;
    }
    fields.push(f);
  }
  const rank = (f: FieldDiff) => (f.where === "field" ? 0 : shownField(f) ? 1 : 2);
  fields.sort((x, y) => rank(x) - rank(y));
  const own = new Map<string, string>();
  const rt = multiset(timelessLines(r.snapshot?.text, own));
  const liveR = new Set(timelessLines(r.snapshot?.live, own));
  const plainText = c.plain?.text;
  // a line this run lacks or adds, as the baseline with no added delay does too, is that baseline's difference
  const onlyB = onlyIn(ref.text, rt).filter((l) => !isNoiseLine(c.lines, l) && !(plainText && (plainText.get(l) ?? 0) <= (rt.get(l) ?? 0)));
  const onlyR = onlyIn(rt, ref.text).filter((l) => !isNoiseLine(c.lines, l) && !(plainText && (plainText.get(l) ?? 0) >= (rt.get(l) ?? 0)));
  // a line inside a live region of the run that showed it is an announcement (a toast that a slower run let expire)
  const inRef = (l: string) => c.raw.get(l) ?? l;
  const inRun = (l: string) => own.get(l) ?? l;
  const announced = [...onlyB.filter((l) => ref.live.has(l)).map(inRef), ...onlyR.filter((l) => liveR.has(l)).map(inRun)];
  const textOnlyBaseline = byWeight(onlyB.filter((l) => !ref.live.has(l)).map(inRef));
  const textOnlyRun = byWeight(onlyR.filter((l) => !liveR.has(l)).map(inRun));
  const errors = [...new Set(r.errors.map((e) => e.message))].filter((m) => !c.errors.has(m));
  const witnesses = [...new Set(witnessesOf(r))].filter((w) => !c.witnesses.has(w));
  if (!(fields.length || textOnlyBaseline.length || textOnlyRun.length || announced.length || errors.length || witnesses.length)) return null;
  const parts = { fields, textOnlyBaseline, textOnlyRun, errors };
  let tier: Tier = visibleDiff(parts) ? "visible" : fields.length || announced.length ? "internal" : "transient";
  // a bare count on the page and the store field another site's response wrote (a star count, a rate limit's null): that
  // site answered differently, which is no question of this page's order
  let otherSite = false;
  if (tier === "visible" && c.leftOut.size && !errors.length && !fields.some(shownField) && [...textOnlyBaseline, ...textOnlyRun].every((l) => lineWeight(l) === 0)) {
    const wrote = new Set([...writtenBy(ref.run, c.leftOut), ...writtenBy(r, c.leftOut)]);
    otherSite = fields.some((f) => f.where === "state" && wrote.has(f.name));
    if (otherSite) tier = "internal";
  }
  const textCounts: Record<string, { baseline: number; run: number }> = {};
  for (const l of [...textOnlyBaseline.slice(0, 15), ...textOnlyRun.slice(0, 15)]) textCounts[l] = { baseline: ref.text.get(timeless(l)) ?? 0, run: rt.get(timeless(l)) ?? 0 };
  return { run: r.id, label: r.assignment?.label ?? r.schedule?.label ?? r.id, tier, fields: fields.slice(0, 30), textOnlyBaseline: textOnlyBaseline.slice(0, 15), textOnlyRun: textOnlyRun.slice(0, 15), ...(Object.keys(textCounts).length ? { textCounts } : {}), ...(announced.length ? { announced: announced.slice(0, 10) } : {}), errors: errors.slice(0, 10), witnesses: witnesses.slice(0, 10), forced: r.forced, ...(otherSite ? { otherSite } : {}) };
}

/**
 * Compare a set of runs (one explore session). Groups by route and scenario; each group needs two fifo baselines under
 * the same conditions, and sets the run with no added delay (when there is one) beside them.
 */
export function compareRuns(runs: Run[]): GroupReport[] {
  const { grouping, groups } = groupRuns(runs);
  const session = runs.filter(settledAfterActs);
  const out: GroupReport[] = [];
  for (const g of groups.values()) {
    const route = g[0].page.route;
    const { base, plain } = baselinesOf(g, session);
    const rest = g.filter((r) => !isFifo(r));
    const scenario = scenarioOf(base[0] ?? g[0]);
    const rep: GroupReport = { route, scenario, scenarioKey: scenarioOf(base[0] ?? g[0], grouping), grouping, baselines: base.map((r) => r.id), runs: g.length, compared: base.length >= 2 ? rest.length : 0, noise: [], diffs: [], missingBaseline: base.length === 0, insufficientBaselines: base.length === 1, unfiltered: [], ...(plain ? { plainBaseline: plain.id } : {}) };
    const cut = g.filter((r) => (r.snapshot?.stateLeft ?? 0) > 0);
    if (cut.length) rep.truncated = { runs: cut.length, left: Math.max(...cut.map((r) => r.snapshot!.stateLeft!)), total: Math.max(...cut.map((r) => r.snapshot!.stateTotal ?? 0)) };
    if (!base.length) {
      out.push(rep);
      continue;
    }
    const b0 = base[0];
    const leftOut = thirdPartyOf(g);
    if (leftOut.size) rep.thirdParty = [...leftOut].slice(0, 10);
    // record ids that differ between the baselines (and, with one baseline, between it and nothing: none)
    const noisy = new Set<string>();
    for (const b of base.slice(1)) for (const p of noisyParents(Object.keys(b0.snapshot?.state ?? {}), Object.keys(b.snapshot?.state ?? {}))) noisy.add(p);
    const raw = new Map<string, string>();
    const texts = base.map((b) => multiset(timelessLines(b.snapshot?.text, raw)));
    const plainText = plain ? multiset(timelessLines(plain.snapshot?.text, raw)) : null;
    const lines = lineNoise(texts, plainText);
    const bk = keyed(b0.snapshot, noisy, leftOut);
    const plainKeys = plain ? keyed(plain.snapshot, noisy, leftOut) : null;
    const noise = new Set<string>([...noisy].map((p) => `state ${p}.* (record ids)`));
    const noiseName = new Set<string>();
    const settledNames = new Set<string>();
    for (const b of base.slice(1)) {
      const o = keyed(b.snapshot, noisy, leftOut);
      for (const [name, v] of bk) {
        const w = o.get(name);
        if (w && sameValues(v, w)) continue;
        // two values of a form field, or a write sent twice in one of the slow baselines, and the baseline with no added
        // delay agrees with the other: not noise (it was the bug), and that baseline's value is what runs are compared with
        const p = plainKeys?.get(name);
        const wrote = name.startsWith("requests ") && !SAFE.test(name.slice(9)) && !!writeEvidence(name.slice(9), b0, b);
        if ((name.startsWith("field ") || wrote) && w && p && (sameValues(p, v) || sameValues(p, w))) {
          bk.set(name, p);
          settledNames.add(name);
          continue;
        }
        noiseName.add(name);
      }
      for (const name of o.keys()) if (!bk.has(name)) noiseName.add(name);
    }
    for (const n of noiseName) noise.add(n);
    for (const l of byWeight([...lines.exact].map((x) => raw.get(x) ?? x))) noise.add(`text ${JSON.stringify(l)}`);
    for (const l of lines.labels) noise.add(`text ${JSON.stringify(l)}`);
    rep.noise = [...noise].slice(0, 40);
    // what the first slow baseline showed, with what the baseline with no added delay settled put right
    const refText = new Map(texts[0]);
    for (const [wrong, right] of lines.settled) {
      const n = refText.get(wrong);
      if (!n) continue;
      refText.delete(wrong);
      refText.set(right, (refText.get(right) ?? 0) + n);
    }
    for (const l of lines.doesNotBelong) refText.delete(l);
    for (const l of lines.belongs) refText.set(l, Math.max(refText.get(l) ?? 0, plainText?.get(l) ?? 1));
    const sideOf = (run: Run, keys: Map<string, string[]>, text: Map<string, number>): Side => ({ run, keys, text, live: new Set(timelessLines(run.snapshot?.live, raw)) });
    const plainSide = plain ? sideOf(plain, plainKeys!, plainText!) : null;
    const ctx: Context = { noisy, leftOut, noiseName, settledNames, lines, raw, errors: baselineErrors(base, plain), witnesses: new Set([...base, ...(plain ? [plain] : [])].flatMap(witnessesOf)), cut: (b0.snapshot?.stateLeft ?? 0) > 0, plain: plainSide };
    const reference = sideOf(b0, bk, refText);
    for (const r of rest) {
      const d = diffRun(reference, r, ctx);
      if (d) (rep.insufficientBaselines ? rep.unfiltered : rep.diffs).push(d);
    }
    // what a slow response alone does: each slow baseline against the one with no added delay
    if (plainSide && base.length >= 2) {
      const noPlain: Context = { ...ctx, plain: null, errors: new Set(plain!.errors.map((e) => e.message)), witnesses: new Set(witnessesOf(plain!)) };
      const each = base.map((b) => diffRun(plainSide, b, noPlain)).filter((d): d is RunDiff => !!d);
      const slow = each.filter((d) => d.tier === "visible");
      if (slow.length) rep.delay = { ...slow[0], of: base.length, differing: slow.length };
      else {
        const counts = new Map(each.flatMap((d) => d.fields).filter((f) => f.where === "requests" && POST.test(f.name)).map((f) => [f.name, f]));
        if (counts.size) rep.delayCounts = [...counts.values()].slice(0, 4);
      }
    }
    out.push(rep);
  }
  return out;
}
