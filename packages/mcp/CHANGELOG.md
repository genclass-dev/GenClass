# Changelog

## Unreleased

Systematic explore (docs/runtime/AGENT.md section 5). The default plan and every existing report line are unchanged.
The new orders and the coverage need a page runtime with the agent link's `lifo`, `ranked`, `reverse`, `delaySeed` and
net timing log (unreleased, after `@genclass/runtime` 0.3.0-beta.5); a page whose hello does not list them gets
schedules it can run, labelled, and its report says what it lacks.

- **`plan: "systematic"`** for `genclass_explore {action: "start"}`, opt-in: two baselines, one `lifo` load (every
  overlapping response pair the other way), `runs - 1` cover rows chosen from the baselines' timing (sequence covering
  arrays: each row a `ranked` order, rows in pairs that, given enough of them, deliver every ordering of every
  overlapping triple), and a third baseline last: `runs + 3` page loads, with `slow_ms` all with the same added
  latency and delay seed. 3 to 8 requests in flight together take `runs` 5, 7, 9, 9, 11 and 11 for every ordering; the tool's description
  says so. The cover is computed when a baseline settles, never at a page's hello, and fixed from the first row handed
  out; a slot without a row runs a seeded stand-in ("seed 2", "seed 2 reversed"). Its false-report rate is not
  measured yet: `seeded` stays the default, byte for byte what it was. `slow_mode`: `"uniform"` (0 to `slow_ms` per
  response, the seeded default) or `"fixed"` (`slow_ms` for every response, the systematic default). Its baselines all
  share the added latency, so it does not name what a slow response alone does (the seeded plan's load without it does).
- **What a page can run** (its hello `caps`) is checked at every hello: an explore position it cannot run gets a
  stand-in it can, labelled "(page runtime has no lifo)" and noted on the run (`genclass_status` shows the notes); a
  replay gets the finding run's recorded order; a minimise probe waits for a page that runs `ranked`. A page whose
  runtime rejects a schedule anyway falls back to `natural`: the load is not counted as that schedule, an explore
  position comes back once as a stand-in that needs nothing of a runtime, labelled with what that page could not run
  (never a cap its hello listed), and nothing is queued twice. A page-set schedule of an order the bridge does not know
  gets no assignment.
- **Coverage**, for both plans, from the pages' net timing log: each scenario's report says how many overlapping
  response pairs some run delivered both ways and how many orderings of overlapping triples it tried ("Coverage: 10 of 10
  overlapping response pairs delivered both ways; 53 of 60 orderings of 10 overlapping triples"), names up to three
  pairs never delivered the other way with why ("did not overlap when reordered (sent by X's handler)", or not tried,
  with what to run), and, when orderings are missing, the `runs` of a systematic session whose cover rows try every one
  (`genclass_explore {action:"start", plan:"systematic", runs:9}`), or that the session already armed them, or why no
  number of runs does. A page runtime without the log gets "coverage needs @genclass/runtime with the net timing log".
- **Minimise**: `genclass_replay {action: "minimize", id}` on a race from explore arms probes, each the first baseline's
  start order with one response of the failing order moved (the smallest moves first, at most 12), one page load each;
  `genclass_replay {action: "result"}` names the smallest reordering that reproduces the race, exact ("the one inverted
  pair") or not, and the finding replays it from then on (its regression test too). A probe whose page ends with another
  wrong value than the failing run's, none of the baseline's, reproduces it ("other values"), and so does a replay of
  that order. A probe that did not deliver the order it was built for is inconclusive and says why.
- **The replay order check**: a replay of a race whose harmful order is known (a minimal reproduction, else the failing
  run's inversions) counts only when that order happened in it; otherwise it is inconclusive ("the harmful order did
  not happen in this run ... run explore again"), never "not reproduced". A fix that stops sending the older request is
  proven by a new explore.
- **Race findings** keep the failing run's inversions, the first baseline's start order and the requests that ended
  without a response, so minimise and replays need no baseline later; a race whose failing run delivered nothing out of
  request order is titled "The final state depends on response timing". `genclass_explain` lists the inversions.
- **Regression tests** assert the schedule the page put in force (`window.__GENCLASS_AGENT__.schedule`: its order,
  `reverse`, `delaySeed` and every `ranks` key), so an older runtime that ignores the order makes the test fail
  instead of pass on the bug.
- **API**: `explore.start` takes `plan` and `slowMode`; `finding.minimize`; `replay.result` adds a `minimize` field
  beside its unchanged `results`; `status` lists armed probes and run notes. Validation of the new fields (`caps`,
  `ranks`, `reverse`, `delaySeed`, the net log: 2,000 keys, numbers finite and non-negative, strings capped). What
  `GENCLASS_REPORT` sends is unchanged.
- `test/e2e/systematic.node.mjs`: the systematic plan end to end in Node through the real runtime and bridge, with a
  simulated page (no browser): 126 checks, RESULTS.md section 28.

## 0.2.2 (2026-11-05)

- **The agent shows each action and waits for a yes.** The skill (the plugin's, the root copy and the one `init`
  writes) and the server's instructions now stop before what changes someone's project or sends something out: running
  or adding what `genclass_setup` prints (the tool's answer opens with that step), `npx playwright install chromium`,
  `genclass_scan` with `hosted: true`, and a fix or a test when the user only asked what broke. The regression test is
  offered, not added. `genclass_scan`'s "Next" line and its message when Chromium is missing say the same, and the skill's
  terminal line for the visual checks passes `--local`, so without Chromium it stops instead of sending the URL to the
  page check. These are instructions to the agent, not locks in the code. Why: directories read the skill at a pinned
  commit (buildwithclaude closed #636, #627 and #490 over these steps and merged #515 for asking), and it is what
  someone who only asked a question should get.
- **The exact runtime.** `genclass_scan`'s `npx` and `genclass_setup`'s install line name
  `@genclass/runtime@0.3.0-beta.5` instead of `@beta`, as do the skill, `llms-install.md` and the READMEs in this package:
  what a server runs or an agent copies pins like a script tag, so whoever reads a commit knows what runs. The one
  source is `RUNTIME_VERSION` in `src/clients.ts`; `npm run sync -w @genclass/mcp` writes it and those files from
  `packages/runtime/package.json`, the build the e2e runs, `test/manifests.test.ts` fails when they differ or when one of
  them names a tag or a bare install, and `release-mcp.yml` stops if npm does not serve that version. The text still names
  the line (`0.3.0-beta.1` or later for the agent entry, npm's `latest` is 0.2.x), and the runtime's own docs keep `@beta`.
- **`GenClass.init()` is behind the development check too.** `genclass_setup` printed `const rt = GenClass.init();` outside
  the check, so following it put the runtime in production builds, where it sends anonymous diagnostics from public hosts
  by default. It now prints both lines inside the check, and a production build drops the runtime (a test bundles the
  printed lines with esbuild; Vite and Next.js 15 by hand, [RESULTS.md](../../docs/runtime/RESULTS.md) section 26). The same
  block is in the READMEs, `llms-install.md` and `AGENT.md`, and the text says plainly what moving `GenClass.init()` out of
  the check would do. An app that already runs GenClass keeps its setup: `init` returns the running runtime.
- **The READMEs and manifests say what can leave the machine**, instead of "sends nothing" (no code change).

- **`genclass_explore`'s verdict on real apps.** On 2026-11-04 four hunts ran explore next to their own page checks; on
  fixed builds where the page was right it said RACE in 85 of 120 reordered runs (OpenCode request counts, n8n's generated
  field names, Open WebUI's relative times and counts), and it missed real bugs. Rescored from those reports: 0 of 120
  ([RESULTS.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md), "explore's verdict on real
  apps", with what the rescoring cannot see and the recall next to it). What changed:
  - An age ("13 minutes ago", "an hour ago", "just now", "10m ago") is one line when the later load is older by about the
    time between the two, plus a minute, whatever the baselines did. Nothing else moves on its own: "3:30 PM", "today", "in 2 days" and a bare "3d" are
    values a page can get wrong, compared as they are unless the baselines show them varying.
  - A different non-zero count of a POST, with the page the same, is no race without two identical requests in flight or
    a user action sending it directly a different number of times. A POST one side never sent stays a race, however it was
    sent. PUT, PATCH and DELETE counts are as before. **Cost:** a duplicate POST behind another request or a timer, not
    overlapping, with the page unchanged, is internal now (measured there), and "No race found" says a duplicate write may
    have happened and to check what the server holds.
  - A field name some baseline lacks compares with itself by its shape (`el-id-*-32`, `*-input`); a name every baseline
    has is a name (`qty-100`), whatever row beside it is new.
  - **With `slow_ms` the plan has one more load**: a baseline with no added delay after the two slow ones (`runs + 3`
    loads; `--repeat-each 9` for `runs: 6`). What both slow baselines show the same and it does not is reported first
    (`RACE: a slow response alone changes the page`, a race finding replaying the slow schedule; `RACE, on one load's word`
    when no other load sides with it). What one slow baseline alone does, and a line only it shows, is named under "worth
    a look", and is no race.
  - Noise blanks only the tokens that varied, at their position: "version-1" against "version-2" stays a difference when
    a number elsewhere varied, and another number on that line may drift a little and no further.
  - Report text: page content before labels before counts, in each run's list and in which runs come first; the
    headline and the finding's title name that line; store values and refetch counts capped with a count of the rest.
  - Routes group by shape (`/session/<id>`, `/c/<uuid>`: a new path on every load also gets its armed schedule), an
    action only some loads did no longer splits a session, and a report that compared nothing says `NO VERDICT`, never
    beside a race finding.
  - Safe requests to other sites leave the counts unless a user action or the page's own origin led to them, and a bare
    count on the page is internal only when it stands for a store field one such response alone wrote, with no overwrite
    recorded on it. They still join the schedule (that needs the runtime's agent entry).
  - `sameValue` no longer backtracks on many redactions in a row: a page could hang the bridge for seconds with one value.
  - A race finding's report says to fix only if the user asked for a fix.

- **The plugin's repository vendors the server, and the lockfile is gone.** In
  [genclass-dev/genclass-plugin](https://github.com/genclass-dev/genclass-plugin), `.mcp.json` and the hook run
  `node ${CLAUDE_PLUGIN_ROOT}/server/genclass-mcp.mjs` instead of `npx -y @genclass/mcp@<version>`: `server/cli.mjs`
  is the published package's `dist/cli.js` at the plugin's version, byte for byte (`scripts/plugin-repo.mjs` fetches
  it from npm with `npm install --ignore-scripts` into a temporary prefix; `--server <package dir>` takes a local
  build instead), and `server/genclass-mcp.mjs` is the package's `bin/genclass-mcp.mjs` importing it. Why: Anthropic's
  directory holds a plugin whose launcher runs `npx <package>` for a reviewer ("Runs a pinned npx or uvx package"),
  and the lockfile this line had added for its "Launcher lock missing" warning (`plugin/package.json` and
  `plugin/package-lock.json`) earned the note "Launcher locked" but a second hold, "Dependencies install from a
  lockfile" (2026-10-28). The directory's own text names the way out: the package's built files inside the plugin,
  each under 256 KiB, run from `${CLAUDE_PLUGIN_ROOT}`, with no `package.json` or lockfile; so both files are removed
  again. The plugin folder in GenClass keeps the `npx` launchers (nothing built is committed here, and the
  marketplace in GenClass still lists it), and the Agent Plugins `mcp.json` keeps `npx` everywhere, because that
  format has no plugin-root variable (Codex and Cursor read it). The daily sync vendors the release of `package.json`'s
  version; between a bump and its release the script exits 3 and the repository stays as it is (its workflow treats
  that as nothing to do), so a release is: bump, `npm run sync -w @genclass/mcp`, tag, publish; the next sync vendors
  the new build. `test/manifests.test.ts` checks the assembled tree (the plugin folder byte for byte except the two
  launchers, the server byte for byte, no `package.json`, lockfile or `node_modules`, every file under 256 KiB) and
  that the vendored server runs.

- **The plugin has a repository of its own, [genclass-dev/genclass-plugin](https://github.com/genclass-dev/genclass-plugin)**:
  the plugin folder at the root, with marketplace files for Claude Code (`.claude-plugin/marketplace.json`), Codex
  (`.agents/plugins/marketplace.json`) and Cursor, the Gemini CLI manifest and the licence, assembled by
  `node packages/mcp/scripts/plugin-repo.mjs` (`npm run plugin-repo -w @genclass/mcp`) and re-synced there daily by
  its own workflow. Anthropic's directory stops validating a repository whose GitHub archive is over 50 MiB
  (GenClass's is 51), and Codex, Gemini CLI, `gh skill` and the skills CLI clone or read a whole repository for
  one plugin (Gemini CLI and `gh skill` read the latest GitHub release first, which in GenClass predates the
  plugin), so the small repository is what the install lines name: `/plugin marketplace add genclass-dev/genclass-plugin`,
  `codex plugin marketplace add genclass-dev/genclass-plugin` then `codex plugin add genclass@genclass`,
  `gemini extensions install https://github.com/genclass-dev/genclass-plugin`, `npx skills add genclass-dev/genclass-plugin`,
  `gh skill install genclass-dev/genclass-plugin genclass`. The marketplace in GenClass still lists the plugin.
- **A Codex marketplace file at the repository root**, `.agents/plugins/marketplace.json` (Codex's own format; Codex
  already read `.claude-plugin/marketplace.json`).
- **The skill's frontmatter names its licence** (`license: Apache-2.0`, the Agent Skills field `gh skill publish`
  recommends).

## 0.2.1 (2026-10-27)

- **The plugin has an icon** (`plugin/.claude-plugin/icon.png`, the genclass.dev mark, 512 by 512), which the Anthropic directory reads on the first save.
- **The instructions carry the "when", the skill the "how"** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 4.2). The server's `instructions` now open with the symptom words ("sometimes", "randomly", "only in
  production", "on slow connections", a value that "flips back", stale or old results, lost edits, double submits,
  sideways scrolling), all within the first 500 characters, keep one line per trigger saying what to call first, and
  name the `genclass` skill so a client that has it loads it (2,712 characters, under the 4,096 ceiling). The skill
  (`plugin/skills/genclass/SKILL.md`) no longer restates the triggers in its body: its frontmatter description is the
  trigger, with the same words early, and the body is the procedure (the explore arguments, the Playwright pairing,
  how to read "Compared: 6 of 6" against "No verdict" and "0 compared", that "Internal state only" and "Along the way
  only" are not races, witness against explore race against model detection, the reporting rule) plus a new section
  for when the `genclass_*` tools are missing (the pinned one-line install, or `npx @genclass/runtime@beta scan <url>
  --json` for the visual checks alone; GenClass needs Claude Code or another MCP client on the developer's machine,
  the chat app cannot run it).
- **`init` writes the skill without the plugin.** `genclass-mcp init` now also writes `.claude/skills/genclass/SKILL.md`
  into the project (the package's copy, resolved next to the built command, with a `genclass:init` marker line after
  the frontmatter), so Claude Code loads the procedure on a project set up with `init` or `claude mcp add` alone. A
  rerun replaces a file that carries the marker and leaves one that does not (yours, or edited), and says which;
  `--no-skill` leaves the skill out; a `CLAUDE.md` without a `.claude/` folder still gets it under `.claude/skills/`.
- **A repository-root copy for skill directories.** `skills/genclass/SKILL.md` is a byte-identical copy of the
  plugin's skill, so `npx skills add genclass-dev/GenClass` (skills.sh and directories that read a repository's
  root `skills/` folder) finds it; `npm run sync -w @genclass/mcp` refreshes the copy and pins the install line in
  both.
- Tests: `test/manifests.test.ts` checks the skill's frontmatter (name, a one-line description of at most 1,024
  characters with the symptom words early), that every `genclass_*` name in its body is a tool the server registers,
  that the body has the procedure and the fallback and no em-dash, that the root copy is identical, and that the
  instructions stay under 4,096 characters, put the symptom words in the first 500 and name the skill;
  `test/cli.test.ts` covers the skill written by `init`, the rerun on a marked and an unmarked file, and `--no-skill`.

## 0.2.0 (2026-10-25)

The `0.1.0` on npm (published 2026-10-25) is an earlier build: eight tools, no `genclass_scan`, no `GENCLASS_REPORT`.
Everything below ships first in `0.2.0`.

- **`genclass_setup` installs the newest runtime line.** It prints `npm install @genclass/runtime@beta` (the agent
  entry and interaction analytics need 0.3.0-beta.1 or later) for a project on 0.2.x, on a range without a version
  (`*`, `latest`: npm's `latest` is still 0.2.x) or with an older copy in `node_modules`, and says what the project
  has. The README's connect step names `@beta` first.
- **`genclass_scan {url, phone?, hosted?}`: audit any page in one step** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 4.2). It runs `@genclass/runtime`'s `scan --json` (the project's own runtime when it has the command, else
  `npx -y @genclass/runtime@beta`) in the project's folder: headless Chromium at desktop and phone sizes with the 23
  measured visual checks, and returns a score and each problem with its element, selector and suggested CSS fix (page
  text cleaned and labelled as data), plus the report as JSON (a second text block and `structuredContent`). It passes
  `--local` unless the agent sets `hosted: true`, so without Playwright's Chromium it says how to install it instead
  of sending the URL anywhere; `hosted: true` uses the genclass.dev page check (public pages only). The server's
  instructions and the plugin skill say to scan a page before calling a UI change done. Nine tools.

- **Fixed: a race replay counts page lines.** Explore compares page text as counts, so a product name the page
  always shows once and a stale result showed a second time was "only in the failing run"; the replay verdict then
  checked presence only, and the card alone made every replay "reproduced", including after the fix. The finding's
  evidence now keeps the counts (`textCounts`) and the verdict needs the line as many times as the failing run showed
  it. Found by the end-to-end walkthrough, covered by a test.
- **Fixed: with `GENCLASS_REPORT` set, the tools' own calls are mirrored too.** The server's in-process API (what
  `genclass_explain`, `genclass_replay`, `genclass_explore` and `genclass_clear` call when this session owns the
  bridge) bypassed the reporting wrapper, so a dashboard only ever received the findings; the evidence read, the test,
  replays armed and their verdicts, explore reports and clears reached it only through the bridge's HTTP path. Found
  by the end-to-end walkthrough (`docs/evidence/e2e-walkthrough`), covered by a test.
- **Opt-in reporting to the app's dashboard** (`GENCLASS_REPORT`; [docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 4.5). Set to `on` (with `GENCLASS_DASHBOARD`) or to a dashboard link, the server mirrors its log of the loop
  to that dashboard: each finding the bridge makes, each time the agent reads its evidence (`genclass_explain`), each
  replay armed and each replay verdict, each regression test written, each explore report (page loads compared, races
  found) and each clear: `POST /api/projects/<secret>/agent`, batched, best effort, ids, kinds, page paths, verdicts,
  counts and times only, never page text. The dashboard's Closed-loop development view then draws every issue's path
  (found, reproduced, fix proven, closed, or round again when a replay after a fix still reproduces it) with the
  period's counts, lists the log newest first, and shows per production problem what the agent reproduced, tested and
  proved fixed. Off unless set; nothing sent feeds a decision, a finding or a tool result.

- **Explore stops reporting order-dependent bookkeeping as races** ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
  section 5.1, [RESULTS.md](../../docs/runtime/RESULTS.md) section 22). A reordered run is a race only when what the
  page shows, its form values, the requests it sent or its errors differ from the request-order baseline; store values
  that differ while the page is the same are listed as "Internal state only", and an overwrite a later response
  repaired as "Along the way only", neither with a finding. A `[redacted]` value equals any value. Scenarios are
  grouped with digits blanked, parenthesised counts dropped and a typing burst split by a label change joined again,
  falling back to action kinds and element roles, then kinds, when names changed with the order; the report says how
  many reordered runs it compared and says "0 compared" (no verdict) rather than "No race found" when none was. Race
  finding titles, keys, replays and generated tests lead with what the page showed (store values only for a finding
  with nothing else). Snapshots may carry up to 1,200 store fields and say how many the page left out. The explore
  tool's description and the plugin skill say the same. On the Strapi admin's 21 interaction sessions the race-like
  verdicts went from 16 to 0 (reordered runs reported as races: 62, all false, to 0; sessions without a usable verdict:
  5 to 0), and the real 403 race is still found at 300, 600 and 900 ms (6 of 6 runs, 0 false); on a correct Redux
  Toolkit Query page the false reports went from 18 of 18 reordered runs to 0; the e2e page still finds its race in 5
  of 6 reordered runs and none on the fixed page.

- First version: the GenClass MCP server for coding agents ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)).
  A bridge on 127.0.0.1:47357 that pages connect to through `@genclass/runtime/agent`; eight tools
  (`genclass_status`, `genclass_findings`, `genclass_explain`, `genclass_explore`, `genclass_replay`,
  `genclass_analytics`, `genclass_setup`, `genclass_clear`); findings deduplicated and kept in
  `.genclass/agent/state.json`; explore verdicts from final states against request-order baselines; replays with
  reproduced / not reproduced verdicts; Playwright regression tests generated from a finding; new findings pushed as
  Claude Code channel events or through a `UserPromptSubmit` hook; one bridge shared by every agent session on the
  machine; production numbers read from the developer's GenClass dashboard. No dependencies. The bridge accepts pages
  only from the developer's machine (or origins listed in `GENCLASS_AGENT_ORIGINS`), binds each run to the page that
  registered it (origin and token), guards its agent API with a per-user token, quotes every page string it shows the
  agent and strips invisible characters. A Claude Code plugin (`plugin/`: the server, the prompt hook and a skill) and
  an MCP Registry entry (`server.json`) ship with it. Needs `@genclass/runtime` 0.3.0-beta.1 or later in the app
  (`@genclass/runtime/agent`). Released by `.github/workflows/release-mcp.yml` from a `mcp-v<version>` tag.
- Ready for registries and directories: a `server.json` description of at most 100 characters (the official MCP
  Registry's limit; checked against its 2025-12-11 schema and accepted by `mcp-publisher validate`), a `title` and
  `websiteUrl`; the release workflow publishes it to the registry with GitHub OIDC (pinned, checksummed
  `mcp-publisher`) after npm, and uploads an MCP Bundle (`npm run bundle`: `genclass-<version>.mcpb`, for Claude
  Desktop and Smithery) as an artifact. Every launcher is pinned to the release (`npx -y @genclass/mcp@<version>`):
  the plugin's server and hook, `init`, and the install blocks; `npm run sync` rewrites the pins from
  `package.json` and the tests fail when one differs. Install blocks for Claude Code, Claude Desktop, Cursor (with an
  install link), VS Code (`code --add-mcp` and an install link), Codex CLI, Gemini CLI, Windsurf, Cline, Goose, Zed,
  JetBrains IDEs and OpenCode, printed by `genclass-mcp config [client]` and in the README; `genclass_setup` adds the
  block for the client it runs in (from `clientInfo` at initialize). Every tool's annotations carry `title`,
  `readOnlyHint`, `destructiveHint` and `openWorldHint`. The plugin has a README (what it installs, what the hook
  sends where, how to turn it off), directory links in `plugin.json`, and an [Agent Plugins](https://agent-plugins.org)
  `plugin.json` and `mcp.json` for Cursor and Codex; the repository root has `glama.json`, `gemini-extension.json`,
  `llms-install.md` and `.cursor-plugin/marketplace.json`. Listing drafts: `docs/adoption/listings/mcp.md`.
