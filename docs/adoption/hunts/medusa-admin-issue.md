# Medusa admin: issue and pull request material (not ready-to-paste text)

For the sender of the Medusa contribution prepared in [medusa-admin.md](medusa-admin.md) (2026-11-03). Medusa's
CONTRIBUTING.md (develop, read 2026-11-03) says: "AI-authored pull requests are not accepted: the PR description and
your replies to reviewers must be in your own words", and issues or PR descriptions "that read as AI-generated get a
comment asking you to rewrite them in your own words", closed after 8 hours if not rewritten. Translating or
proofreading text you wrote yourself is allowed. **So this file gives no text to paste.** It gives, for each field of
Medusa's bug template (`.github/ISSUE_TEMPLATE/bug_report_v2.yml`) and pull request template
(`.github/pull_request_template.md`), the facts the sender writes in their own words, each one measured in the report.
The code, the test and the changeset in [medusa-admin.patch](medusa-admin.patch) may be AI-assisted under the same
policy ("You may use AI tools to help write code, but you must understand and be able to explain every change").

Order (Medusa's process): **1.** file the issue, **2.** comment on it asking to be assigned and saying a fix with a
regression test is ready, **3.** wait for a maintainer to assign you, **4.** only then open the pull request from a
fork, linking the issue. pr-guardrails closes an unlinked or unassigned PR 8 hours after its warning; at most 3 open
PRs per contributor. The triage bot may queue its own fix for a small UI bug ("Issues that our automation is already
fixing are not assigned to contributors"); if it does, the issue still stands and the PR is not opened.

## Before sending (the sender, by hand)

- [ ] Search the tracker since 2026-11-03 for duplicates: `is:issue exchange "add items" twice`, `claim "add items"
      duplicate`, `RETURN_ITEM duplicate`, `exchange inbound quantity 2`, and open PRs touching
      `exchange-inbound-section.tsx`, `exchange-outbound-section.tsx`, `claim-create-form.tsx`,
      `claim-outbound-section.tsx`. (The session's searches, the brief's, found none on 2026-11-03: "admin duplicate submit
      twice" 0 results.)
- [ ] Reproduce by hand in a fresh `dtc-starter` (section 4.2 of the report): an order with a delivered item, Orders →
      the order → "…" → Request exchange → Inbound "Add items" → tick one item → Save → "Add items" again → Save without
      changing anything. The item's quantity shows 2. Then the double-click case: cancel, start again, double-click Save.
- [ ] Publish the reproduction repository the bug template requires (a required field): the `dtc-starter` checkout at
      `913d448` with `seed.mjs` and `repro.mjs` from `docs/adoption/hunts/medusa-admin/` and a README with the five
      commands of report section 1. Nothing from GenClass is needed in it: `repro.mjs` imports only Playwright.
- [ ] Apply `medusa-admin.patch` on Medusa's `develop` (recorded at `97012ac68ced9e1742159cca62df1c2ed9f48ef5`; check it
      still applies with `git apply --check`), run `yarn test src/routes/orders/order-create-exchange/components/exchange-create-form/exchange-inbound-section.spec.tsx`
      in `packages/admin/dashboard` on the unfixed code (2 failed) and the fixed code (2 passed), and the dashboard's whole
      `yarn test` (190 passed here).
- [ ] Read the diff until you can explain every line: the module-level `itemsToAdd`/`itemsToRemove`, why the second
      Save adds again, why a ref and not state (the second press arrives before React re-renders; the existing specs
      render with `renderToString`), why the selection is cleared after it is applied and not before (a failed add
      keeps the selection for a retry).
- [ ] Write the issue and the PR description yourself from the facts below, and answer the template's AI Usage
      question truthfully (facts for it below).
- [ ] Branch name `fix/dashboard-add-items-double-save` (Medusa: `fix/`, `feat/`, `docs/` off `develop`), PR against
      `develop`.

## 1. The issue (bug_report_v2.yml, "Bug report for v2.0"), facts per field

Title field: starts with `[Bug]: `. Facts for it: exchange and claim "Add items" Save can add the same items twice.

- **Package.json file**: paste `apps/backend/package.json` of your reproduction repository (dtc-starter: `@medusajs/*`
  2.22.2, `@medusajs/dashboard` 2.22.2, `@tanstack/react-query` 5.64.2).
- **Node.js version**: your `node -v` (the session ran v22.23.4).
- **Database and its version**: yours (the session ran PostgreSQL 16.15).
- **Operating system name and version**: yours (the session ran Ubuntu 24.04.5 LTS).
- **Browser name**: yours (the session ran Chromium 153 headless through Playwright 1.63.0).
- **What happened?** Facts:
  - In the exchange create modal (Orders → order → Request exchange), "Add items" for the inbound items, tick one
    item, press Save twice quickly (a double click): two `POST /admin/exchanges/{id}/inbound/items` with the same
    item, the exchange gets two `RETURN_ITEM` actions of quantity 1, the item shows quantity 2, and the order preview's
    `return_requested_quantity` for that line is 2.
  - Without any timing: add one item with one Save, open "Add items" again and press Save without changing the
    selection: the same item is added a second time (same result, 2).
  - Typing 1 into the quantity afterwards does not undo it: the input shows 1 but the server keeps both actions and
    `return_requested_quantity` stays 2 (measured 2 of 2).
  - Same in the exchange's outbound "Add items" (two `ITEM_ADD` lines of the same variant) and in the claim's inbound
    "Add items" (two `RETURN_ITEM`). Return requests are not affected (their modal clears its selection and closes at once).
  - Where in the code (develop): `itemsToAdd` and `itemsToRemove` are module-level `let`s in
    `exchange-inbound-section.tsx`, `exchange-outbound-section.tsx`, `claim-create-form.tsx` and
    `claim-outbound-section.tsx`; `onItemsSelected` never resets them, and the Save button has no pending state, so a
    second Save (during the request or after reopening) sends the same selection again. The order edit's add-items
    modal next to them disables its Save with `disabled={isPending}`.
- **Expected behavior**: one press or one selection adds each item once; saving the modal again without a new
  selection adds nothing.
- **Actual behavior**: the counts above: 12 of 12 trials without any tool (3 each: exchange inbound double click, exchange
  reopen and save, claim inbound double click, exchange outbound double click), double clicks with 40, 120 and 250 ms
  between the presses all duplicated (2 of 2 each), one click never did (2 of 2).
- **Link to reproduction repo**: your public repository (above).
- Optional last line, your own words: a fix with a Vitest regression test is ready and you would like to be assigned.

## 2. The comment asking to be assigned

Facts: you can reproduce it on 2.22.2 and develop; you have a fix for the four modals with a Vitest spec
(fails before, passes after); you would like to be assigned. One or two sentences, your own words.

## 3. The pull request (pull_request_template.md), facts per section, after you are assigned

- **Linked issue**: `Fixes #<the issue>`.
- **What**: the "Add items" Save in the exchange inbound and outbound and the claim inbound and outbound modals applies
  a selection once: a second press while the first is in progress is ignored, and the applied selection is cleared.
- **Why**: a double click, or saving the modal again without a new selection, added the same items again (two
  `RETURN_ITEM` / `ITEM_ADD` actions, quantity 2), which a merchant cannot undo by typing 1 (issue).
- **How**: in each of the four files the old `onItemsSelected` body becomes `addSelectedItems`, which sets
  `itemsToAdd = []` after the add request and `itemsToRemove = []` after the removals; the new `onItemsSelected`
  runs it behind a `useRef` flag (synchronous, so a second press before React re-renders is ignored too). A failed
  add keeps the selection so Save can be retried. No API, type or text changes.
- **Testing**: `exchange-inbound-section.spec.tsx` (Vitest, the `product-export.spec.tsx` pattern: mocked modules,
  `renderToString`, the captured Save handler): Save pressed twice in a row adds once; Save after a save without a new
  selection adds nothing. Both fail on develop (`expected "vi.fn()" to be called 1 times, but got 2 times`, 3 of 3
  runs) and pass with the change (3 of 3); the dashboard's `yarn test`: 31 files, 190 tests passed; `yarn typecheck`
  clean; prettier clean; eslint shows the same 26 pre-existing `react-hooks/exhaustive-deps` warnings on these files
  before and after. Manually: report section 4.6 (the fixed build in a browser). The reviewer can test it with the
  issue's steps.
- **Examples**: none needed (a bug fix); you may delete the code block or show the two steps.
- **Checklist**: changeset added (`.changeset/dashboard-add-items-double-save.md`, `@medusajs/dashboard` patch); tests;
  verified locally (only tick it after you did); linked and assigned (only after assignment); "I wrote this description
  myself and can explain every change" (only if true).
- **AI Usage** (answer truthfully, your words). Facts: Claude (Claude Code, Anthropic) investigated the bug, wrote the
  fix, the Vitest spec and the changeset, and ran the checks; you reviewed the diff and ran the test and the manual
  reproduction yourself. The double submit was first flagged by GenClass, a tool you work on, which watches an app's
  requests in the browser; it reported the two identical in-flight `POST .../inbound/items` (`duplicate-request`).
  The disclosure the GenClass swarm asks for, to adapt into your own words here: "I used Claude (Claude Code) to
  investigate this, write the fix and the tests, and draft this description; I reviewed the change and ran the tests
  and the manual check myself. The race was found with GenClass, a tool I work on, which replays the same steps with
  the server's responses delivered in different orders." Under Medusa's policy the description is yours, so leave out
  "and draft this description" (Claude drafted these notes, not the description), and since this one is a double
  submit rather than a reordering, say that GenClass flagged the two identical requests in flight.
- **Additional Context**: the order edit modal's Save already uses `disabled={isPending}`; `@medusajs/ui`'s `Button`
  `isLoading` could be added for feedback if maintainers prefer (not in this change, to keep it small). A separate,
  unpatched observation is in report section 5 (the order timeline can miss a just-created exchange); file it as its
  own issue only if you want to, after this one.
