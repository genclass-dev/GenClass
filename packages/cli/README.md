# genclass

GenClass in your terminal: one command that sets it up, shows what it finds on your live site, has it fixed, and
answers questions about your app.

```bash
npx genclass
```

Run it in your web app's folder. It shows where the project stands and walks you through the next step: one Enter
per step. Stop at any point and run it again: it continues from what is true now. It comes with Pro: 3 days free,
then US$15 a developer a month.

```text
  ╭─ GenClass ────────────────────────────────────────────── v0.3.7 ─╮
  │                                                                  │
  │                        Welcome back, Ada!                        │
  │                                                                  │
  │                              ▄▄▄▄█▄                              │
  │                           ▄█████████                             │
  │                         ▄███▀▀  ▀▀                               │
  │                         ███▀     ▄▄▄▄▄                           │
  │                         ███▄     ▀█████                          │
  │                         ▀███▄ ▄▄  ▄███▀                          │
  │                           ▀▀▄████████▀                           │
  │                              ▀▀█▀▀▀                              │
  │                                                                  │
  │                       shop • Vite + React                        │
  │                    ada@example.com • Pro plan                    │
  │                           ~/code/shop                            │
  │                                                                  │
  ╰──────────────────────────────────────────────────────────────────╯

  ✔  Done     Account • Pro • Runtime
  ●  Next     Add the test workflow
  ◌  Waiting  Dashboard: deploy, then open your site once
  ○  Later    GitHub App • Coding agent • Suggestions

  ▎ Next  Add the test workflow
  ▎ One new file, .github/workflows/genclass.yml.

  ────────────────────────────────────────────────────────────────────
  ❯ Enter to continue · d every part · s skip · q later
```

The view stays that short. Press `d` (or run `npx genclass status --all`) to see every part with what is known about
it, and `d` again to fold it back.

## It stays open

When the walk is done (or you press `q` to leave it for later), the command does not end. It asks what next:

```text
  What next? A number, a command, or a question.
   1  dashboard    what GenClass found on your live site
   2  problems     every problem, by kind and page
   3  analytics    visitors, pages, sources, clicks
   4  events       the latest events, one per line
   5  fix          hand a problem to your coding agent
   6  ask          ask about your app (or just type it)
   7  connections  alerts, GitHub, your coding agent
   8  suggest      what your app is missing
   9  profile      your account and plan, and upgrade
      help         every command   q leave

  ❯ which page loses the most visitors?
```

Type a number, a command, or a sentence: a sentence is a question about your app. `q` leaves. Every command works
here, the free local ones too (`privacy`, `doctor --fix`, `flake`), and everything here is also a command of its own
(`npx genclass problems`), so scripts and coding agents use the same things.

