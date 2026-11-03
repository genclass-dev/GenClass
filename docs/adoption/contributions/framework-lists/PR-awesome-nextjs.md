# Pull request to unicodeveloper/awesome-nextjs

Status: **ready to send**. Base: `master` at `483a40d51d2e8b4daac81fb517ca29abf7ca33df` (2026-11-02). Patch:
[upstream-awesome-nextjs.patch](upstream-awesome-nextjs.patch) (one line in `README.md`, `## Extensions`, appended
after `@farming-labs/docs`).

Commit (CONTRIBUTING.md: "The body of your commit message should contain a link to the repository"):

```
Add GenClass to Extensions

https://github.com/genclass-dev/GenClass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Title

```
Add GenClass to Extensions
```

## Body

```markdown
Adds [GenClass](https://github.com/genclass-dev/GenClass) to the **Extensions** section, at the end of the list.

GenClass is an open-source (Apache-2.0) browser library that reports race conditions while they happen: stale responses that land over newer data and duplicate requests such as double submits. In a Next.js app it is one import in `instrumentation-client.ts` (Next.js 15.3 or later; earlier versions use a client component in the root layout or `pages/_app`). A small model runs on the user's device in a Web Worker, and by default it only reports: it never holds, delays or changes a request, a response or a state write.

I used Claude (Claude Code) to draft this entry; I reviewed it. GenClass is a tool I work on.

https://github.com/genclass-dev/GenClass
```

## If asked

- *Is it Next.js-specific?* No: it is a browser library with a documented Next.js path (`instrumentation-client.ts`)
  and a Next.js 16 App Router app in its compatibility matrix
  (https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md). If the maintainers prefer another section,
  move the line there on this same PR (CONTRIBUTING.md: "just edit the existing one").
- *Is it free?* The library is Apache-2.0 and works without an account; genclass.dev sells hosted dashboards on top,
  which the entry does not link.
- Silence is normal here (356 open pull requests on 2026-11-03). One short, polite nudge after two weeks is within
  the list's custom; no second one.
