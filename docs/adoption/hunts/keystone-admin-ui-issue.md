# Keystone: draft issue and draft pull request

Drafts for the Keystone maintainers, from the hunt in [keystone-admin-ui.md](keystone-admin-ui.md). Nothing here has
been posted. Keystone's `CONTRIBUTING.md` welcomes issues and pull requests directly (no CLA, no DCO, no AI policy, no
issue-first rule), so either can be sent alone; the pull request below links the issue if both are sent, issue first.
The patch is [keystone-admin-ui.patch](keystone-admin-ui.patch), against `keystonejs/keystone` `main` at
`88da2cc283395509fbbf4f1b192294fdb8fee783` (2026-11-03, "Version Packages (#10071)").

## Before sending (for the sender)

- [ ] Search the tracker again for the same bug since 2026-11-03 (issues and pull requests: "created twice", "enter
      twice", "double submit", "duplicate create", "submitted twice"; on the hunt date nothing matched, see the report,
      section 4.5).
- [ ] Reproduce by hand at the then-current `main`: `examples/usecase-blog` (or any example), open
      `/tags/create` with Chrome DevTools' network throttling at "Slow 4G" (or "3G"), type a name, press Enter twice
      quickly. Two `createTag` requests leave and two tags exist.
- [ ] Apply the patch (`git am keystone-admin-ui.patch`) and run the new test unfixed and fixed:
      `DATABASE_URL=file:./test.db pnpm vitest run --maxWorkers=1 tests/admin-ui-tests/create-item.test.ts`
      (the test fails without the `useCreateItem.ts` change and passes with it).
- [ ] Read the whole diff (one hook, one test file, one CI matrix line, one changeset).
- [ ] Make every sentence of the AI-assistance paragraph true (you ran the test and the manual check yourself), and
      send from your own account. Keystone has no template for pull requests and a 6-line template for issues (below).

## Issue (template: `.github/ISSUE_TEMPLATE/1.Bug_report.md`)

Title: **Pressing Enter twice on the create item page creates the item twice**

```markdown
<!-- Please add steps to reproduce the problem -->

1. Run any example with the Admin UI, e.g. `examples/usecase-blog` (`pnpm dev`).
2. In Chrome DevTools, set network throttling to "Slow 4G" (the bug needs the create request to take a moment).
3. Open http://localhost:3000/tags/create, type a name into the Name field and press Enter twice quickly.
4. Two `createTag` mutations are sent and two tags with that name exist (the page navigates to the first one).

The same happens on every create page (`/authors/create`, `/posts/create`, ...): pressing Enter in a text field while
the create is in flight submits the form again. Clicking or double clicking the Create button does not, because the
button is pending.

Measured on `main` at 88da2cc with the Admin UI's production build (`keystone build && keystone start`) and
Playwright: with the `createTag` request held 300 ms, Enter pressed twice 60 ms apart created two tags in 3 of 3 tries;
without added latency, in 1 of 3. A double click on Create created one tag in 3 of 3 (with and without latency).

<!-- Please describe what you expected to happen -->

One item is created, as when the Create button is clicked twice: a second submit while the create is in flight is
ignored.

Cause: `CreateItemPage`'s form submits through a hidden `<button type="submit">` (the react-aria Enter workaround,
`packages/core/src/admin-ui/pages/CreateItemPage/index.tsx` line 51). The visible Create button is `isPending` while the
mutation runs, but the hidden one is not, and neither the form's `onSubmit` (lines 35 to 43) nor
`useCreateItem().create()` (`packages/core/src/admin-ui/utils/useCreateItem.ts` line 80) checks whether a create is
already in flight. The item page already guards its save the same way (`ItemPage/index.tsx` line 232,
`if (isSaving) return`).

<!-- Please add any screenshots if possible -->

(none; the counts above are from the request log and the GraphQL API)

<!-- Please add contextual information such as your node version (node -v), or the web browser you used -->

Node 22.23.4, Chromium 153 (Playwright 1.63 headless) and Chrome with DevTools throttling; `@keystone-6/core` from
`main` at 88da2cc (8.2.x line).

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.
```

## Pull request (no template in the repository)

Title: **Fix the create item page creating the item twice when the form is submitted again while creating**

```markdown
Fixes #<issue number> (if the issue is sent first; otherwise drop this line)

Pressing Enter in a field of the create item page submits the form through the hidden submit button, which is not
pending while the create mutation is in flight, so pressing Enter twice (or Enter after clicking Create) sends a second
create and creates the item twice. `useCreateItem().create()` now ignores a call while a create is in flight, with a
ref so that a second submit in the same frame is also caught; the item page already ignores a second save the same way
(`if (isSaving) return`).

- `packages/core/src/admin-ui/utils/useCreateItem.ts`: an `isCreatingRef` guard around the mutation (reset in
  `finally`, so a failed create can be retried).
- `tests/admin-ui-tests/create-item.test.ts`: holds the `createTask` request for 500 ms, presses Enter twice in the
  Label field and asserts one create request and one task. It fails on `main` (2 requests, 2 tasks) and passes with the
  fix, in the dev and production runs `adminUITests` makes.
- `.github/workflows/tests_ci.yml`: the new file in the `admin_ui_integration_tests` matrix.
- `.changeset/fix-create-item-double-submit.md`: patch for `@keystone-6/core`.

To check by hand: `examples/usecase-blog`, DevTools throttling "Slow 4G", `/tags/create`, type a name, Enter twice:
one tag (two before).

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.
```

## A second, smaller observation (not in the patch, not drafted as an issue)

On a list page, a click on a column header while the next page (or a new filter) is loading is ignored: while the
query is in flight `data` is undefined, so `allowsSorting` is `false` for every column
(`packages/core/src/admin-ui/pages/ListPage/index.tsx` line 504, `!isConstrained && !data?.items?.length ? false :
field.isOrderable`, which reads as meant for an empty, unfiltered list). Reproduced without GenClass with page 2's query
held 800 ms: the click was lost in 5 of 5 tries, and in 0 of 3 once the page had loaded (report, section 6). Whether
sorting should be possible during loading is a design call for the maintainers; it could be raised in a discussion
after the fix above, if at all.
