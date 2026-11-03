# Navidrome: issue and pull request drafts (not sent)

Drafts for the race in [navidrome.md](navidrome.md), section 4. Navidrome wants an issue first, then a pull request
whose branch is named `<issue-title>/<issue-number>`, whose commit says `fix(ui): <description> - #<issue>` and is
signed off (`git commit --signoff`, DCO, no CLA), against `master`
([CONTRIBUTING.md](https://github.com/navidrome/navidrome/blob/master/CONTRIBUTING.md), read 2026-11-03). The issue
follows `.github/ISSUE_TEMPLATE/bug_report.yml` (blank issues are disabled), the pull request
`.github/pull_request_template.md`. Navidrome has no AI or LLM policy (CONTRIBUTING.md, both templates and the docs'
Developers section, read 2026-11-03), so the disclosure is the swarm's default paragraph, in "Anything else?" and in
"Additional Notes". `NNNN` below is the issue number the tracker assigns.

## Before sending (the sender, by hand)

- [ ] Search the tracker again for duplicates filed since 2026-11-03: issues and pull requests with "rating",
      "stars", "useRating", "rating reverts", "rating wrong". On 2026-11-03 none matched this bug (searches in
      navidrome.md section 8). Related but different: #6008 / #6009 (smart-playlist row duplicated after rating,
      merged 2026-08-21), #6411 / #6413 (server-side range check, merged 2026-11-02).
- [ ] Read open pull request **#5570** ("feat(ui): rate the current track from the player toolbar") and **#5561**
      (user ratings with average display): this session could not read their diffs (HTTP 403 from this
      environment). If either rewrites `ui/src/common/useRating.jsx`, rebase the patch onto it or mention the
      overlap in the pull request.
- [ ] Reproduce by hand on a current build (master, or the latest release): DevTools > Network, throttle to
      "Slow 3G" (or use the Playwright script below), rate a song that already has 1 star: 3 stars, then 5 stars a
      moment later. The row ends on 3 stars; a page reload shows 5.
- [ ] Run `node docs/adoption/hunts/navidrome/repro.mjs --runs 5` from the GenClass checkout against your local
      `make dev` (expect "5 of 5" stale before the patch, "0 of 5" after), or reproduce it any other way you trust.
- [ ] `git apply navidrome.patch` on a fresh master, then `cd ui && npm run test -- src/common/useRating.test.js`
      (the new test fails without the `useRating.jsx` hunk and passes with it), `npm run test`, `npm run lint`,
      `npm run check-formatting`.
- [ ] Read the whole diff (two files, 66 lines added, 13 removed) and be able to explain it.
- [ ] Open the issue; then the branch `star-rating-reverts/NNNN`, the commit
      `git commit --signoff -m "fix(ui): keep the last star rating when two ratings overlap - #NNNN"`, and the pull
      request with the same title.
- [ ] Make every sentence of the disclosure true (you reviewed the change and ran the tests and the manual check).
      If a maintainer asks about GenClass, answer in one line and link to the repository; never push it.

---

## Issue

**Title:** `[Bug]: Rating a song twice quickly can leave the old star rating on screen`

**I confirm that:**
- [x] I have searched the existing open AND closed issues to see if an issue already exists for the bug I've
      encountered
- [x] I'm using the latest version (your issue may have been fixed already)

**Version**

master at 7c1e68a (2026-11-03), built from sources (`make dev`)

**Current Behavior**

When a song is rated twice in quick succession (for example 3 stars, then 5 stars a moment later because the first
click was a mistake), the stars can end up showing the first rating while the server has stored the second. The
wrong rating stays on screen until the page is reloaded or the list is refetched.

It happens when the refresh the UI sends after the first rating (`GET /api/song/:id`) reaches the browser after the
refresh for the second rating: `useRating` calls `subsonic.setRating` and then `dataProvider.getOne` for each click,
and nothing orders the two `getOne` responses, so whichever lands last writes its record into the store. On a slow or
congested connection (mobile data, a remote server) the first refresh can be answered with rating 3 by the server
and still be delivered after the second refresh's rating 5.

**Expected Behavior**

The stars show the last rating the user chose (and the server stored), whatever order the responses arrive in.

**Steps To Reproduce**

1. Open Songs (or an album) and pick a song that already has a rating, e.g. 1 star (an unrated song shows the
   click position anyway, because its `Rating` starts uncontrolled: `rating` is omitted from the API response when
   0).
2. Slow down the network (DevTools > Network > "Slow 3G") or, more reliably, delay only the first
   `GET /api/song/<id>` response by about a second, e.g. with Playwright:
   ```js
   let n = 0
   await page.route('**/api/song/<id>', async (route) => {
     if (++n > 1) return route.fallback()
     const res = await route.fetch()        // the server answers now (rating 3)
     await new Promise((r) => setTimeout(r, 800))
     return route.fulfill({ response: res }) // ...the answer reaches the page late
   })
   ```
3. Click the 3rd star, and once that first refresh has been answered (in the script: after the server responded to
   `GET /api/song/<id>`), click the 5th star. Click somewhere else so the Rating loses focus (a focused MUI Rating
   paints its focused star, not its value).
4. The row shows 3 stars. `GET /api/song/<id>` (or a reload) says `rating: 5`.

With the delay above this happened in 5 of 5 runs; with the same clicks and no delay, in 0 of 5. With both clicks
back to back it happened in 2 of 5 runs (whether the first refresh is answered before the second rating reaches the
server is down to timing).

**Environment**

- OS: Ubuntu 24.04 (server and browser)
- Browser: Chromium (Playwright 1.63, headless)
- Client: Navidrome web UI

**How Navidrome is installed?**

Built from sources

**Configuration**

```toml
MusicFolder = "./music"
DataFolder = "./data"
LogLevel = "debug"
DevAutoCreateAdminPassword = "password"
```

**Relevant log output**

```
GET /rest/setRating?...&id=<id>&rating=3    200
GET /api/song/<id>                          200  (answered at once, delivered ~800 ms later)
GET /rest/setRating?...&id=<id>&rating=5    200
GET /api/song/<id>                          200  (delivered first)
```

The server side is fine: both ratings are stored in order and the final value is 5.

**Anything else?**

`ui/src/common/useRating.jsx`, `rate()`: each call does `setRating(id, val).then(refreshRating)` independently, and
`RatingField` does not disable the control while a rating is in flight (it ignores the hook's `loading`). I have a
small fix (ratings from one field are applied one after the other, so the last rating's refresh is always the last
to land) with a regression test in `useRating.test.js`, and I'm happy to open a PR.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

**Code of Conduct**
- [x] I agree to follow Navidrome's Code of Conduct

---

## Pull request

**Branch:** `star-rating-reverts/NNNN` · **Title:** `fix(ui): keep the last star rating when two ratings overlap - #NNNN`
· **Commit:** the same line, `git commit --signoff`

### Description

Rating a song twice in quick succession (3 stars, then 5) could leave the first rating on screen while the server
stored the second: each rating ran `setRating` and then `getOne` on its own, so when the first `getOne` response
arrived after the second one, it wrote the older record (rating 3) into the store last.

`useRating` now applies the ratings of one field one at a time: a new rating is chained after the previous rating's
refresh (`pendingRef`), so its `setRating` is sent only once that refresh has landed, and the last rating's refresh
is always the last write. `refreshRating` returns its promise so the chain can wait for it; `rate()` returns the
chain. Nothing else changes: the same requests are sent, the playlist-track branch still reloads the list, errors
still notify. Clicking several stars quickly now sends the ratings in order instead of in parallel, which also
keeps the server from receiving two overlapping `setRating` calls for the same song.

### Related Issues

Fixes #NNNN

### Type of Change
- [x] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Refactor
- [ ] Other (please describe):

### Checklist

- [x] My code follows the project’s coding style
- [x] I have tested the changes locally
- [ ] I have added or updated documentation as needed (no documentation covers this)
- [x] I have added tests that prove my fix/feature works (or explain why not)
- [x] All existing and new tests pass

### How to Test

- `cd ui && npm run test -- src/common/useRating.test.js`: the new test "keeps the last rating when a quick second
  rating overtakes the first refresh" lets the fake server store each rating, answers the refreshes newest first,
  and checks that the last refresh to land carries rating 5. It fails on master (`expected 3 to be 5`) and passes
  with the fix. Then `npm run test`, `npm run lint`, `npm run check-formatting`.
- By hand: in Songs, take a song rated 1 star, throttle the network (or delay the first `GET /api/song/<id>` by
  ~800 ms), click 3 stars and then 5 stars, click elsewhere: the row shows 5 stars (on master it shows 3).

### Screenshots / Demos (if applicable)

None (no visual change).

### Additional Notes

The fix is per `RatingField` instance (per hook): two different views rating the same song at the same moment are
still independent, as before. An alternative would be disabling the `Rating` while `loading`, like `LoveButton`
does, but that greys the stars out on every click; queueing keeps the control responsive.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.
