# DRAFT: Gitea bug issue, then the pull request (not filed)

> **For the sender, before anything is sent.** These drafts were written with AI assistance. Gitea's
> [AI Contribution Policy](https://github.com/go-gitea/gitea/blob/main/CONTRIBUTING.md#ai-contribution-policy) (read
> 2026-11-03) needs you to have manually tested the change, to understand it well enough to "explain, defend, and
> revise" it yourself, and to answer review in your own words ("Do not rely solely on AI to generate replies"). Gitea
> asks for an issue before a PR ("Discuss your design before the implementation"): file the issue, wait for a
> maintainer's response to the approach, then open the PR. Evidence: [gitea.md](gitea.md) (the refresh section at the
> end has today's numbers); fix and test: [gitea.patch](gitea.patch).
>
> Before filing:
>
> - [x] Search the tracker for duplicates (session, 2026-11-03: 16 queries over issues and PRs, nothing on this bug;
>   the queries are in gitea.md, "Refresh (2026-11-03)"; the closest are
>   https://github.com/go-gitea/gitea/issues/19784, uncommitted IME input on Android, a different cause, and
>   https://github.com/go-gitea/gitea/pull/36625, a merged fix for a different desync in the same editor). Search again
>   on the day you file, in case something landed since.
> - [x] Check the code is still the same on `main` and in the latest release (session: byte-identical in v28.3.0 and on
>   `main` at 78eb95ab19c64210c00b15eaf85551d188613173; the patch applies unchanged).
> - [x] Re-run the regression test and the throttled reproduction on current `main` (session: test 6 of 6 fail
>   unfixed, 6 of 6 pass fixed; throttled reproduction 5 of 5 stale unfixed, 0 of 5 fixed).
> - [ ] **Reproduce it by hand** in your own browser on a Gitea built from current `main` (steps below; devtools'
>   network throttling with a custom profile of 400 ms and 50 KB/s makes it easy). Gitea's CONTRIBUTING asks reporters
>   to try "a site running on the latest commits" and names demo.gitea.com; a local build of `main` is that too. The
>   issue's last line says you reproduced it by hand: keep it only once you have.
> - [ ] Rewrite the text in your own words where you want to, and be ready to answer questions yourself.
> - [ ] File the issue from your own account with the bug report form (fields below, verbatim).
>
> Before opening the PR (after a maintainer agrees with the approach):
>
> - [ ] Run the test yourself, unfixed and fixed: `GITEA_TEST_E2E_FLAGS='tests/e2e/markdown-preview.test.ts' make test-e2e`.
> - [ ] Read the whole diff (83 lines added, 1 removed) and be able to explain the counter and the test's wait.
> - [ ] `git am` the patch, then `git commit --amend --reset-author` so the commit is yours, and replace
>   `MODEL_VERSION` in the `Assisted-by:` trailer (Gitea's AGENTS.md wants `Assisted-by: AGENT_NAME:MODEL_VERSION`,
>   never `Co-Authored-By` or `Signed-off-by`).
> - [ ] Replace `<issue URL>` in the PR text with the issue's full URL (Gitea's AGENTS.md: full URLs, not numbers).

---

## The issue

Fields follow Gitea's bug report form (`.github/ISSUE_TEMPLATE/bug-report.yaml`, unchanged on 2026-11-03).

**Title:** Markdown preview can show outdated text when Preview is clicked again before the previous preview loads

**Gitea Version:** `main` at 78eb95ab19c64210c00b15eaf85551d188613173 (also v28.3.0; the code is the same)

**What happened?**

The Preview tab of the markdown editor can end up showing text that is no longer in the editor, with nothing to tell
the user it is stale.

Steps:

1. In the browser's devtools, throttle the network (I used 400 ms latency and 50 KB/s up and down).
2. Open any comment box, for example a new comment on an issue, and paste a long text (I used 1,500 list items, about
   60 KB).
