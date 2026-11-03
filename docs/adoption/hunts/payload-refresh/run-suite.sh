#!/bin/sh
# The refresh's run of the regression test in Payload's own e2e suite (test/fields), on SQLite, as done for
# docs/adoption/hunts/payload.md "Refresh (2026-11-03)". The hunt's payload-hunt/payload-suite/run.sh did the same on
# MongoDB; MongoDB's binary host (fastdl.mongodb.org) was not reachable from the refresh's container, so SQLite here.
#   PAYLOAD_DIR  a Payload checkout: main (Node 24.22.1, pnpm 11.28.6) or 3.x (Node 22.23.4), per its .tool-versions
#   PATCH        docs/adoption/hunts/payload-refresh-main.patch (main) or payload-refresh-3x.patch (3.x)
#   GRAVATAR_OFF set it where www.gravatar.com is unreachable: the admin's default avatar then fails to load, and
#                Payload's console-error check fails every test on it (no image loads in that case)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$PAYLOAD_DIR"
pnpm install --frozen-lockfile
NODE_OPTIONS="--max-old-space-size=6144" pnpm run build:core --concurrency=2
cp "$here/playwright.local.config.ts" test/                                    # one worker; CHROMIUM_PATH, GRAVATAR_OFF
export PORT=3100 PAYLOAD_DATABASE=sqlite
t() {
  node_modules/.bin/playwright test test/fields/collections/Relationship/e2e.spec.ts -c test/playwright.local.config.ts \
    --workers=1 --retries=0 "$@" || true
}
serve() { pnpm dev fields & dev=$!; until curl -s -o /dev/null --max-time 300 "http://localhost:3100/api/users?limit=1"; do sleep 5; done; }
git apply --include='test/*' "$PATCH"
serve
echo "== unfixed, the new test (expected: 3 failed)"; t --repeat-each=3 --grep "should not request related documents again"
echo "== unfixed, the whole spec"; t
kill $dev; sleep 3
git apply --exclude='test/*' "$PATCH"                                           # restart: the dev server compiles src
serve
echo "== fixed, the new test (expected: 3 passed)"; t --repeat-each=3 --grep "should not request related documents again"
echo "== fixed, the whole spec"; t
kill $dev
