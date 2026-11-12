# Changelog

## 0.1.1

- **Fixed: the guided setup ended at the suggestions step's address question.** A question asked right after another
  one (with nothing in between that waits) had its input paused when the earlier question's reader closed, and the
  command ended at the prompt. Each question now waits for the one before it to have closed
  (`packages/runtime/bin/lib/ui.mjs` `ask`). Found on the first real run of 0.1.0.
- The README no longer says the package is not on npm.

## 0.1.0

The first version: one command for everything GenClass sets up.

- **`genclass`** shows where a project stands in six steps (signed in, GenClass in the app, first page seen, pull
  requests checked, coding agent connected, suggestions) and, on a terminal, walks the next one. Each step is read
  from what is on disk and what genclass.dev answers, so a run continues where the last one stopped.
- **`genclass setup --yes`** and **`genclass status --json`** are the same walk for a coding agent: nothing is asked,
  and what only a person can do (approve the sign-in, install the GitHub App) is printed with its link.
- **`genclass suggest [url]`** measures the repository and the live site against a catalog of checks (launch, search,
  AI assistants, payments, safety, quality, email) and prints what failed, most important first, each with its
  evidence, what to do and a prompt for a coding agent. Signed in, genclass.dev orders the list for the app and
  words the reasons; it is sent the failed checks and five things about the app, never code, and the command shows
  that before the first send.
- `login`, `logout`, `whoami`, `connect`, `dashboard`, `init`, `remove` and `scan` are the commands of
  `@genclass/runtime`'s own CLI, unchanged.
- One file with no dependencies. It installs `@genclass/runtime` and `@genclass/mcp` at the versions it was built
  with.
