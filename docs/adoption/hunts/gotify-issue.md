# Gotify server: draft issue, pull request and commit (not sent)

Drafts for the finding in [gotify.md](gotify.md) section 4. Nothing here has been posted. Gotify's
[CONTRIBUTING.md](https://github.com/gotify/server/blob/master/CONTRIBUTING.md) asks for a bug to be confirmed (issue
or `#gotify:matrix.org`) and, before starting on a fix, a comment saying you want to submit the PR. So the order is:
the issue (which already says you would like to send the fix), wait for a maintainer's confirmation, then the pull
request. The repository has no pull request template, no CLA, no DCO and no AI policy (read 2026-11-03).

## Before sending (the sender, by hand)

- [ ] Search the tracker again for duplicates filed after 2026-11-03: open and closed issues and PRs in gotify/server
      for "spinner", "loading", "loadMore", "Refresh", "messages not shown", "stuck". On 2026-11-03 nothing matched;
      the closest were #658/#660 (the spinner itself, 2024), #486 (an Android timeout, closed), #680 (duplicates,
      a different symptom; see gotify.md section 6) and open PR #917 (a refactor of the same store that keeps the
      shared flag).
- [ ] Reproduce by hand in a browser, not only with the scripts: run Gotify (v3.1.1 release binary or master), log in,
      give one application a few messages, open DevTools, Network, add a custom throttling profile with 600 ms
      latency (or "Slow 4G"), reload on "All Messages" and click that application while the spinner shows. Then,
      on "All Messages", click Refresh twice quickly. Both should leave a spinner that never goes away. Answer the
      template's first question ("reproduced with the latest available release") from what you saw on v3.1.1; the
      session only reproduced it on master `dd06dc7` (the files involved are identical in v3.1.1).
- [ ] Apply `gotify.patch` to a fresh clone at `dd06dc7` (or rebase it onto current master), run
      `(cd ui && yarn build)` then `make test-js` or the single file
      (`cd ui && CI=true GOTIFY_EXE=<prod binary> yarn test --run src/tests/message.test.ts`): it must pass, and the new
      test must fail without the `MessagesStore.ts` change.
- [ ] Run `cd ui && yarn lint && yarn testformat && npx tsc`.
- [ ] Read the diff (4 changed lines in `MessagesStore.ts`, one test) and be ready to explain it in your own words.
- [ ] Make the disclosure paragraph true: you reproduced it, ran the tests and read the diff yourself.
- [ ] After a maintainer confirms the issue, comment that you will open the PR (CONTRIBUTING asks for this), then open
      it from your fork. Keep it to one commit; if the maintainer prefers another shape (for example a per-state
      field instead of the `Set`), take theirs.

---

## Issue

**Title:** WebUI: messages never load when an app is opened (or Refresh is clicked twice) while a message list is still loading

**Labels (the template adds):** a:bug

**Can the issue be reproduced with the latest available release? (y/n)**

y (reproduced on master `dd06dc7`; `ui/src/message/` is unchanged since v3.1.1) <!-- sender: replace after checking v3.1.1 yourself -->

**Which one is the environment gotify server is running in?**
- [ ] Docker
- [x] Linux machine
- [ ] Windows machine
<details><summary>Docker startup command or config file here (please mask sensitive information)</summary><br>

```
not Docker: `go run .` with GOTIFY_SERVER_PORT=8080, sqlite, default admin user
```
</details>

**Do you have an reverse proxy installed in front of gotify server? (Please select None if the problem can be reproduced without the presense of a reverse proxy)**
- [x] None
- [ ] Nginx
- [ ] Apache
- [ ] Caddy
<details><summary>Reverse proxy configuration (please mask sensitive information)</summary><br>

```

```
</details>

**On which client do you experience problems? (Select as many as you can see)**
- [x] WebUI
- [ ] gotify-cli
- [ ] Android Client <!-- (Please open the issue in gotify/android instead if it is only related to the android client) -->
- [ ] 3rd-party API call (Please include your code)


**What did you do?**

On a slow connection (Chrome DevTools throttling with 600 ms latency; "Slow 4G" works too):

1. Open the WebUI on "All Messages" (reload the page). While the message list still shows the spinner, click an
   application in the left navigation.
2. Or: on "All Messages", click Refresh twice quickly.

**What did you expect to see?**

The application's messages (or, after Refresh, the message list).

**What did you see instead? (Include screenshots, android logcat/request dumps if possible)**

The spinner, forever. No request for the application's messages is sent; the list only appears after navigating to
another view and back, or reloading. Measured with a Playwright script that delays only the response to
`GET /message?since=0` by 600 ms: 10 of 10 runs stuck for each case; 0 of 10 without the delay.

I think the cause is the single `loading` flag in `ui/src/message/MessagesStore.ts`, shared by every message list:

- `loadMore(appId)` returns early while any list is loading. `Messages.tsx` calls `loadMore` only from a
  `useEffect` on `appId`, so the load for the application opened during the "All Messages" request is skipped and
  never retried.
- `refreshByApp` calls `clearAll()` and then `loadMore`. A second click while the first refresh's request is in
  flight clears the state again, and its `loadMore` is skipped; the first request then completes into the state
  object that was just discarded.

Tracking the in-flight load per list (instead of one flag for all of them) fixes both. I'd like to submit the fix:
4 changed lines in `MessagesStore.ts` and an e2e test in `ui/src/tests/message.test.ts` that holds
`GET /message?since=0` and opens an application meanwhile (it fails without the change and passes with it).

I used Claude (Claude Code) to investigate this, write the fix and the test, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.

---

## Pull request (after the maintainer confirms and you have commented that you will send it)

**Title:** fix(ui): don't skip loading a message list while another one is loading

**Body:**

Fixes #<issue number>

`MessagesStore.loadMore` used one `loading` flag for all message lists. Opening an application while "All
Messages" was still loading (or clicking Refresh twice) skipped the new list's load, and nothing retried it, so the
view stayed on the spinner until you navigated away and back. The in-flight loads are now tracked per list state,
so concurrent loads of the same list are still prevented, and a load that completes into a state that `clearAll`
discarded no longer blocks the new state.

Test: `ui/src/tests/message.test.ts` "loads an app opened while all messages are still loading" holds
`GET /message?since=0` with request interception, opens the Backup application, releases the request and expects
Backup's message. It fails without the change (the wait for the message times out) and passes with it. I ran
`yarn build`, then the message tests three times each way, then the whole UI suite (everything passes except the
OIDC tests, which need Docker for Dex and could not start on my machine), `yarn lint`, `yarn testformat` and `tsc`.

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.

<!-- sender: if you ran the OIDC tests with Docker yourself, replace the sentence about them -->

---

## Commit message

```
fix(ui): don't skip loading a message list while another one is loading

loadMore used one loading flag for all message lists, so a list requested
while another one was loading (opening an app during the initial load of
all messages, or clicking refresh twice) was never loaded and kept showing
the spinner. Track the in-flight load per list state instead.

Investigated, written and tested with the help of Claude (Claude Code);
reviewed and tested by me.
```
