# genclass-dev[bot]: setup for whoever runs it

What has to happen, in order, before the GitHub App reviews its first pull request, and how to run it afterwards. The
code is in [`telemetry-worker/src/github/`](../../telemetry-worker/src/github/); it is part of the collector worker and
stays off until its secrets are set. Users' guide: [README.md](README.md). Design: [DESIGN.md](DESIGN.md).

Nothing in this repository registers, deploys, lists or announces the app by itself. Every step below is done by the
owner, by hand.

## Before anything else

Three things decide whether the app can launch as described. None of them can be done from this repository.

1. **The name (settled 2026-11-09).** The app is registered as "GenClass.dev" for the organization `genclass-dev`
   (app id 5691603): its URL name is `genclass-dev`, its page <https://github.com/apps/genclass-dev>, its bot
   `genclass-dev[bot]`. "GenClass" alone was not possible: GitHub refuses an app name that matches an account that is
   not yours, and `github.com/genclass` is someone else's (created 2024-06-01). `genclass-dev` is the organization's
   own login, which GitHub allows for an app the organization owns, so nobody else can take the name people type.
   Commands are `@genclass-dev review` or the short form `/genclass review`. Never document `@genclass`: that
   mention notifies the other account. The worker reads the name from `GITHUB_APP_SLUG`.
2. **`@genclass/playwright` on npm (done 2026-11-10).** The app reads the files that package's fixture writes.
   0.1.0 was published once by the owner from the tarball the release run built (`release-playwright.yml`, tag
   `playwright-v0.1.0`; the `npm-publish` environment needed the tag rule `playwright-v*`). Later versions publish
   from that workflow: trusted publishing is set for it on npm since the same day (`npm trust github`, npm 11:
   repository genclass-dev/GenClass, file `release-playwright.yml`, environment `npm-publish`).
