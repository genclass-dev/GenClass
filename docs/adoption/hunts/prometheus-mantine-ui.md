# Race hunt: Prometheus web UI, mantine-ui (prometheus/prometheus)

A GenClass race hunt against the Prometheus 3.x web UI (`web/ui/mantine-ui`), run on 2026-11-03 in a cloud session of
the adoption swarm (brief: `docs/adoption/swarm-targets/prometheus-mantine-ui.md` on branch `adopt/briefs`). Everything
was done on a local copy; nothing was sent to the Prometheus project.

**Headline: no race found.** Seven scenarios (the query tree view under an expression change, two table executions
back to back, a graph execution followed by a range change, two "Format expression" calls with an edit between them,
the Targets and Service discovery pool select switched twice, a double-click on the TSDB status page's "Delete
series"), each run as an explore session of 8 page loads (2 request-order baselines and 6 seeded reorderings) at 300,
600 and 900 ms of extra latency, and again 8 times without GenClass with the superseded request held 900 ms: RESULTS_HEADLINE
GenClass printed no RACE line in any session; the lines it did print are request counts that depend on timing, listed
as "internal state only" (section 6). Section 7 quotes the code that makes the order not matter.

**One non-race defect, with a ready fix.** The tree view sends each leaf node's `/api/v1/query` twice and aborts the
first (7 requests for 5 nodes in 8 of 8 loads; 5 and none aborted with the fix, 8 of 8). The cause is the query key
`[useId()]` with `useId` from `@mantine/hooks`, whose value changes right after mount. The fix (React's own `useId`,
one import line) and a Vitest test that fails on `main` and passes with it are in
[prometheus-mantine-ui.patch](prometheus-mantine-ui.patch); the pull request draft is in
[prometheus-mantine-ui-issue.md](prometheus-mantine-ui-issue.md). GenClass did not find this as a race: explore
listed it as a GET count that differs, and the browser's request log showed what it was. **Status: needs owner
decision** (send a small plain bug fix that does not demonstrate GenClass, or send nothing).

## 1. Versions and commits

| what | version |
|---|---|
| prometheus/prometheus | `main` at `4a933f89fa96c56ad69e7c02dc5f40e06d93440e` (2026-11-03 16:21 UTC), cloned `--depth 50` to `~/targets/prometheus-mantine-ui` |
| UI | `web/ui/mantine-ui` (`@prometheus-io/mantine-ui` 0.315.1): React 19.3.1, Mantine 9.7.3, TanStack Query 5, Vite 8.3.4, Vitest 5 |
| server | Prometheus 3.15.1 release binary (`prometheus-3.15.1.linux-amd64.tar.gz`, revision bae3ece) |
| Node, pnpm | Node 22.23.4 (the repository's `web/ui/.nvmrc` pins 24.21.0; `scripts/check-node-version.sh` only warns, and Vite 8 and Vitest 5 accept 22.12+), pnpm 10.28.0 |
| browser | Playwright's Chromium 153.0.8010.12, headless |
| GenClass | this repository at `c1c9e14`: `packages/runtime` 0.3.0-beta.5 (`dist/` built here), `packages/mcp` 0.2.1 (`serve()` in-process) |
| related upstream | open PR #20279 "ui: respect evaluation time in Explain and query tree" (2026-11-02), which changes the same query key; read at its head `126004d` |

## 2. Running the UI

```bash
git clone --depth 50 https://github.com/prometheus/prometheus.git ~/targets/prometheus-mantine-ui
cd ~/targets/prometheus-mantine-ui/web/ui
pnpm install --frozen-lockfile        # 9.5 s
pnpm run build:module                 # lezer-promql and codemirror-promql, imported by mantine-ui
# the server, without Go:
mkdir -p ~/targets/prom && cd ~/targets/prom
curl -sSLO https://github.com/prometheus/prometheus/releases/download/v3.15.1/prometheus-3.15.1.linux-amd64.tar.gz
tar xzf prometheus-3.15.1.linux-amd64.tar.gz && cd prometheus-3.15.1.linux-amd64
./prometheus --config.file=<this repo>/docs/adoption/hunts/prometheus-mantine-ui/prometheus.yml \
  --web.enable-admin-api --storage.tsdb.path=$HOME/targets/prom/data
# the UI under test: a production build served by vite preview (its proxy sends /api and /-/ to :9090)
cd ~/targets/prometheus-mantine-ui/web/ui/mantine-ui && npx vite build && npx vite preview --port 4173 --strictPort
```

Setup took about 15 minutes. The config in [prometheus-mantine-ui/prometheus.yml](prometheus-mantine-ui/prometheus.yml)
scrapes the server itself under four jobs (`prometheus`, `self-a`, `self-b`, `down-only`, with five unreachable
targets), so the Targets and Service discovery pool select has pools to switch between, and loads
[rules.yml](prometheus-mantine-ui/rules.yml) (three alerts, one recording rule). No database, no seed step, no login.

**Why a production build.** The dev server (`pnpm start`, port 5173) renders under `React.StrictMode`
(`src/main.tsx` L10), which mounts every component twice in development: on the dev server the tree's leaf queries
went out three times each and the table's twice, with the extra ones aborted (measured with the plain request log of
section 8). A hunt there would measure React's development checks. Every number below is from `vite preview` of
`vite build`, where StrictMode does nothing.

## 3. Attaching GenClass without touching Prometheus

[prometheus-mantine-ui/hunt.mjs](prometheus-mantine-ui/hunt.mjs) follows the Gitea and Ghost harnesses: it starts
`@genclass/mcp`'s `serve()` in-process and talks to it over JSON-RPC `tools/call`; in Playwright it routes the virtual
same-origin path `/__genclass/*` to `packages/runtime/dist/`, sets `window.GENCLASS_CONFIG = { telemetry: false, mode:
"observe", model: false, devtools: false, visual: false, analytics: false, report: "silent", autoState: false }` and the
bridge URL from an init script, and rewrites each HTML document of the app so its `<head>` starts with the script-tag
build, the mirror atom below and `connectAgent(window.GenClass.runtime, { url })`. Each load is a fresh browser context
with the `local-network-access` permission. React state discovery is off (`autoState: false`), for the reasons the
Ghost report gives (section 8 there).

**The mirror atom.** The UI exposes neither its Redux store nor its TanStack Query client on `window`, so the
injected script registers `rt.atom("prom", ...)` and keeps it current from DOM mutations (coalesced per frame) with
only what a reordering could corrupt and what does not move with the clock: the tree view's nodes (operator text,
result count, label cardinalities; not the per-node response time), the table's series labels and "Result series"
count (not the sample values, which change every scrape, nor the load time), the graph legend's series and the range
field, the expression input's text, the Targets/Service discovery pools with their "n / m up" counts, and the delete
form's alerts. That is the state explore compares, next to the page text, form values and request counts it always
compares.

