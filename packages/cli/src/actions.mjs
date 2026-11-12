// What each step of `genclass setup` does when it is its turn: sign in, add the runtime, watch for the first page,
// add the workflow file and check the GitHub App, connect a coding agent. Each returns "done", "skipped" or "failed".
//
// Invariants:
// - Nothing is written before the person has seen what will be written and said yes (or passed --yes). The runtime is
//   added by the runtime CLI's own `init` (packages/runtime/bin/lib/init.mjs), which shows its diff and asks.
// - No git command that changes anything is run: a new file is left for the person to commit, and the command to do
//   so is printed.
// - No secret is asked for or typed here. Signing in and installing the GitHub App happen in the browser; this
//   process only waits for genclass.dev to say they happened.
// - A question that gets no answer because input ended is a no (tui.mjs agree, pick): nothing is written, sent or
//   opened on an empty answer unless someone could still have typed one.
// - Nothing this command sets up is drawn on a page: the runtime is added without the developer overlay
//   (runtimeArgs), so a site's visitors and its developer see their own layout and nothing of GenClass's.
// - A browser is opened only for addresses on the host this CLI talks to, built here or checked against that host
//   (api.mjs), never one taken from a file or a page.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pollDeviceLogin, readCredentials, saveCredentials, startDeviceLogin } from "../../runtime/bin/lib/account.mjs";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { apiHost, hostConfig, hostUrl } from "../../runtime/bin/lib/host.mjs";
import { accountLabel, run as runInit } from "../../runtime/bin/lib/init.mjs";
import { run as runLogin } from "../../runtime/bin/lib/login.mjs";
import { c, interactive, out, printChange, stopOnEnter, sym } from "../../runtime/bin/lib/ui.mjs";
import { fetchOverview, fetchRepoStatus } from "./api.mjs";
import { BUILD, SKILL_FILE, WORKFLOW_FILE } from "./assets.mjs";
import { freeLimits, WORKFLOW_PATH } from "./state.mjs";
import { saveNotes } from "./store.mjs";
import { agree, bad, good, note, planCard, PROMPT, spinner, typed, warn } from "./tui.mjs";
import { planViteSettings } from "./vite.mjs";

/** Resolves after `ms`, or at once when `signal` aborts. */
const nap = (ms, signal) =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        r();
      },
      { once: true },
    );
  });
/** What a wait's line ends with on a terminal: the person is never held by one. */
const canStop = () => (interactive() ? c.gray(" (Enter to stop waiting)") : "");

