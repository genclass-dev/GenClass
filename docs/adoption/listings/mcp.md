# Listing `@genclass/mcp`: every directory, ready to send

Submission steps, required fields and a draft entry in each list's own format. Checked against each directory's own
pages on 2026-10-24 (section 2 on 2026-11-07); each section names its source. Of the directories below, sent so far
(checked 2026-11-07): the official MCP Registry (0.2.0 to 0.2.2, by the release workflow), the Anthropic directory
(section 3, submitted 2026-10-28), and pull requests to awesome-mcp-servers
([#18644](https://github.com/punkpeye/awesome-mcp-servers/pull/18644), open, waiting for the Glama listing) and
awesome-playwright ([#278](https://github.com/mxschmitt/awesome-playwright/pull/278), open). Six lists not covered here
also got a pull request for the server or the skill between 2026-11-03 and 2026-11-05: TensorBlock/awesome-mcp-servers
([#5290](https://github.com/TensorBlock/awesome-mcp-servers/pull/5290), merged), MobinX/awesome-mcp-list
([#1108](https://github.com/MobinX/awesome-mcp-list/pull/1108), closed without a merge), and four still open:
yzfly/Awesome-MCP-ZH ([#951](https://github.com/yzfly/Awesome-MCP-ZH/pull/951)), karanb192/awesome-claude-skills
([#650](https://github.com/karanb192/awesome-claude-skills/pull/650)), Jenqyang/Awesome-AI-Agents
([#728](https://github.com/Jenqyang/Awesome-AI-Agents/pull/728)) and ai-for-developers/awesome-ai-coding-tools
([#1211](https://github.com/ai-for-developers/awesome-ai-coding-tools/pull/1211)).

## What is true today (keep every entry to this)

- **Released.** `@genclass/mcp` 0.2.2 is on npm (`latest`) and in the official MCP Registry as
  `io.github.genclass-dev/genclass` (`active`, `isLatest`), both checked 2026-11-07;
  `.github/workflows/release-mcp.yml` publishes each version from its `mcp-v*` tag (AGENTS.md rule 9). The page
  side, the agent link (`@genclass/runtime/agent`), is in `@genclass/runtime` 0.3.0-beta.1 and later, on npm's `beta`
  dist-tag (0.3.0-beta.5); npm's `latest`, 0.2.3, does not have it, so runtime install lines name
  `@genclass/runtime@beta`.
- **Measured on one page.** In headless Chromium (`packages/mcp/test/e2e/race.e2e.mjs`, docs/runtime/AGENT.md
  section 7): a search page whose results are written by each response, on an in-order backend that answers in
  40 ms. `genclass_explore` (2 baselines, 6 reordered runs, `slow_ms: 600`) found the race in **5 of 6** reordered
  runs; on the fixed page **0 of 6** reordered runs differed (no false report). The replay reproduced the bug on the
  buggy page and not on the fixed one; the generated Playwright test failed on the buggy page and passed on the fixed
  one. One page and one bug class: a proof of the mechanism, not a recall figure. Do not write "detects all races",
  "zero false positives" or any rate beyond this.
- **What it needs.** Node 20 or later, a web app on a local dev server, and two lines in the app's development build
  (`connectAgent` from `@genclass/runtime/agent`). Any MCP client over stdio. No API key, no account.
- **What it sends.** By default nothing leaves the machine: the bridge listens on 127.0.0.1 only. Three things are
  opt-in: the dashboard read (`genclass_analytics {source: "production"}` with `GENCLASS_DASHBOARD`), the dashboard
  mirror (`GENCLASS_REPORT`) and `genclass_scan` with `hosted: true` (the URL goes to the genclass.dev page check).
  `genclass_scan` also downloads the pinned runtime from npm when the project does not have it.
- **Repository.** Public URL: https://github.com/genclass-dev/GenClass (`daybot-solutions-inc/GenClass-lib` and
  `genclass-dev/GenClass-lib` are old names that GitHub redirects; submit the `genclass-dev/GenClass` one everywhere).
  Server: `packages/mcp`. Claude Code plugin: `packages/mcp/plugin`.
  Registry name: `io.github.genclass-dev/genclass`. The plugin at a repository root, with its marketplace files:
  https://github.com/genclass-dev/genclass-plugin (assembled from `packages/mcp/plugin` by
  `packages/mcp/scripts/plugin-repo.mjs`, re-synced daily by its own workflow, never edited by hand). Submit that
  one to plugin and skill directories, and GenClass to MCP server directories.

### Texts to reuse

- Up to 100 characters (MCP Registry, `server.json`):
  `Find race conditions in your web app by reordering its responses, replay one, prove the fix.`
- One sentence: `A local MCP server that shows a coding agent what happened inside a web app's pages in causal order, re-runs a page with network responses delivered in different orders to find race conditions, replays one exact order to prove a fix, and writes a Playwright regression test.`
- Three example prompts (the Anthropic directory asks for at least three that work):
  1. "The search results sometimes show an older query. Find out why and prove the fix." (`genclass_findings`,
     `genclass_explain`, `genclass_replay` before and after the fix)
  2. "I changed the autosave code. Check it for races before we call it done." (`genclass_explore` start, run the
     scenario once per armed page load, `genclass_explore` report)
  3. "Is GenClass connected to my dev server? If not, set it up." (`genclass_status`, `genclass_setup`)

### Assets the owner supplies

- **Logo.** `packages/mcp/plugin/.claude-plugin/icon.png` (the genclass.dev mark, 512 by 512, also at the root of
  genclass-plugin) is what the Anthropic directory reads the first time the plugin is saved in the portal. Cline
  wants a 400x400 PNG; Cursor a logo committed to the repository.
- **Contact email** for the forms that ask (Anthropic, mcpservers.org). PRIVACY.md names mehar@daybot.ca.
- **GitHub topics.** `gemini-cli-extension` (Gemini gallery), `agent-skills` (`gh skill`), `claude-code-plugin`,
  `claude-plugin` and `codex-plugin` are set on genclass-plugin; GenClass carries `gemini-cli-extension`,
  `claude-code-plugin` and `mcp-server`. Gemini CLI and `gh skill` read the latest GitHub release before the default
  branch, and GenClass's latest release (v0.2.1, 2026-10-11) predates the plugin, so only genclass-plugin installs
  through them.

## Order

1. Official MCP Registry (automatic, by the release workflow), then the GitHub MCP Registry onboarding request.
2. Anthropic directory (plugin), Glama (claim), Cline, mcpservers.org, mcp.so, cursor.directory, Cursor Marketplace,
   Gemini gallery topic, Smithery (bundle).
3. Lists that review by hand once a listing exists: awesome-mcp-servers (needs the Glama score), awesome-claude-code
   (a person, through the web form), ccplugins, awesome-playwright.

---

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

Source: modelcontextprotocol/registry `docs/modelcontextprotocol-io/` (quickstart, authentication, github-actions);
issue modelcontextprotocol/registry#1468.

- **How.** No form or pull request: `mcp-publisher publish` with `packages/mcp/server.json`. The `registry` job of
  `release-mcp.yml` does it after the npm publish: pinned `mcp-publisher` v1.8.1 (sha256 checked), `mcp-publisher
  validate`, `mcp-publisher login github-oidc`, `mcp-publisher publish`, then it reads the entry back. For the first
  version, which the owner publishes to npm by hand, the tag's run stops at npm; run the workflow by hand on the same
  tag (Actions, Release MCP, Run workflow, "Use workflow from: Tags: mcp-v0.1.0") and it runs the registry job alone.
- **Requirements.** The npm version exists first; `package.json` `mcpName` equals `server.json` `name`
  (`io.github.genclass-dev/genclass`); `description` at most 100 characters (`packages/mcp/test/schemas.test.ts`
  checks it against the 2025-12-11 schema, and `mcp-publisher validate` against the live registry accepted this file
  on 2026-10-24 and refused the old 210-character one with 422).
- **Organization namespace.** OIDC grants `io.github.<repository owner>/*`, so the tag must be pushed to
  `genclass-dev/GenClass` (the job checks this first). `mcp-publisher login github` (device flow) cannot publish
  to an organization namespace (#1468, open); the fallback is `mcp-publisher login github --token <PAT>` with a
  classic PAT with `read:org` or a fine-grained one with Organization Members read-only, by an organization Owner.
- **Draft.** `packages/mcp/server.json` as committed.

## 2. GitHub MCP Registry (github.com/mcp) and the VS Code MCP gallery

Source: github/github-mcp-server [discussion 1257](https://github.com/github/github-mcp-server/discussions/1257)
(checked 2026-11-07: GitHub's answer of 2026-05-19 says onboarding a new server is manual curation and that later
versions sync from the official registry; the notes at the top of the thread, October 2026, list what a request
holds); github.blog "How to find, install, and manage MCP servers with the GitHub MCP Registry" (2025-10-24);
docs.github.com "Extend Copilot Chat with MCP" (VS Code adds servers from the GitHub MCP Registry).

- **How.** A comment in discussion 1257 asking for onboarding, once the official registry lists the server as
  `active` and `isLatest` (true on 2026-11-07). That thread is where requests are posted now; it is marked closed and
  still takes comments. The blog post's route, an email to partnerships@github.com with the same facts, is the older
  one. Read the values from the registry before posting, as the thread asks. On 2026-11-07 GitHub's catalog did not
  list GenClass (`curl "https://api.mcp.github.com/v0.1/servers?search=genclass"` returned no server), and no request
  had been posted.
- **Draft comment.**

  > **Onboarding request: GenClass (`io.github.genclass-dev/genclass`)**
  >
  > - Registry name: [`io.github.genclass-dev/genclass`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.genclass-dev/genclass)
  > - Version: npm `@genclass/mcp@0.2.2`, `active` and `isLatest: true` in the registry
  > - Transport: stdio (`npx -y @genclass/mcp@0.2.2`)
  > - Repository: https://github.com/genclass-dev/GenClass (the server is in `packages/mcp`)
  > - License: Apache-2.0
  > - What it does: a local server for coding agents. It shows the agent what happened inside a web app's pages on
  >   the developer's machine in causal order, re-runs a page with network responses delivered in different orders to
  >   find race conditions, replays one exact order to prove a fix, and writes a Playwright regression test. It needs
  >   no account or API key and sends nothing off the machine unless the user turns that on.
  > - Verification: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.genclass-dev/genclass"`

## 3. Anthropic directory (claude.ai/directory/manage)

Source: claude.com/docs/directory/publish, claude.com/docs/plugins/submit, claude.com/docs/plugins/pre-submission-checklist,
support.claude.com "Anthropic Software Directory Policy".

- **Route.** A Claude Code plugin bundle. The directory no longer accepts local MCP servers as desktop extensions
  (MCPB) and takes remote servers only as connectors, so the plugin is the route for this local server.
- **Who.** A Pro, Max, Team or Enterprise plan (Team or Enterprise: an Owner, or a member with the Directory
  permission), with GitHub connected on claude.ai and push access to the repository. The first organization to
  submit a repository folder holds that listing.
- **Steps.** claude.ai/directory/manage, Submit new, Plugin bundle. Source: repository
  `genclass-dev/genclass-plugin`, no plugin path (the plugin is the repository root), branch `main`; Validate.
  GenClass itself cannot be submitted: the portal stops validating a repository whose GitHub archive is over
  50 MiB (pre-submission checklist), and GenClass's is 51 MiB. Listing details are read from
  `.claude-plugin/plugin.json` and `README.md` at that root (the same files as `packages/mcp/plugin/`). Data handling: by default the plugin
  collects and sends nothing; it reads and writes `.genclass/agent/` in the project and `~/.genclass/` (the bridge
  token); what goes off the machine is opt-in: the dashboard read (`GENCLASS_DASHBOARD`), the dashboard mirror
  (`GENCLASS_REPORT`) and `genclass_scan` with `hosted: true`; `genclass_scan` also downloads the runtime from npm when
  the project does not have it. Compliance: contact email and
  the four acknowledgements. Updates: GitHub push webhook.
- **What the checks will say.** Local run of `claude plugin validate --profile directory` on the assembled
  repository and on `packages/mcp/plugin` (Claude Code 2.1.311, 2026-10-28): passes with nothing to report; the
  launcher checks are the portal's alone. The portal's first validation (2026-10-28, `main` at e911b25) passed with
  one warning, "Launcher lock missing" on `mcpServers.genclass` in `.mcp.json` (a `package-lock.json` or `uv.lock`
  next to the manifest that declares the server; exact versions, registry sources and hashes are required for the
  Verified badge), and held the pinned launchers for a reviewer, "Runs a pinned npx or uvx package" (2 findings:
  `.mcp.json` and the hook ran `npx -y @genclass/mcp@0.2.2`). A lockfile at the plugin root (68507fa) turned the
  warning into the note "Launcher locked" and added a second hold, "Dependencies install from a lockfile" (the dated
  bullets below). The hold text names the way to avoid both: the package's built files inside the plugin, each under
  256 KiB, run from `${CLAUDE_PLUGIN_ROOT}`, with no `package.json` or lockfile. That is what the plugin repository
  now is: `scripts/plugin-repo.mjs` fetches the released `@genclass/mcp` at the plugin's version from npm and vendors
  its `dist/cli.js` (about 150 KB, no dependencies) as `server/cli.mjs` with the package's command next to it, and
  `.mcp.json` and the hook run `node ${CLAUDE_PLUGIN_ROOT}/server/genclass-mcp.mjs`; the lockfile is gone. The copy
  of the plugin inside GenClass keeps `npx` (nothing built is committed there), and the Agent Plugins `mcp.json`
  keeps `npx` everywhere, since that format has no plugin-root variable. An unpinned launcher would block; the
  manifests test keeps the `npx` pins equal to `package.json`'s version and checks the assembled tree. Between a
  version bump and its release the sync script exits 3 (npm does not serve the new version yet) and the plugin
  repository stays at the previous release until the first sync after the publish. The vendored version drew no hold,
  "Meets directory policy, with warnings" (the dated bullet below); "MCP server command wasn't read" has not appeared.

- **Policy items.** Privacy policy URL: `privacyPolicyUrl` in `plugin.json` (the plugin README's Privacy section).
  Support: `supportUrl` (GitHub issues). Tool annotations: every tool has `title`, `readOnlyHint`, `destructiveHint`
  and `openWorldHint`. Test account: none needed (no account exists); for a reviewer's page to test against, the
  end-to-end app is `packages/mcp/test/e2e/app`. Example prompts: the three above.
- **Submitted (2026-10-28).** From Karanvir's Max account (the browser pane's sign-in; the listing belongs to that
  account's organization), repository `genclass-dev/genclass-plugin`, `main` at e911b25, plugin page
  `claude.ai/directory/manage/plugins/20878d40-42c5-4300-a1d6-f09b9cc291eb`. The portal's validation: 7 checks
  passed, 4 warnings, 2 policy holds. The warnings: `documentationUrl`, `supportUrl` and `privacyPolicyUrl` in
  `plugin.json` ("the directory reads them, Claude Code ignores them, no action needed") and "Launcher lock missing"
  (above). Notes, not warnings: the server is local, so not on claude.ai; the agent-plugins `plugin.json` is ignored;
  the icon passed without a code check. "MCP server command wasn't read" did not appear. The holds: "Runs a pinned npx
  or uvx package", one for `.mcp.json` and one for the hook. Listed on Claude Code and Cowork; the Claude apps surface
  was unticked because the skill says the chat app cannot run the server. Data handling: no personal data, no skill
  sends data elsewhere, nothing retained, not for under-18s. Contact: mehar@daybot.ca. Auto-publish was switched on,
  but the page says it does not apply until an Anthropic reviewer has published a version. Updates: the push webhook
  ("Set up push updates" on the plugin's page gives the payload URL and a secret shown once; "Rotate secret" on its
  Settings tab replaces it) was added to the repository the same day with
  `gh api -X POST repos/genclass-dev/genclass-plugin/hooks` (content type JSON, the push event only, active);
  GitHub's ping delivery returned 200 and the page shows "Webhook connected". State: the security scan passed within
  4 minutes of submitting; since then "In review" ("Held for: Content policy review", reason "Runs a pinned npx or
  uvx package"); "Live" needs a reviewer, and the first version always does.
- **Lockfile re-validation (2026-10-28).** PR #125 (merged as d15192a) reached the plugin repository through the sync
  workflow as 68507fa (`package.json` and `package-lock.json` added, the README updated). The webhook's push delivery
  returned 200 and the page showed "last push just now", and "Check for new commits" was pressed, but the directory
  took the new version "via scheduled check" about 9 minutes after the push (the page says its own check runs about
  every 6 hours with or without a webhook). It fetched 17 files (177.7 kB); validation "Passed with warnings: 4
  notes", and "Launcher lock missing" became the note "Launcher locked"; the scan passed in 2 minutes; compared with
  e911b25, "2 new findings, 1 fixed". The version is held for a reviewer with two reasons now: "Runs a pinned npx or
  uvx package" (2 findings, as before) and the new "Dependencies install from a lockfile" on `package-lock.json`:
  "No action needed: a reviewer clears this hold. Keep a lockfile that pins an npx-launched server; to avoid the
  install entirely, bundle the dependencies into built files of under 256 KiB each and remove both package.json and
  the lockfile." So the lockfile earns the lock note, not fewer holds; only the vendored server (above) avoids both.
  The three `plugin.json` URL fields, "Uses hooks" and "Runs a local program for an MCP server" are listed as
  warnings for information only. The tracked branch cannot change while the plugin is under review.
- **Vendored server (2026-10-28).** After the second hold, the plugin repository was changed to what the hold text
  asks for (the layout above): `.mcp.json` and the hook run the released server vendored under `server/` with `node`
  from `${CLAUDE_PLUGIN_ROOT}`, and the plugin ships no `package.json` or lockfile. Locally, the assembled repository
  passes `claude plugin validate --profile directory`, the vendored server answers `--version` and an MCP
  `initialize`, and the hook exits silently without a bridge. The directory took that version, ec577ea, by its
  scheduled check about 7 minutes after the sync's push (17 files, 333.2 kB): validation passed with the same 3 notes,
  directory policy "Meets directory policy, with warnings" (no hold), the security scan passed in 3 minutes, and the
  version is "with a reviewer": "This version passed the security scan and is waiting for a reviewer before it can be
  listed. There's nothing you need to do." Compared with 68507fa: "3 new findings, 4 fixed". The warnings, each marked
  as information or as something that can stay: "Uses a credential from the user's machine" (2 findings in
  `server/cli.mjs`; the server writes and reads its own bridge token under `~/.genclass/`, and the text suggests a
  `user_config` option with `sensitive: true` instead), "Unrecognized field in plugin.json" (the three URL fields),
  "Contains a download-and-run command" in `server/cli.mjs` (the `npx` lines the server prints for other clients, and
  `genclass_scan`, which runs `npx` on the pinned `@genclass/runtime` for `scan`: "where the plugin runs this, ship the script inside
  the plugin"; where it is documentation nothing changes), "Uses hooks" and "Runs a local program for an MCP server".
  The first version still goes live only when an Anthropic reviewer publishes it; auto-publish applies after that.

## 4. punkpeye/awesome-mcp-servers

Source: punkpeye/awesome-mcp-servers `CONTRIBUTING.md`, `README.md` (legend, Developer Tools),
`.github/workflows/check-glama.yml`.

- **How.** Fork, add one line under Developer Tools in `README.md`, open a pull request. Rules: public GitHub
  repository; link text `owner/repo`; only emojis from the legend; alphabetical within the category. The bot then
  asks for a Glama listing that passes its checks and a Glama score badge after the name; the maintainer merges once
  the server is claimed on Glama and has a score. An automated agent opening the PR must add `🤖🤖🤖` to its title;
  a person does not.
- **When.** After npm and the Glama claim (section 5).
- **Draft** (heading `### 💻 <a name="developer-tools"></a>Developer Tools`; confirm the Glama path once listed):

```
- [genclass-dev/GenClass](https://github.com/genclass-dev/GenClass) [![genclass-dev/GenClass MCP server](https://glama.ai/mcp/servers/genclass-dev/GenClass/badges/score.svg)](https://glama.ai/mcp/servers/genclass-dev/GenClass) 📇 🏠 🍎 🪟 🐧 - Race conditions in web apps for coding agents: records clicks, requests, response order and state writes in the app's pages on your machine, re-runs a page with responses delivered in different orders, replays one exact order to prove a fix and writes a Playwright regression test.
```

## 5. Glama (glama.ai/mcp/servers)

Source: glama.ai/mcp/faq; glama.ai/blog/2025-07-08-what-is-glamajson; schema glama.ai/mcp/schemas/server.json.

- **How.** glama.ai/mcp/servers, Add Server: the GitHub repository URL, a display name and a short description.
  Glama then checks the license, scans and starts the server. For an organization's repository, ownership is claimed
  through `glama.json` at the repository root (committed: `{"maintainers": ["MeharPro"]}`, valid against Glama's
  schema in `schemas.test.ts`); add the other maintainers' GitHub usernames before claiming, then run Claim
  ownership again after any change to the file.
- **Build.** The score needs the server to start and answer introspection. Glama takes a Dockerfile in its own admin
  page, not from the repository. This one works for a stdio server from npm (paste it there):

```dockerfile
FROM node:22-alpine
ENV GENCLASS_STATE_DIR=none
ENTRYPOINT ["npx", "-y", "@genclass/mcp@0.2.2"]
```

- **Fields.** Display name `GenClass`; description: the 100-character text above. How Glama treats a server in a
  subfolder of a monorepo is not documented; give `packages/mcp` if it asks.

## 6. Cline MCP Marketplace (cline/mcp-marketplace)

Source: cline/mcp-marketplace `README.md` and `.github/ISSUE_TEMPLATE/mcp-server-submission.yml`.

- **How.** New issue with the "MCP Server Submission" template:
  https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml (title `[Server Submission]: `).
- **Fields.** GitHub Repository URL (required); Logo Image, a 400x400 PNG (required); two required checkboxes: Cline
  set the server up from the README and/or `llms-install.md` alone, and the server is stable and ready for public
  use (check both only after trying it with the published package); Additional Information (the README's "Reason for
  Addition" goes here). `llms-install.md` is at the repository root.
- **Draft.**

  > GitHub Repository URL: https://github.com/genclass-dev/GenClass
  >
  > Additional Information: The server is in `packages/mcp` (npm `@genclass/mcp`); install steps for agents are in
  > `llms-install.md` at the repository root. Reason for addition: it gives Cline a way to find and prove timing bugs
  > in a web app (stale responses that overwrite newer data, double submits, errors that happen "sometimes"): it
  > records what happened inside the app's pages on the developer's machine in causal order, re-runs a page with
  > network responses delivered in different orders, replays one exact order to confirm a bug and its fix, and
  > writes a Playwright regression test. Runs on your machine: no API key, nothing sent off it unless you turn that on. Measured so far on one
  > page: the race was found in 5 of 6 reordered runs, with no false report on the fixed page.

## 7. mcpservers.org

Source: the form at https://mcpservers.org/submit.

- **Fields.** Server Name `GenClass`; Category `Development`; Short Description: the one-sentence text above;
  Repository, Website or Documentation: `https://github.com/genclass-dev/GenClass/tree/main/packages/mcp`;
  Official MCP Registry Name: `io.github.genclass-dev/genclass`; "supports remote connections": leave unchecked
  (stdio only); Contact Email; plan Free (review within two weeks) unless the owner prefers the paid one.

## 8. mcp.so

Source: https://mcp.so/submit; chatmcp/mcpso issue 1 "Submit Your MCP Servers here".

- **How.** The form, type MCP Server: Repository URL `https://github.com/genclass-dev/GenClass`, Name `GenClass`.
  The form shows a paid option ($39, published without review); the free review option was not visible without
  signing in. Or a comment on issue chatmcp/mcpso#1.
- **Draft comment.**

  > GenClass: https://github.com/genclass-dev/GenClass (server in `packages/mcp`). A local MCP server that shows a
  > coding agent what happened inside a web app's pages in causal order, finds race conditions by re-running a page
  > with responses delivered in different orders, replays one exact order to prove a fix, and writes a Playwright
  > regression test. Install: `npx -y @genclass/mcp@0.2.2`. Category: developer tools.

## 9. cursor.directory

Source: the site's source README (cursor/community-plugins); the site itself answered 429 to automated reads, so the
form was not read.

- **How.** cursor.directory/plugins/new, sign in with GitHub or Google, paste the repository URL, Submit. It detects
  components in the Open Plugins (Agent Plugins) layout: `packages/mcp/plugin/plugin.json` and `mcp.json` (Agent
  Plugins 1.0.0, valid against its schemas in `schemas.test.ts`), `skills/genclass/SKILL.md`, and the Claude Code
  `.mcp.json` and `hooks/hooks.json`. If it does not find a plugin in a subfolder from the repository URL, paste
  `https://github.com/genclass-dev/GenClass/tree/main/packages/mcp/plugin`. Each submission gets an automated
  security scan.

## 10. Cursor Marketplace (cursor.com/marketplace/publish)

Source: cursor.com/docs/reference/plugins ("Submitting a plugin").

- **How.** Submit the repository link at cursor.com/marketplace/publish; Cursor reviews each plugin and each update.
  `.cursor-plugin/marketplace.json` at the repository root points to `packages/mcp/plugin`, where the Agent Plugins
  `plugin.json` and `mcp.json` are (server and skill; Cursor's own hook events differ, so the Claude Code hook is not
  part of it). Its checklist also wants a committed logo and a README that documents usage
  (`packages/mcp/plugin/README.md`).

## 11. Gemini CLI extensions gallery (geminicli.com/extensions)

Source: google-gemini/gemini-cli `docs/extensions/releasing.md` and `docs/extensions/reference.md`.

- **How.** No submission: a daily crawler lists public repositories with the GitHub topic `gemini-cli-extension`
  whose root holds `gemini-extension.json`. `genclass-dev/GenClass` and genclass-plugin both carry the topic (checked
  2026-11-07). The committed `gemini-extension.json` starts `npx -y @genclass/mcp@0.2.2` (kept equal to the package
  version by `manifests.test.ts`).
- **Install line for the entry.** `gemini extensions install https://github.com/genclass-dev/GenClass`. This
  clones the whole repository, which is large; `gemini mcp add genclass npx -- -y @genclass/mcp@0.2.2` adds the server
  alone.

## 12. Smithery (smithery.ai)

Source: smithery.ai/docs/build/publish ("Local (MCPB Bundle)"), smithery.ai/docs/concepts/cli.

- **How.** Local stdio servers are listed from an MCP Bundle. The release workflow builds it
  (`npm run bundle -w @genclass/mcp`, `mcp-bundle` artifact: `genclass-<version>.mcpb` and its sha256; the bundle
  was built, validated with `mcpb validate` and its unpacked server answered an MCP initialize). The owner publishes
  it: `npm install -g smithery@latest`, `smithery auth login`,
  `smithery mcp publish genclass-<version>.mcpb -n genclass/genclass` (the qualified name is the owner's choice), then
  completes the publishing flow on the site.

## 13. hesreallyhim/awesome-claude-code

Source: hesreallyhim/awesome-claude-code `CONTRIBUTING.md` and `.github/ISSUE_TEMPLATE/recommend-resource.yml`.

- **Rules.** Only through the web issue form "Recommend a Resource", by a person (not an agent, not the `gh` CLI, not a
  pull request); one resource at a time; the resource must have 14 days of active development since the first
  commit on its default branch, or 100 stars. Description: 1 to 3 sentences, 10 to 500 characters, descriptive, not
  promotional, does not address the reader, no emojis.
- **Draft.**
  - Display Name: `GenClass`
  - Category: `Testing`
  - Link: `https://github.com/genclass-dev/GenClass/tree/main/packages/mcp`
  - Author Name: `GenClass`; Author Link: `https://github.com/genclass-dev`
  - Description: `A plugin with an MCP server, a prompt hook and a skill that show Claude Code what happened inside a web app's pages in causal order, re-run a page with network responses delivered in different orders to find race conditions, and replay one exact order to confirm a fix. It also writes a Playwright regression test from a finding; so far measured on one page, where the race showed in 5 of 6 reordered runs and the fixed page showed none.`
  - Checklist: the five required boxes are for the person who submits to check after doing what they say; leave the
    last box unchecked.

## 14. ccplugins/awesome-claude-code-plugins

Source: ccplugins/awesome-claude-code-plugins `README.md` (no CONTRIBUTING file).

- **How.** A pull request adding one line under `### MCP Servers` in `README.md` (roughly alphabetical). Optionally
  an entry in its `.claude-plugin/marketplace.json`; for a plugin in a subfolder Claude Code's marketplace format
  takes `{"source": "git-subdir", "url": "genclass-dev/GenClass", "path": "packages/mcp/plugin"}`.
- **Draft.**

```
- [GenClass](https://github.com/genclass-dev/GenClass/tree/main/packages/mcp/plugin) - See the race, replay it, prove the fix: an MCP server, a prompt hook and a skill that show Claude what happened inside a web app's pages in causal order, re-run a page with responses in different orders to find races, and write a Playwright regression test. Install: `/plugin marketplace add genclass-dev/GenClass` then `/plugin install genclass@genclass`
```

  (The list's own entries separate name and text with a long dash; this draft uses a hyphen, per this repository's
  writing rules. Swap it if the maintainer asks.)

## 15. mxschmitt/awesome-playwright

Source: mxschmitt/awesome-playwright `README.md` (section "AI & Agents", alphabetical) and `CONTRIBUTING.md`.

- **How.** A pull request adding one line under `## AI & Agents`, between "Cutaway" and "Playwright Agent CLI".
- **Draft.**

```
- [GenClass MCP](https://github.com/genclass-dev/GenClass/tree/main/packages/mcp) - MCP server that lets coding agents find race conditions in a web app by re-running a page with responses delivered in different orders, replay one exact order, and generate a Playwright test that fails while the bug is there.
```

  `@genclass/playwright` (the race-file reporter) would go under `## Reporters` in the same format once it is
  released.

## Skill and plugin directories (2026-10-28)

The skill is `skills/genclass/SKILL.md`, at the root of both repositories; the plugin is the root of genclass-plugin.
Verified on this machine on 2026-10-28 from the pushed repository: `claude plugin marketplace add`, `codex plugin
marketplace add` and `codex plugin add genclass@genclass`, `gemini extensions install`, `gh skill install` (gh 2.103)
and `npx skills add` all install from `genclass-dev/genclass-plugin`.

- **skills.sh** (Vercel's directory, what `npx skills add` reads): automatic, ranked by anonymous install counts; the
  skill is listed at https://www.skills.sh/genclass-dev/genclass-lib/genclass (installs of the monorepo copy), and the
  install lines now name genclass-plugin, which gets its own page the same way. Nothing to submit.
- **Smithery skills** (smithery.ai/skills): mirrors the skills CLI's index; nothing to submit.
- **Gemini CLI gallery** (geminicli.com/extensions): a daily crawl of repositories with the topic
  `gemini-cli-extension` and a root `gemini-extension.json`; genclass-plugin has both. Nothing to submit.
- **Codex**: OpenAI's public plugin directory takes local servers only from approved partners
  (developers.openai.com/plugins/deploy/desktop-only), so the path is `codex plugin marketplace add
  genclass-dev/genclass-plugin` (Codex reads `.agents/plugins/marketplace.json`, and the Claude one as a fallback) and,
  by hand, one README line in hashgraph-online/awesome-codex-plugins.
- **Claude**: the directory (section 3 above); the owner submits from the paid claude.ai account with GitHub
  connected. Also claude-plugins.dev indexes public plugin repositories by topic.
- **Cursor**: cursor.com/marketplace/publish (manual review of an open-source repository) and
  cursor.directory/plugins/new (sign in, paste the repository URL; it detects `skills/`, `.mcp.json` and
  `hooks/hooks.json` at the root). Both by hand.
- **GitHub Copilot**: `gh skill install genclass-dev/genclass-plugin genclass` works today; the community registry is
  github/awesome-copilot (a pull request adding the skill folder). By hand.
- **Tessl registry** (`tessl skill publish --public`, after approval) and VoltAgent/awesome-agent-skills ("real
  community usage" required): later, once installs exist.
