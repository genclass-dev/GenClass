# genclass[bot]: setup for whoever runs it

What has to happen, in order, before the GitHub App reviews its first pull request, and how to run it afterwards. The
code is in [`telemetry-worker/src/github/`](../../telemetry-worker/src/github/); it is part of the collector worker and
stays off until its secrets are set. Users' guide: [README.md](README.md). Design: [DESIGN.md](DESIGN.md).

Nothing in this repository registers, deploys, lists or announces the app by itself. Every step below is done by the
owner, by hand.

## Before anything else

Three things decide whether the app can launch as described. None of them can be done from this repository.

1. **The name.** The app is meant to be "GenClass", whose URL name is `genclass` and whose bot is `genclass[bot]`.
   GitHub refuses an app name that matches an existing account's name unless that account is yours, and a user
   account named `GenClass` exists (created 2024-06-01, no public repositories; checked 2026-11-09). If it is not
   yours, the app needs another name. Whatever GitHub turns the name into is what people type: "GenClass Bot" gives
   `genclass-bot`, `genclass-bot[bot]` and `@genclass-bot fix 1`. The worker reads the name from `GITHUB_APP_SLUG`; the
   guide, the two workflow files and the pages say `genclass` and need the same change.
2. **`@genclass/playwright` on npm.** The app reads the files that package's fixture writes. Version 0.1.0 is not
   published. The fixture now also writes where each test is declared (`location`), which inline comments need; the
   first published version must include it.
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
| `GITHUB_MARKETPLACE_WEBHOOK_SECRET` | optional: the Marketplace listing's own webhook secret (default: the app's) |

These are not `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, which belong to the OAuth app behind "Sign in with
GitHub". If the app's URL name is not `genclass`, set `GITHUB_APP_SLUG` in `wrangler.toml`.

## 4. The tables

Migration `0013_github_app.sql` adds six tables and changes none. As for every migration, look before applying (an
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

`wrangler.toml` gained one route, `genclass.dev/github*`, and two vars.

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
4. Open a pull request there. Expect, in order: the GenClass check, neutral, "No race files for this commit"; when the
   test run finishes, the same check with the findings, and the comment if anything was flagged.
5. Comment `@genclass help`. Expect an eyes reaction and one reply.
6. Sign in at `https://genclass.dev/account/github`, Connect GitHub, link the repository to an app, push again. Expect
   the "In production" section when the pull request changes a route file.
7. Uninstall. `SELECT COUNT(*) FROM github_installations` is 0 again.

What has been verified so far (2026-11-09), all without GitHub itself:

- the test suite (`telemetry-worker/test/github*.test.ts`): signed deliveries through the real handler against a
  fake GitHub, with the real migrations under `node:sqlite`;
- `node telemetry-worker/test/e2e/github.e2e.mjs`: the same flow in the Workers runtime (`wrangler dev --local`,
  local D1) against a stand-in for GitHub on 127.0.0.1: the app's token signed with a PKCS#1 key, an artifact
  unzipped, the check and the comment written once, a command answered, the rows gone after an uninstall. It writes
  only to a temporary directory and calls nothing on the internet;
- the three pages, opened in a browser against that local worker at desktop and phone widths, with a repository
  linked and paused from `/account/github`.

No step above has been run against GitHub itself: registering the app, a real webhook, a real artifact download, real
rate limits and Connect GitHub against github.com are first tried at step 1.

## Try it without touching production

A second app, private to you, whose webhook points at a tunnel to `wrangler dev`:

```bash
npx --yes wrangler@4 dev --local --local-upstream localhost:8787
```

```bash
node scripts/github-app-setup.mjs --name "GenClass (test)" --private --origin https://<your tunnel host>
```

Put the values from `.github-app.secrets.json` into `.dev.vars` (`.dev.vars.example` lists the names), with
`GITHUB_APP_SLUG` set to the test app's URL name and `GITHUB_APP_PRIVATE_REPOS=open`, then
`npx --yes wrangler@4 d1 migrations apply genclass-dashboard --local`. Connect GitHub needs `AUTH_ORIGIN` to be the
tunnel's origin, because GitHub sends the browser back to the callback URL in the manifest.

## Running it

- **Turn it off.** Delete the `GITHUB_APP_ID` secret (`wrangler secret delete GITHUB_APP_ID`): the webhook answers 503
  and the pages are gone, at once. Or suspend installations from the app's page on GitHub.
- **Stop one repository.** Its owner can pause it on `/account/github` or with `@genclass pause` on a pull request. By
  hand: `UPDATE github_repos SET paused = 1 WHERE full_name = '<owner/name>'` (insert the row if there is none).
- **A delivery failed.** GitHub does not retry. The app forgets a delivery whose job failed, so Redeliver on the app's
  Advanced page runs it again; a delivery that succeeded is not run twice. The only thing logged is one line per
  failed delivery: the event's name and one word for the reason (`npx --yes wrangler@4 tail` shows it live; for a
  private key the worker cannot use, the line also says what is wrong with it, never the key).
- **Rotate the private key.** Generate a new key on the app's page, `wrangler secret put GITHUB_APP_PRIVATE_KEY`, then
  delete the old key on GitHub. Tokens in flight keep working for up to an hour.
- **Rotate the webhook secret.** GitHub has one secret at a time: set it on GitHub and in the worker together, then
  redeliver what failed in between.
- **Rate limits.** The app stops calling GitHub for an installation until the time GitHub names. 120 reviews an hour
  per installation and 400 per pull request are its own caps (`src/github/store.ts`).
- **A request to delete data.** Uninstalling deletes everything kept for an installation. For one repository:
  `DELETE FROM github_prs WHERE repo_id = ?` and `DELETE FROM github_repos WHERE repo_id = ?`.

## Plans and private repositories

- Public repositories are always reviewed. Nothing in the configuration can turn that off.
- `GITHUB_APP_PRIVATE_REPOS = "plan"` (the default) reviews a private repository only when the GenClass account
  managing the installation has a plan with `github_private` (`billing/plans.json`: Enterprise, so a grant by
  `comp_until` is how an agreement is switched on), or the GitHub account has a paid plan on GitHub Marketplace.
- `GITHUB_APP_PRIVATE_REPOS = "open"` reviews every repository: for a beta, or a self-hosted collector.
- The two lines added to `billing/plans.json` are marked `available: false`, so the pricing page shows them as coming
  next. Set them to `true` when the app is live.

## GitHub Marketplace

The listing draft, GitHub's requirements and what is still missing are in
[`docs/adoption/listings/github-marketplace.md`](../adoption/listings/github-marketplace.md). In short: a free listing
needs the app to be public, a logo and screenshots, links to a privacy policy and to support, and a listing webhook
(`https://genclass.dev/api/github/marketplace`). A paid plan needs a verified publisher and 100 installations first.

## A self-hosted collector, GitHub Enterprise Server

The same worker on someone's own Cloudflare account (`wrangler.selfhost.toml`) can run an app of its own: register it
with `--origin https://<their worker>` and set the same secrets there. `GITHUB_API_URL` and `GITHUB_WEB_URL` point the
app at a GitHub Enterprise Server (`https://HOST/api/v3` and `https://HOST`). Neither has been run.

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
