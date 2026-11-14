// `genclass fix`: the problems GenClass found on the live site, handed to the person's coding agent to fix. It lists
// them, takes a pick (one kind, or all of them), and starts the agent in the project folder with the prompt the
// dashboard's "Copy prompt" and "Fix all" buttons copy (kinds.mjs): what was found, where, how it is usually fixed,
// and the steps that reproduce it and prove the fix with GenClass's MCP server.
//
// Invariants:
// - GenClass itself changes no code. The fix is the agent's, in the person's own session with it, where they see and
//   approve what it does. This command only starts that session (or copies or prints the prompt).
// - Nothing starts without a key press: Enter starts the agent, c copies, p prints, q stops. Piped, with --print or
//   --json, the prompt is printed and nothing else happens, so an agent can run `genclass fix --print` itself.
// - The prompt names pages and counts from the dashboard. It holds nothing from the person's code, which this
//   command never reads, and it is sent nowhere: it goes to the agent on this machine, the clipboard or the screen.
// - An agent is started only when its command is on the PATH, in the app's own folder, with the terminal handed to
//   it; when it ends, this command carries on.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { c, interactive, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { appView, KINDS, n, RANGE_WORDS } from "./app.mjs";
import { fixAllPrompt, fixPrompt, infoOf, problemList } from "./kinds.mjs";
import { agentSetup } from "./views.mjs";
import { clean, good, note, PROMPT, typed, warn, width, wrap } from "./tui.mjs";

/** The coding agents this command can start, in the order they are looked for: [command, name, arguments for a prompt]. */
export const AGENTS = [
  ["claude", "Claude Code", (p) => [p]],
  ["codex", "Codex", (p) => [p]],
  ["cursor-agent", "Cursor", (p) => [p]],
  ["gemini", "Gemini CLI", (p) => ["-i", p]],
];

