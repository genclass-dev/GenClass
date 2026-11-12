// `genclass ask "..."`: a question about the app, in plain words, answered by GenClass's model from what the runtime
// found on the live site (the dashboard's numbers for the app). In the command's home, a typed sentence is a
// question, and the questions before it in the same sitting are sent along, so "and on which page?" works.
//
// Invariants:
// - What leaves the machine is the question and at most three earlier questions and answers. The app's numbers are
//   read on genclass.dev, where they already are. Never code, never a file of the project.
// - The first time, the command says what is sent and where it goes, and waits for Enter. The answer to that is
//   remembered next to the sign-in (prefs.json), so it is asked once per machine.
// - The answer is the model's and is printed as text: cleaned of control characters, wrapped, never run or opened.
//   It can be wrong; the numbers it rests on are one command away and the screen says which.
// - No dead end: no model on the server, the day's runs used up, or a model that did not answer each say so and
//   name the command that shows the numbers themselves.

import { c, interactive, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { askModel } from "./api.mjs";
import { n, pickApp, RANGE_WORDS } from "./app.mjs";
import { brand } from "./art.mjs";
import { readPrefs, savePrefs } from "./name.mjs";
import { asking, refused } from "./session.mjs";
import { clean, header, note, PROMPT, spinner, typed, warn, width, wrap } from "./tui.mjs";

/** The earlier questions and answers of this sitting, per app: sent along so a follow-up makes sense. */
const turns = new Map();
/** For the tests: forget every earlier question. */
export const forget = () => turns.clear();

/**
 * A line of the model's answer with its Markdown marks turned into the terminal's: `code` in cyan and **strong** in
 * bold, without the backticks and asterisks. Each word is painted on its own, so a span that wraps onto the next
 * line leaves no colour open across the bar.
 */
export function marks(line) {
  const paint = (text, f) => text.split(" ").map((w) => (w ? f(w) : w)).join(" ");
  return line.replace(/`([^`]+)`/g, (_, x) => paint(x, c.cyan)).replace(/\*\*([^*]+)\*\*/g, (_, x) => paint(x, c.bold));
}

/** The model's answer as lines for the terminal: beside a bar, wrapped, list lines kept as list lines. */
export function answerLines(text, cols = width() - 6) {
  const lines = [];
  for (const raw of String(text).split("\n")) {
    const l = marks(clean(raw, 600));
    if (!l) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const m = /^([-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (m) {
      const mark = /^\d/.test(m[1]) ? m[1] : "-";
      wrap(m[2], cols - mark.length - 1).forEach((w, i) => lines.push(`${i ? " ".repeat(mark.length) : mark} ${w}`));
    } else lines.push(...wrap(l, cols));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * `genclass ask <question>`. Exit code 0 with an answer; 1 when there is none (signed out, refused, no model);
 * 2 when no question was given.
 * @param {{ question?: string, range?: string, app?: string, cwd?: string, json?: boolean, yes?: boolean }} o
 */
export async function ask(o = {}, deps = {}) {
  let question = String(o.question ?? "").trim();
  if (!question && interactive() && !o.json) {
    const a = await typed(`  ${PROMPT()} ${c.gray("Ask about your app:")} `);
    question = String(a ?? "").trim();
  }
  if (!question) {
    if (o.json) out(JSON.stringify({ ok: false, error: "a question is needed", run: 'npx genclass ask "what is going wrong on my site?"' }));
    else {
      out();
      note("Ask something about your app, in your own words:");
      out(`    ${c.cyan('npx genclass ask "what is going wrong on my site?"')}`);
      out(`    ${c.cyan('npx genclass ask "which page loses the most visitors?"')}`);
      out();
    }
    return 2;
  }
  const picked = await pickApp(o, deps, "ask");
  if ("code" in picked) return picked.code;
  const { state, creds, target } = picked;
  const range = ["24h", "7d", "30d", "90d", "1y"].includes(o.range) ? o.range : "7d";
  if (!o.json) header({ app: target.name, framework: state.app.token === target.token ? state.app.framework : null, account: state.account?.label, plan: state.account?.plan?.name, host: state.host });
  // once per machine: what is sent, and where
  const prefs = (deps.readPrefs ?? readPrefs)();
  if (!prefs.askTold) {
    const told = "Your question goes to GenClass's model on genclass.dev, with this app's dashboard numbers: pages, kinds of problem and counts, and with visitor analytics the sources and the names of what people click. The model is OpenAI's. No code leaves your machine, and neither the question nor the answer is stored.";
    if (o.json || o.yes || !interactive()) process.stderr.write(`genclass ask: ${told}\n`);
    else {
      note(told);
      const a = await typed(`  ${PROMPT()} ${c.bold("Enter")} ${c.gray("to ask ·")} ${c.bold("q")} ${c.gray("stop")} `);
      if (a === null || /^q/i.test(a)) {
        out();
        return 1;
      }
    }
    (deps.savePrefs ?? savePrefs)({ askTold: true });
  }
  const history = turns.get(target.id) ?? [];
  const sp = o.json ? null : spinner("Reading your app's numbers");
  const r = await asking({ ...o, json: o.json }, creds, (cr) => askModel(cr, { id: target.id, range, question, history }, deps), deps);
  sp?.stop(null);
  if (!r.ok) return refused(r, { what: "A question to the model", command: `ask "${clean(question, 40)}"`, browserUrl: target.dashboard_url, json: o.json });
  if (o.json) {
    out(JSON.stringify({ ok: r.answer !== null, app: target.name, range: r.range ?? range, question, answer: r.answer, why: r.why, remaining_today: r.remainingToday }, null, 2));
    return r.answer === null ? 1 : 0;
  }
  if (r.answer === null) {
    if (r.why === "limit") {
      warn(`Today's ${r.perDay === null ? "" : `${n(r.perDay)} `}model runs are used (ask and suggest share them). They come back tomorrow.`);
      if (r.upgradeUrl) out(`  ${c.gray("More a day with the Team plan:")} ${c.cyan("npx genclass plan")}`);
    } else if (r.why === "no-model") note("This genclass.dev has no model to ask, so there is no answer in words.");
    else warn("The model did not answer this time. Asking again in a moment usually works.");
    out(`  ${c.gray("The numbers themselves:")} ${c.cyan("npx genclass problems")}`);
    out();
    return 1;
  }
  const bar = brand("▎");
  for (const l of answerLines(r.answer)) out(`  ${bar} ${l}`);
  turns.set(target.id, [...history, { q: question, a: r.answer }].slice(-3));
  out();
  const left = r.remainingToday === null ? "" : ` ${sym.dot} ${n(r.remainingToday)} question${r.remainingToday === 1 ? "" : "s"} left today`;
  note(`From ${clean(target.name, 40)}'s numbers, ${RANGE_WORDS[r.range ?? range] ?? range}${left}`);
  out(`  ${c.gray("The numbers:")} ${c.cyan("npx genclass problems")}`);
  out(`  ${c.gray("Fix it:     ")} ${c.cyan("npx genclass fix")}`);
  out();
  return 0;
}
