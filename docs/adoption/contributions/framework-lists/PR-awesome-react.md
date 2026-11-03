# Pull request to enaqx/awesome-react (held: needs owner decision, "later")

Status: **needs owner decision; recommendation: do not send yet.** Base: `master` at
`e6fd973eefe57d288a60e6d21bb9d8f343addfe9` (2026-09-04). Patch:
[upstream-awesome-react.patch](upstream-awesome-react.patch) (one line in `README.md`, `#### React Development Tools`,
appended after why-did-you-render; lowercase name and no trailing period, as every entry in that section).

What is missing, in the maintainer's own words on comparable pull requests:

- Traction: "Hello, I do not want to discourage you. Its great start but lets add it later if it gets more traction!"
  (enaqx on https://github.com/enaqx/awesome-react/pull/1801, a 6-star project). GenClass had 7 stars on 2026-11-03
  (GitHub search API, `repo:genclass-dev/GenClass`) and was created 2026-10-07.
- React-specificity: "It is not specific to React" (https://github.com/enaqx/awesome-react/pull/1810) and "not
  React/React Native oriented project and more general one" (https://github.com/enaqx/awesome-react/pull/1722).
  GenClass is framework-agnostic; its React-specific part is automatic discovery of React component state, Redux /
  Redux Toolkit stores and Zustand stores that use `devtools`.
- README "Contribution": "Kindly refrain from using this list as an advertisement board or a space to promote your
  experiments. We focus on sharing entirely free resources here."

There is no star number to reach; the bar is the maintainer's judgement. Revisit when GenClass has visible usage
outside its authors (stars, dependents, issues from users). The nearest comparable pull request in the same section,
why-did-you-fetch (#1845), was still open and unanswered on 2026-11-03 (search API).

Commit:

```
Add genclass to React Development Tools

https://github.com/genclass-dev/GenClass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Title

```
Add genclass to React Development Tools
```

## Body

```markdown
Adds [genclass](https://github.com/genclass-dev/GenClass) to React Development Tools.

It reports race conditions in a running React app while they happen (stale responses that land over newer data, duplicate submits), each with its evidence. In React it discovers component state, Redux / Redux Toolkit stores and Zustand stores that use `devtools` on its own, so one import is the whole setup. A small model runs on the user's device in a Web Worker; by default it never holds, delays or changes a request, a response or a state write. Free and Apache-2.0.

I used Claude (Claude Code) to draft this entry; I reviewed it. GenClass is a tool I work on.
```

## If sent anyway and declined

Thank the maintainer in one line and close nothing yourself; do not argue and do not reopen. Do not send a second
pull request until the traction question has a clear answer.
