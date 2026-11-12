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
import { apiHost, hostConfig, hostUrl } from "../../runtime/bin/lib/host.mjs";
import { accountLabel, run as runInit } from "../../runtime/bin/lib/init.mjs";
import { run as runLogin } from "../../runtime/bin/lib/login.mjs";
import { c, interactive, out, printChange, sym } from "../../runtime/bin/lib/ui.mjs";
import { fetchOverview, fetchRepoStatus } from "./api.mjs";
import { BUILD, WORKFLOW_FILE } from "./assets.mjs";
import { WORKFLOW_PATH } from "./state.mjs";
import { agree, bad, good, note, spinner, warn } from "./tui.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  out(`  Code  ${c.bold(dev.user_code)}  ${c.gray("(check that the page shows the same code, then approve)")}`);
  out();
  if (openBrowser(dev.verification_uri_complete, o)) note("Your browser is opening that page.");
  const sp = spinner("Waiting for you to approve in the browser");
  const r = await pollDeviceLogin(dev);
  if (!r.ok) {
    sp.stop("bad", r.error === "access_denied" ? "The sign-in was denied in the browser." : r.error === "expired_token" ? "The code expired before it was approved. Run genclass again for a new one." : `The sign-in did not finish: ${r.reason}`);
    return "failed";
  }
  saveCredentials({ host: apiHost(), access_token: r.access_token, account: r.account });
  sp.stop("ok", `Signed in as ${c.bold(accountLabel(r.account))}`);
  return "done";
}

// ------------------------------------------------------------------------------------------------ 2. the runtime

/**
 * The arguments the runtime step hands to the runtime CLI's `init` (a fresh project) or `connect` (added, not in
 * the account yet). `init` gets --no-devtools: GenClass set up by this command draws nothing on a page, not on the
 * deployed site (it never did) and not on localhost either (the developer overlay is left out). What it finds goes
 * to the browser console, the dashboard and `genclass dashboard`.
 */
export function runtimeArgs(state, o = {}) {
  const connect = state.steps.find((s) => s.id === "runtime")?.run === "genclass connect";
  // signed in one step earlier, so the app goes into that account without asking again
  const args = ["--cwd", state.cwd, ...(o.yes ? ["--yes"] : []), ...(state.signedIn ? ["--in-account"] : [])];
  return { cmd: connect ? "connect" : "init", args: connect ? args : [...args, "--no-devtools"] };
}

/** Adds the runtime with the runtime CLI's own init (fresh project) or connect (added, not in the account). */
export async function addRuntime(state, o = {}) {
  const { cmd, args } = runtimeArgs(state, o);
  const code = cmd === "connect" ? await runLogin("connect", args) : await runInit("init", args);
  return code === 0 ? "done" : "failed";
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
  const sp = spinner("Open your live site in a browser now. Watching for its first page");
  const until = Date.now() + (o.seconds ?? 120) * 1000;
  while (Date.now() < until) {
    await sleep(5000);
    const me = await fetchOverview(creds);
    if (me.ok && me.projects.find((p) => p.token === state.app.token)?.last_event) {
      sp.stop("ok", "GenClass received the first page from your site. Your dashboard is filling.");
      return "done";
    }
  }
  sp.stop("warn", "Nothing arrived yet. GenClass sends nothing from localhost or a private address; run genclass again after the live site was opened.");
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
      note(`Not a terminal: run ${c.cyan("genclass setup --yes")} to write ${WORKFLOW_PATH}.`);
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
  const sp = spinner(text);
  const end = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < end) {
    await sleep(3000);
    const r = await fetchRepoStatus(creds, repo);
    if (r.ok) last = r;
    if (r.ok && until(r)) {
      sp.stop();
      return r;
    }
  }
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
      warn(`No answer yet. Make sure the browser is signed in to the same GenClass account as this command, then run genclass again.`);
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

/** Adds the MCP server to the project's agent configuration after showing the change. */
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
      note(`Not a terminal: run ${c.cyan("genclass setup --yes")} to write it.`);
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
  note("Restart your coding agent in this folder and it has GenClass's tools.");
  return "done";
}
