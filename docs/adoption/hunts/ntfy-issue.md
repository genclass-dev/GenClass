# Draft issue and pull request text for ntfy (binwiederhier/ntfy)

Drafts only: nothing here has been sent. ntfy's `docs/ai-policy.md` asks contributors to "write them yourself, or at
least read and edit any AI-generated text before posting it. Keep it concise", and that the maintainer is not "the first
human to read your code". **The sender must rewrite both texts below in their own words** after doing the checklist at
the end; they are a starting point with the facts in them, not text to paste. The maintainer signs his own
AI-assisted replies "Phil's Robot"; a one-line disclosure in that spirit fits his idiom.

The full report, with every number's command, is [ntfy.md](ntfy.md); the patch is [ntfy.patch](ntfy.patch) (against
`8ed8684`, 2026-11-02).

---

## Issue

Template: `.github/ISSUE_TEMPLATE/1_bug_report.md` (label `🪲 bug`; the maintainer may add `web-app`).

**Title:** Web app: account sync can undo a change made while it runs (reserved topic loses its messages, unsubscribed topic comes back)

:lady_beetle: **Describe the bug**

When you're logged in, every account change makes the server send a `sync` event, and the web app answers each one with
`GET /v1/account` and applies the result locally (`AccountApi.sync()`). Nothing checks whether that account was fetched
before a change the app made in the meantime, so a sync can undo it:

- Subscribe to a topic with "Reserve topic" on, while the account already has another subscription. The reservation's
  sync event arrives before the subscription exists on the server, so that sync removes the topic again, with the
  messages the app just loaded for it; the next sync re-adds the topic. The topic then shows "You haven't received any
  notifications for this topic yet." until a reload or the next poll. On a local server this happened every time I
  tried (6 of 6).
- With a slower connection the same thing happens to other changes: subscribing to two topics in a row can drop the
  second one, an unsubscribed topic comes back, a renamed topic gets its old name back, a notification setting flips
  back. I reproduced each one by holding one `GET /v1/account` response until the next one was answered.

A second, smaller problem in the same function: when the account has no subscriptions, the server leaves
`subscriptions` out of the JSON (`omitempty`) and `sync()` skips the list (`if (account.subscriptions)`). So if you
unsubscribe from your last topic in one browser, other browsers keep showing it, even after a reload.

Steps (reserved topic):
1. Log in on a server with reservations, as a user whose tier allows them; subscribe to any topic.
2. Publish two messages to another topic: `curl -d hi localhost/mytopic` (twice).
3. "Subscribe to topic", enter `mytopic`, turn on "Reserve topic", Subscribe.
4. The topic opens empty; reload and both messages are there.

Steps (last topic): log in in two browsers, subscribe to one topic, unsubscribe in browser 1; browser 2 keeps it.

:computer: **Components impacted**

Web app (`web/src/app/AccountApi.js`), current `main`.

:bulb: **Screenshots and/or logs**

Console of the reserved-topic case, in order: `[SubscribeDialog] Reserving topic …`, `[ConnectionListener] Triggering
account sync`, `[AccountApi] Fetching user account`, `[AccountApi] Adding user subscription …`, `[ConnectionListener]
Triggering account sync`, `[Poller] Polling …/mytopic`, `[SubscriptionManager] Syncing subscriptions from remote
[Object]` (the account without the new topic), `[SubscriptionManager] Syncing subscriptions from remote [Object,
Object]`, `[Poller] Adding 2 notification(s) …`.

:crystal_ball: **Additional context**

`hooks.js` already mentions a related "Race condition: sometimes the subscription is already unsubscribed from account
sync before the message is handled". I have a fix with unit and Playwright tests and will open a PR.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this text; I
reproduced the bug by hand, read the change and ran the tests myself. The race was first seen with GenClass, a tool I
work on, which replays the same steps with the server's responses delivered in different orders.

---

## Pull request

No PR template in the repository. Base: `main`. One commit, ntfy's "Web app: …" subject style.

**Title:** Web app: don't let an account sync undo a change made while it was fetching

**Body:**

Fixes #<issue>.

`AccountApi.sync()` applies whatever `GET /v1/account` returns. If the account was changed locally while that request
was in flight, the response may not have the change yet, and applying it undoes it (removes a topic that was just
subscribed to, together with its notifications, re-adds one that was just unsubscribed from, restores an old display
name or setting).

- `AccountApi` counts local account changes (`updateSettings`, `add`/`update`/`deleteSubscription`,
  `upsert`/`deleteReservation`); `sync()` skips applying an account whose fetch overlapped one. The change makes the
  server send its own sync event, and that sync applies it.
- An absent `subscriptions` list (the server omits an empty one) is applied as empty, so unsubscribing from the last
  topic also removes it in other browsers.

Tests: two unit tests in `AccountApi.test.js`; Playwright: "reserving a topic while subscribing keeps its messages"
(reservations.spec.js), "a slow account sync doesn't undo a newer settings change" (settings.spec.js), and one more
assertion in "subscriptions and display names sync to the account" (the second browser drops the topic). They fail
without the change and pass with it; `npm test`, `make web-e2e`, `npm run lint` and `npm run format:check` pass.

One gap I left on purpose: the UI writes IndexedDB before it calls `AccountApi` (e.g. `subscriptionManager.remove()`
then `deleteSubscription()`), so a sync landing in those few milliseconds still applies; it can flicker a topic, and
the next sync fixes the data. Closing it would mean counting the change at the five call sites before the local write.
Happy to do that here or separately if you prefer.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## Before sending (for the sender)

- [ ] Search the tracker again for duplicates since 2026-11-03 (searched then, issues and PRs: "unsubscribe other
      browser", "subscription reappears", "unsubscribe sync", "reserve messages", "account sync subscriptions",
      "subscriptions not synced", "unsubscribed topic still", "web app sync race", "AccountApi", "syncFromRemote":
      nothing on the web app; #1294 and #1875 are the mobile apps). Also check that `main` has not changed
      `AccountApi.sync()` since `8ed8684` (`git log -p 8ed8684..origin/main -- web/src/app/AccountApi.js`).
- [ ] Reproduce the reserved-topic case by hand in a browser (steps above), on a local server built from `main`, and the
      last-topic case with two browsers.
- [ ] Read the diff line by line until you can explain each line, including why skipping a sync loses nothing (the
      change's own sync event) and what the remaining gap is.
- [ ] Apply the patch (`git am docs/adoption/hunts/ntfy.patch`, then set yourself as the author), run `cd web && npm
      test`, `npm run lint`, `npm run format:check`, and `make web-e2e` (or the three specs:
      `npx playwright test reservations.spec.js settings.spec.js subscribe.spec.js`). Check that the three new checks fail
      when you revert `AccountApi.js` alone.
- [ ] Rewrite the issue and the PR description in your own words, short; keep the AI-assistance paragraph true for what
      you did. File the issue first, then the PR with `Fixes #<issue>`.
- [ ] If asked whether to split it: the `?? []` change (last topic) is independent and can be its own PR.
- [ ] Optional, the maintainer's call: a line in `docs/releases.md` under the next release's bug fixes.