/** Opens `url` in the default browser when that makes sense here. Returns whether it tried; never throws. */
export function openBrowser(url, o = {}) {
  const env = process.env;
  if (o.noBrowser || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ 1. sign in

/** The device sign-in: a code and a link, the browser opened on it, and a wait until it is approved. */
export async function signIn(o = {}) {
  const h = hostConfig();
  if (h.error) {
    bad(h.error);
    return "failed";
  }
  const dev = await startDeviceLogin();
  if (!dev.ok) {
    bad(`Could not start the sign-in: ${dev.reason}`);
    return "failed";
  }
  out();
  out(`  Open  ${c.cyan(dev.verification_uri_complete)}`);
  out(`  Code  ${c.bold(dev.user_code)}  ${c.gray("(the page must show the same code)")}`);
  out();
  if (openBrowser(dev.verification_uri_complete, o)) note("Your browser is opening that page.");
  const stop = stopOnEnter();
  const sp = spinner(`Waiting for you to approve in the browser${canStop()}`);
  const r = await pollDeviceLogin(dev, { signal: stop.signal });
  await stop.done();
  if (!r.ok && r.error === "cancelled") {
    sp.stop("warn", "Stopped waiting. Nothing was signed in; run npx genclass again when you want to.");
    return "skipped";
  }
  if (!r.ok) {
    sp.stop("bad", r.error === "access_denied" ? "The sign-in was denied in the browser." : r.error === "expired_token" ? "The code expired before it was approved (codes last ten minutes)." : `The sign-in did not finish: ${r.reason}`);
    return "failed";
  }
  saveCredentials({ host: apiHost(), access_token: r.access_token, account: r.account });
  sp.stop("ok", `Signed in as ${c.bold(accountLabel(r.account))}`);
  return "done";
}

// ------------------------------------------------------------------------------------------------ 1b. the plan

/**
 * The plan step, for an account on Free that can buy a plan here: the paid plan's card, then one question. Enter
 * opens that plan's checkout in the browser (genclass.dev sends the person straight to Stripe) and waits for the
 * payment; f goes on with Free for this project, and that choice is remembered so the project is asked once. With
 * --yes, or with nobody at a terminal, nothing is bought and nothing is opened: it is Free for now, said in one line
 * with where the plan starts. Returns "done", "skipped" (asked again next run) or "quit" (q: stop the walk).
 * @param {{ fetchFn?: typeof fetch, waitMs?: number, everyMs?: number }} [deps]
 */
export async function choosePlan(state, o = {}, deps = {}) {
  const offer = state.steps.find((s) => s.id === "plan")?.offer;
  if (!offer) return "skipped";
  const free = offer.free.name;
  const limits = freeLimits(offer.free);
  const stayFree = (line) => {
    saveNotes(state.cwd, { plan: "free", planAt: new Date().toISOString() });
    note(line);
    return "done";
  };
  if (o.yes || !interactive()) return stayFree(`${free} for now (limited${limits ? `: ${limits}` : ""}). ${offer.plan.name}, ${offer.price}: ${offer.checkoutUrl}`);
  planCard(offer, state.app?.name ?? null);
  // the small way on, in the owner's words
  out(`  ${c.gray(`f  Try ${free.toLowerCase()} for now (limited)`)}`);
  const dot = c.gray("·");
  const a = await typed(`  ${PROMPT()} ${c.bold("Enter")} ${c.gray(`to start ${offer.plan.name}`)} ${dot} ${c.bold("f")} ${c.gray("free for now")} ${dot} ${c.bold("q")} ${c.gray("stop")}  `);
  if (a === null || /^q/i.test(a)) return "quit";
  if (/^[fs]/i.test(a)) return stayFree(`${free} for now. ${offer.plan.name} any time: ${offer.checkoutUrl}`);
  if (await checkout(offer, o, deps)) return "done";
  note(`This project goes on with ${free} for now.`);
  return "skipped";
}

/**
 * Opens a plan's checkout in the browser and waits for the payment (Enter stops the wait). The page is
 * genclass.dev's, the payment is Stripe's; this command never sees a card. Returns whether the plan became active.
 * @param {{ plan: { name: string }, checkoutUrl: string }} offer
 * @param {{ fetchFn?: typeof fetch, waitMs?: number, everyMs?: number }} [deps]
 */
export async function checkout(offer, o = {}, deps = {}) {
  out();
  out(`  Open  ${c.cyan(offer.checkoutUrl)}`);
  if (openBrowser(offer.checkoutUrl, o)) note("Your browser is opening the checkout.");
  const creds = readCredentials();
  const stop = stopOnEnter();
  const sp = spinner(`Waiting for the payment in the browser${canStop()}`);
  const until = Date.now() + (deps.waitMs ?? 10 * 60_000);
  let paid = false;
  while (creds && !stop.signal.aborted && Date.now() < until) {
    await nap(deps.everyMs ?? 3000, stop.signal);
    if (stop.signal.aborted) break;
    const me = await fetchOverview(creds, deps);
    if (me.ok && me.plan && me.plan.id !== "free") {
      paid = true;
      break;
    }
  }
  await stop.done();
  if (paid) sp.stop("ok", `${offer.plan.name} is active. Thank you.`);
  else sp.stop("warn", `No payment yet. ${offer.plan.name} starts the moment the payment goes through.`);
  return paid;
}

// ------------------------------------------------------------------------------------------------ 2. the runtime

/**
 * The arguments the runtime step hands to the runtime CLI's `init` (a fresh project) or `connect` (added, not in
 * the account yet). `init` gets --no-devtools: GenClass set up by this command draws nothing on a page, not on the
 * deployed site (it never did) and not on localhost either (the developer overlay is left out). What it finds goes
 * to the browser console, the dashboard and `genclass dashboard`.
 */
export function runtimeArgs(state, o = {}) {
  const connect = state.steps.find((s) => s.id === "runtime")?.run === "npx genclass connect";
  // signed in one step earlier, so the app goes into that account without asking again
  const args = ["--cwd", state.cwd, ...(o.yes ? ["--yes"] : []), ...(state.signedIn ? ["--in-account"] : [])];
  // --brief: the walk has its own header, so init says the same things in a few lines
  return { cmd: connect ? "connect" : "init", args: connect ? args : [...args, "--no-devtools", "--brief"] };
}

/**
 * Adds the runtime with the runtime CLI's own init (fresh project) or connect (added, not in the account), then the
 * two build settings an app on Vite 7 or earlier needs with it (vite.mjs). When those settings are all that is
 * missing (the step says so), only they are written.
 */
export async function addRuntime(state, o = {}) {
  if (!state.steps.find((s) => s.id === "runtime")?.vite) {
    const { cmd, args } = runtimeArgs(state, o);
    const code = cmd === "connect" ? await runLogin("connect", args) : await runInit("init", args);
    if (code !== 0) return "failed";
  }
  return (await addViteSettings(state, o)) === "failed" ? "failed" : "done";
}

/** Shows the two Vite settings and writes them on a yes (--yes, or one question on a terminal). */
export async function addViteSettings(state, o = {}) {
  let plan = null;
  try {
    plan = planViteSettings(state.cwd, detectProject(state.cwd));
  } catch {
    plan = null;
  }
  if (!plan) return "done";
  out();
  if (plan.note) {
    warn(plan.note);
    return "skipped";
  }
  warn(`Vite ${plan.major} needs two settings for the model's worker.`);
  note('Without them "vite build" fails.');
  out();
  printChange(plan.change);
  if (!o.yes) {
    if (!interactive()) {
      note(`Not a terminal: run ${c.cyan("npx genclass setup --yes")} to write them.`);
      return "skipped";
    }
    if (!(await agree("Add them?"))) {
      note("Left as it is. The two lines are above when you want them.");
      return "skipped";
    }
  }
  try {
    writeFileSync(plan.change.path, plan.change.after);
  } catch (e) {
    bad(`Could not write ${plan.change.file}: ${e?.message ?? e}`);
    return "failed";
  }
  good(`${plan.change.kind === "create" ? "Wrote" : "Updated"} ${c.bold(plan.change.file)} ${c.gray("(your build and dev server now handle the model's worker)")}`);
  note("Vite 8 needs neither setting. npx genclass remove takes them out again.");
  return "done";
}

// ------------------------------------------------------------------------------------------------ 3. first page

/** Waits (up to `seconds`) for genclass.dev to have received a first event from this app. */
export async function watchFirstPage(state, o = {}) {
  const creds = readCredentials();
  if (!creds || !state.app.token) return "skipped";
  if (!o.yes && interactive()) {
    const ok = await agree("Is your site deployed with GenClass in it? I will watch for its first page for two minutes", false);
    if (!ok) {
      note("No problem. Deploy as you normally do, open the live site once, and run genclass again: this step turns green by itself.");
      return "skipped";
    }
  } else return "skipped";
  const stop = stopOnEnter();
  const sp = spinner(`Open your live site in a browser now. Watching for its first page${canStop()}`);
  const until = Date.now() + (o.seconds ?? 120) * 1000;
  while (Date.now() < until && !stop.signal.aborted) {
    await nap(5000, stop.signal);
    if (stop.signal.aborted) break;
    const me = await fetchOverview(creds);
    if (me.ok && me.projects.find((p) => p.token === state.app.token)?.last_event) {
      await stop.done();
      sp.stop("ok", "GenClass received the first page from your site. Your dashboard is filling.");
      return "done";
    }
  }
  await stop.done();
  sp.stop("warn", "Nothing arrived yet. GenClass sends nothing from localhost or a private address; run npx genclass again after the live site was opened.");
  return "skipped";
}

// ------------------------------------------------------------------------------------------------ 4. pull requests

/**
 * The workflow file for a project that is `sub` below the repository's root ("" at the root): the job runs in that
 * folder and uploads the race files from it. Null when `sub` holds a character a workflow path should not.
 */
export function workflowFor(sub) {
  if (!sub) return WORKFLOW_FILE;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(sub) || sub.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  const withDir = WORKFLOW_FILE.replace("    timeout-minutes: 45\n", `    timeout-minutes: 45\n    defaults:\n      run:\n        working-directory: ${sub}\n`).replace("          path: test-results/genclass\n", `          path: ${sub}/test-results/genclass\n`);
  return withDir.includes(`working-directory: ${sub}`) && withDir.includes(`path: ${sub}/test-results/genclass`) ? withDir : null;
}

/**
 * Writes the workflow file at the repository's root. On a terminal the step's Enter is the yes (`o.confirmed`);
 * `--yes` writes too; otherwise it asks.
 */
export async function addWorkflow(state, o = {}) {
  const root = state.git.root;
  const sub = relative(root, state.cwd).split(sep).join("/");
  const text = workflowFor(sub);
  if (text === null) {
    warn(`This app's folder (${sub}) has a name the workflow cannot use as it is. Copy docs/github-app/workflows/genclass.yml from the GenClass repository and set its working directory by hand.`);
    return "skipped";
  }
  const file = join(root, WORKFLOW_PATH);
  if (!o.yes && !o.confirmed) {
    if (!interactive()) {
      note(`Not a terminal: run ${c.cyan("npx genclass setup --yes")} to write ${WORKFLOW_PATH}.`);
      return "skipped";
    }
    if (!(await agree(`Write ${WORKFLOW_PATH}?`))) return "skipped";
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
  } catch (e) {
    bad(`Could not write ${WORKFLOW_PATH}: ${e?.code === "EEXIST" ? "a file with that name is already there" : (e?.message ?? e)}`);
    return e?.code === "EEXIST" ? "skipped" : "failed";
  }
  good(`Wrote ${c.bold(WORKFLOW_PATH)} ${c.gray(`(new file, ${text.split("\n").length - 1} lines)`)}`);
  note("It is not committed. When you are ready:");
  out(`    ${c.cyan(`git add ${WORKFLOW_PATH} && git commit -m "Add GenClass to pull requests" && git push`)}`);
  return "done";
}

/**
 * Waits (up to `seconds`) for genclass.dev to have an answer from GitHub about `repo` that passes `until`.
 * The last answer, or null when none passed in time.
 */
async function waitForGithub(creds, repo, text, until, seconds) {
  const stop = stopOnEnter();
  const sp = spinner(`${text}${canStop()}`);
  const end = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < end && !stop.signal.aborted) {
    await nap(3000, stop.signal);
    if (stop.signal.aborted) break;
    const r = await fetchRepoStatus(creds, repo);
    if (r.ok) last = r;
    if (r.ok && until(r)) break;
  }
  await stop.done();
  sp.stop();
  return last && until(last) ? last : null;
}

/**
 * The GitHub App on this repository, with as little asked as possible: genclass.dev is asked what GitHub says; when
 * it has no answer the browser is opened to get one (Continue with GitHub), and when the answer is that the app is
 * not on the repository the browser is opened on GitHub's install page. This process only waits for the answer.
 */
export async function connectGithubApp(state, o = {}) {
  const creds = readCredentials();
  const repo = state.git.github;
  if (!creds || !repo) return "skipped";
  // a genclass.dev with no GitHub App (a collector someone hosts themselves): nothing to connect, and no waiting
  if (state.account?.github && state.account.github.app === false) {
    note("This genclass.dev has no GitHub App, so there is nothing to connect here.");
    return "skipped";
  }
  let st = await fetchRepoStatus(creds, repo);
  if (!st.ok && st.missing) {
    note(`This genclass.dev cannot tell the command about the GitHub App. Check it in the browser: ${c.cyan(hostUrl("/account/github"))}`);
    return "skipped";
  }
  const on = (r) => r.known && r.installed === true;
  if (st.ok && on(st)) {
    good(`The GenClass GitHub App is on ${c.bold(repo)}.`);
    return "done";
  }
  const installUrl = (st.ok && st.installUrl) || hostUrl("/github/install");
  const connectUrl = (st.ok && st.connectUrl) || hostUrl("/github/connect");
  if (o.yes || !interactive()) {
    out(`  Install the GenClass GitHub App on ${c.bold(repo)}:  ${c.cyan(installUrl)}`);
    out(`  Then, on the page GitHub sends you to, press ${c.bold("Continue with GitHub")}. Already installed: ${c.cyan(connectUrl)}`);
    return "skipped";
  }
  // 1. no answer from GitHub yet: get one. The page asks GitHub which repositories the app is on and comes back.
  if (!st.ok || !st.known) {
    out(`  ${c.gray(sym.arrow)} Asking GitHub which repositories the app is on: ${c.cyan(connectUrl)}`);
    openBrowser(connectUrl, o);
    st = (await waitForGithub(creds, repo, "Waiting for GitHub's answer (approve in the browser if it asks)", (r) => r.known, 90)) ?? st;
    if (st.ok && on(st)) {
      good(`The GenClass GitHub App is on ${c.bold(repo)}.`);
      return "done";
    }
    if (!st.ok || !st.known) {
      warn(`No answer yet. Make sure the browser is signed in to the same GenClass account as this command, then run npx genclass again.`);
      return "skipped";
    }
  }
  // 2. GitHub's answer does not list the repository: install the app on it
  out(`  ${c.gray(sym.arrow)} The app is not on ${c.bold(repo)} yet. Opening GitHub to install it: ${c.cyan(installUrl)}`);
  note("Pick this repository on GitHub's page. On the page that follows, press Continue with GitHub.");
  openBrowser(installUrl, o);
  const done = await waitForGithub(creds, repo, `Waiting for the app to be installed on ${repo}`, on, 240);
  if (done) {
    good(`The GenClass GitHub App is on ${c.bold(repo)}.`);
    return "done";
  }
  warn("Not installed yet. Finish on GitHub and run genclass again: this step picks up where it stopped.");
  return "skipped";
}

// ------------------------------------------------------------------------------------------------ 5. coding agent

/** The MCP server entry most clients take (packages/mcp/src/clients.ts serverConfig), at the version this CLI was built with. */
export const mcpServer = () => ({ command: "npx", args: ["-y", `@genclass/mcp@${BUILD.mcpVersion}`] });

/**
 * The change that adds GenClass's MCP server to a project's agent configuration: `.cursor/mcp.json` when the project
 * has a `.cursor` folder and no `.mcp.json`, else `.mcp.json` (Claude Code and other clients read it). Null with
 * `reason` when the file is there and is not a JSON object (it is left alone).
 */
export function planAgentConfig(dir) {
  const file = existsSync(join(dir, ".cursor")) && !existsSync(join(dir, ".mcp.json")) ? ".cursor/mcp.json" : ".mcp.json";
  const path = join(dir, file);
  let before = null;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    /* a new file */
  }
  let json = {};
  if (before !== null && before.trim()) {
    try {
      json = JSON.parse(before);
    } catch {
      return { file, change: null, reason: `${file} is not valid JSON` };
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return { file, change: null, reason: `${file} is not a JSON object` };
  }
  const servers = json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers) ? json.mcpServers : {};
  const after = `${JSON.stringify({ ...json, mcpServers: { ...servers, genclass: mcpServer() } }, null, 2)}\n`;
  return { file, path, change: { file, kind: before === null ? "create" : "modify", before: before ?? "", after }, reason: null };
}