**The command comes with Pro.** Right after the sign-in, an account without Pro sees Pro's card, and Enter opens its
checkout in the browser: 3 days free (one trial per account; the card is asked for on Stripe, and nothing is charged
if you cancel before they end), then US$15 a developer a month, for up to 3 apps in the account. More apps come with
Enterprise, by email. Every command but `login`, `logout`, `whoami`, `plan`, `upgrade`, `profile`, `status`,
`privacy`, `doctor`, `flake`, `remove`, `help` and `version` asks first. Without a terminal (`--yes`, `--json`, a coding agent) nothing is opened:
one line with the checkout address, and exit code 1. Free stays on the website: one app's totals for the last 7 days.
Plans bought before 13 November 2026 keep every app they cover (an app paid for on its own does not count toward
Pro's 3); Free covers an account's oldest app and locks the others.

**Just `genclass`.** `npx` runs the command without installing it, so the first run on a terminal installs it
(`npm install -g genclass`, said on screen; `npm uninstall -g genclass` takes it out, `GENCLASS_NO_INSTALL=1` turns
it off). After that you type `genclass`, and every screen says `genclass` instead of `npx genclass`.

## Every part, in order

| Part | What the step does | What it changes |
|---|---|---|
| Account | Opens genclass.dev in your browser; you approve a short code there. | A session file in your user config folder. Nothing is typed in the terminal. |
| Pro | Right after the sign-in: Pro's 3-day free trial opens in your browser, and the command waits for it. Every step after it needs Pro. | Nothing in your project. The payment is on Stripe's page; the command never sees a card. |
| Runtime | Adds GenClass to the app: one import (or script tag) and the package. It watches the page in your users' browsers for lost edits, double submits and old data shown over new, and only reports, to the console and your dashboard. Nothing is drawn on your pages. | Your entry file and `package.json`; you see the change first. `genclass remove` undoes it. |
| App plan | Once the app is in your account, its plan page opens in your browser once: Continue with Pro. Pro covers up to 3 apps; more apps come with Enterprise, by email. | Nothing in your project. |
| Dashboard | Waits for your live site to be opened once. GenClass sends nothing from localhost; while it waits, the command says how to see GenClass work before any deploy: start your dev server, open the page, read the `[GenClass]` lines in the browser console, and ask your coding agent "is GenClass connected?" or to explore a flow for races. | Nothing. |
| Test workflow | Runs your Playwright tests once more per pull request with slow and reordered responses. | One new file, `.github/workflows/genclass.yml`, which you commit. |
| GitHub App | Comments on a pull request when a page ends up wrong, with the steps to see it. The command opens GitHub's install page and waits for the answer. A repository that was renamed on GitHub is looked up under its new name. | Nothing in your project. The app cannot read or change your code. |
| Coding agent | Gives Claude Code, Cursor and other agents GenClass's tools and its skill (ask what went wrong, replay it, check the fix), and links your dev page to them: `connectAgent` from `@genclass/runtime/agent`, in development builds only, so the agent sees each click, request and response on localhost and can run them again in another order. All of it is in one preview and one yes. Then it says how to see it work now: the dev server, the `[GenClass]` lines in the browser console, and "is GenClass connected?" for the agent. Done once the MCP server is configured and the link is in (or cannot be added for this framework: Angular, Nuxt and a plain script tag get the lines to add instead). The link needs `@genclass/runtime` 0.3.0-beta.1 or later (its `./agent` entry): with 0.2.x, npm's `latest`, the step writes no link and says to run `npm install @genclass/runtime@beta` first. | `.mcp.json` (or `.cursor/mcp.json`), `.claude/skills/genclass/SKILL.md`, and a `genclass:init` block right after GenClass's import (with more of your imports after it, the block holds the two imports and a second block right after your last import holds the call, so imports stay first and the call runs before your code; Vite apps, SvelteKit and React Router: `import.meta.env.DEV`; Next.js and Create React App: `process.env.NODE_ENV === "development"`; Astro: a second `<script>` line in the layout). `npx genclass remove` takes it out. The runtime package's own `npx @genclass/runtime@beta remove` (0.3.0-beta.6) does not know the link yet: in a linked project it removes nothing until the next runtime release, so use `npx genclass remove`. |
| Suggestions | Tells you what your app is missing, most important first. | Nothing in your project. |

On a terminal, Enter (or `y`) starts a step and is the yes for what its sentence says it writes; `s` or `n` skips it,
`q` stops, and any other answer is asked again, so a "no" never writes a file or opens a page. While a step waits for you
in the browser (the sign-in, GitHub), Enter stops the wait and the walk goes on. Pro and the app's plan are the
exception: nothing after them runs until they are done. A part that does not apply
is left out and says why: no Playwright tests, not a GitHub repository, not a web app.

## Your app in the terminal

```bash
npx genclass dashboard
```

What GenClass found on your live site, in one screen: problems by kind and page, measured visual checks, what was
handled, visitors, what your coding agent did with the findings, what the GitHub App is doing, and what the last
suggestions run left to do.

```text
  GenClass • shop                                                Vite + React
  ada@example.com • Pro plan
  ────────────────────────────────────────────────────────────────────────────
  last 7 days · last page 3 hours ago

  Page loads     1,204      Problems found 26         ▁▃▂▇▅▁█
  Handled        3          Of them checks 9

  Problems
    12  duplicate  /checkout    the same request went out twice
     4  stale      /orders/:id  old data replaced newer data
     1  failing    /cart        a request keeps failing

  Visual checks
    6  text-overflow  /pricing
    3  image-broken   /

  Visitors       312 visits · 1,020 page views · 41% left after one page
  Coding agent   5 found · 3 reproduced · 2 fixed · 1 with a test
  GitHub App     reviewing · 4 pull requests so far
  Suggestions    7 to do, 2 urgent · checked 2 days ago · npx genclass suggest
```

`--range 24h`, `7d` or `30d` (a plan with more history: `90d`, `1y`) picks the period, `--all` shows every row,
`--app <name>` another app of your account, `--open` the browser dashboard, `--json` the same as data. These are the
numbers your dashboard on genclass.dev shows, cut by the same plan rules.

Each part of the browser dashboard has its own view, short first, `--all` for every row:

| | |
|---|---|
| `npx genclass problems` | what was found, by kind and by page, the measured visual checks, what GenClass stopped on the visitor's screen, how it compares with the period before |
| `npx genclass analytics` | visitors: visits, page views, time on a page, where people come from, devices and countries, what gets clicked again and again. One part in full: `analytics pages`, `sources`, `devices`, `clicks`, `paths`, `funnels` |
| `npx genclass events` | the latest events one per line: when, kind, how sure the model was, the page, and what GenClass did |
| `npx genclass health` | how GenClass itself runs on your pages: model loads, where it ran, decision time, what was not checked, runtime versions |
| `npx genclass report` | the period as Markdown, to paste or pipe (`--out report.md` writes a file) |
| `npx genclass export` | every stored event as a file, JSON Lines or `--format csv`, `--from` and `--to` as days |

## Have it fixed

```bash
npx genclass fix
```

It lists what GenClass found on your live site, you pick one (or Enter for all of them), and it starts your coding
agent in the project with a prompt: what was found, where, how it is usually fixed, and the steps that reproduce it
and prove the fix with GenClass's MCP server. Claude Code, Codex, Cursor's agent and Gemini CLI are started when
their command is installed; otherwise the prompt is copied (`c`) or printed (`p`).

GenClass changes no code. The agent does, in your own session with it, where you see and approve what it does.
Nothing starts without a key press. `npx genclass fix stale --print` prints the prompt for one kind and nothing
else, which is how an agent asks for it itself.

## Flaky test, or racy app?

```bash
npx genclass flake                          # your whole Playwright suite
npx genclass flake tests/search.spec.ts     # any arguments of "playwright test": a file, file:line, --grep, --project, -c
```

It runs your own Playwright suite with your own `@genclass/playwright`: once with responses in their natural order,
then once per seed (5 by default, `--runs N`) with your app's API requests held for a seeded time before they leave,
so their responses can arrive in another order. Then it says, for each test, one of four things, from what the run
measured and nothing else:

| Verdict | What it means |
|---|---|
| passed | it passed on every run |
| racy | it failed on some runs, and on a failing run GenClass saw a race on the page (a late response that wrote over newer data, a request sent again while the identical one was in flight): which request, the seeds, and the command that replays one |
| flaky | it failed on some runs and GenClass saw no race there, or could not watch those runs and says so: likely the test itself (a fixed wait, a timeout too tight for slower responses, state shared between tests) |
| broken | it failed on every run, in the natural order too: not about the order of responses. With `--seed` or `--no-baseline` there is no natural-order run: a test that failed on every seed with no race seen is listed apart ("Failed on every seed"), with the command that runs it in the natural order too |

It ends with the one command that replays a failing seed, such as
`npx genclass flake tests/search.spec.ts:12 --project chromium --seed 2` (the same seed holds the same requests for
the same time, so the responses come back in the order the run saw, unless your server's own timing changes it), and
a prompt for your coding agent: what failed,
on which seeds, what GenClass recorded, and how to prove the fix with the same seed. On a terminal, Enter starts the
agent with it (Claude Code, Codex, Cursor's agent or Gemini CLI, as `genclass fix` does), `c` copies it and `p` prints
it; piped, it is printed. `--json` gives the same as data, `--print` only the prompt. Exit code 0 when every test
passed every time, 1 when one did not, 2 when nothing could be judged.

What it needs: Playwright, and in the same project `npm install -D @genclass/playwright @genclass/runtime@beta`.
Without them it prints that line (with your package manager) and runs nothing; an app that lists `@genclass/runtime`
in its dependencies is told to install it without `-D`, so a production install keeps it. Your tests and your
`playwright.config` stay as they are. It adds a reporter of its own, which writes to a temporary folder, on top of
yours with `--add-reporter`. A Playwright without `--add-reporter` only has `--reporter`, which replaces the
config's reporters for these runs: `genclass flake` says so before it starts, and the reporters you pass with
`--reporter` run next to its own. Retries are off unless you pass `--retries` (a retry would hide the failure), and
the HTML report does not open a browser. It is free and local: no sign-in, nothing is sent anywhere.

`--seed N` starts at seed N without the natural-order run (alone, it replays that one seed), `--no-baseline` skips the
natural-order run, `--no-chaos` repeats every run in the natural order (plain repeats, nothing held). The race files
stay in `test-results/genclass`, one per test and seed of the last run.

"No race seen" is not "no race": GenClass sees writes to the state it finds on the page (React, Redux and Zustand
stores, and stores registered with the runtime) by the requests the run holds (same-origin `/api*` or JSON requests
unless `GENCLASS_CHAOS_MATCH` says otherwise). A test is called racy only when a race file of one of its failing runs
shows a race. Measured on the fixture app of [`test/e2e/flake.e2e.mjs`](test/e2e/flake.e2e.mjs) (Chromium, the
search page of `@genclass/playwright`'s own end-to-end check, four ordinary tests, 6 runs each; one page and one
planted bug by this team, so not a recall figure for real suites): in four runs of the e2e, the buggy page's test was
racy each time (it failed on seeds 1, 3 and 4, with the late response seen on all 12 failing runs; it passed in the
natural order), and the three tests on the fixed page showed no race on any of their 72 runs (false reports on the
correct variant: 0, counted and required by the e2e). All four replays of seed 1 and all four of seed 3 failed again
with the same race ([RESULTS.md §30](../../docs/runtime/RESULTS.md)).

## Ask

```bash
npx genclass ask "what is going wrong on my site?"
```

A question in your own words, answered by GenClass's model from what the runtime found on your live site: pages,
kinds of problem and counts, and with visitor analytics the sources and what people click. In the home, just type
the question; a follow-up ("and on which page?") carries the turn before it.

**What leaves your machine:** the question. The numbers are read on genclass.dev, where they already are, and go to
the model (OpenAI's API) with it. No code, no file of your project. Neither the question nor the answer is stored.
The command says this before the first question and waits for Enter. Ask and suggest share a plan's model runs a
day (30 on Pro).

## Connections

```bash
npx genclass connections
```

Where your app's new problems are sent (Slack, Sentry, PostHog, Datadog, or a webhook of your own), what the GitHub
App is doing on the repository, whether your coding agent is connected, and whether the app has a private link.

- `npx genclass connections add slack` sets a destination up. What you type is not shown, goes to
  genclass.dev over HTTPS, is stored encrypted there and is not kept on your machine. Then `test`, `off`, `on`,
  `remove` in place of `add`.
- `npx genclass agent` shows how your coding agent is connected and what it did with the findings (found,
  reproduced, fix proven, closed). `npx genclass agent link` gives it the live site's numbers: it makes the app's
  private dashboard link and hands it to GenClass's MCP server in your own agent settings, never in a file of the
  repository.
- `npx genclass funnels add "Checkout" /cart /checkout /thanks` adds a funnel; `funnels remove "Checkout"`
  removes it.

## Account

`npx genclass apps` lists your apps (`apps new "Name"` makes one). `npx genclass plan` shows your plan, its limits
and what is used, and each app's plan. `npx genclass profile` shows your account and each app's plan with numbered
choices (upgrade, billing, sign out). `npx genclass upgrade` starts Pro, its free trial first, for an account
without it. With Pro there is nothing to upgrade: it says where seats are added (Manage billing), and for an app past
Pro's 3 it says that more apps come with Enterprise, with the app's plan page. `npx genclass team` shows who is on the
plan (`team invite` makes a single-use invite link).

**What a terminal may do** is listed on the page where you approve its sign-in, and nothing else: read your apps'
dashboards, analytics and stored events, ask the model, change where alerts go, funnels and the private link, show
the plan and the team and make an invite link. It cannot change how you sign in, pay for anything, remove people,
or delete an app or your account: those stay in the browser, and the command prints the address. A sign-in from
before 0.3.0 was approved for less, so the first command that needs more asks you to sign in once more.

## Suggestions

```bash
npx genclass suggest https://your-site.com
```

It measures your repository and your live site against a list of checks, in plain words:

- **Launch:** HTTPS, one address for www and the bare domain, a real page title, a 404 for missing pages, somewhere
  to try a change before users get it.
- **Search:** a description, a link preview image, robots.txt, a sitemap.
- **AI assistants:** whether ChatGPT, Claude and Perplexity may read the site, and whether the page has any text
  before JavaScript runs.
- **Payments:** test keys on the live site, a secret key in browser code, a price people can see.
- **Safety:** a `.env` file in git, keys in tracked files, secret keys in the JavaScript your live site ships (the
  kind and the script, never the value), and a Next.js or React Server Components version with a known critical
  hole (CVE-2025-55182, CVE-2025-29927).
- **Quality:** tests, a workflow that runs them, something that reports errors from real users.
- **Email:** SPF and DMARC, so your mail does not land in spam.

Each failed check comes with the evidence that was measured, what to do, and a prompt you can paste to your coding
agent. genclass.dev orders the list for your app and words the reasons for it.

**What leaves your machine.** Requests to your own site, and, to get the plan, the checks that failed with their
evidence lines, plus your app's name, framework, address, payment provider and host. No source code, no file
contents, no secrets. The command shows this before the first time it sends it for a project; `--no-model` sends
nothing. genclass.dev passes it to the model that writes the plan, and keeps the plan it writes for your app, not
what was sent.

**What Pro shows.** Every check, with its evidence, and the plan for all of them: why it matters for your app, the
first step and the agent prompt, with the model's own ideas and website designs.

## Privacy and health checks

```bash
npx genclass privacy
npx genclass doctor
```

`privacy` says what this project's GenClass setup sends from your visitors' browsers, to whom and for how long, what
it keeps on their devices, the opt-outs it honours, what that means for EU, UK and US visitors, the exact options that
make it send and keep nothing, and the Content-Security-Policy lines it needs. It reads your project's files and
nothing else, needs no account, and is not legal advice. `--out genclass-privacy.md` writes it for your privacy
policy or a vendor questionnaire. For sites that ask visitors first (the EU, EEA and UK) it names the runtime's
consent gate, `consent: "pending"`: with it set, the map says that each recipient and stored entry waits for the
visitor's grant, and whether your project's GenClass files pass the choice on with
`GenClass.consent({ diagnostics, analytics, storage, model })`.

`doctor` checks every part GenClass added (this command's version and the one on your PATH, the runtime and its
import order, the MCP server's pin, the skill, the coding-agent link, the bridge, your site's
Content-Security-Policy, the test workflow) and says what to run for each. `--fix` writes GenClass's own lines only,
after showing them: the MCP pin, the skill, and the dev-only coding-agent link (the same block the Coding agent step
writes, in every setup init writes but Angular, Nuxt and a plain script tag), which `remove` takes out again.

## Commands

`npx` runs the command without installing it. The first run on a terminal installs it, so you can type just
`genclass` (by hand: `npm install -g genclass`).

| | |
|---|---|
| `npx genclass` | where the project stands; on a terminal, the next step, then the home |
| `npx genclass setup` | the guided setup (`--yes`: no questions) |
| `npx genclass status` | what is done and what is next (`--all`: every part; `--json`) |
| `npx genclass dashboard` | your app in the terminal (`--open` the browser dashboard) |
| `npx genclass problems` | every problem found, by kind and page, and what GenClass did |
| `npx genclass analytics [part]` | visitors; parts: `pages`, `sources`, `devices`, `clicks`, `paths`, `funnels` |
| `npx genclass events` | the latest events, one per line |
| `npx genclass health` | how GenClass itself runs on your pages |
| `npx genclass report` | the period as Markdown (`--out <file>`) |
| `npx genclass export` | every stored event as a file (`--from`, `--to`, `--format csv`, `--out`) |
| `npx genclass fix [number, kind or all]` | hand a problem to your coding agent (`--print`, `--copy`, `--agent <name>`) |
| `npx genclass ask "..."` | a question about your app, answered from its numbers |
| `npx genclass suggest [url]` | what your app is missing, then one number hands the list to your coding agent (`--yes`, `--no-model`, `--all`) |
| `npx genclass scan <url>` | 23 visual checks on one page (free, with no account: `npx @genclass/runtime@beta scan <url>`) |
| `npx genclass connections` | alerts, GitHub App, coding agent (`add`, `test`, `on`, `off`, `remove` a destination) |
| `npx genclass agent` | your coding agent and what it did (`agent link`) |
| `npx genclass funnels` | funnels (`add "Name" /a /b`, `remove "Name"`) |
| `npx genclass apps`, `plan`, `team` | your apps, your plan, the people on it |
| `npx genclass profile`, `upgrade` | your account and each app's plan; start Pro |
| `npx genclass login`, `logout`, `whoami` | your account |
| `npx genclass privacy` | what is sent and kept, and how to send nothing (`--out`, `--json`; free) |
| `npx genclass doctor` | is every part in place and current (`--fix`, `--json`, `--offline`; free) |
| `npx genclass flake [tests]` | is a failing Playwright test flaky, or is your app racy (`--runs N`, `--seed N`, `--json`, `--print`; free, local) |
| `npx genclass remove` | take GenClass out of the app again |

Options: `--app <name>`, `--range 24h|7d|30d|90d|1y`, `--all`, `--json`, `--cwd <dir>`, `--yes`, `--no-browser`.

## For coding agents

`genclass` asks nothing when it is not run on a terminal, so an agent can drive it:

```bash
npx genclass status --json     # where things stand, and "next": the command to run or what only a person can do
npx genclass setup --yes       # does every step that needs no person; prints the links for the ones that do
npx genclass suggest --json    # the checks that failed, with evidence, in order
npx genclass dashboard --json  # what GenClass found on the live site
npx genclass problems --json   # the same by kind and page; also analytics, events, health, agent
npx genclass fix --print       # the prompt to fix what was found (fix stale --print: one kind)
npx genclass flake --json      # each Playwright test: passed, racy (seed, request, replay), flaky or broken; and a prompt
npx genclass report            # the period as Markdown
```

Four steps need the person, in their browser, and the command prints the link for each: approving the sign-in,
starting Pro's 3-day trial (their card, on Stripe), opening a new app's plan page once, and installing the GitHub
App. At the sign-in, `setup --yes` prints a link and a code and waits up to ten minutes for the person to approve, so
give it a long timeout, or have them run `npx genclass login` first. Without Pro, `setup --yes` stops at the trial
with exit code 1 and one line with the checkout link, and every command that needs Pro answers the same way (`upgrade`
included; `scan` and `audit` end with 2): give the person the link, wait for them to start the trial, then run
`setup --yes` again. With `--json` that answer is one shape everywhere: `{ "ok": false, "needs_pro": true,
"signed_in", "plan", "price", "trial_days", "checkout_url", "run" }`, where `run` is the command to run next.

## How it is built

One file with no dependencies, so `npx genclass` starts at once. It reuses the sign-in, project detection and
install code of `@genclass/runtime`'s own CLI ([`packages/runtime/bin`](../runtime/bin)) and installs the runtime
and MCP server versions it was built with. Sources: [`src/`](src). The server side is
[`telemetry-worker/src/cli.ts`](../../telemetry-worker/src/cli.ts) and
[`suggest.ts`](../../telemetry-worker/src/suggest.ts). Privacy: [PRIVACY.md](../../PRIVACY.md).

```bash
npm run build -w genclass          # dist/genclass.mjs
(cd packages/cli && npx vitest run)
```

`genclass flake` in a real browser (not in the vitest run: it needs Chromium and the built runtime and
`@genclass/playwright`): `npm run build -w @genclass/runtime && npm run build -w @genclass/playwright && npm run build -w genclass && node packages/cli/test/e2e/flake.e2e.mjs`.
