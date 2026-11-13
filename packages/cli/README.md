# genclass

GenClass in your terminal: one command that sets it up, shows what it finds on your live site, has it fixed, and
answers questions about your app.

```bash
npx genclass
```

Run it in your web app's folder. It shows where the project stands and walks you through the next step: one Enter
per step. Stop at any point and run it again: it continues from what is true now.

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
  │                   ada@example.com • Free plan                    │
  │                           ~/code/shop                            │
  │                                                                  │
  ╰──────────────────────────────────────────────────────────────────╯

  ✔  Done     Account • Runtime
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

Type a number, a command, or a sentence: a sentence is a question about your app. `q` leaves. On Free, each command
ends with one line on Free's limits and `genclass upgrade`. Everything here is also a
command of its own (`npx genclass problems`), so scripts and coding agents use the same things.

**Just `genclass`.** `npx` runs the command without installing it, so the first run on a terminal installs it
(`npm install -g genclass`, said on screen; `npm uninstall -g genclass` takes it out, `GENCLASS_NO_INSTALL=1` turns
it off). After that you type `genclass`, and every screen says `genclass` instead of `npx genclass`.

## Every part, in order

| Part | What the step does | What it changes |
|---|---|---|
| Account | Opens genclass.dev in your browser; you approve a short code there. | A session file in your user config folder. Nothing is typed in the terminal. |
| Runtime | Adds GenClass to the app: one import (or script tag) and the package. It watches the page in your users' browsers for lost edits, double submits and old data shown over new, and only reports, to the console and your dashboard. Nothing is drawn on your pages. | Your entry file and `package.json`; you see the change first. `genclass remove` undoes it. |
| Plan | Once the app is in your account, its plan page opens in your browser: Team, or Free for now (limited) after saying what stops you from paying. Each app has its own plan. The setup goes on once it has one. | Nothing in your project. The payment is on Stripe's page; the command never sees a card. |
| Dashboard | Waits for your live site to be opened once. GenClass sends nothing from localhost. | Nothing. |
| Test workflow | Runs your Playwright tests once more per pull request with slow and reordered responses. | One new file, `.github/workflows/genclass.yml`, which you commit. |
| GitHub App | Comments on a pull request when a page ends up wrong, with the steps to see it. The command opens GitHub's install page and waits for the answer. A repository that was renamed on GitHub is looked up under its new name. | Nothing in your project. The app cannot read or change your code. |
| Coding agent | Gives Claude Code, Cursor and other agents GenClass's tools and its skill: ask what went wrong, replay it, check the fix. | `.mcp.json` (or `.cursor/mcp.json`) and `.claude/skills/genclass/SKILL.md`. |
| Suggestions | Tells you what your app is missing, most important first. | Nothing in your project. |

On a terminal, Enter starts a step and is the yes for what its sentence says it writes. While a step waits for you
in the browser (the sign-in, GitHub), Enter stops the wait and the walk goes on. A part that does not apply
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
  ada@example.com • Team plan
  ────────────────────────────────────────────────────────────────────────────
  last 7 days · last page 3 hours ago

  Visits watched 1,204      Problems found 17         ▁▃▂▇▅▁█
  Handled        3          Visual checks  9

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
| `npx genclass analytics` | visitors: visits, page views, time on a page, where people come from, devices and countries, what gets clicked again and again. One part in full: `analytics pages`, `sources`, `devices`, `clicks`, `paths`, `funnels` (Team) |
| `npx genclass events` | the latest events one per line: when, kind, how sure the model was, the page, and what GenClass did |
| `npx genclass health` | how GenClass itself runs on your pages: model loads, where it ran, decision time, what was not checked, runtime versions |
| `npx genclass report` | the period as Markdown, to paste or pipe (`--out report.md` writes a file) |
| `npx genclass export` | every stored event as a file, JSON Lines or `--format csv`, `--from` and `--to` as days (Team) |

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
day (3 on Free, 30 on Team).

## Connections

```bash
npx genclass connections
```

Where your app's new problems are sent (Slack, Sentry, PostHog, Datadog, or a webhook of your own), what the GitHub
App is doing on the repository, whether your coding agent is connected, and whether the app has a private link.

- `npx genclass connections add slack` sets a destination up (Team). What you type is not shown, goes to
  genclass.dev over HTTPS, is stored encrypted there and is not kept on your machine. Then `test`, `off`, `on`,
  `remove` in place of `add`.
- `npx genclass agent` shows how your coding agent is connected and what it did with the findings (found,
  reproduced, fix proven, closed). `npx genclass agent link` gives it the live site's numbers: it makes the app's
  private dashboard link and hands it to GenClass's MCP server in your own agent settings, never in a file of the
  repository.
- `npx genclass funnels add "Checkout" /cart /checkout /thanks` adds a funnel (Team); `funnels remove "Checkout"`
  removes it.

## Account

`npx genclass apps` lists your apps (`apps new "Name"` makes one). `npx genclass plan` shows your plan, its limits
and what is used, and each app's plan. `npx genclass profile` shows your account and each app's plan with numbered
choices (upgrade, billing, sign out); `npx genclass upgrade` opens the plan page of this folder's app. `npx genclass team` shows who is on
the plan (`team invite` makes a single-use invite link).

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
- **Safety:** a `.env` file in git, keys in tracked files.
- **Quality:** tests, a workflow that runs them, something that reports errors from real users.
- **Email:** SPF and DMARC, so your mail does not land in spam.

Each failed check comes with the evidence that was measured, what to do, and a prompt you can paste to your coding
agent. When you are signed in, genclass.dev orders the list for your app and words the reasons for it.

**What leaves your machine.** Requests to your own site, and, to get the plan, the checks that failed with their
evidence lines, plus your app's name, framework, address, payment provider and host. No source code, no file
contents, no secrets. The command shows this before the first time it sends it for a project; `--no-model` sends
nothing. genclass.dev passes it to the model that writes the plan and stores none of it.

**What is free.** Every check, with its evidence. The plan (why it matters for your app, the first step, the agent
prompt) is shown for the first three items on Free and for all of them on Team, with more plans a day.

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
| `npx genclass scan <url>` | 23 visual checks on one page |
| `npx genclass connections` | alerts, GitHub App, coding agent (`add`, `test`, `on`, `off`, `remove` a destination) |
| `npx genclass agent` | your coding agent and what it did (`agent link`) |
| `npx genclass funnels` | funnels (`add "Name" /a /b`, `remove "Name"`) |
| `npx genclass apps`, `plan`, `team` | your apps, your plan, the people on it |
| `npx genclass profile`, `upgrade` | your account and each app's plan; Team for this app |
| `npx genclass login`, `logout`, `whoami` | your account |
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
npx genclass report            # the period as Markdown
```

Two steps need the person: approving the sign-in and installing the GitHub App. Both happen in their browser, and
the command prints the link. At the sign-in, `setup --yes` prints a link and a code and waits up to ten minutes for
the person to approve, so give it a long timeout, or have them run `npx genclass login` first.

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
