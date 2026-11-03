# Race hunt: Memos (main@b40d8a7, 26.11.1-dev)

A GenClass race hunt on Memos' web app, run on 2026-11-03 in a cloud session, with the real `@genclass/runtime`
(0.3.0-beta.5, this repository at `c1c9e14`) injected into the app by Playwright and the real `@genclass/mcp` (0.2.1)
driven the way a coding agent drives it. Memos' source was not modified for the hunt; the fix is a patch for its
maintainers (`memos.patch`, the issue and pull request drafts in `memos-issue.md`). Nothing was sent to Memos'
repository, discussions or maintainers.

**Status: ready to send** (after the by-hand items in `memos-issue.md`, "Before sending").

**Headline.** Two real races of one kind, both found by `genclass_explore` and both reproduced without GenClass: a
reply that is older than the page's data is written over it, and stays.

1. **Two quick updates of one memo** (`useUpdateMemo`): Pin then Unpin, or "Check all tasks" then "Uncheck all
   tasks", from the memo's More menu on its detail page. When the first reply arrives last, the page shows the first
   change (pinned; all tasks checked) while the server saved both in order and holds the second. Explore: the page
   disagreed with the server in 5 of 18 reordered pin loads and 1 of 18 task loads, 0 of 12 request-order baselines;
   GenClass's verdict named the task case as a RACE on the checkboxes, and reported the pin case as "internal state
   only" (the pinned mark has no text, section 6). Without GenClass, holding the first `UpdateMemo` reply 1.5 s: 10 of
   10 trials showed the memo pinned, still pinned 30 s later; 0 of 3 without the hold.
2. **Two quick reactions** (`useReactionActions`): 👍 then ❤️. The 👍 click's own `getMemo`, answered before ❤️ was
   saved, lands last and removes ❤️ from the page; the server has both. Explore: RACE in 1 of 6 reordered loads at
   300 ms (the page text lost "❤ 1"), 0 of 6 baselines. Without GenClass, holding the replies to the `GetMemo`
   requests sent between the 👍 reply and the ❤️ upsert: 10 of 10 trials lost ❤️, still lost 30 s later in 10 of 10;
   0 of 3 without the hold.

The patch has two commits, 13 changed lines of source and three Vitest tests that fail on main and pass with the fix
(3 runs each way); Memos' `pnpm lint` and `pnpm test` (193 files, 1,619 tests) pass. On the fixed build the
GenClass-free reproductions showed the stale state in 0 of 10 (pin) and 0 of 10 (reactions) trials, and
explore's oracle in ⟨EF⟩ of ⟨EFN⟩ reordered loads (section 5.3).

The comment surface showed no order-dependent page. Archive then Restore on the detail page ends on a page that
depends on the reply order (section 4.3). Of GenClass's own verdicts on the 12 complete unfixed sessions outside
archive, 2 were true races (tasks 900, reaction 300), 5 were false RACE verdicts resting only on request counts, and
5 said no race; in 3 of the pin sessions marked "no race" or false, the stale pin was there but listed as internal
state. The false ones have one cause: Memos' API is Connect RPC, which sends reads (`GetMemo`, `ListMemoComments`,
`GetUserStats`) as POST, and explore counts a different number of POSTs as a different number of writes (section 6,
item 1).

Sections: 1 setup, 2 how the app was driven, 3 scenarios and verdicts, 4 the findings, 5 fix and tests,
6 problems with GenClass itself, 7 duplicates and policy, 8 time spent, 9 reproducing.

## 1. Setup

