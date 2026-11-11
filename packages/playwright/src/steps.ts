// The order of things on the page during one test: from what the page hands over (page.ts) to the steps a race file
// carries (GenClassRacesFile.steps, types.ts) and back. Pure: no I/O, no clock, no randomness; the same input gives the
// same output.
//
// The page script hands over the agent entry's record as it grows: each user action, each request's send, and the
// delivery of its response to the app (or its end without one), with its time. Here they get names that are the same
// in every run of a test, which is what lets two runs be compared step by step (order.ts):
//   - a user action is named by its kind and its target as the runtime describes them ('click button "Apply"': a
//     role, and a label or the element's visible text). What is typed into a form field is never in that; and for a
//     keyboard action on anything but a field, a button or the like, only the role is kept (actionLabel), since an
//     editor without a label is described by its own text, which is what was typed;
//   - a request is named by its method and path, ids written ":id" (chaos.ts stablePath, on top of what the runtime's
//     own key already normalises); a request to another host by host name and path, without the port, so a back end
//     on a random port has one name;
//   - `n` says which one: the n-th action with that label, the n-th request with that label, counted in the order
//     they were done or sent in this test, whatever page or page load they were on.
// A step that happened after the test's own code had finished (the fixture waits for responses at the end of a test)
// is kept and marked `late`: it is evidence for a witness, and it cannot have changed the test's result. The end is
// known best as a time (session.ts watches Playwright set the test's duration, which it does the moment the test's
// function returns or throws); a step within END_GUARD_MS before it counts as late too, since the test's last check
// was made in the page a message earlier than the test's side heard of it. Without that time, the end is where the
// page was first asked anything at the end of the test, which is later by the test's own teardown.
//
// What a file holds is bounded twice: by a number of steps and by a number of bytes. When a test has more, the steps
// after the ones that fit are left out and counted in `cut`: every run of a test then holds the same beginning, which
// is what a comparison needs (a failing run stops early; its last steps are a passing run's middle ones).

import { stablePath } from "./chaos.js";
import { STEP_TOKEN } from "./schema.js";
import { STEPS_LIMITS, type RacesSteps } from "./types.js";

export { readSteps } from "./schema.js";

/** "a": a user action. "s": a request was sent. "r": its response was delivered to the app. "x": it ended without one. */
export type StepKind = "a" | "s" | "r" | "x";

/** One step of a test, named so that it is the same step in every run of that test. */
export interface StepEvent {
  kind: StepKind;
  /** A user action ('click button "Apply"') or a request ("POST /api/orders"). */
  label: string;
  /** Which one, from 1: the n-th action with this label, or the n-th request with it. */
  n: number;
  /** ms since the test's first step. */
  t: number;
  /** It happened after the test's own code had finished. */
  late?: boolean;
}

/** A step as the page handed it over: for an action `name` is its label, for a request its key in that page load ("GET /api/search#3"). */
export interface PageStep {
  kind: StepKind;
  /** ms on the wall clock. */
  at: number;
  name: string;
}

/** The steps of one page load, each at the place the page gave it. */
export interface PageStream {
  /** Names the page load. */
  id: string;
  steps: (PageStep | undefined)[];
  /** How many of them happened while the test's own code ran (unset: all of them). */
  body?: number;
  /**
   * The place of the first step after ones that were lost: the page recorded more between two hand-overs than its
   * record keeps (unset: nothing was lost). What comes from there on has an unknown number of steps before it.
   */
  gap?: number;
}

/**
 * What a step landing this long before the end of the test's own code is taken for: late. One message from the page
 * to the test takes about this long, so the test's last check may have been made before the step.
 */
export const END_GUARD_MS = 10;

/**
 * A test's steps in order. `bodyKnown`: it is known where the test's own code ended. `lost`: steps that are not in
 * `events` because a page load lost some (PageStream.gap): the ones known to come after the loss, and one for the
 * loss itself. They count as left out, like the steps a file has no room for.
 */
export interface StepSequence {
  events: StepEvent[];
  bodyKnown: boolean;
  lost?: number;
}

/** `s` in at most `max` characters: a longer one is cut (never inside a surrogate pair) and ends with "…". */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/**
 * Kinds of action made with the keyboard, and the roles whose name is safe to keep for them. The runtime describes a
 * target as its role and a name ('input "Search"'): a form field's name is its label, never its content, and a button,
 * a link or a menu item is named by its caption. Anything else is named by its own visible text when it has no label,
 * and for an element one types into (a rich-text editor, any contenteditable) that text is what was typed. So for a
 * keyboard action the name is kept only for those roles, and every other target is its role alone ("type textbox").
 */
