// Where a project stands with GenClass: every part of it as one step, each read from what is on disk and what
// genclass.dev answers, in order. `genclass` shows a short view of this list (what is done, what is next, what comes
// later), expands it on request, and walks it; `genclass status --json` prints all of it for a coding agent.
//
// Invariants:
// - Reading the state changes nothing: no file is written, nothing is installed, and the only requests are GETs to
//   genclass.dev with the saved CLI session (the account's overview, and what the GitHub App is doing on this
//   repository). Without a session, or offline, the steps that need the server say so and the rest are still read.
// - A step is "done" only on evidence: a file that is there, a session genclass.dev accepts, an event it received.
//   What cannot be checked from here is never shown as done.
// - The order is fixed and there is one next step: the first that is neither done, waiting on something outside this
//   machine, nor not applicable to this project.
// - Every part of GenClass is a step (account, runtime, dashboard, test workflow, GitHub App, coding agent,
//   suggestions), so nothing is set up somewhere this list does not show. A step that does not apply to a project
//   says why and never blocks the ones after it.

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
 * @property {"account" | "runtime" | "dashboard" | "workflow" | "github-app" | "agent" | "suggestions"} id
 * @property {string} title    the part's name, one or two words
 * @property {string} doing    what doing the step is called ("Add GenClass to this app")
 * @property {StepState} state
 * @property {string} detail   what is known, in a few words
 * @property {string} why      what the step does, in one short sentence (shown when it is next)
 * @property {string} more     the fuller explanation (shown when the list is expanded)
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
 * @param {{ cwd?: string, offline?: boolean, skip?: string[] }} [o]
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
    title: "Account",
    doing: "Sign in",
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
    why: "Opens genclass.dev in your browser. You approve a short code there.",
    more: "Your account is where your apps, their dashboards and your plan live. Nothing is typed in the terminal.",
    run: "genclass login",
    human: "approve the sign-in in your browser",
  });

  // 2. the runtime in this app
  const linked = !!st.token && (!me || !!app);
  steps.push({
    id: "runtime",
    title: "Runtime",
    doing: st.fresh ? "Add GenClass to this app" : "Put this app in your account",
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
    why: st.fresh ? "One import and the package. You see the change before it is written." : "Gives the app its place in your account, so what it finds shows on your dashboard.",
    more: "The runtime watches the page in your users' browsers for lost edits, double submits and old data shown over new. It only reports: it never holds, delays or changes anything your app does.",
    run: st.fresh ? "genclass init" : "genclass connect",
    human: null,
  });

  // 3. the dashboard: the first page seen
  steps.push({
    id: "dashboard",
    title: "Dashboard",
    doing: "See your first page",
    state: !isApp ? "optional" : app?.last_event ? "done" : app ? "waiting" : "todo",
    detail: !isApp ? "" : app?.last_event ? `last page ${ago(app.last_event, now)}` : app ? "deploy, then open your site once" : "",
    why: "It fills once your live site has been opened.",
    more: "GenClass sends nothing from localhost, so the dashboard starts with your deployed site. Deploy as you normally do, open the site, and run genclass again.",
    run: null,
    human: "deploy your app and open the live site once",
  });

  // 4. the test workflow
  const wf = { state: /** @type {StepState} */ ("todo"), detail: "" };
  if (!isApp) wf.state = "optional";
  else if (!git.repo) Object.assign(wf, { state: "optional", detail: "not a git repository yet" });
  else if (!git.github) Object.assign(wf, { state: "optional", detail: "the repository is not on GitHub" });
  else if (workflows.length) Object.assign(wf, { state: "done", detail: workflows[0] });
  else if (!playwright) Object.assign(wf, { state: "optional", detail: "no Playwright tests yet" });
  else Object.assign(wf, { state: "todo", detail: "Playwright found · no workflow file yet" });
  steps.push({
    id: "workflow",
    title: "Test workflow",
    doing: "Add the test workflow",
    ...wf,
    why: `One new file, ${WORKFLOW_PATH}. Your tests are not changed.`,
    more: "On each pull request it runs your Playwright tests once more with slow and reordered responses, in a job of its own that is allowed to fail, and uploads small race files. It needs no secret.",
    run: "genclass setup",
    human: null,
  });

  // 5. the GitHub App
  const gh = { state: /** @type {StepState} */ ("todo"), detail: "", run: /** @type {string | null} */ ("genclass setup"), human: /** @type {string | null} */ (null) };
  if (!isApp || !git.github) Object.assign(gh, { state: "optional", detail: !isApp ? "" : git.repo ? "the repository is not on GitHub" : "not a git repository yet" });
  else if (!workflows.length && !playwright) Object.assign(gh, { state: "optional", detail: "needs Playwright tests first" });
  else if (!workflows.length) Object.assign(gh, { detail: "after the test workflow" });
  else if (!me) Object.assign(gh, { detail: "sign in to check" });
  else if (!repo || !repo.ok) Object.assign(gh, repo?.missing ? { state: "waiting", detail: "check it at genclass.dev/account/github", run: null } : { detail: `could not check${repo ? ` (${repo.reason})` : ""}` });
  else if (!repo.known) Object.assign(gh, { detail: "continue with GitHub to check", human: "install the GitHub App and continue with GitHub in your browser" });
  else if (!repo.installed) Object.assign(gh, { detail: `not on ${git.github} yet`, human: "install the GitHub App on this repository" });
  else if (repo.needsPlan) Object.assign(gh, { state: "waiting", detail: "private repository: reviews come with the Team plan", run: null });
  else if (repo.paused) Object.assign(gh, { state: "waiting", detail: "paused on your GitHub page at genclass.dev", run: null });
  else if (repo.evidence) Object.assign(gh, { state: "done", detail: repo.prs ? `reviewing · ${repo.prs} pull request${repo.prs === 1 ? "" : "s"} so far` : "reviewing" });
  else Object.assign(gh, { state: "waiting", detail: "installed · open a pull request and the first review appears", run: null, human: "commit the workflow file and open a pull request" });
  steps.push({
    id: "github-app",
    title: "GitHub App",
    doing: "Connect the GitHub App",
    ...gh,
    why: "It comments on a pull request when a page ends up wrong. It cannot read or change your code.",
    more: "The app reads the race files the test workflow uploads and posts one check and one comment, with the steps to see the problem. You install it on GitHub in your browser; this command only waits for GitHub's answer.",
  });

  // 6. the coding agent
  const agents = [...new Set([...agentConfigs(cwd), ...(git.root && git.root !== cwd ? agentConfigs(git.root) : [])])];
  steps.push({
    id: "agent",
    title: "Coding agent",
    doing: "Connect your coding agent",
    state: !isApp ? "optional" : agents.length ? "done" : "todo",
    detail: agents.length ? agents.join(", ") : "",
    why: "Adds GenClass's tools to Claude Code, Cursor and other agents in this project.",
    more: "It adds GenClass's MCP server to the project's agent configuration (.mcp.json). The server runs on your machine and lets an agent ask what went wrong on a page, replay it and check its fix.",
    run: "genclass setup",
    human: null,
  });

  // 7. suggestions
  const notes = readNotes(cwd);
  const s = notes.suggest;
  steps.push({
    id: "suggestions",
    title: "Suggestions",
    doing: "See what your app is missing",
    // run once, it is done only when nothing is left on the list; until then it waits on the person, not on a command
    state: !s ? "todo" : s.failed ? "waiting" : "done",
    detail: !s ? "" : s.failed ? `${s.failed} to do${s.urgent ? `, ${s.urgent} urgent` : ""} · checked ${ago(s.at, now)}` : `nothing to do · checked ${ago(s.at, now)}`,
    why: "Checks your repository and your live site, and tells you what to do first.",
    more: "It measures what a launched app needs (search engines and AI assistants can read it, payments are live, secrets are safe, people can see the price) and explains each thing in plain words, with a prompt for your coding agent.",
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
    /** the account's apps as genclass.dev lists them ([] signed out) */
    projects: me?.projects ?? [],
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
    next: s.next ? { id: s.next.id, title: s.next.doing, run: s.next.run, human: s.next.human, why: s.next.why } : null,
    complete: s.complete,
  };
}
