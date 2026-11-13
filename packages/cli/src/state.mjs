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
import { join, resolve } from "node:path";
import { readCredentialsFor } from "../../runtime/bin/lib/account.mjs";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { hostConfig } from "../../runtime/bin/lib/host.mjs";
import { accountLabel, inspectProject } from "../../runtime/bin/lib/init.mjs";
import { fetchOverview, fetchRepoStatus } from "./api.mjs";
import { gitInfo, renamedRepo } from "./git.mjs";
import { readNotes } from "./store.mjs";
import { ago } from "./tui.mjs";
import { planViteSettings } from "./vite.mjs";

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

/** Free's limits as a few words ("3 apps, 7 days of history, your top 3 suggestions"), from the numbers the server sent. */
export function freeLimits(free) {
  const parts = [];
  if (free?.apps) parts.push(`${free.apps} app${free.apps === 1 ? "" : "s"}`);
  if (free?.historyDays) parts.push(`${free.historyDays} days of history`);
  if (free?.suggestionsShown) parts.push(`your top ${free.suggestionsShown} suggestion${free.suggestionsShown === 1 ? "" : "s"}`);
  if (free?.liveFixes) parts.push(`${free.liveFixes} live fixes a month`);
  return parts.join(", ");
}

const NOT_APPS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "tmp", "target"]);

/**
 * The web apps below `dir`, for a folder that is not one itself (a monorepo's root, the folder above the app):
 * `{ apps: [{ dir, label }], more }`, `dir` relative with forward slashes, in name order. Bounded: three folders
 * deep, at most `max` apps named (the rest counted in `more`) out of at most 400 folders read; hidden folders, build
 * output and the inside of an app are not looked at. Only reads package.json files and what the detector reads.
 */
