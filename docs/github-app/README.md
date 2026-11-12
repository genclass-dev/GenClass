# genclass-dev[bot]: the GitHub App

GenClass's GitHub App puts what the GenClass runtime saw on the pull request it was seen in. While your Playwright
tests run, the runtime watches the page under test: a request that left twice, an older response applied over a newer
one, a write that was overwritten. The fixture writes that to small files, your workflow uploads them, and the app
posts one check and one comment with each finding's test, its seeds and the evidence line.

It reads the race files your workflow uploads, never your source code. It is free on public repositories; private
repositories come with the Team plan ([Plans](#plans)).

- Install: <https://genclass.dev/github> (or `https://github.com/apps/genclass-dev/installations/new`)
- Code: [`telemetry-worker/src/github/`](../../telemetry-worker/src/github/)
- For whoever runs the app: [SETUP.md](SETUP.md). How it is built and why: [DESIGN.md](DESIGN.md).

> **Status (2026-11-10):** live. The app is GenClass.dev, anyone can install it, and `@genclass/playwright` 0.1.0 is
> on npm. Its first reviews were on this repository's own pull requests
> ([177](https://github.com/genclass-dev/GenClass/pull/177)). [SETUP.md](SETUP.md) says what has been run against
> GitHub and what has not yet.

## Setup

1. **Install the app** on the account or organization, for all repositories or the ones you pick. Nothing else is
   asked: no sign-up, no token.

   Then give it something to read, one of two ways. **With no change to your tests:** copy
   [`workflows/genclass.yml`](workflows/genclass.yml) to `.github/workflows/genclass.yml` and go to step 4. It runs
   your existing Playwright suite under GenClass in a job of its own that is allowed to fail, and uploads the race
   files ([how it works and what it does not cover](../../packages/playwright/README.md#without-changing-your-tests)).
   When the server that runs the app has it turned on, the check on a repository's first pull request has a link that
   opens GitHub's new-file editor with that file filled in, so you only review it and commit it.
   **Or in your own e2e job,** steps 2 and 3.

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

4. **Open a pull request.** When its test run has uploaded race files, the GenClass check appears on the commit. When
   something is flagged, the comment below appears, and later pushes edit it in place. Once race files were read for
   a repository, the check is on every commit of every pull request there, with or without race files.

Nothing is written when the app is installed. Reviews start with the first push or comment after that; a pull request
that was already open is picked up on its next push, or when someone comments `@genclass-dev review`.

Until race files were read for a repository once, the app stays silent there: a pull request without race files gets
no check and no comment. There are two exceptions. On an installation for selected repositories, the first pull
request the app sees without race files gets one check, marked skipped, that says what the app reads and how to set it
up; it is written once per repository, and not where `check.fail_on` is set, because a skipped check passes. (An
installation for all repositories gets none: most of its repositories never asked for one.) And
`@genclass-dev review`, or Re-run on the check, always gets an answer.

Race files uploaded for a pull request from a fork review that pull request like any other. They do not switch the
check on for the repository's other pull requests: for that, race files must come from a branch of the repository or
from an author GitHub lists as its owner, member or collaborator.

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

Reply `@genclass-dev replay 1` for the steps to reproduce a finding, or `@genclass-dev fix 1` for a brief a coding agent can work from.

<details><summary>The race report, test by test</summary>
... the report `genclass-playwright-report` prints, with each evidence line ...
</details>

---

<sub>genclass-dev[bot] read 4 race files from the artifact `genclass-races` of this pull request's workflow run, never your source code. ...</sub>
```

The check on the commit carries the same table as its summary and the whole race report on its page. By default it is
neutral with findings and green with none; it fails only if you ask it to (`check.fail_on`). It is green only when
every race file of the commit was read: files that are not race files give "No race file could be read", neutral, and
a commit whose artifacts could be read only in part is neutral too. A result a commit already has is kept when its
race files cannot be read again (an expired artifact, a failed download).

## What the lines mean

- **A finding** is one signature in one test: a trigger, a diagnosis and an operation, such as `request:duplicate` on
  `POST /api/orders`. Its number is given once and never changes, so `@genclass-dev fix 2` means the same finding after
  the next push.
- **Where it comes from.** With the fixture's default (`model: "skip"`) the files carry *witnesses*: happens-before
  facts the runtime measured without its model. `overwrote-newer`: a response wrote a field over what a newer request
  or the user had written since. `identical-in-flight`: two identical requests in flight together from separate user
  actions. With `model: "load"` they also carry the on-device model's diagnoses (duplicate, stale, failing and
  others) with its confidence.
- **Reproducible** means flagged in `min_seeds` or more seeds of the same test (2 by default). A signature seen in
  fewer seeds may depend on that seed's timing: run more seeds before acting on it.
- **Status**, from push to push: *New* (seen for the first time at this commit, or flagged again after a run in which
  it was not), *Still flagged*, *Not flagged now* (its test ran at this commit without it), *Test not in this run*.
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
| `@genclass-dev review` | Reads this commit's race files again and updates the check and the comment. | write access, or the pull request's author |
| `@genclass-dev replay <n>` | Replies with the steps to reproduce finding n on your machine. | write access, or the author |
| `@genclass-dev fix <n>` | Replies with a brief a coding agent can work from ([below](#fix)). Never for a pull request from a fork. | write access |
| `@genclass-dev issue <n>` | Opens an issue for finding n. | write access |
| `@genclass-dev pause` / `resume` | Stops and starts updates on this pull request. `resume` reads the current commit at once. | write access |
| `@genclass-dev help` | Lists the commands. | write access, or the author |

`/genclass` works in place of the mention for every command (`/genclass review`, `/genclass fix 2`), and notifies
nobody. The mention is `@genclass-dev`, the organization that owns the app; `@genclass` without `-dev` is another GitHub
account and is never read as a command.

"Write access" is GitHub's answer when the app asks it for the commenter's permission on the repository, at that
moment: admin, maintain or write. The role GitHub shows next to a comment is not used, so a member whose organization
membership is private can use every command, and a member who can only read cannot. A `review` from the pull
request's author without write access reads the commit again; it does not lift a pause on the pull request or
`reviews.ignore_authors`. The app adds an eyes reaction to a command it took. A `review` that an hourly limit stopped
gets a reply that says so.
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
commands: true          # the @genclass-dev commands
issues: never           # never | merge: open an issue when a pull request merges with reproducible findings
```

`reviews: false`, `check: false` and `production: false` are short forms. A mistake in the file never stops a review:
the default stands in and the check lists what was wrong. The file is a small subset of YAML (mappings, lists,
strings, numbers, true and false; no anchors, tags or multi-line strings).

The defaults apply when the repository has no settings file. When GitHub cannot give the app the file (an outage, a
timeout), the app does not fall back to the defaults: it writes nothing for that event and reads the file again at
the next one, or at the sweep (below).

With `issues: merge`, a pull request that merges gets one issue for the reproducible findings flagged in the race
files of the commit that merged. If that commit's test run was not read before the merge, it is read first; when it
uploaded no race files, no issue is opened. That read follows the `reviews` settings: for a pull request that
`reviews.auto`, `reviews.branches` or `reviews.ignore_authors` leave out, nothing is read at the merge and no issue is
opened. When a pull request merges before the commit's workflow runs exist, or while one of them is still going,
nothing is decided at the merge: the sweep (below) decides, about an hour later, with the race files there are then.
A finding that an issue from the app already lists, open or closed, is not filed again: one finding gets one issue,
however many pull requests merge with it. When two pull requests merge at the same moment, one is decided at once and
the other by the sweep. A paused pull request or repository gets none. `@genclass-dev issue <n>` opens one on request.

With `check.fail_on` set, and once race files were read for the repository, the check stays "in progress" on a new
commit until its test run finishes, so a required check cannot pass before the race files arrive. A check in progress
is always finished. The commit's last workflow run to finish ends the wait. `@genclass-dev review` and the sweep end
it with what there is only when no workflow run of the commit is still going (a commit that started no workflow at
all); while a run is still going, the check waits for it. GitHub offers no Re-run on a check that is in progress, so
Re-run is for a check that is completed. When the pull request is paused or converted to a draft, the check ends
neutral at once and says why, and a setting that leaves the pull request out does the same at its next event; when it
is closed, or a newer commit is pushed, the old commit's check ends cancelled. When an hourly limit is reached the
check stays in progress and says which limit.

Also with `check.fail_on` set: when some of a commit's race files could not be read the first time (an artifact that
could not be downloaded, or one that has expired) and what was read does not fail the check, the check gives no
result from the part. It stays in progress as "Not all race files could be read yet" and says what was not read.
`@genclass-dev review`, or the sweep, then ends it with what can be read: a failure if that fails the check, neutral
otherwise, never a success.

The sweep runs every 20 minutes. It reviews the pull requests whose review has been owed for more than an hour: a
commit that starts no workflow at all, a review that failed or that an hourly limit stopped, a check that waits. It
ends such a wait with what there is.

## Production findings

Reviews from race files need no account. If the app's runtime also runs in your deployed app, link the repository to
that GenClass app and reviews add a section: that app's findings in the last days on the pages the pull request's
changed files serve.

1. Sign in at <https://genclass.dev/account/github> and choose **Connect GitHub**. GitHub tells GenClass which
   installations of the app and which repositories you can reach. Your GitHub token is used for that question and not
   kept; the answer is kept for 30 minutes.
2. Pick the GenClass app for a repository. You need write access to the repository and the app must be in your
   account.

Taking a link away needs less: the account that owns the linked app can always do it, also after it lost write access
to the repository. The page lists the repositories linked to one of your apps that GitHub's answer does not list (this
page has not asked GitHub in the last 30 minutes, or you can no longer reach them), each with **Unlink**; a private
one is listed without its name.

What appears on the pull request is the kind of each finding, the page route and a count. On a public repository,
everyone who can see the pull request sees them. Changed files are matched to pages by path alone, for Next.js (app
and pages routers), SvelteKit, Nuxt, Astro and Remix or React Router file routes; a pull request that touches no route
file says so and lists nothing. The findings were seen before the pull request: they say where the change lands, not
that it caused them.

<a id="fix"></a>

## Fix with a coding agent

`@genclass-dev fix <n>` replies with a brief: what was seen, the command that runs the test under the same seeds, and the
steps for an agent with [`@genclass/mcp`](../../packages/mcp/README.md): reproduce it (`genclass_explore`,
`genclass_explain`), fix the cause, prove it by replay (`genclass_replay`: "not reproduced" after "reproduced"), add
the regression test `genclass_explain` prints, push. The next review says whether the finding is still flagged.

Two ways to use it:

- **On your machine.** Paste the brief into Claude Code (or another MCP client) in a checkout of the branch with your
  dev server running.
- **In your CI.** [`workflows/genclass-fix.yml`](workflows/genclass-fix.yml) is a starting point: it runs when
  genclass-dev[bot] posts a brief and hands it to [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
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
| Issues: read and write | GitHub delivers pull-request comments (the commands) under this permission. The app reacts to a command, and opens an issue only when a setting or a person with write access asks. Before it opens one for `issues: merge` it lists the issues it opened itself, so that no finding is filed twice. |
| Single file: read, `.github/genclass.yml` | Your settings. |
| Metadata: read | Required by GitHub for every app. With it the app asks what permission a commenter has on the repository before it takes a command. |

It does not ask for repository contents. It cannot read, clone or change your code, branches, workflows, secrets or
settings, and it never opens a pull request. Events it receives: pull requests, pull-request and issue comments,
workflow runs, check runs (its own "Re-run"), and installs and uninstalls.

## What it keeps

- For an installation: the GitHub account's id and name, whether all or selected repositories, and the GenClass
  account that manages it, if there is one ([Plans](#plans)).
- For a repository: its id, name and visibility, only when it is linked to a GenClass app or paused. And, by id only,
  when each of three things happened for it, so that none happens twice: race files were first read, the one check
  that says what the app reads was written, the one check that says a private repository needs a plan was written.
  And for a minute at most, that a pull request has the repository's turn to open an issue.
- For a pull request: the ids of the app's comment and check, the head commit, whether it is paused, the number of
  the issue opened for it, and per finding a fingerprint (a hash), its group, operation, test title and seeds: what
  is in the comment already. 30 days after it closes, the row is deleted.
- Webhook delivery ids, for a week, so that one delivery is handled once.
- Never: source code, diffs, file contents, race files or tokens. An artifact is read in memory and dropped; the
  installation token lives in memory for under an hour; your GitHub token from Connect is used once.

Uninstalling the app, or taking a repository out of it, deletes what was kept for it at once.
[PRIVACY.md](../../PRIVACY.md#the-github-app) is the policy.

## Plans

- **Public repositories are free**, for every account and organization, with no limit on repositories or pull
  requests other than the [limits](#limits) below. Nothing in the app can make a public repository need a plan.
- **Private repositories come with Team or Enterprise** (announced here on 2026-11-11; Team is US$15 a developer a
  month, <https://genclass.dev/pricing>). From 2026-11-10 to the day the collector with these plans was deployed the
  app reviewed private repositories for everyone. A private repository without such a plan is not read at all: it
  gets one neutral check that says so, on the first pull request the app sees there, once per repository, and no
  comment.
- **A self-hosted collector** reviews every repository: it sells no plans (`PLAN_GATES = "open"`, or
  `GITHUB_APP_PRIVATE_REPOS = "open"`).
- **Whose plan counts.** The plan that counts for an installation's private repositories is the plan of the GenClass
  account that manages it. An installation on your own GitHub account is managed by the GenClass account you choose
  Connect GitHub from. For an organization, the managing account is set when the plan is agreed: write to
  mehar@genclass.dev. Being able to push to a repository does not make an account the manager of its installation.
  <https://genclass.dev/account/github> shows for each installation whether your account, another account or no
  account manages it.

## Limits

| | |
|---|---|
| Reviews per installation | 120 an hour. Only a review that reads a commit's race files counts. Of them, at most 90 are started by pushes, and at most 60 are for pull requests whose author is not an owner, member or collaborator of the repository |
| Reviews per pull request | 30 an hour; 400 that wrote something, in all |
| One webhook's work | 20 seconds; what is left is picked up at the next event, a redelivery or the sweep |
| Artifacts read per review | 6, each at most 4 MB as a zip (12 MB in all) |
| Race files read per review | 600, each at most 64 KB, and 4 MB in all, unzipped. A file that is started and cannot be read counts too |
| Signatures | 200 in one race file, each listing at most 64 seeds; 2,000 in the race files of one review |
| Text in a race file | 1,000 characters for a test's name, 2,000 for an evidence line, 600 for any other string |
| Workflow runs per commit | The first 100 GitHub lists are looked at. The artifacts of at most 30 finished runs are asked for: the most recently finished first, and one run of every workflow before a second run of any. The workflow of the run whose end started the review is asked first, also when that run is not among the 100. Of two runs of one workflow that uploaded the same artifact name, the one that finished last is read |
| Findings remembered per pull request | 100. A finding that is flagged keeps its number. With more than 100 flagged at once, the rest are counted in the comment and the check ("N more findings flagged at this commit are not listed") and count for `check.fail_on` |
| Comment and check size | 60,000 characters; a longer report is shortened and says so |
| Settings file | 16 KB |

What is over a limit is not read, and the review says so: a race file is listed under "Files skipped" with the reason,
and a note in the check and the comment says what was left out. The limits count for one review as a whole, however
many artifacts the race files come in. `@genclass/playwright`'s fixture writes within the limits for one race file (of
a test with more signatures than fit it leaves out the least confident, and the report says how many), so those stop
only files something else wrote. With more than 30 finished workflow runs on a commit, a note says how many had their
artifacts looked at, when no race file was read or when a workflow had none of its runs looked at. In that second
case the check is neutral, never a success, also when the race files that were read flag nothing: race files may be
in a run that was not asked. On a commit with more than 30 workflows the check therefore cannot be a success.

Whatever was left unread keeps the check from being a success: it is then neutral, or a failure when what was read
fails it. One thing is listed without that effect: a `.json` file over 64 KB whose name is not one the fixture gives
its race files (`<test>-<id>-s<seed>.json`, with `-r<n>` before `.json` for a retry). A repository that uploads more
than `test-results/genclass` under the artifact's name, a reporter's JSON output for instance, sees that file under
"Files skipped" and keeps its green check.

When GitHub's own rate limit for the installation is used up, the app stops until the time GitHub names and picks the
pull request up again at its next event, or at the sweep.

## Security

- Every webhook is checked against the app's secret before anything is parsed, and a delivery is handled once.
- Race files are untrusted input, most of all from forks. They are read under the limits above, only `.json` entries,
  each through the format's validator; nothing in them is executed or fetched. An artifact is unzipped by the app's
  own code, which stops at the size an entry claims, so an archive made to unpack into gigabytes costs what it claims
  and no more. Text from race files is escaped before it is shown, so it cannot become markup, an `@mention`, an issue
  or pull request reference, or a link to a web address: an invisible zero-width space breaks `#` before a number,
  every `@`, `://` and `www.`. An address in a test's name or an evidence line is shown as text, and the address
  of another repository's issue leaves no "mentioned this" there. Operations are shown as code, where GitHub links
  nothing. The title of an issue the app opens is plain text, not markdown: what comes from a race file gets the
  same invisible breaks there.
- The installation token is asked for one repository at a time, and the address GitHub gives for an artifact is
  fetched without any credential.
- Report a vulnerability privately: [SECURITY.md](../../SECURITY.md).

## Troubleshooting

- **"No race files for this commit".** No artifact whose name starts with `genclass` was uploaded by a workflow run on
  that commit. Check the upload step ran (`if: ${{ !cancelled() }}`) and that `test-results/genclass` has files:
  `npx genclass-playwright-report` prints the same report locally.
- **No check at all.** No race file was read for the repository yet, so a pull request without them gets none
  ([Setup](#setup), step 4). That includes an artifact that was uploaded and could not be read. `@genclass-dev review`
  answers with what there is, and says what was wrong with an artifact.
- **The check stays "Waiting for this commit's test run".** A workflow run on the commit has not finished (one that
  waits for an approval or for a runner counts). When the last one finishes without race files, the check says "No
  race files for this commit". While a run is still going, `@genclass-dev review` does not end the wait; on a commit
  that started no workflow at all it does, and so does the sweep.
- **"Hourly review limit reached".** The check names the limit that was reached ([Limits](#limits)): the
  installation's 120 reviews, the 90 of them that pushes may start, the 60 for pull requests by authors from outside
  the repository, or the pull request's 30. Comment `@genclass-dev review` after the hour, or Re-run the check if it
  is completed (a check in progress has no Re-run); the sweep reads the commit otherwise.
- **"Not all race files could be read yet".** `check.fail_on` is set and an artifact of the commit could not be
  downloaded or has expired; the check names it. `@genclass-dev review` ends the check with what can be read, and so
  does the sweep, about an hour later.
- **No comment.** The default posts one only when something is flagged (`comment: always` changes that).
- **A private repository shows "Private repositories need a plan".** See [Plans](#plans).
- **Settings do not apply.** The file must be on the default branch; the check lists any mistake in it. Changes are
  picked up within two minutes.

## Uninstall

Uninstall the app in your GitHub settings (Applications, Installed GitHub Apps). GenClass deletes everything it kept
for the installation when GitHub tells it, at once. Its comments and checks stay on your pull requests; they are yours
to delete.
