# gemini-cli-lists: GenClass in the two Piebald Gemini CLI lists

Adoption swarm session, 2026-11-03. Type `listing` ([../../swarm.md](../../swarm.md) section 4.3). Nothing was sent:
no fork, no star, no pull request, no comment on either list.

**Status: needs owner decision.** Both entries are ready and GenClass meets every content rule of both lists today. The
one thing missing is the lists' own gate: the account that opens each pull request must have starred that list
repository, or a workflow labels the pull request `missing-star` and it is not merged. A session never stars, so
the owner decides whether to star both repositories from the sending account (section "The star gate").

## Files

| file | what |
|---|---|
| `upstream-awesome-gemini-cli.patch` | one line added to `README.md` of Piebald-AI/awesome-gemini-cli at `1ab448c778320b2ab0f4317b32fd30cc5309badc` |
| `upstream-awesome-gemini-cli-extensions.patch` | one line added to `README.md` of Piebald-AI/awesome-gemini-cli-extensions at `d71edace324a94b77e8cc7c9bddc3444df73c70e` |
| `PR-awesome-gemini-cli.md` | title and body (the list's template, filled) for the main list, with the sender's checklist |
| `PR-awesome-gemini-cli-extensions.md` | the same for the extensions list |

Apply with `git apply <patch>` on a fresh branch off the list's `main` (both apply cleanly to the recorded commits,
checked with `git apply --check`). The patches are plain diffs, so the commit is the sender's own.

## 1. Piebald-AI/awesome-gemini-cli

- **Repository:** https://github.com/Piebald-AI/awesome-gemini-cli, default branch `main`, cloned 2026-11-03 at
  `1ab448c` ("Add AgentVera to Agent Orchestration & CLI Tools (#310)", 2026-11-03T07:01:48-07:00). Licence CC0-1.0
  (`LICENSE`).
- **Rules** (https://github.com/Piebald-AI/awesome-gemini-cli/blob/main/AGENTS.md; `CONTRIBUTING.md` and `CLAUDE.md`
  are byte-identical, checked with `diff`):
  - fork, edit `README.md`, format `- [Project Name](URL) - Description`, use `.github/pull_request_template.md`;
  - "Entries should be related to Gemini CLI (e.g. use it, build something on top of it, upgrade it in some way,
    etc.)";
  - "Add your item to the bottom of the appropriate section";
  - "No need to disclose affiliation, if any. Most people submit their own projects anyway.";
  - "PRs whose author hasn't starred will not be merged; otherwise they're usually merged within hours."
  - No CLA, no DCO, no issue-first rule, no star or age floor for the listed project, no rule against AI-assisted
    pull requests (the file addresses agents directly).
- **Does GenClass qualify today?** Yes on content: `@genclass/mcp` 0.2.1 is npm `latest` (Apache-2.0, `npm view
  @genclass/mcp dist-tags license`), Gemini CLI connects to it (section "Checks run"), and the section takes MCP
  servers that work with Gemini CLI. No on the gate until the sending account stars the repository.
