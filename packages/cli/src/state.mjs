// Where a project stands with GenClass: the six steps of the one way to set it up, each read from what is on disk
// and what genclass.dev answers, in order. `genclass` shows this list, `genclass setup` walks it, and
// `genclass status --json` prints it for a coding agent.
//
// Invariants:
// - Reading the state changes nothing: no file is written, nothing is installed, and the only requests are GETs to
//   genclass.dev with the saved CLI session (the account's overview, and what the GitHub App is doing on this
//   repository). Without a session, or offline, the steps that need the server say so and the rest are still read.
// - A step is "done" only on evidence: a file that is there, a session genclass.dev accepts, an event it received.
//   What cannot be checked from here is never shown as done.
// - The order is fixed and there is one next step: the first that is neither done, waiting on something outside this
//   machine, nor not applicable to this project.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCredentialsFor } from "../../runtime/bin/lib/account.mjs";
import { hostConfig } from "../../runtime/bin/lib/host.mjs";
import { accountLabel, inspectProject } from "../../runtime/bin/lib/init.mjs";
import { fetchOverview, fetchRepoStatus } from "./api.mjs";
import { gitInfo } from "./git.mjs";
import { readNotes } from "./store.mjs";
import { ago } from "./tui.mjs";

/** Where the one workflow file goes (docs/github-app/workflows/genclass.yml). */
export const WORKFLOW_PATH = ".github/workflows/genclass.yml";

/** @typedef {"done" | "next" | "waiting" | "todo" | "optional" | "blocked"} StepState */
/**
 * @typedef {Object} Step
 * @property {"account" | "runtime" | "first-page" | "pull-requests" | "agent" | "suggestions"} id
 * @property {string} title
 * @property {StepState} state
 * @property {string} detail   what is known, in a few words
 * @property {string} why      what the step is for, in plain words (shown when it is next)
 * @property {string | null} run    the command that does it, or null when a person has to do something else
 * @property {string | null} human  what a person has to do that no command can (approve in a browser, deploy)
 */

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The workflow files of the repository that run GenClass on the tests (the one-file path, or the fixture). */
export function genclassWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n));
  } catch {
    return [];
  }
  return names.filter((n) => /genclass-playwright-run|@genclass\/playwright|genclass-races/.test(read(join(dir, n)) ?? "")).map((n) => `.github/workflows/${n}`);
}

/** Whether the project has Playwright tests to run: the package, or a config file. */
export function hasPlaywright(cwd, project) {
  if (project?.has?.("@playwright/test") || project?.has?.("playwright")) return true;
  return ["ts", "js", "mjs", "cjs", "mts"].some((e) => existsSync(join(cwd, `playwright.config.${e}`)));
}

/** The MCP configuration files that name GenClass's server, relative to `dir`. */
export function agentConfigs(dir) {
  return [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".codex/config.toml", ".gemini/settings.json"].filter((f) => /@genclass\/mcp|genclass-mcp/.test(read(join(dir, f)) ?? ""));
}

/**
 * @param {{ cwd?: string, offline?: boolean }} [o]
 * @param {{ fetchFn?: typeof fetch, runGit?: (args: string[], cwd: string) => string | null, now?: number }} [deps]
 */
