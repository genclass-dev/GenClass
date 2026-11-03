# adopt(testing-list): GenClass in TheJambo/awesome-testing

**Status: ready to send.** One line in the list's `### UI & End-to-End Testing` section, by pull request, prepared
2026-11-03. Nothing has been posted, forked or opened on the target.

| | |
|---|---|
| List | [TheJambo/awesome-testing](https://github.com/TheJambo/awesome-testing), CC0, default branch `master` |
| Recorded commit | `f308113c66f3e32b2dd31d4ed0069d6a4fc9e983` (2026-11-03 05:43 +0800, "Add bareenv to test automation frameworks (#361)") |
| Change | [`upstream-awesome-testing.patch`](upstream-awesome-testing.patch): adds one line to `README.md` (`git apply --check` passes on the recorded commit) |
| Pull request text | [`PR-awesome-testing.md`](PR-awesome-testing.md): title, body and answers to likely questions |
| Brief | `docs/adoption/swarm-targets/testing-list.md` on branch `adopt/briefs` (type `listing`, `docs/adoption/swarm.md` section 4.3) |

## 1. The entry

Section `### UI & End-to-End Testing` (heading at README.md line 107 of the recorded commit). The new line goes at
line 124, after `flutter-skill` (line 123) and before `Hyperbrowser` (was line 124). That puts it in alphabetical
order, ignoring case. The section is only loosely sorted (for example `Hercules` follows `Hyperbrowser`, and
`agent-qa` and `assay` are at the end). The owner's merged pull request #353 still says "Inserted alphabetically", so
we follow that.

The new line:

```markdown
- [GenClass](https://github.com/genclass-dev/GenClass) - Open-source browser library that reports race conditions in a web app while they happen (stale responses written over newer data, duplicate submits, failure storms) with a small on-device model. Its local MCP server re-runs a page with responses delivered in different orders to find races and replays one order to prove a fix.
```

An existing line in the same section, quoted from README.md line 128 of the recorded commit, for the format:

```markdown
- [mendwright](https://github.com/saadbuilt/mendwright) - Self-healing selectors for Playwright and Selenium in Python. Repairs a broken selector from a saved fingerprint of the element, asks a model only when that isn't enough, checks the repair on the live page and can write it back into your code.
```

The new line matches that format: `- [Name](url) - Description.`, two sentences that end with a period, no badges, no
version numbers and no install command. It is 384 characters long. For comparison, mendwright's line is 301,
qmax-mcp's (line 135) is 379, and VibeView's (line 139) is 417, the longest in the section. All counts are for the
whole Markdown line, measured with Python `len()` on the recorded README.

Where each part of the description comes from:

- "Open-source browser library that reports race conditions in a web app while they happen (stale responses ...,
  duplicate ..., failure storms)": the first paragraph of this repository's `README.md`.
- "with a small on-device model": the same paragraph ("A small model runs on the user's device, in a Web Worker").
- "Its local MCP server re-runs a page with responses delivered in different orders to find races and replays one
  order to prove a fix": `packages/mcp/README.md` (`genclass_explore` and `genclass_replay`).

The description contains no numbers and no detection rates.

**PR title**, following the merged pull requests #357, #356 and #352: `Add GenClass to UI & End-to-End Testing`.

## 2. The list's rules, checked