| what | version |
|---|---|
| Memos | `usememos/memos` main at `b40d8a7b573774c52b022c8d6537d6baf2129dc0` (2026-11-01, "fix(cmd): warn about legacy-named identity provider files in /etc/secrets"), reported as `26.11.1-dev.b40d8a7`; database schema 26.10.1 |
| backend | Go 1.27.2 (the toolchain `go.mod` names, downloaded by `GOTOOLCHAIN=auto`), SQLite, `--port 8081 --data ~/targets/memos-data` |
| frontend | Vite 8.0.11 dev server on :3001 (unfixed) and a second one on :3002 from a worktree with the patch, both proxying to the same backend; React 19.2.6, `@tanstack/react-query` 5.100.9, Vitest 4.1.5 |
| Node, pnpm | 24.22.2 (the web app's `engines` requires >= 24; the image has 22, so a Node 24 tarball was unpacked under `~/targets/node24`), pnpm 11.0.1 (`packageManager`) |
| browser | Chromium 153.0.8010.12 (headless shell), Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Node 24 next to the image's Node 22 (pnpm refuses the install on the engines field otherwise)
curl -fsSL -o node24.tar.xz https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz && tar xf node24.tar.xz
export PATH=~/targets/node24/bin:$PATH && npm i -g pnpm@11.0.1

# Memos, outside this checkout
git clone https://github.com/usememos/memos.git ~/targets/memos && cd ~/targets/memos   # b40d8a7b5
go mod download && go build -buildvcs=true -o ~/targets/memos-bin ./cmd/memos
~/targets/memos-bin --port 8081 --data ~/targets/memos-data &
cd web && pnpm install && pnpm dev &                     # :3001
# the fixed variant: a worktree with memos.patch applied, its own pnpm install, pnpm dev --port 3002

# seed: the owner account through /auth/signup, the two race memos and filler memos
node docs/adoption/hunts/memos/setup.mjs
```

The seeding: `setup.mjs` signs up the owner `hunter` on the fresh instance's `/auth/signup` page, then creates memos
over the app's own Connect JSON API from the signed-in page. Its first two runs stopped at the server's write limit
(HTTP 429, `RATE_LIMITED`, 120 writes per user per minute) after creating about 240 filler memos; the script now waits
out the window. The instance holds about 240 "filler memo N #seed" memos, "race tasks memo" (three unchecked tasks),
"race target memo for pin, archive and reactions", and "repro pin memo" (a second target, for the GenClass-free
scripts).

## 2. How the app was driven

`docs/adoption/hunts/memos/explore.mjs` (the Gitea harness's pattern, `../gitea-explore.mjs`):

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js`, bridge on a free port, no state directory;
  `genclass_clear`, `genclass_explore start` (`runs: 6`, `slow_ms` 300, 600 and 900), `genclass_explore report`,
  `genclass_explain` on the first finding and `genclass_findings`, called over JSON-RPC as an agent calls them.
- **Injection without touching Memos.** A Playwright route rewrites the SPA's HTML (Vite's dev server) to load
  `packages/runtime/dist/genclass.global.js` from a virtual same-origin path with `GenClass.init({ model: false,
  telemetry: false, report: "silent" })`, and `dist/agent.js` in a module script that calls `connectAgent`. Each
  context gets the `local-network-access` permission. GenClass discovered React component state on its own (fields
  such as `MemoEditorView.external0.pinned`, `AppSidebarProvider.state2.memo.reactions`); TanStack Query's cache is
  not discovered. The injected script also mirrors what the memo card shows without text of its own into
  `rt.atom("memoCard", { pinned, tasks, path })` from a MutationObserver.
- **Same start every load.** Before each load the harness signs in over the API in its own request context and
  resets the two race memos (unpinned, NORMAL, no reactions, tasks unchecked, no comments), so every load starts from
  the same server state. The page is the memo's detail page, `/memos/<uid>`.
- **The steps** (two writes each, at Playwright's pace): pin (More > Pin, More > Unpin), archive (More > Archive, More >
  Restore), tasks (More > Check all tasks, More > Uncheck all tasks), reaction (hover, Add reaction > 👍, Escape, hover,
  Add reaction > ❤️), comment (Write a comment > "comment first" > Comment, then "comment second"). After the steps:
  `whenSettled(15000)`, 2.5 s more (past the refetches the SSE `memo.changed` event triggers), then the **oracle**:
  what the page shows (pinned mark, checkbox states, reaction pills, comment texts, end page) next to `GetMemo` /
  `ListMemoComments` from the server. "DIFFER" in the load lines means the page disagrees with the server.
- **The live refresh is left on.** Memos' `useLiveMemoRefresh` streams `/api/sse` through `fetch` and invalidates every
  memo query on each write. Its refetches are part of every load (the `GetMemo#2`, `#3` in the delivery orders), and
  explore reorders their replies like any other; a stale state counted here outlived them.