**Oracles, per load** (in every result file, `prometheus-mantine-ui/results/*.json`):

1. *explore*: GenClass's verdict as `genclass_explore report` printed it, nothing removed;
2. *reference*: after `whenSettled`, the harness reads the same regions itself and compares them with a **reference
   load**: a fresh page without GenClass opened directly at the scenario's final URL (for example
   `/query?g0.expr=<final expression>&g0.show_tree=1`) right after; for "format" the reference is the server's own
   `/api/v1/format_query` of the final draft, for "delete" one `POST` and the success alert.

**Without GenClass** (`--plain`): the same steps, no injection, and a Playwright route that holds the superseded
request(s) of the scenario 900 ms (the first expression's node queries, the first table query, the first range
query, the first format call, the first pool's `/targets`, the delete `POST`), so the newer response arrives first.
Same reference oracle, 8 loads per scenario.

## 4. Scenarios

Each is one page load per run, the same steps every time, at Playwright's pace (CodeMirror is filled with
select-all, Backspace and `insertText`).

| id | scenario | steps | what overlaps on the wire |
|---|---|---|---|
| tree | tree view under an expression change | open `/query` with `rate(process_cpu_seconds_total[1m]) * on(instance, job) group_left(version) prometheus_build_info` and the tree shown; as soon as the root node renders, replace the expression with `sum by (job) (up) + count by (job) (go_goroutines)` and Execute | the first tree's per-node `/query` requests (five nodes, leaves first), the first table query, `/parse_query` for the second expression, the second tree's node queries and table query |
| table | two executions back to back | open `/query` with `up` on the Table tab; Execute `count by (job) (up)`, then at once `sum by (job) (up == 0)` | three `/query?...&time=...&stats=true` |
| graph | execution then range change | open `/query` with `up` on the Graph tab (range 1h); Execute `count by (job) (up)`, then click "Decrease range" (30m) | three `/query_range` (old expression, new expression at 1h, at 30m) |
| format | format, edit, format | open `/query`; type `sum   by(job)(up)`, "Format expression" from the query options menu, replace the draft with `count by(  instance )( go_goroutines )`, format again | two `/format_query` |
| targets | pool select twice | open `/targets`; pick `self-a`, then `self-b` | `/targets?scrapePool=self-a`, `...=self-b` |
| sd | pool select twice | the same on `/service-discovery` | the same two |
| delete | double-click | open `/tsdb-status`, type `go_gc_duration_seconds{job="self-a"}` in "Series selector(s)", double-click "Delete series" | `POST /api/v1/admin/tsdb/delete_series` (one or two) |

