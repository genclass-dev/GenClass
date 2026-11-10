// A repository's settings for genclass-dev[bot]: `.github/genclass.yml` on the repository's DEFAULT branch.
//
// Invariants:
// - The file is read from the default branch only, never from a pull request's head: a pull request (from a fork,
//   from anyone) cannot change how it is reviewed, who may command the bot or whether production numbers are shown.
// - A missing file means the defaults. A file that cannot be parsed, or a value that is not allowed, never stops a
//   review: the default stands in and the problem is listed as a warning in the check run, where the repository's
//   owners see it.
// - Unknown keys are warnings too (a typo should not silently do nothing).
// - Every list and string is capped, so a hostile file cannot make a review slow or its report long.

import { parseYaml, YamlError, type YamlValue } from "./yaml.js";

export const SETTINGS_PATH = ".github/genclass.yml";

export type CommentMode = "findings" | "always" | "never";
export type FailOn = "never" | "reproducible" | "any";
export type IssueMode = "never" | "merge";

export interface RepoSettings {
  reviews: {
    /** Review each pull request when it opens and on every push. Off: only `@genclass-dev review` does. */
    auto: boolean;
    /** Review draft pull requests too. */
    drafts: boolean;
    /** Only pull requests into these base branches ("*" stands for any run of characters); empty: all. */
    branches: string[];
    /** Logins whose pull requests are not reviewed (for example "dependabot[bot]"). */
    ignoreAuthors: string[];
  };
  /** The summary comment: only when something is flagged, always, or never (the check run still reports). */
  comment: CommentMode;
  check: {
    enabled: boolean;
    /** When the check fails instead of staying neutral: never, on a reproducible finding, or on any finding. */
    failOn: FailOn;
  };
  /** Inline comments on a test's line when that line is part of the pull request's diff. */
  inline: boolean;
  /** Seeds of the same test a signature must be flagged in to count as reproducible. */
  minSeeds: number;
  /** Artifacts whose name starts with this are read as race files. */
  artifact: string;
  production: {
    /** Show the linked GenClass app's findings for the pages a pull request touches. */
    enabled: boolean;
    days: 1 | 7 | 30;
  };
  /** `@genclass-dev ...` commands in pull-request comments. */
  commands: boolean;
  /** Open an issue when a pull request merges with reproducible findings still flagged. */
  issues: IssueMode;
}

export const DEFAULT_SETTINGS: RepoSettings = {
  reviews: { auto: true, drafts: false, branches: [], ignoreAuthors: [] },
  comment: "findings",
  check: { enabled: true, failOn: "never" },
  inline: true,
  minSeeds: 2,
  artifact: "genclass",
  production: { enabled: true, days: 7 },
  commands: true,
  issues: "never",
};

const MAX_LIST = 30;
const MAX_ITEM = 100;
const MAX_WARNINGS = 12;

const isMap = (v: YamlValue | undefined): v is { [key: string]: YamlValue } => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Settings from the file's text (null: no file). Never throws. `warnings` are sentences for the repository's owners.
 */
