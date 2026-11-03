# Race hunt: Gitea markdown preview

Status: evidence and a prepared fix, nothing sent to Gitea. The issue draft ([gitea-issue.md](gitea-issue.md)) and the
patch ([gitea.patch](gitea.patch)) are for the owner to reproduce by hand, rewrite and send. Gitea asks for an issue
before a PR, and its AI policy needs the contributor to answer maintainer questions personally. Refreshed on
2026-11-03 against Gitea `main` at `78eb95a`: **ready to send** (see "Refresh (2026-11-03)" at the end).

## Headline

Gitea's markdown **Preview** can show text that is no longer in the editor. Type A, click Preview, click Write, change
the text to B, click Preview again: if the response for A arrives after the response for B, the preview renders A
while the editor holds B. Nothing guards against the out-of-order response. The same code pattern is in every
ComboMarkdownEditor (issue and PR comments, issue and PR descriptions, comment edits, releases, wiki, milestones) and
in the web file editor's **Preview** and **Preview Changes** tabs.

| | unfixed Gitea | fixed Gitea |
|---|---|---|
| GenClass explore, comment box, 3 x (2 baselines + 6 seeded), 300 / 600 / 900 ms | **6 of 18** seeded loads ended with the old text (2 of 6 at each latency) | **0 of 18** (no false report) |
| GenClass explore, file editor Preview, same | **5 of 18** (1, 2, 2 of 6) | **0 of 18** |
| GenClass explore, file editor Preview Changes, 3 x (2 baselines + 12 seeded) | **12 of 36** (4 of 12 at each latency) | **0 of 36** |
| loads where the newer response was delivered first | 23, all 23 showed the old text | 23, none showed the old text |
| Gitea e2e test without GenClass (`tests/e2e/markdown-preview.test.ts`, 2 tests x 10 repeats) | **20 of 20 fail** | **20 of 20 pass** |
| at a person's pace without GenClass: Chromium throttled to 400 ms and 50 KB/s, a 62 KB first text, a short second one, about 1 s between actions (5 runs) | **5 of 5** end with the long first text | **5 of 5** show the short text |

Every baseline load (2 per session, responses in request order) ended right, on both builds. The fix keeps a request
counter per handler and renders only the latest response: 11 lines added and 1 removed, in two files.

## Versions and environment

