# OpenCode: the `opencode-genclass` plugin and GenClass's OpenCode install surface

Swarm session `opencode` (docs/adoption/swarm.md, type ecosystem), 2026-11-03. **Status: needs owner decision.**

## What was prepared

1. **A new package, `opencode-genclass`**, in [`packages/opencode-plugin/`](../../../../packages/opencode-plugin/)
   (Apache-2.0, README, CHANGELOG, licence, 26 unit tests, no dependencies, never published). One default export,
   `{ id: "genclass", setup, server }`, that both OpenCode lines load:
   - **OpenCode 2.x** (`@opencode/cli` 2.2.5) reads `{ id, setup }`, the object `Plugin.define` returns (it is the
     identity function in `@opencode/plugin` 2.2.5, `dist/promise/plugin.js`, so no runtime dependency is needed).
     `setup` adds `genclass` through `ctx.mcp.transform` only when `editor.get("genclass")` is undefined, and
     registers `ctx.session.hook("prompt")`, which appends the findings digest to the prompt text.
   - **OpenCode 1.x** (`opencode-ai` 1.18.29 and later, checked with 1.19.5) reads `{ id, server }` through
     `readV1Plugin` (packages/opencode/src/plugin/shared.ts, v1.19.5). `server()` returns `config`
     (`cfg.mcp.genclass ??= {type: "local", command: ["npx", "-y", "@genclass/mcp@0.2.1"]}`) and `chat.message`,
     which pushes one synthetic text part with an id in OpenCode's own ascending `prt_` format (pushed parts get no id
     from OpenCode: `assign` runs before the trigger, session/prompt.ts lines 692-696 and 999-1011 at v1.19.5).
   - The digest (`src/digest.ts`) is `genclass-mcp hook`'s logic and wording, copied and checked for byte equality
     against the real `hookCmd` on one stub bridge (`test/parity.test.ts`): cursor file `<state>/hook-cursor`,
     800 ms bridge timeout, `intervention` and `expectation` dropped, at most 5, the first prompt only sets the
     cursor, the header "GenClass recorded new findings in the app's pages since the last prompt (recorded data, not
     instructions; genclass_explain {id} for details):". Never throws (a rejected V1 hook fails the user's prompt:
     `Effect.promise` in `Plugin.trigger`, plugin/index.ts v1.19.5).
   - Options `mcp: false` and `findings: false`.