The brief's other surfaces were read, not run, and section 7 says why each cannot race on the wire: the Alerts and
Rules pages filter on the client from one request; the notifications provider; the metrics explorer and its labels
view; the PromQL autocomplete.

## 5. Results

RESULTS_TABLE

"forced holds" counts responses the schedule released only because their hold ran out (summed over the session's 8
loads); every response was still delivered unchanged. Section 9 explains why there are so many.

## 6. What explore reported, and what it was

RESULTS_EXPLORE

## 7. Why the UI did not race

- **Tree view.** Every Execute remounts the whole tree: `QueryPanel.tsx` L123 wraps it in
  `<ErrorBoundary key={retriggerIdx}>` and the Execute handler increments `retriggerIdx` (L101). An expression
  changed by the URL (back/forward, `QueryPage.tsx` L29-38) replaces the panels with new ones from
  `newDefaultPanel()`, whose `id` is a fresh `randomId()` (`queryPageSlice.ts` L79), and `<Panel key={p.id}>`
  (`QueryPage.tsx` L119-120) remounts them. So no `TreeNode` instance survives an expression change, and the brief's
  open lead (the per-node key `[useId()]` omits the node's query, `TreeNode.tsx` L129-136) cannot show one node's
  answer under another expression. The tree scenario's 24 explore loads and 8 plain loads agree. The lead does
  matter once the key's identity is relied on across renders, which is what open PR #20279 starts doing (it adds the
  query and the evaluation time to the key, so a node re-queries when the evaluation time changes without
  remounting); the duplicate request of section 8 comes from the same line.
- **Table and graph.** Each execution is its own TanStack Query cache entry (`TableTab.tsx` L35-54 keys on
  `[useId(), "/query", expr, endTime, retriggerIdx]`; `Graph.tsx` L71-103 on the expression, end, range and step),
  a component observes only its current key, and the query function passes TanStack's `signal` to `fetch`
  (`api/api.ts` L64-71), so a superseded request is aborted and its answer, if it still arrives, lands in a cache
  entry nobody shows. `QueryLifecycle.test.tsx` L181 already asserts the abort. The graph's `keepPreviousData` shows
  the previous key's data only until the new one answers.
- **Format.** `ExpressionInput.tsx` L115-160: `handleFormat` takes a generation number before `refetch` and drops the
  answer when the draft (`updateDraft`) or the executed expression changed meanwhile.
- **Targets and Service discovery.** The pool's targets come from `useSuspenseAPIQuery` keyed on `[path, params]`
  with the pool in the params (`ScrapePoolsList.tsx` L144, `ServiceDiscoveryPoolsList.tsx` L182): one cache entry per
  pool, and the component suspends until the current pool's entry has data.
- **Delete series.** `TSDBStatusPage.tsx` L82-134 sets `deleting` before its `fetch`, and the button has
  `loading={deleting}` (L336), which Mantine renders disabled. React re-renders synchronously after a click (a
  discrete event), so the second click of a double-click lands on a disabled button: one `POST` in every load. The
  server's delete is idempotent anyway.
- **Read, not run.** Alerts and Rules: one suspense query each, filters and search applied in the browser (no request
  to reorder). `NotificationsProvider.tsx`: one SSE stream (`fetchEventSource`, messages handled in order) and a
  polling fallback that is one TanStack query (an interval refetch never overlaps its own in-flight request).
  `LabelsExplorer.tsx` L103: `/series` keyed by the matchers, same reasoning as the table. The PromQL autocomplete
  (`web/ui/module/codemirror-promql`) caches and aborts its own requests, and CodeMirror drops completions whose
  context no longer applies; not exercised here (time-boxed).

## 8. One defect that is not a race: the tree view sends each leaf's query twice

**What.** Opening the query page with the tree view shown sends each leaf node's `/api/v1/query` twice; the first
request of each is aborted. [prometheus-mantine-ui/requests.mjs](prometheus-mantine-ui/requests.mjs) (plain
Playwright, nothing injected or delayed) opens
`/query?g0.expr=sum by (job) (up) + count by (job) (go_goroutines)&g0.show_tree=1` 8 times and counts the tree's
requests ([summaries/requests-unfixed.json](prometheus-mantine-ui/summaries/requests-unfixed.json),
[requests-fixed.json](prometheus-mantine-ui/summaries/requests-fixed.json)):

