// A Playwright regression test from a finding (docs/runtime/AGENT.md section 5.3). It performs the recorded user
// actions on the recorded page with the finding's delivery schedule set through a page global, so the app's own
// @genclass/runtime/agent link delivers the responses in exactly the order that produced the bug, on any machine,
// with or without the MCP bridge running. It asserts the generic fact that made the finding (no response overwrote
// newer data in that field, no identical request from a second click, the error does not recur, the state and page
// text the request-order baseline ended with). For a race it also holds the page to what the request-order baselines
// showed (the lines the failing run lacked, and those naming what the user typed): what the user should see, not only
// what must not be there; other findings get a marked place for that assertion. A line both orders show, only not as
// often, is asserted by its count. A test it cannot give a generic assertion that tells the failing order from request
// order (the lines naming what was typed do not: the failing run shows them too) fails until one is written: it never
// passes while asserting nothing. The file opens with what it needs
// and the command that runs it, declares only the records its assertions read, and names a locator used twice once.
//
// Every string from the page goes into the file as a JSON string literal (never as code); patterns are built at run
// time with new RegExp from such a literal. Values the page redacted ("[redacted]") become a placeholder. Constant
// names made from element names keep letters and digits only, and end with the element's role.

import type { ActStep, Finding, Run, ScheduleSpec } from "./types.js";
import { agesIn, clean, pathShape, shape } from "./text.js";
import { shownField, type FieldDiff } from "./compare.js";

const lit = (s: unknown): string => JSON.stringify(clean(s, 200));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 'button "Place order"' → { role: "button", name: "Place order" }. */
export function parseTarget(t: string | undefined): { role: string; name?: string } {
  if (!t) return { role: "page" };
  const m = /^([a-z][a-z0-9-]*)(?: "(.*)")?$/i.exec(t.trim());
  if (!m) return { role: "unknown", name: t };
  return m[2] !== undefined ? { role: m[1].toLowerCase(), name: m[2] } : { role: m[1].toLowerCase() };
}

const ROLE_LOCATOR = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "combobox", "searchbox", "textbox", "slider", "spinbutton"]);
const FIELD_TAGS = new Set(["input", "textarea", "select"]);
const TYPED_INPUTS: Record<string, string> = { range: 'input[type="range"]', color: 'input[type="color"]', file: 'input[type="file"]' };

/**
 * A Playwright locator expression for a recorded element description. A name the runtime truncated ("…") matches by
 * its prefix; a field also matches by placeholder, title, name or id; a target without a name is the first element
 * of its kind (actionLines marks it for checking).
 */
export function locator(target: string | undefined): string {
  const { role, name } = parseTarget(target);
  if (role === "page" || !name) return `page.locator(${lit(role === "page" || role === "unknown" ? "body" : TYPED_INPUTS[role] ?? role)}).first()`;
  const cut = name.endsWith("…");
  const n = cut ? name.slice(0, -1).trimEnd() : name;
  const nm = cut ? `new RegExp(${lit(`^${escapeRe(n)}`)})` : lit(n);
  const exact = cut ? "" : ", exact: true";
  const exactOpt = cut ? "" : ", { exact: true }";
  if (ROLE_LOCATOR.has(role)) {
    // a control named only by its name or id attribute has no accessible name to match
    const attr = cut ? "" : `.or(page.locator(${lit(`[name=${JSON.stringify(n)}], [id=${JSON.stringify(n)}]`)}))`;
    return `page.getByRole(${lit(role)}, { name: ${nm}${exact} })${attr}.first()`;
  }
  if (FIELD_TAGS.has(role) || TYPED_INPUTS[role]) {
    const attr = cut ? "" : `.or(page.locator(${lit(`[name=${JSON.stringify(n)}], [id=${JSON.stringify(n)}]`)}))`;
    return `page.getByLabel(${nm}${exactOpt}).or(page.getByPlaceholder(${nm}${exactOpt})).or(page.getByTitle(${nm}${exactOpt}))${attr}.first()`;
  }
  return `page.getByText(${nm}${exactOpt}).first()`;
}