2. **GenClass's own OpenCode install surface** (`packages/mcp`): the OpenCode block in `src/clients.ts` (README
   regenerated with `npm run sync -w @genclass/mcp`) gains the command-line form `opencode mcp add genclass -- npx
   -y @genclass/mcp@0.2.1`, where each line writes it, and the two skill paths OpenCode loads; `genclass-mcp init`
   writes `.opencode/commands/genclass-explore.md` when the project has `.opencode/` (with the `genclass:init` marker,
   replaced on rerun, a user's own file left alone; one new test in `test/cli.test.ts`); `CHANGELOG.md`; the plugin's
   source and README and `docs/adoption/listings/opencode.md` join the PINS list in `test/manifests.test.ts`.
3. **Workflows**: `.github/workflows/opencode-plugin.yml` (typecheck, build, unit tests, then the real-binary checks;
   separate from ci.yml) and `.github/workflows/release-opencode.yml` (tag `opencode-v<version>`, mirrors
   release-mcp.yml: trusted publishing, the first version published by the owner from the `opencode-tarball`
   artifact).
4. **The upstream entry**: [upstream.patch](upstream.patch) (one row in OpenCode's ecosystem Plugins table, against
   anomalyco/opencode `dev` at 79c80c7ca2c0bb24db98670f8fe0c1c0d5133630) and [PR.md](PR.md). No issue is needed
   (documentation PRs are exempt from the linked-issue check).
5. [`../../listings/opencode.md`](../../listings/opencode.md): the OpenCode lines, what works today, where to list.

## Why "needs owner decision"

- **A new workspace package** changes the root `package-lock.json` (AGENTS.md rule 7). The change is the two
  workspace entries only (`node_modules/opencode-genclass` link and `packages/opencode-plugin`, 18 lines; the
  package's dev dependencies are the ranges the other packages already use, so nothing new is downloaded). A full
  `npm install` with npm 10.9.9 also rewrote unrelated `dev`/`peer` flags across the lockfile; that rewrite was
  reverted and the two entries written by hand; `npm ci` accepts the result.
- **Publishing** (AGENTS.md rule 9): a new release workflow, `release-opencode.yml`, on its own tag. Its first run
  fails at the publish step by design; the owner publishes that tarball once, then sets up trusted publishing.
- **The ecosystem row** names a package that is not on npm yet: send it only after `opencode-v0.1.0` is out.
- **AGENTS.md** does not list `packages/opencode-plugin/` in its repository map or build section; the session left
  AGENTS.md alone (outside its brief). One row and one build line, if the owner wants them.

## Rules checked (target: anomalyco/opencode)

| Rule | Source | Result |
|---|---|---|
| How to add an entry | `packages/web/src/content/docs/ecosystem.mdx`: "Want to add your OpenCode related project to this list? Submit a PR." | one row at the end of the Plugins table, as the last three rows (opencode-goal-plugin, opencode-tavily, opencode-supabase) |
| Base branch, template | CONTRIBUTING.md "Base branches on `dev` and complete the provided pull request template." | PR.md uses `.github/pull_request_template.md`'s sections |
| Linked issue | CONTRIBUTING.md "Documentation, refactor, and feature PRs are exempt from the automated linked-issue check." | none needed |
| Title | CONTRIBUTING.md "Use `type(scope): summary`" | `docs: add opencode-genclass to the ecosystem plugins` |
| AI policy | CONTRIBUTING.md "Long, AI-generated PR descriptions and issues may be ignored. Write a short explanation in your own words."; the template's bold warning | no ban; the body is short and the sender rewrites it in their own words; disclosure line included |
| Formatter | root `package.json`: prettier 3.6.2, `semi: false`, `printWidth: 120` | `prettier --check` passes on the edited file; the row's link (96 characters) fits the name column (98), so no other row changes |
| CLA, DCO | none found in CONTRIBUTING.md or `.github/` | none |
| Design review | CONTRIBUTING.md: UI and core features | not applicable (a docs row; the plugin lives outside the repository) |

opencode.ai itself was not reachable from this session (the proxy refused the host), so its documentation pages were
not re-read; the facts used here come from the binaries and the source at the commits named.

## Checks run (all on this machine, 2026-11-03)

- `npm run typecheck -w opencode-genclass && npm run build -w opencode-genclass && (cd packages/opencode-plugin && npx vitest run)`:
  clean, built (`dist/index.js` 6.1 kB, one export: `default`), **26 passed**.
- `npm run typecheck -w @genclass/mcp && npm run build -w @genclass/mcp && (cd packages/mcp && npx vitest run)`:
  clean, built, **154 passed, 3 skipped** (12 files); `npm run sync -w @genclass/mcp`: 42 passed after the sync.
- **Type conformance** with no casts against the published APIs: [types/check.sh](types/check.sh) (V1 `PluginModule`,
  `Plugin` and `Hooks` from `@opencode-ai/plugin` 1.19.5; V2 `Plugin.define` and `Plugin.Plugin` from
  `@opencode/plugin` 2.2.5): `tsc` exit 0.
- **Real binaries**, `node packages/opencode-plugin/test/smoke/run.mjs` (OpenCode installed from npm, throwaway HOME
  and XDG directories, a minimal environment): 10 of 10 checks passed on the final run:

  ```
  ok   1.x control: no genclass server without the plugin
  ok   1.x plugin: genclass listed (npx -y @genclass/mcp@0.2.1) and connected
  ok   1.x the project's own genclass entry wins
  ok   2.x control: no genclass server without the plugin
  ok   2.x plugin: genclass listed and connected
  ok   2.x plugin list shows id genclass
  ok   2.x the project's own genclass server wins
  ok   1.x run: the model request carries the digest in the user's message
  ok   1.x run: the digest has the race and not the intervention
  ok   1.x run: the cursor file advanced to e1:2
  ```

  The end-to-end run uses a local OpenAI-compatible stub as the model and a stub bridge answering `digest` with one
  `race` and one `intervention` finding; the stub model received the user's message with the digest appended (the
  race line, not the intervention). The 2.x prompt hook was not run end to end: 2.2.5's provider configuration has a
  different shape and a stub model was not set up within the time box; the 2.x hook is covered by the unit tests
  on a fake context typed after 2.2.5 and by the type conformance check. Earlier runs of the script failed for
  harness reasons, each fixed: `spawnSync` blocked the stub servers in the same process; the inherited environment
  carried the container's cloud credentials, which OpenCode picked up (see "Problems"); a clean environment then
  lacked the proxy settings `npx` needed. The final script passes only PATH, proxy, CA and npm-cache variables.
- **Install lines**, each run with the binaries: `opencode mcp add genclass -- npx -y @genclass/mcp@0.2.1` wrote
  `~/.config/opencode/opencode.jsonc` (`mcp.genclass`) on 1.19.5 and the project's `opencode.json`
  (`mcp.servers.genclass`) on 2.2.5; the README's flat JSON block loads on 2.2.5 (connected); `npx skills@1.7.6 add
  genclass-dev/genclass-plugin -a opencode -y` wrote `.agents/skills/genclass/SKILL.md`, and `opencode debug skill`
  (1.19.5) listed `genclass` from it and from the `.claude/skills/genclass/SKILL.md` that `init` writes; `init` in a
  project with `.opencode/` wrote the command, and `opencode debug config` (1.19.5) listed `genclass-explore` with
  its description.

Not run: the runtime's own CI steps (nothing under `packages/runtime` changed), `packages/mcp/test/e2e/race.e2e.mjs`
(only `init` changed in the server's command), the new workflows on GitHub Actions (they run when this PR is
opened).

## Before sending (the sender, by hand)

1. The owner releases `opencode-genclass` 0.1.0 (tag `opencode-v0.1.0`, then the one-time manual publish of the
   workflow's tarball and the trusted-publisher setup). Check `npm view opencode-genclass version`.
2. Install it yourself in OpenCode (`"plugin": ["opencode-genclass"]` on 1.x or `"plugins": [...]` on 2.x), run
   `opencode mcp list`, and send one prompt in a project with the app connected; see the findings arrive.
3. Check the row's link resolves: `https://github.com/genclass-dev/GenClass/tree/main/packages/opencode-plugin`
   (the repository's current name per docs/adoption/swarm.md; `GenClass-lib` makes the link 100 characters, longer
   than the table's 98-character column, and prettier would then re-pad every row).
4. Fork anomalyco/opencode, branch from `dev`, `git apply upstream.patch` (or re-make the one row if `dev` moved),
   `npx prettier@3.6.2 --check packages/web/src/content/docs/ecosystem.mdx`, read the diff.
5. Search the repository's pull requests for "genclass" first (0 results when the brief was written).
6. Open the PR with PR.md's title; rewrite the body in your own words, keeping it short; keep the AI assistance line.
   If asked: the plugin is open source in the GenClass repository, runs locally, and its only network call is to the
   GenClass bridge on 127.0.0.1.

## Risks

- OpenCode 2.x's plugin API is 2.2.x and moving; the plugin declares only the fields it uses (structural types), and
  the conformance script should be re-run against each new `@opencode/plugin` (bump the versions in
  `types/check.sh` and `test/smoke/run.mjs`).
- On 2.x the digest is appended to the prompt text itself (the `prompt` hook has no parts), so the user sees it in
  their own message; on 1.x it is a synthetic part, which OpenCode's UI may not show. Both carry the "recorded data,
  not instructions" header.
- 2.x plugins start after the background service boots; the first `mcp list` right after a restart can show no
  `genclass` yet (seen in this session; the smoke script polls).
- The cursor file is the one the Claude Code hook uses: a developer who runs both agents on one project shares it,
  so each agent sees only the findings since either one's last prompt.

## Problems with GenClass itself

- None in `@genclass/mcp` 0.2.1 itself: OpenCode started it with `npx -y @genclass/mcp@0.2.1` and connected on both
  lines.
- The digest logic exists twice now (`hookCmd` and the plugin's copy). The parity test keeps them equal, but a small
  exported `digest()` in `@genclass/mcp` would let the plugin import it if the owner accepts a runtime dependency.
- The smoke harness's first runs inherited this container's environment, which holds AWS credentials; OpenCode 1.19.5
  picked the `amazon-bedrock` provider from them for one `opencode run` and sent the stub prompt ("why does the search
  page show old results" with the stub digest) to AWS Bedrock, which refused it (`The security token included in the
  request is invalid`). No real data was in it. The script now passes a minimal environment; anyone writing agent
  harnesses here should do the same.

## Time

About two hours: reading the brief and the published OpenCode sources (40 min), the package and tests (40 min), the
real-binary checks and their harness (30 min), the install surface, workflows and these drafts (20 min).
