// The explore verdict (docs/runtime/AGENT.md section 5). Runs of the same scenario (the same user actions on the same
// route) differ only in when their responses were delivered. The fifo runs are the baselines: responses in the order
// their requests started, as on a fast, serial network. With added latency (`slow_ms`) there are two slow baselines and
// one with no added delay. Whatever differs between the two slow baselines is noise and is ignored, by shape as well as
// by value:
//   - a store field whose value differs between them;
//   - the children of a store object whose keys differ between them (new records get new ids on every run): there,
//     records are compared by their values, not by their keys;
//   - in a page line, the tokens that differ at their position (times, counters, ids); another number on that line may
//     drift a little (a second live metric), and a word with a digit in it stays exact;
//   - a page line only one of them shows.
// A value the runtime redacted ("[redacted]") equals any value: whether an opaque id is redacted depends on the id
// itself, so a redaction is never a difference.
//
// Both slow baselines ending the same way, unlike the baseline with no added delay, is what a slow response alone does
// (GroupReport.delay), and a run like that baseline is not listed for it. One slow baseline unlike it is one load against
// one load, which chance can do: it is named apart, "worth a look" (GroupReport.look), and stays noise. A seeded run's
// difference from the slow baselines beyond that depends on network timing. It is sorted by where it shows, from the
// evidence the run recorded:
//   visible    what the page shows (its text, its form values), the writes it sent, or an error only it had: a race;
//   internal   store values, counts of safe requests (GET: a cache refetching once more), a different non-zero count of a
//              POST with nothing recorded that makes it a write (POST often reads) or announcements (lines in ARIA live
//              regions: a toast a slower run let expire) only, while the page showed the same as the baseline: reported
//              apart, never as a race (a cache's bookkeeping, such as request ids and lists of cache keys, depends on
//              arrival order by construction and never reaches the page);
//   transient  the same final state, but an older response overwrote newer data along the way (a later response
//              repaired it): reported apart, never as a race.
// A POST a run never sends, or only it sends, is a lost or an extra write and stays visible. A different non-zero count
// counts as a write only when the run recorded two identical requests in flight together that the baseline did not, or
// a user action sent it directly a different number of times. PUT, PATCH and DELETE counts always do.
// Safe requests to another site leave the counts unless a user action or a request to the page's own origin led to them.
//
// Scenarios are grouped by route (id-like segments blanked) and recorded actions: element names with digits blanked and
// parenthesised counts dropped, consecutive typing into one field as one burst; when that leaves reordered runs without
// two baselines to compare with (a label that changed with the order), by action kinds and element roles, then by action
// kinds alone, then with up to two actions only some loads did (a dialog to dismiss). A group without two baselines
// cannot tell noise from a race and gives no verdict.
//
// Text shapes are matched here, and none of them is a bug pattern: ages ("13 minutes ago": text.ts agesIn(), the same line
// within how long the session ran, whatever the baselines did, because they move with the clock), generated field names
// (fieldShape(), only for names that differ between the baselines) and route segments (routeShape()), tokens holding
// digits. Whether anything is a bug is only ever asked of the page itself: does what it shows depend on the timing of its
// responses?

import type { ActStep, Run, Snapshot } from "./types.js";
import { ageless, agesIn, fieldShape, lineWeight, pathShape, q, routeShape, sameAges, sigOf } from "./text.js";

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

