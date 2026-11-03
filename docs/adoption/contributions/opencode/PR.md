# Pull request draft: anomalyco/opencode

Send only after `opencode-genclass` is on npm (see README.md, "Before sending"). Base branch `dev`. The diff is
[upstream.patch](upstream.patch): one row at the end of the Plugins table in
`packages/web/src/content/docs/ecosystem.mdx`. OpenCode asks for a short description in the sender's own words
(CONTRIBUTING.md, "Keep It Brief"; the template warns that a large AI-generated description may get the PR closed):
read the body below, then rewrite it in your own words before sending; keep it about this length.

## Title

```
docs: add opencode-genclass to the ecosystem plugins
```

## Body (the repository's template, `.github/pull_request_template.md`)

```markdown
### Issue for this PR

None: a documentation change (exempt from the linked-issue check in CONTRIBUTING.md).

### Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code improvement
- [x] Documentation

### What does this PR do?

Adds one row to the Plugins table on the ecosystem page for opencode-genclass. The plugin adds the GenClass MCP
server (a local server that records what happens in your web app's pages in dev and replays network responses in
different orders to find race conditions) and, before each prompt, adds the findings recorded since the previous
prompt as a text part. One default export serves both OpenCode 1.x (`server` hooks: `config`, `chat.message`) and
2.x (`setup`: `mcp.transform`, `session.hook("prompt")`), the shape the V1 migration guide describes. I work on
GenClass.

### How did you verify your code works?

`prettier --check` (3.6.2, the repo's settings) passes on the file and the table padding is unchanged. The plugin
itself I ran in opencode-ai 1.19.5 and @opencode/cli 2.2.5: the server is listed and connected through the plugin,
a project's own `genclass` entry wins, and on 1.19.5 the findings reach the model request.

### Screenshots / recordings

Not a UI change.

### Checklist

- [x] I have tested my changes locally
- [x] I have not included unrelated changes in this PR

AI assistance: I used Claude (Claude Code) to write the plugin and its tests and to draft this description; I
reviewed the change and ran the checks myself.
```

The template's optional "Visual" section (an animated SVG for the desktop app's "What's new in beta") is for
user-facing app changes; delete it, as above.
