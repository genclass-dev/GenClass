# `mcp-server-lists`: GenClass on two community MCP server lists

Adoption swarm session, 2026-11-03 (brief: `docs/adoption/swarm-targets/mcp-server-lists.md` on `adopt/briefs`;
procedure: [../../swarm.md](../../swarm.md) section 4.3, type `listing`). Nothing was sent. Nothing was posted,
forked, starred or opened on either list. Both lists were cloned read-only into `~/targets/mcp-server-lists/`.

| list | status | file changed upstream | PR text | patch |
|---|---|---|---|---|
| [TensorBlock/awesome-mcp-servers](https://github.com/TensorBlock/awesome-mcp-servers) | **ready to send** | `docs/code-analysis--quality.md` (+1 line), `data/server-metadata/github-genclass-dev-genclass-cafd8990.json` (new, optional) | [PR-tensorblock.md](PR-tensorblock.md) | [upstream-tensorblock.patch](upstream-tensorblock.patch) against `31f91489a2c7e735ddfaf9075ce5fae4009b5370` |
| [MobinX/awesome-mcp-list](https://github.com/MobinX/awesome-mcp-list) | **ready to send** (slow queue, see risks) | `README.md` (+1 line) | [PR-mobinx.md](PR-mobinx.md) | [upstream-mobinx.patch](upstream-mobinx.patch) against `f3fe0a7131c04163ab12273e46a1c62a778a3ceb` |
| YuzeHao2023/Awesome-MCP-Servers | dropped by the brief's verifier (unmaintained: last listing merge 2026-04-01, 499 open PRs) | nothing prepared | | |

GenClass meets both lists' rules today. Neither list has a star floor, score, badge or required star of the list
itself, and neither needs anything GenClass doesn't already have published.

## What the entry describes, and what was checked

The entry describes the MCP server only: `@genclass/mcp` 0.2.1 in `packages/mcp` of https://github.com/genclass-dev/GenClass.
Each claim in the entries was checked in this session:

| claim | how it was checked |
|---|---|
| published, 0.2.1 is `latest`, Apache-2.0 | `curl -sS https://registry.npmjs.org/@genclass/mcp` → `dist-tags {'latest': '0.2.1'}`, `license Apache-2.0` |
| `npx -y @genclass/mcp@0.2.1` runs over stdio, 9 tools, these names | piped `initialize`, `notifications/initialized`, `tools/list` into `npx -y @genclass/mcp@0.2.1` → `serverInfo {'name': 'genclass', 'version': '0.2.1'}`, 9 tools: `genclass_status, genclass_findings, genclass_explain, genclass_explore, genclass_replay, genclass_analytics, genclass_setup, genclass_scan, genclass_clear`. Its stderr said `bridge listening on http://127.0.0.1:47357` |
| `https://github.com/genclass-dev/GenClass` is this repository | `git ls-remote https://github.com/genclass-dev/GenClass HEAD` → `c1c9e14…`, the same commit as this checkout's `origin/main` (the old `GenClass-lib` URL resolves to the same HEAD) |
| page side is two dev-only lines, `connectAgent` from `@genclass/runtime/agent` | `packages/mcp/README.md` (the `connectAgent(rt)` block). `@genclass/runtime@beta` is `0.3.0-beta.5` on npm and exports `./agent` (registry JSON) |
| no auth, no account, local by default | `packages/mcp/README.md`: the bridge listens on 127.0.0.1 only. The only data that leaves the machine is opt-in (`genclass_analytics {source: "production"}` with `GENCLASS_DASHBOARD`, `genclass_scan {hosted: true}`, `GENCLASS_REPORT`). The entries say "local by default" or "local", never "nothing ever leaves" |
| clients | `packages/mcp/README.md` has install sections for Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf, Cline and Goose |
| "re-runs a page with responses delivered in different orders", "replays one exact order to prove a fix", "writes a Playwright regression test" | `docs/adoption/listings/mcp.md` "Texts to reuse" and the package README. No rate and no recall claim is made anywhere |

## 1. TensorBlock/awesome-mcp-servers: ready to send

**Rules** (read in the clone at `31f91489`, which was still `main` when this report was written):

- `README.md`, section "Add or Improve an Entry"
  (https://github.com/TensorBlock/awesome-mcp-servers#add-or-improve-an-entry): pick a category, add one bullet
  `- [Server Name](https://github.com/owner/repo): Brief description of what the MCP server lets an agent do. Install: \`npx your-package\`.`,
  search for duplicates, open a PR. Editing `docs/*.md` alone is enough. `data/server-metadata/*.json` sidecars are
  optional. `data/catalog.json` and `data/profiles/*` are generated, so don't commit them.
- `docs/index-alpha/contribution-guide.md`: list the install command, transport, auth, clients, tool count and names,
  licence and docs URL. Structured metadata can go in `data/server-metadata/{serverId}.json`.
- `schemas/server-metadata.schema.json`: requires `id` and `source.projectUrl`, and allows no extra properties.
- No `CONTRIBUTING.md`, PR template, code of conduct, CLA, DCO or AI policy at HEAD (`ls .github` shows
  `ISSUE_TEMPLATE actions scripts workflows`). No workflow runs on `pull_request`.
- Unwritten rules the brief's verifier saw in maintainer closures: one server and one category per PR, no duplicates.
  The maintainer merges the day's PRs in one batch, around 09:10 UTC.

**Duplicates:** `grep -rli genclass docs README.md data/server-metadata` in the clone returns nothing. The verifier's
check of open PRs, issues and the hosted API (0 hits) is in the brief. This session could not re-run it (the GitHub
API is scoped to this repository).

**Category and position:** `docs/code-analysis--quality.md` (heading `## ✨ Code Analysis & Quality`, 152 bullets),
new line 128 of 158, right after the QA servers for web apps:

```
- [Aboudjem/sniff](https://github.com/Aboudjem/sniff): Autonomous QA and accessibility scanner that walks real user flows in a headless browser, reporting broken pages, dead links, console errors, and WCAG issues. Install with `npx -y sniff-qa --mcp`.
- [GenClass](https://github.com/genclass-dev/GenClass): Helps a coding agent find race conditions in a web app: reads what happened in the app's development pages in causal order (clicks, requests, the order responses arrived, state writes, errors), re-runs a page with network responses delivered in different orders, replays one exact order to prove a fix and writes a Playwright regression test. The page side is two dev-only lines (`connectAgent` from `@genclass/runtime/agent`). Install: `npx -y @genclass/mcp@0.2.1`. Transport: stdio. Local by default: no auth, no account; the bridge listens on 127.0.0.1. 9 tools. Clients: Claude Code, Cursor, VS Code, Codex. License: Apache-2.0. [Docs](https://github.com/genclass-dev/GenClass/blob/main/packages/mcp/README.md).
```

The brief's primary suggestion was `docs/developer-productivity--utilities.md` (544 bullets), with this page as the
verifier's alternative. I chose Code Analysis & Quality for three reasons. Its neighbours are the closest match
(`Aboudjem/sniff` and `vostride/agent-qa` test running web apps, `baccaraaa/tavero` checks running React apps,
`johannschiffer/genesis-blackbox` is a runtime flight recorder). The page is about a quarter the size, so one line is
easier to find. And the line sits mid-page, which avoids the end-of-page merge conflicts the verifier saw. Either page
is accepted, and the maintainers re-route entries when they disagree.

**Wording for the indexer** (`packages/catalog-builder/src/buildCatalog.ts` and `parseMarkdown.ts`, read in the
clone):

- The install command is in backticks and contains `npx`.
- `stdio` sets the transport.
- `no auth` maps to auth `none`. `inferAuth` accepts only "no auth" or "no api key"; "Auth: none" would give `unknown`.
- `9 tools` sets the count.
- `Apache-2.0` sets the licence.
- Claude, Cursor, Codex and VS Code set the clients.
- The bullet has no bare `http` word and no link whose path ends in `/mcp`, both of which the indexer would read as a
  remote endpoint. The Docs link points at the README blob.

**Sidecar** `data/server-metadata/github-genclass-dev-genclass-cafd8990.json`: the id is `github-<owner>-<repo>` plus
the first 8 hex digits of sha256 of the canonical URL. `node -e` with the same `canonicalizeUrl` gives
`https://github.com/genclass-dev/GenClass` → `cafd8990`. It adds what the indexer can't parse from Markdown: the tool
names (`source: self_reported`), the docs and homepage links, install confidence `high` and the full client list, plus
auth notes that name the opt-in network reads. `verification.status` is `self_reported`, with a note saying what was
run. Because the sidecar is optional, the PR text says how to drop it if asked.

**Checks run** (Node 22.23.4, in the clone, with the patch applied):

```
$ npm ci --no-audit --no-fund          → added 166 packages
$ npm run catalog:build                → Catalog entries: 9417 / Catalog errors: 0
$ npm test                             → Test Files 13 passed (13) / Tests 91 passed (91)
$ npm run typecheck                    → tsc -p tsconfig.base.json --noEmit, exit 0
$ npm run profiles:build               → Profiles written: 9417 (data/profiles/github-genclass-dev-genclass-cafd8990.json present)
$ ajv (2020-12, ajv-formats) on the sidecar against schemas/server-metadata.schema.json → schema valid: true
```

The generated catalog entry, with the sidecar, has `category "Code Analysis & Quality"`, `transport ["stdio"]`,
`auth.type "none"`, `tools.count 9` with the nine names, `license "Apache-2.0"`, `links.endpoint null` and
`installReady true`. With the sidecar removed and the catalog rebuilt, the bullet alone gives `install.confidence
"medium"`, `transport ["stdio"]`, `auth "none"`, `clients [Claude, Cursor, Codex, VS Code]`, `tools.count 9`,
`license "Apache-2.0"` and `installReady true`. The generated `data/catalog.json` and `data/profiles/` were reverted
before the patch was exported. `git apply --check` of the patch on a fresh worktree at `31f91489` passes.

**PR title** (the merged ones' form): `Add GenClass to Code Analysis & Quality`. The body is in
[PR-tensorblock.md](PR-tensorblock.md).

**Expect:** merge within about a day if the batch habit holds. After the merge, a bot comments the profile URL,
install-config links and badge markdown (`.github/workflows/merged-pr-follow-up.yml`). Claiming the profile and adding
the badge are later owner-account steps and are not prepared here.

## 2. MobinX/awesome-mcp-list: ready to send

**Rules** (read in the clone at `f3fe0a7`, `main`, last commit 2026-10-22):

- `CONTRIBUTING.md` (https://github.com/MobinX/awesome-mcp-list/blob/main/CONTRIBUTING.md): only real MCP servers with
  a public GitHub repository. Add exactly one bullet in an existing category, in this format:
  `-   **[owner/repo](https://github.com/owner/repo)** [![GitHub stars](https://img.shields.io/github/stars/owner/repo?style=social)](https://github.com/owner/repo): Short one-line description of what the MCP server does.`
  Three spaces after `-`, the badge for the same repository, one concise sentence, no drive-by edits, the PR changes
  `README.md` only, title `Add owner/repo to <Category>`. PRs are closed for having no repository, the wrong format,
  a duplicate (including another open PR), a dead repository, or large rewrites.
- `.github/PULL_REQUEST_TEMPLATE.md`: what it does, repo URL, category, the pasted entry, and a seven-box checklist.
  `PR-mobinx.md` fills it in verbatim.
- `.github/ISSUE_TEMPLATE/` has two issue forms, but there's no rule to open an issue first. No CLA, DCO, code of
  conduct requirement, AI policy or star floor.

**Qualifies today:** yes. The repository is public and not archived (a fresh clone of `genclass-dev/GenClass` works,
`git ls-remote` above), and the MCP server is published (`@genclass/mcp` 0.2.1, `tools/list` above).

**Duplicates:** `git grep -i genclass` over `README.md` on `main`, every branch, and all 1,013 `refs/pull/*/head`
(PRs up to #1104, fetched into the clone) gives 0 hits.

**Section and position:** `### 💻 Developer Tools`, as its last line: new README line 396, after
`meiorz/rowsmith-mcp` and before `### 🧮 Data Science Tools`. The maintainer appends new entries to the end of a
category (brief: comments on #814 and #821).

```
-   **[meiorz/rowsmith-mcp](https://github.com/meiorz/rowsmith-mcp)** [![GitHub stars](https://img.shields.io/github/stars/meiorz/rowsmith-mcp?style=social)](https://github.com/meiorz/rowsmith-mcp): Generates fake test data (CSV, JSON, SQL) from a schema, with a catalogue of invalid values and their reasons and a payment sandbox that never moves money.
-   **[genclass-dev/GenClass](https://github.com/genclass-dev/GenClass)** [![GitHub stars](https://img.shields.io/github/stars/genclass-dev/GenClass?style=social)](https://github.com/genclass-dev/GenClass): Local MCP server (packages/mcp, @genclass/mcp on npm) that reports race conditions recorded in a web app's development pages, re-runs a page with network responses delivered in different orders, and replays one order to prove a fix.
```

**Check:** the list runs no CI on PRs, so the format was checked with a regex written from `CONTRIBUTING.md`. All 131
bullets in Developer Tools match it, the new one included. The bold link and both badge URLs name the same repository,
and the description is one sentence ending with a period. `git diff --stat` shows `README.md | 1 +`, and
`git apply --check` on a fresh worktree at `f3fe0a7` passes.

**PR title:** `Add genclass-dev/GenClass to Developer Tools`. The body is in [PR-mobinx.md](PR-mobinx.md).

**Expect:** slow. Nothing has landed on `main` since 2026-10-22. PRs after #838 (2026-10-19) were unprocessed on
2026-11-03, and the next PR number is about #1105. The collaborator often commits a valid entry directly on `main`
("Add ... (from #N)") and then closes the PR, which counts as success. Check the README before reading any closure as
a rejection.

## To send (a person, from the owner's personal GitHub account, after the owner's go-ahead)

Send them one at a time on different days, as swarm.md section 7.2 asks.

**TensorBlock:**

1. Re-read `docs/code-analysis--quality.md` on their `main`. About 30 PRs a day land there, so check that the
   `Aboudjem/sniff` line is still there and that nobody has added GenClass.
2. Fork `TensorBlock/awesome-mcp-servers`, clone your fork, `git checkout -b add-genclass`, then
   `git apply <this repo>/docs/adoption/contributions/mcp-server-lists/upstream-tensorblock.patch`. If it no longer
   applies, paste the bullet after the `Aboudjem/sniff` line by hand and copy the sidecar file.
3. Optional, Node 22: run `npm ci && npm run catalog:build && npm test && npm run typecheck`, then
   `git checkout -- data/` so the generated files aren't committed.
4. Commit under your own name with the message `Add GenClass to Code Analysis & Quality`, then push.
5. Open the PR with the title and body from `PR-tensorblock.md`, and tick **Allow edits by maintainers**. Ideally open
   it before about 09:00 UTC so it makes that day's batch. Read the diff before opening.

**MobinX:**

1. Re-read the end of `### 💻 Developer Tools` in their `README.md` on `main`, and search the README and open PRs for
   "genclass".
2. Fork `MobinX/awesome-mcp-list`, `git checkout -b add-genclass` from `main`, then
   `git apply .../upstream-mobinx.patch`. If line numbers have moved, paste the line as the last bullet of
   Developer Tools by hand.
3. Commit with the message `Add genclass-dev/GenClass to Developer Tools`, push, and open the PR with the title and
   body from `PR-mobinx.md`.

When asked, answer with the "If the maintainer asks" notes in each PR file. Never argue a decline. Add the sent URL
and date to this file.

## Risks

- **Reach is small on the page and larger on TensorBlock's index.** TensorBlock builds 9,417 catalog entries (`catalog:build` above) and,
  by the verifier's count, takes about 30 merges a day. The value is the hosted MCP Index (search API, `tensorblock.co/mcp` profile, registry MCP server). MobinX puts
  one bullet at the bottom of a 131-entry section.
- **Merge conflicts on TensorBlock.** The bullet sits mid-page and the "Allow edits" box lets the maintainer resolve
  conflicts.
- **The MobinX queue may sit for weeks** (see "Expect" above).
- **Stars badge.** The verifier saw it render "Stars 7". This session couldn't fetch it (img.shields.io is blocked by
  the session's proxy). No rule cares about the count.
- **Fit.** The repository root is the browser runtime and the server is `packages/mcp`. Both entries name
  `packages/mcp` and `@genclass/mcp`, and MobinX's `@mastra/mcp` line is the precedent if the triage objects.
- **TensorBlock's README promotes TensorBlock's own products.** That costs GenClass nothing. Nothing in their process
  requires starring.

## Problems with GenClass itself (for the launcher's triage, no issue filed)

1. **The repository URL in published metadata is the old name.** `packages/mcp/package.json` (`repository.url`,
   `bugs.url`), `packages/mcp/server.json` (`repository.url`) and so the npm page and the MCP Registry entry still say
   `genclass-dev/GenClass-lib`, while the public repository is `genclass-dev/GenClass`. The old URL resolves (same
   HEAD), so nothing is broken, but directories that copy the npm or registry metadata will show the old name. Fix
   both files at the next `@genclass/mcp` release. The entries here link the new name only.
2. **`packages/mcp/README.md` mixes both names** (for example line 46 "the marketplace in `genclass-dev/GenClass-lib`",
   line 304 `npx skills add genclass-dev/GenClass-lib`, and the AGENT.md link on line 371).
3. **`docs/adoption/listings/mcp.md` "What is true today" is stale.** It says `@genclass/mcp` 0.1.0 is not on npm and
   that the public URL is `GenClass-lib`. npm has 0.2.1 as `latest`. Its punkpeye draft also links `GenClass-lib`.
4. **"Nothing leaves the machine" is too broad as a listing claim.** The brief lists it as a verified fact, but the
   package README names three opt-in exceptions: `genclass_analytics {source: "production"}`,
   `genclass_scan {hosted: true}` and `GENCLASS_REPORT`. The entries say "local by default" (TensorBlock) and "local"
   (MobinX), and the sidecar's auth notes name the opt-ins. Reword "Texts to reuse" in `mcp.md` the same way.
5. **No docs link that isn't in a `/mcp` folder.** TensorBlock's indexer reads any URL whose path ends in `/mcp` as a
   remote endpoint, so `.../tree/main/packages/mcp` can't be used as a docs link there. The README blob link works.
   This isn't a GenClass bug, but other indexers that use the same heuristic will hit it too.

## Time spent

About 1 hour 15 minutes: reading the briefs and rules, cloning, reading the indexer, the `tools/list` check, the
entries, TensorBlock's build and tests, MobinX's duplicate scan over all PR heads, and these files.
