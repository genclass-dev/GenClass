# genclass-dev[bot]: design

How the GitHub App is built and why. Users' guide: [README.md](README.md). Operator's guide: [SETUP.md](SETUP.md).
The code is the source of truth: [`telemetry-worker/src/github/`](../../telemetry-worker/src/github/).

## What it is

A reviewer whose every line comes from something that ran. Other pull-request bots read the diff and say what might
be wrong. This one reads what the GenClass runtime recorded in the page while the pull request's own tests ran, and
says what happened: this request left twice in both seeds of this test. It reads no code and guesses nothing.

That decides most of what follows. The app needs evidence to exist before it can say anything, so setup is two steps
in the repository, not zero. In exchange, a comment from it can be checked by anyone: run the test under the same
seeds.

## Where the evidence comes from

| Source | What | Needs |
|---|---|---|
| The pull request's own test run | Race files (`genclass-races/1`) written by `@genclass/playwright`'s fixture and uploaded as an artifact: per test and seed, the signatures the runtime flagged, with the evidence line | the fixture and an upload step |
| The linked app's production telemetry | The dashboard's own aggregates: kind, page route and count per finding, for the pages the changed files serve; and the coding agent's loop for that app | a GenClass app, linked by someone who owns it and can push to the repository |

Considered and left out:

- **The diff.** No static check, no model reading code. A guess from a diff is what this app exists not to be, and it
  would need the contents permission.
- **A language model in the review.** Nothing in a review is generated. Usual fixes are one fixed paragraph per group
  of finding, in the agent skill's words. Writing the fix is the coding agent's job, where it can run the app.
- **Uploading from CI with an OIDC token.** No app permission needed, but pull requests from forks cannot get an OIDC
  token, and forks are most pull requests on public repositories. Reading the artifact works for forks.
- **Reviewing a preview deployment** with the hosted page check. Useful with no setup at all; the page check lives in
  another repository. Not built.

## Shape

```
GitHub ──webhook──▶ POST /api/github/webhook      signature, delivery id claimed, 202
                      └─ after the response (waitUntil): handlers.ts
                           reviewPull: lease ─▶ settings (default branch) ─▶ artifacts of the head commit
                                       ─▶ zip ─▶ race-file validator ─▶ the reporter's summariser
                                       ─▶ fold into the pull request's findings (D1) ─▶ check, comment, inline
person  ──browser──▶ /github, /github/setup        static
                    /github/connect ─▶ GitHub ─▶ /github/callback   who is this, what can they reach
                    /account/github                 link a repository to an app
```

| File | Role |
|---|---|
| `config.ts` | the app's secrets and vars; off without them |
| `jwt.ts` | the app's RS256 token with WebCrypto; wraps GitHub's PKCS#1 key as PKCS#8 |
| `api.ts` | REST client: per-repository installation tokens, byte caps, rate limits, a call budget, credential-free downloads |
| `http.ts` | routes: the webhooks, the pages, Connect GitHub, linking |
| `handlers.ts` | one function per event, and the review of one pull request |
| `evidence.ts` | artifacts to race files; the linked app's findings |
| `zip.ts` | a zip reader for untrusted archives |
| `settings.ts`, `yaml.ts` | `.github/genclass.yml`, in a small strict subset of YAML |
| `routes.ts` | changed file paths to page routes, by framework convention |
| `review.ts` | the findings a pull request keeps, and every sentence the app writes |
| `commands.ts` | `@genclass-dev <command>` |
| `entitlement.ts` | public free, private by plan |
| `store.ts` | the six tables of migration 0013 |
| `pages.ts` | the three pages |

It lives in the collector worker, not a worker of its own: accounts, sessions, plans, D1 and the deploy are already
there, and one deploy by hand is what a small team does reliably. The cost is that the app's key sits in the worker
that takes public ingest. What limits that: the app is off without its secrets, its routes are matched before
anything else and never fall through, and it shares no code path with ingest.

The report text is the reporter's. `review.ts` imports `packages/playwright/src/summarize.ts` and embeds its output,
so the app and `genclass-playwright-report` cannot disagree about what a line means.

## Decisions

**No contents permission.** The app asks for pull requests, checks, actions (read), issues and one file. It cannot
read or write code. The settings file comes through the single-file permission. The list of changed files and their
hunk ranges come through the pull-requests permission, and only when something needs them (a linked app's pages, an
inline comment); of a patch, the app keeps line ranges.

**Settings from the default branch only.** A pull request must not be able to turn off its own review, raise who may
command the bot, or switch on production numbers. The client never passes a `ref`.

**One comment, edited in place; no comment without findings.** The check carries the status on every commit. The
comment exists when there is something to read and is updated, never repeated. A comment someone deletes comes back
only for a finding they have not been told about. The footer is one small line that says what the app read and links
to what the lines mean. There is no banner, badge or call to action in it.

**Numbers for life.** A finding's fingerprint is a hash of its test and signature; its number is given once. Statuses
are worked out against the commit whose race files were read last.

**"Not flagged now", never "fixed".** Absence in one run is not proof. Proof is a replay that reproduced before and
does not after, which the agent tools do on the developer's side.

**State in D1, evidence nowhere.** A pull request's row holds ids, hashes and the short titles already in its public
comment. Race files are read in memory per review; to answer `@genclass-dev replay` later the app uses the stored titles,
not the files.

**One review at a time per pull request.** A lease in the row (a minute) and a pending mark: an event that arrives
during a review makes the holder go round once more. Two events arriving together cannot post two comments.

**Answer first, work after.** GitHub gives a webhook 10 seconds and does not retry. The worker answers 202 once the
signature and delivery id are checked and works in `waitUntil`. A job that fails forgets its delivery id, so a manual
redelivery runs; one that succeeded cannot be replayed for a week.

