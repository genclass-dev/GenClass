# Draft issue and pull request text for Memos' maintainers

Drafts for the GenClass owner to send, or not. Nothing here has been posted anywhere. Facts and commands are from
`memos.md` in this directory; the patch is `memos.patch` (two commits against `usememos/memos` `b40d8a7b5`, made with
`git format-patch`). Memos has no pull request template and no AI policy; its bug template is
`.github/ISSUE_TEMPLATE/bug_report.yml` (fields below in its order). One issue covers both bugs: they are the same
kind (an older reply written over newer data) in the same part of the web app, and one pull request fixes both, one
commit each.

## Before sending

- [ ] Search the tracker again for duplicates since 2026-11-03 (issues and pull requests): "pin unpin", "pinned",
      "archive restore", "check all tasks", "reaction disappears", "reaction", "race", "out of order",
      "useUpdateMemo". None was found on 2026-11-03 (`memos.md` section 7).
- [ ] Reproduce by hand on a local `main` with the steps below (DevTools: Network, throttling, or the two scripts
      `docs/adoption/hunts/memos/repro.mjs --surface pin|reaction` from this repository), and update the version line
      to the commit you used.
- [ ] Apply the patch to a fresh clone (`git am memos.patch`), re-author the commits as yourself
      (`git rebase -x 'git commit --amend --no-edit --reset-author' HEAD~2`), and read the diff: 10 added lines in
      `useMemoQueries.ts`, 3 changed lines in `MemoReactionListView/hooks.ts`, two tests.
- [ ] Run `cd web && pnpm lint && pnpm test` (Node 24, pnpm 11.0.1), and the two new tests on the unfixed code
      (`git stash` the two source files) to see them fail.
- [ ] Open the issue first, put its number in the pull request's "Fixes #", then open the pull request from your
      fork's branch against `main`.
- [ ] Keep the AI-assistance paragraph; every sentence in it must be true for you.

## Issue

**Title:** Quick second action on a memo can leave the page showing the older state (pin/unpin, check/uncheck all, reactions)

**Check before submitting**

- [x] I searched existing issues and did not find a duplicate

**Describe the bug**

What happened: when two changes to the same memo are made before the first one's reply comes back, the page can end
up showing the first change, while the server saved both in order and holds the second.

- Pin, then Unpin from the memo's "More" menu: the detail page keeps the pinned corner mark; the server has the memo
  unpinned. The same with "Check all tasks" then "Uncheck all tasks" (the checkboxes stay checked) and with Archive
  then Restore on the detail page (it ends on the Archived page while the memo is restored).
- Add a 👍 reaction, then a ❤️: the ❤️ pill disappears; the server has both reactions.

The page stays like that until the memo is fetched again (a reload, a window focus, or the next live-refresh event).

What I expected: the page ends showing the last change I made, which is what the server holds.

Cause, as far as I can tell:

1. `useUpdateMemo` (`web/src/hooks/useMemoQueries.ts`): both updates are sent at once; `onSuccess` writes each reply
   into `memoKeys.detail` and the lists when it arrives. When the first reply arrives last, the older memo is written
   over the newer optimistic state, and nothing refetches the detail afterwards (the lists are invalidated, the
   detail is not). The SSE `memo.changed` refetch does not help when it is answered before that late reply.
2. `useReactionActions` (`web/src/components/MemoReactionListView/hooks.ts`): after the upsert, `getMemo` is called
   directly and its reply is written with `setQueryData`. The first click's `getMemo` was answered by the server
   before the second reaction was saved; when it arrives last it removes the second reaction from the cache.
   React Query's own refetches of that query cancel each other; this direct call is outside them.

**Steps to reproduce**

The replies have to arrive out of order, which a slow or unsteady connection does; to make it deterministic, hold
one reply back (DevTools has no per-request delay, so a Playwright route or a proxy is the simplest way; the script
we used is linked under Additional context).

Pin:
1. Open a memo's detail page (`/memos/<id>`).
2. "More" > "Pin", then right away "More" > "Unpin".
3. Delay the reply to the first `UpdateMemo` (the pin) by about 1.5 s, so it arrives after the second.
4. The memo shows the pinned mark; `GetMemo` (or a reload) says `pinned: false`.

Reactions:
1. Open a memo's detail page, hover the memo, "Add reaction" > 👍.
2. Delay the reply to the `GetMemo` that follows the 👍 upsert by about 1.5 s.
3. While it is held, "Add reaction" > ❤️.
4. The ❤️ pill disappears when the held reply lands; the server has 👍 and ❤️.

With those delays, pin showed the stale state in 10 of 10 trials and reactions in 10 of 10 (0 of 3 each without the
delay); 30 s later it was still shown in all 20.

**Memos version**

main@b40d8a7 (26.11.1-dev.b40d8a7), SQLite, `go run ./cmd/memos` + `pnpm dev`

**Additional context**

Deployment / database / browser: local dev setup from AGENTS.md (backend on :8081, Vite on :3001), SQLite, Chromium
153 (Playwright 1.63).

The reproduction scripts (plain Playwright, nothing injected into the page):
`https://github.com/genclass-dev/GenClass/blob/main/docs/adoption/hunts/memos/repro.mjs`. A fix with regression tests
follows in a pull request.

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.

## Pull request

**Title:** `fix(web): keep the newer state when two changes to a memo overlap`

**Body:**

Fixes #<issue>.

When two changes to the same memo were in flight, the page could end showing the older one (#<issue>): pin then
unpin left the memo pinned on its detail page, check all then uncheck all left the tasks checked, archive then
restore ended on the Archived page, and adding two reactions quickly dropped the second. The server had saved both
changes in order each time; only the client cache held the older state, until the memo was fetched again.

Reproduced on main@b40d8a7 by delaying one reply by 1.5 s (the first `UpdateMemo`; the `GetMemo` after the first
reaction's upsert): the stale state showed in 10 of 10 trials for pin and 10 of 10 for reactions, and 0 of 3 each without
the delay. With this branch: 0 of 10 and 0 of 10.

Two commits:

- `fix(web): keep the newer memo update when two updates of a memo overlap`: `useUpdateMemo` gets a mutation
  `scope`, so memo updates are sent one at a time in the order they were made (React Query still runs each
  `onMutate` right away, so the optimistic patch shows on the click as before). An update whose memo has a newer
  update queued behind it returns from `onSuccess` before writing its reply, so the newer optimistic patch stays
  until the newer reply lands.
- `fix(web): refetch a memo's reactions through its query`: the reaction click invalidates the memo's detail query
  instead of calling `getMemo` and `setQueryData` itself. A newer refetch of that query cancels an older one, so an
  older copy of the reactions cannot land after a newer one.

Tests (Vitest, in the style of `memo-record.test.tsx`): two new `useUpdateMemo` tests in `web/tests/memo-record.test.tsx`
answer the pin and unpin replies in reverse order and in order, and `web/tests/reaction-actions.test.tsx` answers the
two reactions' refetches in reverse order. All three fail on main (the memo ends `pinned: true`; the reactions end
`["👍"]`) and pass with the fix, three runs each way.

Checks: `cd web && pnpm lint` (tsc and Biome clean) and `pnpm test` (193 files, 1619 tests) pass.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.