export async function readState(o = {}, deps = {}) {
  const st = inspectProject({ cwd: o.cwd });
  const { cwd, project } = st;
  const host = hostConfig();
  const { creds, otherHost } = readCredentialsFor();
  const git = gitInfo(cwd, deps.runGit);
  const now = deps.now ?? Date.now();

  // ---- the server's side (two GETs at most)
  let me = null;
  let offline = null;
  if (creds && !o.offline) {
    const r = await fetchOverview(creds, deps);
    if (r.ok) me = r;
    else offline = r.status === 401 ? "expired" : r.reason;
  }
  const app = me && st.token ? (me.projects.find((p) => p.token === st.token) ?? null) : null;
  const playwright = hasPlaywright(cwd, project);
  const workflows = git.root ? genclassWorkflows(git.root) : [];
  let repo = null;
  if (me && git.github) repo = await fetchRepoStatus(creds, git.github, deps);

  /** @type {Step[]} */
  const steps = [];
  const isApp = !project.refused && !!project.framework;

  // 1. the account
  steps.push({
    id: "account",
    title: "Signed in",
    state: me ? "done" : creds && offline && offline !== "expired" ? "done" : "todo",
    detail: me
      ? `${accountLabel(me.account)}${me.plan ? ` · ${me.plan.name} plan` : ""}`
      : creds && offline === "expired"
        ? "the saved session expired: sign in again"
        : creds && offline
          ? `${accountLabel(creds.account)} (not checked: ${offline})`
          : otherHost
            ? `the saved session is for ${otherHost}`
            : "",
    why: "Your account is where your apps, their dashboards and your plan live. Signing in opens genclass.dev in your browser; you approve a short code there, and nothing is typed here.",
    run: "genclass login",
    human: "approve the sign-in in your browser",
  });

  // 2. the runtime in this app
  const linked = !!st.token && (!me || !!app);
  steps.push({
    id: "runtime",
    title: "GenClass is in this app",
    state: !isApp ? "blocked" : st.fresh ? "todo" : linked ? "done" : "todo",
    detail: !isApp
      ? (project.refused ?? "no web app in this folder (no package.json with a browser app, no HTML page)")
      : st.fresh
        ? project.label
        : !st.token
          ? "added, with no dashboard yet"
          : me && !app
            ? "added, but this app is not in your account yet"
            : `${st.handWritten ? "added by hand" : "added"}${app ? ` · app "${app.name}"` : ""}`,
    why: st.fresh
      ? "This adds the GenClass runtime to your app: one import (or one script tag) and the package. It watches the page in your users' browsers for lost edits, double submits and old data shown over new, and only reports. You see the exact change before anything is written."
      : "The runtime is in the code. This gives the app its place in your account, so what it finds shows up on your dashboard.",
    run: st.fresh ? "genclass init" : "genclass connect",
    human: null,
  });

  // 3. the first page seen
  steps.push({
    id: "first-page",
    title: "First page seen",
    state: !isApp ? "optional" : app?.last_event ? "done" : app ? "waiting" : "todo",
    detail: !isApp ? "" : app?.last_event ? `last page ${ago(app.last_event, now)}` : app ? "deploy, then open your site once" : "",
    why: "GenClass sends nothing from localhost, so the dashboard fills once your deployed site has been opened. Deploy as you normally do, open the site, and run genclass again.",
    run: null,
    human: "deploy your app and open the live site once",
  });

  // 4. pull requests
  const pr = { state: /** @type {StepState} */ ("todo"), detail: "", run: /** @type {string | null} */ ("genclass setup"), human: /** @type {string | null} */ (null) };
  if (!isApp) Object.assign(pr, { state: "optional", detail: "" });
  else if (!git.repo) Object.assign(pr, { state: "optional", detail: "not a git repository yet" });
  else if (!git.github) Object.assign(pr, { state: "optional", detail: "the repository is not on GitHub" });
  else if (!playwright && !workflows.length) Object.assign(pr, { state: "optional", detail: "no Playwright tests yet" });
  else if (!workflows.length) Object.assign(pr, { state: "todo", detail: "Playwright found · no workflow file yet" });
  else if (!me) Object.assign(pr, { state: "todo", detail: "workflow file in place · sign in to check the app" });
  else if (!repo || !repo.ok) {
    Object.assign(pr, repo?.missing ? { state: "waiting", detail: "workflow file in place · app: genclass.dev/account/github", run: null } : { state: "todo", detail: `workflow file in place · could not check the app${repo ? ` (${repo.reason})` : ""}` });
  } else if (!repo.known) Object.assign(pr, { state: "todo", detail: "workflow file in place · continue with GitHub", human: "install the GitHub App and continue with GitHub in your browser" });
  else if (!repo.installed) Object.assign(pr, { state: "todo", detail: `the GitHub App is not on ${git.github} yet`, human: "install the GitHub App on this repository" });
  else if (repo.needsPlan) Object.assign(pr, { state: "waiting", detail: "private repository: reviews come with the Team plan", run: null });
  else if (repo.paused) Object.assign(pr, { state: "waiting", detail: "paused on your GitHub page at genclass.dev", run: null });
  else if (repo.evidence) Object.assign(pr, { state: "done", detail: repo.prs ? `reviewing · ${repo.prs} pull request${repo.prs === 1 ? "" : "s"} so far` : "reviewing" });
  else Object.assign(pr, { state: "waiting", detail: "ready · open a pull request and the first review appears", run: null, human: "commit the workflow file and open a pull request" });
  steps.push({
    id: "pull-requests",
    title: "Pull requests checked",
    ...pr,
    why: "On each pull request GenClass runs your Playwright tests once more with slow and reordered responses, and comments when a page ends up wrong, with the steps to see it. It needs one workflow file in the repository and the GenClass GitHub App on it. The app cannot read or change your code.",
  });

  // 5. the coding agent
  const agents = [...new Set([...agentConfigs(cwd), ...(git.root && git.root !== cwd ? agentConfigs(git.root) : [])])];
  steps.push({
    id: "agent",
    title: "Coding agent connected",
    state: !isApp ? "optional" : agents.length ? "done" : "todo",
    detail: agents.length ? agents.join(", ") : "",
    why: "This lets Claude Code, Cursor and other coding agents ask GenClass what went wrong, replay it and check their fix. It adds GenClass's MCP server to the project's agent configuration; the server runs on your machine.",
    run: "genclass setup",
    human: null,
  });

  // 6. suggestions
  const notes = readNotes(cwd);
  const s = notes.suggest;
  steps.push({
    id: "suggestions",
    title: "Suggestions",
    // run once, it is done only when nothing is left on the list; until then it waits on the person, not on a command
    state: !s ? "todo" : s.failed ? "waiting" : "done",
    detail: !s ? "" : s.failed ? `${s.failed} to do${s.urgent ? `, ${s.urgent} urgent` : ""} · checked ${ago(s.at, now)}` : `nothing to do · checked ${ago(s.at, now)}`,
    why: "GenClass checks your repository and your live site for what a launched app needs (search engines and AI assistants can read it, payments are live, secrets are safe, people can see the price) and tells you what to do first, in plain words.",
    run: "genclass suggest",
    human: s?.failed ? "work through the list: genclass suggest" : null,
  });

  const next = steps.find((x) => x.state === "todo" && !(o.skip ?? []).includes(x.id)) ?? null;
  if (next) next.state = "next";
  return {
    cwd,
    host: host.overridden && !host.error ? host.host : null,
    app: { name: app?.name ?? project.name ?? null, framework: project.label || null, isApp, token: st.token ?? null, dashboardUrl: app?.dashboard_url ?? st.local?.dashboardUrl ?? null, site: notes.site ?? null },
    account: me ? { label: accountLabel(me.account), plan: me.plan, suggestions: me.suggestions, billingUrl: me.billingUrl, github: me.github } : null,
    signedIn: !!me,
    sessionProblem: creds && !me ? offline : null,
    git: { repo: git.repo, github: git.github, root: git.root, branch: git.branch },
    playwright,
    workflows,
    repo: repo?.ok ? repo : null,
    steps,
    next,
    complete: steps.every((x) => x.state === "done" || x.state === "optional"),
  };
}

/** The state as plain data for `--json`: what a coding agent reads to know where things stand and what to run. */
export function stateJson(s) {
  return {
    app: s.app,
    signed_in: s.signedIn,
    account: s.account ? { label: s.account.label, plan: s.account.plan } : null,
    github: s.git.github,
    steps: s.steps.map((x) => ({ id: x.id, title: x.title, state: x.state, detail: x.detail, run: x.state === "done" ? null : x.run, human: x.state === "done" ? null : x.human })),
    next: s.next ? { id: s.next.id, title: s.next.title, run: s.next.run, human: s.next.human, why: s.next.why } : null,
    complete: s.complete,
  };
}
