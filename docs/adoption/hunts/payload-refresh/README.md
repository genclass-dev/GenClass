# The Payload refresh's files (2026-11-03)

What the refresh in [../payload.md](../payload.md) ("Refresh (2026-11-03)") ran, next to the hunt's own harness in
[../payload-hunt/](../payload-hunt/). Nothing here imports GenClass: the refresh re-ran the fix, the test and the
reproduction, not the explore sessions.

| file | role |
|---|---|
| `../payload-refresh-main.patch` | the fix and the test against payload `main` at `c2a3239` (4.0.0-beta.6), for the PR |
| `../payload-refresh-3x.patch` | the same change against `3.x` at `49b3c0b` (3.92.1), for a backport |
| `repro/` | the public reproduction the issue form requires: the three files changed in `create-payload-app@3.92.1 -t blank --db sqlite` (`src/payload.config.ts` with an `onInit` seed, `src/collections/Categories.ts` with a 1 s read delay, `src/collections/Posts.ts`), `repro.patch` (the same as a diff against the template's initial commit) and the repository's README; the sender makes and pushes it |
| `login.mjs` | logs in to the reproduction app and saves `storageState.json` for `../payload-hunt/dup-requests.spec.mjs` and `throttle-control.mjs` |
| `throttle-control.mjs` | the controls: the list's batch requests as served (no route) and under Chromium's "Slow 4G" throttling |
| `run-suite.sh` | the regression test and the relationship spec in Payload's own suite (`test/fields`, SQLite), unfixed then fixed |
| `playwright.local.config.ts` | the hunt's local Playwright config plus `GRAVATAR_OFF` (no image loads where www.gravatar.com is unreachable) |
| `out/` | the logs, small: the reproduction on 3.92.1 unfixed and fixed, the test three times each way on `main`, the relationship spec on each code, the controls |

Commands, as run (Node 22.23.4 for the reproduction app, Node 24.22.1 for Payload `main`):

```bash
# the reproduction app (port 3000)
npx -y create-payload-app@3.92.1 -n app -t blank --db sqlite --db-connection-string "file:./payload.db" --no-agent --use-npm --no-deps
cd app && git apply <this folder>/repro/repro.patch && npm install && npm run dev
# a harness folder whose node_modules resolves @playwright/test (here: a symlink to the app's node_modules)
HUNT_OUT=$PWD/out node login.mjs
HUNT_OUT=$PWD/out DELAY_MS=0 node dup-requests.spec.mjs      # the hook's 1 s delay alone; exit 1 on a repeat
HUNT_OUT=$PWD/out DELAY_MS=1500 node dup-requests.spec.mjs   # plus the hunt's 1.5 s route delay
PAYLOAD_APP=<app> node ../payload-hunt/apply-to-bundle.mjs   # the fix in the app's @payloadcms/ui client bundle (--revert)
HUNT_OUT=$PWD/out [THROTTLE=1] node throttle-control.mjs     # with the hook removed from Categories.ts
# Payload's suite
git clone https://github.com/payloadcms/payload && cd payload        # main at c2a3239
PAYLOAD_DIR=$PWD PATCH=<..>/payload-refresh-main.patch GRAVATAR_OFF=1 sh <this folder>/run-suite.sh
PAYLOAD_DIR=$PWD node ../payload-hunt/react-compiler-check.cjs <unfixed index.tsx> <fixed index.tsx>
```
