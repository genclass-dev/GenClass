# Payload admin (refresh)

Session brief for the adoption swarm (docs/adoption/swarm.md), 2026-11-03. Slug `payload-refresh`, type hunt-refresh.

TARGET: Payload admin (refresh) (upstream payloadcms/payload). TYPE: hunt-refresh (`docs/adoption/swarm.md` section 4.2). SLUG: payload-refresh.

The hunt (2026-10-24, payload 3.92.0) found no stale-state race but drafted an issue and PR for what it did find: read `hunts/payload.md` section 1 and `hunts/payload-issue.md` for the bug and the two patches (`hunts/payload.patch` against the release, `hunts/payload-main.patch` against main). Decide which patch is current and bring it to today's main.

The existing files are under `docs/adoption/`: hunts/payload.md, hunts/payload.patch, hunts/payload-main.patch, hunts/payload-issue.md, hunts/payload-hunt/. Read the report and the drafts in full first.

Do, in order: (1) clone the upstream repository to `~/targets/payload` at today's default branch and record the commit; run it natively as the report's setup section says (adapt to today's docs; no Docker daemon here); (2) apply the patch (rebase it if it no longer applies, keep the diff minimal), run the regression test on the unfixed and on the fixed code three times each, and re-run the report's reproduction without GenClass; (3) search the upstream tracker and pull requests (`gh api -X GET search/issues`, or the GitHub web search if `gh` is not signed in; a few queries, 3 seconds apart) for anything filed on the same bug since the hunt date, and read the project's current CONTRIBUTING and AI policy; (4) complete every item of the draft's own "before filing" or "before sending" list that a session can do, and update the drafts where facts changed (versions, commits, line numbers, related links), keeping the disclosure paragraph; (5) append a dated "Refresh (2026-11-03)" section to the report with what was re-run, the numbers, what changed, and the status; (6) commit and open the pull request as section 5 of the brief says.

Done means: the sender has nothing left but the by-hand items the draft names (reproduce by hand, run the test, read the diff, send), or the report says clearly why this should not be sent.

Use SLUG `payload-refresh` in every path and in the pull request title.
