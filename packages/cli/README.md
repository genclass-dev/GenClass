# genclass

One command that sets GenClass up and tells you what your app needs next.

```bash
npx genclass
```

Run it in your web app's folder. It shows where the project stands and walks you through the next step: one Enter
per step. Stop at any point and run it again: it continues from what is true now.

```text
  ╭─ GenClass ────────────────────────────────────────────── v0.2.3 ─╮
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
  ❯ Enter to continue · d every part · s skip · q stop
```

The view stays that short. Press `d` (or run `npx genclass status --all`) to see every part with what is known about
it, and `d` again to fold it back.

## Every part, in order

| Part | What the step does | What it changes |
|---|---|---|
| Account | Opens genclass.dev in your browser; you approve a short code there. | A session file in your user config folder. Nothing is typed in the terminal. |
| Runtime | Adds GenClass to the app: one import (or script tag) and the package. It watches the page in your users' browsers for lost edits, double submits and old data shown over new, and only reports, to the console and your dashboard. Nothing is drawn on your pages. | Your entry file and `package.json`; you see the change first. `genclass remove` undoes it. |
| Dashboard | Waits for your live site to be opened once. GenClass sends nothing from localhost. | Nothing. |
| Test workflow | Runs your Playwright tests once more per pull request with slow and reordered responses. | One new file, `.github/workflows/genclass.yml`, which you commit. |
| GitHub App | Comments on a pull request when a page ends up wrong, with the steps to see it. The command opens GitHub's install page and waits for the answer. | Nothing in your project. The app cannot read or change your code. |
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

`--range 24h`, `7d` or `30d` picks the period, `--all` shows every row, `--app <name>` another app of your account,
`--open` the browser dashboard, `--json` the same as data. These are the numbers your dashboard on genclass.dev
shows, cut by the same plan rules. The sign-in page says the command can show them; a sign-in from before 0.2.0
was approved without that, so the command asks you to sign in once more.

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

`npx` runs the command without installing it. To type just `genclass`, install it once: `npm install -g genclass`.

| | |
|---|---|
| `npx genclass` | where the project stands; on a terminal, the next step |
| `npx genclass setup` | the guided setup (`--yes`: no questions) |
| `npx genclass status` | what is done and what is next (`--all`: every part; `--json`) |
| `npx genclass suggest [url]` | what your app is missing (`--json`, `--yes`, `--no-model`, `--all`) |
| `npx genclass dashboard` | your app in the terminal (`--range`, `--all`, `--app`, `--open`, `--json`) |
| `npx genclass scan <url>` | 23 visual checks on one page |
| `npx genclass login`, `logout`, `whoami` | your account |
| `npx genclass remove` | take GenClass out of the app again |

Options everywhere: `--cwd <dir>`, `--yes`, `--json`, `--no-browser`.

## For coding agents

`genclass` asks nothing when it is not run on a terminal, so an agent can drive it:

```bash
npx genclass status --json     # where things stand, and "next": the command to run or what only a person can do
npx genclass setup --yes       # does every step that needs no person; prints the links for the ones that do
npx genclass suggest --json    # the checks that failed, with evidence, in order
npx genclass dashboard --json  # what GenClass found on the live site
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
