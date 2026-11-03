# framework-lists: GenClass in awesome-nextjs, awesome-svelte, awesome-solid-js (and awesome-react, later)

Adoption swarm session, 2026-11-03, slug `framework-lists`, type listing ([../../swarm.md](../../swarm.md) section
4.3). Nothing was sent: no fork, pull request, comment or star on any of the four repositories.

| list | status | section | pull request text | patch |
|---|---|---|---|---|
| [unicodeveloper/awesome-nextjs](https://github.com/unicodeveloper/awesome-nextjs) | **ready to send** | `## Extensions`, last line | [PR-awesome-nextjs.md](PR-awesome-nextjs.md) | [upstream-awesome-nextjs.patch](upstream-awesome-nextjs.patch) |
| [TheComputerM/awesome-svelte](https://github.com/TheComputerM/awesome-svelte) | **ready to send** | `## Dev Tools`, after Frontman | [PR-awesome-svelte.md](PR-awesome-svelte.md) | [upstream-awesome-svelte.patch](upstream-awesome-svelte.patch) |
| [one-aalam/awesome-solid-js](https://github.com/one-aalam/awesome-solid-js) | **ready to send** | `## 🛠️ Tooling`, last line | [PR-awesome-solid-js.md](PR-awesome-solid-js.md) | [upstream-awesome-solid-js.patch](upstream-awesome-solid-js.patch) |
| [enaqx/awesome-react](https://github.com/enaqx/awesome-react) | **needs owner decision** (recommend "later") | `#### React Development Tools`, last line | [PR-awesome-react.md](PR-awesome-react.md) | [upstream-awesome-react.patch](upstream-awesome-react.patch) |

## 1. The entries

Every line uses only facts stated in the repository README (lines 11-16 and 40-41): it reports race conditions while
they happen; a small model runs on the user's device; by default (`observe`) it never holds, delays or changes a
request, a response or a state write; one import per app. No rates, no version pin, no "detects all". The link is
`https://github.com/genclass-dev/GenClass`, the repository's current name (commit `b740e43`: "the repository's
rename to `genclass-dev/GenClass` (the old name, `GenClass-lib`, redirects)"; the GitHub search API returned
`genclass-dev/GenClass stars=7 created=2026-10-07 private=false` on 2026-11-03). The earlier drafts in
[../../listings/vue-and-angular.md](../../listings/vue-and-angular.md) still link the old name; it redirects.

### awesome-nextjs (`master` at `483a40d51d2e8b4daac81fb517ca29abf7ca33df`, 2026-11-02)

Existing line it follows (README.md line 183):

```
- [@farming-labs/docs](https://github.com/farming-labs/docs) - A modern documentation framework that works. One config file, zero boilerplate.
```

Entry (new line 184):

```
- [GenClass](https://github.com/genclass-dev/GenClass) - Race-condition reporter for Next.js apps: one client-side import, a small on-device model, and an observe mode that never holds or changes a request.
```

"Client-side import" is `instrumentation-client.ts` (README line 40-41; the Next.js 16 App Router row of
[compat/RESULTS.md](../../../../compat/RESULTS.md)). PR title `Add GenClass to Extensions`; commit body carries the
repository link.

### awesome-svelte (`main` at `8a61443bf7d815998df11ca16f8cdeb0d4d7fd81`, 2026-11-03)

Existing line it follows (README.md line 382, the section's only entry):

```
- [Frontman](https://github.com/frontman-ai/frontman) - Open-source AI coding agent that lives in your browser with click-to-edit and hot reload for Svelte apps.
```

Entry (new line 383, before `### Adapters`):

```
- [GenClass](https://github.com/genclass-dev/GenClass) - Reports race conditions in a SvelteKit app while they happen (stale responses, duplicate submits) from one import in hooks.client, with a small on-device model.
```

Changed from the brief's draft, which said "(stale responses written over newer data, duplicate submits)": Svelte
stores are not discovered automatically (README line 56: "Vue / Pinia, Svelte stores, signals, MobX, Jotai and
Recoil are not discovered: register such state with `rt.atom` / `rt.guard`"), so the line does not claim the
state-level part; the PR body names `rt.atom`. `hooks.client` is the SvelteKit row of compat/RESULTS.md
(`src/hooks.client.ts`). Commit message `Add GenClass`; PR title `Add GenClass to Dev Tools` (the shape of #182,
Frontman's).

### awesome-solid-js (`main` at `48140bdc0e2d194f0251bfc375681605f93c9d2f`, 2026-07-30)

Existing line it follows (README.md line 170):

```
- [ArkEnv](https://github.com/yamcodes/arkenv) - Environment variable validation from editor to runtime, integrates with Solid and SolidStart via its Vite plugin.
```

Entry (new line 171):

```
- [GenClass](https://github.com/genclass-dev/GenClass) - Reports race conditions in a Solid app while they happen with a small on-device model; one import, and observe mode never changes a request or a state write.
```

The import goes in `src/index.tsx` (Solid row of compat/RESULTS.md). PR title `Add GenClass to Tooling` (the shape of
#78, ArkEnv's).

### awesome-react (`master` at `e6fd973eefe57d288a60e6d21bb9d8f343addfe9`, 2026-09-04): held

Existing line it follows (README.md line 124; every entry in the section is lowercase with no trailing period):

```
- [why-did-you-render](https://github.com/welldone-software/why-did-you-render) - Monkey patches React to notify you about avoidable re-renders
```

Entry (new line 125):

```
- [genclass](https://github.com/genclass-dev/GenClass) - Reports race conditions in a React app while they happen with a small on-device model; its default observe mode changes no request or state write
```

GenClass does not meet this list's bar today; what is missing is quoted in [PR-awesome-react.md](PR-awesome-react.md)
(traction, React-specificity, "do not promote your experiments").

## 2. The rules, list by list

| list | rules read | what they require | GenClass today |
|---|---|---|---|
| awesome-nextjs | [CONTRIBUTING.md](https://github.com/unicodeveloper/awesome-nextjs/blob/master/CONTRIBUTING.md) at `483a40d` | search for duplicates; one PR per suggestion; AP title case; `[Title Case Name](link) - Description.`; description starts with a capital, ends with a full stop; no trailing whitespace; a useful PR title; "The body of your commit message should contain a link to the repository"; edits on the same PR if asked | meets all; no star or age threshold written |
| awesome-svelte | [CONTRIBUTING.md](https://github.com/TheComputerM/awesome-svelte/blob/main/CONTRIBUTING.md) at `8a61443`; README line 14 "Contributions welcome" | `- [Project Name](Project URL) - A sentence ...` starting uppercase, ending with a period; commit `Add {project name}`; the most appropriate field (issue if none fits); "Describe in at least one sentence why you think the project is awesome" | meets all |
| awesome-solid-js | no CONTRIBUTING, no `.github/`; README and LICENSE (MIT) only | de facto `- [Name](URL) - Description.`; #78 (ArkEnv) merged with "Made with Cursor" in the body and a `Co-authored-by: Cursor` trailer | meets the de facto format |
| awesome-react | README "Contribution" (lines 265-267 at `e6fd973`), no CONTRIBUTING | free resources only, GitHub links preferred, "Kindly refrain from using this list as an advertisement board or a space to promote your experiments"; in practice traction and React-specificity (PR #1801, #1810, #1722, quoted in PR-awesome-react.md) | **does not meet**: 7 stars, four weeks old, framework-agnostic |

None of the four has a CLA, DCO, issue-first rule, pull request or issue template, code of conduct, CI workflow or
AI/LLM policy (checked in the clones: `ls -a` shows no `.github/` in any of them). Each PR body carries the adapted
disclosure ("I used Claude (Claude Code) to draft this entry; I reviewed it. GenClass is a tool I work on.") and each
commit a `Co-Authored-By: Claude` trailer; AI trailers were merged in awesome-nextjs (the 2026-11-02 "Add Midnight
Lite to Boilerplates" commit) and awesome-solid-js (#78).

Duplicates: `gh api -X GET search/issues -f q="genclass repo:<list> is:pull-request"` and `... is:issue` returned 0
for all four lists on 2026-11-03.

## 3. Checks run

None of the four lists runs CI, a validator or a linter on pull requests. What was run here
([check.sh](check.sh) re-runs it):

- Each patch applies with `git am` on its recorded commit, and the result's tree equals the edited clone's.
- The added line: one line, the list's format, no trailing whitespace (awesome-nextjs's README starts with a UTF-8
  BOM and uses LF; the edit keeps both).
- `awesome-lint` 2.3.0 (sindresorhus; informational, the lists do not run it) on README.md before and after:

  | list | errors before | errors after | new finding |
  |---|---|---|---|
  | awesome-nextjs | 69 | 69 | none |
  | awesome-svelte | 27 | 27 | none |
  | awesome-solid-js | 88 | 88 | none |
  | awesome-react | 163 | 164 | "List item description must end with proper punctuation" on the new line, the same finding every entry in that section has (the list's own convention is no period) |

  (Output of `WORK=<scratch> ./check.sh` on 2026-11-03. A first run in the session clones gave one error fewer on
  every list; the difference is the `awesome-github` rule, which depends on the clone's branch and remote, and is
  the same before and after.)

## 4. To send (a person, from a personal GitHub account, after the owner's go-ahead)

For each ready list, in any order, a few days apart if the owner prefers:

1. Re-check for duplicates: search the list's pull requests and issues for "genclass".
2. Fork the list on GitHub, clone the fork, branch from the default branch.
3. `git am /path/to/upstream-<list>.patch`, then `git commit --amend --reset-author --no-edit` (the patches carry a
   placeholder author, `Sender Name <sender@example.invalid>`). If the default branch moved and the patch no longer
   applies, add the entry line by hand at the position given in section 1.
4. Read the diff. Make sure every sentence of the PR body is true for you (the disclosure says you reviewed it).
5. Push, open the pull request with the title and body from `PR-<list>.md`.
6. Answer questions personally; move the line if the maintainer asks, on the same PR. Never argue with a decline.
7. Add the PR URL and the date to this README.

awesome-react: do not send until the owner decides; see [PR-awesome-react.md](PR-awesome-react.md).

## 5. Risks

- awesome-nextjs had 356 open pull requests on 2026-11-03 (search API); the entry may sit or be closed silently.
- awesome-svelte and awesome-solid-js maintainers act in batches months apart; silence is normal.
- All four lists are promotional by nature; the lines stay to the verified claims, and the "free" question has an
  answer (Apache-2.0 library, no account needed; genclass.dev's paid dashboards are not linked).
- Licences: awesome-nextjs (README, CC0) and awesome-svelte (LICENSE, CC0-1.0) put the entry text in the public
  domain; awesome-solid-js is MIT; awesome-react's badge links CC BY 4.0 (its alt text says CC0, and there is no
  LICENSE file). Nothing in the lines needs protecting.
- Some sentences of the brief itself are cut off at the source ("an AI co-author trailer wa…", "Merges are same-…");
  nothing here depends on the missing text.
- GenClass is in beta (`@genclass/runtime` npm `beta` = 0.3.0-beta.5, `latest` = 0.2.3 on 2026-11-03); no line pins
  a version, so the entries outlive the beta.
- The compatibility matrix the PR bodies link was measured with an unpublished 0.1.0-beta.4 build on 2026-10-10 (its
  own header says so); the bodies link it, they do not restate it as current.

## 6. Problems with GenClass itself

- The repository's own README badges and links, `docs/adoption/listings/vue-and-angular.md` and the published npm
  metadata of 0.3.0-beta.4 / 0.2.3 still name `genclass-dev/GenClass-lib`; the repository is `genclass-dev/GenClass`
  (the old name redirects). Not changed here (outside this brief's scope).
- `swarm.md` section 5 asks for branch `adopt/<slug>`; this session was assigned the branch
  `claude/friendly-hamilton-fhpt01` by its environment and was not allowed to push elsewhere, so the hand-back is on
  that branch.
- `git fetch origin adopt/briefs main` in the brief's first step took more than two minutes in this container (it
  finished later); the brief was read through the GitHub API meanwhile (the same blob on `adopt/briefs`).

## 7. Time spent

About one hour: reading the brief and rules, cloning, edits and patches, the checks, the drafts.
