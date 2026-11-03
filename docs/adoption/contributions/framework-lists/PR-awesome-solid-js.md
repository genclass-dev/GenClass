# Pull request to one-aalam/awesome-solid-js

Status: **ready to send**. Base: `main` at `48140bdc0e2d194f0251bfc375681605f93c9d2f` (2026-07-30). Patch:
[upstream-awesome-solid-js.patch](upstream-awesome-solid-js.patch) (one line in `README.md`, `## 🛠️ Tooling`,
appended after ArkEnv).

Commit (no written rules; the shape of #78, "Add ArkEnv to Tooling", which was squash-merged with a link and an AI
co-author trailer):

```
Add GenClass to Tooling

https://github.com/genclass-dev/GenClass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Title

```
Add GenClass to Tooling
```

## Body

```markdown
Adds [GenClass](https://github.com/genclass-dev/GenClass) to the Tooling section.

GenClass is an open-source (Apache-2.0) browser library that reports race conditions while they happen (stale responses that land over newer data, duplicate requests such as double submits), each with its evidence. In a Solid app it is one import at the top of `src/index.tsx`; signals and stores can be registered with `rt.atom` for state-level checks. A small model runs on the user's device in a Web Worker, and by default it only reports: it never holds, delays or changes a request, a response or a state write. A Solid 1.9 + Vite app is in its [compatibility matrix](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md).

I used Claude (Claude Code) to draft this entry; I reviewed it. GenClass is a tool I work on.
```

## If asked

- *Is it Solid-specific?* No: it is a browser library with a Solid path; it does not discover Solid signals on its
  own, which is why the body names `rt.atom`.
- The list moves a few times a year (last commit 2026-07-30); silence is normal.
