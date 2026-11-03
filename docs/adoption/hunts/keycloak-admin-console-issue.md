# Keycloak admin console: drafts for the issue and the pull request

Drafts for [keycloak-admin-console.md](keycloak-admin-console.md), written 2026-11-03. Nothing here has been sent. Keycloak
wants an issue from its templates before every pull request (CONTRIBUTING.md, "Each PR, no matter how small, should
have a GitHub issue"), so there are two texts, in that order. The fix is small and touches no API endpoint, so no
GitHub Discussion first (CONTRIBUTING.md: "For minor changes you can skip this part"); the sender may still choose to
open one because the fix adds a member to the exported `RealmContext` type (see "Anything else?").

## Before sending (the sender, by hand)

- [ ] Search the tracker again, with the words "realm settings" + "revert", "reverted", "overwritten", "lost",
      "display name", "two tabs", "stale", label `area/admin/ui`, open and closed, since 2026-11-03. The session's
      searches (in the target brief, 2026-11-03) found nothing on this bug.
- [ ] Reproduce by hand once, without any tool: start the nightly (`cd js/apps/keycloak-server && pnpm start`), create
      a realm with a display name, open Realm settings > General in Chrome with DevTools > Network throttling set to a
      custom profile of 2,000 ms latency, change the display name, Save, and within a second of the green notification
      click the Login tab and switch "User registration" on. Reload: the display name is the old one. (The session
      measured this with Chromium's own latency emulation: 3 of 3 lost at 2,000 ms with a 0.8 s pause; 0 of 3 with a
      3 s pause, and 0 of 3 at 300 or 600 ms of latency. See the report, section 4.2.)
- [ ] Apply `keycloak-admin-console.patch` on a fresh clone of `main` (it was made against
      `15a9bbb8ae20c141f947ff656ef9d7b3b521471e`), run the new test against the unfixed console and see it fail,
      then against the fixed one and see it pass (commands in the report, section 4.5).
- [ ] Run `pnpm lint` in `js/apps/admin-ui` and read the whole diff; be able to explain why `upConfig` is left out of
      the representation put into the context and why `id` is set back to the realm's id (report, section 4.4).
- [ ] File the issue (fields below, as `### <label>` headers per the repository's AGENTS.md), note its number, put it
      in the commit message's last line, squash to one commit, `git commit --signoff`, rebase on `main`, open the PR.
- [ ] As a new contributor: at most 2 open PRs at a time; answer review within 2 weeks (CONTRIBUTING.md).

---

## 1. Issue (template: Bug Report, `.github/ISSUE_TEMPLATE/bug.yml`)

**Title:** Realm settings: saving another tab right after a save reverts the first save

### Before reporting an issue

- [x] I have read and understood the above terms for submitting issues, and I understand that my issue may be closed without action if I do not follow them.

### Area

admin/ui

### Describe the bug

After a save on one realm settings tab, the console reloads the realm (`refresh()` in `RealmSettingsTabs.tsx`
`save`, then `GET /admin/realms/{realm}` in `RealmContext`). Until that reload returns, the other tabs still build
their saves on the realm as it was before the first save. A save on another tab in that window sends the older values
of every field, and the server stores them: the first save is reverted, although both saves showed a success
notification.

Example: General tab, change the display name and Save ("Realm successfully updated"); then, before the reload of the
realm has returned, the Login tab, switch "User registration" on ("User registration changed successfully").
`LoginTab.tsx` sends `Object.assign(realm, switches)`, the whole realm from the context, so
`PUT /admin/realms/{realm}` carries the old display name and the server puts it back. The tabs that save through
`RealmSettingsTabs` `save` (`{ ...realm, ...r }`, and the shared form that is reseeded from the context's realm) look
to have the same window; I only tested General followed by Login.

On localhost the reload takes milliseconds, so it takes a slow connection to hit it by hand: with 2,000 ms of
latency (Chromium's network emulation) and the Login tab clicked 0.8 s after the notification, the display name was
lost in 3 of 3 attempts; with 3 s between the two, or with 300 ms or 600 ms of latency, in 0 of 3.

### Version

nightly 999.0.0-SNAPSHOT (asset of 2026-11-03), source at 15a9bbb8ae20c141f947ff656ef9d7b3b521471e. The same code is
in 26.8.1 (`RealmSettingsTabs.tsx`, `LoginTab.tsx`, `RealmContext.tsx`); not run there.

### Regression

- [ ] The issue is a regression

### Expected behavior

Both saves are kept: the display name from the General tab and "User registration" on.

### Actual behavior

"User registration" is on, the display name is back to its previous value (in the console after a reload and in
`GET /admin/realms/{realm}`), and both saves showed a success notification.

### How to Reproduce?

1. Start the nightly (`js/apps/keycloak-server`, `pnpm start`) and create a realm with a display name, e.g. "Before".
2. Open Realm settings > General for that realm. In DevTools > Network, add a throttling profile with 2,000 ms of
   latency and select it (or hold `GET /admin/realms/{realm}` with any proxy).
3. Change Display name to "After", click Save, and as soon as "Realm successfully updated" appears, click the Login
   tab and switch "User registration" on.
4. Turn throttling off and reload: Display name is "Before"; `GET /admin/realms/{realm}` has
   `"displayName": "Before"` and `"registrationAllowed": true`.

The pull request adds a Playwright test that holds the reload of the realm until the Login tab has saved, which fails
on `main` the same way.

### Anything else?

Cause, as far as I can tell: `RealmSettingsTabs` `save` and `LoginTab` `updateSwitchValue` both merge their changes
into `realmRepresentation` from `RealmContext`, which only changes when the refetch started by `refresh()` returns.
A fix that keeps the change in the admin UI: after a successful save, put the saved representation into the context
right away (a `setRealmRepresentation` on the context), so later saves build on it until the refetch lands. That adds
a member to the exported `RealmContextType`. The window between clicking Save and the save's own response is not
closed by this (a second save sent before the first one's response still carries the older values); disabling the
other tabs' saves while one is in flight would close it, at a larger cost.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## 2. Pull request (template: `docs/pull_request_template.md` is a comment only; CONTRIBUTING.md's checklist)

**Title:** Keep a realm settings save when another tab saves before the realm is reloaded

**Commit message** (one commit, signed off, last line the issue):

```
Keep a realm settings save when another tab saves before the realm is reloaded

After a successful save, RealmSettingsTabs puts the saved representation into
the realm context right away, so a save on another tab before the refetch
returns no longer sends the values from before the first save.

Closes #NNNNN

Signed-off-by: <name> <email>
```

**Body:**

Closes #NNNNN

After a save on a realm settings tab the console refetches the realm, and until that returns the other tabs build
their saves on the realm from before the save, so a quick save on another tab (for example a Login tab switch right
after a General tab save) reverts the first one on the server.

This keeps the saved representation in the realm context as soon as the save succeeds (a new
`setRealmRepresentation` on `RealmContext`, used by `RealmSettingsTabs` `save`); the refetch still runs and replaces it
with the server's copy. Two fields differ from what the save sent: `upConfig` is left out, because it is saved by the
`ui-ext` endpoint alongside the realm and is not part of the realm representation (keeping it would make a later save
from another tab send this save's user profile configuration again), and `id` stays the realm's id, because the save
sends the realm name as `id` and a few forms read `realmRepresentation.id` as a component's `parentId`.

Test: `test/realm-settings/general.spec.ts`, "Realm settings saves on two tabs": it holds the reload of the realm
until the Login tab has saved, then reads the realm through the admin client. It fails on `main` (the server has the
old display name) and passes with the change; `general.spec.ts` and `login.spec.ts` pass in Chromium.

- [x] Includes functional/integration test
- [ ] Includes documentation: none needed, no user-visible change besides the fix

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.
