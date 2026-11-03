# Reproduction: list view re-requests pending relationship documents

Minimal reproduction for the Payload issue drafted in `../../payload-issue.md`. It is the `blank` template from
`create-payload-app@3.92.1` (SQLite) with two collections added and nothing else:

- `categories` (`name`), whose `beforeOperation` hook delays every read by 1 s, so the list view's `categories` batch
  answers about 1 s after its `users` batch;
- `posts` (`title`, `category` → `categories`, `author` → `users`), list columns title, category, author;
- an `onInit` seed: one user (`dev@payloadcms.com` / `test`), 10 categories, 10 posts.

The three changed files are in `src/` here; `repro.patch` is the same change as a diff against the template's own
initial commit.

## Make the repository (the sender, by hand)

```bash
npx create-payload-app@3.92.1 -n payload-relationship-batch-repro -t blank --db sqlite --db-connection-string "file:./payload.db" --no-agent --use-npm
```

```bash
cd payload-relationship-batch-repro && git apply /path/to/GenClass-lib/docs/adoption/hunts/payload-refresh/repro/repro.patch
```

Copy this README in as the repository's README (from the heading "Steps" below), commit, and push it to a public
repository under the sender's own account: the issue template requires its link.

## Steps

1. `npm install`, then `npm run dev` (the first start seeds the database).
2. Open http://localhost:3000/admin, log in as `dev@payloadcms.com` / `test`.
3. Open DevTools, Network panel, filter on `limit=250`.
4. Open http://localhost:3000/admin/collections/posts.

Expected: one `GET /api/categories?...where[id][in]=1,...,10` and one `GET /api/users?...where[id][in]=1`.

Actual (payload 3.92.1): `/api/categories` is requested a second time with the same ten ids, 112 to 211 ms after the
first in nine runs, once `/api/users` has answered and while the first `categories` request is still pending.

Remove the `beforeOperation` hook in `src/collections/Categories.ts` and the second request does not happen: the two
batches then land within the provider's 100 ms debounce of each other. A uniform throttle (DevTools "Slow 4G") delays
both batches alike and does not show it either.