## 3. Scenarios and verdicts

Unfixed build. "Oracle" counts loads whose page disagreed with the server, out of the 6 seeded loads (and of the 2
request-order baselines). Summaries: `memos/results/unfixed/*-summary.json`; the full reports of the two finding
sessions and of pin at 600 ms are next to them.

| surface | slow_ms | oracle: seeded / baselines | GenClass verdict | what the verdict rested on |
|---|---|---|---|---|
| pin | 300 (first run) | 2 of 6 / 0 of 2 | no race; "internal state only" 5 of 6 | `memoCard.pinned` and `MemoEditorView.external0.pinned` "false" → "true" listed as internal; witnesses `overwrote-newer memoCard.pinned by POST .../UpdateMemo` |
| pin | 300 | 0 of 6 / 0 of 2 | no race | |
| pin | 600 | 2 of 6 / 0 of 2 | RACE 1 of 6 (false) | the count of `ListMemoComments` POSTs (3 vs 2); the two stale runs listed under "internal state only" |
| pin | 900 | 3 of 6 / 0 of 2 | no race | the stale runs under "internal state only" |
| tasks | 300 | 0 of 6 / 0 of 2 | no race | |
| tasks | 600 | 0 of 6 / 0 of 2 | no race | |
| tasks | 900 | 1 of 6 / 0 of 2 | **RACE 1 of 6 (true)** | fields "first task", "second task", "third task": baseline "unchecked", this run "checked" |
| reaction | 300 | 1 of 6 / 0 of 2 | **RACE 1 of 6 (true)** | page text only in the baseline: "1", "❤" |
| reaction | 600 | 0 of 6 / 0 of 2 | RACE 6 of 6 (false) | counts of `ListMemoComments` POSTs |
| reaction | 900 | 0 of 6 / 0 of 2 | no race | |
| comment | 300 | 0 of 6 / 0 of 2 | RACE 4 of 6 (false) | counts of `GetUserStats` POSTs |
| comment | 600 | 0 of 6 / 0 of 2 | RACE 5 of 6 (false) | counts of `GetUserStats` POSTs |
| comment | 900 | 0 of 6 / 0 of 2 | RACE 6 of 6 (false) | counts of `GetUserStats` and `ListMemoComments` POSTs |
| archive | 300, 600, 900 | see section 4.3 | ⟨archive verdicts⟩ | |

The first pin session's report file was overwritten by the batch's 300 ms session; its eight load lines are in this
session's log (loads 3 and 5 DIFFER, both with `UpdateMemo#1` delivered after `UpdateMemo#2`). Two void sessions are
not in the table: the first reaction session (the "Add reaction" button only appears on hover, every load timed out
before a write; GenClass still said "RACE 1 of 6", on a `GetMemo` count) and the first comment session (the comment
editor is a `contenteditable`, not a textarea; every load timed out). Both were fixed in the harness and run again.

Every DIFFER load on pin and tasks has the first `UpdateMemo` delivered after the second; no load with the replies in
request order differed. The pin and task scenarios are the same mutation, so their rates differ only by when the
second click lands (the task menu item is offered later, after the toast; in the tasks sessions the second update was
sent 0.9 s after the first, and only the 900 ms holds crossed them).

## 4. The findings

### 4.1 Two quick updates of a memo (pin, tasks)

What explore saw, the tasks session at 900 ms, run r21 (seed 3), quoted from `genclass_explain f19`
(`memos/results/unfixed/tasks-900.txt`):

