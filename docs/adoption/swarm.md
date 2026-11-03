# The adoption swarm: one session per target

Written 2026-11-03. Fifty cloud sessions each prepare one contribution that brings GenClass into an open-source project
or ecosystem, all at the same time. No session sends anything to a third-party repository or site: each one opens a
pull request against this repository with everything a person needs to send its contribution, and the owner (or the
session that launched the swarm, with the owner's go-ahead) sends it from a personal account, a few a day, and
answers the maintainers personally. This file is the brief every session reads first (sections 2 to 5), the roster
(section 6) and the loop that turns the sessions' pull requests into contributions (section 7).

## 1. Where GenClass can be added (the map)

What "adding GenClass" is in each kind of place, and why that place:

- **AI coding agents and their ecosystems** (`@genclass/mcp`, the plugin, the skill): registry entries, extension
  packages and plugins reachable by pull request (Zed's extensions repository, Goose's directory, OpenCode's plugins
  and lists, the Roo and Kilo marketplaces, Docker's MCP registry, the Copilot and Codex lists). The agents' users meet
  GenClass where they already install tools, and `genclass_explore` is something no other MCP server does.
- **Open-source web apps, by race hunt**: a real race found with explore, reproduced without GenClass, fixed with a
  regression test in the project's own style, with one disclosed sentence on how it was found. The strongest form:
  the maintainers and every reader of the issue see the tool do something. Seven hunts are drafted in
  [hunts/](hunts/), none sent.
- **Curated lists and directories**: one line each, by pull request where the list allows it (the form-only ones are
  in [listings/](listings/) for the owner).
- **Framework and dev-tooling integration points** (example apps, templates, devtools tabs) that take pull requests
  today. The ones that need `@genclass/nuxt`, `@genclass/astro`, `@genclass/sv` or `@genclass/playwright` wait for
  those releases: none of the four is on npm (checked 2026-11-03).
- **Contributor setups**: apps that already commit agent configuration (`.mcp.json`, `opencode.json`,
  `.cursor/mcp.json`, an `AGENTS.md` MCP section) get GenClass's server entry the same way.
- **Upstream evidence**: open race-condition issues in data-fetching and state libraries where a measured timeline
  from explore and replay settles the thread, as [hunts/rtk-5139.md](hunts/rtk-5139.md) prepares for Redux Toolkit.

## 2. Rules for every session

1. **Prepare, never send.** Do not open, comment on, react to, star, fork, push to or edit anything on any repository,
   site, forum, chat or tracker other than this repository (`genclass-dev/GenClass`). No `npm publish`, no release,
   no tag. The contribution is handed back as files and a pull request here (section 5); a person sends it.
2. **Claims discipline.** Any number in any text is one you measured in this session (say how, with the commands)
   or one in [../runtime/RESULTS.md](../runtime/RESULTS.md) or a hunt report. Never "detects all races", "zero false
   positives" or a rate beyond what was measured. GenClass's role in an upstream text is one sentence, at the end,
   never a pitch; what the maintainers get is a bug, a fix and a test they can run without GenClass.
3. **Disclosure.** Every draft that a person will send carries an "AI assistance" paragraph in the project's wording
   if it has one, otherwise this one: "I used Claude (Claude Code) to investigate this, write the fix and the tests,
   and draft this description; I reviewed the change and ran the tests and the manual check myself. The race was
   found with GenClass, a tool I work on, which replays the same steps with the server's responses delivered in
   different orders." The sender must be able to make every sentence true before sending; say in the report what
   they must do themselves (reproduce by hand, run the tests, read the diff).
4. **The target's rules come first.** Read its `CONTRIBUTING.md`, `.github/` templates, code of conduct, DCO or CLA
   requirement and any AI or LLM policy before writing a line. A project that bans AI-assisted contributions gets no
   pull request draft: write the report, mark the status "not worth sending" with the policy quoted, and stop. A
   project that wants an issue before a pull request gets both drafts, in that order. Use its issue and pull request
   templates verbatim, its commit style, its test framework, its formatter.
5. **This repository's rules** ([../../AGENTS.md](../../AGENTS.md)) hold: never change `packages/runtime/src`,
   `packages/mcp/src`, any test, any model-visible text or any file outside `docs/adoption/` unless your target brief
   says so (an ecosystem target may add one small package where the brief names the folder, with tests, never
   published). Never add a dependency to a workspace package. Fix GenClass problems you hit by writing them down
   (section 5, "Problems with GenClass itself"), not by patching GenClass.
6. **Local only.** Run the target on this machine with seeded local accounts. Never drive a public or hosted
   instance (no `demo.example.com`, no `try.*`), never sign up anywhere, never use a real credential.
7. **Nothing large in git.** Clone the target outside this checkout (`~/targets/<slug>`). Commit no `node_modules`,
   builds, clones, databases, screenshots over 200 KB or raw result files over 200 KB: summarise results into a small
   JSON or a table in the report and keep the harness that regenerates them.
8. **Negative results are results.** No race found, an app that will not run here, a list closed to GenClass: still
   open the pull request with the report, the status and what was tried ([hunts/ghost.md](hunts/ghost.md) is the
   model for "no race found"). Guesswork is not: every claim in the report names the command, file or URL behind it.
9. **Time.** One session. If the target is not running after about two hours of setup, stop setting up and report
   "blocked" with the exact failure. A hunt that has a confirmed race keeps going until the fix, the test and the
   drafts are done; one with none stops after the planned scenarios and writes the negative report.
10. **Determinism and honesty in numbers.** Report "found in N of M reordered runs" with M, the latencies, the seeds and
    the baselines; report every scenario, the negatives included; report the run without GenClass next to the run with
    it.

## 3. The environment and the common setup

The cloud container (as the 2026-10-24 hunts found it): Ubuntu 24.04, 4 vCPUs, 15 GB RAM, root, Node 22, outbound
network, Chromium preinstalled for Playwright (`npx playwright install` is not allowed and not needed), a Docker client
but no daemon (no `docker compose`; run services natively: `apt-get install postgresql` or `mysql-server` or `redis`,
then start them with `service ... start`), Go, Python 3 and `pip` available, `dotnet` and `bun` installable.

Build GenClass once, from this checkout:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime     # packages/runtime/dist: genclass.global.js (script tag), agent.js, index.js
npm run build -w @genclass/mcp         # packages/mcp/dist: index.js exports serve(), cli.js is the server
```

Read before writing a harness (each header says what it does and how to run it):

- [hunts/gitea-explore.mjs](hunts/gitea-explore.mjs): injection from outside with a Playwright route that rewrites
  each HTML page to load `packages/runtime/dist/genclass.global.js` from a virtual same-origin path, model off,
  telemetry off, the agent link (`dist/agent.js`) connected to an MCP bridge started in-process with `serve()` from
  `packages/mcp/dist/index.js`; the local-network-access permission each browser context needs; `rt.atom()` mirrors
  of page regions for apps without a discoverable store; one explore session per latency (2 baselines plus 6 seeded
  loads at 300, 600 and 900 ms).
- [hunts/vendure-hunt.mjs](hunts/vendure-hunt.mjs): a duplicate-submit hunt with raw CDP input events, three
  independent counts (wire, database, GenClass witnesses) and the control run without GenClass (`GENCLASS=0`).
- [hunts/umami/throttle.mjs](hunts/umami/throttle.mjs): a reproduction without GenClass through Chromium's network
  throttling.
- [../../packages/mcp/test/e2e/race.e2e.mjs](../../packages/mcp/test/e2e/race.e2e.mjs): the whole loop on one page:
  explore, replay (reproduced), the generated regression test (fails), the fix, replay (not reproduced), the test
  (passes), explore (no race).
- [../runtime/AGENT.md](../runtime/AGENT.md): the agent link, the bridge, explore's verdict (section 5.1), replays,
  the generated tests, what is measured (section 7) and the limits (section 8).

`npx @genclass/runtime@beta init --agent` is in the unreleased `0.3.0-beta.6`; use the built `dist/` from this
checkout, never an npm install of the runtime, for anything measured.

## 4. Procedures by contribution type

### 4.1 `hunt`: a race hunt on an open-source web app

1. **Run the app natively** as its own developer docs say (the brief has the commands). Seed what the surfaces need
   (an admin, a few hundred rows for lists and search). Record versions and the commit.
2. **Attach GenClass from outside** (the Gitea harness pattern): the target's source stays unmodified for the hunt.
   Where the app's state is not discovered (Vue, Svelte, Angular, plain DOM), mirror the regions under test with
   `rt.atom()` from a `MutationObserver`; say in the report which state the verdict compared.
3. **Scenarios.** The brief's surfaces, usually: search-as-you-type (type a prefix, then the full word), autosave or
   blur-save (edit two fields in a row), list filters and pagination (switch twice fast), create and update with a
   double-click, optimistic updates under a refetch or poll, anything the brief's existing issues name. For each: 2
   request-order baselines plus 6 seeded reordered loads, at 300, 600 and 900 ms, the same steps each load, and an
   oracle of your own next to GenClass's verdict (read the DOM or the API after `whenSettled()`).
4. **Reproduce without GenClass** every RACE line that is a real difference in the app's data or display: plain
   Playwright with a delayed route or Chromium throttling, N of N runs. A RACE line that is a timing-dependent request
   count, a relative time, a store present in one run and not another, or a witness on your own mirror atom is not a
   bug: classify it as the Ghost report does (section 6 there).
5. **Fix** the cause in the project's style (keep only the latest response, abort the superseded request, a request
   counter, disable the control while in flight, an idempotency key), smallest diff, no reformatting. **Regression
   test** in the project's own framework (its Playwright, Cypress, Vitest or Jest suite, in its folder, with its
   helpers), failing on the unfixed code and passing on the fixed, run three times each way. Run the project's
   related suite and its lint. Then explore again on the fixed build (expect 0 of N) and the plain reproduction
   (expect 0 of N).
6. **Write** `hunts/<slug>.md` with the sections of [hunts/strapi.md](hunts/strapi.md): setup (versions, commit,
   exact commands), how the app was driven, scenarios and verdicts (a table, negatives included), the finding with
   its evidence in causal order (quoted from `genclass_explain` or the recorded timeline), root cause (file and
   lines), the fix, test results, the fixed variant, problems with GenClass itself, time spent, reproducing. Then
   `hunts/<slug>.patch` (`git format-patch` or `git diff` against the named upstream commit, fix and test together),
   `hunts/<slug>-issue.md` (the issue in the project's template, then the pull request description in its template,
   each with the disclosure paragraph, and a "before sending" checklist for the sender: search the tracker for
   duplicates since the hunt date, reproduce by hand, run the test, read the diff), and `hunts/<slug>/` with the
   harness and small summaries. Add the row to [hunts/README.md](hunts/README.md).

### 4.2 `hunt-refresh`: a drafted hunt brought up to date and made ready to send

For Strapi, Payload, Gitea, Mealie, Umami, Vikunja, Vendure and the Redux Toolkit comment. The drafts in `hunts/` are
from 2026-10-24 and 2026-10-25. Today: run the target at its current main, apply the patch (rebase it if it no longer
applies), run the regression test on the unfixed and the fixed code, re-run the hunt's reproduction without GenClass,
check the upstream tracker and pull requests for anything filed on the same bug since the hunt (the search API, with
the words the draft's "before sending" notes name), read the project's current contribution and AI policy, complete
every item of the draft's own "before filing" or "before sending" list that a session can do, and rewrite the drafts
where facts changed (versions, line numbers, the issue's related links). Add a dated "Refresh" section at the end of
the report with what changed, what was re-measured and the status. Status "ready to send" means the sender has
nothing left but the by-hand items the draft names.

### 4.3 `ecosystem`, `framework`, `listing`, `contributor-setup`: a pull request to another repository, prepared here

1. Read the target repository's contribution rules and the format of three recent accepted entries or changes of the
   same kind. Clone it to `~/targets/<slug>` at its default branch and record the commit.
2. Make the change there exactly as it would be submitted (the entry, the file, the manifest, the example app), run
   whatever check the repository runs on such changes (its validator, build, lint, link check, generated README).
3. Hand back `contributions/<slug>/upstream.patch` (against the recorded commit) or, for a new package or extension
   that lives in its own repository, `contributions/<slug>/repo/` (the complete repository contents, with a README,
   licence and tests, validated with the tool the ecosystem uses), plus `contributions/<slug>/PR.md` (title and body
   in the target's template, disclosure paragraph included), `ISSUE.md` where the target wants an issue first, and
   `contributions/<slug>/README.md`: the report (what the entry does, every rule checked with its URL, the check you
   ran and its output, what the sender must do by hand such as a logo upload or a form, risks).
4. For an entry that needs a published artifact GenClass does not have (a release, a badge, a score, a package on
   npm), stop at the report, mark "needs owner decision", and say exactly what is missing.

### 4.4 `upstream-evidence`: a comment with a reproduction on an open issue

Build a standalone reproduction that imports nothing from GenClass (the pattern in [hunts/rtk-5139/](hunts/rtk-5139/)),
record the timeline with the agent link in a harness, state what the maintainers asked for and answer exactly that,
and draft the comment in `contributions/<slug>/COMMENT.md` (short, the reproduction's URL in this repository, the
timeline, the two test cases, the disclosure line). The report in `README.md` says why the comment helps the thread
and when it should not be posted (a maintainer already answered, the issue closed).

## 5. What to hand back

- **Branch** `adopt/<slug>` from this repository's `main`, one or more commits whose messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (or the model's own line), pushed to this repository.
- **Pull request** against `main`, title `adopt(<slug>): <status>: <one line>` where status is one of
  `ready to send`, `needs owner decision`, `not worth sending`, `blocked`. The body starts with the status line and
  gives: what was found or prepared (three sentences), the exact files, the "to send" steps for a person (fork, push,
  open, which account, which text, what to say when asked), the measured numbers with their M and latencies, the
  problems hit with GenClass itself, and the time spent. If `gh pr create` is not available in the session, push the
  branch and put the title and body in `contributions/<slug>/PR-to-genclass.md` (or `hunts/<slug>-pr-to-genclass.md`)
  and in the session's final message.
- **Problems with GenClass itself**: every false RACE line and why, every tool error, every missing feature, every
  place the docs were wrong, in the report's own section. This is product feedback the launcher triages; file no
  issue for it.

## 6. Roster

Filled by the launching session once the targets are verified (the workflow's verdicts). One row per session.

<!-- roster:start -->
<!-- roster:end -->

## 7. The review and shipping loop (the launching session, with the owner)

1. A session's pull request arrives. Read the report; run the harness or the test where it is cheap; check the
   claims discipline, the disclosure paragraph and the target's policy; merge the pull request into `main` when it
   holds (the report is the record even when nothing is sent), or send it back with questions.
2. "Ready to send" contributions go out from the owner's or the user's personal GitHub account only after the owner
   says so, in batches of a few a day (never dozens in one hour: GitHub's spam heuristics and maintainers' patience
   both count), each followed personally: the sender reproduces by hand first, answers questions, and never argues
   with a maintainer who declines. The sent URL and the date are added to the report.
3. "Needs owner decision" items (a licence, a logo, a form, a release that must happen first) are listed to the owner
   in one message with the decision each needs.
4. "Not worth sending" and "blocked" reports are merged as records; their GenClass problems feed the runtime's and
   the MCP server's backlog.