**Rate limits are obeyed, not waited out.** A limit from GitHub marks the installation until the time GitHub names;
calls before then fail without reaching GitHub. Writes are never retried, so a comment cannot be posted twice.

**`fix` hands off; the app does not run agents.** An agent needs the code, the app running and a browser. All three
are in the repository's own CI or on the developer's machine, under their key. The app writes a brief there and
nothing more. It refuses for forks, because a comment-started workflow runs with the base repository's secrets.

## Threats

| Threat | What stops it |
|---|---|
| A forged webhook | HMAC-SHA256 over the exact bytes with the app's secret, verified with WebCrypto before parsing |
| A replayed webhook | Delivery ids claimed for a week; handlers are idempotent beyond that (body hashes) |
| A hostile artifact from a fork | Byte cap on download; zip reader with entry, size and count caps, inflating in a stream so a claimed size is never trusted; only `.json`, through the format's validator; nothing executed or fetched |
| Text in race files becoming markup, links, mentions or issue references | Everything from a race file goes through the summariser's escaping; operations in tables also escape `|` |
| Text in race files steering a coding agent | The brief's JSON carries it cut to one line with backticks and `<` written as escapes; the brief and the workflow prompt say it is data; `fix` only for people with write access and never for forks |
| A pull request changing its own review | Settings are read from the default branch |
| Someone linking their app to a repository they do not control, to post their text there | A link needs GitHub's answer, at most 30 minutes old, that the person can push to that repository |
| Someone reading another account's app through a repository | A link needs the app to be in the linker's own account; the page never names another account's app |
| A made-up `installation_id` on the setup page | The setup page is static; nothing trusts its address |
| Login CSRF on Connect | State kept server-side, single use, bound to the session that started it; the cookie holds only the row's id |
| A leaked installation token | Asked per repository, kept in memory under an hour, never stored or logged |
| The token reaching GitHub's storage host | A download's redirect is fetched without any credential |
| One busy installation starving the rest | 120 reviews an hour per installation, 400 per pull request, a call budget per job |
| A loop between bots | The app never answers a bot or its own replies; commands are read only from `created` comments |
| Someone without write access using commands to make the bot talk | Only `review`, `replay` and `help`, only on their own pull request, counted against the pull request's 400; to anyone else the app says nothing at all |
| A page making a signed-in browser start Connect over and over | One pending start per account; starting again replaces it |
| A redirect from GitHub's API to somewhere else | Followed once, only inside the API root; anything else is an error and the token is not sent |

## What is stored

Six tables (`migrations/0013_github_app.sql`): installations, linked or paused repositories, pull-request rows,
delivery ids (7 days), hourly review counts (2 days), Marketplace plans. An uninstall deletes an installation's rows
at once; a closed pull request's row goes after 30 days. No code, diffs, file contents, race files or tokens.

This is a new flow of data to GenClass: before the app, nothing about a repository reached GenClass's servers. It is
opt-in per installation, disclosed in [PRIVACY.md](../../PRIVACY.md#the-github-app) and in the app's own page, and it
does not change what the runtime sends from anyone's browser.

## Plans

Public repositories are free and that cannot be configured away. Private repositories need the `github_private`
entitlement (`billing/plans.json`: Enterprise) or a paid GitHub Marketplace plan; `marketplace_purchase` events are
stored for that. GitHub's rules shape the order: a free listing first; a paid plan needs a verified publisher and 100
installations; and an app with a free listing may not sell a paid service only outside the Marketplace, so once the
listing qualifies, the paid plan has to be offered there too.

## Growth without outreach

The app is how people who asked for reports get them. That is the whole of its reach, on purpose.

- **It acts only where it is installed.** It has no code path that comments, opens an issue or opens a pull request on
  a repository without an installation. It never @mentions anyone.
- **Its comments are for the people in the pull request.** One comment per pull request, only with findings, with a
  footer that says what was read. On a public repository other people see it; nothing in it is written for them.
- **Finding it** is the Marketplace listing, `genclass.dev/github`, this repository's README and the check's name on
  a pull request.
- **Nothing here contacts maintainers**, lists people or collects addresses. GitHub's acceptable use policies forbid
  using what its API returns for unsolicited messages, and the Marketplace developer agreement forbids a product
  built to send them. Reports filed on other projects in early November 2026 without a person's review were a
  mistake ([issue 173](https://github.com/genclass-dev/GenClass/issues/173)); the app is the way that asks first.
- **A maintainer who wants help setting it up asks**, in an issue here. A setup pull request on their repository
  follows only from that.

### Reports before installation

Someone can see what GenClass finds on their app before installing anything: the page check
(`npx @genclass/runtime@beta scan <url>`, or genclass.dev's page check) loads a public URL and lists what the measured
checks found. It needs no repository access. What it gives is the visual checks; races need the app's own tests and
the fixture.

Rules for anything of this kind: the report goes to the person who asked for it, and to nobody else. Nothing is filed
on a project because a scan found something. A finding is worth telling a project about only after a person
reproduced it by hand and wrote it up themselves, one project at a time, under that project's rules.

## Not built, and why

- **Marketplace paid plan:** needs the publisher verification and 100 installations first.
- **`genclass_pr` in `@genclass/mcp`** (read a pull request's findings into a local agent session): the brief is
  enough for a first version, and a tenth tool touches the package's manifests and pinned versions.
- **Preview-deployment reviews:** the hosted page check is in another repository.
- **Issues from production findings:** needs a view of what is new since a deploy, which the dashboard does not have.
- **GitHub Enterprise Server and self-hosting:** the configuration is there (`GITHUB_API_URL`), untested.