- Gitea `main` at [`ff68b39`](https://github.com/go-gitea/gitea/commit/ff68b39c93d7b0d10e0f6629fb188f8f1c0b37d4)
  (2026-10-24). The preview handlers are byte-identical, at the same lines, in release
  [v28.2.0](https://github.com/go-gitea/gitea/releases/tag/v28.2.0) (2026-10-18, tag commit `829b49c`), so the links
  below point at v28.2.0.
- Go 1.27.3 (fetched by `GOTOOLCHAIN=auto` from the container's Go 1.24.7, per `go.mod`'s `toolchain go1.27.3`),
  Node 22.22.0, pnpm 12.13.0, SQLite (compiled in), git 2.43.0. Built with `make build`.
- GenClass from this repository at `d77ffd8` (`main`): `@genclass/runtime` 0.3.0-beta.1, `@genclass/mcp` 0.1.0.
- Chromium revision 1243 (Playwright 1.63.0's). The GenClass harness uses this repository's Playwright 1.63.0; Gitea's
  e2e tests ran with Gitea's pinned Playwright 1.64.0 driving the same Chromium binary, because revision 1248 (1.64.0's)
  is not installed in this container and installing browsers is not allowed here. Firefox was not run.
- A cloud container: Ubuntu 24.04, 4 vCPUs, 15 GB RAM, running as root.

## Setup and commands

GenClass:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
```

(`npx playwright install --with-deps chromium` was skipped: the container ships that Chromium.)

Gitea:

```bash
git clone --depth 50 https://github.com/go-gitea/gitea.git && cd gitea   # main at ff68b39
npm install --prefix ../tools pnpm@12.13.0 && export PATH=$PWD/../tools/node_modules/.bin:$PATH
make build                                # 3 min 37 s here: pnpm install, vite, go build
```

corepack 0.34 downloads pnpm 12.13.0 but cannot start it (pnpm 12's package layout), hence the npm install.

The local instance, configured as `tools/test-e2e.sh` does (sqlite3, `HTTP_PORT = 3000`,
`ROOT_URL = http://localhost:3000`, `INSTALL_LOCK = true`, `STATIC_ROOT_PATH` = the checkout, `[actions] ENABLED =
true`), then:

```bash
useradd -m gitea && chown -R gitea <workdir>          # Gitea refuses to run as root
runuser -u gitea -- env GITEA_WORK_DIR=<workdir> GITEA_TEST_E2E=true ./gitea web
runuser -u gitea -- env GITEA_WORK_DIR=<workdir> ./gitea admin user create --username e2e-admin \
  --password <pw> --email e2e-admin@e2e.gitea.com --must-change-password=false --admin
```

Test data through the API: repository `hunt` (auto-init, so `README.md` on `main`), issue 1,
`.gitea/workflows/dispatch.yml` with a `workflow_dispatch` input `alpha_input` on `main`, and a branch `other` whose copy
of the workflow has the input `bravo_input` instead.

Explore (each run: one session per latency, 2 fifo baselines + N seeded loads, a fresh browser context per load):

```bash
node docs/adoption/hunts/gitea-explore.mjs --surface comment  --slow 300,600,900 --runs 6  --out <dir>
node docs/adoption/hunts/gitea-explore.mjs --surface file     --slow 300,600,900 --runs 6  --out <dir>
node docs/adoption/hunts/gitea-explore.mjs --surface diff     --slow 300,600,900 --runs 12 --out <dir>
node docs/adoption/hunts/gitea-explore.mjs --surface dispatch --slow 300,600,900 --runs 6  --out <dir>
```

Gitea's e2e tests. `make test-e2e` first runs `playwright install --with-deps chromium firefox`, which this container
does not allow, so the same script ran directly on the already built binary and assets, with a local, uncommitted
Playwright config that keeps Gitea's config and only points the `chromium` project at the installed Chromium:

```bash
GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true EXECUTABLE=gitea \
  ./tools/test-e2e.sh -c playwright.local.config.ts tests/e2e/markdown-preview.test.ts --repeat-each 10
```

(`test-e2e.sh` starts its own Gitea as the current user; the variable only lifts Gitea's root check.) On a normal
machine: `GITEA_TEST_E2E_FLAGS='tests/e2e/markdown-preview.test.ts' make test-e2e`.

## How GenClass was attached

Gitea's code was not changed for the hunt. [gitea-explore.mjs](gitea-explore.mjs) (Playwright) rewrites every Gitea HTML
page through `page.route` to load, first in `<head>`, the script-tag build (`dist/genclass.global.js`) from a virtual
same-origin path (`/__genclass/rt/`), started with `GenClass.init({ model: false, telemetry: false, report: "silent" })`
(observe mode, no model, no telemetry), then imports the agent link (`dist/agent.js`, an ES module: the script-tag build
has no agent entry yet) and calls `connectAgent`. The MCP server runs in the harness process, driven through
`tools/call` like an agent (`genclass_explore` start and report, `genclass_findings`, `genclass_explain`).

Two things were needed that a normal integration would not need:

- **State registration.** Gitea's frontend is Go templates, Fomantic, jQuery, vanilla TypeScript and some Vue, so
  GenClass discovers no store. The injected script registers what each watched pane shows with `rt.atom()`
  (`commentPreview`, `filePreview`, `fileDiff`, `dispatchInputs`), updated from a `MutationObserver`. The verdicts below
  compare those atoms, the page text and form values.
- **Local Network Access.** Chromium blocked the agent link's hello to the loopback bridge ("Permission was denied for
  this request to access the `loopback` address space"): a document fulfilled by `page.route` has no server address,
  so, as far as we can tell, Chromium does not treat it as a loopback page. The harness grants `local-network-access` to
  each browser context, which only affects the agent link's own requests.

GenClass holds responses, never requests (AGENT.md section 3): it can only show races whose responses the UI reads.
POSTs whose responses the UI ignores (the PR "Viewed" toggle, project card moves) are out of its reach and were not
explored.

## Verdicts

| surface | code | explore on unfixed Gitea | verdict |
|---|---|---|---|
| Comment box Preview (ComboMarkdownEditor) | [`ComboMarkdownEditor.ts` L244-L254](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/comp/ComboMarkdownEditor.ts#L244-L254) | race: 2 of 6 at 300, 600 and 900 ms | **stale response, confirmed without GenClass, fixed** |
| File editor Preview | [`repo-editor.ts` L28-L43](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-editor.ts#L28-L43) | race: 1, 2, 2 of 6 | **stale response, confirmed, fixed** |
| File editor Preview Changes (diff) | [`repo-editor.ts` L50-L58](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-editor.ts#L50-L58) | 6 seeds: no race at any latency; 12 seeds: race in 4 of 12 at each latency | **stale response, confirmed, fixed** (see "What GenClass missed") |
| Actions "Run workflow" branch change | [`workflow_dispatch.tmpl` L16-L17](https://github.com/go-gitea/gitea/blob/v28.2.0/templates/repo/actions/workflow_dispatch.tmpl#L16-L17), [`fetch-action.ts` L155-L159](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/modules/fetch-action.ts#L155-L159) | "race" in 5 of 6 at 300 ms; no race at 600 and 900 ms | **a different bug: a dropped update, not a stale response** (secondary lead below, not fixed here) |
| Issue search | server-rendered form (a full page load per search) | not explored | negative: no client-side race possible |
| Poster and assignee dropdowns | Fomantic API module, [`repo-issue-list.ts` L126](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-issue-list.ts#L126) with `interruptRequests: true` ([`api.js` L167, L1028](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/fomantic/build/components/api.js#L167)) | not explored | negative: an earlier request is aborted |
| Shared search box (repo and user search) | [`search.ts` L73-L81](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/modules/search.ts#L73-L81): AbortController and `input.value === query` | not explored | negative: guarded twice |
| Dashboard repository search | [`DashboardRepoList.vue` L297, L304](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/components/DashboardRepoList.vue#L297): `searchedURL === searchURL.value` | not explored | negative: guarded |

The negatives were read in the code (on v28.2.0 and on `main`), not explored: the adversarial review that picked the
targets had already found their guards.

## The evidence, in causal order

Comment box, explore session at `slow_ms: 600`, run r11 (seed 1), as `genclass_explain` printed it. Times are from the
agent link's start; "held" includes the emulated latency.

```
+0.310s action 0: type textarea "Leave a comment" = "alpha draft of the comment"
+0.367s action 1: click link "Preview"
+0.368s send POST /:id/hunt/markup#1 "form 3 fields" (action 1)
+0.449s action 2: click link "Write"
+0.479s action 3: type textarea "Leave a comment" = "bravo final wording"
+0.532s action 4: click link "Preview"
+0.533s send POST /:id/hunt/markup#2 "form 3 fields" (action 4)
+0.807s delivered POST /:id/hunt/markup#2 (held 255 ms)
+0.808s write commentPreview.text by POST /:id/hunt/markup#2: "Loading…" → "bravo final wording"
+0.900s delivered POST /:id/hunt/markup#1 (held 511 ms)
+0.901s write commentPreview.text by POST /:id/hunt/markup#1: "bravo final wording" → "alpha draft of the comment"
```

(The page's own `content-history`, `notifications/new` and `stopwatches` requests are left out; they do not touch the
preview.) The explore verdict for that run:

```
state "commentPreview.text": baseline "\"bravo final wording\"", this run "\"alpha draft of the comment\""
page text only in the baseline: "bravo final wording"
page text only in this run: "alpha draft of the comment"
witness only here: overwrote-newer commentPreview.text by POST /:id/hunt/markup
```

The bridge also filed a `stale-write` finding from the `overwrote-newer` witness ("The response to POST
/:id/hunt/markup overwrote commentPreview.text after a newer POST /:id/hunt/markup had already written it"), 2 times in
2 runs. The file editor's traces have the same shape (`POST /:id/hunt/markup` with 4 form fields; for Preview Changes,
`POST /:id/hunt/_preview/main/README.md#1` delivered after `#2`, writing `fileDiff.text` from "bravo final wording" back
to "alpha draft of the comment").

Every unfixed load, per surface and latency, with the delivery order of the two preview requests (from the agent link's
recording):

| surface | slow_ms | #1 then #2 (request order) | #2 then #1 (newer first) |
|---|---|---|---|
| comment | 300 / 600 / 900 | 6 / 6 / 6 loads, all showed B | 2 / 2 / 2 loads, all showed A |
| file Preview | 300 / 600 / 900 | 7 / 6 / 6, all B | 1 / 2 / 2, all A |
| file Preview Changes | 300 / 600 / 900 | 10 / 10 / 10, all B | 4 / 4 / 4, all A |

The pace: the harness acts at Playwright's speed, so the two Preview clicks were about 165 ms apart. A person takes
longer to switch, edit and click, so in practice the bug needs the first response to take longer than that. The
emulated latency only makes the overlap happen on a fast machine; the bug is the missing ordering check. The next
section shows it at a person's pace with nothing reordered on purpose.

## At a person's pace, without GenClass

[gitea-throttle.mjs](gitea-throttle.mjs) uses only Chromium's own network throttling (what devtools does:
`Network.emulateNetworkConditions`, 400 ms latency, 50 KB/s each way) and holds nothing: fill the comment box with a
long text (1,500 list items, 61.9 KB of markdown, 108 KB rendered), click Preview, wait 1 s, click Write, wait 0.5 s,
replace the text with "short text", wait 0.5 s, click Preview again. The long text takes longer to upload, render and
download, so its response arrives last.

