# Paperless-ngx: issue drafts (not sent)

Drafts for the person who sends them, from the hunt in [paperless-ngx.md](paperless-ngx.md). Paperless-ngx allows
AI-assisted bug reports if they are disclosed and describe observed behaviour only (CONTRIBUTING.md, "Use of AI
Tools", items 1, 4 and 5, quoted in the report's section 10). So the drafts below contain what a user sees and how to
make it happen, nothing about code, causes or fixes. There is **no pull request draft**: the project does not accept
PRs that are "entirely or mostly AI-derived", so a fix must be written by hand (the report has the cause and a fix
idea for that person, plus failing test sketches).

## Before sending (by hand, in this order)

1. Search the tracker (open and closed issues, discussions) for "global search", "search results", "Escape",
   "notes ctrl+enter", "duplicate note", "note author" since 2026-11-03. This session did not query GitHub.
2. Reproduce each one yourself in a browser on a current `dev` or the latest release (policy item 5: "Please do not
   open issues or PRs you have not verified yourself"). For issue 1 the easiest way is Chrome DevTools, Network tab,
   throttling "Slow 4G" or a custom profile, then the steps; or run
   `node docs/adoption/hunts/paperless-ngx/repro.mjs --case search,search-control` against the e2e instance. Replace
   every field below that describes this session's setup with your own (version, OS, install method, logs, browser).
3. Use the **web form** ("Bug report"), not `gh issue create` (the brief reports that issues opened outside the form
   are closed by a bot). Set **AI usage** to "Yes, AI tools helped write this report".
4. Do not add anything the form's hidden comment asks AI tools to add.
5. Send issue 1 first. Send issue 2 only if you reproduce it; issue 3 only after checking it also happens when you
   reach the Notes tab by clicking inside the app, not only on a direct load or refresh.
6. One issue per bug; no root cause, no code, no fix suggestion in any of them.

---

## Issue 1

**Title:** `[BUG] Global search shows results for an earlier, shorter query after typing more`

**AI usage:** Yes, AI tools helped write this report

**Description:**

```markdown
When I type in the global search box in the header, pause briefly, and then keep typing, the results dropdown
sometimes shows the results for what I had typed before the pause instead of what is in the box. It stays that way;
the results for the full text never appear.

Example on a small test instance: I type `doc`, pause for about half a second, then type the rest so the box says
`document 12`. Expected: the dropdown lists "document 12". Observed (when the network is slow): the dropdown lists
"test document 1", "test document 2", "test document 3", the results for `doc`, under the box that says
`document 12`. In the browser's network tab both searches (`/api/search/?query=doc` and
`/api/search/?query=document 12`) succeed; the wrong list appears when the answer for `doc` arrives after the
answer for `document 12`.

A related case: type `doc`, pause, then press Escape to clear the box before the results appear. The box is empty,
but when the answer arrives the dropdown opens with the `doc` results.

With a fast local connection I could not see it; with network throttling it happened every time I tried
(5 of 5 attempts with the `doc` answer delayed 1.5 s, 0 of 5 without a delay). I have only reproduced it with a
slow network.

I used AI tools (Claude Code) to find this and to draft this report; I reproduced it myself in a browser. It was
found with GenClass, a tool I work on, which replays the same steps with the server's responses arriving in
different orders.
```

**Steps to reproduce:**

```markdown
1. Open Paperless-ngx with some documents whose titles share a prefix (e.g. "test document 1", "document 12").
2. Open the browser's developer tools, Network tab, and choose a slow throttling profile (e.g. "Slow 4G").
3. Click the search box in the header and type `doc`.
4. Wait about half a second (until the search request for `doc` has started), then type `ument 12` quickly.
5. Wait for both search requests to finish.
6. Observed: the box says `document 12`, the dropdown lists the results for `doc`. Expected: the results for
   `document 12`.

Variant: at step 4, press Escape instead of typing. When the `doc` request finishes, the dropdown opens with its
results while the box is empty.
```

**Webserver logs:** (paste your own; on the test instance the server logged no errors, and both search requests
returned 200)

```
<your webserver log lines around the two GET /api/search/ requests>
```

**Browser logs:** none (no errors in the console).

**Paperless-ngx version:** `<yours>` (found on `dev` at commit cc15aa0, 3.4.1)

**Host OS:** `<yours>` (found on Ubuntu 24.04, x86_64)

**Installation method:** `<yours>` (found on Bare metal: the repository's development instance)

**Browser:** `<yours>` (found with Chromium 153, headless, driven by Playwright)

**Configuration changes:** none

**Checkboxes:** tick all five only if true for you: you believe it affects all users, it is not about OCR of a
specific file, you searched for existing issues, you updated the title, and you disclosed AI use without code
analysis.

---

## Issue 2

**Title:** `[BUG] Pressing Ctrl+Enter twice in the notes box saves the note twice`

**AI usage:** Yes, AI tools helped write this report

**Description:**

```markdown
In a document's Notes tab, pressing Ctrl+Enter (Cmd+Enter on macOS) twice in quick succession saves the same note
twice. The "Add note" button is disabled while a note is being saved, so clicking it twice does not do this, but the
keyboard shortcut does. The two copies are visible in the list and stay after a reload.

With a slow connection it happened every time (5 of 5 with the save request taking about 300 ms and the two key
presses 40 ms apart; with one key press, 0 of 5 duplicates). On a fast local connection the second press has to come
within the time the save takes.

I used AI tools (Claude Code) to find this and to draft this report; I reproduced it myself in a browser.
```

**Steps to reproduce:**

```markdown
1. Open any document and go to the Notes tab.
2. Optional, to make it easy: in the browser's developer tools, Network tab, choose a slow throttling profile.
3. Type a note in the text box.
4. Press Ctrl+Enter twice quickly (or hold Ctrl+Enter).
5. Observed: the note appears twice, and reloading the page still shows two notes. Expected: one note.
```

**Webserver logs:** two `POST /api/documents/<id>/notes/` requests with the same body (paste yours).

(Other fields as in issue 1.)

---

## Issue 3 (send only after the check in step 5 above)

**Title:** `[BUG] Notes show no author name when the Notes tab is opened directly`

**AI usage:** Yes, AI tools helped write this report

**Description:**

```markdown
When I open a document's Notes tab directly by URL (for example `/documents/1/notes`, or by refreshing the page on
that tab), the notes are listed with an empty author: the footer reads "- Nov 3, 2026" instead of
"playwright - Nov 3, 2026". On a local test instance this happened in 10 of 10 direct loads with no throttling, and
every time when the users request was slow.

<Add whether it also happens when you open the document from the list and click the Notes tab, and whether the
names appear after any later interaction.>

I used AI tools (Claude Code) to find this and to draft this report; I reproduced it myself in a browser.
```

**Steps to reproduce:**

```markdown
1. Add a note to a document.
2. Open `/documents/<id>/notes` directly in a new tab (or refresh while on the Notes tab).
3. Observed: the note's footer shows only the date, with no author name. Expected: the author's name and the date.
```

(Other fields as in issue 1.)