```
+3.390s action 1: click menuitem "Check all tasks"
+3.404s write MemoEditorView.external0.content by action 1: "…- [ ] first task…" → "…- [x] firs…"
+3.407s send POST /memos.api.MemoService/UpdateMemo#1 "126 bytes" (action 1)
+3.426s send POST /memos.api.MemoService/GetMemo#2 "30 bytes" (action 1) via timer 0ms
+3.982s delivered POST /memos.api.MemoService/GetMemo#2 (held 544 ms)
+4.311s action 3: click menuitem "Uncheck all tasks"
+4.331s write MemoEditorView.external0.content by action 3: "…- [x] first task…" → "…- [ ] firs…"
+4.334s send POST /memos.api.MemoService/UpdateMemo#2 "126 bytes" (action 3)
+4.356s send POST /memos.api.MemoService/GetMemo#3 "30 bytes"
+4.965s delivered POST /memos.api.MemoService/GetMemo#3 (held 599 ms)
+5.085s delivered POST /memos.api.MemoService/UpdateMemo#2 (held 727 ms)
+5.122s delivered POST /memos.api.MemoService/UpdateMemo#1 (held 1.7 s)
+5.123s write MemoEditorView.external0.content, …property.hasIncompleteTasks, …updateTime.seconds by POST …/UpdateMemo#1
+5.125s write memoCard.tasks by POST /memos.api.MemoService/UpdateMemo#1: "memoCard.tasks: \"___\" → \"xxx\""
```

The verdict: "field "first task": baseline "unchecked", this run "checked"" for the three tasks; the oracle: shown
`xxx`, server `___`. `GetMemo#3` is the live refresh's refetch after the second write; it was answered before the late
reply, so nothing corrected the page afterwards. The pin runs have the same shape (`UpdateMemo#2` then
`UpdateMemo#1`, the witnesses `overwrote-newer memoCard.pinned by POST /memos.api.MemoService/UpdateMemo` and
`overwrote-newer MemoEditorView.external0.pinned`).

**Reproduction without GenClass** (`memos/repro.mjs --surface pin`, plain Playwright, nothing injected): a
`page.route` lets every request reach the server at once and holds only the reply to the first `UpdateMemo` for
1,500 ms; the page is read 3 s after that reply is delivered and 30 s later, next to `GetMemo`:

```
pin, unfixed, held 1500 ms:  pinned shown, server unpinned in 10 of 10 trials; 30 s later: 10 of 10
pin, unfixed, held 0 ms:     0 of 3
```

**Root cause** (lines at `b40d8a7b5`): `web/src/hooks/useMemoQueries.ts`, `useUpdateMemo` (line 326). Both
mutations run at once; `onMutate` (line 344) cancels memo queries and applies the optimistic patch, then `onSuccess`
(line 368) writes the server's reply into `memoKeys.detail` (line 373) and patches every collection, whenever the
reply arrives, with no check for a newer update of the same memo. It then invalidates the lists, comments, stats and
attachments, not the memo's own detail query, which the detail page reads (`pages/MemoDetail.tsx`, `useMemo(name)`;
`staleTime` 10 s). The callers are `web/src/components/MemoActionMenu/hooks.ts`: `handleTogglePinMemoBtnClick` (line
66), `handleToggleMemoStatusClick` (line 84), `updateMemoContent` (line 41, check all / uncheck all). The editor's
save also uses `useUpdateMemo` but is guarded against a double submit (`EditSession.tsx`, `isLoading.saving`), so it
was not a scenario.

### 4.2 Two quick reactions

What explore saw, the reaction session at 300 ms, run r3 (seed 1), from `genclass_explain`
(`memos/results/unfixed/reaction-300.txt`):

```
+1.945s action 1: click button "👍"
+1.946s send POST /memos.api.MemoService/UpsertMemoReaction#1 "38 bytes" (action 1)
+1.979s send POST /memos.api.MemoService/GetMemo#2 "30 bytes"
+2.011s delivered POST /memos.api.MemoService/UpsertMemoReaction#1 (held 31 ms)
+2.012s send POST /memos.api.MemoService/GetMemo#3 "30 bytes" (action 1) via POST /memos.api.MemoService/UpsertMemoReaction
+2.061s action 3: click button "Add reaction"
+2.146s action 4: click button "❤"
+2.147s send POST /memos.api.MemoService/UpsertMemoReaction#2 "40 bytes" (action 4)
+2.157s send POST /memos.api.MemoService/GetMemo#4 "30 bytes"
+2.273s delivered POST /memos.api.MemoService/GetMemo#4 (held 109 ms)
+2.276s write MemoEditorView.external0.reactions by …/GetMemo#4: "0 items → 2 items …"
+2.304s delivered POST /memos.api.MemoService/UpsertMemoReaction#2 (held 145 ms)
+2.304s send POST /memos.api.MemoService/GetMemo#5 "30 bytes" (action 4) via POST /memos.api.MemoService/UpsertMemoReaction
+2.359s delivered POST /memos.api.MemoService/GetMemo#5 (held 44 ms)
+2.389s delivered POST /memos.api.MemoService/GetMemo#3 (held 368 ms)
+2.390s write MemoEditorView.external0.reactions by …/GetMemo#3: "2 → 1 items: removed 1 item"
+2.420s delivered POST /memos.api.MemoService/GetMemo#2 (held 432 ms)
```

