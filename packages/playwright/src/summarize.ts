// `@genclass/playwright/summarize`: "genclass-races/1" files -> one markdown report. Pure: no I/O, no clock, no
// randomness, so the same files always give the same bytes (the input order does not matter either), which is what
// lets a CI job post it as a sticky pull-request comment and a unit test assert it exactly.
//
// What the report says, and what it does not:
//   - per test, one line per signature ("trigger|diagnosis|op"), grouped as duplicate submits, stale responses,
//     failing endpoints and other detections, with the evidence line the runtime printed and the model's
//     confidence. The grouping is by the model's diagnosis label only; nothing here looks at facts or decides what
//     is a bug.
//   - signatures whose trigger is "witness" (the fixture's happens-before facts, computed by the runtime without the
//     model: overwrote-newer, identical-in-flight) get a group of their own, shown only when there are any, with no
//     confidence (a fact happened or not) and a footer sentence that says what they are. They are never counted as
//     duplicate submits or stale responses: whether one is a bug is for the reader. The same holds for the page's
//     uncaught errors (trigger "page-error") and the measured visual checks (trigger "check"): a group, a table row
//     and a footer paragraph each, only when there are any, no confidence; the model's paragraph is about the model's
//     groups only. A report without them is byte for byte what it was before they existed.
//   - a signature flagged in at least `minSeeds` seeds of the same test (default 2, the fixture's 2-seed rule) is
//     marked reproducible; one seen in fewer may depend on that seed's timing. A seed whose file ran in the natural
//     order (chaos order "systematic", repeat 0: nothing reordered) is shown as such and does not count.
//   - totals per group.
//   - nothing about interventions or false interventions: the files do not carry what an action did to the app, so
//     the report makes no claim either way.
//
// Made to be posted as a GitHub comment: text from the files (test names, evidence lines) is escaped so it cannot
// turn into markup, and "#123", "GH-123" and "@name" get a zero-width space so GitHub neither links the runtime's
// request ids to the repository's issues nor mentions anyone. The whole report is kept under `maxChars` (default
// 60000; GitHub rejects comment bodies over 65,536 characters) by leaving out the least important lines, with a note.
// Its last line (`REPORT_FOOTER`, unless `footer: false`) links to the package README's section on what the lines
// mean and what the fixture can miss; it counts toward `maxChars` and is kept however the report is shortened.

import { parseRaces, validateRaces } from "./schema.js";
import { CHECK_TRIGGER, PAGE_ERROR_TRIGGER, type GenClassRacesFile, type RaceChaosOrder, type RacesFileInput, type RacesParseResult } from "./types.js";

/**
 * The report groups, in report order: the model's four, then the fixture's records made without the model: the
 * page's uncaught errors (trigger "page-error"), the measured visual checks (trigger "check") and the witnesses
 * (trigger "witness"), last.
 */
export type RaceCategory = "duplicate" | "stale" | "failing" | "other" | "page-error" | "check" | "witness";

export const CATEGORIES: readonly RaceCategory[] = ["duplicate", "stale", "failing", "other", "page-error", "check", "witness"];

/** The model's groups: the model's footer paragraph and its "not ready" note are about these only. */
export const MODEL_CATEGORIES: readonly RaceCategory[] = ["duplicate", "stale", "failing", "other"];

/** The groups `totals.byCategory` always counts; the page errors and the measured checks appear there only when present. */
export type CoreCategory = Exclude<RaceCategory, "page-error" | "check">;

export const CATEGORY_TITLES: Readonly<Record<RaceCategory, string>> = {
  duplicate: "Duplicate submits",
  stale: "Stale responses",
  failing: "Failing endpoints",
  other: "Other detections",
  "page-error": "Page errors (uncaught, recorded without the model)",
  check: "Measured checks (visual measurements, not the model)",
  witness: "Witnesses (facts measured without the model)",
};

/** The trigger the fixture gives a witness signature. */
export const WITNESS_TRIGGER = "witness";

/** A signature kind added after the first version (a page error or a measured check), which the older notes do not count. */
function newerKind(trigger: string): boolean {
  return trigger === PAGE_ERROR_TRIGGER || trigger === CHECK_TRIGGER;
}

/** The default number of seeds a signature must be seen in to count as reproducible. */
export const DEFAULT_MIN_SEEDS = 2;
/** The marker the report starts with, so a CI step can find and update its own comment. */
export const REPORT_MARKER = "<!-- genclass-report -->";
/**
 * The report's last line, after a blank line (left out with `footer: false`): a link to the "What to expect from the
 * model" section of this package's README, which says what the lines mean and what the fixture can miss. It has no
 * "@" and no "#" before a digit, so GitHub mentions and links nothing in it.
 */
