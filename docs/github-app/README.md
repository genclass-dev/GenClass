# genclass[bot]: the GitHub App

GenClass's GitHub App puts what the GenClass runtime saw on the pull request it was seen in. While your Playwright
tests run, the runtime watches the page under test: a request that left twice, an older response applied over a newer
one, a write that was overwritten. The fixture writes that to small files, your workflow uploads them, and the app
posts one check and one comment with each finding's test, its seeds and the evidence line.

It reads the race files your workflow uploads, never your source code. It is free on public repositories.

- Install: <https://genclass.dev/github> (or `https://github.com/apps/genclass/installations/new`)
- Code: [`telemetry-worker/src/github/`](../../telemetry-worker/src/github/)
- For whoever runs the app: [SETUP.md](SETUP.md). How it is built and why: [DESIGN.md](DESIGN.md).

> **Status (2026-11-09):** the code and its tests are in this repository. The app is not registered on GitHub yet and
> `@genclass/playwright` is not on npm yet, so nothing below can be installed today. [SETUP.md](SETUP.md) lists what
> is left, in order.

## Setup

1. **Install the app** on the account or organization, for all repositories or the ones you pick. Nothing else is
   asked: no sign-up, no token.

2. **Use the fixture in your Playwright tests.** It puts `@genclass/runtime` on each page under test in observe mode:
   it reports, and never holds, delays or changes anything your app does. With chaos on, each seed delays and reorders
   responses differently ([`packages/playwright`](../../packages/playwright/README.md) has every option).

   ```bash
   npm i -D @genclass/playwright @genclass/runtime@beta
   ```

   ```ts
   // playwright.config.ts
   use: { genclass: { chaos: { seed: 1, delayMs: [0, 600] } } },

   // in your specs
   import { test, expect } from "@genclass/playwright/fixture";
   ```

3. **Upload the race files from the workflow.** The fixture writes one JSON file per test and seed to
   `test-results/genclass`. `--repeat-each 2` runs every test under two seeds, which is what "reproducible" needs.

   ```yaml
         - run: npx playwright test --repeat-each 2
         - uses: actions/upload-artifact@v4
           if: ${{ !cancelled() }}
           with:
             name: genclass-races
             path: test-results/genclass
             retention-days: 7
   ```

   A whole workflow file is in [`workflows/genclass-e2e.yml`](workflows/genclass-e2e.yml). The job needs no secret and
   no write permission, so it works the same for pull requests from forks.

4. **Open a pull request.** The GenClass check appears on its commits. When something is flagged, the comment below
   appears, and later pushes edit it in place.

Reviews start with the first push or comment after the app is installed; a pull request that was already open is
picked up on its next push, or when someone comments `@genclass review`.

## What a review looks like

This is the comment for the reporter's own example files (a double submit seen in both seeds, a stale response seen
in one), as the app writes it; the report inside the fold and the footer's links are cut short here:

```markdown
## GenClass runtime review

**2 findings** in this pull request's tests at `4f2a9c1` · 1 reproducible · 2 tests read

| # | Status | Finding | Test | Seen |
|---:|---|---|---|---|
| 1 | New | Duplicate submit · `POST /api/orders` | checkout.spec.ts > checkout > places one order | 2 of 2 seeds, **reproducible** |
| 2 | New | Stale response · `GET /api/search` | search.spec.ts > search > shows the results of the last query | 1 of 2 seeds |

Reply `@genclass replay 1` for the steps to reproduce a finding, or `@genclass fix 1` for a brief a coding agent can work from.

<details><summary>The race report, test by test</summary>
... the report `genclass-playwright-report` prints, with each evidence line ...
</details>

---

<sub>genclass[bot] read 4 race files from the artifact `genclass-races` of this pull request's workflow run, never your source code. ...</sub>
```

The check on the commit carries the same table as its summary and the whole race report on its page. By default it is
neutral with findings and green with none; it fails only if you ask it to (`check.fail_on`).

## What the lines mean

- **A finding** is one signature in one test: a trigger, a diagnosis and an operation, such as `request:duplicate` on
  `POST /api/orders`. Its number is given once and never changes, so `@genclass fix 2` means the same finding after
  the next push.
- **Where it comes from.** With the fixture's default (`model: "skip"`) the files carry *witnesses*: happens-before
  facts the runtime measured without its model. `overwrote-newer`: a response wrote a field over what a newer request
  or the user had written since. `identical-in-flight`: two identical requests in flight together from separate user
  actions. With `model: "load"` they also carry the on-device model's diagnoses (duplicate, stale, failing and
  others) with its confidence.
- **Reproducible** means flagged in `min_seeds` or more seeds of the same test (2 by default). A signature seen in
  fewer seeds may depend on that seed's timing: run more seeds before acting on it.
