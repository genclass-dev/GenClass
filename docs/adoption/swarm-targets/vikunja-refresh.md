# Vikunja task autosave (refresh)

Session brief for the adoption swarm (docs/adoption/swarm.md), 2026-11-03. Slug `vikunja-refresh`, type hunt-refresh.

TARGET: Vikunja task autosave (refresh) (upstream go-vikunja/vikunja). TYPE: hunt-refresh (`docs/adoption/swarm.md` section 4.2). SLUG: vikunja-refresh.

The hunt found two real bugs in the task detail view (autosave and priority), both reproduced without GenClass, with a patch and tests. The issue draft's pre-submission checklist says the tracker was not searched: search it now (priority, autosave, description lost) and record the result.

The existing files are under `docs/adoption/`: hunts/vikunja.md, hunts/vikunja.patch, hunts/vikunja-issue.md, hunts/vikunja/. Read the report and the drafts in full first.

Do, in order: (1) clone the upstream repository to `~/targets/vikunja` at today's default branch and record the commit; run it natively as the report's setup section says (adapt to today's docs; no Docker daemon here); (2) apply the patch (rebase it if it no longer applies, keep the diff minimal), run the regression test on the unfixed and on the fixed code three times each, and re-run the report's reproduction without GenClass; (3) search the upstream tracker and pull requests (`gh api -X GET search/issues`, or the GitHub web search if `gh` is not signed in; a few queries, 3 seconds apart) for anything filed on the same bug since the hunt date, and read the project's current CONTRIBUTING and AI policy; (4) complete every item of the draft's own "before filing" or "before sending" list that a session can do, and update the drafts where facts changed (versions, commits, line numbers, related links), keeping the disclosure paragraph; (5) append a dated "Refresh (2026-11-03)" section to the report with what was re-run, the numbers, what changed, and the status; (6) commit and open the pull request as section 5 of the brief says.

Done means: the sender has nothing left but the by-hand items the draft names (reproduce by hand, run the test, read the diff, send), or the report says clearly why this should not be sent.

Use SLUG `vikunja-refresh` in every path and in the pull request title.
