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

`run.mjs` and `dev.mjs` write a JSON file to `results/` and print a table. `results/after-narrowing.json` and
`results/dev-after-narrowing-6.json` are both sets run once more after the witness rule was narrowed for a router's
"submitting" marker (two more public suites, RESULTS.md section 29): the counts did not change. `.work/` (the built app, npm's copy of the
published packages, every run's race files and verdicts) is ignored by git. A full `run.mjs` at 6 seeds is 288 trials
a mode, about 17 minutes for the three modes on a 10-core laptop with 3 workers.

## A test that fails in some runs (`flaky.mjs`, RESULTS.md section 30)

`@genclass/playwright` compares the order of steps in a test's failing runs with the order in its passing runs
(`packages/playwright/src/order.ts`: a measured comparison with counts and shuffled outcomes, never a diagnosis).
`flaky.mjs` measures whether its first line agrees with what is known, and how often it says anything when the
outcomes say nothing:

```bash
node bench/pr-evidence/flaky.mjs dev --seeds 60 --batch 30      # development set: every tiny-desk test under each seed
node bench/pr-evidence/setup.mjs vue-vite && node bench/pr-evidence/setup.mjs plain-html
node bench/pr-evidence/flaky.mjs held --apps vue-vite,plain-html --scenarios a,h --data 1,2,3,4,5,6,7,8,9,10 --seeds 30
node bench/pr-evidence/flaky.mjs files <a directory of race files>   # a real suite's runs, each test's comparison in full
node bench/pr-evidence/flaky-null.mjs --out bench/pr-evidence/results/flaky-null.json   # tests with no order to find (no browser)
```

- **Development set:** a buggy tiny-desk test that fails under some seeds and passes under others is one the
  comparison can be asked about. Counted: whether its first line names the two requests that the `overwrote-newer`
  witness of a failing run names (the witness needs React's state; the comparison does not), and that a test which
  never fails gets no line. It was run twice: `results/flaky-dev.json` and `flaky-dev-60.json` (the same runs as one
  batch of 60), then `flaky-dev-rebased.json` and `flaky-dev-60-rebased.json` after the branch was rebased onto the
  narrowed witness rule. The counts are the same.
- **Held-out set:** compat's apps whose state the runtime does not see (Vue with Pinia, plain HTML; Solid's
  `createResource` never shows the bug), the two typeahead scenarios (a: the backend answers shorter prefixes later;
  h: it answers in order and only the delays reorder), compat's oracle as the outcome. With `--data`, a test is one
  data seed: the word typed and the backend's own delays are the same in every run of it and only GenClass's delays
  change, which is what "one test, run many times" means. Without `--data` the data changes with the seed, as in
  compat's matrix; that was the first measurement, and its result is kept (`results/flaky-held-data-varies.json`):
  with ten different words in one batch, whether a stale answer shows depends on the word, not only on the order.
  A hit is a first line that says a newer search's response came before an older one's.
- **Shuffled outcomes:** every batch is also compared `--rounds` times (20) with its outcomes dealt at random; the
  share of those that are called explained is the false-explanation rate, printed next to every hit rate.
- **Tests with no order to find** (`flaky-null.mjs`): shuffling the outcomes of real runs keeps each run as long as
  it was, so it cannot show a comparison that mistakes a run's length for an order. This script makes the runs
  itself, seeded: the outcome is a coin, and failing runs last longer than passing ones (an assertion waiting for its
  timeout), or stop early, or are as long. An independent review found the first version of the comparison calling
  a third of the "failing runs last longer" tests explained; `--order <module>` runs another build's comparison, which
  is how that number was made again with this generator (RESULTS.md section 30).

The comparison was chosen on the development set and on one real suite whose cause was already known by hand
(RESULTS.md section 30 says which part came from where). It was then changed once more, after an independent review:
every result file made before that was compared again from the same recorded race files (`--no-run`; a file keeps
when its runs were made and says `recompared`), and because the held-out results were known by then, one more
held-out sample was recorded afterwards under data seeds and delay seeds not used before
(`results/flaky-held-after-review-*.json`: `--data 11,...,20 --first-seed 31` and `--data 21,...,30 --first-seed 61`,
each with `--from` naming a directory of its own).

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