- **Status**, from push to push: *New* (first seen at this commit), *Still flagged*, *Not flagged now* (its test ran
  at this commit without it), *Test not in this run*.
- **"Not flagged now" is not "fixed".** The app never says fixed. A replay that reproduced the finding before your
  change and does not after it is the evidence of a fix, and that happens on your machine or in your CI
  ([Fix with a coding agent](#fix)).
- **Each line is a diagnosis or a measured fact, not a verdict.** Some overwrites are intended, and many are repaired
  a moment later. Whether a line is a bug is for you to decide. If the app flags correct code, tell us with the
  [false flag form](https://github.com/genclass-dev/GenClass/issues/new/choose).
- **Nothing is inferred from your diff.** The app does not read file contents and makes no guess about code.

## Commands

Each on a line of its own, in a comment on the pull request:

| Command | What it does | Who may use it |
|---|---|---|
| `@genclass review` | Reads this commit's race files again and updates the check and the comment. | write access, or the pull request's author |
| `@genclass replay <n>` | Replies with the steps to reproduce finding n on your machine. | write access, or the author |
| `@genclass fix <n>` | Replies with a brief a coding agent can work from ([below](#fix)). Never for a pull request from a fork. | write access |
| `@genclass issue <n>` | Opens an issue for finding n. | write access |
| `@genclass pause` / `resume` | Stops and starts updates on this pull request. | write access |
| `@genclass help` | Lists the commands. | write access, or the author |

"Write access" is what GitHub says about the commenter at that moment. The app adds an eyes reaction to a command it
took.
It never answers a bot, a comment that only mentions it in a sentence, a quoted line or a code block, and it says
nothing at all to someone who may not use a command.

## Settings

Optional: `.github/genclass.yml` on the repository's **default branch**. It is never read from a pull request, so a
pull request cannot change how it is reviewed. These are the defaults:

```yaml
reviews:
  auto: true            # review each pull request when it opens and on every push
  drafts: false         # also review drafts
  branches: []          # only pull requests into these base branches ("release/*"); empty: all
  ignore_authors: []    # logins whose pull requests are not reviewed, e.g. "dependabot[bot]"
comment: findings       # findings: one comment, only when something is flagged | always | never
check:
  enabled: true
  fail_on: never        # never | reproducible | any
inline: true            # a comment on the test's line when the diff shows that line
min_seeds: 2            # seeds a signature must be flagged in to count as reproducible (1 to 10)
artifact: genclass      # artifacts whose name starts with this are read
production:
  enabled: true         # with a linked GenClass app: its findings on the pages this pull request touches
  days: 7               # 1, 7 or 30
commands: true          # the @genclass commands
issues: never           # never | merge: open an issue when a pull request merges with reproducible findings
```

`reviews: false`, `check: false` and `production: false` are short forms. A mistake in the file never stops a review:
the default stands in and the check lists what was wrong. The file is a small subset of YAML (mappings, lists,
strings, numbers, true and false; no anchors, tags or multi-line strings).

With `check.fail_on` set, the check stays "in progress" on a new commit until its test run finishes, so a required
check cannot pass before the race files arrive. A commit that starts no workflow at all keeps waiting;
`@genclass review` ends the wait with what there is.

## Production findings

Reviews from race files need no account. If the app's runtime also runs in your deployed app, link the repository to
that GenClass app and reviews add a section: that app's findings in the last days on the pages the pull request's
changed files serve.

1. Sign in at <https://genclass.dev/account/github> and choose **Connect GitHub**. GitHub tells GenClass which
   installations of the app and which repositories you can reach. Your GitHub token is used for that question and not
   kept; the answer is kept for 30 minutes.
2. Pick the GenClass app for a repository. You need write access to the repository and the app must be in your
   account.

What appears on the pull request is the kind of each finding, the page route and a count. On a public repository,
everyone who can see the pull request sees them. Changed files are matched to pages by path alone, for Next.js (app
and pages routers), SvelteKit, Nuxt, Astro and Remix or React Router file routes; a pull request that touches no route
file says so and lists nothing. The findings were seen before the pull request: they say where the change lands, not
that it caused them.

<a id="fix"></a>

## Fix with a coding agent

`@genclass fix <n>` replies with a brief: what was seen, the command that runs the test under the same seeds, and the
steps for an agent with [`@genclass/mcp`](../../packages/mcp/README.md): reproduce it (`genclass_explore`,
`genclass_explain`), fix the cause, prove it by replay (`genclass_replay`: "not reproduced" after "reproduced"), add
the regression test `genclass_explain` prints, push. The next review says whether the finding is still flagged.

Two ways to use it:

- **On your machine.** Paste the brief into Claude Code (or another MCP client) in a checkout of the branch with your
  dev server running.
- **In your CI.** [`workflows/genclass-fix.yml`](workflows/genclass-fix.yml) is a starting point: it runs when
  genclass[bot] posts a brief and hands it to [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
  with `@genclass/mcp` configured, with your own API key. The agent pushes to the pull request's branch. It has not
  been run against a real repository yet: read it, and adapt how it starts your app.

The app itself never writes code: it has no access to repository contents. What limits the CI path:

- The app writes a brief only when GitHub says the person asking has write access, and never for a pull request from
  a fork: a workflow started from a comment runs with your repository's secrets, and would be running the fork's code.
- The brief's JSON block holds text recorded from a test run (test titles, operations). It says so, and the workflow's
  prompt tells the agent to treat it as data. Still, review what an agent pushes like any other change.
- `claude-code-action` refuses comments from bots unless they are listed in `allowed_bots`. The workflow lists
  `genclass` and checks the comment's author and marker.

## What it may read and write

| Permission | Why |
|---|---|
| Pull requests: read and write | The list of files a pull request changes (their paths and which lines the diff shows), and its own comments. |
| Checks: write | The GenClass check on each commit. |
| Actions: read | The workflow runs of a pull request's head commit, and the artifact with the race files. |
| Issues: read and write | GitHub delivers pull-request comments (the commands) under this permission. The app reacts to a command, and opens an issue only when a setting or a person with write access asks. |
| Single file: read, `.github/genclass.yml` | Your settings. |
| Metadata: read | Required by GitHub for every app. |

It does not ask for repository contents. It cannot read, clone or change your code, branches, workflows, secrets or
settings, and it never opens a pull request. Events it receives: pull requests, pull-request and issue comments,
workflow runs, check runs (its own "Re-run"), and installs and uninstalls.

## What it keeps

- For an installation: the GitHub account's id and name, whether all or selected repositories, and the GenClass
  account that manages it, if one connected.
- For a repository: its id, name and visibility, only when it is linked to a GenClass app or paused.
- For a pull request: the ids of the app's comment and check, the head commit, and per finding a fingerprint (a
  hash), its group, operation, test title and seeds: what is in the comment already. 30 days after it closes, the row
  is deleted.
- Webhook delivery ids, for a week, so that one delivery is handled once.
- Never: source code, diffs, file contents, race files or tokens. An artifact is read in memory and dropped; the
  installation token lives in memory for under an hour; your GitHub token from Connect is used once.

Uninstalling the app, or taking a repository out of it, deletes what was kept for it at once.
[PRIVACY.md](../../PRIVACY.md#the-github-app) is the policy.

## Plans

- **Public repositories: free**, for every account and organization, with no limit on repositories or pull requests
  other than the [limits](#limits) below.
- **Private repositories: the Enterprise plan**, by agreement (mehar@daybot.ca), until a paid plan is offered on
  GitHub Marketplace. Without it a private repository is not read at all: its pull requests get one neutral check that
  says so, and no comment.

## Limits

| | |
|---|---|
| Reviews per installation | 120 an hour |
| Reviews per pull request | 400 in all |
| Artifacts read per review | 6, each at most 4 MB (12 MB in all) |
| Race files read per review | 600, each at most 256 KB |
| Workflow runs looked at per commit | the 8 newest |
| Findings remembered per pull request | 100 |
| Comment and check size | 60,000 characters; a longer report is shortened and says so |
| Settings file | 16 KB |

When GitHub's own rate limit for the installation is used up, the app stops until the time GitHub names and picks the
pull request up again at its next event.

## Security

- Every webhook is checked against the app's secret before anything is parsed, and a delivery is handled once.
- Race files are untrusted input, most of all from forks. They are read under the limits above, only `.json` entries,
  each through the format's validator; nothing in them is executed or fetched. Text from them is escaped before it is
  shown, so it cannot become markup, a link, an `@mention` or an issue reference.
- The installation token is asked for one repository at a time, and the address GitHub gives for an artifact is
  fetched without any credential.
- Report a vulnerability privately: [SECURITY.md](../../SECURITY.md).

## Troubleshooting

- **"No race files for this commit".** No artifact whose name starts with `genclass` was uploaded by a workflow run on
  that commit. Check the upload step ran (`if: ${{ !cancelled() }}`) and that `test-results/genclass` has files:
  `npx genclass-playwright-report` prints the same report locally.
- **The check stays "Waiting for this commit's test run".** A workflow run on the commit has not finished, or GitHub's
  rate limit was hit. `@genclass review` reads again.
- **No comment.** The default posts one only when something is flagged (`comment: always` changes that).
- **A private repository shows "Private repositories need a plan".** See [Plans](#plans).
- **Settings do not apply.** The file must be on the default branch; the check lists any mistake in it. Changes are
  picked up within two minutes.

## Uninstall

Uninstall the app in your GitHub settings (Applications, Installed GitHub Apps). GenClass deletes everything it kept
for the installation when GitHub tells it, at once. Its comments and checks stay on your pull requests; they are yours
to delete.
