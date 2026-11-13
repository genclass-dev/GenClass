# Changelog

## 0.3.6

The paid plan is Pro (it was called Team), with 3 days free:

- **Free shows the totals and one suggestion.** `problems`, `events`, `report` and `fix` say what Pro adds, its
  trial and price, and `genclass upgrade`; `dashboard` shows the headline numbers with the same box; `ask` is Pro's.
- **`genclass suggest` on Free: the first suggestion and how many more**, counting the checks, the model's own ideas
  and website designs. A Free app is shown that same plan again on later runs (with its date) until it has Pro.
- **On Pro, suggest also prints the model's ideas** (marked as not measured) **and website designs**: each one is
  inspired by a real site that fits what the company does, with a complete prompt to paste into Claude. The hand-off
  menu copies a design's prompt in one key.
- The digest sent for a plan now includes what the site says it is about (its title and description), shown before
  it is sent.
- The plan card and the Free line name the trial: 3 days free, then $15 a project a month.
- Suggest's lines fit 58 columns.

## 0.3.5

For onboarding paying customers:

- **Every app chooses its plan on a page.** Once the app is in the account, the setup opens the app's plan page in
  the browser: Team large, with its price and a Start button, and a very small "Try for free (limited)" under it.
  Free asks what is stopping them from paying first. The terminal shows the same card and waits for the choice made
  there; the setup goes on only once the app has its plan. Plans are per
  app now: Team is $15 a project a month with the whole team on it, Free covers 3 apps and 100 problems fixed live a
  month per app. A fourth app has only Team. Before, the plan was a card in the terminal only, and a setup run
  without a keyboard (`--yes`, a coding agent) chose Free without showing anything.
- **`genclass` alone works.** A run through `npx genclass` on a terminal installs the command (`npm install -g
  genclass`) and says so; `npm uninstall -g genclass` takes it out, `GENCLASS_NO_INSTALL=1` turns it off.
- **Numbered choices.** The home lists its commands with numbers (type 3 for analytics), and "Which app?" is a
  numbered list instead of commands to retype.
- **`genclass profile`**: who is signed in, each app's plan, and numbered choices to upgrade, open billing or sign
  out. **`genclass upgrade`** opens the plan page of this folder's app (`--app` for another).
- On Free, every command ends with one line: the limits and the way up (`genclass upgrade`).
- **`genclass suggest` hands the whole list to your coding agent**: after the list, one number starts Claude Code,
  Codex, Cursor or Gemini CLI in the folder with every item, or copies or prints the prompt.
- `genclass dashboard` shows the live fixes used this month, and says when an app on Free has used them all and
  GenClass only observes until the month ends.
- `genclass apps new` says when the new app needs a plan of its own, with its plan page.

## 0.3.4

From a review of every setup path after a teammate hit the 0.3.2 bug:

- **The GitHub App step is offered for every repository on GitHub.** It waited for Playwright tests, so a project
  without them (most) never saw it. The app also comments production findings on pull requests, which need no tests.
- **A hand-written setup is no longer stuck at "Put this app in your account".** Its key (`GenClass.init({ token })`,
  `GENCLASS_CONFIG`, a meta tag) was not read, so the step came back on every run even with the app in the account.
- **An app set up with `@genclass/nuxt` or `@genclass/astro` is not treated as new**, so the walk no longer adds a
  second runtime import and a second app.
- **`--yes` no longer replaces a key that is not the account's** (a teammate's): `connect` says which options name
  the app instead.
- `setup --yes --json` prints only JSON on stdout; `status --json` names `npx genclass setup --yes` where a step
  needs it, so a coding agent no longer loops on `npx genclass setup`.
- Saying no to the runtime's change no longer leads to the Vite settings; signed out, the first-page and GitHub App
  steps say why they do nothing.
- Commands now run as the screen prints them: the signed-out `dashboard` with `--all`, `--range` or `--app`;
  `connect`, `init` and `audit` typed at the home prompt (they were sent to the model as questions); the CSP advice's
  `fetch-model`; `scan` of a local address; `--app` with a long or quoted name; "which app" and "sign in again" hints
  that dropped what was typed after the command.
- `remove` run from a folder inside the app finds GenClass's other files.
- `init` and `connect` run through `genclass` add no developer overlay, name themselves `npx genclass` in their help
  and errors, and point a newer runtime at `npx genclass@latest`.

## 0.3.3

- **"Put this app in your account" works.** For an app that already has GenClass in it but is not in the signed-in
  account (set up by someone else, or before there was an account), the step ran the runtime's `connect` with
  `--in-account`, an option only `init` takes. `connect` refused it and printed its usage, and the app could never
  be put in the account from the walk. Since 0.2.0; found by a teammate on a real project. The step now passes
  `connect` only its own options: it asks which of the account's apps this is (or makes a new one), shows the change
  and writes it. A test runs both of the runtime's commands with exactly what the step passes.
- **A step that fails says so, and the walk does not offer what depends on it.** The walk used to go straight on to
  "See your first page" (asking whether the site was deployed) for an app that was not in the account, which can
  never finish. Now a failed step gets one line saying it did not finish and will be offered again, and the first
  page is only offered once the app is in the account.
- When the account's plan has no room for another app, the hint names an app it has (`connect` and pick it) instead
  of "sign in again", which hit the same limit.

## 0.3.2

From the first run of 0.3.1 against production with a real account:

- **An answer from `genclass ask` shows no Markdown marks.** The model writes page names as `` `/checkout` ``; the
  backticks were printed as they were. Code is now cyan and bold is bold, with the marks taken out.
- **`genclass team` says "1 person"**, not "1 people", on a plan with no seat count.
- **`genclass apps` points at the app worth looking at:** this folder's, else the one that heard from its site last,
  instead of the first by name (which was an empty test app).

## 0.3.1

- **`genclass login` renews a sign-in that 0.3.0 asks to renew.** A sign-in approved before 0.3.0 can show
  dashboards but not the plan, alerts, stored events or questions, and the command says "run npx genclass login
  once". `login` only looked at whether the sign-in could show dashboards, so for such a sign-in it answered
  "already signed in", which was a dead end for anyone not at a prompt that signs in on Enter. It now asks the
  server the newest thing a terminal is approved for, and signs in again when the answer is "sign in again". Found
  the first time 0.3.0 met a real older sign-in in production.

## 0.3.0

The command becomes the whole product in a terminal. Until now it set GenClass up and ended; what the dashboard
shows, and everything an account can do, needed the browser.

- **It stays open.** When the walk is done, or left with `q`, the command asks what next: type a command
  (`problems`, `analytics`, `fix`, ...) or a sentence, which is a question about your app. `q` leaves. Inside it a
  view is not headed again by the card. A command typed whole, as a screen printed it (`npx genclass fix`), works
  there too.
- **Just `genclass`.** `npx genclass` runs without installing, so `genclass` alone was "command not found". The
  first time the home opens, the command offers to install itself (`npm install -g genclass`, shown first, asked
  once, never in CI or with `--yes`). Once `genclass` is on the PATH every screen says `genclass` instead of
  `npx genclass`.
- **Every part of the dashboard.** `problems` (by kind, by page, each kind on each page, the measured visual
  checks, what GenClass stopped on the visitor's screen, the change on the period before), `analytics` (visits,
  page views, time on a page, pages, sources and campaigns, devices, browsers, systems, countries, new and
  returning, clicks, rage clicks and dead clicks, paths, entry and exit pages, funnels; one part in full with
  `analytics pages` and so on), `events` (the latest 50 as stored, with mode and trigger under `--all`), `health`
  (model loads, where it ran, decision time, what was not checked, load errors, the visual checks' coverage, runtime
  versions; `--all` adds every breakdown), `report` (the dashboard's Copy as Markdown), `export` (every stored
  event as JSON Lines or CSV, page by page into one file). All of them fit a 58-column window, take `--range`,
  `--app`, `--all` and `--json`, and follow the plan's rules like the browser does.
- **`fix`: the problems, handed to your coding agent.** The list, a pick (a number, a kind, or all), and Enter starts
  Claude Code, Codex, Cursor's agent or Gemini CLI in the project with the dashboard's own prompt for it: what, where,
  the usual fix, and the steps that reproduce it and prove the fix with GenClass's MCP server. `c` copies, `p`
  prints, `--print` prints and nothing else. GenClass changes no code and starts nothing without a key press.
- **`ask`: talk to it.** A question in plain words is answered by genclass.dev's model from the app's dashboard
  numbers; a follow-up carries the turn before it. Only the question leaves the machine; the first time, the command
  says what goes to the model and waits for Enter. It shares a plan's daily model runs with `suggest`.
- **The account's side.** `connections` (where alerts go: Slack, Sentry, PostHog, Datadog, a webhook; add, test,
  turn off, remove, with what is typed never shown; plus the GitHub App, the coding agent and the private link),
  `agent` (how the agent is connected here and what it did with the findings) and `agent link` (gives the agent the
  live site's numbers, in your own agent settings, not in the repository), `funnels` (add and remove), `apps`
  (list, new), `plan` (limits, what is used, what the plan leaves out, and Enter to start the paid plan), `team`
  (who is on it, an invite link).
- **A plan is chosen at the start of the setup.** For an account on Free the step after the sign-in shows the paid
  plan, large, with its price and what it adds; Enter opens its checkout in the browser (one click less: the page
  goes straight to Stripe), `f` is "Try free for now (limited)". Asked once per project.
- **What a terminal may do is listed where it is approved.** The sign-in page now lists it line by line, and what
  it never can: change how you sign in, pay, remove people, delete an app or the account. A sign-in from before
  this version was approved for less: the first command that needs more says so and signs in again on Enter.
- Notes and lists no longer run two columns past a 58-column window; a share of almost all is no longer rounded up
  to "100%"; two apps with the same name can be told apart (`--app <id>`).

## 0.2.4

- **A repository that was renamed on GitHub is found under its new name.** A checkout cloned before a rename still
  carries the old name in its remote, and genclass.dev knows the repository by the current one, so the GitHub App
  step said "not on acme/shop-old yet" for an app that was installed and reviewing. When the server answers "not
  installed", the command asks github.com where the old address leads now (one HEAD request, public repositories
  only) and asks again under that name. The step's details say the new name and the line that updates the remote.
  Found on GenClass's own repository the first time the step was run against GitHub.

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
- **`npx genclass dashboard`, after seeing it on a real account:** the list is largest first whatever order the
  server sends, and leads with what happened in plain words ("old data replaced newer data", then the page) instead
  of the kind's name and a cut-off explanation; `--all` adds the kind's own name. The first number is "Page loads",
  the dashboard page's own word (it said "Visits watched" next to a different "visits" under Visitors). The chart of
  problems has a line of its own and folds a long period to the window. Long lines fold; nothing ends in "…".
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
