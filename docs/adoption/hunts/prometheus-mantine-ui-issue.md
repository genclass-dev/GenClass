# Prometheus web UI (mantine-ui): drafts for the sender

Prepared 2026-11-03 by a GenClass adoption-swarm session. Nothing here has been sent. Report:
[prometheus-mantine-ui.md](prometheus-mantine-ui.md). Patch: [prometheus-mantine-ui.patch](prometheus-mantine-ui.patch)
(against prometheus/prometheus `4a933f89fa96c56ad69e7c02dc5f40e06d93440e`, fix and test together, 59 changed lines).

**Status: needs owner decision.** The race hunt found no race (report, sections 5 to 8). What is drafted below is
a small non-race bug the hunt ran into: the query tree view sends each leaf node's request twice and aborts the
first. It is real, measured and fixed with a test, but GenClass did not find it as a race (explore listed it only as
a request count that differs, under "internal state only"; the browser's request log showed it). Sending it is a
plain bug-fix contribution, not a GenClass demonstration. The owner decides whether it goes out.

Prometheus wants no issue first for a fix this small (CONTRIBUTING.md: "If you have a trivial fix or improvement, go
ahead and create a pull request, addressing (with `@...`) a suitable maintainer of this repository"). So there is
one draft, the pull request, in the repository's template (`.github/PULL_REQUEST_TEMPLATE.md`). An issue draft in
`bug_report.yml`'s fields follows for the case a maintainer asks for one.

## Pull request

**Title:** `ui: send each query tree node's request once`

**Branch and commit:** from `main`, one commit, signed off: `git commit -s -m "ui: send each query tree node's request once"`
(DCO; the sign-off is the sender's own name and email).

**Body** (paste from the line below; `@juliusv` is the web/ui owner in CODEOWNERS and MAINTAINERS.md, the address
CONTRIBUTING.md asks for):

---

@juliusv

The query tree view sends each leaf node's `/api/v1/query` request twice and aborts the first one.

`TreeNode` keys its query on `useId()` from `@mantine/hooks`. That hook returns an id derived from React's `useId`
on the first render and replaces it with a random one in a layout effect after mount, so the node's query key changes
right after it mounts. A leaf node's query is enabled at once (it has no children to wait for), so TanStack Query
has already started the request under the first key; the key change starts a second request and aborts the first.
Inner nodes are enabled only after their children answered, by which time the id is stable, so they send once.

Measured on a production build of `main` (4a933f8) served by `vite preview` against a local Prometheus 3.15.1, opening
`/query?g0.expr=sum by (job) (up) + count by (job) (go_goroutines)&g0.show_tree=1` 8 times in Chromium and counting the
tree's `/api/v1/query` requests: 7 requests for the 5 nodes in each of the 8 loads, `up` and `go_goroutines` sent twice
with the first aborted (16 aborted in all). With this change: 5 requests per load, none aborted, 8 of 8 loads.

The fix takes `useId` from React instead, which is stable from the first render (`TableTab.tsx` and `Graph.tsx`
already use it for their query keys). The node id used for selecting a node comes from the same hook, so by reading
the code the root node is now also selected once instead of twice on mount (the Explain tab's error boundary is keyed
on that id).

The new `TreeNode.test.tsx` renders a leaf node and asserts it sends one request that is not aborted. On `main` it
fails (two requests, the first aborted); with the change it passes (three runs each). `CI=true pnpm run test` and
`pnpm run lint` in `web/ui` pass.

This is independent of #20279 (open), which adds the query and the evaluation time to the same key but keeps the
Mantine hook: the change applies on top of it unchanged, and there the test needs `endTime={null}`.

I used Claude (Claude Code) to investigate this, write the fix and the test, and draft this description; I reviewed
the change and ran the tests and the manual check myself. I came across it while checking this UI for races with
GenClass, a tool I work on, which replays the same steps with the server's responses delivered in different orders;
the duplicate request showed up in the browser's request log, not as a race.

#### Which issue(s) does the PR fix:

None filed; a trivial fix, sent straight as a pull request as CONTRIBUTING.md suggests.

#### Release notes for end users (**ALL** commits must be considered).
*Reviewers should verify clarity and quality.*

```release-notes
[BUGFIX] UI: Send each leaf node's query in the query tree view once instead of twice.
```

---

## Issue (only if a maintainer asks for one)

Template: `.github/ISSUE_TEMPLATE/bug_report.yml`. Title: `UI: query tree view sends each leaf node's query twice`.

**What did you do?**
Opened the query page with the tree view shown, for example
`http://localhost:9090/query?g0.expr=sum%20by%20(job)%20(up)%20%2B%20count%20by%20(job)%20(go_goroutines)&g0.show_tree=1`,
with the browser's network panel open.

**What did you expect to see?**
One `/api/v1/query` request per tree node (5 for this expression).

**What did you see instead? Under which circumstances?**
7 requests: the leaf nodes' queries (`up`, `go_goroutines`) are each sent twice and the first of each is cancelled.
Every time the tree renders, in a production build (8 of 8 loads). `TreeNode` keys the query on `useId()` from
`@mantine/hooks`, whose value changes in a layout effect right after mount, so the query key changes once and the
first request is aborted.

**System information:** `Linux 6.18.44 x86_64` (the sender fills in their own)

**Prometheus version:** UI built from `main` at 4a933f8 (`@prometheus-io/mantine-ui` 0.315.1), server 3.15.1
release binary (the sender replaces this with `prometheus --version` of the build they reproduce on).

**Prometheus configuration file:** the shipped `documentation/examples/prometheus.yml` is enough.

I used Claude (Claude Code) to investigate this and draft this report; I reproduced it myself. (Same last sentences as
the pull request's disclosure if it is filed.)

## Before sending (the sender)

- [ ] The owner said yes to sending a non-race fix (the status above).
- [ ] Search the tracker again for duplicates since 2026-11-03: open and closed issues and pull requests for
      `TreeNode`, `useId`, `tree view` + `request`/`twice`/`duplicate`/`abort`. On 2026-11-03 the search API found none;
      the related open #20279 changes the same key without this fix (see the body).
- [ ] If #20279 has merged: rebase, check the patch still applies (it did on 2026-11-03), and add `endTime={null}` to
      the test's `<TreeNode>`.
- [ ] Reproduce by hand: build the UI (`cd web/ui && pnpm install && pnpm run build:module && cd mantine-ui && npx vite build && npx vite preview`)
      with a local Prometheus on :9090, open the URL above with the network panel open, see 7 `query` requests with
      two cancelled; apply the patch, rebuild, see 5. Or run `docs/adoption/hunts/prometheus-mantine-ui/requests.mjs`
      from this repository against each build.
- [ ] Run the test both ways yourself: `pnpm --filter @prometheus-io/mantine-ui exec vitest run src/pages/query/TreeNode.test.tsx`
      fails on `main` and passes with the patch; then `CI=true pnpm run test` and `pnpm run lint` in `web/ui`.
- [ ] Read the diff (two lines in `TreeNode.tsx`, the new test); make sure every sentence of the body is true for you,
      in particular the disclosure paragraph.
- [ ] Commit with `git commit -s`, push to your fork, open the pull request with the title and body above.
- [ ] A first-time contributor's CI waits for a maintainer's `/workflow-approve`; do not ping for it.
- [ ] If asked whether this was found with GenClass: no, the race hunt found nothing; this came from the request log
      of the same session. If the maintainers prefer a different fix (for example adding the query to the key, as
      #20279 does, which alone does not stop the duplicate), follow them.