`GetMemo#3` is the 👍 click's own fetch (sent "via UpsertMemoReaction"), answered before ❤️ was saved, delivered
after `#4` (the live refresh's refetch) and `#5` (the ❤️ click's fetch), both of which had two reactions; it removed
❤️. `GetMemo#2`, the live refresh's refetch from before the ❤️ write, was delivered even later and wrote nothing:
React Query had cancelled it when `#4` started. That is the difference the fix uses.

**Reproduction without GenClass** (`memos/repro.mjs --surface reaction`): the route holds, for 1,500 ms, the replies to
every `GetMemo` sent after the 👍 upsert's reply and before the ❤️ upsert (the click's own fetch and any live-refresh
refetch in that window); between the clicks the script waits 300 ms and opens the picker again:

```
reaction, unfixed, held 1500 ms:  ❤️ missing, server 👍 + ❤️ in 10 of 10 trials; 30 s later: 10 of 10 of 10
reaction, unfixed, held 0 ms:     0 of 3
```

(The script's first version held only the first `GetMemo` after the upsert, which in all 10 trials was the live
refresh's refetch, not the click's fetch: 0 of 10. React Query cancelled it, as in the explore run above. The second
version holds the window.)

**Root cause**: `web/src/components/MemoReactionListView/hooks.ts`, `handleReactionClick` (line 43): after the upsert or
delete it calls `memoServiceClient.getMemo` itself (line 59) and writes the reply with
`queryClient.setQueryData(memoKeys.detail(memo.name), updatedMemo)` (line 60). Two clicks give two such fetches that
React Query does not know about, so neither cancels the other, and the later-arriving one wins whatever it holds.
The server deduplicates nothing here, but a duplicate is not possible either: `reaction` has
`UNIQUE(creator_id, memo_id, reaction_type)` (`store/migration/sqlite/LATEST.sql`), so a double click on one emoji
fails its second insert and the client swallows the error.

### 4.3 Archive then Restore (not in the patch's tests)

On the detail page, `handleToggleMemoStatusClick` navigates after each reply: to the Archived page after Archive, home
after Restore (line 107, with the memo state captured at the click). With both in flight, the last reply decides the
page. Unfixed, first oracle (end page only): at 600 and 900 ms the request-order baselines ended home in 4 of 4 loads,
and the seeded loads ended on `/archived` (while the memo was restored, so the page says "No data found") in 3 of 5 and
4 of 6; at 300 ms the archive reply often arrived before the second click, the Restore click then happened on the
Archived page's card (no navigation) and the baselines too ended on `/archived`. GenClass's verdicts here ("RACE 3 of 5",
"3 of 5", "5 of 6") mixed that end page with request counts and an `AbortError: Transition was skipped` page error that
the double navigation raises in one run. ⟨archive rerun with the corrected oracle, unfixed and fixed⟩

### 4.4 Comments

Two comments in a row, each after the editor closed: 0 of 18 seeded loads lost or duplicated a comment. The editor's
save is guarded; `useCreateMemo` invalidates the comment list, and React Query's own refetches cancel each other.

## 5. Fix and tests

### 5.1 The fix (`memos.patch`, two commits against `b40d8a7b5`)