3. Click **Preview**, and about a second later, before it has loaded, click **Write**.
4. Replace the text with something short, `short text`, and click **Preview** again.
5. The preview first shows "short text", then the long text's preview arrives and replaces it. The editor still
   contains "short text".

The long text takes longer to upload, render and download, so its response arrives last. Any first response that is
slower than the time it takes to switch tabs and edit does the same (a long document, a busy instance, a slow
connection). In Playwright it is deterministic: hold the first `POST .../markup` response with `page.route` until the
second preview has rendered.

Expected: the preview always shows the text from the latest Preview click.

The web file editor has the same problem in its **Preview** and **Preview Changes** tabs (edit a file, Preview, Edit
File, change it, Preview again).

Cause: each click sends a request and renders whatever comes back, with no check that the response belongs to the
latest click:

- https://github.com/go-gitea/gitea/blob/v28.3.0/web_src/js/features/comp/ComboMarkdownEditor.ts#L244-L254 (all
  markdown editors)
- https://github.com/go-gitea/gitea/blob/v28.3.0/web_src/js/features/repo-editor.ts#L28-L43 (file editor Preview)
- https://github.com/go-gitea/gitea/blob/v28.3.0/web_src/js/features/repo-editor.ts#L50-L58 (file editor Preview
  Changes)

Suggested fix: keep a request counter in each handler and render only the response to the latest request (a few lines
per handler; an AbortController would also work but needs every handler to catch the `AbortError`). I have the change
and an e2e test (`tests/e2e/markdown-preview.test.ts`: it holds the first response with `page.route`, fails on current
`main` and passes with the fix) ready, and can open a PR if this approach is fine.

**How are you running Gitea?**

Built from source (`make build`), binary, Linux (Ubuntu 24.04), SQLite; Chromium.

I reproduced this by hand and with the Playwright test above. I used Claude (Claude Code) to investigate this, write the fix and the test, and draft this description; I reviewed the change and ran the tests and the manual check myself; the race was found with GenClass, a tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## The pull request (after the issue)

Gitea's `.github/pull_request_template.md` is a comment only ("Target the `main` branch", "Use a Conventional Commits
title", "Describe your change below and link any issue it fixes"); its AGENTS.md asks for a minimal description (what
and why, under 1000 characters, no file listings), issues by full URL, and agent attribution on one trailing line,
never as a section. No screenshots: nothing in the UI changes except which response is rendered.

**Title:** `fix(markdown): ignore outdated preview responses`

**Body:**

```markdown
Fixes <issue URL>

When Preview is clicked again while an earlier preview request is still in flight, the earlier response can arrive last and replace the newer render, so the preview shows text that is no longer in the editor. Each preview handler (the markdown editor, and the file editor's Preview and Preview Changes tabs) now keeps a request counter and renders only the response to its latest request (unlike an AbortController, this adds no error path).

The e2e test holds the first response with `page.route`, releases it after the second preview has rendered, and expects the newer text to stay. It fails on `main` and passes with the fix.

I used Claude (Claude Code) to investigate this, write the fix and the test, and draft this description; I reviewed the change and ran the tests and the manual check myself; the race was found with GenClass, a tool I work on, which replays the same steps with the server's responses delivered in different orders.
```

(965 characters with the `<issue URL>` placeholder.)

What to say when asked:

- *Why not abort the request?* Aborting makes the awaited `POST` reject; Gitea's global handler would show an error
  unless every handler catches it. The counter adds no error path; the outdated request still completes on the server
  and its response is simply not rendered.
- *Why does the test wait for `requestfinished` plus a frame?* With the fix the page does nothing when the late
  response arrives, so there is no event to wait for; the wait was long enough in every unfixed run (26 of 26 across
  2026-10-24 and 2026-11-03). On a much slower runner it could let a regression pass; it cannot fail on correct code.
- *Two editors on one page?* Each handler keeps its own counter in its closure, so they do not interfere.