/** A target's name for grouping: ages as one token, parenthesised counts dropped ('combobox "author (1)"' → 'combobox "author"'), digits blanked. */
function targetName(t: string | undefined): string {
  return blankDigits(ageless(t ?? "").replace(/\s*\(\d+\)/g, "")).trim();
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

/** The value keyed() gives a form field in a raw snapshot: by its name, or by its generated shape, fields of one shape pooled. */
export function fieldValue(fields: Record<string, string> | undefined, name: string): string | undefined {
  if (fields?.[name] !== undefined) return fields[name];
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

/** POST is the one unsafe method that often only reads ("POST /counts", GraphQL): how many times it went says little. */
const POST = /^POST\s/;

/** A request sent by one side and never by the other: a lost write, or one only that side sent, whatever the method says. */
const onOneSide = (f: Pick<FieldDiff, "baseline" | "run">): boolean => f.baseline === "(absent)" || f.run === "(absent)";

/**
 * A difference the page shows or sends: a form value, or the count of a write. PUT, PATCH and DELETE always; a POST when
 * one side never sent it, or with evidence that a different non-zero count is a write.
 */
export const shownField = (f: FieldDiff): boolean => f.where === "field" || (f.where === "requests" && !SAFE.test(f.name) && (!POST.test(f.name) || onOneSide(f) || !!f.evidence));

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
   * What a slow response alone does: what every slow baseline shows that the baseline with no added delay does not, and
   * the reverse (`textOnlyBaseline` is what that baseline shows, `textOnlyRun` what the slow ones show), in the first slow
   * baseline's words. Only when it reached the page, its form values, an error, or a write one side never sent or one with
   * evidence: a different count of writes alone can be a queue saving less often when answers are slow (`look`).
   */
  delay?: RunDiff & { of: number; differing: number };
  /**
   * Worth a look, not a race: what only one slow baseline did against the baseline with no added delay (one load against
   * one load, which chance can do), a number both slow baselines show a little off from it (`drift`: slow line, its line,
   * a counter that moved between loads), and counts of writes that changed with the delay and nothing else.
   */
  look?: { lines: { text: string; only: "slow" | "plain"; runs: number }[]; drift: [string, string][]; errors: string[]; fields: FieldDiff[]; writes: FieldDiff[] };
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

/**
 * What may stand at one digit-holding position of a noisy line: this very token, a number near this one, or any token of
 * a shape ("": any).
 */
type Slot = { exact: string } | { near: number; was: string } | { shape: string };

const NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * Which tokens varied between two lines of one shape. A word with a digit that did not vary stays exact ("12 items,
 * version-1"); a number that did not vary, on a line where another did, may drift a little ("CPU 12% memory 40%") and no
 * further ("Order 123 total 40" is not "Order 125 total 90").
 */
function slotsOf(a: string[], b: string[]): Slot[] {
  return a.map((t, i) => (t !== b[i] ? { shape: tokenShape(t) === tokenShape(b[i]) ? tokenShape(t) : "" } : NUMBER.test(t) ? { near: Number(t), was: t } : { exact: t }));
}

const nearBy = (n: number, t: string): boolean => NUMBER.test(t) && Math.abs(Number(t) - n) <= Math.max(2, Math.abs(n) * 0.1);

const fitsSlots = (slots: Slot[], tokens: string[]): boolean => slots.every((s, i) => ("exact" in s ? s.exact === tokens[i] : "near" in s ? nearBy(s.near, tokens[i]) : !s.shape || tokenShape(tokens[i]) === s.shape));

/** A noisy line for the report: the tokens that varied as "N" or "*", the others as they are. */
function slotsText(line: string, slots: Slot[]): string {
  let i = 0;
  return line.replace(DIGIT_TOKEN, (t) => {
    const s = slots[i++];
    return !s ? t : "exact" in s ? s.exact : "near" in s ? s.was : s.shape || "*";
  });
}

/**
 * Lines only in `a` and only in `b`, as counts, after a line with an age met its like: "26 minutes ago" against "27
 * minutes ago" is no difference within the tolerance, "just now" against "3 days ago" is. Oldest with oldest, so a list
 * whose rows all moved a minute pairs row by row.
 */
function lineDiff(a: Map<string, number>, b: Map<string, number>, toleranceMs: number): { onlyA: string[]; onlyB: string[] } {
  const onlyA = onlyIn(a, b);
  const onlyB = onlyIn(b, a);
  if (!onlyA.length || !onlyB.length) return { onlyA, onlyB };
  const aged = (list: string[]) => {
    const m = new Map<string, { i: number; ages: NonNullable<ReturnType<typeof agesIn>>["ages"] }[]>();
    list.forEach((l, i) => {
      const x = agesIn(l);
      if (x) m.set(x.form, [...(m.get(x.form) ?? []), { i, ages: x.ages }]);
    });
    for (const v of m.values()) v.sort((p, q) => p.ages[0].lo - q.ages[0].lo);
    return m;
  };
  const inB = aged(onlyB);
  const dropA = new Set<number>();
  const dropB = new Set<number>();
  for (const [form, xs] of aged(onlyA)) {
    const ys = inB.get(form) ?? [];
    let i = 0;
    let j = 0;
    while (i < xs.length && j < ys.length) {
      if (sameAges(xs[i].ages, ys[j].ages, toleranceMs)) {
        dropA.add(xs[i++].i);
        dropB.add(ys[j++].i);
      } else if (xs[i].ages[0].lo < ys[j].ages[0].lo) i++;
      else j++;
    }
  }
  return { onlyA: onlyA.filter((_, i) => !dropA.has(i)), onlyB: onlyB.filter((_, i) => !dropB.has(i)) };
}

/** Page lines the baselines say nothing about: lines only some of them show, and lines with a token that varied. */
interface LineNoise {
  exact: Set<string>;
  slots: Map<string, Slot[][]>;
  /** The noisy lines as the report writes them. */
  labels: Set<string>;
  /** Lines every baseline shows the same: a token that varied elsewhere does not make them noise. */
  stable: Set<string>;
  /** One value in place of another between two baselines (no digit to pair them by); a third anywhere else is not news. */
  swapped: [string, string][];
}

const isNoiseLine = (n: LineNoise, l: string): boolean => {
  if (n.exact.has(l)) return true;
  if (n.stable.has(l)) return false;
  const tokens = tokensOf(l);
  return !!n.slots.get(lineShape(l))?.some((s) => fitsSlots(s, tokens));
};

/** What differs between the baselines' lines. */
function lineNoise(base: Map<string, number>[], toleranceMs: number): LineNoise {
  const n: LineNoise = { exact: new Set(), slots: new Map(), labels: new Set(), stable: new Set(), swapped: [] };
  const b0 = base[0];
  for (const l of b0.keys()) if (base.every((b) => b.has(l))) n.stable.add(l);
  for (const b of base.slice(1)) {
    const { onlyA: fromFirst, onlyB } = lineDiff(b0, b, toleranceMs);
    const unpaired = new Set<number>(fromFirst.keys());
    const left: string[] = [];
    for (const y of onlyB) {
      // its own kind first ("3" with "4", not with "version-1"), then any line of the shape (generated ids of two forms)
      const i = [...unpaired].find((k) => kindOf(fromFirst[k]) === kindOf(y)) ?? [...unpaired].find((k) => lineShape(fromFirst[k]) === lineShape(y));
      if (i === undefined) {
        left.push(y);
        continue;
      }
      unpaired.delete(i);
      const x = fromFirst[i];
      const shape = lineShape(x);
      const list = n.slots.get(shape) ?? [];
      const slots = slotsOf(tokensOf(x), tokensOf(y));
      list.push(slots);
      n.slots.set(shape, list);
      n.labels.add(slotsText(x, slots));
    }
    const rest = [...unpaired].map((k) => fromFirst[k]);
    for (const l of [...rest, ...left]) n.exact.add(l);
    if (rest.length === left.length) rest.forEach((x, i) => n.swapped.push([x, left[i]]));
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
function keyed(s: Snapshot | undefined, noisy: Set<string>, leftOut?: Set<string>, generated?: Set<string>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!s) return m;
  for (const [k, v] of Object.entries(s.state)) {
    const blank = underNoisy(k, noisy);
    const name = `state ${blank ?? k}`;
    const list = m.get(name);
    if (list) list.push(v);
    else m.set(name, [v]);
  }
  // a name made for the load ("el-id-2476-32") compares with itself in the next one; fields of one such shape pool values
  for (const [k, v] of Object.entries(s.fields ?? {})) {
    const shape = fieldShape(k);
    const name = `field ${generated?.has(shape) ? shape : k}`;
    const list = m.get(name);
    if (list) list.push(v);
    else m.set(name, [v]);
  }
  for (const [k, v] of Object.entries(s.requests)) if (!leftOut?.has(k)) m.set(`requests ${k}`, [String(v)]);
  return m;
}

/**
 * The shapes of field names made for each page load: a name one baseline has and another has not, with a partner of its
 * shape there. By shape alone "qty-100" and "qty-200" would pool, and two products swapping values would read as nothing.
 */
function generatedNames(base: Run[]): Set<string> {
  const out = new Set<string>();
  const names = base.map((b) => Object.keys(b.snapshot?.fields ?? {}));
  for (const here of names)
    for (const there of names) {
      if (here === there) continue;
      const other = new Set(there);
      const shapes = new Set(there.filter((k) => !here.includes(k)).map(fieldShape));
      for (const k of here) if (!other.has(k) && fieldShape(k) !== k && shapes.has(fieldShape(k))) out.add(fieldShape(k));
    }
  return out;
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

/** Two identical requests in flight together recorded for this signature. */
const inFlightTwice = (x: Run, sig: string): boolean => x.witnesses.some((w) => w.kind === "identical-in-flight" && (w.subject === sig || sigOf(w.by) === sig));

/** How many of this signature's requests a user action sent directly (no other request or timer in between). */
const sentDirectly = (x: Run, sig: string): number => x.steps.filter((s) => s.k === "send" && sigOf(s.key) === sig && s.act !== undefined && s.via === undefined).length;

/** POST counts: what a run recorded that makes a different count a write, compared with the run it is measured against. */
function writeEvidence(sig: string, ref: Run, r: Run): string | undefined {
  if (inFlightTwice(r, sig) !== inFlightTwice(ref, sig)) return "two identical requests in flight";
  const [mine, theirs] = [sentDirectly(r, sig), sentDirectly(ref, sig)];
  if (mine !== theirs) return `a user action sent it directly ${mine} time(s), ${theirs} in the baseline`;
  return undefined;
}

/** Fields a request wrote in a run ("write" steps name the request by its key). */
function writtenBy(r: Run, sigs: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const s of r.steps) if (s.k === "write" && s.by && sigs.has(sigOf(s.by))) for (const p of s.paths) out.add(p);
  return out;
}

/** A request signature's host, when it is another origin's ("GET api.github.com/repos/x" → "api.github.com"). */
const hostOf = (sig: string): string | null => /^[A-Z]+ ([^/\s]+)(?:\/|$)/.exec(sig)?.[1] ?? null;

/** The last two labels of a host: the page's own API on a sibling host is not a third party ("api.acme.com", "app.acme.com"). */
const siteOf = (host: string): string => host.split(".").slice(-2).join(".");
const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Safe requests to other sites in a group of runs that nothing else depends on: none was led to by a user action, and no
 * request to the page's own origin came from one. Their count says nothing about this page (a star count, an invite
 * badge). The page's own machine (a backend on another port) and its sibling hosts are never other sites. Writes stay:
 * from a page on localhost, a hosted API of its own and someone else's look alike, and a write is not for this to hide.
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
    for (const sig of Object.keys(r.snapshot?.requests ?? {})) if (foreign(sig) && SAFE.test(sig)) out.add(sig);
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

/** One side a run is compared with: a baseline's entries and lines, and the run they came from. */
interface Side {
  run: Run;
  keys: Map<string, string[]>;
  text: Map<string, number>;
  live: Set<string>;
}

interface Context {
  noisy: Set<string>;
  leftOut: Set<string>;
  generated: Set<string>;
  noiseName: Set<string>;
  lines: LineNoise;
  /** How far two ages may differ and be one line: how long the session ran, and the minute an age can roll over in. */
  toleranceMs: number;
  /** Errors and witnesses of the baselines: a run's own are the others. */
  errors: Set<string>;
  witnesses: Set<string>;
  cut: boolean;
  /** What the session already reports as what a slow response alone does, and that baseline's entries: a run like it on those is not listed for them. */
  delay?: { gone: string[]; come: string[]; fields: Map<string, string[] | null> };
}

const linesOf = (lines: string[] | undefined): Map<string, number> => multiset(lines ?? []);

/** Does `line` stand in `list`, as it is or as an age within the tolerance? */
function standsIn(list: string[], line: string, toleranceMs: number): boolean {
  if (list.includes(line)) return true;
  const x = agesIn(line);
  return !!x && list.some((l) => {
    const y = agesIn(l);
    return !!y && y.form === x.form && sameAges(x.ages, y.ages, toleranceMs);
  });
}

/** A run's difference from one side, beyond noise; null when it has none. */
function diffRun(ref: Side, r: Run, c: Context): RunDiff | null {
  const rk = keyed(r.snapshot, c.noisy, c.leftOut, c.generated);
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
    // what the session reports as a slow response's, and this run has the no-delay value of
    const told = c.delay?.fields.get(name);
    if (told !== undefined && ((told === null && !v) || (told && v && sameValues(told, v)))) continue;
    const f: FieldDiff = { where, name: name.slice(sp + 1), baseline: shown(a), run: shown(v) };
    if (where === "requests" && POST.test(f.name)) {
      const evidence = onOneSide(f) ? (f.run === "(absent)" ? "the baseline sends it and this run never does" : "only this run sends it") : writeEvidence(f.name, ref.run, r);
      if (evidence) f.evidence = evidence;
    }
    fields.push(f);
  }
  const rank = (f: FieldDiff) => (f.where === "field" ? 0 : shownField(f) ? 1 : 2);
  fields.sort((x, y) => rank(x) - rank(y));
  const rt = linesOf(r.snapshot?.text);
  const liveR = new Set(r.snapshot?.live ?? []);
  const { onlyA, onlyB: came } = lineDiff(ref.text, rt, c.toleranceMs);
  // a line this run lacks or adds as the baseline with no added delay does, when the session says so already
  const onlyB = onlyA.filter((l) => !isNoiseLine(c.lines, l) && !(c.delay && standsIn(c.delay.gone, l, c.toleranceMs)));
  const onlyR = came.filter((l) => !isNoiseLine(c.lines, l) && !(c.delay && standsIn(c.delay.come, l, c.toleranceMs)));
  // a line inside a live region of the run that showed it is an announcement (a toast that a slower run let expire)
  const announced = [...onlyB.filter((l) => ref.live.has(l)), ...onlyR.filter((l) => liveR.has(l))];
  const textOnlyBaseline = byWeight(onlyB.filter((l) => !ref.live.has(l)));
  const textOnlyRun = byWeight(onlyR.filter((l) => !liveR.has(l)));
  const errors = [...new Set(r.errors.map((e) => e.message))].filter((m) => !c.errors.has(m));
  const witnesses = [...new Set(witnessesOf(r))].filter((w) => !c.witnesses.has(w));
  if (!(fields.length || textOnlyBaseline.length || textOnlyRun.length || announced.length || errors.length || witnesses.length)) return null;
  const parts = { fields, textOnlyBaseline, textOnlyRun, errors };
  let tier: Tier = visibleDiff(parts) ? "visible" : fields.length || announced.length ? "internal" : "transient";
  // a bare count on the page and the store field another site's one response wrote (a star count, a rate limit's null):
  // that site answered differently, which is no question of order. Two requests can answer out of order: those stay
  let otherSite = false;
  if (tier === "visible" && c.leftOut.size && !errors.length && !fields.some(shownField) && [...textOnlyBaseline, ...textOnlyRun].every((l) => lineWeight(l) === 0)) {
    const once = new Set([...c.leftOut].filter((sig) => ref.run.snapshot?.requests[sig] === 1 && r.snapshot?.requests[sig] === 1));
    const wrote = new Set([...writtenBy(ref.run, once), ...writtenBy(r, once)]);
    otherSite = fields.some((f) => f.where === "state" && wrote.has(f.name));
    if (otherSite) tier = "internal";
  }
  const textCounts: Record<string, { baseline: number; run: number }> = {};
  for (const l of [...textOnlyBaseline.slice(0, 15), ...textOnlyRun.slice(0, 15)]) textCounts[l] = { baseline: ref.text.get(l) ?? 0, run: rt.get(l) ?? 0 };
  return { run: r.id, label: r.assignment?.label ?? r.schedule?.label ?? r.id, tier, fields: fields.slice(0, 30), textOnlyBaseline: textOnlyBaseline.slice(0, 15), textOnlyRun: textOnlyRun.slice(0, 15), ...(Object.keys(textCounts).length ? { textCounts } : {}), ...(announced.length ? { announced: announced.slice(0, 10) } : {}), errors: errors.slice(0, 10), witnesses: witnesses.slice(0, 10), forced: r.forced, ...(otherSite ? { otherSite } : {}) };
}

/** Two lines the same but for numbers a little apart. */
function drifted(x: string, y: string): boolean {
  if (kindOf(x) !== kindOf(y)) return false;
  const [a, b] = [tokensOf(x), tokensOf(y)];
  return a.every((t, i) => t === b[i] || (NUMBER.test(t) && nearBy(Number(t), b[i])));
}

/** A different count of a write, both sides having sent some: a queue saves less often when answers are slow. */
const countOnly = (f: FieldDiff): boolean => f.where === "requests" && !SAFE.test(f.name) && !onOneSide(f);

/**
 * Against the baseline with no added delay: what every slow baseline shows the same (what a slow response alone does),
 * and what is worth a look. Noise took out what the slow baselines disagree on, so each one's list is the others'.
 */
function delayOf(plain: Side, base: Run[], rest: Run[], c: Context): { delay?: RunDiff & { of: number; differing: number }; look?: GroupReport["look"]; told?: Context["delay"] } {
  const noPlain: Context = { ...c, errors: new Set(plain.run.errors.map((e) => e.message)), witnesses: new Set(witnessesOf(plain.run)) };
  const each = base.map((b) => diffRun(plain, b, noPlain));
  const common = <T>(of: (d: RunDiff) => T[], key: (x: T) => string = (x) => String(x)): T[] => (each.every((d) => !!d) ? of(each[0] as RunDiff).filter((x) => each.every((d) => of(d as RunDiff).some((y) => key(y) === key(x)))) : []);
  // a third value where the slow baselines show two of their own (a random tip) is no line they agree on
  const thirds = c.lines.swapped.filter(([x, y]) => !plain.text.has(x) && !plain.text.has(y)).length;
  let textOnlyBaseline = common((d) => d.textOnlyBaseline);
  if (textOnlyBaseline.length <= thirds) textOnlyBaseline = [];
  let textOnlyRun = common((d) => d.textOnlyRun);
  // a number a little off, the rest of the line the same: a counter between two loads moves like that on its own
  const drift: [string, string][] = [];
  for (const x of textOnlyRun) {
    const y = textOnlyBaseline.find((l) => drifted(x, l));
    if (y === undefined) continue;
    drift.push([x, y]);
    textOnlyBaseline = textOnlyBaseline.filter((l) => l !== y);
  }
  textOnlyRun = textOnlyRun.filter((x) => !drift.some(([d]) => d === x));
  const errors = common((d) => d.errors);
  const fields = common((d) => d.fields, (f) => `${f.where} ${f.name} ${f.baseline} ${f.run}`);
  // a count of writes reads as a slow response's only with evidence the slow side sent more: the reverse is a queue at work
  const more = (f: FieldDiff): boolean => inFlightTwice(base[0], f.name) || sentDirectly(base[0], f.name) > sentDirectly(plain.run, f.name);
  const says = fields.filter((f) => f.where === "field" || (f.where === "requests" && !SAFE.test(f.name) && (!countOnly(f) || more(f))));
  const reached = textOnlyBaseline.length > 0 || textOnlyRun.length > 0 || errors.length > 0 || says.length > 0;
  const first = each[0];
  const otherSite = each.every((d) => d?.otherSite);
  const writes = new Map<string, FieldDiff>();
  for (const d of each) for (const f of d?.fields ?? []) if (countOnly(f) && !says.includes(f)) writes.set(f.name, f);
  // what only one slow baseline did: lines it alone shows or alone lacks (a third value elsewhere: no two loads agree on anything)
  const plainHas = (l: string) => plain.text.has(l);
  const skip = new Set(c.lines.swapped.filter(([x, y]) => !plainHas(x) && !plainHas(y)).flat());
  const lines = byWeight([...c.lines.exact].filter((l) => !skip.has(l) && lineWeight(l) > 0)).slice(0, 6).map((text) => ({ text, only: plainHas(text) ? ("plain" as const) : ("slow" as const), runs: rest.filter((r) => linesOf(r.snapshot?.text).has(text)).length }));
  const errs = [...new Set(base.flatMap((b) => b.errors.map((e) => e.message)))].filter((m) => !errors.includes(m) && !noPlain.errors.has(m));
  const fieldLook: FieldDiff[] = [];
  for (const name of c.noiseName) {
    if (!name.startsWith("field ") && !(name.startsWith("requests ") && !SAFE.test(name.slice(9)))) continue;
    const p = plain.keys.get(name);
    const vals = base.map((b) => keyed(b.snapshot, c.noisy, c.leftOut, c.generated).get(name));
    const off = vals.find((v) => !(v && p && sameValues(v, p)));
    if (off && vals.some((v) => (v && p && sameValues(v, p)) || (!v && !p))) fieldLook.push({ where: name.startsWith("field ") ? "field" : "requests", name: name.slice(name.indexOf(" ") + 1), baseline: shown(p), run: shown(off) });
  }
  const look = lines.length || drift.length || errs.length || fieldLook.length || writes.size ? { lines, drift: drift.slice(0, 4), errors: errs.slice(0, 3), fields: fieldLook.slice(0, 4), writes: [...writes.values()].slice(0, 4) } : undefined;
  if (!reached || !first || otherSite) return look ? { look } : {};
  const delay: RunDiff & { of: number; differing: number } = { ...first, tier: "visible", textOnlyBaseline, textOnlyRun, errors, fields: [...says, ...first.fields.filter((f) => !says.includes(f) && !writes.has(f.name))], witnesses: [], of: base.length, differing: base.length };
  return { delay, ...(look ? { look } : {}), told: { gone: textOnlyRun, come: textOnlyBaseline, fields: new Map(says.map((f) => [`${f.where} ${f.name}`, plain.keys.get(`${f.where} ${f.name}`) ?? null])) } };
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
    // an age may move by how long the session ran, and roll over a minute on top of that
    const started = Math.min(...g.map((r) => r.started));
    const toleranceMs = Math.max(0, Math.max(...g.map((r) => r.lastSeen)) - started) + 60_000;
    const generated = generatedNames(base);
    const texts = base.map((b) => linesOf(b.snapshot?.text));
    const lines = lineNoise(texts, toleranceMs);
    const bk = keyed(b0.snapshot, noisy, leftOut, generated);
    const noise = new Set<string>([...noisy].map((p) => `state ${p}.* (record ids)`));
    const noiseName = new Set<string>();
    for (const b of base.slice(1)) {
      const o = keyed(b.snapshot, noisy, leftOut, generated);
      for (const [name, v] of bk) {
        const w = o.get(name);
        if (!w || !sameValues(v, w)) noiseName.add(name);
      }
      for (const name of o.keys()) if (!bk.has(name)) noiseName.add(name);
    }
    for (const n of noiseName) noise.add(n);
    for (const l of byWeight([...lines.exact])) noise.add(`text ${JSON.stringify(l)}`);
    for (const l of lines.labels) noise.add(`text ${JSON.stringify(l)}`);
    rep.noise = [...noise].slice(0, 40);
    const sideOf = (run: Run, keys: Map<string, string[]>, text: Map<string, number>): Side => ({ run, keys, text, live: new Set(run.snapshot?.live ?? []) });
    const ctx: Context = { noisy, leftOut, generated, noiseName, lines, toleranceMs, errors: new Set(base.flatMap((b) => b.errors.map((e) => e.message))), witnesses: new Set(base.flatMap(witnessesOf)), cut: (b0.snapshot?.stateLeft ?? 0) > 0 };
    // what a slow response alone does comes first: a seeded run is listed for what the session does not say already
    if (plain && base.length >= 2) {
      const { delay, look, told } = delayOf(sideOf(plain, keyed(plain.snapshot, noisy, leftOut, generated), linesOf(plain.snapshot?.text)), base, rest, ctx);
      if (delay) rep.delay = delay;
      if (look) rep.look = look;
      if (told) ctx.delay = told;
    }
    const reference = sideOf(b0, bk, texts[0]);
    for (const r of rest) {
      const d = diffRun(reference, r, ctx);
      if (d) (rep.insufficientBaselines ? rep.unfiltered : rep.diffs).push(d);
    }
    out.push(rep);
  }
  return out;
}