export function appsBelow(dir, max = 8) {
  const apps = [];
  let more = 0;
  let seen = 0;
  const walk = (abs, rel, depth) => {
    let names = [];
    try {
      names = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !NOT_APPS.has(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen > 400) return;
      const at = join(abs, name);
      const here = rel ? `${rel}/${name}` : name;
      let p = null;
      try {
        p = existsSync(join(at, "package.json")) ? detectProject(at) : null;
      } catch {
        p = null;
      }
      if (p && !p.refused && p.framework) {
        if (apps.length < max) apps.push({ dir: here, label: p.label || String(p.framework) });
        else more++;
      } else if (depth < 3) walk(at, here, depth + 1);
    }
  };
  walk(resolve(dir), "", 1);
  return { apps, more };
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
  if (me && git.github) {
    repo = await fetchRepoStatus(creds, git.github, deps);
    // genclass.dev knows a repository by the name GitHub has for it now. A checkout cloned before a rename still
    // carries the old one, under which the app looks "not installed": ask GitHub for the current name and ask again.
    // (With a server given by a test there is no GitHub to ask, unless the test says what it would answer.)
    if (repo.ok && repo.known && repo.installed === false) {
      const lookup = deps.renamedRepo ?? (deps.fetchFn ? null : renamedRepo);
      const current = lookup ? await lookup(git.github) : null;
      if (current) {
        const again = await fetchRepoStatus(creds, current, deps);
        if (again.ok) {
          repo = again;
          git.renamedFrom = git.github;
          git.github = current;
        }
      }
    }
  }

  /** @type {Step[]} */
  const steps = [];
  // what this command remembers about the project between runs (store.mjs): its site, the last suggestions, the plan chosen
  const notes = readNotes(cwd);
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
    why: "Opens genclass.dev in your browser. New here? Your free account is made there.",
    more: "Your account is where your apps, their dashboards and your plan live. Nothing is typed in the terminal.",
    run: "npx genclass login",
    human: "approve the sign-in in your browser",
  });

  // 2. the runtime in this app
  const linked = !!st.token && (!me || !!app);
  // added and in the account, but on Vite 7 or earlier without the build setting the model's worker needs (vite.mjs)
  let vite = null;
  try {
    vite = isApp && !st.fresh && linked ? planViteSettings(cwd, project) : null;
  } catch {
    vite = null;
  }
  steps.push({
    id: "runtime",
    title: "Runtime",
    doing: st.fresh ? "Add GenClass to this app" : vite ? "Add two Vite settings" : "Put this app in your account",
    state: !isApp ? "blocked" : st.fresh ? "todo" : vite ? "todo" : linked ? "done" : "todo",
    ...(vite ? { vite: true } : {}),
    detail: !isApp
      ? (project.refused ?? "no web app in this folder")
      : st.fresh
        ? project.label
        : !st.token
          ? "added, with no dashboard yet"
          : me && !app
            ? "added, but this app is not in your account yet"
            : vite
              ? `added · Vite ${vite.major} needs two build settings`
              : `${st.handWritten ? "added by hand" : "added"}${app ? ` · app "${app.name}"` : ""}`,
    why: st.fresh
      ? "One import and the package. You see the change first. Nothing is drawn on your pages."
      : vite
        ? `Without them "vite build" fails on Vite ${vite.major}. You see the change first.`
        : "Gives the app its place in your account, so what it finds shows on your dashboard.",
    more: "The runtime watches the page in your users' browsers for lost edits, double submits and old data shown over new. It only reports, to the browser console and your dashboard: it never holds, delays or changes anything your app does, and it puts nothing on the page.",
    run: st.fresh ? "npx genclass init" : vite ? "npx genclass setup" : "npx genclass connect",
    human: null,
  });

  // 2b. the plan of this app. Plans are per project (genclass.dev's billing/plans.json version 4): once the app is in
  // the account, the command opens the app's plan page in the browser, the paid plan large and "Try for free
  // (limited)" small under it, and waits for the choice there. An app past the ones Free covers has only the paid
  // plan. An app with a plan, an app of a team the account is in (its owner chooses), a server that sells nothing
  // and a signed-out person have nothing to choose, so the step does not show. A server from before plans per
  // project answers for the whole account: the plan is then chosen once, in the terminal, as it was.
  const own = app && !app.shared ? app : null;
  const pp = own?.plan ?? null;
  const needs = own?.needsPlan === true;
  const hasPlan = pp ? pp.id !== "free" || !!pp.source : !!me?.plan && me.plan.id !== "free";
  const offer =
    me?.offer && !hasPlan && !app?.shared && (!pp || own.planUrl)
      ? pp
        ? { ...me.offer, checkoutUrl: `${own.planUrl}&from=cli`, project: { id: own.id, name: own.name, token: own.token }, needs }
        : me.offer
      : null;
  const choseFree = pp ? own.planChosen === true && !needs : notes.plan === "free";
  const limits = offer ? freeLimits(offer.free) : "";
  steps.push({
    id: "plan",
    title: "Plan",
    doing: offer?.project ? "Choose this app's plan" : "Choose a plan",
    state: !offer ? "optional" : choseFree ? "done" : "todo",
    detail: !me
      ? ""
      : !offer
        ? pp
          ? `${pp.name}${pp.source === "comp" ? " (set up by GenClass)" : ""}`
          : app?.shared
            ? "the team's owner chooses it"
            : me.plan
              ? `${me.plan.name} plan`
              : ""
        : needs
          ? `Free covers ${offer.free.apps === 1 ? "one app" : `${offer.free.apps ?? 1} apps`}: this one needs ${offer.plan.name}`
          : choseFree
            ? `${offer.free.name} for now (limited) · ${offer.plan.name} is ${offer.price}`
            : `${offer.plan.name}, ${offer.price}`,
    why: !offer
      ? pp ? "This app's plan." : "The plan your account is on."
      : needs
        ? `Free covers ${offer.free.apps === 1 ? "one app" : `${offer.free.apps ?? 1} apps`} and this is one more. ${offer.plan.name} is ${offer.price}.`
        : `${offer.plan.name} is ${offer.price}. Or try ${offer.free.name} for now (limited).`,
    more: !offer
      ? "Plans and prices: genclass.dev/pricing."
      : offer.project
        ? `The app's plan page opens in your browser: ${offer.plan.name}, paid there on Stripe, or ${offer.free.name} for now${limits ? ` (${limits})` : ""}. Every app has its own plan: genclass.dev/account/billing.`
        : `${offer.plan.name} opens in your browser and is paid there, on Stripe. ${offer.free.name} keeps what finds, shows and fixes the problems${limits ? `: ${limits}` : ""}. You can change plan any time at genclass.dev/account/billing.`,
    run: "npx genclass setup",
    human: offer && !choseFree ? `choose ${offer.project ? "this app's plan" : "a plan"} in your browser: ${offer.checkoutUrl}` : null,
    ...(offer ? { offer } : {}),
    // the plan is the app's: the walk asks once the app is in the account
    after: "runtime",
  });

  // 3. the dashboard: the first page seen
  steps.push({
    id: "dashboard",
    title: "Dashboard",
    doing: "See your first page",
    state: !isApp ? "optional" : app?.last_event ? "done" : app ? "waiting" : "todo",
    detail: !isApp ? "" : app?.last_event ? `last page ${ago(app.last_event, now)}` : app ? "deploy, then open your site once" : "",
    why: "It fills once your live site has been opened.",
    more: "GenClass sends nothing from localhost, so the dashboard starts with your deployed site. Deploy as you normally do, open the site, and run npx genclass again.",
    run: null,
    human: "deploy your app and open the live site once",
    // nothing to watch for until the app is in the account: the walk does not offer it before
    after: "runtime",
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
    run: "npx genclass setup",
    human: null,
  });

  // 5. the GitHub App
  const gh = { state: /** @type {StepState} */ ("todo"), detail: "", run: /** @type {string | null} */ ("npx genclass setup"), human: /** @type {string | null} */ (null) };
  if (!isApp || !git.github) Object.assign(gh, { state: "optional", detail: !isApp ? "" : git.repo ? "the repository is not on GitHub" : "not a git repository yet" });
  // a genclass.dev with no GitHub App (a collector someone hosts themselves): nothing to connect
  else if (me?.github && me.github.app === false) Object.assign(gh, { state: "optional", detail: "this genclass.dev has no GitHub App" });
  else if (!me) Object.assign(gh, { detail: "sign in to check" });
  else if (!repo || !repo.ok) Object.assign(gh, repo?.missing ? { state: "waiting", detail: "check it at genclass.dev/account/github", run: null } : { detail: `could not check${repo ? ` (${repo.reason})` : ""}` });
  else if (!repo.known) Object.assign(gh, { detail: "continue with GitHub to check", human: "install the GitHub App and continue with GitHub in your browser" });
  else if (!repo.installed) Object.assign(gh, { detail: `not on ${git.github} yet`, human: "install the GitHub App on this repository" });
  else if (repo.needsPlan) Object.assign(gh, { state: "waiting", detail: "private repository: reviews come with Pro", run: null });
  else if (repo.paused) Object.assign(gh, { state: "waiting", detail: "paused on your GitHub page at genclass.dev", run: null });
  else if (repo.evidence) Object.assign(gh, { state: "done", detail: repo.prs ? `reviewing · ${repo.prs} pull request${repo.prs === 1 ? "" : "s"} so far` : "reviewing" });
  else Object.assign(gh, { state: "waiting", detail: "installed · open a pull request and the first review appears", run: null, human: workflows.length ? "commit the workflow file and open a pull request" : "open a pull request" });
  steps.push({
    id: "github-app",
    title: "GitHub App",
    doing: "Connect the GitHub App",
    ...gh,
    why: "It comments on a pull request when a page ends up wrong. It cannot read or change your code.",
    more: `The app reads the race files the test workflow uploads and posts one check and one comment, with the steps to see the problem. You install it on GitHub in your browser; this command only waits for GitHub's answer.${git.renamedFrom ? ` GitHub now calls this repository ${git.github} (this checkout's remote still says ${git.renamedFrom}); to update it: git remote set-url origin https://github.com/${git.github}.git` : ""}`,
  });

  // 6. the coding agent
  const agents = [...new Set([...agentConfigs(cwd), ...(git.root && git.root !== cwd ? agentConfigs(git.root) : [])])];
  steps.push({
    id: "agent",
    title: "Coding agent",
    doing: "Connect your coding agent",
    state: !isApp ? "optional" : agents.length ? "done" : "todo",
    detail: agents.length ? agents.join(", ") : "",
    why: "Adds GenClass's tools and its skill to Claude Code, Cursor and other agents in this project.",
    more: "It adds GenClass's MCP server to the project's agent configuration (.mcp.json) and the skill that tells the agent how to use it (.claude/skills/genclass/SKILL.md). The server runs on your machine and lets an agent ask what went wrong on a page, replay it and check its fix.",
    run: "npx genclass setup",
    human: null,
  });

  // 7. suggestions
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
    run: "npx genclass suggest",
    human: s?.failed ? "work through the list: npx genclass suggest" : null,
  });

  // the first step to do that is not skipped and does not wait on a step that is not done (dashboard: the runtime)
  const ready = (x) => !x.after || steps.find((y) => y.id === x.after)?.state === "done";
  const next = steps.find((x) => x.state === "todo" && !(o.skip ?? []).includes(x.id) && ready(x)) ?? null;
  if (next) next.state = "next";
  return {
    cwd,
    host: host.overridden && !host.error ? host.host : null,
    app: { name: app?.name ?? project.name ?? null, framework: project.label || null, isApp, token: st.token ?? null, dashboardUrl: app?.dashboard_url ?? st.local?.dashboardUrl ?? null, site: notes.site ?? null, ...(isApp ? {} : { below: appsBelow(cwd) }) },
    account: me ? { label: accountLabel(me.account), plan: me.plan, suggestions: me.suggestions, billingUrl: me.billingUrl, github: me.github, offer: me.offer ?? null } : null,
    signedIn: !!me,
    /** the account's apps as genclass.dev lists them ([] signed out) */
    projects: me?.projects ?? [],
    sessionProblem: creds && !me ? offline : null,
    git: { repo: git.repo, github: git.github, root: git.root, branch: git.branch, ...(git.renamedFrom ? { renamedFrom: git.renamedFrom } : {}) },
    playwright,
    workflows,
    repo: repo?.ok ? repo : null,
    steps,
    next,
    complete: steps.every((x) => x.state === "done" || x.state === "optional"),
  };
}

/** The plan of the app with `token` (plans are per project), else the account's: what a header shows. */
export const planName = (state, token = state?.app?.token) => (state?.projects ?? []).find((p) => p.token === token && p.plan)?.plan?.name ?? state?.account?.plan?.name ?? null;

/** The state as plain data for `--json`: what a coding agent reads to know where things stand and what to run. */
/** The command for a step as a coding agent runs it: without a terminal the walk does a step only with --yes. */
const forAgent = (run) => (run === "npx genclass setup" ? "npx genclass setup --yes" : run);

export function stateJson(s) {
  return {
    app: s.app,
    signed_in: s.signedIn,
    account: s.account ? { label: s.account.label, plan: s.account.plan } : null,
    github: s.git.github,
    steps: s.steps.map((x) => ({ id: x.id, title: x.title, state: x.state, detail: x.detail, run: x.state === "done" ? null : forAgent(x.run), human: x.state === "done" ? null : x.human })),
    next: s.next ? { id: s.next.id, title: s.next.doing, run: forAgent(s.next.run), human: s.next.human, why: s.next.why } : null,
    complete: s.complete,
  };
}
