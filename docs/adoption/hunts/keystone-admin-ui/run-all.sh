#!/usr/bin/env bash
# Runs every explore session of the hunt (docs/adoption/hunts/keystone-admin-ui.md section 5), one after another:
# each scenario at 300, 600 and 900 ms of extra latency, 2 fifo baselines + 6 seeded loads per session.
# Usage (from the GenClass-lib repo root, Keystone running and seeded): bash docs/adoption/hunts/keystone-admin-ui/run-all.sh [scenario...]
set -u
cd "$(dirname "$0")/../../../.."
scenarios=("$@")
[ ${#scenarios[@]} -eq 0 ] && scenarios=(list-search list-pages rel-search rel-more item-save create-enter create-click)
for s in "${scenarios[@]}"; do
  for ms in 300 600 900; do
    echo "=== $s slow $ms $(date -u +%H:%M:%S)"
    node docs/adoption/hunts/keystone-admin-ui/hunt.mjs "$s" --slow "$ms" --runs 6 --seed 1 2>&1 | grep -v "^\[genclass-mcp\]"
  done
done
