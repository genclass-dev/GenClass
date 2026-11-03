# Pull request to TheJambo/awesome-testing (draft, not sent)

Target: https://github.com/TheJambo/awesome-testing, default branch `master`, prepared against
`f308113c66f3e32b2dd31d4ed0069d6a4fc9e983` (2026-11-03, "Add bareenv to test automation frameworks (#361)").
The change is `upstream-awesome-testing.patch` in this folder: one line added to `README.md`. The list has no pull
request template; title and body follow the owner's merged pull requests (#357, #356, #352, #353).

Before sending, replace `[N]` below with the count from the command in README.md ("Before sending", step 3). If
you cannot get a fresh count, delete that clause rather than reuse an old figure.

## Title

```text
Add GenClass to UI & End-to-End Testing
```

## Body

```markdown
Adds [GenClass](https://github.com/genclass-dev/GenClass) to UI & End-to-End Testing, inserted alphabetically between flutter-skill and Hyperbrowser.

GenClass is an open-source (Apache-2.0) browser library that reports race conditions in a running web app: a stale response written over newer data, a duplicate submit, a failure storm. A small model runs on the user's device. It comes with a local MCP server for coding agents. The server re-runs a page with the server's responses delivered in different orders to find races. It can then replay one order to show the bug before a fix and its absence after. Nothing in the list covers race conditions or response ordering today. Everything is free and runs locally, with no account needed.

The runtime has been on npm since 2026-10-08 (`@genclass/runtime`, [N] downloads in the month to 2026-11-01), and the MCP server is published as `@genclass/mcp`.

Disclosure: I am the author. The entry text was drafted with help from Claude Code; I reviewed it.
```

## The line it adds

```markdown
- [GenClass](https://github.com/genclass-dev/GenClass) - Open-source browser library that reports race conditions in a web app while they happen (stale responses written over newer data, duplicate submits, failure storms) with a small on-device model. Its local MCP server re-runs a page with responses delivered in different orders to find races and replays one order to prove a fix.
```

## If asked

- **"Is there a free tier?"** The runtime and the MCP server are Apache-2.0 and free. Neither needs an account. The
  optional hosted dashboard and the Enterprise service are separate. Point to `LICENSE` and `packages/mcp/README.md`.
- **"Isn't this covered by X?"** Name the capability no entry has: it reorders the server's responses and replays one
  order. Do not argue. If the owner still declines, thank them and close.
- **"It's very new."** Give the npm facts above. Do not add rates or detection claims.
- **The red "Dead link checker" check.** The brief's verifier found it already failing on `master`, and the owner
  merges anyway. The new GitHub link passed when the same checker ran here (README.md, "The list's check"). Do not
  fix other entries' links in this pull request.
