# Explore bench: races found next to false reports

Measures `genclass_explore` (docs/runtime/AGENT.md section 5) the way an agent uses it: two fifo baselines and
seeded reorderings of the same user steps, compared by the MCP server. Every number goes to
[RESULTS.md](../../docs/runtime/RESULTS.md) (sections 22 and "explore's verdict on real apps") with its false-report rate
next to it.

## What is here

| file | what |
|---|---|
| `summarise.mjs` | scores a directory of explore sessions: per reordered run, whether explore reported it as a race, against a DOM oracle the harness recorded for the same load (a run "differs" when its oracle equals neither baseline's). With `--old <packages/mcp/dist of another checkout>` it scores the older comparison on the same recorded runs. |
| `apps.mjs` | the two small apps below in headless Chromium with the real runtime and MCP server; writes sessions `summarise.mjs` reads |
| `planted.mjs` | small pages made of what the 2026-11-04 hunts and the review of the fix met (ages, read-only POSTs, double submits, a lost POST, generated field names, bugs that need only a slow response, a bare number beside a version, a new path per load, an optional click, wrong values that read like a time, clocks moving, a random tip, a save queue), each with a correct variant and, where it has one, a planted bug; scores each session itself against each load's own check, with `--old` the older comparison on the same runs |
| `stored.mjs` | rescoring reports a hunt kept only as text: parses the listed differences back into runs and gives them to `compareRuns`; its header says what the text cannot show. `--raw <state.json>` compares a bridge's recorded runs directly |
| `apps/` | a search page on Redux Toolkit Query and one on TanStack Query (`src/rtk.jsx`, `src/tanstack.jsx`), each with a planted stale race (`?bug`) and a correct variant; installed on its own (`npm install` in `apps/`, not a workspace) |

The Strapi sessions come from the hunt harness on the `(an internal branch)` branch
(`(internal notes)/strapi/hunt.mjs`, its setup in `(internal notes)/strapi.md` section 1), run once per
scenario and latency with its own bridge state directory (`HUNT_STATE=state-<scenario>-<slow_ms>`), so that every
session's recorded runs stay available to `summarise.mjs`.

## Run

```bash
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
(cd bench/explore/apps && npm install)
node bench/explore/apps.mjs /tmp/explore-apps --slow 300,600,900
node bench/explore/summarise.mjs /tmp/explore-apps

# the same with the comparison of another checkout (a git worktree of main, built)
node bench/explore/apps.mjs /tmp/explore-apps-before --rt ../before/packages/runtime/dist --mcp ../before/packages/mcp/dist --slow 300,600,900
node bench/explore/summarise.mjs /tmp/explore-apps-before --old ../before/packages/mcp/dist

# the pages made of what the hunts met; shards run side by side, each with its own browser, and write into one directory
node bench/explore/planted.mjs /tmp/planted --shard 0/2 --port 41700 &
node bench/explore/planted.mjs /tmp/planted --shard 1/2 --port 41700 &
wait
node bench/explore/planted.mjs /tmp/planted --score --old ../before/packages/mcp/dist

# reports a hunt kept as text
node bench/explore/stored.mjs <hunt results directory>
```

Not in CI: it needs Chromium, the apps' dependencies and (for Strapi) a running Strapi.

## Caveats

The two apps were written by the author of the comparison rules they measure, so they show the mechanism on the
two libraries' documented patterns, not an independent recall figure. The DOM oracle is the harness's own check of
what the page shows (secondary): for the Strapi double Save and Publish scenario it leaves out the notifications (toasts
that disappear after a few seconds, so whether one is still shown depends on timing) and blanks the digits of the
title the scenario makes unique per run.