/** The full path of a command on the PATH, or null. */
export function onPath(name, env = process.env, platform = process.platform) {
  const names = platform === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const f of names) {
      try {
        const file = join(dir, f);
        if (!statSync(file).isFile()) continue;
        if (platform !== "win32") accessSync(file, constants.X_OK);
        return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** The agents installed on this machine: [{ cmd, name, args }]. `only`: a command or a name, to pick one. */
export function findAgents(only = null, find = onPath) {
  const want = only ? String(only).toLowerCase() : null;
  return AGENTS.filter(([cmd, name]) => !want || cmd === want || name.toLowerCase() === want || name.toLowerCase().split(" ")[0] === want)
    .filter(([cmd]) => find(cmd))
    .map(([cmd, name, args]) => ({ cmd, name, args }));
}

/** Puts `text` on the clipboard. Resolves whether it worked. */
export function copyText(text, platform = process.platform, run = spawn) {
  const tries = platform === "darwin" ? [["pbcopy", []]] : platform === "win32" ? [["clip", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  const attempt = (i) =>
    new Promise((done) => {
      if (i >= tries.length) return done(false);
      let child;
      try {
        child = run(tries[i][0], tries[i][1], { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        return done(attempt(i + 1));
      }
      child.on("error", () => done(attempt(i + 1)));
      child.on("close", (code) => done(code === 0 ? true : attempt(i + 1)));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text);
    });
  return attempt(0);
}

/** Starts an agent with the prompt in `cwd`, the terminal handed to it. Resolves its exit code (null: it did not start). */
export function startAgent(agent, prompt, cwd, run = spawn) {
  return new Promise((done) => {
    let child;
    try {
      child = run(process.platform === "win32" ? `${agent.cmd}.cmd` : agent.cmd, agent.args(prompt), { cwd, stdio: "inherit" });
    } catch {
      return done(null);
    }
    child.on("error", () => done(null));
    child.on("close", (code) => done(code ?? 0));
  });
}

/** Which problem a typed word means: its number in the list, its key, or "all" (also "a"); null when none. */
export function pickProblem(list, word) {
  const w = String(word ?? "").trim().toLowerCase();
  if (!w) return null;
  if (w === "all" || w === "a") return "all";
  if (/^\d+$/.test(w)) return list[Number(w) - 1] ?? null;
  return list.find((x) => x.key === w) ?? list.find((x) => infoOf(x).name.toLowerCase() === w) ?? null;
}

function listProblems(list, shown) {
  const top = list.slice(0, shown);
  const wNum = String(top.length).length;
  top.forEach((x, i) => {
    const info = infoOf(x);
    out(`    ${c.cyan(String(i + 1).padStart(wNum))}  ${c.bold(clean(info.name, 40))}  ${c.gray(`${n(x.count)} time${x.count === 1 ? "" : "s"}${x.check ? ", visual check" : ""}`)}`);
    const pages = x.where.slice(0, 3).map((w) => clean(w.route, 40)).join(", ");
    // the dashboard's words for the same kind, so the two screens name it the same way (the 0.3.9 user stories)
    const plain = KINDS[x.key];
    const under = [plain, pages && `on ${pages}`].filter(Boolean).join(", ");
    if (under) for (const l of wrap(under, width() - 2 - 6 - wNum)) out(`    ${" ".repeat(wNum + 2)}${c.gray(l)}`);
  });
  if (list.length > shown) out(`    ${c.gray(`and ${n(list.length - shown)} more: add --all`)}`);
}

/**
 * `genclass fix [number | kind | all]`. Exit code 0; 1 when the app's numbers could not be read or the agent did
 * not start; 2 when the word after `fix` names no problem.
 * @param {{ what?: string, print?: boolean, copy?: boolean, agent?: string, all?: boolean, json?: boolean, range?: string, cwd?: string, app?: string }} o
 * @param {{ agents?: Function, start?: Function, copy?: Function }} [deps]
 */
export function fix(o = {}, deps = {}) {
  const promptFor = (target, app, list, pick) => (pick === "all" ? fixAllPrompt(target.name, app.range, list) : fixPrompt(target.name, app.range, pick));
  return appView(o, deps, {
    name: "fix",
    // the prompt alone when it is asked for as text: nothing else on the screen
    plain: !!o.print || (!interactive() && !o.copy),
    json: (app, _s, target) => {
      const list = problemList(app.more.breakdowns);
      const pick = o.what ? pickProblem(list, o.what) : "all";
      return { ok: true, app: target.name, range: app.range, problems: list.map((x) => ({ key: x.key, name: infoOf(x).name, count: x.count, visual_check: x.check, pages: x.where.slice(0, 10) })), prompt: list.length && pick ? promptFor(target, app, list, pick) : null };
    },
    show: async (app, state, target) => {
      const list = problemList(app.more.breakdowns);
      const plain = !!o.print || (!interactive() && !o.copy);
      if (!list.length) {
        if (plain) process.stderr.write(`genclass fix: no problems found in the ${RANGE_WORDS[app.range] ?? app.range}\n`);
        else {
          out(`  ${c.gray(RANGE_WORDS[app.range] ?? app.range)}`);
          out();
          good("No problems found in this period, so there is nothing to fix.");
          if (app.totals.possible) note(`${n(app.totals.possible)} possible problems (lower confidence) are listed by: npx genclass problems --all`);
          out();
        }
        return 0;
      }
      let pick = o.what ? pickProblem(list, o.what) : null;
      if (o.what && !pick) {
        const said = `No problem "${clean(o.what, 40)}" in this period. Use a number from the list, a kind (${list.slice(0, 3).map((x) => x.key).join(", ")}) or all.`;
        if (plain) process.stderr.write(`genclass fix: ${said}\n`);
        else {
          warn(said);
          out();
          listProblems(list, list.length);
          out();
        }
        return 2;
      }
      if (plain) {
        out(promptFor(target, app, list, pick ?? "all"));
        return 0;
      }
      const here = state.app.token === target.token;
      out(`  ${c.gray(RANGE_WORDS[app.range] ?? app.range)}${app.demo ? c.gray(` ${sym.dot} sample data`) : ""}`);
      out();
      if (!pick) {
        out(`  ${c.bold("What GenClass found on the live site")}`);
        listProblems(list, o.all ? list.length : 8);
        out();
        if (list.length === 1) pick = list[0];
        else {
          const a = await typed(`  ${PROMPT()} ${c.gray("a number, or")} ${c.bold("Enter")} ${c.gray("for all of them ·")} ${c.bold("q")} ${c.gray("stop")} `);
          if (a === null || /^q/i.test(a)) return 0;
          pick = a === "" ? "all" : pickProblem(list, a);
          if (!pick) {
            warn(`"${clean(a, 20)}" is not in the list.`);
            out();
            return 2;
          }
        }
      }
      const prompt = promptFor(target, app, list, pick);
      const what = pick === "all" ? `all ${n(list.length)} kinds of problem` : infoOf(pick).name.toLowerCase();
      // the prompt's steps use GenClass's MCP server: say so when the agent does not have it here
      if (here && !agentSetup(state.cwd, deps.home).files.length) {
        note("Your agent needs GenClass's MCP server for the steps in this prompt. npx genclass setup adds it (the coding agent step).");
        out();
      }
      if (o.copy) {
        if (await (deps.copy ?? copyText)(prompt)) {
          good(`Copied the prompt for ${what}.`);
          note("Paste it to your coding agent, in the app's folder.");
        } else {
          warn("Could not reach the clipboard, so here it is:");
          out();
          out(prompt);
        }
        out();
        return 0;
      }
      const agents = here ? (deps.agents ?? findAgents)(o.agent ?? null) : [];
      if (!here) note(`This folder is not ${clean(target.name, 40)}'s. Run this in the app's folder and its coding agent can be started on the code from here.`);
      else if (!agents.length) note(o.agent ? `No ${clean(o.agent, 20)} command on this machine.` : "No coding agent's command found on this machine (claude, codex, cursor-agent, gemini).");
      const agentLine = agents.length ? `${c.bold("Enter")} ${c.gray(`start ${agents[0].name} ·`)} ` : "";
      out(`  ${c.bold(`A prompt for ${what} is ready.`)}`);
      note(`It tells the agent what was found, where, how it is usually fixed, and how to reproduce it and prove the fix. GenClass changes no code: the agent does, with you watching.`);
      const a = await typed(`  ${PROMPT()} ${agentLine}${c.bold("c")} ${c.gray("copy ·")} ${c.bold("p")} ${c.gray("print ·")} ${c.bold("q")} ${c.gray("stop")} `);
      if (a === null || /^q/i.test(a)) return 0;
      if (/^p/i.test(a)) {
        out();
        out(prompt);
        out();
        return 0;
      }
      if (/^c/i.test(a) || !agents.length) {
        if (await (deps.copy ?? copyText)(prompt)) {
          good("Copied the prompt.");
          note("Paste it to your coding agent, in the app's folder.");
        } else {
          warn("Could not reach the clipboard, so here it is:");
          out();
          out(prompt);
        }
        out();
        return 0;
      }
      out();
      out(`  ${c.gray(sym.arrow)} Starting ${c.bold(agents[0].name)} in this folder, with the prompt.`);
      note("When you leave it, you are back here.");
      out();
      // the terminal is the agent's until it ends
      await new Promise((r) => setTimeout(r, 30));
      const code = await (deps.start ?? startAgent)(agents[0], prompt, state.cwd);
      out();
      if (code === null) {
        warn(`${agents[0].name} did not start. The prompt, to paste by hand:`);
        out();
        out(prompt);
        out();
        return 1;
      }
      good(`Back from ${agents[0].name}.`);
      note("A fix shows here once it is deployed and the live site has been used again.");
      out(`  ${c.gray("What is left:")} ${c.cyan("npx genclass problems")}`);
      out();
      return 0;
    },
  });
}
