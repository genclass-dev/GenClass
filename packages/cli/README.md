# genclass

One command that sets GenClass up and tells you what your app needs next.

```bash
npx genclass
```

Run it in your web app's folder. It shows where the project stands and walks you through the next step. Stop at any
point and run it again: it continues from what is true now.

```text
  GenClass • shop                                                Vite + React
  ada@example.com • Free plan
  ────────────────────────────────────────────────────────────────────────────
  ✔  Signed in                ada@example.com · Free plan
  ✔  GenClass is in this app  added · app "shop"
  ◌  First page seen          deploy, then open your site once
  ●  Pull requests checked    Playwright found · no workflow file yet
  ○  Coding agent connected
  ○  Suggestions

  Next  Check every pull request
        On each pull request GenClass runs your Playwright tests once more with slow and
        reordered responses, and comments when a page ends up wrong, with the steps to see it.
```

> **Status:** `genclass` is not on npm yet. From a checkout of this repository:
> `npm run build -w genclass && node packages/cli/bin/genclass.mjs` in your app's folder.

## The six steps

| Step | What it does | What it changes |
|---|---|---|
| Signed in | Opens genclass.dev in your browser; you approve a short code there. | A session file in your user config folder. Nothing is typed in the terminal. |
| GenClass is in this app | Adds the runtime: one import (or script tag) and the package. It watches the page in your users' browsers for lost edits, double submits and old data shown over new, and only reports. | Your entry file and `package.json`, after you have seen the diff and said yes. `genclass remove` undoes it. |
| First page seen | Waits for your live site to be opened once. GenClass sends nothing from localhost. | Nothing. |
| Pull requests checked | Runs your Playwright tests once more per pull request with slow and reordered responses, and comments when a page ends up wrong. | One new file, `.github/workflows/genclass.yml`, which you commit. You install the GenClass GitHub App in your browser; it cannot read or change your code. |
| Coding agent connected | Lets Claude Code, Cursor and other agents ask GenClass what went wrong and check their fix. | `.mcp.json` (or `.cursor/mcp.json`), after you have seen the change. |
| Suggestions | Tells you what your app is missing, most important first. | Nothing in your project. |

A step that does not apply is left out and says why: no Playwright tests, not a GitHub repository, not a web app.

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

| | |
|---|---|
| `genclass` | where the project stands; on a terminal, the next step |
| `genclass setup` | the guided setup (`--yes`: no questions) |
| `genclass status` | the checklist (`--json`) |
| `genclass suggest [url]` | what your app is missing (`--json`, `--yes`, `--no-model`, `--all`) |
| `genclass dashboard` | this app's dashboard (`--open`) |
| `genclass scan <url>` | 23 visual checks on one page |
| `genclass login`, `logout`, `whoami` | your account |
| `genclass remove` | take GenClass out of the app again |

Options everywhere: `--cwd <dir>`, `--yes`, `--json`, `--no-browser`.

## For coding agents

`genclass` asks nothing when it is not run on a terminal, so an agent can drive it:

```bash
npx genclass status --json     # where things stand, and "next": the command to run or what only a person can do
npx genclass setup --yes       # does every step that needs no person; prints the links for the ones that do
npx genclass suggest --json    # the checks that failed, with evidence, in order
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