export const REPORT_FOOTER =
  "GenClass for Playwright: [what these lines mean and what the fixture can miss](https://github.com/genclass-dev/GenClass/tree/main/packages/playwright#what-to-expect-from-the-model).";
/** The default report size limit, in characters (JavaScript string length): under GitHub's 65,536 per comment. */
export const DEFAULT_MAX_CHARS = 60000;
/** The smallest size limit: lower `maxChars` values count as this. */
export const MIN_MAX_CHARS = 1000;

/**
 * The group of a diagnosis label: "duplicate", "stale" and "failing" have their own; everything else (transient,
 * inconsistent, conflict, overload, slow, unusual, a plugin's own labels) is "other". "expected" is not a detection
 * and is left out of the report. With the trigger given, a witness (trigger "witness") is "witness", a page error
 * (trigger "page-error") "page-error" and a measured check (trigger "check") "check", whatever the label says.
 */
export function categoryOf(diagnosis: string, trigger?: string): RaceCategory {
  if (trigger === WITNESS_TRIGGER) return "witness";
  if (trigger === PAGE_ERROR_TRIGGER) return "page-error";
  if (trigger === CHECK_TRIGGER) return "check";
  return diagnosis === "duplicate" || diagnosis === "stale" || diagnosis === "failing" ? diagnosis : "other";
}

export interface SummarizeOptions {
  /** Seeds a signature must be seen in to be marked reproducible. Default 2; values below 1 count as 1. */
  minSeeds?: number;
  /** The report's heading. Default "GenClass race report". */
  title?: string;
  /** Where the files were looked for (shown in the report, e.g. ["test-results/genclass"]). */
  sources?: string[];
  /** Evidence lines longer than this are cut (with "…"). Default 400. */
  maxEvidenceChars?: number;
  /**
   * The report is kept to at most this many characters (JavaScript string length), so that it fits in one GitHub
   * comment. Default 60000 (`DEFAULT_MAX_CHARS`); 0 or Infinity: no limit; other values below 1000 count as 1000.
   * Left out first: entries of the "nothing flagged" and "Files skipped" lists, then the least important signatures
   * of each test (fewer seeds and lower confidence first), then whole tests from the end of the report. The counts
   * always include everything, a note under the first line says what was left out, and the footer line is kept.
   */
  maxChars?: number;
  /**
   * End the report with `REPORT_FOOTER`, one line that links to what the lines mean and what the fixture can miss.
   * Default true; `false` leaves that line out (the paragraphs that explain the groups stay). The line counts toward
   * `maxChars`.
   */
  footer?: boolean;
}

export interface SignatureSummary {
  sig: string;
  trigger: string;
  diagnosis: string;
  op: string;
  category: RaceCategory;
  /** Highest confidence over the seeds it was seen in. */
  confidence: number;
  /** The evidence line of the most confident occurrence (the earliest file by name on a tie). */
  evidence: string;
  /** The seeds it was seen in, sorted. */
  seeds: number[];
  reproducible: boolean;
}

export interface TestSummary {
  test: string;
  /** Every seed the test ran with, as far as the files tell (file seeds and signature seeds), sorted. */
  seeds: number[];
  /** Files read for this test. */
  files: number;
  /** Signatures, in report order: by group, reproducible first, then more seeds, higher confidence, then by sig. */
  signatures: SignatureSummary[];
  /** Modes the files report (when they carry one), sorted. */
  modes: string[];
  /**
   * Files that flagged nothing and whose model was not "ready" when the fixture collected (null model: "not
   * started"), so those runs may not have been checked; and their states. Files with detections are not counted,
   * whatever the state (the runtime can unload an idle model after it ran), nor files whose `fixture.model` is
   * "skip" (no model by choice: `unchecked` covers those). Only the model's own detections count as flagged here:
   * witnesses, page errors and measured checks say nothing about the model; `others`, set when it is not 0, counts
   * the files that flagged only those.
   */
  modelNotReady: { files: number; states: string[]; others?: number };
  /**
   * Files the fixture wrote that flagged nothing although it could not check the page, and why: the agent entry did
   * not connect (no witnesses), or a service worker controlled the page (chaos and the runtime's files went past
   * page.route). Only witnesses and page errors count as flagged here (they need the agent entry; the model's
   * detections and measured checks do not); `others`, set when it is not 0, counts the files that flagged only those.
   */
  unchecked: { files: number; reasons: string[]; others?: number };
  /**
   * Files whose chaos was on but held no request (nothing matched, or a user route or service worker answered first).
   * A file of the natural order (chaos order "systematic", repeat 0) holds nothing by design and is not counted.
   */
  chaosIdle: number;
  /** The chaos of the first file (by name) that carries one. */
  chaos?: GenClassRacesFile["chaos"];
  /** Set when some file records its chaos order ("systematic"): the order of each such seed (by seed). */
  seedOrders?: Record<string, RaceChaosOrder>;
  /** Set when not 0: files whose page had not settled when the fixture collected (`fixture.settled` false). */
  unsettled?: number;
  /** Set when some file says its measured checks did not run (`fixture.visual`): how many, and why. */
  visualNotRun?: { files: number; reasons: string[] };
}

