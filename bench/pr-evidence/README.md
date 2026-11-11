# bench/pr-evidence: what the pull-request check has to go on

genclass-dev[bot] reads race files that `genclass-playwright-run` writes while a repository's own Playwright suite
runs. This bench measures that path, the one a repository gets from the app's one workflow file, with no change to a
test: how often a race that is there is flagged, how often correct code is flagged, and what the run costs. Numbers:
[docs/runtime/RESULTS.md](../../docs/runtime/RESULTS.md), section 29.

Nothing here feeds a situation, the model, training data or a decision of the runtime. Local, headless Chromium.

## Two sets, kept apart

| | what | used for |
|---|---|---|
| **Development set** | `tiny-desk/`: a small React 19 + Vite app written for a review of the app on 2026-11-11, before its author had read the runtime's witness code. Four planted races (search, checkout, profile autosave, detail panel), the fixed version of each, a notifications poll with no ordering guard, and a button meant to send the same request twice. Ten plain Playwright tests that all pass at normal speed. | Choosing changes to `@genclass/playwright`. `dev.mjs` runs it. |
| **Held-out set** | compat's React + Vite app (`compat/apps/react-vite`): six data layers (useState, TanStack Query, Zustand twice, Redux Toolkit, Apollo), compat's eight scenarios (a and b written the naive way, c to h correct), its seeded mock backend and its oracle, which reads only the DOM and the server's state. | Measuring. `run.mjs` runs it. |

compat's apps are not written for GenClass and are never changed for it (`compat/README.md`). This bench builds a copy
of the app with the one GenClass import taken out (`setup.mjs`), so the runtime comes from the Playwright side alone,
as for a repository that only added the workflow file.

Where each change measured in section 29 came from, so the held-out numbers can be read for what they are:

- the end-of-test wait and the mirrored seeds: found and sized on the development set;
- identical reads and same-path writes keeping their order: derived from how holding a request differs from delaying
  an answer, after the development set's poll was recorded as `16 → 17` "overwritten";
- the narrower `overwrote-newer` (a timer of the same action is not newer data), the default filter on the page's own
  host at any port, and ids written as `:id` in a request's key: found on two public suites run by hand;
- chaos holding nothing while the page is offline: seen on the held-out set itself (scenario e), so e's number after
  the change is not an independent test of it.

What both sets show and nothing here fits away: an intended repeat of one request is flagged.

## Run

```bash
npm run build -w @genclass/runtime && npm run build -w @genclass/playwright
node bench/pr-evidence/setup.mjs                         # once: builds the held-out app (npm install, vite build)
node bench/pr-evidence/run.mjs --seeds 6                 # held-out: plain, GenClass without delays, GenClass with delays
node bench/pr-evidence/dev.mjs --seeds 10                # development set: the published packages against each change
node bench/pr-evidence/dev.mjs --seeds 40 --grep detail --settings wait,wait+mirror
```

`run.mjs` and `dev.mjs` write a JSON file to `results/` and print a table. `.work/` (the built app, npm's copy of the
published packages, every run's race files and verdicts) is ignored by git. A full `run.mjs` at 6 seeds is 288 trials
a mode, about 17 minutes for the three modes on a 10-core laptop with 3 workers.

## What a trial is (held-out set)

One test per data layer and scenario (`specs/compat.spec.mjs`), repeated once per seed. As in `compat/run.mjs`: the
mock backend is reset with the seed and the scenario, the scenario's `drive` gives trusted input, the page settles
(nothing in flight on the backend and the DOM unchanged for 900 ms), and the scenario's `oracle` says whether a user
would see a bug. The test never fails on that verdict: it writes it to a file, and `run.mjs` joins it, by layer,
scenario and seed, with the signatures in that test's race file.

- **A flag** is a race file with at least one signature.
- On scenarios **a** and **b** (bugs), flags are counted against the trials in which the oracle saw the bug.
- On scenarios **c to h** (correct apps), every flag is a flag on correct code. The count is reported per scenario and
  signature, because one cause (scenario f, a counter whose "plus" is meant to be pressed several times) accounts for
  most of them.

## Limits

- One app per set, React only, Chromium only, one machine. The held-out backend makes its own delays (scenario a's
  shorter prefixes answer later by construction), so its bug scenarios show the bug in nearly every trial: it measures
  whether a race that happened was recorded, not how often delays make one happen. The development set measures that.
- The data layers whose state the runtime cannot see (a query cache, Apollo's cache) can only get
  `identical-in-flight`; the table says which layers those are.
- The wall-clock comparison is one run on a laptop that was doing other work.
