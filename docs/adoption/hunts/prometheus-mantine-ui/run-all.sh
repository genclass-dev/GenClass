#!/usr/bin/env bash
# Runs every scenario of hunt.mjs: explore at 300, 600 and 900 ms (2 baselines + 6 seeded loads each), then the
# plain runs without GenClass (8 loads each, the superseded request held 900 ms). Results go to results/.
set -u
cd "$(dirname "$0")"
for s in tree table graph format targets sd delete; do
  for slow in 300 600 900; do node hunt.mjs "$s" --slow "$slow" --runs 6 --seed 1; done
  node hunt.mjs "$s" --plain --runs 8 --delay 900
done