export function readSettings(text: string | null): { settings: RepoSettings; warnings: string[] } {
  const s: RepoSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RepoSettings;
  const warnings: string[] = [];
  const warn = (w: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(w);
  };
  if (text === null || text.trim() === "") return { settings: s, warnings };
  let doc: YamlValue;
  try {
    doc = parseYaml(text);
  } catch (e) {
    warn(`${SETTINGS_PATH} could not be read (${e instanceof YamlError ? e.message : "not valid YAML"}); the defaults are used.`);
    return { settings: s, warnings };
  }
  if (doc === null) return { settings: s, warnings };
  if (!isMap(doc)) {
    warn(`${SETTINGS_PATH} must be a mapping of settings; the defaults are used.`);
    return { settings: s, warnings };
  }

  const bool = (v: YamlValue | undefined, at: string, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    warn(`${at} must be true or false; using ${fallback}.`);
    return fallback;
  };
  const oneOf = <T extends string>(v: YamlValue | undefined, at: string, allowed: readonly T[], fallback: T): T => {
    if (v === undefined) return fallback;
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
    warn(`${at} must be one of ${allowed.join(", ")}; using ${fallback}.`);
    return fallback;
  };
  const list = (v: YamlValue | undefined, at: string): string[] => {
    if (v === undefined || v === null) return [];
    const items = Array.isArray(v) ? v : [v];
    const out: string[] = [];
    for (const x of items) {
      if (typeof x !== "string" || !x.trim() || x.length > MAX_ITEM) {
        warn(`${at} takes short strings; one entry was left out.`);
        continue;
      }
      if (out.length >= MAX_LIST) {
        warn(`${at} keeps its first ${MAX_LIST} entries.`);
        break;
      }
      out.push(x.trim());
    }
    return out;
  };
  const known = (m: { [key: string]: YamlValue }, at: string, keys: readonly string[]): void => {
    for (const k of Object.keys(m)) if (!keys.includes(k)) warn(`${at ? `${at}.` : ""}${k.slice(0, 40)} is not a setting; it was ignored.`);
  };

  known(doc, "", ["reviews", "comment", "check", "inline", "min_seeds", "artifact", "production", "commands", "issues"]);

  const r = doc.reviews;
  if (isMap(r)) {
    known(r, "reviews", ["auto", "drafts", "branches", "ignore_authors"]);
    s.reviews.auto = bool(r.auto, "reviews.auto", s.reviews.auto);
    s.reviews.drafts = bool(r.drafts, "reviews.drafts", s.reviews.drafts);
    s.reviews.branches = list(r.branches, "reviews.branches");
    s.reviews.ignoreAuthors = list(r.ignore_authors, "reviews.ignore_authors").map((x) => x.toLowerCase());
  } else if (typeof r === "boolean") {
    s.reviews.auto = r; // `reviews: false` is the short way to turn automatic reviews off
  } else if (r !== undefined) warn("reviews must be a mapping (auto, drafts, branches, ignore_authors) or true/false.");

  s.comment = oneOf(doc.comment, "comment", ["findings", "always", "never"] as const, s.comment);

  const c = doc.check;
  if (isMap(c)) {
    known(c, "check", ["enabled", "fail_on"]);
    s.check.enabled = bool(c.enabled, "check.enabled", s.check.enabled);
    s.check.failOn = oneOf(c.fail_on, "check.fail_on", ["never", "reproducible", "any"] as const, s.check.failOn);
  } else if (typeof c === "boolean") {
    s.check.enabled = c;
  } else if (c !== undefined) warn("check must be a mapping (enabled, fail_on) or true/false.");

  s.inline = bool(doc.inline, "inline", s.inline);

  if (doc.min_seeds !== undefined) {
    const n = doc.min_seeds;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 10) s.minSeeds = n;
    else warn(`min_seeds must be a whole number from 1 to 10; using ${s.minSeeds}.`);
  }

  if (doc.artifact !== undefined) {
    const a = doc.artifact;
    if (typeof a === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a)) s.artifact = a;
    else warn(`artifact must be a name of letters, digits, ".", "_" and "-"; using ${s.artifact}.`);
  }

  const p = doc.production;
  if (isMap(p)) {
    known(p, "production", ["enabled", "days"]);
    s.production.enabled = bool(p.enabled, "production.enabled", s.production.enabled);
    if (p.days !== undefined) {
      if (p.days === 1 || p.days === 7 || p.days === 30) s.production.days = p.days;
      else warn(`production.days must be 1, 7 or 30; using ${s.production.days}.`);
    }
  } else if (typeof p === "boolean") {
    s.production.enabled = p;
  } else if (p !== undefined) warn("production must be a mapping (enabled, days) or true/false.");

  s.commands = bool(doc.commands, "commands", s.commands);
  s.issues = oneOf(doc.issues, "issues", ["never", "merge"] as const, s.issues);
  return { settings: s, warnings };
}

/**
 * Whether `text` matches the pattern, where "*" stands for any run of characters ("/" included) and everything else
 * is literal. No regular expression is built from the pattern: the loop below is O(pattern x text) at worst, so a
 * hostile pattern cannot make a review slow.
 */
export function globMatches(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === "*") {
      star = pi++;
      mark = ti;
    } else if (pi < pattern.length && pattern[pi] === text[ti]) {
      pi++;
      ti++;
    } else if (star >= 0) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/** Whether a base branch is one the settings review ("main", "release/*"); an empty list means every branch. */
export function branchMatches(patterns: readonly string[], branch: string): boolean {
  return patterns.length === 0 || patterns.some((p) => globMatches(p, branch));
}
