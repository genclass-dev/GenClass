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
| The default branch's test run | The race files of the default branch's most recent commit that has them, read only when the pull request's own files flag something: which kinds and operations are flagged there too | the same workflow running on pushes to the default branch |

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
                                       ─▶ (something flagged: the default branch's race files, the same way)
                                       ─▶ fold into the pull request's findings (D1) ─▶ check, comment, inline
person  ──browser──▶ /github, /github/setup        static (setup: after installing; "Continue with GitHub")
                    /github/connect ─▶ GitHub ─▶ /github/callback   who is this, what can they reach
                                                    (not signed in: GitHub's answer also signs them in)
                    /account/github                 what the app is doing on each repository; link one to an app
```

| File | Role |
|---|---|
| `config.ts` | the app's secrets and vars; off without them |
| `jwt.ts` | the app's RS256 token with WebCrypto; wraps GitHub's PKCS#1 key as PKCS#8 |
| `api.ts` | REST client: per-repository installation tokens, byte caps, rate limits, a call budget, credential-free downloads |
| `http.ts` | routes: the webhooks, the pages, Connect GitHub, linking |
| `handlers.ts` | one function per event, and the review of one pull request |
| `evidence.ts` | artifacts to race files, a pull request's and the default branch's; the linked app's findings |
| `zip.ts` | a zip reader for untrusted archives |
| `settings.ts`, `yaml.ts` | `.github/genclass.yml`, in a small strict subset of YAML |
| `routes.ts` | changed file paths to page routes, by framework convention |
| `review.ts` | the findings a pull request keeps, and every sentence the app writes |
| `workflow-file.ts` | the text of the one workflow file a repository adds, and the link that opens GitHub's new-file editor with it |
| `commands.ts` | `@genclass-dev <command>` |
| `entitlement.ts` | public free, private by plan |
| `store.ts` | the seven tables of migration 0013 |
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
command the bot, or switch on production numbers. The client never passes a `ref`. The defaults stand in only when
GitHub says there is no file to read. A file that could not be fetched is not a missing file: the job fails before it
writes, nothing is cached, and the next event reads again, so a repository's `comment: never` or `reviews: false` is
never replaced by the defaults because GitHub did not answer.

**Silent until there is something to read.** Installing the app on an organization must not put a check on every
pull request of every repository. Until race files were read for a repository once, a pull request without them gets
nothing. A repository of an installation for selected repositories was picked by someone, so it gets one check, once,
that says what the app reads; a private repository without a plan gets its one check that says so. Only race files
from inside the repository (a branch of it, or an author GitHub calls owner, member or collaborator) switch the check
on for the repository's other pull requests: a fork's workflow uploads what it likes. A person who asks is always
answered.

**A link to GitHub's editor, not a pull request.** The shortest way to give the app something to read is one workflow
file ([`workflows/genclass.yml`](workflows/genclass.yml)). The app cannot add it: it has no contents permission and
never opens a pull request. So the check that has nothing to read may carry a link to GitHub's own new-file editor,
`<web root>/<owner>/<name>/new/<default branch>?filename=...&value=...`, with the file's name and text filled in. The
person who follows it reads the file and commits it as themselves, or does not. The link is a setting of the server,
`GITHUB_APP_WORKFLOW_LINK`, off by default: the workflow installs `@genclass/playwright` from npm, so the link waits
for that package's first version. It appears where the app already says how to set itself up (the first-run check,
"No race files for this commit", the page `/github/setup`) and nowhere else. The functions that render a comment, a
reply or an issue are not given the link, so none of them can show it. The sentence around it says what the file
does and that the person reviews and commits it. With the setting off, every text the app writes on GitHub is
unchanged. On `/github/setup` the address is built in the browser from a repository and a branch that a person
types, because that page knows nothing about any installation.

**The workflow's job says whether there was something to read, not what was found.** In the one-file workflow the
step that runs the suite is allowed to fail, and the upload fails without a race file: the job's own check on a
commit is red when nothing ran under GenClass and green otherwise. What a run found has one place, the app's check,
and one setting that can make it fail (`check.fail_on`). With `continue-on-error` on the job alone, the workflow run
stayed green and the job's check was a failure whenever a test failed under the delays: a red mark on every such
pull request that no setting of the app could turn off, and on every commit of the default branch once the file ran
there for the baseline. The job stays allowed to fail as well, so a red job never fails the workflow run.

**One comment, edited in place; no comment without findings.** Once race files were read for a repository, the check
carries the status on every commit. The comment exists when there is something to read and is updated, never
repeated. A comment someone deletes comes back only for a finding they have not been told about. The footer is one
small line that says what the app read and links to what the lines mean. There is no banner, badge or call to action
in it. "Findings" here means the pull request's own: what the default branch's race files flag too does not start a
comment (below), and what the settings leave out is in no count.

**One finding per signature.** A finding is a kind and an operation; the tests that reach it are listed in its row.
It used to be one signature in one test, which made one race a row per test, and a row per Playwright project for
the same test. Grouping by the signature is the grouping the reader does anyway: the usual fix is per kind and
operation, an issue is per finding, and a baseline or an `ignore` entry can only name something that is the same
from test to test. The cost is that two causes behind one kind and operation share a row. They also share the
embedded race report, which stays test by test with each test's own seeds and evidence line, so nothing is lost,
only folded. What a row keeps of its tests is five names; the seeds are those of the test that flags it in most.
"Reproducible" keeps its meaning, enough seeds of one test: two tests that each saw it once are not that.
The operation is taken as the race file writes it; the app does not rewrite it. The runtime's request keys already
write the ids they recognise in a path as `:id` (`normalizePath` in `packages/runtime/src/util.ts`: numbers, UUIDs,
long hex strings and tokens, short slugs that mix letters and digits), so a record a test creates does not make a
new finding in every run. A record that a path names with a plain word keeps an operation of its own, and an
`ignore` entry with a `*` covers those. Naming a race is the part of whatever writes the race file, so that the
race report and the review name it alike.

**Numbers for life.** A finding's fingerprint is a hash of its kind and operation; its number is given once. Statuses
are worked out against the commit whose race files were read last. A row keeps 100 findings. One that is flagged is
never dropped to make room: the ones that do not fit get no number and are counted, so nothing comes back as new
under another number at the next review. Rows stored before the grouping (state `v: 1`) are regrouped when they are
read: the lowest number of a group stays, the others are kept with the finding and still name it in a command, and
the counter does not go back, so no number ever means two findings. The comment says once which numbers a row was
listed under. The stored column is rewritten as `v: 2` by the pull request's next review, never by a command, so the
state has one writer as before. An issue opened before the grouping carries the old fingerprint, of one test and
the signature; at a merge a finding counts as filed under that one too.

**Compared with the default branch, by its own runs.** A pull request's comment used to list as new what every pull
request of the repository lists: a race that is on the default branch already. The app now reads the race files of
the default branch's most recent commit that has them, and a finding flagged there too is "already on the default
branch": listed, with the commit named, not counted as new, not commented inline, not a reason for a comment or, by
default, for a failing check. It still keeps a check from being green: something is flagged.
- *The claim is small.* Two sets of race files flag the same kind and operation. Nothing says the pull request did
  not cause it, or that it is harmless; the commit is named so that the reader can look.
- *Not when a clean test turns.* Kind and operation alone would hide the one change that matters most: a pull request
  that brings a known race into a test that passed without it on the default branch (the debounce breaks, and the
  plain checkout test now double-submits like the test that double-clicks on purpose). So a finding is not "already
  there" when a test flags it here in enough seeds to be reproducible and that test ran on the default branch without
  it; the review names the test, and the finding counts for the comment and the check as the pull request's own. One
  seed in such a test is not enough (a race that shows by chance wanders between tests), and a test the default
  branch did not run is not a test that was clean there. A mark that stands without a comparison (below) is dropped
  the same way when the finding becomes reproducible in a test it was not flagged in when it was compared. A finding
  that stops being the default branch's (this way, or because the default branch no longer flags it) is "New" at
  that commit: nobody was told it was the pull request's.
- *Which runs.* Only runs a push to the default branch or its schedule started, filed under the branch's name, in
  the repository itself. GitHub's `branch` filter is not trusted for that: a fork's branch can be called `main`, and
  a `pull_request_target` run carries the base branch's name and commit while testing a pull request's code. A
  dispatched run is left out too, because its inputs can point it at any code.
- *Which commit.* The most recent one, among the branch's last 100 finished runs, that gives a race file that
  validates. Most commits of a default branch have none (a docs-only merge, a workflow with path filters: on this
  repository the race files were five commits back the day this was written), so counting commits back does not find
  it. The looking follows workflows instead: runs are asked for their artifacts by recency, at most ten, those of the
  workflow that uploaded the pull request's own race files first, and a workflow whose two most recent runs showed
  none is passed over. A commit whose artifact has expired is not a commit without findings: an older one may stand
  in, and the review says the comparison may be incomplete.
- *Same reader.* The commit's files go through `ciEvidence` itself: the same caps, the same validator, the same
  choice between two artifacts of one name. A baseline is as untrusted as a pull request's artifact.
- *Read only to compare.* Not at all when nothing is flagged, so a clean pull request costs nothing more. A client
  of its own, 20 requests at most, so the review's own budget is untouched.
- *Never at the review's expense.* Not started in the last 9 seconds of a job; no request in the last 6, and one that
  is running then is given up; a request that got no answer is not tried again (the client's own retry of a read
  would wait as long again). A read that was cut short is dropped whole. When GitHub does not answer for the default
  branch, or answers 5xx, the review is written without the comparison and says so: a slow endpoint must not keep
  every review of a repository from being written, least of all the sweep's, which is what finishes a check left in
  progress. Only a rate limit or a refused token ends the pass, as it would at the review's next request.
- *What stands.* The marks are stored per finding with the commit they came from. When the default branch cannot be
  read later (the artifact expired, no time), they stand and the review says which commit they are of: the same
  rule as for a commit's own result that cannot be read again. Findings over the hundred a row keeps have no row and
  so no mark: they are compared only in a review that reads the default branch, and count as the pull request's own
  in one that cannot.
- *Kept two minutes, in memory.* A push brings several reviews of one pull request within minutes; the commit, the
  fingerprints and the names of the tests that flagged and that ran are remembered per isolate that long, for at
  most 200 repositories, and dropped when a run of the default branch ends.
- *Not the base branch.* A pull request into a release branch is compared with the default branch too. Its own base
  would be the better comparison there; one rule for every pull request was chosen first.

**Left out by a setting, counted.** `ignore` lists signatures by kind and operation; a signature it names is not
folded into the findings at all, so it has no row, no number, no inline comment and no part in the check, and
`issues: merge` opens nothing for it. Three things keep that from being silent: the comment and the check say how
many were left out at this commit, the race report in the fold still shows them, and the entry is in a file on the
default branch that the team reviews like any other. With everything left out a check can be green, and its title
says "besides N left out by the settings". An entry must name a kind and an operation; one that does not is not used
and is reported, so a typo can never leave out more than was meant. One `*` is allowed in an operation, which makes
a match a single pass over it: operations come from race files, which anyone's pull request can upload, and
matching thousands of them against a rule must not be able to make a review slow.

**"Not flagged now", never "fixed".** Absence in one run is not proof. Proof is a replay that reproduced before and
does not after, which the agent tools do on the developer's side.

**State in D1, evidence nowhere.** A pull request's row holds ids, hashes and the short titles already in its public
comment. Race files are read in memory per review; to answer `@genclass-dev replay` later the app uses the stored titles,
not the files. The default branch's race files are no exception: the row keeps the commit they were of and one mark
per finding, and nothing else of them outlives the two minutes in memory. A table of baselines per repository would
survive an expired artifact and save requests; it would also be the first thing the app stores about a repository's
default branch, so it was left for the owner to decide.

**One review at a time per pull request.** A lease in the row (35 seconds, longer than a job can live) and a pending
mark: an event that arrives during a review makes the holder go round once more. The mark is made only on a live
lease, in one statement; an event that finds the holder gone takes the lease itself. Two events arriving together
cannot post two comments. The findings and hashes in the row are written only by the review that holds the lease.
What a command changes while a review may be running (a pause) is a column of its own, written in one statement: the
review does not undo it, and the command does not write back findings it read earlier.

**A request holds for one pass.** What a person asked for (a `review` from someone with write access lifts a pause
and `reviews.ignore_authors`) holds for the pass it was asked for. A pass that follows in the same job runs as what
arrived meanwhile: an event as an event, another request as a request. A pause set after a request stops that
request's pass before it writes and the passes after it, and a request that was waiting on a running review when the
pause was set becomes a plain event, so it cannot lift a pause it was made before. A pass that runs as a request is
counted as one, not under the share of the hour that pushes have.

**The pull request's state comes from GitHub, never from a payload.** Each pass asks for the pull request. A
redelivered or late `synchronize` cannot move the row back to an older commit, and an old `closed` cannot close a pull
request that was reopened.

**Answer first, work after.** GitHub gives a webhook 10 seconds and does not retry. The worker answers 202 once the
signature and delivery id are checked and works in `waitUntil`, which the platform cuts 30 seconds after the response
without running another line. So a job stops itself 20 seconds after its delivery arrived: no request to GitHub
starts after that, the lease is released and the job fails. A job that fails forgets its delivery id, so a manual
redelivery runs; one that ended is marked done and cannot be replayed for a week; one that was cut anyway is neither,
and can be redelivered a minute later.

**A review that is owed is run.** A pull request's row is marked due when a review of it starts and unmarked when it
ends, unless it ended waiting for the commit's test run or could not run (a limit, no time left). A sweep reviews
what has been due for more than an hour. That is what makes one rule hold: a check is never left "in progress"
without something certain to finish it. Everything that ends a wait early finishes the check at once and says why;
the sweep is for what no event ended.

**The sweep has its own cron trigger, and a small run.** A second trigger, every 20 minutes, runs the sweep and
nothing else; the daily trigger runs it too, after the retention sweeps. One run looks at 20 pull requests at most,
the longest owed first. A review is some 15 statements on the database and up to 40 requests to GitHub, and the
platform caps both for one invocation; 20 reviews stay under a thousand of each. A run ends at the first failure that
is not GitHub's answer: if the database refuses a statement straight after a check run or a comment was created, its
id is lost and the next review would write a second one, and every row after it would fail the same way. The
20-minute trigger also shortens how long an hourly limit or a failed job keeps a check in progress, from up to a day
to about an hour and a half.

**No verdict from a read that is not whole, where the check can fail a pull request.** Under `check.fail_on`, neutral
passes a required check. A first read of a commit in which an artifact could not be downloaded, or had expired, would
give "neutral" or "No race files" for race files nobody read. So that read gives no verdict unless what was read
already fails the check: the check stays in progress, says what could not be read, nothing of the part is kept, and
the review is owed. A person who asks, and the sweep, end it with what can be read then. Whether a read was whole is a
flag the evidence carries (`incomplete`), set where something goes unread; it is never worked out from the wording of
a note. One thing is listed without setting it: a `.json` file over 64 KB that is not named as the fixture names its
race files, so that a repository that uploads a reporter's output next to them keeps its green check.

**Which artifact is read does not depend on which event started the review.** Of two runs of one workflow that
uploaded the same artifact name, the one that finished last is read. The run whose end started a review only makes
sure that its workflow is asked first; it does not win over a later run of that workflow. When GitHub's list of a
commit's runs (100) does not show that run, it is asked about by itself, so its workflow is known and the same rule
applies to it.

**Rate limits are obeyed, not waited out.** A limit from GitHub marks the installation until the time GitHub names;
calls before then fail without reaching GitHub. Writes are never retried, so a comment cannot be posted twice.

**An issue only from the merged commit's evidence, and one per finding.** `issues: merge` is decided by the review
pass that finds the pull request merged, under the lease, whichever event got there first. When the stored findings
are an older commit's, the merged commit's race files are read first, and with none to read there is no issue. That
read follows the review settings: a pull request that `reviews.auto`, `reviews.branches` or `reviews.ignore_authors`
leave out is not read or counted at the merge either. While the merged commit's workflow runs do not exist yet or
have not all finished, nothing is decided, because the events of the runs still to end will find the pull request
closed: the review stays owed, and the sweep reads the commit again and decides with what there is. Each
issue carries its findings' fingerprints in hidden markers. Before opening one, the app lists the issues it opened in
the repository, open and closed, and leaves out what they already list: the same finding is in every pull request's
race files until someone fixes it, and an issue someone closed must not come back at the next merge. One pull request
at a time lists and opens in a repository (a turn of one minute in `github_repo_facts`): a merge queue lands a group
of pull requests at once, and each would find no issue for the finding they share. The one that waits is owed its
review, and the sweep decides it from the list. A paused pull request or repository gets none.

**`fix` hands off; the app does not run agents.** An agent needs the code, the app running and a browser. All three
are in the repository's own CI or on the developer's machine, under their key. The app writes a brief there and
nothing more. It refuses for forks, because a comment-started workflow runs with the base repository's secrets.

## Threats

| Threat | What stops it |
|---|---|
| A forged webhook | HMAC-SHA256 over the exact bytes with the app's secret, verified with WebCrypto before parsing |
| A replayed webhook | Delivery ids claimed for a week; handlers are idempotent beyond that (body hashes) |
| A hostile artifact from a fork | Byte cap on download. The zip reader inflates an entry itself, into a buffer of the size the entry claims, so a zip bomb costs its claim and no more (the runtime's `DecompressionStream` is not used: workerd inflates a whole write before any output can be counted). Every entry it starts counts against the caps, kept or not, and many records cannot share one stream. The caps are for the review as a whole, however many artifacts there are: 600 race files, 64 KB a file, 4 MB unzipped, 2,000 signatures. Only `.json`, through the format's validator, which caps a file's signatures (200) and the length of each string; nothing executed or fetched |
| Text in race files becoming markup, links, mentions or issue references | Everything from a race file goes through the summariser's escaping, which also puts a zero-width space after every `@` and into `://` and `www.`, so nobody is mentioned, no address is linked and the address of another repository's issue leaves no reference there; operations are shown as code, and in tables also escape `|`. An issue's title is plain text: what comes from a race file gets the same breaks there, without backslashes |
| Text in a race file passing for the marker of a finding that has an issue, so that the finding is never filed | A marker counts only as a whole line of an issue's body, and race-file text is always written inside a line, with its line breaks taken out |
| Text in race files steering a coding agent | The brief's JSON carries it cut to one line with backticks and `<` written as escapes; the brief and the workflow prompt say it is data; `fix` only for people with write access and never for forks |
| A pull request changing its own review | Settings are read from the default branch, `ignore` like the rest |
| A pull request supplying its own baseline, so that its finding is "already on the default branch" and does not fail the check | A baseline is read only from workflow runs that a push to the default branch or its schedule started, in the repository itself, under the branch's name. Each run says so itself (`event`, `head_branch`, `head_repository`), and GitHub's `branch` filter is not taken at its word: a run a pull request started is never read, whatever branch name it carries, nor a run of a fork, nor a dispatched one |
| A hostile artifact on the default branch, or text in it | It is read by the reader a pull request's artifact goes through, under the same caps. Nothing of its text is shown: what is kept of it is the commit and a set of fingerprints |
| The comparison using up a review's requests or its time, or a slow GitHub turning it into a failed job | A client of its own with 20 requests; not started with less than 9 seconds of the job left; no request with less than 6, and a running one is given up then; no second try of a request that got no answer; a read that was cut short is dropped whole and not remembered. No answer and a 5xx for the default branch give a review without the comparison, never a failed job |
| Someone with write access pushing a tag named like the default branch, so that a workflow that runs on every push uploads their commit's race files under that name | Not stopped, if GitHub files a tag push's run under the tag's name (its run object has a `head_branch` and nothing that says branch or tag; not tried against GitHub): telling them apart needs the contents permission. It takes write access and a workflow without a branch filter, it changes one thing (their findings read "already on the default branch" and do not fail the check), and `check.fail_on_baseline: true` takes that away. The workflow files here run on pushes to named branches only |
| Race files with thousands of operations made to match slowly against an `ignore` entry | An entry's operation holds at most one `*`, so a match is one pass over at most 160 characters; at most 30 entries |
| A settings entry that leaves out more than its author meant | A kind must be written whole and matches exactly; an entry without a kind and an operation, or with any other key (a `test`, say, which is not read), is not used and is reported in the check; every review counts what was left out |
| Someone linking their app to a repository they do not control, to post their text there | A link needs GitHub's answer, at most 30 minutes old, that the person can push to that repository |
| Someone reading another account's app through a repository | A link needs the app to be in the linker's own account; the page never names another account's app |
| An app's findings staying on a repository's pull requests after the app's owner lost access to it | The account that owns a linked app can always take the link away, with or without access to the repository; its account page lists such links, a private repository without its name |
| An account with access to one repository deciding whether an organization's private repositories are read (getting them read under its own plan, or keeping the organization's plan from counting) | Only the plan of the account that manages the installation counts. That account is the GenClass account of the person whose own GitHub account the installation is on (GitHub's answer to who they are), or, for an organization, the account the operator set by hand. What an account can reach or push to never counts, and connecting never takes an installation from an account whose plan includes private repositories for one whose plan does not |
| A Marketplace purchase lost because the listing's webhook sends a form | A form delivery (the JSON in a field named `payload`) is checked against its signature over the bytes received, then handled as the JSON delivery it stands for |
| A delivery GitHub signed for the app's webhook (a comment whose text holds `&payload=...`) sent to the listing's webhook as a form, to record a paid plan | A form is taken only when the body is exactly one `payload` field: it starts with `payload=` and holds no `&`. A JSON body is refused, never searched. The listing's webhook gets a secret of its own when the listing exists (SETUP.md) |
| A made-up `installation_id` on the setup page | The setup page is static; nothing trusts its address |
| A repository or branch name made to change where the workflow link points (another repository, another host, another file or text) or to put markup into the check | The link's parts are the server's own GitHub web root, the repository's full name and its default branch as GitHub gives them (the pull request GitHub returns, else the event's signed payload) and the app's own file text. Nothing in it comes from a race file, a pull request's title, a head or base branch, or a request. The full name must be `owner/name` in the characters GitHub allows, and the branch a name git allows: no `.` or `..` segment, no empty segment, none of the characters git refuses; otherwise there is no link. Each branch segment, the file's name and the text are percent-encoded down to letters, digits, `-`, `_` and `.`, so a `#`, `?`, `&`, `%`, a bracket or a quote in a branch name stays inside its path segment and cannot start a query, a fragment, a second link or markup. No address over 5,800 characters is built |
| Input typed into the form on the setup page becoming markup, or an address somewhere else | The page's script, under the page's nonce and the same content security policy, checks the two inputs against the same two patterns, builds the same address with `encodeURIComponent`, and opens it in a new tab without an opener. Messages are set as text. The form has no action and no inline handler, and nothing typed is sent to the server |
| Login CSRF on Connect | State kept server-side, single use, bound to the session that started it; the cookie holds only the row's id |
| Login CSRF on "Continue with GitHub" (the same start from a browser that is not signed in, which ends in a session) | The state is single use and kept server-side in a row only that browser's cookie names (HttpOnly, SameSite=Lax), so a code and state from someone else's flow find no row there and nothing is exchanged. Who is signed in is GitHub's answer to the token's own `GET /user`, never anything in the callback's address. A code GitHub sends on its own after an install (no state of ours) is not exchanged: the person gets the setup page and its button |
| A page making browsers start "Continue with GitHub" over and over to pile up rows | These starts have no account to keep to one row, so they are rate limited per network like every sign-in start that stores one (`AUTH_LIMIT`), and a row lasts 10 minutes |
| Taking over an account through "Continue with GitHub" | It is GitHub sign-in: the account is the one whose `github_id` GitHub vouched for, or a new one. Nothing is attached by email or login, and an account with a passkey still has to pass the passkey step before it gets a session |
| A leaked installation token | Asked per repository, kept in memory under an hour, never stored or logged |
| The token reaching GitHub's storage host | A download's redirect is fetched without any credential |
| One busy installation starving the rest | 120 reviews an hour per installation, 400 per pull request, a call budget per job; the sweep looks at 20 pull requests a run |
| A race file with thousands of seeds, in hundreds of files, holding the shared isolate for seconds | A signature lists at most 64 seeds (the validator refuses the file on the count alone), and the summariser merges seeds in work that grows with their number, not its square |
| One pull request, or pull requests from outside, using up an installation's hour | 30 reviews an hour per pull request, counted before GitHub is asked anything; the hour is charged only for a review that reads a commit's evidence; at most half of it for authors who are not owner, member or collaborator, and at most 90 of the 120 for reviews started by pushes |
| A webhook delivered late, twice or out of order | The pull request is asked of GitHub at every pass; delivery ids are claimed once |
| A loop between bots | The app never answers a bot or its own replies; commands are read only from `created` comments |
| Someone without write access using commands to make the bot talk | Write access is GitHub's answer to the permission question for the commenter, asked for the command; the association an event carries is not used. Without it: only `review`, `replay` and `help`, only on their own pull request, counted against the pull request's 400, and their `review` lifts neither a pause nor `reviews.ignore_authors`; to anyone else the app says nothing at all |
| A page making a signed-in browser start Connect over and over | One pending start per account; starting again replaces it |
| A redirect from GitHub's API to somewhere else | Followed once, only inside the API root; anything else is an error and the token is not sent |

## What is stored

Seven tables (`migrations/0013_github_app.sql`): installations, linked or paused repositories, what was done once per
repository (three dates), pull-request rows, delivery ids (7 days), hourly review counts (2 days), Marketplace plans.
An uninstall deletes an installation's rows at once; a closed pull request's row goes after 30 days. No code, diffs,
file contents, race files or tokens.

A pull request's row holds its findings as JSON (`github_prs.state`, version 2): per finding a number, a fingerprint
of its kind and operation, the kind, the operation, up to five test titles, the seeds of the first of them, two short
commits, a status, and whether the default branch's race files flag it too; and for the row the default branch's
commit those marks are of. No table or column was added for that. Version 1 rows (a finding per test and signature)
are read and regrouped, and rewritten by the next review. A worker from before version 2 reads a version 2 row as
empty: after a rollback a pull request's findings are numbered from 1 again in its existing comment, and nothing
else is lost.

This is a new flow of data to GenClass: before the app, nothing about a repository reached GenClass's servers. It is
opt-in per installation, disclosed in [PRIVACY.md](../../PRIVACY.md#the-github-app) and in the app's own page, and it
does not change what the runtime sends from anyone's browser.

## Plans

Public repositories are free and that cannot be configured away. Private repositories need the `github_private`
entitlement (`billing/plans.json`: Enterprise) or a paid GitHub Marketplace plan; `marketplace_purchase` events are
stored for that. GitHub's rules shape the order: a free listing first; a paid plan needs a verified publisher and 100
installations; and an app with a free listing may not sell a paid service only outside the Marketplace, so once the
listing qualifies, the paid plan has to be offered there too.

The entitlement is looked up on one GenClass account per installation, the account that manages it
(`github_installations.owner`). For an installation on a person's own GitHub account that is the account they connect
GitHub from (Connect GitHub signed in, or Continue with GitHub after installing, which signs them in to the account
that has their GitHub identity): GitHub says who they are, and the installation is on that account. For an organization, nothing
the app can ask says who administers it. `GET /user/installations` lists every installation in which the person can
reach a repository, outside collaborators included, and `GET /user/memberships/orgs/{org}`, which gives the person's
role, is listed in GitHub's documentation under the organization permission "Members", which the app does not ask
for. So an organization's managing account is set by the operator when the plan is agreed, and push access to a
repository is never taken as a sign of it. The Marketplace plan is keyed by the organization's GitHub account and
needs no managing account.

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
- **An organization's owner taking its installation by connecting:** needs GitHub's answer that the person is an owner
  of the organization, which means asking every installation for the organization permission "Members: read". Until
  then the operator sets the managing account.
- **`genclass_pr` in `@genclass/mcp`** (read a pull request's findings into a local agent session): the brief is
  enough for a first version, and a tenth tool touches the package's manifests and pinned versions.
- **Preview-deployment reviews:** the hosted page check is in another repository.
- **Issues from production findings:** needs a view of what is new since a deploy, which the dashboard does not have.
- **A stored baseline:** what the default branch's race files flag is read from GitHub for a review and remembered
  two minutes. Kept in a table it would outlast an expired artifact; that is a new kind of thing to store.
- **Reviewing open pull requests again when the default branch's race files change:** a pull request is compared at
  its own next review. Doing it at every push to the default branch would be a review per open pull request.
- **A comparison with a base branch that is not the default branch.**
- **A command that prints the `ignore` entry for a finding:** the kind and the operation are in the race report and
  in the `replay` reply today.
- **Telling two causes behind one kind and operation apart:** they are one finding; the race report lists each test.
- **GitHub Enterprise Server and self-hosting:** the configuration is there (`GITHUB_API_URL`), untested.