/** Where the skill goes in a project: Claude Code reads a project's skills from here, as `npx @genclass/mcp init` writes it. */
export const SKILL_PATH = ".claude/skills/genclass/SKILL.md";
export const SKILL_MARK = "genclass:init";

/**
 * The skill file as this command writes it: the MCP package's own skill with a marker line after its front matter
 * (the same marker `npx @genclass/mcp init` uses, so either command replaces the other's file and neither replaces
 * one the person has made their own by removing the line).
 */
export function skillText(source = SKILL_FILE) {
  const mark = `<!-- ${SKILL_MARK}: written by \`npx genclass\`; a rerun replaces this file while this line is here, so remove the line to keep your edits -->`;
  const end = source.startsWith("---\n") ? source.indexOf("\n---\n", 4) : -1;
  return end < 0 ? `${mark}\n\n${source}` : `${source.slice(0, end + 5)}${mark}\n${source.slice(end + 5)}`;
}

/** Writes the skill unless a file is there that does not carry the marker. Returns "written", "kept" or "failed". */
export function writeSkill(dir) {
  const file = join(dir, SKILL_PATH);
  try {
    if (existsSync(file) && !readFileSync(file, "utf8").includes(SKILL_MARK)) return "kept";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, skillText());
    return "written";
  } catch {
    return "failed";
  }
}