| build | loads | tree nodes | tree requests per load | aborted, all loads |
|---|---|---|---|---|
| `main` (4a933f8), `vite preview` | 8 | 5 | 7 (in 8 of 8 loads) | 16: `up` and `go_goroutines`, once per load each |
| with the patch, `vite preview` | 8 | 5 | 5 (in 8 of 8 loads) | 0 |

**Root cause.** `TreeNode.tsx` L129-137 calls `useAPIQuery({ key: [useId()], path: "/query", ... })` with `useId`
imported from `@mantine/hooks` (L33). Mantine 9.7.3's `useId` (`@mantine/hooks/esm/use-id/use-id.mjs`) starts with
`mantine-${React.useId()}` and calls `setUuid(randomId())` in a layout effect after mount. A leaf node's query is
enabled at once (`mergedChildState` is `"success"` with no children), so the observer subscribes and fetches under
the first key, then the re-render switches it to the random key: a second fetch, and TanStack aborts the first
because its query function consumed the `signal` (and `gcTime` is 0). Inner nodes wait for their children and
fetch after the id settled, so they send once. The same hook gives the node id used for selection (L76), so the
root's "select me on mount" effect (L89-93) runs twice, and the Explain tab's `ErrorBoundary key={selectedNode?.id}`
(`QueryPanel.tsx` L352-353) sees two ids (read in the code; not measured).

**Fix.** Import `useId` from React instead (stable from the first render; `TableTab.tsx` and `Graph.tsx` already use
React's): two lines in `TreeNode.tsx`. The node id only has to be unique among the tree's nodes, which React's id is.

**Test.** `web/ui/mantine-ui/src/pages/query/TreeNode.test.tsx` (new, in `QueryLifecycle.test.tsx`'s style: `fetch`
stubbed with `vi.stubGlobal`, the signals kept): renders a leaf `TreeNode` for `up` and asserts one request whose
signal is not aborted. On `main`: fails 3 of 3 (`expected [ AbortSignal { aborted: true }, …(1) ] to have a length of
1 but got 2`); with the fix: passes 3 of 3. The whole UI suite with the patch: `CI=true pnpm --filter
@prometheus-io/mantine-ui exec vitest run`: 18 files, 208 tests passed; `eslint` and `prettier --check` on both files
clean; `tsc --noEmit -p .` clean. The patch is 59 changed lines (under the PR triage board's 60-line "Quick Wins").

**PR #20279.** Open since 2026-11-02, by another contributor: it changes this key to `[useId(), query, endTime]`
and keeps Mantine's hook, so the duplicate stays. The patch applies cleanly on its head (`126004d`); there, with the
test given `endTime={null}` (the PR adds that prop), the test fails without the fix and passes with it.

**Is it worth sending?** It is a small, real, measured inefficiency with a two-line fix and a test, in the shape the
maintainers ask for. It is not a race, and GenClass did not find it as one: explore's reports list `requests sent to
"GET /api/v1/query"` among the "internal state only" differences in every tree session (the count differs between
runs because whether the doomed first request leaves the browser before its abort depends on timing), which is a hint
at best; the plain request log made it plain. Sending it would be ordinary good-citizen work with a one-sentence
disclosure, not a demonstration of GenClass. Hence "needs owner decision".

## 9. Problems with GenClass itself

PROBLEMS

## 10. Time spent

TIME

## 11. Reproducing

```bash
# this repository, both packages built (docs/adoption/swarm.md section 3); Prometheus and `vite preview` as in section 2
node docs/adoption/hunts/prometheus-mantine-ui/hunt.mjs tree --slow 600 --runs 6 --seed 1   # one explore session
node docs/adoption/hunts/prometheus-mantine-ui/hunt.mjs tree --plain --runs 8 --delay 900    # the same without GenClass
docs/adoption/hunts/prometheus-mantine-ui/run-all.sh                                         # every session (about 1 h)
node docs/adoption/hunts/prometheus-mantine-ui/summarise.mjs                                 # the table of section 5
node docs/adoption/hunts/prometheus-mantine-ui/requests.mjs --app http://localhost:4173      # section 8, per build
# the patch and its test, in the Prometheus clone:
cd ~/targets/prometheus-mantine-ui && git apply <this repo>/docs/adoption/hunts/prometheus-mantine-ui.patch
cd web/ui && pnpm --filter @prometheus-io/mantine-ui exec vitest run src/pages/query/TreeNode.test.tsx
```