| Rule | Source | GenClass |
|---|---|---|
| Contributions are public domain under CC0 | [CONTRIBUTING.md](https://github.com/TheJambo/awesome-testing/blob/master/CONTRIBUTING.md) | The sender agrees to this by opening the pull request. The entry text is the only contribution. |
| Search previous suggestions first | same | The brief's verifier found 0 hits for "genclass" in the list's issues and pull requests on 2026-11-03. The recorded README has 0 matches for `genclass` or `race condition` (`grep -ci`). The sender re-searches (see "Before sending"). |
| One pull request per suggestion | same | One line, one pull request. As the brief advises, no second "GenClass scan" entry goes under Visual Testing. |
| Short, simple, descriptive; end with a period | same | Two sentences, both ending with a period. |
| Spelling and grammar | same | Checked by hand. |
| No trailing whitespace | same | `git diff --check` is clean. |
| How to open the PR | [Sindre Sorhus' guide](https://github.com/sindresorhus/awesome/blob/master/contributing.md#adding-something-to-an-awesome-list), linked from CONTRIBUTING.md | Edit README.md (in the browser or a fork), say why in the body, open the pull request. |
| Templates, CLA/DCO, AI policy | `.github/` holds only `workflows/404-links.yml` (recorded commit). [CODE-OF-CONDUCT.md](https://github.com/TheJambo/awesome-testing/blob/master/CODE-OF-CONDUCT.md) is the Contributor Covenant. | There is no PR or issue template, no CLA or DCO, and no AI policy. The disclosure follows #352, which was merged: "The entry text was drafted with help from Claude Code." |
| Unwritten bar: an existing entry already covers it; no permanent free tier; brand-new with no traction | The owner's comments when closing PRs, per the brief (#362, #347, #346, #210, #332; #358; #351, #331, #337) | No entry covers race conditions or response ordering. Runtime and MCP server are Apache-2.0, free and need no account. GenClass is a tool, not a training repo or site, and is older than the 0- to 2-star tools merged this week, per the brief (bareenv #361, mendwright #357, Bite #352, ghostwire #353). |

**Does GenClass qualify today?** Yes. It meets every written rule, and it is inside what the owner merged this week.
No star count, badge or score is required. The one soft risk is the owner's "brand-new" bar. The PR body answers it
with npm facts only.

## 3. The list's check, run here

The list runs one check on pull requests: `.github/workflows/404-links.yml`, "Dead link checker",
`restqa/404-links@2.2.0`. Its config `.404-links.yml` waits 500 ms between github.com requests. The action is a
Docker image whose entry point is `node 404-links.js`. With no Docker daemon here, I ran that same script with
Node 22, from the action's source at tag `2.2.0`, in the same folder layout:

```bash
git clone --depth 1 --branch 2.2.0 https://github.com/restqa/404-links ~/targets/tools/404-links
(cd ~/targets/tools/404-links && npm ci --omit=dev)
# a folder holding the changed README.md, CONTRIBUTING.md, CODE-OF-CONDUCT.md and .404-links.yml
cd ~/targets/linkcheck/after && node ~/targets/tools/404-links/404-links.js
```

**The new link only** (a folder with the section heading, the new line and `.404-links.yml`), exit code 0:

```text
> ✅ - [200] - https://github.com/genclass-dev/GenClass
=====================================================
> All the links are reachable 🥳
```

**The whole list, before and after the change** (exit code 1 both times):

<!-- linkcheck:full -->

In this container, only github.com and raw.githubusercontent.com hosts resolve. Every other host failed with
`ENOTFOUND`, plus one 403. So the full-list error count measures this sandbox, not the list. The useful comparison
is that the change adds one link, and that link passes. The brief's verifier found the action already failing on
`master` on GitHub. A red check is expected and is not caused by this entry.

The link itself: `git ls-remote https://github.com/genclass-dev/GenClass HEAD` returned `c1c9e14…`, this
repository's `main` on 2026-11-03. Also, `https://github.com/daybot-solutions-inc/GenClass-lib` redirects to
`https://github.com/genclass-dev/GenClass`.

## 4. Facts for the PR body, and where each comes from

| Fact | How checked (2026-11-03, this session) |
|---|---|
| `@genclass/runtime` first published 2026-10-08 | `npm view @genclass/runtime time.created` → `2026-10-08T00:14:10.429Z` |
| dist-tags `latest` 0.2.3 and `beta` 0.3.0-beta.5 | `npm view @genclass/runtime dist-tags` |
| `@genclass/mcp` 0.2.1 published (first version 2026-10-25) | `npm view @genclass/mcp version time.created` → `0.2.1`, `2026-10-25T00:30:17.856Z` |
| Apache-2.0 | `LICENSE`; `"license"` in `packages/runtime/package.json` and `packages/mcp/package.json` |
| Monthly downloads | **Not measured here.** The session proxy refused `api.npmjs.org` (CONNECT 403). The brief's verifier reports 2,896 for the month to 2026-11-01. Because of the claims rule, the PR draft has `[N]` for the sender to fill (see "Before sending"). |

The brief also suggested "128 real apps measured". I left it out of the PR body. That number counts the apps used for
training data (`docs/runtime/RESULTS.md` section 6, "Real-browser v2 gold (128 apps …)"). It is not adoption, and
on an adoption question it would read as adoption.

## 5. To send (a person, from a personal GitHub account, after the owner's go-ahead)

Before sending:

1. Check that `master` has not moved in a way that matters. If it has, put the line back between `flutter-skill` and
   `Hyperbrowser`, wherever those lines now are:
   ```bash
   git clone https://github.com/TheJambo/awesome-testing && cd awesome-testing && git log -1 --format=%H && grep -n 'flutter-skill\|Hyperbrowser\|GenClass' README.md
   ```
2. Search the list's issues and pull requests for `genclass`, `race`, and `MCP server` entries added since
   2026-11-03 (https://github.com/TheJambo/awesome-testing/pulls?q=genclass). If an entry for response reordering
   has appeared, do not send.
3. Get the downloads figure. Put it in place of `[N]` in the body, or delete that clause:
   ```bash
   curl -s https://api.npmjs.org/downloads/point/2026-10-02:2026-11-01/@genclass/runtime
   ```
4. Open https://github.com/genclass-dev/GenClass while signed out, and check that the repository is public and its
   README describes what the entry says.

Then:

1. Fork TheJambo/awesome-testing (or use "Edit this file" on README.md in the browser, which forks for you).
2. Apply the change: `git apply upstream-awesome-testing.patch`, or paste the line from section 1 after the
   `flutter-skill` line.
3. Commit `Add GenClass to UI & End-to-End Testing`. Push, and open the pull request against `master` with the title
   and body from [`PR-awesome-testing.md`](PR-awesome-testing.md).
4. Expect a "Scheduled PR reviewer" bot comment and a hold for the owner, because the PR discloses self-promotion
   for a new repository. Expect the "Dead link checker" to be red, as it is on master. In the sampled pull
   requests, the owner decided within 1 to 29 hours. Answer questions as `PR-awesome-testing.md` suggests. If the
   owner declines, thank them and close. Do not argue.
5. Add the pull request's URL and the date to this report.

## 6. Risks

- **The owner's "brand-new, no traction" bar** (#351, #337, #331). Those were a training repo and sites. Tools as
  new as GenClass, or newer, were merged this week. The PR body gives npm facts only.
- **The "already covered" close.** UI & E2E already has MCP entries (ContextQA MCP, flutter-skill, qmax-mcp,
  vibe-testing). None of them reorders responses or finds races, and the description leads with that difference.
- **Telemetry.** `@genclass/runtime` sends diagnostics by default. This is disclosed and can be turned off
  (`TELEMETRY.md`). The entry does not mention it. If a reviewer asks, point to `TELEMETRY.md` and the opt-outs.
- **The repository name.** The entry links `genclass-dev/GenClass`. This repository's own README badges and
  `docs/adoption/listings/mcp.md` still use `genclass-dev/GenClass-lib`, which GitHub redirects. If the repository
  is renamed again, the entry keeps working through GitHub's redirect. If the owner wants a different URL in the
  list, the line should change before sending.

## 7. Problems with GenClass itself

No GenClass code was run for a listing. Documentation found along the way:

- `README.md` (badges, the compatibility link) and `docs/adoption/listings/mcp.md` ("Public URL:
  https://github.com/genclass-dev/GenClass-lib") name the old repository URL. The brief and `docs/adoption/swarm.md`
  name `genclass-dev/GenClass`, which is where the mirror now redirects. Listings need one canonical URL.
- The download figure, the strongest adoption fact for listings, cannot be read from inside a swarm session
  (`api.npmjs.org` is blocked by the session proxy). Every listing session will need the sender to fill it in.
  It would help to record the figure once, with its date, somewhere the sessions can cite.

## 8. Time

About 45 minutes: reading the brief and rules, locating and checking the entry, the link checker runs (the full-list
run takes about 15 minutes because of the 500 ms GitHub delay), and these files.
