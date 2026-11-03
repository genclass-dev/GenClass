# Race hunt: Audiobookshelf (2.37.2)

A GenClass race hunt on Audiobookshelf's web client (`advplyr/audiobookshelf`). It ran on 2026-11-03 in a cloud
session. The real `@genclass/runtime` (0.3.0-beta.5, from this repository at `c1c9e14`) was injected into the client
by Playwright, and the real `@genclass/mcp` (0.2.1) was driven the way a coding agent drives it. Audiobookshelf's
source was not modified for the hunt. The fix is a patch for its maintainers: [audiobookshelf.patch](audiobookshelf.patch).
The facts for the sender's own pull request text are in [audiobookshelf-facts.md](audiobookshelf-facts.md). The
project does not accept fully AI-generated pull requests, so that file holds facts and checks, not paste-ready text.
Nothing was sent to Audiobookshelf's repository, tracker or maintainers.

**Headline.** Two real client bugs, both reproduced without GenClass, and one server-side rollback confirmed at the
API level.

1. **[#2231](https://github.com/advplyr/audiobookshelf/issues/2231), open since 2023-10-21 as "unable to
   reproduce", now reproduced deterministically.** Any `item_updated` socket message for the item open in the "Edit
   item" modal wipes every unsaved edit in the Details form. The trigger does not have to be a Match:
   - another client's PATCH reverted a typed title in 3 of 3 runs (control without a server change: 0 of 3);
   - the folder watcher picking up a new file reverted it in 3 of 3 runs, 12.8 s after the file was written;
   - the modal's own Save followed by typing wiped the new text in every load (section 3).

   GenClass's explore cannot produce this: it is a socket push, and explore reorders only HTTP responses. The hunt
   found it by reading the code the brief pointed at, then reproduced it directly. The fix is about 25 lines in
   `BookDetailsEdit.vue`: keep unsaved edits to fields the update did not change. It comes with a Cypress component
   spec. Both are in the patch.
2. **The global search keeps the older query's results when two searches overlap (no issue filed).** If the "Har"
   search is still in flight when the "Harmony" search starts, and the responses arrive in request order, the menu
   lists "Hart Keep" and "Harbor Sea" under the box that says "Harmony". This happened in 3 of 3 runs with both
   responses held 1.5 s, and in 0 of 3 with the responses reversed or not held. The first response clears a shared
   `isFetching` flag, so the second is dropped as "canceled". Explore at 300 and 600 ms found no race, because at
   those latencies the two searches never overlap (the box debounces for 750 ms). The slower sessions are in section 3.
   One-line fix (section 5). It is not in the patch: the project asks first-time contributors for small PRs.
3. **#5627's class, a stale session's close rolls progress back**, confirmed with three API calls (section 6). Not
   patched: open PR #5640 works in the same place.

Sections: 1 setup, 2 how the app was driven, 3 scenarios and verdicts, 4 the finding (#2231), 5 the search overlap,
6 progress rollback (#5627), 7 problems with GenClass itself, 8 time spent, 9 reproducing.

## 1. Setup

| what | version |
|---|---|
| Audiobookshelf | 2.37.2, `master` at `ce41ce489cebaf00e008919f6f2901b428acfd56` (2026-11-01, "Merge pull request #5691 from mikiher/dedupe-authors"), the commit the patch is against |
| server runtime | Node 24.22.2 (nvm; the readme's "Manual Environment Setup" requires Node 24), Express 4, Sequelize 6, sqlite3 5.1.7, socket.io 4 |
| client | Nuxt 2.18 / Vue 2.7, the static build (`npm run generate`) the server serves under `/audiobookshelf` |
| ffmpeg | 6.1.1 (Ubuntu 24.04 apt); Audiobookshelf pins 5.1 and its downloader was refused by the network policy, so `dev.js` sets `SkipBinariesCheck: true` (nothing in the hunt transcodes) |
| browser | Chromium 1243 (headless shell), Playwright 1.63.0, harness on Node 22.23.4 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Audiobookshelf, outside this checkout
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 24
git clone https://github.com/advplyr/audiobookshelf.git ~/targets/audiobookshelf && cd ~/targets/audiobookshelf
cp .devcontainer/dev.js dev.js      # Port 3333, config/ and metadata/ in the clone, /usr/bin/ffmpeg
sed -i 's/SkipBinariesCheck: false/SkipBinariesCheck: true/' dev.js   # ffmpeg 6.1 here, 5.1 pinned (see above)
npm ci && (cd client && npm ci && npm run generate)
npm run dev                          # nodemon: tsc to dist-server/, node dist-server/index.js --dev -> :3333

# seed: 220 books under ~/abs-data/books, a root user, one library, a scan
bash docs/adoption/hunts/audiobookshelf/seed.sh ~/abs-data/books
curl -X POST localhost:3333/init -H 'content-type: application/json' -d '{"newRoot":{"username":"root","password":"hunt-pw-1"}}'
TOKEN=$(curl -s -X POST localhost:3333/login -H 'content-type: application/json' \
  -d '{"username":"root","password":"hunt-pw-1"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["accessToken"])')
curl -X POST localhost:3333/api/libraries -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Books","mediaType":"book","folders":[{"fullPath":"'$HOME'/abs-data/books"}]}'
curl -X POST localhost:3333/api/libraries/<id>/scan -H "authorization: Bearer $TOKEN"
```

The seed is 220 books named "<Word> <Noun>" (20 words × 11 nouns: Harbor, Hardy, Harvest, Harmony, Hart, Silver, ...)
by 40 authors, each one 2 s sine mp3 made by ffmpeg, so the prefix "Har" matches five words' books. Setup took about
25 minutes, most of it the two `npm ci` runs and `npm run generate`.

## 2. How the app was driven

All the hunt's scripts are in [audiobookshelf/](audiobookshelf/); `lib.mjs` is shared (login through the client's own
form, saved as Playwright storage state; a bearer-token API client for setup and oracles).

- **With GenClass** ([explore.mjs](audiobookshelf/explore.mjs)): the Gitea harness pattern. A Playwright route
  rewrites the client's HTML document to load `genclass.global.js` from a virtual same-origin path (model off,
  telemetry off, `report: "silent"`) and to connect `agent.js` to an MCP bridge started in-process with `serve()`.
  Each browser context gets the `local-network-access` permission. Audiobookshelf's Vuex store is not discovered, so
  the injected script mirrors three regions with `rt.atom()` from a `MutationObserver`:
  - `search.text`: the global search menu's text;
  - `shelf.titles`: the first 24 bookshelf cards' titles, read from the cards' Vue instances;
  - `edit.title` and `edit.subtitle`: the Details form's two inputs.

  The explore verdict compares those atoms, the page text and the form values. One explore session per latency: 2
  baselines (responses in request order) plus 6 seeded loads, the same steps each load. Each load also has an oracle
  of the harness's own, read from the DOM after `whenSettled()`.
- **Without GenClass**:
  - [repro-2231.mjs](audiobookshelf/repro-2231.mjs): the #2231 reproduction, with three triggers (`patch`, `watcher`,
    `none`).
  - [repro-search.mjs](audiobookshelf/repro-search.mjs): the search overlap, with a Playwright route that only holds
    the two search responses.
  - [progress-5627.mjs](audiobookshelf/progress-5627.mjs): the progress rollback, through the API.
  - [standin-component-test.mjs](audiobookshelf/standin-component-test.mjs): the Cypress spec's two cases, mounted
    without Cypress (section 4.5).

RESULTS_PLACEHOLDER