| build | result (5 runs each) |
|---|---|
| unfixed | **5 of 5**: "short text" appeared about 3.1 s after the first click, then the long text's preview replaced it; the editor held "short text" |
| fixed | **5 of 5**: the preview shows "short text" at the end (3 more runs again later, same result) |

```bash
node docs/adoption/hunts/gitea-throttle.mjs 5 http://localhost:3000
```

## Root cause

The Preview tab's click handler sends the editor's text and renders whatever comes back
([`ComboMarkdownEditor.ts` L244-L254](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/comp/ComboMarkdownEditor.ts#L244-L254)):

```ts
this.tabPreviewer.addEventListener('click', async () => {
  ...
  formData.append('text', this.value());
  const response = await POST(this.previewUrl, {data: formData});
  const data = await response.text();
  renderPreviewPanelContent(panelPreviewer, data);
```

Each click starts an independent request, and nothing checks, after the `await`s, that this response belongs to the
latest click. Requests run concurrently on the server, so a slower render of an older text can complete last and
overwrite the newer one. The file editor's Preview
([`repo-editor.ts` L28-L43](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-editor.ts#L28-L43))
and Preview Changes
([`repo-editor.ts` L50-L58](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-editor.ts#L50-L58),
`elDiffPanel.innerHTML = await resp.text()`) do the same.

A consequence read from the code, not reproduced: the comment preview enables its task-list checkboxes and writes a
toggle back into the editor's current text at the byte offset recorded in the rendered HTML
(`data-source-position`). In a stale preview those offsets come from the old text. `toggleTasklistCheckbox` refuses an
offset that does not land on `[ ]` or `[x]`, so most mismatches are rejected, but when the offsets happen to line up on
a different item, clicking a checkbox toggles that other item.

## Fix

[gitea.patch](gitea.patch), in Gitea's style (Conventional Commits title `fix(markdown): ignore outdated preview
responses`, an `Assisted-by:` trailer, no Co-Authored-By or Signed-off-by). The core of it:

```diff
+    let previewRequestId = 0;
     this.tabPreviewer.addEventListener('click', async () => {
       ...
       formData.append('text', this.value());
+      const requestId = ++previewRequestId;
       const response = await POST(this.previewUrl, {data: formData});
       const data = await response.text();
+      if (requestId !== previewRequestId) return; // a newer preview request has been sent
       renderPreviewPanelContent(panelPreviewer, data);
```

and the same three lines in the file editor's Preview and Preview Changes handlers (for the diff tab the response text
is read into a variable before the check). Why a counter rather than an AbortController: aborting makes the awaited
`POST` reject with an `AbortError`, which Gitea's global error handler would show as a JavaScript error banner unless
every handler catches it, so it needs more code and new error paths. The counter changes nothing else: the outdated
request still completes on the server (a markdown render), its response is simply not rendered. Each handler keeps its
own counter in its closure, so two editors on one page do not interfere.

Before sending: replace the patch's `From: Your Name <you@example.com>` with the owner's identity (`git am` then `git
commit --amend --reset-author`), and fill in the trailer's `MODEL_VERSION` placeholder in the
`Assisted-by: AGENT_NAME:MODEL_VERSION` form Gitea's AGENTS.md asks for (this repository does not record model names in
committed files).

## Test without GenClass

`tests/e2e/markdown-preview.test.ts` (in the patch), a plain Playwright test in Gitea's e2e suite, no GenClass:

- `comment preview ignores outdated responses`: on an issue page, `page.route` holds the first `/markup` response; fill
  "outdated text", Preview, Write, fill "current text", Preview; wait until the preview shows "current text"; release
  the held response, wait for that request to finish and one animation frame, and expect the preview to still show
  "current text".
- `file editor preview and diff ignore outdated responses`: the same sequence in the web file editor, for Preview
  (`/markup`) and then Preview Changes (`/_preview/main/README.md`).

Results:

| build | result |
|---|---|
| unfixed, `--repeat-each 10` | **20 of 20 failed**, all at the assertion after the release, each receiving "outdated text" (the comment test at line 44; the file editor test at line 68, in its Preview part) |
| preview handlers fixed, diff handler not yet | the comment test passes; the file editor test passes its Preview part and fails in the Preview Changes part at the same assertion (so the diff part of the test bites on its own) |
| fixed, `--repeat-each 10` | **20 of 20 passed**, about 1.8 s per test (run before and after a final comment-only edit of the test, 20 of 20 both times; the unfixed numbers above are with the final file) |
| fixed, with the neighbouring `codeeditor.test.ts` and `issue-comment.test.ts` | 7 of 7 passed |

Lint and types on the fixed tree: `pnpm exec eslint --max-warnings=0` on the three changed files and `pnpm exec
vue-tsc` (what `make lint-js` runs, scoped) are clean. Not run: Gitea's vitest suite, which runs in browser mode on
Playwright 1.64.0's own Chromium and Firefox (not installed here); the changed handlers have no unit tests. Firefox e2e
was not run. The patch applies with `git am` on `ff68b39`.

A limit of the test, stated for the reviewer: after releasing the held response, the test cannot observe "the page
ignored it" (the fixed code does nothing), so it waits for the request to finish plus one animation frame before
asserting. That wait was long enough in 20 of 20 unfixed runs here. On a much slower runner it could let a regression
pass; it cannot fail on correct code.

## The fixed variant

The same explore sessions on the fixed build (after a restart of the instance on the rebuilt assets):

| surface | seeded loads ending with the old text | loads where the newer response came first |
|---|---|---|
| comment, 3 x 6 seeds | **0 of 18** | 6, all showed B |
| file Preview, 3 x 6 seeds | **0 of 18** | 5 (1, 2, 2), all showed B |
| file Preview Changes, 3 x 12 seeds | **0 of 36** | 12, all showed B |

No `overwrote-newer` witness and no finding on any of the 72 fixed seeded loads; baselines 18 of 18 right. The seeded
schedules are deterministic (priorities and delays are hashes of the seed and the request key), so the fixed build saw
the same delivery orders as the unfixed one.

## What GenClass missed or mislabelled

- **Preview Changes with 6 seeds.** In the first sessions (6 seeded orders at each latency) the diff tab showed no race
  even though its two requests overlapped. The seeded priority is `hash32("<seed>|<request key>")`; for the keys
  `POST /:id/hunt/_preview/main/README.md#1` and `#2`, seeds 1 to 8 all rank `#1` higher, so the newer response was
  never delivered first; seeds 9 to 12 rank `#2` higher, and those were exactly the 4 racing loads of the 12-seed
  sessions. With two overlapping requests, each seed is close to a coin flip, so 6 seeds miss the harmful order about
  once in 64 surfaces; it happened here. A cheap improvement for `genclass_explore`: make sure each pair of overlapping
  requests of one signature is tried in both orders (for example, pair every seed with its reverse) before reporting
  "no race".
- **Workflow dispatch.** At 300 ms explore reported a race in 5 of 6, but no reordering was involved: in those runs the
  second branch pick never sent a request (`requests sent to GET /:id/hunt/actions/workflow-dispatch-inputs: baseline 2,
  this run 1`). At 600 ms one baseline lost the update too, so the difference was filed as noise ("no race"); at 900 ms
  all 8 loads lost it ("no race"). The order comparison cannot judge a dropped update reliably: what decides it is the
  latency, not the order.
- **Setup.** No automatic state discovery on this stack (one injected `rt.atom` per pane), and the Local Network Access
  permission for route-fulfilled pages.

## Secondary lead: workflow dispatch drops the second branch pick

In "Run workflow", the branch dropdown's hidden `ref` input fetches the workflow's inputs for that branch on `change`
([`workflow_dispatch.tmpl` L16-L17](https://github.com/go-gitea/gitea/blob/v28.2.0/templates/repo/actions/workflow_dispatch.tmpl#L16-L17)).
`performFetchActionRequest` returns early while an earlier request on the same element is loading
([`fetch-action.ts` L155-L159](https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/modules/fetch-action.ts#L155-L159)),
so a second pick made before the first branch's inputs arrive is dropped. Measured: pick `other`, then `main` while
`other`'s inputs load; the form ends with `ref=refs/heads/main` and `other`'s input (`bravo_input`) in 20 of 24 loads
across the three latencies (5, 7 and 8 of 8), including both baselines at 900 ms. Submitting that form would send
`main` as the ref with `other`'s input fields (not tried).

Not fixed here: the guard is in the shared fetch-action framework, where dropping repeated requests is deliberate for
clicks, so the right fix (let the latest `change` win, for example abort and resend for change triggers) is a design
choice for the maintainers. A separate issue, after the preview one.

## Time spent

About 1 h 15 min of wall-clock time in one session (2026-10-24 23:22 to about 00:35 UTC), from file timestamps:
clone and both builds 11 min (GenClass 2 min, Gitea 3 min 37 s); the harness, the Local Network Access block and the
first race found 9 min; the other surfaces and the negatives 5 min; the e2e test and the fix 10 min; the before and
after runs and both explore datasets 15 min (one 3-latency session set for one surface takes about 1 min); the patch,
the person-paced check and the writing about 25 min.

## Refresh (2026-11-03)

Status: **ready to send**. The bug is still on Gitea's `main` and in the latest release, nothing has been filed on it,
the patch applies unchanged, and every number below was re-measured today. What the sender has left is by hand:
reproduce it in their own browser, run the test, read the diff, rewrite where they want, file the issue, and open the
PR only after a maintainer responds (checklist at the top of [gitea-issue.md](gitea-issue.md)). Forgejo could not be
checked from this container (below).

### What was re-run, and how

- Gitea `main` at [`78eb95a`](https://github.com/go-gitea/gitea/commit/78eb95ab19c64210c00b15eaf85551d188613173)
  (2026-11-03 15:30 UTC, 78 commits after the hunt's `ff68b39`), cloned to `~/targets/gitea`; latest release
  [v28.3.0](https://github.com/go-gitea/gitea/releases/tag/v28.3.0) (tag commit `4f5a3e1`, 2026-11-01). Both
  handler files are byte-identical to the hunt's commit and to v28.3.0 (`git diff v28.3.0 HEAD` on them is empty; blobs
  `2e03422` and `a17e985`, the ones the patch names), so the line links in the drafts now point at v28.3.0 with the same
  line numbers. No commit since `ff68b39` touched them.
- Toolchain: `go.mod` now `go 1.27` / `toolchain go1.27.3` (fetched by `GOTOOLCHAIN=auto` from the container's Go
  1.24.7), Node 22.23.4, pnpm 12.16.1 (Gitea's `packageManager`; preinstalled here, so the hunt's corepack workaround
  was not needed), Gitea's Playwright 1.64.1 driving the container's Chromium (revision 1243, Chrome for Testing
  153.0.8010.12). `make build`: 4 min 43 s. GenClass at this repository's `c1c9e14` (`@genclass/runtime`
  0.3.0-beta.5, `@genclass/mcp` 0.2.1), built from the checkout.
- `make test-e2e` still starts with `playwright install --with-deps`, which this container does not allow (and
  Gitea's config now has a `webkit` project too), so `tools/test-e2e.sh` ran directly on the built binary with an
  uncommitted `playwright.local.config.ts` that keeps Gitea's config and only keeps the `chromium` project, pointed at
  `/opt/pw-browsers/chromium`:

  ```bash
  GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true EXECUTABLE=gitea \
    ./tools/test-e2e.sh -c playwright.local.config.ts tests/e2e/markdown-preview.test.ts
  ```

  three separate runs on the unfixed tree (with only the test file added) and three on the fixed tree (`git am
  docs/adoption/hunts/gitea.patch`, then `make build` again).
- The person-paced reproduction ([gitea-throttle.mjs](gitea-throttle.mjs), unchanged) and the explore sessions
  ([gitea-explore.mjs](gitea-explore.mjs), unchanged) ran against one local instance on port 3000 configured as in
  "Setup and commands" (user `gitea`, SQLite, `e2e-admin`, repository `hunt` with auto-init, issue 1), restarted on each
  build. Fixed build first, then unfixed. The dispatch surface (the secondary lead) was not re-run.

### Numbers

| | unfixed (`78eb95a`) | fixed (`78eb95a` + patch) |
|---|---|---|
| e2e test, 3 runs x 2 tests | **6 of 6 fail**, at lines 44 and 68 (the assertion after the release), each receiving "outdated text" | **6 of 6 pass**, 1.5 to 2.4 s per test |
| neighbouring `codeeditor.test.ts`, `issue-comment.test.ts` with the new test | not run | 7 of 7 pass |
| without GenClass: Chromium throttled to 400 ms and 50 KB/s, 62 KB first text, about 1 s between actions, 5 runs | **5 of 5** end with the long text (first line "item 0 with bold and code text") while the editor holds "short text"; "short text" first appeared 3.06 to 3.20 s after the first click | **0 of 5**: 5 of 5 end with "short text" |
| explore, comment box, 3 x (2 baselines + 6 seeded), 300 / 600 / 900 ms | **5 of 18** seeded loads end with the old text (2, 1, 2) | **0 of 18** |
| explore, file editor Preview, same | **6 of 18** (2, 2, 2) | **0 of 18** |
| explore, file editor Preview Changes, 3 x (2 baselines + 12 seeded) | **12 of 36** (4, 4, 4) | **0 of 36** |
| seeded loads where the newer response was delivered first | 23, all 23 showed the old text | 23, none showed the old text |
| baselines (responses in request order) ending right | 18 of 18 | 18 of 18 |
| explore's RACE verdicts | 9 of 9 sessions, each count equal to the loads with old text; `overwrote-newer` witness and `stale-write` finding in all 9 | 1 of 9 sessions, a false report (below); no `overwrote-newer` witness in any |

The per-latency splits differ slightly from 2026-10-24 (comment 6 then 5, file Preview 5 then 6): which seeds put the
newer response first depends on the request keys and the page's other requests, and the oracle (the preview's text)
agrees with the delivery order in every load on both days. Per-session numbers: [gitea-refresh/summary.json](gitea-refresh/summary.json).

Lint on the fixed tree: `pnpm exec eslint --max-warnings=0` on the three changed files and `pnpm exec vue-tsc` (what
`make lint-js` runs, scoped) are clean. Not run: Gitea's vitest suite (browser mode on Playwright 1.64.1's own browsers,
not installed here; the changed handlers have no unit tests), Firefox and WebKit e2e.

Timeline from the unfixed comment session at 600 ms (run r11, seed 1, as `genclass_explain` printed it; the page's own
`content-history` request left out):

```
+0.482s send POST /:id/hunt/markup#1 "form 3 fields" (action 1)
+0.593s send POST /:id/hunt/markup#2 "form 3 fields" (action 4)
+0.931s delivered POST /:id/hunt/markup#2 (held 320 ms)
+0.932s write commentPreview.text by POST /:id/hunt/markup#2: "Loading…" → "bravo final wording"
+0.962s delivered POST /:id/hunt/markup#1 (held 458 ms)
+0.963s write commentPreview.text by POST /:id/hunt/markup#1: "bravo final wording" → "alpha draft of the comment"
```

### The tracker since the hunt

`gh api -X GET search/issues`, 3 s apart, each query with `is:issue` and again with `is:pr`, all with
`repo:go-gitea/gitea`: `preview markdown outdated`, `preview stale`, `preview race`, `preview "out of order"`,
`preview created:>=2026-10-24`, `ComboMarkdownEditor`, `repo-editor preview`, `markup preview old text` (16 queries).
Nothing on this bug. The issues and PRs created since 2026-10-24 that matched are about mail templates, cleanup rules,
pasting code, review attachments and pages support. The closest older items stay as the draft names them:
[#19784](https://github.com/go-gitea/gitea/issues/19784) (uncommitted IME input on Android) and the merged
[#36625](https://github.com/go-gitea/gitea/pull/36625) ("Fix state desync in ComboMarkdownEditor", a different
desync). The one open PR that touches `repo-editor.ts`,
[#37167](https://github.com/go-gitea/gitea/pull/37167) (rich markdown diffs), leaves both preview handlers as they are
on `main` (read from its head ref with `git fetch origin pull/37167/head`), so the patch does not conflict with it today.

### The project's rules, read today

[CONTRIBUTING.md](https://github.com/go-gitea/gitea/blob/main/CONTRIBUTING.md#ai-contribution-policy) at `78eb95a`,
"AI Contribution Policy", in full:

> Contributions made with the assistance of AI tools are welcome, but contributors must use them responsibly and
> disclose that use clearly.
>
> 1. Review AI-generated code closely before marking a pull request ready for review.
> 2. Manually test the changes and add appropriate automated tests where feasible.
> 3. Only use AI to assist in contributions that you understand well enough to explain, defend, and revise yourself
>    during review.
> 4. Disclose AI-assisted content clearly.
> 5. Do not rely solely on AI to generate replies or engage in discussions.
>    Ensure your responses are concise, accurate, and thoughtful, avoiding generic or low-quality AI-generated content.
> 6. AI may be used to help draft issues and pull requests, but contributors remain responsible for the accuracy,
>    completeness, and intent of what they submit.
>
> Maintainers reserve the right to close pull requests and issues that do not disclose AI assistance, that appear to
> be low-quality AI-generated content, or where the contributor cannot explain or defend the proposed changes
> themselves.
>
> We welcome new contributors, but cannot sustain the effort of supporting contributors who primarily defer to AI
> rather than engaging substantively with the review process.

Also from CONTRIBUTING: "file an issue or comment on an existing one before starting your work" and "Pull requests
should not be the place for architecture discussions" (hence issue first); "describe the problem you are fixing, not
how you are fixing it" in the PR title, Conventional Commits, squash merge; the DCO is agreed by opening the PR, with
`Signed-off-by` optional. Gitea's [AGENTS.md](https://github.com/go-gitea/gitea/blob/main/AGENTS.md) (for coding
agents) adds: `Assisted-by: AGENT_NAME:MODEL_VERSION` trailer, "never `Co-Authored-By` or `Signed-off-by`"; PR
descriptions "minimal, only what and why", under 1000 characters; issues and PRs by full URL; "Attribute agent
authorship on one trailing line in issue and PR comments, never as a PR description section"; comments "almost none,
short and preferably same-line"; e2e tests under 4 s and waiting "on a deterministic condition rather than `sleep`".
The patch already followed these; the fixed tests take 1.5 to 2.4 s.

### What changed in the drafts

- [gitea-issue.md](gitea-issue.md): version line (`main` at `78eb95a`, v28.3.0), code links moved to v28.3.0 (same
  lines), the duplicate search dated and listed, the disclosure as one trailing line in the swarm's wording (Gitea's
  AGENTS.md wants a single trailing line), a "before filing" and a "before opening the PR" checklist split into what the
  session did and what is by hand, and the **pull request description**, which the hunt had not drafted (Gitea's
  template, 965 characters, with answers to the three questions a reviewer is likely to ask).
- [gitea.patch](gitea.patch): unchanged. It applies with `git am` on `78eb95a` and `git format-patch` from there
  differs only in the commit hash and the abbreviated blob lengths. The sender still sets their identity and the
  trailer's `MODEL_VERSION`.

### Forgejo

Not checked. `codeberg.org` (and `code.forgejo.org`) are denied by this container's network policy (the proxy answers
403 to CONNECT), there is no Forgejo mirror on GitHub, and the Go module proxy does not serve the current module. So
whether Forgejo still carries the same handlers is unknown today; a session with codeberg.org allowed can check
`web_src/js/features/comp/ComboMarkdownEditor.*` and `web_src/js/features/repo-editor.*` on Forgejo's default branch.
Nothing was prepared for Forgejo.

### Problems with GenClass itself (new today)

- **A false RACE from server timing text.** On the fixed build, the Preview Changes session at 600 ms reported "RACE:
  12 of 12" and filed finding f1 ("it shows "Page: 16ms Template: 4ms" under "seed 1""): Gitea's footer prints the
  server's render time. Explore treats text as noise only when it "differs between the two baselines"; in that session
  both baselines happened to render "Page: 18ms Template: 4ms", so every seeded load differed from them. The other 8
  sessions on the fixed build listed `text "Page: N Template: N"` as ignored noise. The fixed build's preview was right
  in all 12 loads. A cheap improvement: treat text that differs from the baselines only in numbers (the "N" pattern
  explore already builds) as noise when the numbers look like durations, or when that pattern varied in any earlier
  session on the same page; until then, two baselines are too few for pages that print timings.
- **The generated regression test's locator for an unlabeled editor.** In that same finding, the recorded step names
  CodeMirror's unlabeled textbox by its content ("type textbox "alpha draft of the comment""), so the generated test
  fills `getByRole("textbox", { name: "alpha draft of the comment" })`, which will not match an empty editor on a fresh
  load. Not hit on the comment box, whose textarea has a placeholder.
- Still true from the hunt: no automatic state discovery on this stack (one injected `rt.atom` per pane), and the
  Local Network Access permission each route-fulfilled context needs.

### Time spent

About 30 minutes of wall-clock time (16:34 to about 17:05 UTC): clone and both builds 7 min, the e2e runs 4 min, the
tracker search 2 min, the instance, the throttled runs and the explore sessions 10 min, the Forgejo attempts 3 min,
the drafts and this section the rest.
