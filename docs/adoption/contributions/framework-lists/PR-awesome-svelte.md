# Pull request to TheComputerM/awesome-svelte

Status: **ready to send**. Base: `main` at `8a61443bf7d815998df11ca16f8cdeb0d4d7fd81` (merge of #186, 2026-11-03).
Patch: [upstream-awesome-svelte.patch](upstream-awesome-svelte.patch) (one line in `README.md`, `## Dev Tools`, after
Frontman, before `### Adapters`).

Commit (CONTRIBUTING.md step 3: "Commit changes using format: `Add {project name}`"):

```
Add GenClass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Title

```
Add GenClass to Dev Tools
```

## Body

```markdown
## Add GenClass

[GenClass](https://github.com/genclass-dev/GenClass) is an open-source (Apache-2.0) browser library that reports race conditions in a running app while they happen, such as stale responses and duplicate submits, each with its evidence. In a SvelteKit app it is one import in `src/hooks.client.ts`; Svelte stores can be registered with `rt.atom` for state-level checks. A small model runs on the user's device in a Web Worker, and by default it only reports: it never holds, delays or changes a request, a response or a state write.

I used Claude (Claude Code) to draft this entry; I reviewed it. GenClass is a tool I work on.

https://github.com/genclass-dev/GenClass
```

## If asked

- *Why Dev Tools?* It is a development and debugging aid that runs inside the app, like Frontman, the section's one
  entry. If the maintainer prefers another field, move the line on this same PR.
- The maintainer merges in batches a few months apart (the last batch was merged on 2026-11-03); silence is not a
  rejection. Do not nudge before the next batch.