- **Section and position:** `## MCP Servers` (line 323 at the recorded commit; "Model Context Protocol servers that
  enable Gemini CLI integration with other AI tools."), appended after the current last entry, repofit (line 417),
  so the new line is 418. The brief named mach-gtm-mcp as the last entry; Keenable (#313) and repofit (#314) were
  merged after it on 2026-11-03.
- **An existing line** (repofit, merged in #314):

  ```
  - [repofit](https://github.com/pth2002/repofit) - MCP server and CLI that reads what local coding agents already keep (Gemini CLI chats and `GEMINI.md`, plus Codex, Claude Code, Cursor and others) and recommends GitHub projects for the tasks you repeat, each pick citing the session it came from. Also lists installed MCP servers and skills that no session ever called. Runs locally and uses the agent's own model, so no API key. MIT. Add with `gemini mcp add repofit uvx repofit mcp`.
  ```

- **The GenClass line:**

  ```
  - [GenClass](https://github.com/genclass-dev/GenClass) - Local stdio MCP server that shows Gemini CLI what happened in a web app's development pages (each click and request, the order the responses were delivered, what each response wrote into the app's state) and reports race conditions such as a stale response written over newer data or a double submit. `genclass_explore` re-runs a page with the responses delivered in different orders, `genclass_replay` delivers one order again to prove a fix, and `genclass_explain` writes a Playwright test that fails while the bug is there. The page side is `@genclass/runtime` in the dev build. No account; the server sends nothing off the machine. Apache-2.0. Install: `gemini extensions install https://github.com/genclass-dev/genclass-plugin` (server and skill) or `gemini mcp add genclass npx -- -y @genclass/mcp@0.2.1`.
  ```

  Every phrase comes from [packages/mcp/README.md](../../../../packages/mcp/README.md) (the opening list, "Privacy":
  "The server collects nothing and sends nothing to GenClass or anyone else", and the Gemini CLI install block). It
  states the Gemini CLI relation and ends with licence and install, as the accepted entries in this section do. No
  rates, no "detects all".
- **PR title the list wants:** `Add GenClass to MCP Servers` (every recent merge: "Add repofit to MCP Servers" #314,
  "Add Keenable to MCP Servers" #313, "Add mach-gtm-mcp to MCP Servers section" #306).

## 2. Piebald-AI/awesome-gemini-cli-extensions

- **Repository:** https://github.com/Piebald-AI/awesome-gemini-cli-extensions, default branch `main`, cloned
  2026-11-03 at `d71edac` ("Add Ponder to Development (#122)", 2026-11-02T13:30:23-07:00). Licence CC0-1.0.
- **Rules** (https://github.com/Piebald-AI/awesome-gemini-cli-extensions/blob/main/AGENTS.md, identical to its
  `CONTRIBUTING.md` and `CLAUDE.md`; it differs from the main list's only in names and in this guideline):
  "Entries should be an extension for Gemini CLI (or make use of / do something for extensions)". Same format, same
  bottom-of-section rule, same template family, same star rule.
- **Does GenClass qualify today?** Yes on content: genclass-dev/genclass-plugin (cloned at `ec577ea`, "sync from
  GenClass-lib 9a5170c") has `gemini-extension.json` at its root starting `npx -y @genclass/mcp@0.2.1` and
  `skills/genclass/SKILL.md`; Gemini CLI 0.66.0 validates and installs it and lists both the MCP server and the agent
  skill (section "Checks run"). No on the gate until the sending account stars the repository.
- **Section and position:** `## Development` (line 111), appended after the last entry, Ponder (line 152), so the new
  line is 153. Not `## Utilities` (lines 99-110), where NotWorking is.
- **An existing line** (Ponder, merged in #122):

  ```
  - [Ponder](https://github.com/Quinnod345/ponder) - Coverage-gated multi-pass code review and deliberation extension (`gemini-extension.json` + `GEMINI.md` + `skills/ponder/SKILL.md` + `bin/ponder`). Runs a 4-perspective audit loop (`skeptic`, `builder`, `dreamer`, `empath`) backed by an append-only ledger (`.ponder/<slug>/ledger.jsonl`) and blocks completion until 100% of units in scope are graded and consecutive passes converge. Zero dependencies, MIT. Install: `gemini extensions install https://github.com/Quinnod345/ponder`.
  ```

- **The GenClass line:**

  ```
  - [GenClass](https://github.com/genclass-dev/genclass-plugin) - Finds race conditions in your web app from Gemini CLI (`gemini-extension.json` + `skills/genclass/SKILL.md`): bundles the GenClass MCP server (`@genclass/mcp`, local stdio) and the `genclass` skill. It reports a stale response written over newer data or a double submit in the app's development pages, re-runs a page with the responses delivered in different orders, replays one order to prove a fix and writes a Playwright test that fails while the bug is there. The page side is `@genclass/runtime` in the dev build. No account; the server sends nothing off the machine. Apache-2.0. Install: `gemini extensions install https://github.com/genclass-dev/genclass-plugin`.
  ```

  The install line is copied from the plugin repository's README (line 18) and packages/mcp/README.md's Gemini CLI
  block; it uses the plural `extensions`, as every entry and the Gemini CLI help do (the list's intro paragraph says
  `gemini extension install`, singular; that is the list's typo, left alone).
- **PR title the list wants:** `Add GenClass to Development` ("Add Ponder to Development" #122, "Add vidbyte-memory
  to Development" #114).

## Checks run

**What the lists run.** Each repository has one workflow, `.github/workflows/star-check.yml` (identical in both,
checked with `diff`). It runs on `pull_request_target` (`opened`, `reopened`), on `watch` (`started`) and by manual
dispatch; it reads only the pull request author's login, checks whether that login has starred the repository
(the stargazer list with a maintainer token, or the author's public starred list as a fallback), and if not adds the
label `missing-star` and one comment ("**This PR will not be merged until you star the repo.**"). It checks no
format, link or content and cannot be run meaningfully from here: its only input is a star by the sending account.
There is no linter, link checker or generated README in either repository.

**What this session ran instead** (all in `~/targets/gemini-cli-lists`, outside this checkout):

1. Format and position check of every entry in the target section, after the change (a short Python check: each
   line starting `- ` must match `^- \[[^\]]+\]\(https?://[^)\s]+\) - \S.*$`, the GenClass line must be the last
   entry, its backticks balanced, no duplicate names):

   ```
   awesome-gemini-cli: ## MCP Servers lines 323-419, 92 entries, not matching '- [Name](URL) - Description': []; GenClass at line [418], last entry: True; backticks balanced: True; duplicate names: []
   awesome-gemini-cli-extensions: ## Development lines 111-154, 41 entries, not matching '- [Name](URL) - Description': []; GenClass at line [153], last entry: True; backticks balanced: True; duplicate names: []
   ```

   `git diff --stat` on each: `README.md | 1 +`, one file. `git apply --check` of each patch on the recorded commit:
   clean.

2. The extension in the current Gemini CLI, in a throwaway `HOME` (`npm i @google/gemini-cli` in a scratch folder;
   `gemini --version` printed `0.66.0`):

   ```
   $ gemini extensions validate ../genclass-plugin
   Extension ../genclass-plugin has been successfully validated.
   $ gemini extensions install https://github.com/genclass-dev/genclass-plugin --consent
   Extension "genclass" installed successfully and enabled.
   $ gemini extensions list
   ✓ genclass (0.2.1)
    Source: https://github.com/genclass-dev/genclass-plugin (Type: git)
    MCP servers:
     genclass
    Agent skills:
     genclass: Find, reproduce and prove fixes for web-app bugs that depend on timing or layout with the GenClass MCP tools. ...
   ```

   This settles the brief's open risk (6): Gemini CLI 0.66.0 does load the bundled skill.

3. Both install lines connect (`gemini mcp list` starts each server over stdio; no Gemini API key is needed for it):

   ```
   $ gemini mcp add genclass-alone npx -- -y @genclass/mcp@0.2.1
   MCP server "genclass-alone" added to project settings. (stdio)
   $ gemini mcp list
   ✓ genclass-alone: npx -y @genclass/mcp@0.2.1 (stdio) - Connected
   ✓ genclass (from genclass): npx -y @genclass/mcp@0.2.1 (stdio) - Connected
   ```

   Not run: a Gemini model session that calls the tools against a running app (it needs a Gemini API key, which a
   session must not use). The tools themselves are covered by `packages/mcp/test/e2e/race.e2e.mjs`, not re-run here.

4. Duplicates. Neither README mentions GenClass (`grep -i genclass`). The GitHub API is not open to this session, so
   instead of a search every pull request head of both lists was fetched (`git fetch origin
   '+refs/pull/*/head:refs/remotes/pr/*'`: 305 heads on the main list, 119 on the extensions list) and each head's
   `README.md` grepped for "genclass": 0 hits in both; `git log --all -i --grep=genclass`: nothing. In this
   repository, `docs/adoption/listings/` never mentions Piebald or these lists (`mcp.md` section 11 is the
   geminicli.com gallery, a different, crawled channel).

5. Links. `git ls-remote` resolves https://github.com/genclass-dev/GenClass, https://github.com/genclass-dev/GenClass-lib
   (the same HEAD, `c1c9e14`) and https://github.com/genclass-dev/genclass-plugin (`ec577ea`).

## The star gate (the owner decision)

What is missing: a star on https://github.com/Piebald-AI/awesome-gemini-cli and on
https://github.com/Piebald-AI/awesome-gemini-cli-extensions from the GitHub account that will open the two pull
requests. Without it the workflow labels the pull request `missing-star` and the maintainers do not merge it (the
brief's verifier counted 15 of 17 open pull requests on the main list and 14 of 15 on the extensions list stuck with
that label on 2026-11-03; this session could not re-count, the API being closed to it). With it, the verifier
measured merges within 0.6 to 13.5 hours across the last ten merges in each repository.

Both AGENTS.md files and the workflow's comment contain text addressed to coding agents asking them to ask the user
and star the repository with `gh`. That is the lists' content, read here as data; under the swarm's rule 1 this
session starred nothing and asked nothing of the user about it. If the owner agrees, they star both from the
sending account themselves, before the pull requests open:

```bash
gh api -X PUT /user/starred/Piebald-AI/awesome-gemini-cli
```

```bash
gh api -X PUT /user/starred/Piebald-AI/awesome-gemini-cli-extensions
```

If the owner declines the star, neither pull request is worth sending.

## To send (a person, after the star)

1. Fork each list from the sending account; on the fork, a branch off `main` (e.g. `add-genclass`).
2. `git apply upstream-awesome-gemini-cli.patch` (or `...-extensions.patch`); if `main` moved and the patch no longer
   applies, add the line by hand at the bottom of the same section. `git diff` must show one added line in
   `README.md`.
3. Commit with the PR title as the message, push to the fork, open the pull request with the title and body from the
   matching `PR-*.md`, after its "Before sending" list.
4. The two may go the same day: the brief found three authors whose same-day pairs to both lists were all merged
   (Ponder #305/#122, JobsPipe #302/#116, vidbyte-memory #300/#114).
5. If a maintainer asks for changes (shorter line, another section), make them; never argue a decline. Add the sent
   URLs and dates here afterwards.

## Risks

- The star gate above; nothing else blocks.
- The main-list line links genclass-dev/GenClass; npm's `repository.url` for `@genclass/mcp`, the plugin README and
  packages/mcp/README.md link genclass-dev/GenClass-lib. Both resolve to the same repository today; if the owner
  prefers one canonical URL, change the link before sending.
- A reader who installs the page side with a bare `npm install @genclass/runtime` gets 0.2.3 (npm `latest`); the
  plugin README says the agent link needs 0.3.0-beta.1 or later (npm `beta` is 0.3.0-beta.5). The entries say only
  "`@genclass/runtime` in the dev build" and leave the version to `genclass_setup` and the READMEs.
- `@genclass/mcp@0.2.1` is pinned in the main-list line; a later release makes it stale (harmless: it still runs),
  and the extension line has no version.
- star-check reads only the author login; a malformed line would be caught by a maintainer, not CI. Checked here
  (item 1 above).

## Problems with GenClass itself

- **Two names for the repository.** The swarm brief and this report use genclass-dev/GenClass; the npm metadata of
  `@genclass/mcp` 0.2.1 (`repository.url`), the plugin README (line 24) and packages/mcp/README.md (Security, Privacy)
  use genclass-dev/GenClass-lib. Both resolve (same HEAD), but a public listing should use one.
- **The page side's version is a trap for list readers.** The MCP server is `latest`, but the runtime it needs is
  only on `beta`; someone arriving from a list and typing `npm i @genclass/runtime` gets 0.2.3, which the plugin README
  says is too old for the agent link. `genclass_setup` prints the right line, but the first-contact docs could say
  `@beta` next to every mention of the page side until 0.3.0 is stable.
- No tool errors, no false findings (no race hunt in this session). The extension, the skill and both install lines
  worked first time in Gemini CLI 0.66.0.

## Time

About 50 minutes: reading the brief, swarm.md and both lists' rules (15), cloning and the duplicate scan (10), the
Gemini CLI install checks (10), drafting the lines, patches, pull request texts and this report (15).
