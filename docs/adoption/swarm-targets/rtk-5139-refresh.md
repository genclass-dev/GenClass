# Redux Toolkit #5139 evidence (refresh)

Session brief for the adoption swarm (docs/adoption/swarm.md), 2026-11-03. Slug `rtk-5139-refresh`, type hunt-refresh.

TARGET: Redux Toolkit #5139 evidence (refresh) (upstream reduxjs/redux-toolkit, issue https://github.com/reduxjs/redux-toolkit/issues/5139). TYPE: hunt-refresh of an evidence comment (`docs/adoption/swarm.md` sections 4.2 and 4.4). SLUG: rtk-5139-refresh.

This is an evidence comment, not a fix: a standalone reproduction (imports nothing from GenClass), two failing tests and the event timeline the thread asked for. Check whether issue #5139 is still open and unanswered, whether a maintainer commented since 2026-10-25, and whether the current RTK Query release still shows the behaviour; refresh the comment draft to today's versions.

The existing files are under `docs/adoption/`: `hunts/rtk-5139.md`, `hunts/rtk-5139-comment.md`, `hunts/rtk-5139/` (`repro/` and `timeline/`). Read the report and the draft in full first.

Do, in order: (1) build GenClass as the brief's section 3 says; run the reproduction and the timeline harness against today's published `@reduxjs/toolkit` (record the version) and against the repository's current main if the reproduction can be pointed at a local build; (2) re-run the two failing tests and record the result three times; (3) read the issue thread as of today and the project's CONTRIBUTING and any AI policy; search the tracker for newer duplicates or a fix in flight; (4) update the comment draft where facts changed (versions, line numbers, what the thread now asks), keeping the disclosure line; (5) append a dated "Refresh (2026-11-03)" section to the report with what was re-run, the numbers, what changed, and the status; (6) commit and open the pull request as section 5 of the brief says.

Done means: the sender has nothing left but the by-hand items the draft names, or the report says clearly why this should not be posted (a maintainer already answered, the issue closed, the behaviour gone).

Use SLUG `rtk-5139-refresh` in every path and in the pull request title.