export interface CategoryTotals {
  signatures: number;
  reproducible: number;
}

export interface RaceSummary {
  minSeeds: number;
  /** Tests in report order: more reproducible signatures first, then more signatures, then by name. */
  tests: TestSummary[];
  /** Files that could not be read, with why (in name order). */
  skipped: { name: string; errors: string[] }[];
  /** Valid files read. */
  files: number;
  sources: string[];
  totals: {
    tests: number;
    testsWithSignatures: number;
    signatures: number;
    reproducible: number;
    /** Per group: always the model's four and the witnesses; the page errors and the measured checks when present. */
    byCategory: Record<CoreCategory, CategoryTotals> & Partial<Record<RaceCategory, CategoryTotals>>;
  };
}

interface Acc {
  test: string;
  seeds: Set<number>;
  files: number;
  sigs: Map<string, SignatureSummary>;
  modes: Set<string>;
  notReady: number;
  notReadyOthers: number;
  states: Set<string>;
  unchecked: number;
  uncheckedOthers: number;
  reasons: Set<string>;
  chaosIdle: number;
  chaos?: GenClassRacesFile["chaos"];
  orders: Map<number, RaceChaosOrder>;
  unsettled: number;
  visualNotRun: number;
  visualReasons: Set<string>;
}

function byName(a: RacesFileInput, b: RacesFileInput): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Validates the files and groups them by test and by signature. Pure; never throws. */
export function buildSummary(inputs: readonly RacesFileInput[], options: SummarizeOptions = {}): RaceSummary {
  const minSeeds = Math.max(1, Math.floor(typeof options.minSeeds === "number" && Number.isFinite(options.minSeeds) ? options.minSeeds : DEFAULT_MIN_SEEDS));
  const sorted = [...inputs].sort(byName);
  const skipped: RaceSummary["skipped"] = [];
  const tests = new Map<string, Acc>();
  let files = 0;
  for (const input of sorted) {
    const r: RacesParseResult = input.error ? { ok: false, errors: [input.error] } : typeof input.content === "string" ? parseRaces(input.content) : validateRaces(input.content);
    if (!r.ok) {
      skipped.push({ name: input.name, errors: r.errors });
      continue;
    }
    files++;
    const f = r.file;
    const t: Acc = tests.get(f.test) ?? {
      test: f.test,
      seeds: new Set(),
      files: 0,
      sigs: new Map(),
      modes: new Set(),
      notReady: 0,
      notReadyOthers: 0,
      states: new Set(),
      unchecked: 0,
      uncheckedOthers: 0,
      reasons: new Set(),
      chaosIdle: 0,
      orders: new Map(),
      unsettled: 0,
      visualNotRun: 0,
      visualReasons: new Set(),
    };
    tests.set(f.test, t);
    t.files++;
    t.seeds.add(f.seed);
    if (f.mode) t.modes.add(f.mode);
    const m = f.model;
    // what each note counts as flagged: the model's note, the model's own detections only (a witness, a page error or
    // a check says nothing about whether the model checked the run); the fixture's note ("witnesses not recorded"),
    // witnesses and page errors only (both need the agent entry, which the model's detections and the measured checks
    // do not), so neither note is hidden by what the other part found
    const byModel = (x: { trigger: string; diagnosis: string }) => x.trigger !== WITNESS_TRIGGER && !newerKind(x.trigger) && x.diagnosis !== "expected";
    const flaggedModel = f.signatures.some(byModel);
    const flaggedAgent = f.signatures.some((x) => x.trigger === WITNESS_TRIGGER || x.trigger === PAGE_ERROR_TRIGGER);
    const flaggedNotModel = f.signatures.some((x) => x.trigger === WITNESS_TRIGGER || newerKind(x.trigger));
    const flaggedNotAgent = f.signatures.some((x) => byModel(x) || x.trigger === CHECK_TRIGGER);
    if (!flaggedModel && m === null) {
      t.notReady++;
      t.states.add("not started");
      if (flaggedNotModel) t.notReadyOthers++;
    } else if (!flaggedModel && m && m.state !== undefined && m.state !== "ready" && f.fixture?.model !== "skip") {
      t.notReady++;
      t.states.add(m.state);
      if (flaggedNotModel) t.notReadyOthers++;
    }
    const fx = f.fixture;
    // chaos.order "systematic": the order of this seed's run (the natural one does not count toward reproducible)
    const order = f.chaos?.order;
    if (order && !t.orders.has(f.seed)) t.orders.set(f.seed, order);
    if (fx) {
      const why: string[] = [];
      if (fx.agent !== null) why.push(`witnesses not recorded: ${fx.agent}`);
      if (fx.serviceWorker) why.push("a service worker controlled the page");
      if (!flaggedAgent && why.length) {
        t.unchecked++;
        for (const w of why) t.reasons.add(w);
        if (flaggedNotAgent) t.uncheckedOthers++;
      }
      // the natural order holds nothing by design
      if (fx.chaosApplied === 0 && order !== "natural") t.chaosIdle++;
      if (fx.settled === false) t.unsettled++;
      if (typeof fx.visual === "string") {
        t.visualNotRun++;
        t.visualReasons.add(fx.visual);
      }
    }
    if (f.chaos && t.chaos === undefined) t.chaos = f.chaos;
    for (const s of f.signatures) {
      // "expected" is the model's label for nothing wrong; a page error or a check named so is still one
      if (s.diagnosis === "expected" && !newerKind(s.trigger)) continue;
      const seeds = s.seeds.length ? s.seeds : [f.seed];
      for (const n of seeds) t.seeds.add(n);
      const prev = t.sigs.get(s.sig);
      if (!prev) {
        t.sigs.set(s.sig, { sig: s.sig, trigger: s.trigger, diagnosis: s.diagnosis, op: s.op, category: categoryOf(s.diagnosis, s.trigger), confidence: s.confidence, evidence: s.evidence, seeds: [...seeds], reproducible: false });
        continue;
      }
      prev.seeds = [...new Set([...prev.seeds, ...seeds])];
      if (s.confidence > prev.confidence) {
        prev.confidence = s.confidence;
        prev.evidence = s.evidence;
      }
    }
  }

  const counts = new Map<RaceCategory, CategoryTotals>(CATEGORIES.map((c) => [c, { signatures: 0, reproducible: 0 }]));
  let signatures = 0;
  let reproducible = 0;
  const out: TestSummary[] = [];
  for (const t of tests.values()) {
    const sigs = [...t.sigs.values()];
    for (const s of sigs) {
      s.seeds.sort((a, b) => a - b);
      // a seed of the natural order reordered nothing: it does not make a signature reproducible
      s.reproducible = s.seeds.filter((n) => t.orders.get(n) !== "natural").length >= minSeeds;
      const c = counts.get(s.category)!;
      c.signatures++;
      signatures++;
      if (s.reproducible) {
        c.reproducible++;
        reproducible++;
      }
    }
    sigs.sort(
      (a, b) =>
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
        Number(b.reproducible) - Number(a.reproducible) ||
        b.seeds.length - a.seeds.length ||
        b.confidence - a.confidence ||
        cmpStr(a.sig, b.sig),
    );
    const ts: TestSummary = {
      test: t.test,
      seeds: [...t.seeds].sort((a, b) => a - b),
      files: t.files,
      signatures: sigs,
      modes: [...t.modes].sort(),
      modelNotReady: { files: t.notReady, states: [...t.states].sort(), ...(t.notReadyOthers ? { others: t.notReadyOthers } : {}) },
      unchecked: { files: t.unchecked, reasons: [...t.reasons].sort(), ...(t.uncheckedOthers ? { others: t.uncheckedOthers } : {}) },
      chaosIdle: t.chaosIdle,
    };
    if (t.chaos !== undefined) ts.chaos = t.chaos;
    if (t.orders.size) ts.seedOrders = Object.fromEntries([...t.orders].sort((a, b) => a[0] - b[0]).map(([n, o]) => [String(n), o]));
    if (t.unsettled) ts.unsettled = t.unsettled;
    if (t.visualNotRun) ts.visualNotRun = { files: t.visualNotRun, reasons: [...t.visualReasons].sort() };
    out.push(ts);
  }
  const rep = (t: TestSummary) => t.signatures.filter((s) => s.reproducible).length;
  out.sort((a, b) => rep(b) - rep(a) || b.signatures.length - a.signatures.length || cmpStr(a.test, b.test));
  // the model's groups and the witnesses always; the page errors and the measured checks only when there are any
  const byCategory = {} as RaceSummary["totals"]["byCategory"];
  for (const c of CATEGORIES) {
    const v = counts.get(c)!;
    if (!newerCategory(c) || v.signatures > 0) byCategory[c] = v;
  }
  return {
    minSeeds,
    tests: out,
    skipped,
    files,
    sources: options.sources ? [...options.sources] : [],
    totals: { tests: out.length, testsWithSignatures: out.filter((t) => t.signatures.length > 0).length, signatures, reproducible, byCategory },
  };
}