/** The recorded actions as Playwright statements. */
export function actionLines(acts: ActStep[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    const loc = locator(a.target);
    const t = parseTarget(a.target);
    if (t.role !== "page" && !t.name) out.push(`// TODO: the recorded element ${lit(a.target)} had no name; check that this locator finds it`);
    switch (a.kind) {
      case "click": {
        const next = acts[i + 1];
        if (next && next.kind === "click" && next.target === a.target && (next.clicks ?? 1) >= 2) {
          out.push(`await ${loc}.dblclick();`);
          i++;
        } else out.push(`await ${loc}.click();`);
        break;
      }
      case "type": {
        // a burst that continues the previous one on the same field types only the new characters, at the recorded pace
        const prev = acts.slice(0, i).reverse().find((p) => p.target === a.target && p.kind === "type");
        const delay = a.count && a.count > 1 && a.dur ? Math.max(15, Math.min(400, Math.round(a.dur / (a.count - 1)))) : 60;
        if (a.value === "[redacted]" || a.value === undefined) out.push(`await ${loc}.fill("example"); // the recorded value was redacted`);
        else if (prev?.value !== undefined && prev.value !== "[redacted]" && a.value.startsWith(prev.value) && acts[i - 1] === prev)
          out.push(`await ${loc}.pressSequentially(${lit(a.value.slice(prev.value.length))}, { delay: ${delay} });`);
        else {
          out.push(`await ${loc}.fill("");`);
          out.push(`await ${loc}.pressSequentially(${lit(a.value)}, { delay: ${delay} });`);
        }
        break;
      }
      case "change": {
        const { role } = parseTarget(a.target);
        if (role === "checkbox" || role === "radio") out.push(a.value === "unchecked" ? `await ${loc}.uncheck();` : `await ${loc}.check();`);
        else if (role === "select" || role === "combobox") out.push(`await ${loc}.selectOption({ label: ${lit(a.value ?? "")} });`);
        else if (a.value === "file") out.push(`// a file was chosen on ${lit(a.target)}: set one with setInputFiles`);
        else if (a.value !== undefined && a.value !== "[redacted]") out.push(`await ${loc}.fill(${lit(a.value)});`);
        break;
      }
      case "key":
        if (a.key) out.push(`await ${loc}.press(${lit(a.key)});`);
        break;
      case "submit":
        // a submit follows the click or Enter that caused it
        break;
      default:
        out.push(`// ${clean(a.kind, 40)} on ${lit(a.target)} (not replayed)`);
    }
  }
  return out;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const search = u.search.replace(/([?&])genclass-schedule=[^&]*&?/, "$1").replace(/[?&]$/, "");
    return u.pathname + search + u.hash;
  } catch {
    return "/";
  }
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "http://localhost:5173";
  }
}

/** A regex source matching a state path whose id-like segments may differ ("notes.byId.*.body"). */
function pathPattern(path: string): string {
  return `^${pathShape(path)
    .split(".")
    .map((s) => (s === "*" ? "[^.]+" : escapeRe(s)))
    .join("\\.")}$`;
}

/**
 * Lines every baseline showed at its end (the page with responses in request order) that the test holds the fixed page
 * to, at most 4 in all: `onlyBase`, those the failing run lacked (or showed fewer times), and `naming`, those naming a
 * value the user typed (at least 3 characters, any case) with no other digit in them (a clock time, a date or a count
 * beside the typed value reads differently on another day), so the test checks what the user should see and not only
 * what must not be there. Only `onlyBase` tells the failing run from the baseline: the failing run shows the `naming`
 * lines too, so they are checks beside the assertion, never the assertion. Never a line with an age in it or one the
 * failing run showed more often.
 */
export function keptLines(ev: Record<string, unknown>, baselines: Run[], acts: ActStep[]): { onlyBase: string[]; naming: string[] } {
  const onlyBase = [...new Set(((ev.textOnlyBaseline as string[] | undefined) ?? []).filter((l) => typeof l === "string" && !agesIn(l)))].slice(0, 4);
  const onlyRun = new Set((ev.textOnlyRun as string[] | undefined) ?? []);
  const texts = baselines.map((b) => b.snapshot?.text).filter((t): t is string[] => Array.isArray(t) && t.length > 0);
  const common = texts.length ? texts.slice(1).reduce((acc, t) => acc.filter((l) => t.includes(l)), [...new Set(texts[0])]) : [];
  const last = new Map<string, string>();
  for (const a of acts) if (a.kind === "type" && a.value !== undefined && a.value !== "[redacted]") last.set(a.target ?? "", a.value);
  const typed = [...last.values()].map((v) => v.trim().toLowerCase()).filter((v) => v.length >= 3);
  const names = (l: string): boolean => {
    const low = l.toLowerCase();
    // the digits of what was typed ("order 42") are the user's; any other is a value of the moment
    return typed.some((v) => low.includes(v)) && !/\d/.test(typed.reduce((s, v) => s.split(v).join(" "), low));
  };
  const naming = common.filter((l) => !agesIn(l) && !onlyRun.has(l) && !onlyBase.includes(l) && names(l));
  return { onlyBase, naming: naming.slice(0, 4 - onlyBase.length) };
}