1. `fix(web): keep the newer memo update when two updates of a memo overlap` (`useMemoQueries.ts`, 10 added lines):
   `useUpdateMemo` gets `scope: { id: "memo-update" }`, React Query's mechanism for running mutations of one scope one
   at a time, in order. `onMutate` still runs on the click (React Query dispatches it before waiting for the scope,
   `query-core` 5.100.9 `mutation.ts` lines 206 to 222), so the optimistic patch appears at once as before. In
   `onSuccess`, an update whose memo has a newer update still pending (`queryClient.isMutating` with a predicate on
   the memo name, more than itself) returns before writing its reply or refetching, so the newer optimistic patch is
   not overwritten for the time the newer update takes; the newer update's `onSuccess` writes and refetches. The
   `space` invalidation stays before that return.
2. `fix(web): refetch a memo's reactions through its query` (`MemoReactionListView/hooks.ts`, 3 lines changed): the
   click awaits `queryClient.invalidateQueries({ queryKey: memoKeys.detail(memo.name) })` instead of `getMemo` +
   `setQueryData`. A newer refetch of the query cancels an older one in flight, so an older reply cannot land after a
   newer one. Where no detail query is observed (a card in a list), nothing is fetched for the detail; the lists'
   invalidation, already there, refreshes the card.

No new dependency, no new module, no generated file, no server change.

### 5.2 Tests

`web/tests/memo-record.test.tsx`, new `describe("useUpdateMemo")`, two tests in the file's style (`vi.hoisted` mock of
`@/connect`, a `QueryClientProvider` wrapper, `renderHook`, `act`): pin then unpin with the replies answered newest
first ("keeps the newer change when the older reply arrives last") and oldest first ("does not show the older reply
while the newer update is still saving"). `web/tests/reaction-actions.test.tsx`, new: the detail query observed, 👍 then
❤️, the second refetch answered before the first.

```
unfixed (source reverted, tests kept), 3 runs each:
  memo-record.test.tsx       2 failed: AssertionError: expected true to be false (pinned)   3 of 3 runs
  reaction-actions.test.tsx  1 failed: expected [ '👍' ] to deeply equal [ '👍', '❤️' ]       3 of 3 runs
fixed, 3 runs each:          12 passed (memo-record), 1 passed (reaction-actions)            3 of 3 runs
cd web && pnpm lint          tsc --noEmit and Biome: "Checked 674 files ... No fixes applied."
cd web && pnpm test          Test Files 193 passed (193), Tests 1619 passed (1619)
```

### 5.3 The fixed variant

The second Vite server (:3002) serves the worktree with the patch; same backend, same memos.

```
pin, fixed, held 1500 ms:       0 of 10 trials stale; 30 s later: 0 of 10
reaction, fixed, held 1500 ms:  0 of 10 trials stale; 30 s later: 0 of 10
```

⟨explore on the fixed build⟩

## 6. Problems with GenClass itself

1. **Reads over POST counted as writes (false RACE lines).** Memos' API is Connect RPC: every call, `GetMemo`,
   `ListMemoComments` and `GetUserStats` included, is a `POST /memos.api.<Service>/<Method>`. Explore's visible tier
   counts "the number of unsafe requests (POST, PUT, PATCH, DELETE) to a signature" (AGENT.md section 5.1), so a cache
   that refetches once more or once less (a live-refresh event landing before or after a reply) is reported as a race
   with "requests sent to "POST /memos.api.MemoService/ListMemoComments": baseline "3", this run "2"". 5 of the 12
   complete unfixed sessions outside archive ended with a RACE verdict that rested only on such counts (pin 600,
   reaction 600, comment 300, 600 and 900), and so did the void reaction session; in those RACE runs the oracle said
   the page matched the server, and the counts also appear in the archive verdicts. The same applies to gRPC-Web and to GraphQL queries sent as POST. Suggestion: treat a POST as safe for the
   count when the baselines themselves disagree on its count, or when its body names a read (Connect's
   `Get*`/`List*` procedure names, a GraphQL `query`), or let `genclass_explore start` take a list of safe signatures;
   at least, print the request-count reason apart from page and form differences so a reader can discount it.
2. **A visible state with no text lands in "internal state only".** The pinned mark is
   `<span role="img" aria-label="Pinned">` with no text; explore listed the stale pin as `memoCard.pinned` and
   `MemoEditorView.external0.pinned` under "internal state only" in 4 runs over three sessions, and named no race. The
   witnesses (`overwrote-newer memoCard.pinned by POST .../UpdateMemo`) did point at it, in `genclass_findings` as
   `stale-write` findings. AGENT.md section 8 states this limit. Suggestion: read `aria-label` of `role="img"` and
   `aria-pressed`/`aria-checked` states into the page snapshot, as the task checkboxes' states already are.
3. **Witnesses on UI-library state crowd the findings.** `genclass_findings` lists `stale-write` findings on Base UI's
   menu and popover internals (`MenuPopup.external2.isPending`, `PopoverPositioner.external14`, 12 such lines in the
   reaction session) next to the real one; ids such as `"_r_24_"` differ between baselines and runs.
4. **No settle with a streaming fetch? Not a problem.** Memos keeps `/api/sse` open as a streaming `fetch` for the whole
   page life; every load still "reached a quiet point" (`8 of 8 planned loads recorded (8 reached a quiet point)`).
   Recorded because it was a risk the brief named.
5. **A step that the order makes impossible.** On archive at 300 ms, a fast first reply navigated away before the
   second click, so one load per session timed out and was left out ("3 of 5 compared"); explore handled it, the
   harness had to tolerate it.
6. **Harness items, not GenClass bugs:** the reaction button appears only on hover, the comment editor is a
   `contenteditable`, the server limits writes to 120 per minute per user (the reset waits out a 429), and the first
   pin report file was overwritten by a later session with the same name (the harness names files by surface and
   latency only).

## 7. Duplicates and policy

- Searched on 2026-11-03 with the GitHub search API (`repo:usememos/memos` plus `is:issue pin unpin`,
  `is:issue pinned state wrong`, `is:issue reaction duplicate`, `is:issue "pin" "refresh"`, `is:pr race condition web`):
  nothing on this bug. Nearest: #2952 (closed 2024, a misclick toggling pin on Android Firefox), #4331 (closed 2025, an
  internal error on pin after an upgrade), #4796 (closed, refreshing a memo edited elsewhere, which led to the SSE
  channel).
