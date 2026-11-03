#!/usr/bin/env bash
# The explore sweep of docs/adoption/hunts/linkwarden.md, in one go (about 35 minutes on the cloud container).
#   bash docs/adoption/hunts/linkwarden/sweep.sh            # unfixed: every scenario at 300, 600, 900 ms
#   HUNT_TAG=fixed bash docs/adoption/hunts/linkwarden/sweep.sh theme-twice font-size
# Seeds 1-6 for every scenario; the two preference scenarios also from seed 7 (seeds 1-6 never deliver the second of
# their two PUTs first: see the report, section 6).
set -u
cd "$(dirname "$0")/../../../.."
scenarios=${*:-"theme-twice font-size edit-name pin-unpin"}
for s in $scenarios; do
  for ms in 300 600 900; do
    seeds="1"
    case $s in theme-twice|font-size) seeds="1 7";; esac
    for seed in $seeds; do
      out=${HUNT_OUT:-/root/targets/lw-hunt-out}/$s-$ms$([ "$seed" != 1 ] && echo "-s$seed")${HUNT_TAG:+-$HUNT_TAG}.json
      if [ -f "$out" ] && [ -z "${HUNT_FORCE:-}" ]; then echo "skip $out"; continue; fi
      echo "=== $s $ms seed $seed ${HUNT_TAG:-unfixed}"
      HUNT_SEED=$seed timeout 900 node docs/adoption/hunts/linkwarden/hunt.mjs explore "$s" "$ms" 6 2>&1 | grep -E "^(RACE|No race|No verdict|Internal state|Compared|DOM\+server|- r[0-9]+: |wrote)" | cut -c1-300
    done
  done
done
