# Changelog

## 0.2.3

From using the command on a real site the morning after 0.2.2, and from watching its owner use it:

- **A new first screen.** On a terminal the command opens with a welcome card: its name and version in the border,
  "Welcome back, Ada!" (or, signed out, what GenClass does in two lines), GenClass's logo as pixel art (the green
  arrow over the top, the red arrow underneath, in the logo's own two greens and two reds), and three quiet lines for
  the app, the account and the folder. It fits a 58-column window, where the old block-letter wordmark never showed.
  What comes next stands beside a green bar, and the question is one line under a rule: `❯ Enter to continue · d
  every part · s skip · q stop`. Piped output and `--json` are as plain as before.
- **An app on Vite 7 or earlier builds again.** Found by installing into a fresh Vite 7 app and running its
  build: `vite build` failed with `Invalid value "iife" for option "worker.format"` once GenClass was in it, because
  Vite before 8 bundles a worker as one classic script and the model's worker cannot be one. Every app in GenClass's
  own repository is on Vite 8, so this was never seen. The runtime step now shows and writes the two settings such
  an app needs (`worker: { format: "es" }` for the build, `optimizeDeps: { exclude: ["@genclass/runtime"] }` so the
  dev server runs the model in a worker instead of on the page's thread), as the first keys of your Vite config,
  with its own marker. An app that already has GenClass gets "Add two Vite settings" as its next step. A config it
  cannot edit without guessing (a function, one that sets `worker` itself, an app with workers of its own) is left
  alone and gets the two lines to add by hand. `remove` takes them out. Vite 8 needs nothing and gets nothing.
- **`npx genclass remove` takes out everything GenClass put in the project.** After the runtime (the import, the
  config file, the package) it lists what the other steps wrote and removes it on one more yes: GenClass's entry
  in `.mcp.json` (your other servers stay; the file goes only when that entry was all it held), the skill (only
  while it still carries its marker), the pull-request workflow (only while it is exactly the file this command
  wrote) and `.genclass/`, where the coding agent's tools keep what they recorded. What you made your own is kept
  and named. Your app stays in your account.
- **From walking the whole setup as a new user, twice, on a real terminal at 80 and 58 columns:**
  - A sign-in that did not finish (the code expired, the browser said no) is offered once more instead of the walk
    moving on without an account.
  - The sign-in step says where a new person's account comes from ("New here? Your free account is made there").
  - Nothing runs past a narrow window any more: the runtime step's lines, the suggestions (a long evidence line
    wraps instead of ending in "…"), the list of steps, the day-to-day commands. A command or an address is never
    split across two lines.
  - Suggestions no longer list the internal names of checks that need your site ("Not checked (20): https,
    www-joined, ..."); it says how many there are and how to get them.
- **Every command it names is one you can run.** The screens said `genclass suggest`, which is "command not found"
  for anyone who started with `npx genclass` and has nothing installed. They now say `npx genclass suggest`, in the
  views, the help and the `run` fields of `--json`. The help says how to get the short name
  (`npm install -g genclass`).
- **A folder that is not a web app is no longer a dead end.** In a monorepo's root, or the folder above the app, the
  command lists the web apps it finds below (three folders deep, eight named) with the command for each, and on a
  terminal it asks which one and carries on there. `status --json` carries the list as `app.below`.
- A mistyped command names the nearest one: `genclass dashbord` says "Did you mean npx genclass dashboard?".
- **`genclass login` signs in again when it has to.** With a sign-in from before the command could show dashboards,
  `genclass dashboard` said "run genclass login" and `genclass login` answered "already signed in". It now says what
  is missing and asks for one more approval in the browser.
- **`genclass scan --local` works.** The command carries no copy of the runtime, so it uses the one installed in the
  project (`node_modules/@genclass/runtime`, in this folder or one above it). When there is none it says what to
  install, instead of naming a build step of GenClass's own repository.
- **`genclass scan` waits for a scan of the same page that is already running** (someone else's, or yours a moment
  ago) and prints that scan's report, instead of stopping with "try again in 20 s".
- **A normal page is not told its check "could not finish".** A page with no search box and no form gives the race
  probe nothing to try; that row now reads "nothing to try on this page" and does not count as a part that failed.
- **A page check that could not finish says so next to the score.** On a heavy page the hosted check runs out of
  time, and the report read "Score 83/100" with five of eight parts not measured further down. It now reads
  "Score 83/100 over 3 of 8 parts", says which parts the score covers and why, and gives the command that runs the
  visual checks on your computer with no time limit. With nothing measured it is one sentence, not a table of dashes.
- The page check's help and messages say `genclass scan`, not `genclass-runtime scan`, the help says where the
  check runs by default (on genclass.dev), and the full report's link is on genclass.dev.
- The npm page links to the command's guide, genclass.dev/docs/cli.

## 0.2.2

From a walk through the whole setup as a new user, against a local copy of genclass.dev:

- **The runtime step is short.** Inside the walk, adding GenClass prints four lines before the change (the project,
  what is added and in which mode, the anonymous diagnostics with their switch and the link to what is sent, where
  the app goes) instead of a dozen rows, and three lines after it (`init --brief`). The change itself is still shown
  in full before it is written.
- **No wait holds you.** Enter stops waiting for the browser sign-in, for GitHub's answer and for the first page;
  the step is then skipped for this run and the walk goes on.
- **The coding agent step also writes the skill**, `.claude/skills/genclass/SKILL.md`: the procedure the agent
  follows with GenClass's tools, as `npx @genclass/mcp init` writes it (same marker; a file you made your own is
  kept). The step ends with what to say to the agent next.
- **A genclass.dev with no GitHub App** (a collector you host yourself): the GitHub App step does not apply,
  instead of waiting 90 seconds for an answer that cannot come.
- **The sign-in page names what you ran.** The command names itself `genclass <version>`, so the approval page
  shows that and says `npx genclass` (it showed the runtime package's name and login command).
- Files the setup writes say `npx genclass` and `npx genclass remove` in their comment, and a note about a mostly
  static site names `npx genclass scan`.
- Suggestions: when the only workflow is GenClass's own, the check about tests on pull requests says that GenClass's
  run is separate and never blocks a merge, instead of "genclass.yml runs no tests".

## 0.2.1

- **Nothing is drawn on a page.** The runtime step adds GenClass without the developer overlay (`init
  --no-devtools`), so an app set up by this command shows its own layout and nothing of GenClass's, on localhost as
  on the deployed site. What GenClass finds goes to the browser console, the dashboard and `genclass dashboard`.
  (On a deployed site nothing was ever drawn; the overlay appeared only on localhost.) An app set up by 0.2.0 or
  earlier keeps its dev-only overlay line until it is removed by hand or with `genclass remove` and a new setup.

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
