# Audiobookshelf: facts for the sender's own issue comment and pull request

Audiobookshelf does not accept fully AI-generated issues or pull requests
(<https://audiobookshelf.org/docs/contributing/general/>, read 2026-11-03: "We do not accept or review PRs or issues
that are fully AI-generated ... AI tools are not banned, but contributors are expected to apply human judgment and due
diligence"; "If you are a first time contributor, please try to make smaller PRs first"). So this file is **not
paste-ready text**. It gives the facts, the reproduction and the test for a person to check by hand and then write up
in their own words, in the project's pull request template. The report is [audiobookshelf.md](audiobookshelf.md);
the patch is [audiobookshelf.patch](audiobookshelf.patch).

## 1. What to send, and where

- **One pull request** to `advplyr/audiobookshelf`, base `master`, that fixes
  [#2231](https://github.com/advplyr/audiobookshelf/issues/2231) ("Match" has a slow race condition with user input).
  The fix is client-only: one component and one new Cypress component spec. Nothing else goes in this PR.
- **No new issue.** #2231 is open (labels `bug`, `unable to reproduce`, `waiting`; last activity 2024-02-28, per the
  page read on 2026-11-03). The template's "Which issue is fixed?" line is `Fixes #2231`. The PR itself carries the
  deterministic reproduction that the issue lacked.
- **Not in this PR.** These are the two other findings in the report. Each could be its own small PR later, once the
  first one has had a response:
  - the global search overlap ([audiobookshelf.md](audiobookshelf.md) section 5). No issue exists, so open one first
    or describe it in its own PR.
  - the #5627 progress rollback (section 6). Open PR [#5640](https://github.com/advplyr/audiobookshelf/pull/5640) is in
    that area. Do not duplicate it; at most, comment on #5627 with the API steps, in your own words.
- The PR template (`.github/pull_request_template.md`) has these sections: Brief summary / Which issue is fixed? / In-depth
  Description / How have you tested this? / Screenshots. It says: "If you do not follow this template, the PR may be
  closed without review". Fill in every section yourself.

## 2. The facts (each with its source)

1. **Symptom (#2231, the reporter, 2023-10-21, v2.4.4).** After a Match, the "Edit item" modal shows the "Item details
   updated" toast. Edits made while the toast is up are reverted a few seconds later. On 2024-02-28 the reporter said
   it still happens: "add an extra tag and save, remove that tag as the edit dialog opens, wait a few seconds; the
   removed tag reappears" (paraphrased from the issue page).
2. **Maintainer's diagnosis (#2231, 2023-10-23 and 2023-10-28).** The folder watcher picks up the cover or metadata
   file that the match wrote, rescans the item a few seconds later, and the server emits another update to every
   client. The maintainer could not reproduce it.
3. **Mechanism in the code (commit `ce41ce489cebaf00e008919f6f2901b428acfd56`, v2.37.2, master on 2026-11-01):**
   - Every server-side change to an item ends in `SocketAuthority.libraryItemEmitter('item_updated', ...)`. Examples:
     `server/controllers/LibraryItemController.js` line 280 (PATCH `/api/items/:id/media`), and 14 other places in
     that file and `MiscController.js`. A watcher rescan ends there too.
   - `client/layouts/default.vue` lines 209-222 (`libraryItemUpdated`) re-emits the update on the event bus as
     `` `${libraryItem.id}_updated` ``.
   - `client/components/modals/item/EditModal.vue` lines 248-250 (`libraryItemUpdated`) replaces its `libraryItem`
     with the update.
   - `client/components/widgets/BookDetailsEdit.vue` lines 103-110 watch `libraryItem` and call `init()` on every
     change. `init()` (lines 274-289) copies every field from the server's copy, so any unsaved edit is overwritten.
     There is no check for unsaved changes.
   - So the bug is not specific to Match. Any `item_updated` for the item that is open wipes unsaved edits: a watcher
     rescan, an edit of the same book in another tab or on another device, a scan, and the modal's own **Save** (not
     Save & Close) if the user keeps typing before the save's update arrives.
4. **Measured on 2026-11-03** (a local build of `ce41ce48`, Node 24.22.2, SQLite, 220 seeded books, headless Chromium,
   scripted with Playwright; no GenClass involved in these numbers):
   - Another client PATCHes the publisher while the title is being edited: title reverted in **3 of 3** runs. With
     no server-side change, the title was kept in 3 of 3 (control).
   - A new file is written into the book's folder on disk while the title is being edited: the watcher rescanned
     **12.8 s** later (12766-12792 ms) and the title reverted in **3 of 3** runs.
   - Title edited, Save clicked, subtitle typed at once: subtitle wiped in **every one of 24 loads** (3 sessions × 8
     loads, with up to 300, 600 and 900 ms of added response latency; report, section 3).
5. **The fix (the patch).** When the watcher sees a new `libraryItem` with the same `id`, the form takes the server's
   values. It then puts back each field the user changed, as long as this update did not change that field. If the
   update did change it, the server's value wins: the user just saved it, or someone else changed it. A different item
   (`id` changed, for example the modal's next/previous arrows) resets the form as before. The change is 23 lines
   added and 3 removed in `BookDetailsEdit.vue`. `PodcastDetailsEdit.vue` lines 79-85 have the same watcher and are
   **not** changed, to keep the PR small. Mention this as a possible follow-up if you want.
6. **The test.** `client/cypress/tests/components/widgets/BookDetailsEdit.cy.js` mounts the form with the real text
   inputs, types a new title and replaces the `libraryItem` prop with a copy whose publisher changed. It asserts that
   the typed title stayed and the new publisher shows. A second case checks that a different item resets the form.
7. **What was and was not run here** (be exact about this in "How have you tested this?"; write only what you ran
   yourself):
   - The Cypress spec itself was **not** run in this session: the Cypress binary download (download.cypress.io) is
     blocked in the cloud environment. A stand-in that mounts the same `.vue` file in Vue 2.7 in Chromium and replays
     the same two cases gave: unfixed, the edit case **failed 3 of 3** and the different-item case passed 3 of 3;
     fixed, both passed 3 of 3 (`hunts/audiobookshelf/standin-component-test.mjs`).
   - On the fixed build, the end-to-end reproduction kept the title in 3 of 3 (PATCH) and 3 of 3 (watcher), and the
     Save-then-type scenario kept the subtitle (report, section 4.5).
   - Prettier (`npx prettier --check`, the repository's `.prettierrc`) passes on both files. The repository's
     `npm run lint` ignores `client/`.

## 3. Before sending (the sender, by hand)

1. Search the tracker for anything filed since 2026-11-03 on this bug: `is:issue is:open edit details reset`, `is:pr
   BookDetailsEdit`, `is:pr item_updated`, and the #2231 page itself (a maintainer may have answered or closed it).
2. Reproduce by hand on current `master` **without the patch**, in a normal browser. Open a book, click Edit, then the
   Details tab, and change the title without saving. In a second browser tab, open the same book and change the
   publisher, then click Save. Look at the first tab: the title is back to the stored one. Then do the Match path that
   #2231 describes, if you can (a Match with a cover writes a file the watcher sees).
3. Apply the patch (`git apply audiobookshelf.patch` on `master`), rebuild the client, and repeat step 2: the title you
   typed stays, and the publisher field shows the new value.
4. Run the spec: `cd client && npx cypress run --component --spec cypress/tests/components/widgets/BookDetailsEdit.cy.js --browser chrome`
   (or `npm test` for the whole suite). Run it once without the fix too: the first case should fail.
5. Read the diff line by line. Decide whether you agree with "the server wins on a field both sides changed". Be ready
   to explain that rule, or change it, if the maintainer prefers another (for example, a warning).
6. Take the before/after screenshots the template asks for on web-client changes.
7. Write the PR body yourself, in the template, from the facts above. End it with the disclosure paragraph in section
   4 (the policy prescribes no wording; this is the swarm's standard one).

## 4. Disclosure paragraph (to end the PR body; true only once steps 2 to 5 are done)

> I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
> the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
> replays the same steps with the server's responses delivered in different orders.

Note for the sender: the second sentence is accurate only for the *search* finding (report, section 5), which explore
reproduced from response orderings. #2231 is driven by a socket push, and GenClass's explore does not reorder socket
messages. This hunt reproduced #2231 directly, by reading the code and triggering a server-side update. If you send
only the #2231 PR, replace the second sentence with something true. For example: "I found the cause while running
GenClass, a tool I work on, against Audiobookshelf; the reproduction above needs no tool." Or drop it.
