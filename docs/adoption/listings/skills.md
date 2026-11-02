# Listing the `genclass` skill: every skill directory, ready to send

Where a SKILL.md-based skill (the Agent Skills format, agentskills.io) gets listed, what each place reads, and what
is left to do for `skills/genclass/SKILL.md`. Checked on 2026-11-02; each section names its source. Nothing here has
been submitted. This file takes over the skill items of the last section of `mcp.md` ("Skill and plugin
directories", 2026-10-28); the plugin and MCP-server directories stay there.

Not readable from the session that wrote this (facts from those sites come from search excerpts, the tool's own
repository or the 2026-10-28 notes in `mcp.md`, and are marked "not verified"): skills.sh, vercel.com, agentskills.io,
docs.github.com, cli.github.com, github.blog, the `gh` manual mirrors, cursor.com, smithery.ai, developers.openai.com,
docs.tessl.io, claude-plugins.dev, skillsmp.com, agenticskills.io, awesomeskill.ai.

## What is true today (keep every entry to this)

- **The skill.** `skills/genclass/SKILL.md` at the root of `genclass-dev/GenClass` (the repository was renamed from
  `GenClass-lib` on 2026-11-02; the old name still resolves, see below) and at the root of `genclass-dev/genclass-plugin`,
  byte-identical to `packages/mcp/plugin/skills/genclass/SKILL.md` (`packages/mcp/test/manifests.test.ts` keeps it so
  and `npm run sync -w @genclass/mcp` refreshes it). 80 lines; frontmatter `name: genclass`, `license: Apache-2.0`,
  `description` of 509 characters; no scripts, references or assets. It is the procedure; the triggers are its
  description and the server's instructions (`docs/runtime/AGENT.md` section 4.2).
- **It is valid.** Against the Agent Skills specification (agentskills/agentskills `docs/specification.mdx`): `name` at
  most 64 characters, lowercase letters, digits and hyphens, equal to the directory name; `description` non-empty, at
  most 1,024 characters; `license`, `compatibility` (at most 500 characters), `metadata` (string map) and
  `allowed-tools` (experimental) optional; body under 500 lines. `claude plugin validate` (Claude Code 2.1.316) passes
  on `packages/mcp/plugin` ("These checks found nothing to report") and on `skills/`. The spec's own validator,
  `skills-ref validate`, could not be installed in the session (the install was refused), so run it once by hand.
- **What it needs to be useful.** The GenClass MCP server (`@genclass/mcp`, npm) on the developer's machine and a page of
  their dev server connected through `@genclass/runtime/agent`. Installed alone, the skill's last section tells the
  agent how to add the server; it does nothing by itself. Every entry says "with the GenClass MCP server".
- **Install lines, run on 2026-11-02** with the skills CLI 1.7.4 (npm `skills`, Vercel Labs, published 2026-10-19),
  telemetry off, `--list` only: `npx skills add genclass-dev/genclass-plugin`, `npx skills add genclass-dev/GenClass` and
  the old `npx skills add genclass-dev/GenClass-lib` each clone the repository and find exactly one skill, `genclass`,
  with the description above. The GenClass clone is the whole 109 MB repository, so the install lines keep naming
  `genclass-plugin`. `gh skill install genclass-dev/genclass-plugin genclass` was verified on 2026-10-28 with gh 2.103
  (`mcp.md`); the session's gh is 2.89, which has no `skill` command, so it was not re-run.
- **Releases and stars.** `GenClass`'s latest GitHub release is v0.2.1 (2026-10-11), before the skill existed, and
  `genclass-plugin` has no release; the tools that read the latest release before the default branch (`gh skill`,
  Gemini CLI, per `mcp.md`) therefore work from `genclass-plugin` only. Stars: `GenClass` 7, `genclass-plugin` 0. Lists
  with a star or usage threshold (sections 7.2 and 7.3) are closed to it for now.
- **Measured claims.** Only what `mcp.md` states: one page, the race found in 5 of 6 reordered runs, 0 of 6 differing
  on the fixed page. No rate beyond that in any entry.
- **GitHub topics.** `genclass-plugin`: `agent-skills`, `claude-code-plugin`, `claude-plugin`, `codex-plugin`,
  `gemini-cli-extension`, `mcp`, `mcp-server`, `debugging`, `frontend`, `playwright`, `race-condition`. `GenClass` carries
  `claude-code-plugin`, `gemini-cli-extension` and `mcp-server` but not `agent-skills` (41,066 public repositories carry
  that topic). Adding it is a repository setting, done by hand.

### Texts to reuse

- Ten words or fewer (section 7.2): `Find and prove fixes for timing bugs in web apps.`
- One sentence: `A skill for coding agents with the GenClass MCP server: record what happens inside a web app's pages in causal order, re-run a page with responses delivered in different orders to find race conditions, replay one exact order, and prove the fix with a generated Playwright test.`
- The skill's own description (509 characters) is what the skills CLI, skills.sh and Claude Code show; reuse it where a
  form asks for the description and allows it.

## Order

1. Nothing to submit: skills.sh lists installs by itself (section 1); the plugin bundle already submitted to Anthropic's
   directory is the only route there (section 3); Codex and Gemini CLI read the plugin repository (sections 4, 5). In
   this repository: the skills.sh badge, the `--path` install line for Gemini CLI, and the `agent-skills` topic on
   `GenClass` (by hand).
2. cursor.directory (web form, detects `skills/*/SKILL.md`; section 6), then github/awesome-copilot (a pull request that
   copies the skill into that repository under MIT; section 2.2, needs the owner's decision on the licence).
3. Later, once installs and stars exist: VoltAgent/awesome-agent-skills, travisvn/awesome-claude-skills,
   ComposioHQ/awesome-claude-skills (section 7). The crawlers in section 8 need nothing and were not reachable.

---

## 1. skills.sh (Vercel Labs) and the `skills` CLI

Source: npm `skills` 1.7.4 (`README.md`, `docs/creating-skills.md`, `docs/commands.md`, `docs/agents.md`,
`docs/troubleshooting.md`, and `dist/cli.mjs` for the telemetry); the runs above. skills.sh/about: not verified
(search excerpts only).

- **What it is.** The CLI installs skills from any public git repository into the skill folders of 79 agents (Claude
  Code `.claude/skills/`, Codex, Cursor, Copilot, Gemini CLI, OpenCode, Antigravity and others `.agents/skills/`,
  Windsurf `.windsurf/skills/`; `-g` for the user scope, `-a` to pick agents, `--skill` to pick skills, `--copy` instead
  of symlinks, `-y`, `--list`). skills.sh is the directory built from its telemetry.
- **How `npx skills add genclass-dev/GenClass` works.** It clones the repository (GitHub shorthand, URL, GitLab, Azure,
  any git URL, a local path, or a direct `SKILL.md` or archive URL), then looks for `SKILL.md` in the root, `skills/`
  (and its `.curated/`, `.experimental/`, `.system/`), `.agents/skills/`, `.claude/skills/`, `.windsurf/skills/` and
  about 50 other agent folders, each walked three levels deep (a shallower `SKILL.md` shadows deeper ones;
  `--full-depth` searches outside them), plus skills declared in `.claude-plugin/marketplace.json` or `plugin.json`
  (`skills.sh.json` at the root can add folders; nothing found means a recursive search). Then it asks which skills and
  agents (non-interactive inside an agent), links one canonical copy into each agent's folder, records the source for
  `update`, `check` and `remove`, and sends one install event.
- **The listing is the telemetry.** After an install from a GitHub repository that GitHub confirms is public, the CLI
  requests `https://www.skills.sh/tele/t` with `event=install`, `source` (owner/repo), `skills`, `agents`, `global`, the
  skill file URLs, the CLI version, `ci=1` in CI and the detected agent; `find` sends the query; `DISABLE_TELEMETRY=1` or
  `DO_NOT_TRACK=1` turns it off ("anonymous usage data", "No personal information"). Before an install it asks
  `https://www.skills.sh/tele/audit` for the partner security audits of those skills. Not verified (About page
  excerpts): the site "indexes public skills shipped through the open skills CLI and ranks them by anonymous install
  telemetry", each page shows the source repository, install count, the agents it is most used on and the audit
  results, one skill under several repository names is merged at query time, inflated counts are hidden. No
  submission, form or claim step was found.
- **Status.** Listed since the owner's installs on 2026-10-28 at `skills.sh/genclass-dev/genclass-lib/genclass`
  (`mcp.md`); `genclass-plugin` and the renamed `genclass-dev/genclass` get pages the same way (whether the site merges
  the three: not verified). Nothing to do; `metadata.internal` must stay absent (it hides a skill from the CLI).
- **In this repository.** The badge the CLI's own README uses, for `packages/mcp/README.md` and the plugin README:
  `[![skills.sh](https://skills.sh/b/genclass-dev/genclass-plugin)](https://skills.sh/genclass-dev/genclass-plugin)`
  (format from vercel-labs/skills; whether the badge renders for this repository is not verified).

## 2. GitHub CLI `gh skill` and GitHub Copilot

### 2.1 `gh skill`

Source: `mcp.md` (install verified 2026-10-28); npm `skills` `docs/agents.md` for Copilot's folders. The GitHub
changelog ("Manage agent skills with GitHub CLI", 2026-04-16), docs.github.com and the `gh skill` manual pages were not
reachable: the command details below are from search excerpts of those pages and are not verified.

- **What it is.** In GitHub CLI 2.90.0 and later, a public preview: `gh skill search`, `preview`, `install`, `update`,
  `publish` (`list` in later builds). `install OWNER/REPO [SKILL]` installs from a repository; `@tag` or `@sha` and
  `--pin` fix a version; the default agent is Copilot and the default scope the project; `--agent claude-code`,
  `cursor`, `codex`, `gemini-cli`, `antigravity` or `--dir` choose where; hidden folders such as `.claude/skills/` need
  `--allow-hidden-dirs`. The latest release is read before the default branch (`mcp.md`), hence `genclass-plugin`.
  Where Copilot reads project skills (`.github/skills/` per third-party pages) is not verified.
- **No directory to submit to.** `gh skill search` searches GitHub; what it indexes (SKILL.md files, the `agent-skills`
  topic, an index of its own) is not verified. `gh skill publish` validates a skill against the specification and
  publishes it as a tag or release in its own repository (`--fix` for metadata); it is not a registry and is not used
  here: `genclass-plugin` is assembled by `packages/mcp/scripts/plugin-repo.mjs`, re-synced daily and never edited or
  tagged by hand (AGENTS.md), and the skill already carries the `license` field `publish` recommends (packages/mcp/CHANGELOG.md, Unreleased).
- **By hand.** Add the `agent-skills` topic to `genclass-dev/GenClass` (repository settings). Nothing else.

### 2.2 github/awesome-copilot (community collection)

Source: github/awesome-copilot `README.md`, `CONTRIBUTING.md`, `docs/README.skills.md` (2026-11-02).

- **How.** A pull request that copies the skill into their repository: `npm run skill:create -- --name genclass
  --description "..."` makes `skills/genclass/SKILL.md`, paste the body, `npm run skill:validate`, then `npm run build`
  (the README tables are generated; CI fails if they are stale). Branch from and target `main`, not `staged`. Each PR
  gets a state label and a risk tier from the `submission-gate` check; bundled scripts or MCP configuration are "High"
  risk (this skill has neither; it names tools of a server the user installs). Reviewers are assigned by hand. An
  agent opening the PR adds `🤖🤖🤖` to the title; a person does not. Rejected: skills that "mainly restate what
  frontier models already do well"; paid services follow their separate guidance.
- **Licence.** "By contributing to this repository, you agree that your contributions will be licensed under the MIT
  License." The copy there would be MIT while ours is Apache-2.0: the owner decides; keep `license: Apache-2.0` out of
  the copied frontmatter if they agree, or do not submit.
- **The entry.** Generated from the frontmatter: name `genclass`, the description, "Bundled Assets: None", and the
  install line `gh skill install github/awesome-copilot genclass`. The PR description: the one-sentence text above, that
  it needs the GenClass MCP server (`npx -y @genclass/mcp@0.2.1`) and a dev server on the same machine, and the measured
  result.

## 3. Anthropic's directory and Claude Code marketplaces

Source: claude.com/docs/directory/publish, code.claude.com/docs/en/plugins/publish, code.claude.com/docs/en/skills,
code.claude.com/docs/en/plugins/create-marketplace (2026-11-02).

- **Skills are not a listing.** "Skills aren't a submission type on their own. Put them in a bundle." A listing is a
  plugin bundle (a GitHub repository, public before it goes live, paid claude.ai plan) or an MCP connector (a remote
  server). The plugin bundle `genclass-dev/genclass-plugin`, submitted 2026-10-28 and waiting for a reviewer (`mcp.md`
  section 3), carries this skill; once published, its Usage tab reports "how often each skill and MCP server runs".
  `claude-plugins-official` takes no submissions through the portal. Nothing to do.
- **Claude Code.** Reads `.claude/skills/<name>/SKILL.md` (project, personal, nested, `--add-dir`), a plugin's
  `skills/<name>/`, managed settings and skills synced from claude.ai, not `.agents/skills/` (so the skills CLI links
  into `.claude/skills/` for it). All frontmatter is optional there; the listing shows `description` plus `when_to_use`
  cut at 1,536 characters; `license`, `compatibility` and `metadata` are accepted and ignored; claude.ai uploads and the
  Skills API reject any key beyond the six spec fields, so the file's three keys are right. Both `GenClass` (root
  marketplace, `source: ./packages/mcp/plugin`) and `genclass-plugin` are marketplaces; `/plugin install genclass
  --marketplace genclass-dev/genclass-plugin` does both steps (Claude Code 2.1.275 or later).
- **claude-plugins.dev** (indexes public plugin repositories by topic, `mcp.md`): not reachable, not verified.

## 4. Codex

Source: github.com/openai/skills and github.com/openai/plugins READMEs (2026-11-02); developers.openai.com not reachable.

- openai/skills, the catalog (`skills/.system`, `.curated`, `.experimental`, `$skill-installer`), "is deprecated" and
  points to the plugins guide; openai/plugins is "a curated collection of Codex plugin examples" (`.codex-plugin/plugin.json`,
  `skills/`, `.mcp.json`, `.agents/plugins/marketplace.json`) with no text on submissions; OpenAI's directory takes
  local servers from approved partners only (`mcp.md`, not re-verified). The route stays `codex plugin marketplace add
  genclass-dev/genclass-plugin` then `codex plugin add genclass@genclass` (verified 2026-10-28), or the skills CLI. Nothing to submit.

## 5. Gemini CLI

Source: google-gemini/gemini-cli `docs/cli/skills.md` (2026-11-02).

- Skills are discovered in `~/.gemini/skills/` or `~/.agents/skills/` (user) and `.gemini/skills/` or `.agents/skills/`
  (workspace), plus "skills bundled within installed extensions"; `gemini skills install <git-url-or-local-dir>
  --consent`, with `--path` for "a subdirectory of a Git repo containing the skill" and `--scope user|workspace`. No
  skills gallery: geminicli.com/extensions crawls the `gemini-cli-extension` topic (`mcp.md`), and `genclass-plugin`
  is an extension with the skill inside.
- **In this repository**, one more install line for the READMEs (from the doc page; no Gemini CLI in the session, not
  run): `gemini skills install https://github.com/genclass-dev/genclass-plugin.git --path skills/genclass --consent`.

## 6. Cursor

Source: cursor/community-plugins `README.md` (the source of cursor.directory, 2026-11-02); `mcp.md` section 10 for the
Cursor Marketplace. Cursor's own skills documentation (cursor.com, docs.cursor.com) was not reachable.

- **cursor.directory.** "All content is submitted through the website - no pull requests needed for data":
  cursor.directory/plugins/new, sign in with GitHub or Google, paste the repository URL, Submit. It detects, under the
  Open Plugins standard, `skills/*/SKILL.md`, `.mcp.json`, `hooks/hooks.json`, `rules/*.mdc`, `agents/*.md`,
  `.lsp.json`; every submission is reviewed by a Cursor SDK agent (`composer-2`) and stored as safe, suspicious or
  malicious. Submit `https://github.com/genclass-dev/genclass-plugin` (the skill, `.mcp.json` and the hook are at its
  root). Whether a skill without a plugin manifest is listed is not documented. By hand.
- **Cursor Marketplace** (cursor.com/marketplace/publish, manual review): as in `mcp.md` section 10. By hand.

## 7. Curated lists (pull requests by a person)

### 7.1 VoltAgent/awesome-agent-skills

Source: its `CONTRIBUTING.md` (2026-11-02). Links only; "Skill must have real community usage"; "Brand new skills that
were just created are not accepted"; description "10 words or fewer"; "Author/org prefix included in the name"; PR
title `Add skill: author/skill-name`; at the end of Community Skills, Development and Testing. Later. Draft line:

```
- **[genclass-dev/genclass](https://github.com/genclass-dev/genclass-plugin/tree/main/skills/genclass)** - Find and prove fixes for timing bugs in web apps.
```

### 7.2 travisvn/awesome-claude-skills

Source: its `CONTRIBUTING.md` (2026-11-02). One row, `- **[Name](link)** - description`; "if your skill hasn't acquired
a basic 10 stars, it will be closed automatically"; a skill "based around a SaaS" is closed; no PR "generated or
submitted with AI assistance"; more than one file is "a strong guideline". Later, by a person, from `GenClass` (7 stars).

### 7.3 ComposioHQ/awesome-claude-skills

Source: its `CONTRIBUTING.md` (2026-11-02). Copies the skill folder into their repository on their template ("When to
Use This Skill", "How to Use", "Example"), one README line in alphabetical order, PR title `Add genclass skill`, an
"Inspired by" or "Credit" line, tested on Claude.ai, Claude Code and/or the API; no licence stated. Later, as 2.2.

### 7.4 Not routes

anthropics/skills has no contribution statement (its README highlights partner skills Anthropic chooses);
hesreallyhim/awesome-claude-code takes the plugin (`mcp.md` section 13); block/agent-skills was archived on 2026-09-25.

## 8. Crawlers and aggregators (nothing to do, not verified)

Sites that index public GitHub repositories with a `SKILL.md` or mirror the skills CLI's index, none reachable from the
session: SkillsMP (search results say it crawls GitHub, some with a 2-star floor), Smithery skills ("mirrors the skills
CLI's index", `mcp.md`), agenticskills.io (a submit form, a "verified org" badge), awesomeskill.ai, skills-hub.ai
(badges with install counts), skillselion.com, vibeindex.ai, skills.cat, Tessl (`tessl skill publish --public` after
approval, `mcp.md`). Check in a month whether they list `genclass-dev/genclass-plugin`; submit nothing.

## 9. The skill file against each place

| field or file | spec | the file | needed anywhere? |
|---|---|---|---|
| `name` | required, at most 64, lowercase, equals the folder | `genclass` | everywhere; done |
| `description` | required, at most 1,024 | 509 characters, the triggers first | everywhere; done (Claude Code shows up to 1,536) |
| `license` | optional, short | `Apache-2.0` | no directory requires it; `gh skill publish` recommends it; it travels with the copies in 2.2 and 7.3 |
| `compatibility` | optional, at most 500 | absent | nowhere. Optional, in this repository: `Needs the GenClass MCP server (npm @genclass/mcp) and the app's dev server on the same machine; Node 20 or later.` Claude Code ignores it; `manifests.test.ts` checks the frontmatter, so run it after |
| `metadata` | optional string map | absent | nowhere; `metadata.internal: true` would hide it from the skills CLI |
| `allowed-tools` | experimental | absent | nowhere; leave out |
| Claude-only keys (`argument-hint`, `paths`, ...) | not in the spec | none | keep none: claude.ai and the Skills API reject them |
| `scripts/`, `references/`, `assets/` | optional | none | none required; travisvn prefers more than one file |
| layout `skills/genclass/SKILL.md` at the root | | both repositories | the skills CLI, `gh skill`, cursor.directory, Claude Code and Codex plugins, Gemini `--path`: all read it |
| a `LICENSE` next to `SKILL.md` | not required | the repository's `LICENSE` | none asks |
| `skills.sh.json` | optional | absent | not needed: `skills/` is a default folder |
| README badge and install lines | | `npx skills add`, `gh skill install` present | add the skills.sh badge (1) and the Gemini line (5) in this repository |
| GitHub topic `agent-skills` | | `genclass-plugin` yes, `GenClass` no | add on `GenClass`, by hand |
