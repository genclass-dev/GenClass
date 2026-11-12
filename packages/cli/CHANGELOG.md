# Changelog

## 0.2.0

- **`genclass dashboard` shows the app in the terminal**: problems found on the live site by kind and page, measured
  visual checks, what was handled, visitors, what the coding agent did with the findings, what the GitHub App is
  doing and what the last suggestions run left. `--range 24h|7d|30d`, `--all`, `--app <name>`, `--open`, `--json`.
  The numbers are the browser dashboard's, from a new route (`GET /api/cli/app`) with the same plan rules. The
  sign-in page now says the command can show them; a sign-in approved before that is asked to sign in once more
  instead of gaining it silently. Signed out, the command still prints an app's private dashboard link.
- **A short view.** The first screen is three or four lines: what is done, what is next, what waits on something
  outside this machine, what comes later. `d` (or `genclass status --all`) shows every part with what is known about
  it and a fuller explanation, and `d` again folds it back.
- **Every part of GenClass is a step**: account, runtime, dashboard, test workflow, GitHub App, coding agent,
  suggestions. The workflow file and the GitHub App were one step and are now two, in that order.
- **One Enter per step.** Enter is the yes for what the step's sentence says it writes, so the workflow file and the
  agent configuration are written without a second question, and an app added after signing in goes into the
  account without being asked again (`init --in-account`). The diff of the runtime's change is still shown first.
- **The GitHub App connects by itself as far as it can.** The step asks genclass.dev what GitHub says; with no
  answer it opens Continue with GitHub and waits, and when the app is not on the repository it opens GitHub's
  install page and waits until it is. Without a terminal it prints the two links.
- **An opening wordmark**, GENCLASS in block letters, on a terminal that is wide enough and has the characters.
  Never in piped output or `--json`.
- `status --json`: step ids are now `account`, `runtime`, `dashboard`, `workflow`, `github-app`, `agent`,
  `suggestions` (were `first-page` and `pull-requests`), and each step has a short `title`.

## 0.1.1

- **Fixed: the guided setup ended at the suggestions step's address question.** A question asked right after another
  one (with nothing in between that waits) had its input paused when the earlier question's reader closed, and the
  command ended at the prompt. Each question now waits for the one before it to have closed
  (`packages/runtime/bin/lib/ui.mjs` `ask`). Found on the first real run of 0.1.0.
- The README no longer says the package is not on npm.

## 0.1.0

The first version: one command for everything GenClass sets up.

- **`genclass`** shows where a project stands in six steps (signed in, GenClass in the app, first page seen, pull
  requests checked, coding agent connected, suggestions) and, on a terminal, walks the next one. Each step is read
  from what is on disk and what genclass.dev answers, so a run continues where the last one stopped.
- **`genclass setup --yes`** and **`genclass status --json`** are the same walk for a coding agent: nothing is asked,
  and what only a person can do (approve the sign-in, install the GitHub App) is printed with its link.
- **`genclass suggest [url]`** measures the repository and the live site against a catalog of checks (launch, search,
  AI assistants, payments, safety, quality, email) and prints what failed, most important first, each with its
  evidence, what to do and a prompt for a coding agent. Signed in, genclass.dev orders the list for the app and
  words the reasons; it is sent the failed checks and five things about the app, never code, and the command shows
  that before the first send.
- `login`, `logout`, `whoami`, `connect`, `dashboard`, `init`, `remove` and `scan` are the commands of
  `@genclass/runtime`'s own CLI, unchanged.
- One file with no dependencies. It installs `@genclass/runtime` and `@genclass/mcp` at the versions it was built
  with.