function newerCategory(c: RaceCategory): boolean {
  return c === "page-error" || c === "check";
}

// ------------------------------------------------------------------------------------------------ rendering

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** U+200B ZERO WIDTH SPACE: invisible, and enough to stop GitHub's issue references and @mentions. */
export const ZERO_WIDTH_SPACE = "\u200B";

/**
 * Escapes text for one line of markdown prose (GitHub flavoured): inline markup (\ ` * _ [ ] < | ~), entity
 * references, and what would start a block at the beginning of the line (# + - = > and "1." / "1)"). Whitespace runs
 * become one space. Then, so that a pull-request comment neither cross-links nor notifies anyone, a zero-width space
 * goes after "#" before a digit (the runtime's request ids, "#15", would link issue #15, and "owner/repo#15" another
 * repository's), after "GH-" before a digit, and after "@" before a letter or digit (a Playwright tag in a test
 * title, "@smoke", would mention a user or team). The text reads the same; copied, it carries the invisible
 * character.
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<|~])/g, "\\$1")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replace(/^([#+\-=>])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/\b(GH)-(?=\d)/gi, `$1-${ZERO_WIDTH_SPACE}`)
    .replace(/@(?=[A-Za-z0-9])/g, `@${ZERO_WIDTH_SPACE}`);
}

/** Inline code that survives backticks in the text. */
function code(s: string): string {
  const t = s.replace(/\s+/g, " ").trim() || " ";
  const run = Math.max(0, ...(t.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(run + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
}

/** "1, 2, 3", or with chaos order "systematic" each seed's order next to it: "1 (natural), 2 (reverse), 3 (seeded)". */
function seedList(seeds: readonly number[], orders?: Readonly<Record<string, RaceChaosOrder>>): string {
  return seeds.map((n) => (orders?.[String(n)] ? `${n} (${orders[String(n)]})` : String(n))).join(", ");
}

function chaosText(c: NonNullable<GenClassRacesFile["chaos"]>): string {
  const parts: string[] = [];
  if (c.latencyMs) parts.push(c.latencyMs[0] === c.latencyMs[1] ? `latency ${c.latencyMs[0]} ms` : `latency ${c.latencyMs[0]}–${c.latencyMs[1]} ms`);
  if (c.reorder) parts.push("reorder");
  if (typeof c.failRate === "number" && c.failRate > 0) parts.push(`fail rate ${c.failRate}`);
  return parts.length ? parts.join(", ") : "none";
}

function signatureLines(s: SignatureSummary, t: TestSummary, maxEvidence: number): string[] {
  const seen = `${s.seeds.length} of ${plural(t.seeds.length, "seed")} (${seedList(s.seeds, t.seedOrders)})`;
  // only the model's diagnoses carry a probability: a witness, a page error and a check are facts or measurements
  const conf = MODEL_CATEGORIES.includes(s.category) ? ` · confidence ${s.confidence.toFixed(2)}` : "";
  const head = `${s.reproducible ? "**Reproducible**: " : ""}${seen} · ${code(s.op || s.sig)} · ${code(`${s.trigger}:${s.diagnosis}`)}${conf}`;
  const lines = [`- ${head}`];
  const ev = clip(s.evidence, maxEvidence);
  lines.push(ev ? `  > ${escapeMarkdown(ev)}` : "  > (no evidence line in the file)");
  return lines;
}

/** The notes under a flagged test about what the fixture could not do (none for files without a `fixture`). */
function fixtureNotes(t: TestSummary): string[] {
  const out: string[] = [];
  if (t.unchecked.files > 0)
    out.push(
      `Note: in ${t.unchecked.files} of ${plural(t.files, "file")} for this test ${t.unchecked.others ? "nothing but the model's detections or measured checks was flagged" : "nothing was flagged"} and the fixture could not check the page (${t.unchecked.reasons.map(escapeMarkdown).join("; ")}), so those runs may not have been checked.`,
    );
  if (t.chaosIdle > 0)
    out.push(
      `Note: in ${t.chaosIdle} of ${plural(t.files, "file")} for this test chaos was on but held no request (nothing matched its filter, or a route of the test or a service worker answered first).`,
    );
  if (t.unsettled)
    out.push(
      `Note: in ${t.unsettled} of ${plural(t.files, "file")} for this test the page had not settled when the fixture collected, 2 s after the test (a request in flight or held, a short timer pending, or events still coming), so what happened after that was not recorded.`,
    );
  if (t.visualNotRun)
    out.push(`Note: in ${t.visualNotRun.files} of ${plural(t.files, "file")} for this test the measured checks did not run (${t.visualNotRun.reasons.map(escapeMarkdown).join("; ")}).`);
  return out;
}

/** How much of the report is shown: list entries (nothing flagged, files skipped), signatures per test, tests. */
interface Limits {
  items: number;
  perTest: number;
  tests: number;
}

const NO_LIMITS: Limits = { items: Infinity, perTest: Infinity, tests: Infinity };

/** What to keep when a test has more signatures than fit: reproducible, more seeds, higher confidence first. */
function importance(a: SignatureSummary, b: SignatureSummary): number {
  return (
    Number(b.reproducible) - Number(a.reproducible) ||
    b.seeds.length - a.seeds.length ||
    b.confidence - a.confidence ||
    CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
    cmpStr(a.sig, b.sig)
  );
}

/** The test's signatures that are shown under `perTest`, still in report order. */
function shownSignatures(t: TestSummary, perTest: number): SignatureSummary[] {
  if (t.signatures.length <= perTest) return t.signatures;
  const keep = new Set([...t.signatures].sort(importance).slice(0, perTest));
  return t.signatures.filter((x) => keep.has(x));
}

function andList(parts: readonly string[]): string {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The size limit an option value means: Infinity for none. */
function resolveMaxChars(v: unknown): number {
  if (typeof v !== "number" || Number.isNaN(v)) return DEFAULT_MAX_CHARS;
  if (v === 0 || v === Infinity) return Infinity;
  return Math.max(MIN_MAX_CHARS, Math.floor(v));
}

/** The note under the first line when `lim` leaves something out (null when nothing is left out). */
function cutNote(s: RaceSummary, lim: Limits, maxChars: number): string | null {
  const flagged = s.tests.filter((t) => t.signatures.length > 0);
  const quiet = s.tests.length - flagged.length;
  let signatures = 0;
  let tests = 0;
  flagged.forEach((t, i) => {
    if (i >= lim.tests) tests++;
    else signatures += Math.max(0, t.signatures.length - lim.perTest);
  });
  const items = Math.max(0, quiet - lim.items) + Math.max(0, s.skipped.length - lim.items);
  const parts: string[] = [];
  if (signatures) parts.push(`${plural(signatures, "signature")} of the tests below`);
  if (tests) parts.push(plural(tests, "more test") + " with signatures");
  if (items) parts.push(plural(items, "list entry", "list entries"));
  if (!parts.length) return null;
  return (
    `_Shortened to fit ${maxChars} characters: ${andList(parts)} not shown. The counts include everything; ` +
    "`npx -p @genclass/playwright genclass-playwright-report --max-chars 0` prints the whole report from the same files._"
  );
}

/** The report's text from its lines: joined, ending in a newline, with the footer line last unless `footer: false`. */
function finish(L: string[], options: SummarizeOptions): string {
  if (options.footer !== false) L.push("", REPORT_FOOTER);
  return L.join("\n") + "\n";
}

function render(s: RaceSummary, options: SummarizeOptions, lim: Limits, maxChars: number): string {
  const title = options.title?.trim() || "GenClass race report";
  const maxEvidence = typeof options.maxEvidenceChars === "number" && options.maxEvidenceChars > 0 ? Math.floor(options.maxEvidenceChars) : 400;
  const where = s.sources.length ? ` in ${s.sources.map(code).join(", ")}` : "";
  const L: string[] = [REPORT_MARKER, `## ${escapeMarkdown(title)}`, ""];

  if (s.files === 0 && s.skipped.length === 0) {
    L.push(`No GenClass race files were found${where}. This report reads the files the GenClass Playwright fixture writes (one per test, format \`genclass-races/1\`): is the fixture installed, and did the tests run?`);
    return finish(L, options);
  }

  const T = s.totals;
  const orders = s.tests.some((t) => t.seedOrders !== undefined);
  // a natural-order seed does not count toward reproducible: then the rule says which seeds do
  const natural = s.tests.some((t) => Object.values(t.seedOrders ?? {}).includes("natural"));
  const seedWord = natural ? "reordered seed" : "seed";
  const rule = s.minSeeds === 1 ? `at least 1 ${seedWord}` : `${s.minSeeds} or more ${seedWord}s`;
  const head =
    s.files === 0
      ? "**No race file could be read**"
      : T.signatures === 0
        ? `**Nothing flagged** in ${plural(T.tests, "test")}`
        : `**${plural(T.signatures, "signature")}** in ${plural(T.testsWithSignatures, "test")}, **${T.reproducible} reproducible** (flagged in ${rule} of the same test)`;
  const modes = [...new Set(s.tests.flatMap((t) => t.modes))].sort().map(escapeMarkdown);
  const skipped = s.skipped.length ? `, ${s.skipped.length} skipped` : "";
  L.push(`${head} · ${plural(s.files, "file")} read${where}${skipped}${modes.length ? ` · mode ${modes.join(", ")}` : ""}`);
  L.push("");
  const note = cutNote(s, lim, maxChars);
  if (note) L.push(note, "");

  const count = (c: RaceCategory): number => T.byCategory[c]?.signatures ?? 0;
  const witnesses = count("witness") > 0;
  if (T.signatures > 0) {
    L.push("| | signatures | reproducible |");
    L.push("|---|---:|---:|");
    // the model's rows always; the others only when there are any (a reporter-only setup never has them)
    for (const c of CATEGORIES) if (MODEL_CATEGORIES.includes(c) || count(c) > 0) L.push(`| ${CATEGORY_TITLES[c]} | ${count(c)} | ${T.byCategory[c]?.reproducible ?? 0} |`);
    L.push("");
  }

  const flagged = s.tests.filter((t) => t.signatures.length > 0);
  const quiet = s.tests.filter((t) => t.signatures.length === 0);
  for (const t of flagged.slice(0, lim.tests)) {
    L.push(`### ${escapeMarkdown(t.test)}`);
    L.push("");
    const meta = [`${plural(t.seeds.length, "seed")} (${seedList(t.seeds, t.seedOrders)})`, plural(t.signatures.length, "signature")];
    if (t.chaos) meta.push(`chaos: ${chaosText(t.chaos)}`);
    L.push(meta.join(" · "));
    L.push("");
    const shown = shownSignatures(t, lim.perTest);
    for (const c of CATEGORIES) {
      const list = shown.filter((x) => x.category === c);
      if (!list.length) continue;
      L.push(`**${CATEGORY_TITLES[c]}**`);
      L.push("");
      for (const x of list) L.push(...signatureLines(x, t, maxEvidence));
      L.push("");
    }
    if (shown.length < t.signatures.length) {
      L.push(`_…and ${plural(t.signatures.length - shown.length, "more signature")} in this test, not shown._`);
      L.push("");
    }
    if (t.modelNotReady.files > 0) {
      L.push(
        `Note: in ${t.modelNotReady.files} of ${plural(t.files, "file")} for this test ${t.modelNotReady.others ? "nothing but witnesses, page errors or measured checks was flagged" : "nothing was flagged"} and the model was not ready when the fixture collected (${t.modelNotReady.states.map(escapeMarkdown).join(", ")}), so those runs may not have been checked.`,
      );
      L.push("");
    }
    for (const n of fixtureNotes(t)) L.push(n, "");
  }
  if (flagged.length > lim.tests) {
    L.push(`_…and ${plural(flagged.length - lim.tests, "more test")} with signatures, not shown._`);
    L.push("");
  }

  if (quiet.length) {
    L.push(`<details><summary>${plural(quiet.length, "test")} with nothing flagged</summary>`);
    L.push("");
    for (const t of quiet.slice(0, lim.items)) {
      const notReady = t.modelNotReady.files > 0 ? `; model not ready in ${t.modelNotReady.files} of ${plural(t.files, "file")} (${t.modelNotReady.states.map(escapeMarkdown).join(", ")})` : "";
      const unchecked = t.unchecked.files > 0 ? `; not checked in ${t.unchecked.files} of ${plural(t.files, "file")} (${t.unchecked.reasons.map(escapeMarkdown).join("; ")})` : "";
      const idle = t.chaosIdle > 0 ? `; chaos held no request in ${t.chaosIdle} of ${plural(t.files, "file")}` : "";
      const unsettled = t.unsettled ? `; not settled when collected in ${t.unsettled} of ${plural(t.files, "file")}` : "";
      const visual = t.visualNotRun ? `; measured checks did not run in ${t.visualNotRun.files} of ${plural(t.files, "file")} (${t.visualNotRun.reasons.map(escapeMarkdown).join("; ")})` : "";
      L.push(`- ${escapeMarkdown(t.test)} (${plural(t.seeds.length, "seed")}: ${seedList(t.seeds, t.seedOrders)}${notReady}${unchecked}${idle}${unsettled}${visual})`);
    }
    if (quiet.length > lim.items) L.push(`- …and ${quiet.length - lim.items} more`);
    L.push("");
    L.push("</details>");
    L.push("");
  }

  if (s.skipped.length) {
    L.push(`### Files skipped (${s.skipped.length})`);
    L.push("");
    for (const k of s.skipped.slice(0, lim.items)) L.push(`- ${code(k.name)}: ${k.errors.map(code).join("; ")}`);
    if (s.skipped.length > lim.items) L.push(`- …and ${s.skipped.length - lim.items} more`);
    L.push("");
  }

  if (T.signatures > 0) {
    L.push("---");
    L.push("");
    const parts: string[] = [];
    // the model's paragraph is about the model's groups only
    if (MODEL_CATEGORIES.some((c) => count(c) > 0)) {
      parts.push(
        `Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). ` +
          `Reproducible: flagged in ${rule} of the same test. ` +
          `A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. ` +
          `Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.`,
      );
    }
    if (count("page-error") > 0) {
      parts.push(
        `Lines under "${CATEGORY_TITLES["page-error"]}" are uncaught errors and unhandled rejections the runtime recorded in the page, one per signature (error name, the request nearest to the error in its causal chain, or "no request"): ` +
          `the quoted line is the error's name and the shape of its message (quoted values as "…", numbers as N), nothing else of it. ` +
          `Errors whose stack starts in another origin's script (a third-party script, an extension) are left out and counted in the race file. ` +
          `They carry no confidence: an error is listed when it was thrown. Reproducible: seen in ${rule} of the same test.`,
      );
    }
    if (count("check") > 0) {
      parts.push(
        `Lines under "${CATEGORY_TITLES.check}" are the runtime's measured visual checks (deterministic measurements against fixed, documented thresholds; the model is not involved), one per signature (check kind, route): ` +
          `the quoted line is the check, the element's selector and the measured numbers. ` +
          `They carry no confidence: a measurement crossed its threshold or not. Reproducible: seen in ${rule} of the same test.`,
      );
    }
    if (witnesses) {
      parts.push(
        `Lines under "${CATEGORY_TITLES.witness}" are happens-before facts the runtime measured in the page without the model, one per signature (witness kind, operation): ` +
          `overwrote-newer, a response wrote a field over what a newer request or the user had written since the request started; ` +
          `identical-in-flight, two identical requests in flight together from separate user actions. ` +
          `They carry no confidence: a fact is listed when it happened. Reproducible: seen in ${rule} of the same test. ` +
          `Whether a fact is a bug is for you to decide (some overwrites are intended; many are repaired a moment later).`,
      );
    }
    if (orders) {
      parts.push(
        `A seed marked (natural), (reverse) or (seeded) ran with chaos order "systematic": natural held nothing (the baseline, not counted toward Reproducible), ` +
          `reverse released each burst of requests newest first, seeded held each request for its seeded delay.`,
      );
    }
    L.push(parts.join("\n\n"));
  }
  while (L.length && L[L.length - 1] === "") L.pop();
  return finish(L, options);
}

/** The largest n in [lo, hi] with ok(n), assuming ok is true up to some n and false after; null when ok(lo) is false. */
function largest(lo: number, hi: number, ok: (n: number) => boolean): number | null {
  if (!ok(lo)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Renders a summary as markdown (what the reporter writes to genclass-report.md and a CI step posts on the PR),
 * kept within `maxChars`: it leaves out list entries first, then the least important signatures of each test, then
 * whole tests from the end, each step as little as fits; as a last resort it cuts at a line. The footer line
 * (unless `footer: false`) is part of every step and stays last.
 */
export function renderMarkdown(s: RaceSummary, options: SummarizeOptions = {}): string {
  const max = resolveMaxChars(options.maxChars);
  const full = render(s, options, NO_LIMITS, max);
  if (full.length <= max) return full;
  const fits = (lim: Limits) => render(s, options, lim, max).length <= max;
  const flagged = s.tests.filter((t) => t.signatures.length > 0);
  const maxItems = Math.max(s.tests.length - flagged.length, s.skipped.length);
  const maxPerTest = flagged.reduce((m, t) => Math.max(m, t.signatures.length), 1);

  const items = largest(0, maxItems, (n) => fits({ ...NO_LIMITS, items: n }));
  if (items !== null) return render(s, options, { ...NO_LIMITS, items }, max);
  const perTest = largest(1, maxPerTest, (n) => fits({ ...NO_LIMITS, items: 0, perTest: n }));
  if (perTest !== null) return render(s, options, { ...NO_LIMITS, items: 0, perTest }, max);
  const tests = largest(0, flagged.length, (n) => fits({ items: 0, perTest: 1, tests: n }));
  if (tests !== null) return render(s, options, { items: 0, perTest: 1, tests }, max);

  // the cut is made in the lines above the footer, which keeps its place at the end (max is at least 1000 characters)
  const end = options.footer === false ? "" : `\n${REPORT_FOOTER}\n`;
  const text = render(s, { ...options, footer: false }, { items: 0, perTest: 1, tests: 0 }, max);
  const tail = `\n_…cut at ${max} characters._\n`;
  const cut = text.slice(0, max - tail.length - end.length);
  const nl = cut.lastIndexOf("\n");
  return (nl > 0 ? cut.slice(0, nl) : cut) + tail + end;
}

/** Files -> markdown: buildSummary + renderMarkdown. Pure; never throws on bad input (bad files are listed as skipped). */
export function summarize(inputs: readonly RacesFileInput[], options: SummarizeOptions = {}): string {
  return renderMarkdown(buildSummary(inputs, options), options);
}

// The format and its validator, so this entry alone is enough for a CI script.
export { RACES_SCHEMA, PAGE_ERROR_TRIGGER, CHECK_TRIGGER } from "./types.js";
export type { GenClassRacesFile, RaceBurst, RaceChaosOrder, RaceSignature, RacesFileInput, RacesFixtureInfo, RacesParseResult } from "./types.js";
export { parseRaces, validateRaces, MAX_ERRORS } from "./schema.js";