/** Adds the MCP server to the project's agent configuration after showing the change, and the skill next to it. */
export async function connectAgent(state, o = {}) {
  const plan = planAgentConfig(state.cwd);
  if (!plan.change) {
    warn(`${plan.reason}, so it was left alone. Add this to its "mcpServers" by hand:`);
    out(`    ${c.cyan(`"genclass": ${JSON.stringify(mcpServer())}`)}`);
    return "skipped";
  }
  if (!o.yes && !o.confirmed) {
    out();
    printChange(plan.change);
    if (!interactive()) {
      note(`Not a terminal: run ${c.cyan("npx genclass setup --yes")} to write it.`);
      return "skipped";
    }
    if (!(await agree("Write this change?"))) return "skipped";
  }
  try {
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.change.after);
  } catch (e) {
    bad(`Could not write ${plan.file}: ${e?.message ?? e}`);
    return "failed";
  }
  good(`${plan.change.kind === "create" ? "Wrote" : "Updated"} ${c.bold(plan.file)} ${c.gray("(GenClass's MCP server)")}`);
  // the skill is the procedure the agent follows with those tools; a file the person made their own is left alone
  const skill = writeSkill(state.cwd);
  if (skill === "written") good(`Wrote ${c.bold(SKILL_PATH)} ${c.gray("(how the agent uses them)")}`);
  note('Restart your coding agent in this folder, then ask it "is GenClass connected?". The first time, it shows two dev-only lines that connect your running app and adds them when you say yes.');
  return "done";
}
