# Mealie: draft texts for the owner to send

Everything here is a draft for the owner. Nothing was posted, forked, pushed or opened on mealie-recipes/mealie.
The evidence is in [mealie.md](mealie.md); the change is [mealie.patch](mealie.patch). It applies unchanged to
`mealie-next` at d4d6f7135 (2026-11-03, v3.30.0 plus 27 commits). The 2026-10-24 hunt used 4391aa8a5 (v3.29.0).
Facts last checked 2026-11-03: see mealie.md, "Refresh (2026-11-03)".

Before sending:

- Mealie's PR template makes the "AI / LLM Assistance" section required and says: "Failure to accurately disclose LLM
  usage may result in review delays or closure of your PR." Claude (Claude Code) wrote the fix, the tests and these
  texts. Read the change, run the tests and the manual check yourself, so that the disclosure paragraph is true.
  Rewrite any sentence that does not sound like you. (An earlier version of this file said Mealie closes AI-generated
  PRs without review. Mealie's repository says no such thing, as of 2026-11-03.)
- Search the tracker again for anything filed since 2026-11-03: `stale search results`, `search results out of order`,
  `search race`, `useRecipeSearch`. Also check that no open PR changes
  `frontend/app/composables/recipes/use-recipe-search.ts`. On 2026-11-03 there was nothing (mealie.md, Refresh).
- Fork from `mealie-next`. The PR title is in Conventional Commits form. No CLA; contributions are under the AGPL.
  CONTRIBUTING (`docs/docs/contributors/developers-guide/code-contributions.md`) asks for a draft PR first, then
  ready for review once the GitHub checks pass. Mealie's `AGENTS.md` says a draft is optional.
- Checks: `AGENTS.md` asks for `task py:check` and `task ui:check` before a PR. Both ran here on 2026-11-03, with the
  patch applied (mealie.md, Refresh). Run `task ui:check` once yourself. On a fresh clone, run
  `pnpm exec nuxi prepare` in `frontend/` first (or start `task ui` once), or vitest fails with "Failed to load
  tsconfig '.nuxt/tsconfig.json'". `task py:check` needs NLTK's tagger data, or 18 ingredient-parser tests fail:
  `NLTK_DATA=~/nltk_data bash docker/setup_nltk_data.sh`, then `NLTK_DATA=~/nltk_data task py:check`.
- Reproduce by hand (2 minutes, no tools). Start a local dev server (`task py`, `task ui`) and create a few recipes
  named "Chicken ..." and "Chickpea ...". Open `/g/home` and paste the snippet below into the browser console. It
  delays sending any search for exactly "chi" by 2 s. Press `/`, type `chi`, wait about a second, then type `cken`.
  Without the patch, the dialog ends up listing the Chickpea recipes. With the patch, it lists only the Chicken
  ones. Reload the page to remove the snippet.

  ```js
  (() => {
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) { this._url = String(url); return open.call(this, method, url, ...rest); };
    XMLHttpRequest.prototype.send = function (body) {
      if (/[?&]search=chi&/.test(this._url)) { setTimeout(() => send.call(this, body), 2000); return; }
      return send.call(this, body);
    };
  })();
  ```

## 1. Issue #2808: do not comment there

The review that picked Mealie named https://github.com/mealie-recipes/mealie/issues/2808 as related. It is not. #2808
("Multiple patch requests to recipe will duplicate ingredients and steps", open, `bug: confirmed`) is a backend race.
Two PATCH requests to the same recipe in flight together (for example Save clicked twice on a slow server) duplicate
its ingredients and steps. A maintainer called it a database-level race (2024-06-27). An open PR is linked to it:
https://github.com/mealie-recipes/mealie/pull/8754 ("fix: serialize concurrent recipe updates so ingredients and
steps aren't duplicated"). A comment about the search composable would be off topic there and would read as
promotion.

Checked again 2026-11-03: #2808 is still open, last updated 2026-09-30. #8754 is still open, last updated 2026-10-20.
The decision stands. The search bug has no issue of its own. A search of open and closed issues and PRs for stale or
out-of-order search results found nothing, so the draft below is a new issue instead. Open it only if you want an
issue before the PR. Mealie's template accepts a PR without one.

## 2. Draft issue (optional)

Template: "Bug Report" (`.github/ISSUE_TEMPLATE/bug-report.yaml`).

**Title:** `[BUG] - Search can show the results of an earlier search term`

**First Check:** tick the five required boxes once they are true for you: not a feature request, a descriptive title,
searched GitHub, searched the docs, read the docs. Leave "This issue can be replicated on the demo site" unticked. It
was not tried there, and this work never drives a public instance.

**What is the issue you are experiencing?**

The search dialog (and the recipe link field in the ingredient editor) can end up showing the results of an earlier
search. If you pause partway through typing, a search goes out for the partial term. If that response comes back
after the one for the full term, it replaces the newer results and stays there. `useRecipeSearch`
(`frontend/app/composables/recipes/use-recipe-search.ts`) keeps whichever response arrives last.

**Steps to Reproduce**

1. Have a few recipes whose names share a prefix (for example "Chicken ..." and "Chickpea ...").
2. Open the search dialog with `/`, type `chi`, wait about a second, then type `cken`.
3. If the `chi` response arrives after the `chicken` one (a slow server or connection), the dialog lists Chickpea
   recipes for "chicken". To force the order locally, paste this into the browser console before step 2. It delays
   sending the `chi` search by 2 s:

   ```js
   (() => {
     const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
     XMLHttpRequest.prototype.open = function (method, url, ...rest) { this._url = String(url); return open.call(this, method, url, ...rest); };
     XMLHttpRequest.prototype.send = function (body) {
       if (/[?&]search=chi&/.test(this._url)) { setTimeout(() => send.call(this, body), 2000); return; }
       return send.call(this, body);
     };
   })();
   ```

**Please provide relevant logs**

None. Nothing is logged in the browser console or by the backend; both requests succeed (200), and the older one
simply arrives last.

**Mealie Version**

`mealie-next` at d4d6f7135 (v3.30.0), local dev server (`task py`, `task ui`), SQLite.

**Deployment:** Other (please specify below)

**Additional Deployment Details**

Local development setup from the developer docs, not Docker. The code path is the same in the Docker image.

**AI assistance:** I used Claude (Claude Code) to investigate this and draft this report; I reproduced it by hand
myself. The race was found with GenClass, a tool I work on, which replays the same typing with the server's responses
delivered in different orders.

## 3. Draft PR

**Title:** `fix: ignore stale recipe search responses`

**Body:**

```markdown
## What this PR does / why we need it:

`useRecipeSearch` writes whichever search response arrives last. If an earlier search is slower than a later one
(type "chi", pause, finish "chicken"), the "chi" results replace the "chicken" ones and stay on screen, and `loading`
is cleared by whichever response comes back first. This affects the header search dialog and the recipe link field in
the ingredient editor.

- `composables/recipes/use-recipe-search.ts`: count searches and ignore a response that is not for the latest one, so
  it can no longer overwrite newer results or clear `loading`.
- `composables/recipes/__tests__/use-recipe-search.test.ts`: two tests that resolve two searches out of order.

## Which issue(s) this PR fixes:

None filed that I could find. Happy to open one first if you prefer.

## Testing

- The new tests fail on `mealie-next` and pass with this change. `task ui:check` (eslint with `--max-warnings=0`,
  and the full vitest suite: 58 files, 629 tests) and `task py:check` pass.
- On a local dev server with 300 recipes, I delayed the first search ("chi") by 2 s, typed "chi", paused, and typed
  "cken". Before the change, the dialog showed the 20 "chi" results (with Chickpea ...) under "chicken". After it,
  the dialog showed the 15 "chicken" results, though the "chi" response still arrived last.

## AI / LLM Assistance

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same typing with the server's responses delivered in different orders.
```
