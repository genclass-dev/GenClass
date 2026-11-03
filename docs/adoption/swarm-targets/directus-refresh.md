# Directus Studio (refresh of PR #90)

Session brief for the adoption swarm (docs/adoption/swarm.md), 2026-11-03. Slug `directus-refresh`, type hunt-refresh.

TARGET: Directus Studio (refresh of the unmerged hunt in this repository's PR #90) (upstream directus/directus). TYPE: hunt-refresh (`docs/adoption/swarm.md` section 4.2). SLUG: directus-refresh.

A Directus Studio hunt already exists, unmerged: PR #90 (branch `claude/keen-mayer-531u15`, Directus v12.5.1, 2026-10-25). Its headline: on in-app navigation between two items (a relation's "Navigate to Item", then the header back arrow), the item view can show the item you left under the URL of the item you are on, and Save then writes that item's text into the current one for every field the user edits; reproduced without GenClass with a delayed route. Fetch that branch (`git fetch origin claude/keen-mayer-531u15`), read `docs/adoption/hunts/directus.md`, `directus-facts.md` and `directus.patch` there, and rebase its commits onto today's `main` on your branch, so your pull request supersedes #90 (say so in its body).

POLICY GATE (read first): Directus's ai_policy.md bans fully autonomous agent contributions and maintainers close contributions they suspect were generated without meaningful human involvement; the licence is MSCL 1.0, source-available rather than OSI open source, so every text must say "source-available". The hand-back is evidence and a fact sheet for a person to write the issue by hand (as PR #90 already frames it), plus the prepared fix for that person to review and own.

Do, in order: (1) clone the upstream repository to `~/targets/directus` at today's default branch and record the commit; run it natively as the report's setup section says (adapt to today's docs; no Docker daemon here); (2) apply the patch (rebase it if it no longer applies, keep the diff minimal), run the regression test on the unfixed and on the fixed code three times each, and re-run the report's reproduction without GenClass; (3) search the upstream tracker and pull requests (`gh api -X GET search/issues`, or the GitHub web search if `gh` is not signed in; a few queries, 3 seconds apart) for anything filed on the same bug since the hunt date, and read the project's current CONTRIBUTING and AI policy; (4) complete every item of the draft's own "before filing" or "before sending" list that a session can do, and update the drafts where facts changed (versions, commits, line numbers, related links), keeping the disclosure paragraph; (5) append a dated "Refresh (2026-11-03)" section to the report with what was re-run, the numbers, what changed, and the status; (6) commit on top of #90's rebased commits and open the pull request as section 5 of the brief says.

Done means: the sender has nothing left but the by-hand items the draft names (reproduce by hand, run the test, read the diff, send), or the report says clearly why this should not be sent.

Use SLUG `directus-refresh` in every path and in the pull request title.

Verifier's notes on today's Directus (2026-11-03), for the re-run: Directus Studio is a Vue 3 SPA over axios (XHR) and the SDK (fetch); WebSockets only carry collaborative editing (WEBSOCKETS_ENABLED defaults false). Node 26 is mandatory (pnpm-workspace.yaml engineStrict: true): nvm install 26, then pnpm 12.4.1. The full build is heavy (CI sets NODE_OPTIONS=--max_old_space_size=6144). The API reads api/.env; `pnpm cli bootstrap` creates the sqlite schema and the first admin from ADMIN_EMAIL/ADMIN_PASSWORD. Inject the runtime with Playwright on the Vite app at :8080 (it proxies the API and /websocket to 127.0.0.1:8055).

Skip the collection browser, file library and pick-list drawer: packages/composables/src/use-items.ts aborts superseded requests (L86, L197) and discards stale counts with generation counters (L334-352). Unguarded: app/src/composables/use-relation-multiple.ts updateFetchedItems() L442-525 drops a response only when itemId changed, so a search, page, sort or limit change in a list-m2m/list-o2m/list-m2a interface can be overwritten by an older response (and `loading` flips false early); updateItemCount() L548-590 has no guard; use-relation-single.ts getDisplayItem() L63-122 (M2O and file displays) has none; input-autocomplete-api.vue fetchResultsRaw L43-61 only throttles. Double submit: use-item/index.ts save() L171-225 has no re-entrancy check; v-button ignores clicks while loading (L140) but Cmd+S (item.vue L287 -> saveAndStay L605) is gated by isSavable (L350), which ignores `saving`, so a second Cmd+S during an in-flight POST on a new item may create twice; confirm with explore first.

Tests: vitest + happy-dom, `*.test.ts` next to the source (app/vite.config.js L92-106); use-relation-multiple.test.ts mocks @/sdk via @/test-utils/sdk mockSdk with a path resolver, so resolve two responses in reverse order. No Playwright in the repo; tests/e2e is API-level vitest (sqlite project runs without Docker unless extras are requested: tests/sandbox/src/steps/docker.ts L21-25, L103). Before the PR: pnpm lint, pnpm lint:style, pnpm format, `pnpm changeset` ('@directus/app': patch, past tense).

Issue form (blank issues disabled): Describe the Bug, To Reproduce, Directus Version, Hosting Strategy, Database. PR template: What's Changed, Tested Scenarios, Review Notes / Questions / Concerns, Checklist (tick Tests added/updated), footer `Fixes #<num>`; titles are plain imperative sentences. CLA: add the GitHub username to contributors.yml in the PR (unsigned PRs are auto-closed).

Policy (ai_policy.md): AI-assisted code with a human in the loop is allowed; fully autonomous agents and entirely AI-generated issue or PR…

Run commands: git clone https://github.com/directus/directus && cd directus
nvm install 26 && nvm use 26            # engineStrict: true; root engines.node "26", api ">=26"
corepack enable && corepack prepare pnpm@12.4.1 --activate   # or: npm i -g pnpm@12.4.1
pnpm install
NODE_OPTIONS=--max_old_space_size=6144 pnpm build          # CI's setting (.github/actions/prepare/action.yml); builds all workspace packages
cat > api/.env <<'EOF'
DB_CLIENT=sqlite3
DB_FILENAME=./data.db
SECRET=<random string>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<password>
WEBSOCKETS_ENABLED=true
EOF
(cd api && pnpm cli bootstrap)          # "cli" = tsx src/cli/run.ts; creates the sqlite schema and the first admin from ADMIN_EMAIL/ADMIN_PASSWORD
(cd api && pnpm dev)                    # API on http://localhost:8055 (serves the built app at /admin)
(cd app && pnpm dev)                    # Vite on http://localhost:8080; proxies everything except /admin, plus /websocket, to http://127.0.0.1:8055
# Login: http://localhost:8080/admin with ADMIN_EMAIL / ADMIN_PASSWORD
# Seed: create collections with an M2M/O2M field in Settings > Data Model, then POST ~100 rows to /items/<collection> with the admin token
# Before a PR: pnpm lint && pnpm lint:style && pnpm format && pnpm changeset ('@directus/app': patch, past tense)
# Unit tests: (cd app && pnpm test)   # vitest, happy-dom, app/**/*.test.ts

Surfaces the verifier confirmed unguarded today: 1. Relational interface list (list-m2m / list-o2m / list-m2a on an item page): type in the interface's search box or flip pages/sort quickly while an earlier response is delayed. Code: app/src/composables/use-relation-multiple.ts updateFetchedItems() L442-525 (only discards a response when itemId changed; search/page/sort/limit changes unguarded; loading flips false on the first response back) and updateItemCount() L548-590 (no guard). 2. M2O / file display: change a select-dropdown-m2o or file value twice quickly. Code: app/src/composables/use-relation-single.ts getDisplayItem() L63-122 (no abort or sequence guard). 3. Autocomplete interface (input-autocomplete-api) fed by an API URL: fast typing. Code: app/src/interfaces/input-autocomplete-api/input-autocomplete-api.vue fetchResultsRaw L43-61 (throttle/debounce by `rate`, results overwritten by whichever response lands last). 4. Double submit on item create: fill a new item and press Cmd+S twice while the POST is held. Code: app/src/modules/content/routes/item.vue useShortcut('meta+s') L287-291 -> saveAndStay() L605 gated by isSavable L350 (ignores `saving`); app/src/composables/use-item/index.ts save() L171-225 has no re-entrancy guard; the Save button itself ignores clicks while loading (app/src/components/v-button.vue L140). 5. Optional: collaborative editing over WebSocket (two clients on one item, WEBSOCKETS_ENABLED=tru…