const KEYED = new Set(["type", "key", "change"]);
const NAMED_ROLES = new Set(["input", "textarea", "select", "checkbox", "radio", "range", "file", "color", "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "treeitem", "slider"]);

/** The label of a user action: its kind, the key pressed when there is one, and its target (see KEYED). */
export function actionLabel(kind: unknown, target: unknown, key: unknown): string {
  const text = (p: unknown): string => (typeof p === "string" ? p.replace(/\s+/g, " ").trim() : "");
  let where = text(target);
  if (KEYED.has(text(kind))) {
    const role = /^[^\s"]+/.exec(where)?.[0] ?? "";
    if (!NAMED_ROLES.has(role)) where = role;
  }
  return clip([text(kind), text(key), where].filter(Boolean).join(" ") || "action", STEPS_LIMITS.label);
}

/**
 * The label of a request, from its key in the agent entry's record ("GET /api/items/7#2", "POST localhost:8001/api/x/#1",
 * "GET /api/search#3~retry2"): the method and the path with ids as ":id"; for another host, the host name without its
 * port in front of the path; a retry or hedge keeps its suffix. Null for a text that is not such a key.
 */
export function requestLabel(key: string): string | null {
  const hash = key.lastIndexOf("#");
  if (hash <= 0) return null;
  const tail = /^\d+(~[A-Za-z0-9]+)?$/.exec(key.slice(hash + 1));
  if (!tail) return null;
  const name = key.slice(0, hash).trim();
  const space = name.indexOf(" ");
  if (space <= 0) return null;
  const method = name.slice(0, space).toUpperCase();
  let where = name.slice(space + 1).trim();
  if (!where) return null;
  if (where.startsWith("/")) where = stablePath(where);
  else {
    const slash = where.indexOf("/");
    const host = (slash >= 0 ? where.slice(0, slash) : where).replace(/:\d+$/, "");
    where = `${host}${slash >= 0 ? stablePath(where.slice(slash)) : ""}`;
  }
  return clip(`${method} ${where}${tail[1] ?? ""}`, STEPS_LIMITS.label);
}

/** One step as the page script sends it (["a", time, kind, target, key] or ["s" | "r" | "x", time, request key]), or null. */
export function pageStepOf(v: unknown): PageStep | null {
  if (!Array.isArray(v)) return null;
  const kind: unknown = v[0];
  const at: unknown = v[1];
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (kind === "a") return { kind, at, name: actionLabel(v[2], v[3], v[4]) };
  if ((kind === "s" || kind === "r" || kind === "x") && typeof v[2] === "string" && v[2].length > 0 && v[2].length <= 600) return { kind, at, name: v[2] };
  return null;
}

/**
 * The steps of one test in order, named and counted. Page loads are merged by time, each keeping its own order (a
 * record's order is exact, its times are rounded); the steps that landed after the test's own code come last. A
 * response whose request was never handed over is left out: it cannot be named. `endedAt`: when the test's own code
 * finished, in ms on the wall clock (see the header); without it each page load's own count (`body`) says.
 */
export function sequenceOf(streams: readonly PageStream[], endedAt?: number): StepSequence {
  interface Item extends PageStep {
    late: boolean;
    stream: number;
  }
  const timed = typeof endedAt === "number" && Number.isFinite(endedAt);
  // a page load that lost steps: the test's steps are kept up to the last one before the loss, in every page load
  // (what came after it, there or elsewhere, has an unknown number of steps before it)
  let until = Infinity;
  let lost = 0;
  for (const s of streams) {
    if (s.gap === undefined) continue;
    let before = -Infinity;
    for (let i = Math.min(s.gap, s.steps.length) - 1; i >= 0; i--) {
      const p = s.steps[i];
      if (p) {
        before = p.at;
        break;
      }
    }
    until = Math.min(until, before);
    lost = 1;
  }
  const lists: Item[][] = streams.map((s, stream) => {
    const out: Item[] = [];
    s.steps.forEach((p, i) => {
      if (!p) return;
      if (p.at > until || (s.gap !== undefined && i >= s.gap)) {
        lost++;
        return;
      }
      out.push({ ...p, late: timed ? p.at > endedAt - END_GUARD_MS : s.body !== undefined && i >= s.body, stream });
    });
    return out;
  });
  const heads = lists.map(() => 0);
  const merged: Item[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (heads[i] >= lists[i].length) continue;
      if (best < 0 || lists[i][heads[i]].at < lists[best][heads[best]].at) best = i;
    }
    if (best < 0) break;
    merged.push(lists[best][heads[best]++]);
  }
  const ordered = [...merged.filter((x) => !x.late), ...merged.filter((x) => x.late)];
  const counts = new Map<string, number>();
  const next = (key: string): number => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  const requests = new Map<string, { label: string; n: number }>();
  const events: StepEvent[] = [];
  const t0 = ordered.length ? ordered[0].at : 0;
  let last = 0;
  for (const it of ordered) {
    let label: string;
    let n: number;
    if (it.kind === "a") {
      label = it.name;
      n = next(`a ${label}`);
    } else {
      const id = `${it.stream} ${it.name}`;
      let req = requests.get(id);
      if (it.kind === "s") {
        if (req) continue; // one key, sent once
        const l = requestLabel(it.name);
        if (l === null) continue;
        req = { label: l, n: next(`q ${l}`) };
        requests.set(id, req);
      } else if (!req) continue;
      label = req.label;
      n = req.n;
    }
    last = Math.max(last, Math.min(99_999_999, Math.max(0, Math.round(it.at - t0))));
    const e: StepEvent = { kind: it.kind, label, n, t: last };
    if (it.late) e.late = true;
    events.push(e);
  }
  const seq: StepSequence = { events, bodyKnown: timed || streams.some((s) => s.body !== undefined) };
  if (lost > 0) seq.lost = lost;
  return seq;
}

/** The size of a file's `steps` as the fixture writes it, in bytes (UTF-8), with what the field costs around it. */
export function stepsBytes(steps: RacesSteps): number {
  return new TextEncoder().encode(JSON.stringify({ steps }, null, 2)).length + 2;
}

export interface EncodeOptions {
  /** At most this many steps. */
  max: number;
  /** At most this many bytes (stepsBytes). */
  bytes: number;
  /** Steps the fixture did not keep at all (they count in `cut`). */
  more?: number;
}

/**
 * A sequence as a file carries it: its longest beginning within `max` steps, `bytes` bytes and the format's limits
 * (STEPS_LIMITS), with how many steps were left out. Undefined when there is nothing to write or not one step fits.
 */
export function encodeSteps(seq: StepSequence, o: EncodeOptions): RacesSteps | undefined {
  const all = seq.events;
  const more = Math.max(0, Math.floor(o.more ?? 0));
  const most = Math.min(all.length, Math.max(0, Math.floor(o.max)), STEPS_LIMITS.steps);
  if (most <= 0) return undefined;
  const build = (count: number): RacesSteps => {
    const labels: string[] = [];
    const index = new Map<string, number>();
    const tokens: string[] = [];
    let prev = 0;
    let body = 0;
    for (let i = 0; i < count; i++) {
      const e = all[i];
      let at = index.get(e.label);
      if (at === undefined) {
        at = labels.length;
        labels.push(e.label);
        index.set(e.label, at);
      }
      tokens.push(`${e.kind}${at}.${e.n}+${Math.max(0, e.t - prev)}`);
      prev = Math.max(prev, e.t);
      if (!e.late) body++;
    }
    const out: RacesSteps = { labels, order: tokens.join(" ") };
    if (seq.bodyKnown) out.body = body;
    const cut = all.length - count + more;
    if (cut > 0) out.cut = cut;
    return out;
  };
  const fits = (s: RacesSteps): boolean => s.labels.length <= STEPS_LIMITS.labels && stepsBytes(s) <= o.bytes;
  const whole = build(most);
  if (fits(whole)) return whole;
  // the longest beginning that fits (a shorter one never needs more room)
  let lo = 0;
  let hi = most - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(build(mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? build(lo) : undefined;
}

/** The steps of a file, in order, with their times since the first one. Tokens it cannot read are skipped. */
export function decodeSteps(steps: RacesSteps): StepEvent[] {
  const out: StepEvent[] = [];
  if (!steps.order) return out;
  const parts = steps.order.split(" ");
  let t = 0;
  for (let i = 0; i < parts.length; i++) {
    const m = STEP_TOKEN.exec(parts[i]);
    if (!m) continue;
    const label = steps.labels[Number(m[2])];
    if (label === undefined) continue;
    t += Number(m[4]);
    const e: StepEvent = { kind: m[1] as StepKind, label, n: Number(m[3]), t };
    if (steps.body !== undefined && i >= steps.body) e.late = true;
    out.push(e);
  }
  return out;
}