3. **The public commitment about automated reports** ([issue 173](https://github.com/genclass-dev/GenClass/issues/173)).
   The app only ever acts where someone installed it, so it is not what that issue is about. Announcing it is: see
   [the launch notes](#launch-notes).

## 1. Register the app

```bash
node scripts/github-app-setup.mjs --org genclass-dev
```

The script serves one page on 127.0.0.1 that posts the app's manifest
([`telemetry-worker/github-app.manifest.json`](../../telemetry-worker/github-app.manifest.json)) to GitHub. In the
browser, signed in as an owner of the organization, confirm the name. GitHub sends the browser back to the script,
which exchanges the code for the app's id and secrets and writes them to
`telemetry-worker/.github-app.secrets.json` (mode 0600, ignored by git). It prints no secret and shows none in the
browser. `--print-manifest` prints what it would send and stops.

By hand instead (GitHub, Settings, Developer settings, GitHub Apps, New GitHub App), the same values:

| Field | Value |
|---|---|
| Homepage URL | `https://genclass.dev/github` |
| Callback URL | `https://genclass.dev/github/callback` |
| Request user authorization (OAuth) during installation | off |
| Setup URL | `https://genclass.dev/github/setup` (redirect on update: off) |
| Webhook URL | `https://genclass.dev/api/github/webhook`, active, with a secret of 32 random bytes |
| Repository permissions | Actions: read. Checks: read and write. Issues: read and write. Metadata: read. Pull requests: read and write. Single file: read, path `.github/genclass.yml` |
| Subscribe to events | Pull request, Issue comment, Workflow run (Check run comes with the Checks permission) |
| Where can this app be installed | Any account |

Then generate a private key and a client secret on the app's page.

## 2. The one permission the manifest cannot carry

The manifest flow has no field for a single file's path. On the app's page, Permissions and events, Repository
permissions, **Single file**: Read-only, path `.github/genclass.yml`. Save.

Without it the app cannot read anyone's settings file and every repository gets the defaults. Reviews still work.
Adding the permission later asks every installation to accept it; do it before the first install.

## 3. Secrets

From `telemetry-worker/`:

```bash
npx --yes wrangler@4 secret bulk .github-app.secrets.json
```

```bash
rm .github-app.secrets.json
```

| Secret | What |
|---|---|
| `GITHUB_APP_ID` | the app's numeric id |
| `GITHUB_APP_PRIVATE_KEY` | the PEM GitHub generated, as it is (PKCS#1; a PKCS#8 key works too) |
| `GITHUB_APP_WEBHOOK_SECRET` | what the app's webhook is signed with |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | for Connect GitHub on `/account/github`; reviews work without them |
| `GITHUB_MARKETPLACE_WEBHOOK_SECRET` | the Marketplace listing's own webhook secret. Not needed before the listing exists; once it does, set it to a value of its own (unset, the listing's endpoint accepts the app's secret) |

These are not `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, which belong to the OAuth app behind "Sign in with
GitHub". If the app's URL name is not `genclass-dev`, set `GITHUB_APP_SLUG` in `wrangler.toml`.

## 4. The tables

Migration `0013_github_app.sql` adds seven tables and changes none. As for every migration, look before applying (an
earlier migration was once left unapplied):

```bash
CLOUDFLARE_ACCOUNT_ID=144bd5f5270b51dbe7faf46227a154f0 npx --yes wrangler@4 d1 migrations list genclass-dashboard --remote
```

```bash
CLOUDFLARE_ACCOUNT_ID=144bd5f5270b51dbe7faf46227a154f0 npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
```

The worker tolerates the other order too: with the tables missing, the app's own routes fail and nothing else does
(project and account deletion, and the daily sweep, run their GitHub cleanup separately).

## 5. Deploy

`wrangler.toml` gained one route, `genclass.dev/github*`, three vars (`GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_REPOS`
and `GITHUB_APP_WORKFLOW_LINK`, which is [step 7](#7-the-link-that-adds-the-workflow-file)) and a second cron trigger,
`*/20 * * * *`.

The second trigger runs the app's sweep and nothing else: every 20 minutes it reviews the pull requests whose review
has been owed for more than an hour (a job that failed or was stopped, an hourly limit, a check that waits), at most
20 in one run, the longest owed first. A run ends at the first failure that is not GitHub's answer (the database, a
limit of the platform on one invocation); what it did not look at stays owed for the next run. The daily trigger
(`17 3 * * *`) does everything it did before, the same sweep included, so a worker deployed without the second
trigger still finishes every check, within a day instead of within about an hour and a half. `scheduled` in
`src/index.ts` tells the two apart by the trigger's expression.

The checks the app writes link to `docs/github-app/README.md` on the `main` branch of this repository. Merge this
branch to `main` before deploying: until the file is there, those links answer 404.

```bash
npx --yes wrangler@4 deploy
```

## 6. First run

1. `https://genclass.dev/github` shows the app's page; `https://genclass.dev/github/install` goes to GitHub.
2. On the app's page on GitHub, Advanced, Recent deliveries: redeliver the `ping`. It must answer 202
   `{"ok":true,"queued":true}` (the worker answers first and works afterwards). A 401 means the webhook secret on
   GitHub and in the worker differ; a 503 means a secret is missing.
3. Install the app on one repository of your own that has Playwright tests with the fixture and the upload step
   ([README.md](README.md), "Setup").
4. Open a pull request there. Expect, in order: the GenClass check, skipped, "No race files to read yet" (written once
   per repository, and only on an installation for selected repositories; on one for all repositories there is no
   check yet); when the test run finishes, the same check with the findings, and the comment if anything was flagged.
   From then on a pull request without race files gets "No race files for this commit", neutral.
5. Comment `@genclass-dev help`. Expect an eyes reaction and one reply.
6. Sign in at `https://genclass.dev/account/github`, Connect GitHub, link the repository to an app, push again. Expect
   the "In production" section when the pull request changes a route file.
7. Uninstall. `SELECT COUNT(*) FROM github_installations` is 0 again.

What has been verified so far.

Against GitHub itself (2026-11-10), with the app installed on this organization and its webhook pointed at a
no-traffic preview version of the worker (`wrangler versions upload --preview-alias`), on
[pull request 177](https://github.com/genclass-dev/GenClass/pull/177):

- GitHub's own deliveries (`installation`, `workflow_run`, `pull_request`, `issue_comment`) passed the signature
  check and answered 202;
- the app's token, signed by the worker with the PKCS#1 key, was accepted;
- a draft pull request was left alone; marked ready, it was reviewed from the artifact `genclass-races` that this
  repository's own workflow run uploaded (15 race files): one check, neutral, "1 finding, 1 reproducible", and one
  comment with the witness on `GET /api/search` that the e2e app plants on purpose;
- `/genclass replay 1` from someone with write access got the eyes reaction and one reply.

Since then, on production (2026-11-10): the app was made public; pull request 178 was reviewed from two artifacts,
one of them written by an unmodified suite through `genclass-playwright-run`; and the form on `/github/setup` opened
GitHub's new-file editor with the workflow file filled in.

Not yet run against GitHub: Connect GitHub and Continue with GitHub (the button on `/github/setup`, which signs a
person in through the app's own OAuth client), a pull request from a fork, a private repository, `issues: merge`, the
fix workflow, a rate limit.

Without GitHub:

- the test suite (`telemetry-worker/test/github*.test.ts`): signed deliveries through the real handler against a
  fake GitHub, with the real migrations under `node:sqlite`;
- `node telemetry-worker/test/e2e/github.e2e.mjs`: the same flow in the Workers runtime (`wrangler dev --local`,
  local D1) against a stand-in for GitHub on 127.0.0.1: the app's token signed with a PKCS#1 key, an artifact
  unzipped, the check and the comment written once, a command answered, the rows gone after an uninstall. It writes
  only to a temporary directory and calls nothing on the internet;
- the three pages, opened in a browser against that local worker at desktop and phone widths, with a repository
  linked and paused from `/account/github`.

## 7. The link that adds the workflow file

A repository can give the app something to read with one file, [`workflows/genclass.yml`](workflows/genclass.yml),
and no change to its tests. The var `GITHUB_APP_WORKFLOW_LINK` in `wrangler.toml` makes adding that file a review and
a commit.

- `"on"`: the check that has no race files to read ("No race files to read yet" and "No race files for this commit")
  carries one sentence with a link, and `/github/setup` has a small form (repository, branch) with a button. Both open
  GitHub's own new-file editor with `.github/workflows/genclass.yml` and the file's text filled in. The person reads
  it and commits it on GitHub, as themselves. The app writes nothing to the repository and asks for no new
  permission.
- Anything else, and unset: off. No check carries the link, every text the app writes on GitHub is what it is without
  the setting, and `/github/setup` says to copy the file from this repository.

It is `"off"` in `wrangler.toml` and stays off until the first version of `@genclass/playwright` is on npm. The
workflow installs that package from npm, so before it is published the job fails at its install step. After
publishing, set the var to `"on"` and deploy. The checks that have nothing to read then get the new text at the next
review of their pull request.

What to know before turning it on:

- The address is `https://github.com/OWNER/REPO/new/BRANCH?filename=.github/workflows/genclass.yml&value=TEXT`, with
  the text percent-encoded (checked on github.com on 2026-11-10, signed in). `BRANCH` must be a branch that exists:
  the literal `HEAD` answers 404. The check uses the repository's default branch as GitHub names it, in the pull
  request GitHub returns or else in the event's signed payload. When neither names one, the check has no link.
- GitHub answers an address of about 6,000 characters with an error. The file is 2,495 characters and 3,935
  percent-encoded, and the whole address for a short repository name is 4,023. The worker builds no address longer
  than 5,800: if the file grows past that, the checks say what they say without the link.
- The file's text is in two places: `docs/github-app/workflows/genclass.yml`, which is the source, and
  `WORKFLOW_FILE` in `telemetry-worker/src/github/workflow-file.ts`. `test/github-workflow.test.ts` fails when they
  differ and says how to bring them back in step. A change to the file reaches the link with the next deploy.
- A repository whose settings read artifacts under another name gets no link (`artifact` is not the start of
  `genclass-races`, the name the file uploads under): the file would upload something the app does not read there.
- The link is in the check and on `/github/setup` only, never in a comment, a reply or an issue.
- On a GitHub Enterprise Server the address starts with `GITHUB_WEB_URL`.
- Tested against a fake GitHub only (`test/github-workflow.test.ts`). The address was opened by hand on github.com; a
  check that carries it has not been written to GitHub yet, and the form on `/github/setup` has not been used in a
  browser. After turning it on, open the check on a pull request of a repository without race files, follow the
  link, and see that the editor opens with the file filled in. Do the same once from `/github/setup`.

Checked on github.com on 2026-11-10, signed in: the address the worker builds for this repository (4,035 characters)
opens the new-file editor at `.github/workflows/genclass.yml` on `main` with the whole file filled in
([the screenshot](media/one-click-workflow.jpg)). Nothing was committed from it.

## Try it without touching production

A second app, private to you, whose webhook points at a tunnel to `wrangler dev`:

```bash
npx --yes wrangler@4 dev --local --local-upstream localhost:8787
```

```bash
node scripts/github-app-setup.mjs --name "GenClass.dev (test)" --private --origin https://<your tunnel host>
```

Put the values from `.github-app.secrets.json` into `.dev.vars` (`.dev.vars.example` lists the names), with
`GITHUB_APP_SLUG` set to the test app's URL name and `GITHUB_APP_PRIVATE_REPOS=open`, then
`npx --yes wrangler@4 d1 migrations apply genclass-dashboard --local`. Connect GitHub needs `AUTH_ORIGIN` to be the
tunnel's origin, because GitHub sends the browser back to the callback URL in the manifest.

## Running it

- **Turn it off.** Delete the `GITHUB_APP_ID` secret (`wrangler secret delete GITHUB_APP_ID`): the webhook answers 503
  and the pages are gone, at once. Or suspend installations from the app's page on GitHub.
- **Stop one repository.** Its owner can pause it on `/account/github` or with `@genclass-dev pause` on a pull request. By
  hand: `UPDATE github_repos SET paused = 1 WHERE full_name = '<owner/name>'` (insert the row if there is none).
- **Take a repository's link to an app away.** Someone with write access to the repository can on `/account/github`,
  and so can the account that owns the linked app, with or without access to the repository. By hand:
  `UPDATE github_repos SET project_id = NULL, linked_by = NULL, linked = NULL WHERE repo_id = ?`.
- **A delivery failed.** GitHub does not retry. The app forgets a delivery whose job failed, so Redeliver on the app's
  Advanced page runs it again; a delivery whose job ended is not run twice. A job stops itself 20 seconds after its
  delivery arrived (the platform stops work 30 seconds after the response): that is logged as `deadline`, and the
  delivery can be redelivered. A delivery whose job the platform stopped anyway, with no log line, can be redelivered
  a minute after it arrived. Without a redelivery, the pull request is reviewed at its next event, or by the sweep
  (the worker's 20-minute cron trigger, and the daily one), which reviews pull requests whose review has been owed
  for more than an hour, at most 20 in one run; that is also what finishes a check left in progress. The only thing
  logged is one line per failed delivery: the event's
  name and one word for the reason (`npx --yes wrangler@4 tail` shows it live; for a private key the worker cannot
  use, the line also says what is wrong with it, never the key).
- **Rotate the private key.** Generate a new key on the app's page, `wrangler secret put GITHUB_APP_PRIVATE_KEY`, then
  delete the old key on GitHub. Tokens in flight keep working for up to an hour.
- **Rotate the webhook secret.** GitHub has one secret at a time: set it on GitHub and in the worker together, then
  redeliver what failed in between.
- **Rate limits.** The app stops calling GitHub for an installation until the time GitHub names. Its own caps
  (`src/github/store.ts`): 120 reviews an hour per installation that read a commit's race files (90 of them started by
  pushes, 60 for pull requests by authors from outside the repository), 30 reviews an hour per pull request, and 400
  reviews or replies written per pull request in all. A check or a reply about an hourly cap names the cap that
  stopped the review, with its own number.
- **A request to delete data.** Uninstalling deletes everything kept for an installation. For one repository:
  `DELETE FROM github_prs WHERE repo_id = ?`, `DELETE FROM github_repos WHERE repo_id = ?` and
  `DELETE FROM github_repo_facts WHERE repo_id = ?`.

## Plans and private repositories

- Public repositories are always reviewed. Nothing in the configuration can turn that off.
- Production runs with `GITHUB_APP_PRIVATE_REPOS = "open"` since 2026-11-10 (the owner's decision): private
  repositories are reviewed too, free, while the app is new. The rest of this section is what "plan" does, for a paid
  plan later or a self-hosted collector.
- `GITHUB_APP_PRIVATE_REPOS = "plan"` (the default) reviews a private repository only when the GenClass account
  managing the installation has a plan with `github_private` (`billing/plans.json`: Enterprise, so a grant by
  `comp_until` is how an agreement is switched on), or the GitHub account has a paid plan on GitHub Marketplace.
- The account managing an installation is `github_installations.owner`. For an installation on a person's own GitHub
  account, the worker sets it when that person uses Connect GitHub (or Continue with GitHub on `/github/setup`): GitHub says who they are, and the installation is
  on that account. For an organization the worker never sets it. GitHub answers who administers an organization only
  to an app with the organization permission "Members" (`GET /user/memberships/orgs/{org}`), which this app does not
  ask for, and being able to push to one of the organization's repositories proves nothing about the organization.
  Set it by hand when the agreement is made, with the id of the organization's GenClass account (`accounts.id`) and
  the installation's id (`github_installations.id`, also in the address of the installation's page on GitHub):
  `npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE github_installations SET owner = '<accounts.id>' WHERE id = <installation id>"`.
  `owner = NULL` takes it away again.
- Connect GitHub never takes an installation from an account whose plan has `github_private` for one whose plan has
  not, so an account set by hand stays.
- `GITHUB_APP_PRIVATE_REPOS = "open"` reviews every repository: for a beta, or a self-hosted collector.
- The two lines added to `billing/plans.json` are marked `available: false`, so the pricing page shows them as coming
  next. Set them to `true` when the app is live.

## GitHub Marketplace

The listing draft, GitHub's requirements and what is still missing are in
[`docs/adoption/listings/github-marketplace.md`](../adoption/listings/github-marketplace.md). In short: a free listing
needs the app to be public, a logo and screenshots, links to a privacy policy and to support, and a listing webhook
(`https://genclass.dev/api/github/marketplace`). A paid plan needs a verified publisher and 100 installations first.

In the listing's webhook form, choose **Content type: application/json**. The form's other choice,
`application/x-www-form-urlencoded`, sends the same JSON in a form field named `payload`; the worker reads that too,
after the same signature check, and only when the body is exactly that one field (anything else answers 400). GitHub
does not send a Marketplace delivery again, so look at the listing's first delivery (the ping) in its delivery list:
the answer must be 202. A 401 means the secret differs, a 400 that the body could not be read.

Set `GITHUB_MARKETPLACE_WEBHOOK_SECRET` to a value of its own when the listing exists: a new secret in the listing's
webhook form, and the same value with `wrangler secret put GITHUB_MARKETPLACE_WEBHOOK_SECRET`. While it is unset, the
listing's endpoint accepts deliveries signed with the app's own webhook secret. That endpoint is the one that records
a paid plan, so it should not share a secret with the webhook that carries text written by anyone who can comment.

## A self-hosted collector, GitHub Enterprise Server

The same worker on someone's own Cloudflare account (`wrangler.selfhost.toml`) can run an app of its own: register it
with `--origin https://<their worker>` and set the same secrets there. Its configuration has the daily cron trigger
only, which runs the app's sweep once a day; adding `"*/20 * * * *"` to `crons` there runs it every 20 minutes.
`GITHUB_API_URL` and `GITHUB_WEB_URL` point the app at a GitHub Enterprise Server (`https://HOST/api/v3` and
`https://HOST`). Neither has been run.

<a id="launch-notes"></a>

## Launch notes

- The app's reach is the people who install it. It never comments, opens issues or opens pull requests anywhere else,
  and nothing in this repository contacts maintainers. See [DESIGN.md](DESIGN.md), "Growth without outreach".
- Before telling anyone: the three items at the top, the first run above on a real repository, and the follow-up
  promised in issue 173.
- The first users should be repositories that already use the fixture. Their own pull requests are the demonstration.

## Not built

- A paid plan on GitHub Marketplace (the plan events are stored; no plan is defined on GitHub).
- A review of a preview deployment's URL (the hosted page check is in another repository).
- An MCP tool that reads a pull request's findings (`genclass_pr`): today the brief is pasted, or picked up by the
  workflow.
- Issues from production findings. Issues come from pull-request findings only, on request or with `issues: merge`.