- Memos has no CONTRIBUTING.md, no pull request template, no CLA or DCO and no AI policy; its `AGENTS.md` addresses
  coding agents (scoped diffs, local patterns, server data in hooks under `web/src/hooks/`, `pnpm lint && pnpm test`
  for frontend changes), which the patch follows. The contributing page (usememos.com/docs/development/contributing)
  asks for scoped changes, the why, tests for behaviour changes and a check for an existing issue (not an issue
  first); the drafts open an issue first anyway, since the bug template exists and the fix touches shared hooks.
  Commit messages follow the repository's `fix(web): ...` style with a prose body.

## 8. Time spent

About ⟨T⟩ of session time, from 16:33 UTC: 15 minutes to read the brief, clone, build the backend, install Node 24 and
the web dependencies; 15 minutes to read the hooks, seed (the write limit cost one rerun) and write the harness; the
first explore session (pin, 300 ms) found the stale pin at 16:42; 10 minutes for the first fix and its tests; 40
minutes of explore sessions on the unfixed build (two void sessions rerun after harness fixes); 15 minutes for the
reaction fix and its test; ⟨rest⟩.

## 9. Reproducing

```bash
# Memos running as in section 1, seeded with setup.mjs; GenClass built
node docs/adoption/hunts/memos/explore.mjs --surface pin --slow 300,600,900 --out /tmp/memos-out
node docs/adoption/hunts/memos/explore.mjs --surface reaction --slow 300,600,900 --out /tmp/memos-out
GENCLASS=0 node docs/adoption/hunts/memos/explore.mjs --surface pin --runs 8          # the same steps, no GenClass
node docs/adoption/hunts/memos/repro.mjs --surface pin --memo memos/<uid> --trials 10    # --delay 0 for the control
node docs/adoption/hunts/memos/repro.mjs --surface reaction --memo memos/<uid> --trials 10
node docs/adoption/hunts/memos/summarise.mjs /tmp/memos-out
# the fixed variant: apply memos.patch in a worktree, pnpm install, pnpm dev --port 3002, then --memos http://localhost:3002
```