/** A readable constant name for a locator ('searchbox "Search"' → searchSearchbox), unique among `taken`. */
function locName(target: string | undefined, taken: Set<string>): string {
  const { role, name } = parseTarget(target);
  const words = (name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 4);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const r = role.replace(/[^a-z0-9]/gi, "").toLowerCase() || "element";
  // the role last, so a name can never be a reserved word or one of the test's own (page, snap, errors)
  let base = words.length ? `${words.map((w, i) => (i ? cap(w) : w.toLowerCase())).join("")}${cap(r)}` : `${r}El`;
  if (!/^[a-z]/i.test(base)) base = `el${base}`;
  base = base.slice(0, 40);
  let n = base;
  for (let k = 2; taken.has(n); k++) n = `${base}${k}`;
  taken.add(n);
  return n;
}

/** The test file for a finding, or null when it has no recorded run to replay. `baselines`: a race's request-order runs. */
export function regressionTest(f: Finding, run: Run | undefined, spec: ScheduleSpec | undefined, baselines: Run[] = []): string | null {
  if (!run) return null;
  const acts = run.steps.filter((s): s is ActStep => s.k === "act");
  const schedule: ScheduleSpec = spec ?? { order: "given", given: run.order.slice(0, 400) };
  const sched = { ...schedule };
  if (sched.given) sched.given = sched.given.map((k) => clean(k, 300));
  if (sched.focus) sched.focus = sched.focus.map((k) => clean(k, 300));
  delete sched.id;
  delete sched.label;
  const ev = f.evidence as Record<string, unknown>;
  const what =
    f.kind === "stale-write"
      ? `no response overwrites newer ${clean(ev.subject, 60)}`
      : f.kind === "duplicate-request"
        ? `${clean(ev.subject, 60)} is sent once per intent`
        : f.kind === "race"
          ? "the final state does not depend on response order"
          : f.kind === "error"
            ? `no uncaught ${clean(ev.name, 40)}`
            : clean(f.title, 80);
  const title = clean(`${f.route}: ${what} (GenClass ${f.id})`, 140);
  const app = origin(run.page.url);
  const file = `genclass-${clean(f.id, 20).replace(/[^A-Za-z0-9-]/g, "")}.spec.ts`;

  // the assertions first: they say which of the page's own records the test has to read
  const checks: string[] = [];
  const reads = { witnesses: false, errors: false, snap: false };
  let asserts = 0;
  const errorAssert = (name: unknown, message: unknown) => {
    // the same grouping as the bridge: quoted values and numbers do not make another error
    checks.push(`  const shape = (s: string) => s.replace(/"[^"]*"|'[^']*'/g, "…").replace(/\\b\\d+(\\.\\d+)?\\b/g, "N").replace(/\\s+/g, " ").trim().slice(0, 160);`);
    checks.push(`  expect(errors.filter((e: any) => ${name ? `e.name === ${lit(name)} && ` : ""}shape(e.message) === ${JSON.stringify(shape(clean(message, 500)))})).toEqual([]);`);
    reads.errors = true;
    asserts++;
  };
  let kept: string[] = [];
  if (f.kind === "stale-write") {
    checks.push(`  // the bug: a response overwrote newer data in this field`);
    checks.push(`  const SUBJECT = new RegExp(${JSON.stringify(pathPattern(clean(ev.subject, 300)))});`);
    checks.push(`  expect(witnesses.filter((w: any) => w.kind === "overwrote-newer" && SUBJECT.test(w.subject))).toEqual([]);`);
    reads.witnesses = true;
    asserts++;
  } else if (f.kind === "duplicate-request") {
    checks.push(`  // the bug: a second click sent the same request again while the first was in flight`);
    checks.push(`  expect(witnesses.filter((w: any) => w.kind === "identical-in-flight" && w.subject === ${lit(ev.subject)})).toEqual([]);`);
    reads.witnesses = true;
    asserts++;
  } else if (f.kind === "race") {
    const all = (ev.fields as { where: string; name: string; baseline: string; except?: string[] }[] | undefined) ?? [];
    const onlyBase = (ev.textOnlyBaseline as string[] | undefined) ?? [];
    const onlyRun = (ev.textOnlyRun as string[] | undefined) ?? [];
    const errs = (ev.errors as string[] | undefined) ?? [];
    // what the page showed or sent (unsafe requests); store values and refetch counts only when nothing else differed
    const shown = all.filter((d) => shownField(d as FieldDiff));
    const visible = shown.length > 0 || onlyBase.length > 0 || onlyRun.length > 0 || errs.length > 0;
    const fields = visible ? shown : all;
    const pooledUsed = fields.slice(0, 5).some((d) => d.where === "state" && d.name.split(".").includes("*"));
    const pooledField = fields.slice(0, 5).some((d) => d.where === "field" && d.name.includes("*") && !!d.name.replace(/\*/g, "").trim());
    if (pooledUsed) {
      // records under an object whose keys are new each run: compared by their values (as the bridge did)
      checks.push(`  const stateValue = (state: Record<string, string>, name: string) => {`);
      checks.push(`    const re = new RegExp("^" + name.split(".").map((s) => (s === "*" ? "[^.]+" : s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"))).join("\\\\.") + "$");`);
      checks.push(`    const list = Object.entries(state).filter(([k]) => re.test(k)).map(([, v]) => v);`);
      checks.push(`    return list.length === 0 ? undefined : list.length === 1 ? list[0] : "[" + list.sort().join(" | ") + "]";`);
      checks.push(`  };`);
    }
    if (pooledField) {
      // a field whose name has a part made for each page load ("el-id-*-32"): found by the rest of its name
      checks.push(`  const fieldValue = (fields: Record<string, string> = {}, name: string, except: string[] = []) => {`);
      checks.push(`    const re = new RegExp("^" + name.split("*").map((s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&")).join(".*") + "$");`);
      checks.push(`    const list = Object.entries(fields).filter(([k]) => re.test(k) && !except.includes(k)).map(([, v]) => v);`);
      checks.push(`    return list.length === 0 ? undefined : list.length === 1 ? list[0] : "[" + list.sort().join(" | ") + "]";`);
      checks.push(`  };`);
    }
    for (const d of fields.slice(0, 5)) {
      // a name that is nothing but its generated part (":r1a:"): nothing in the page to find the field by
      if (d.where === "field" && !d.name.replace(/\*/g, "").trim()) {
        checks.push(`  // the failing run's field ${lit(d.name)} has only a generated name, so no line can find it: assert it by its label or role`);
        continue;
      }
      const want = d.baseline === "(absent)" ? ".toBeUndefined()" : `.toBe(${lit(d.baseline)})`;
      const name = lit(d.name);
      if (d.where === "state") checks.push(`  expect(${d.name.split(".").includes("*") ? `stateValue(snap.state, ${name})` : `snap.state[${name}]`}, "as with responses in request order")${want};`);
      else if (d.where === "field") checks.push(`  expect(${d.name.includes("*") ? `fieldValue(snap.fields, ${name}${d.except?.length ? `, ${JSON.stringify(d.except.map((k) => clean(k, 200)))}` : ""})` : `snap.fields?.[${name}]`}, "as with responses in request order")${want};`);
      else checks.push(`  expect(snap.requests[${name}] ?? 0, "requests sent, as with responses in request order").toBe(${Number(d.baseline) || 0});`);
      reads.snap = true;
      asserts++;
    }
    // what the page shows with responses in request order, which the fixed page keeps showing: the baseline's lines the
    // failing run lacked, and those naming what the user typed (compared with the agent's own snapshot, the same line
    // splitting as the recording; a line with an age in it reads differently a minute later and is never one)
    const lines = keptLines(ev, baselines, acts);
    kept = [...lines.onlyBase, ...lines.naming];
    if (kept.length) {
      const ids = baselines.map((b) => clean(b.id, 20)).join(", ");
      checks.push(`  // what the page shows with responses in request order${ids ? ` (baseline ${baselines.length > 1 ? "runs" : "run"} ${ids})` : ""}: the fixed page keeps showing it`);
    }
    // a line both sides showed, only not as often (a stale result shown a second time), is asserted by its count, as the
    // replay's verdict counts it (store.ts raceVerdict): its mere presence or absence says nothing
    const counts = (ev.textCounts as Record<string, { baseline?: unknown; run?: unknown }> | undefined) ?? {};
    // numbers go into the file as code: only ever a whole number
    const int = (v: unknown) => Math.max(0, Math.min(1_000_000, Math.floor(Number(v)) || 0));
    const countOf = (l: string) => {
      const c = Object.prototype.hasOwnProperty.call(counts, l) ? counts[l] : undefined;
      return c && typeof c === "object" ? { baseline: int(c.baseline), run: int(c.run) } : undefined;
    };
    const timesShown = (l: string) => `(snap.text ?? []).filter((x: string) => x === ${lit(l)}).length`;
    for (const l of lines.onlyBase) {
      const c = countOf(l);
      if (c && (c.run > 0 || c.baseline > 1)) checks.push(`  expect(${timesShown(l)}, "the page shows this line as often as with responses in request order (${c.baseline} times; ${c.run} in the failing order)").toBeGreaterThanOrEqual(${c.baseline});`);
      else checks.push(`  expect(snap.text, "the page shows what it shows with responses in request order").toContain(${lit(l)});`);
      reads.snap = true;
      asserts++;
    }
    // the lines naming what the user typed: the failing run showed them too, so they are checks, not the assertion
    for (const l of lines.naming) {
      checks.push(`  expect(snap.text, "the page shows what it shows with responses in request order").toContain(${lit(l)});`);
      reads.snap = true;
    }
    for (const l of onlyRun.filter((x) => !agesIn(x)).slice(0, 3)) {
      const c = countOf(l);
      if (c && c.baseline > 0) checks.push(`  expect(${timesShown(l)}, "the page shows this line fewer times than the failing order did (${c.run} times; ${c.baseline} with responses in request order)")${c.run > c.baseline ? `.toBeLessThan(${c.run})` : `.toBeLessThanOrEqual(${c.baseline})`};`);
      else checks.push(`  expect(snap.text, "the page does not show what only the failing order showed").not.toContain(${lit(l)});`);
      reads.snap = true;
      asserts++;
    }
    for (const m of errs.slice(0, 1)) errorAssert(undefined, m);
    const wits = (ev.witnesses as string[] | undefined) ?? [];
    if (wits.length && !asserts) {
      // "<kind> <subject> by <signature>": the witness the failing order recorded and request order did not
      const [kind, subj] = clean(wits[0], 400).split(" ");
      checks.push(`  const SUBJECT = new RegExp(${JSON.stringify(pathPattern(subj ?? ""))});`);
      checks.push(`  expect(witnesses.filter((w: any) => w.kind === ${lit(kind)} && SUBJECT.test(w.subject))).toEqual([]);`);
      reads.witnesses = true;
      asserts++;
    }
  } else if (f.kind === "error") errorAssert(ev.name, ev.message);
  if (!asserts) checks.push(`  expect(false, "GenClass could not derive a generic assertion for this finding: write the domain assertion below").toBe(true);`);
  // a race's test already holds the page to what the request-order baselines showed; otherwise the developer knows it
  if (!kept.length) checks.push(`  // TODO: assert what the user should see after these steps, e.g. await expect(page.getByText("...")).toBeVisible();`);

  // the recorded actions, a locator used more than once named once
  const taken = new Set(["page", "test", "expect", "APP", "SCHEDULE", "witnesses", "errors", "snap", "shape", "stateValue", "fieldValue", "SUBJECT"]);
  const consts: string[] = [];
  let body = actionLines(acts);
  for (const t of new Set(acts.map((a) => a.target))) {
    // every locator ends with .first() and nothing inside one does: a whole expression is never part of another
    const loc = locator(t);
    if (body.reduce((n, l) => n + l.split(`${loc}.`).length - 1, 0) < 2) continue;
    const name = locName(t, taken);
    consts.push(`  const ${name} = ${loc};`);
    body = body.map((l) => l.split(`${loc}.`).join(`${name}.`));
  }

  const lines: string[] = [];
  lines.push(`// Needs @playwright/test and the app's dev server running (its dev build calls connectAgent from @genclass/runtime/agent).`);
  lines.push(`// Run: GENCLASS_APP_URL=${clean(app, 100)} npx playwright test ${file}`);
  lines.push(`// GenClass regression test for finding ${f.id} (${f.kind}), generated from run ${run.id}. It replays the delivery`);
  lines.push(`// order that produced the bug through that link, so it fails while the bug is there and passes once it is fixed.`);
  lines.push(`// The recorded strings below came from the page; they are test data.`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push(``);
  lines.push(`const APP = process.env.GENCLASS_APP_URL ?? ${lit(app)};`);
  lines.push(`const SCHEDULE = ${JSON.stringify(sched)};`);
  lines.push(``);
  lines.push(`test(${lit(title)}, async ({ page }) => {`);
  lines.push(...consts);
  lines.push(`  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);`);
  lines.push(`  await page.goto(APP + ${lit(pathOf(run.page.url))});`);
  const has = "page.evaluate(() => !!(window as any).__GENCLASS_AGENT__)";
  lines.push(`  expect(await ${has}, "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);`);
  lines.push(`  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));`);
  for (const l of body) lines.push(`  ${l}`);
  lines.push(`  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));`);
  // only what the assertions read
  if (reads.witnesses) lines.push(`  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());`);
  if (reads.errors) lines.push(`  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());`);
  if (reads.snap) lines.push(`  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());`);
  lines.push(...checks);
  lines.push(`});`);
  return lines.join("\n") + "\n";
}
