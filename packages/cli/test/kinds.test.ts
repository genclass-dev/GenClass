// The texts `genclass fix` and `genclass report` use (src/kinds.mjs) are the dashboard page's own: this reads the
// page's source and fails when a sentence here is not in it, so the two cannot drift apart unnoticed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTION_NAMES, CHECK_DO, checkFixed, checkOf, CHECKS, didAct, fixAllPrompt, fixPrompt, markdown, problemList, TYPES, typeOf } from "../src/kinds.mjs";
import { appOf, STATS } from "./stats.js";

// the page's script is a string in a template literal: \\u201c there is “ in the browser
const PAGE = readFileSync(fileURLToPath(new URL("../../../telemetry-worker/src/pages.ts", import.meta.url)), "utf8").replace(/\\\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

describe("genclass fix: the kinds and their texts (src/kinds.mjs) are the dashboard's", () => {
  it("every name, meaning and usual fix is in the dashboard page word for word", () => {
    const missing: string[] = [];
    for (const [k, t] of [...Object.entries(TYPES), ...Object.entries(CHECKS)] as [string, { name: string; what: string; fix: string }][]) for (const text of [t.name, t.what, t.fix]) if (!PAGE.includes(text)) missing.push(`${k}: ${text.slice(0, 60)}`);
    for (const [k, text] of Object.entries(CHECK_DO)) if (!PAGE.includes(text as string)) missing.push(`${k}: ${(text as string).slice(0, 60)}`);
    for (const [k, text] of Object.entries(ACTION_NAMES)) if (!PAGE.includes(`"${text}"`)) missing.push(`${k}: ${text}`);
    expect(missing).toEqual([]);
    // and the page has no kind this file lacks
    const keys = (name: string) => [...PAGE.slice(PAGE.indexOf(`var ${name} = {`), PAGE.indexOf("};", PAGE.indexOf(`var ${name} = {`))).matchAll(/^\s+"?([a-z-]+)"?: \{ name:/gm)].map((m) => m[1]);
    expect(keys("TYPES").sort()).toEqual(Object.keys(TYPES).sort());
    expect(keys("CHECKS").sort()).toEqual(Object.keys(CHECKS).sort());
  });

  it("the prompts carry the page's own sentences: the steps, the wait, the proof", () => {
    const app = "shop";
    const list = problemList(STATS.breakdowns);
    const one = fixPrompt(app, "7d", list.find((x) => x.key === "stale")!);
    const check = fixPrompt(app, "7d", list.find((x) => x.key === "text-invisible")!);
    const all = fixAllPrompt(app, "7d", list);
    // each sentence of a prompt that is fixed text is in the page (the parts the page builds are joined with +)
    for (const line of [
      "Fix a problem GenClass found in production in this web app (",
      "2. Find the code behind it and fix it; keep the regression test genclass_explain generates.",
      "3. Replay the recorded order again with genclass_replay: it must say not reproduced.",
      "4. Tell me what you changed, the test you added and the replay's verdict.",
      "When a step needs page loads on the dev page, tell me in one line exactly what to do there",
      "Fix a problem GenClass measured in production in this web app (",
      "2. Find the code or CSS behind it and fix it at the cause (the suggested CSS is a starting point, not a patch).",
      "4. Tell me what you changed and what genclass_scan listed before and after.",
      "1. genclass_status: the dev page must be connected; if it is not, tell me what to open.",
      "5. Sum up in one line per problem: what it was, the proof, the fix.",
    ]) {
      expect(PAGE).toContain(line);
      expect(`${one}\n${check}\n${all}`).toContain(line);
    }
    expect(one).toContain("stale responses, 11 times in the last 7 days, on /search (9), /checkout (2).");
    expect(one).toContain("genclass_explore with focus on the request behind /search");
    expect(check).toContain("invisible text (the measured check text-invisible), 6 times in the last 7 days, on /pricing (6).");
    expect(check).toContain("3. Run genclass_scan on the page again, after the same steps: it must not list text-invisible any more.");
    expect(all).toContain("- Double submits, 14 times, on /checkout. Usual fix: Disable the control while the request is in flight");
    expect(all).toContain("- Invisible text (measured check text-invisible), 6 times, on /pricing.");
    expect(all).toContain("For a measured check, genclass_scan on its page must no longer list it.");
    // nothing but the app's name, pages and counts comes from outside
    expect(`${one}${all}`).not.toContain("gc_AbCdEf");
  });

  it("problemList: the model's kinds and the measured checks, the most frequent first, without `expected`", () => {
    const list = problemList(STATS.breakdowns);
    expect(list.map((x) => [x.key, x.count, x.check])).toEqual([["duplicate", 14, false], ["stale", 11, false], ["text-invisible", 6, true], ["failing", 3, false], ["image-broken", 3, true], ["odd_plugin_kind", 2, false]]);
    expect(list[1]!.where).toEqual([{ route: "/search", count: 9 }, { route: "/checkout", count: 2 }]);
    expect(problemList({})).toEqual([]);
    // a kind this file does not know keeps its own name, made readable, and nothing is said about it
    expect(typeOf("odd_plugin_kind")).toEqual({ name: "Odd plugin kind", what: "", fix: "" });
    expect(checkOf("new-check")).toEqual({ name: "New check", what: "", fix: "" });
    expect(checkFixed(STATS.totals, STATS.breakdowns)).toBe(4);
    expect(didAct({ tier: "acted", executed: true, ran: "discard" })).toBe(true);
    expect(didAct({ tier: "acted", executed: true, ran: "deliver" })).toBe(false);
    expect(didAct({ tier: "detect", executed: false, ran: null })).toBe(false);
  });

  it("the Markdown report has the dashboard's sections and numbers", async () => {
    const md = markdown("shop", await appOf(), "2026-11-12T12:00:00.000Z");
    expect(md.split("\n")[0]).toBe("# shop (GenClass dashboard)");
    expect(md).toContain("In the last 7 days, to 2026-11-12 12:00 UTC.");
    expect(md).toContain("| Page loads | 1,204 |");
    expect(md).toContain("| Problems found | 39 |");
    expect(md).toContain("| Pages with a problem | 5 |");
    expect(md).toContain("| Times GenClass stepped in | 12 |");
    expect(md).toContain("### Double submits: 14");
    expect(md).toContain("Pages: `/checkout` (14)");
    expect(md).toContain("### Invisible text (text-invisible): 6");
    expect(md).toContain("| Merged a repeated request | 7 |");
    expect(md).toContain("| Fixed a measured check | 5 |");
    expect(md).toContain("| 2026-11-12 11:57 | /search | Stale responses | 94% | Dropped a stale write |");
    expect(md).toContain("| 2026-11-12 11:20 | /checkout | Double submits | 88% | Reported |");
    expect(md).toContain("Counts only: GenClass stores no text from the app's pages.");
    for (const line of ["Counts only: GenClass stores no text from the app's pages. Guide: https://genclass.dev/docs/dashboard", "Measurements with fixed thresholds, not model findings: genclass_scan on the page lists each one with its element and a suggested CSS change."]) expect(PAGE).toContain(line);
  });
});
