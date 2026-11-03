# Gitea markdown preview (refresh)

Session brief for the adoption swarm (docs/adoption/swarm.md), 2026-11-03. Slug `gitea-refresh`, type hunt-refresh.

TARGET: Gitea markdown preview (refresh) (upstream go-gitea/gitea). TYPE: hunt-refresh (`docs/adoption/swarm.md` section 4.2). SLUG: gitea-refresh.

The hunt found that the markdown Preview can show text no longer in the editor (an unguarded out-of-order preview response in every ComboMarkdownEditor). Gitea asks for an issue before a PR and its AI policy requires the contributor to answer maintainers personally: re-read that policy today and quote it in the refresh section. Also check whether Forgejo (the fork, codeberg.org/forgejo/forgejo) still carries the same code; if it does, say so in the report (a separate contribution could follow), but prepare nothing for Forgejo in this session.

The existing files are under `docs/adoption/`: hunts/gitea.md, hunts/gitea.patch, hunts/gitea-issue.md, hunts/gitea-explore.mjs, hunts/gitea-throttle.mjs. Read the report and the drafts in full first.

Do, in order: (1) clone the upstream repository to `~/targets/gitea` at today's default branch and record the commit; run it natively as the report's setup section says (adapt to today's docs; no Docker daemon here); (2) apply the patch (rebase it if it no longer applies, keep the diff minimal), run the regression test on the unfixed and on the fixed code three times each, and re-run the report's reproduction without GenClass; (3) search the upstream tracker and pull requests (`gh api -X GET search/issues`, or the GitHub web search if `gh` is not signed in; a few queries, 3 seconds apart) for anything filed on the same bug since the hunt date, and read the project's current CONTRIBUTING and AI policy; (4) complete every item of the draft's own "before filing" or "before sending" list that a session can do, and update the drafts where facts changed (versions, commits, line numbers, related links), keeping the disclosure paragraph; (5) append a dated "Refresh (2026-11-03)" section to the report with what was re-run, the numbers, what changed, and the status; (6) commit and open the pull request as section 5 of the brief says.

Done means: the sender has nothing left but the by-hand items the draft names (reproduce by hand, run the test, read the diff, send), or the report says clearly why this should not be sent.

Use SLUG `gitea-refresh` in every path and in the pull request title.
