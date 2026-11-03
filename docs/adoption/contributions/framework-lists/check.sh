#!/usr/bin/env bash
# framework-lists: re-runs the checks behind README.md section 3. Clones each list at its recorded commit into
# $WORK (default ~/targets/framework-lists-check), applies the patch from this folder with `git am`, checks the added
# line (list format, no trailing whitespace, link) and runs awesome-lint 2.3.0 before and after (informational: none
# of the four lists runs it). Needs git, python3, node and npm; writes nothing into this repository.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HOME/targets/framework-lists-check}"
mkdir -p "$WORK"
if [ ! -x "$WORK/lint/node_modules/.bin/awesome-lint" ]; then
  (mkdir -p "$WORK/lint" && cd "$WORK/lint" && npm install --no-audit --no-fund --silent awesome-lint@2.3.0)
fi
LINT="$WORK/lint/node_modules/.bin/awesome-lint"

check() { # name repo branch commit
  local name=$1 repo=$2 branch=$3 commit=$4 dir="$WORK/$1"
  [ -d "$dir" ] || git clone -q --depth 50 --single-branch --branch "$branch" "https://github.com/$repo.git" "$dir"
  cd "$dir"
  git fetch -q origin "$branch" || true
  git checkout -q -B check "$commit"
  local before after
  before=$(timeout 180 "$LINT" README.md 2>&1 | grep -Eo '[0-9]+ errors?' | head -1 || true)
  git -c user.name=check -c user.email=check@example.invalid am -q "$HERE/upstream-$name.patch"
  after=$(timeout 180 "$LINT" README.md 2>&1 | grep -Eo '[0-9]+ errors?' | head -1 || true)
  local added
  added=$(git diff -U0 HEAD~1 -- README.md | grep '^+-' | cut -c2-)
  python3 -I - "$added" <<'EOF'
import re, sys
line = sys.argv[1]
assert "\n" not in line, "more than one added line"
assert line == line.rstrip(), "trailing whitespace"
assert re.fullmatch(r"- \[[^\]]+\]\(https://github\.com/genclass-dev/GenClass\) - [A-Z].*", line), "format"
print(f"  added line ok ({len(line)} chars, ends with period: {line.endswith('.')})")
EOF
  echo "$name @ ${commit:0:7}: awesome-lint before: ${before:-?}, after: ${after:-?}"
  cd - >/dev/null
}

check awesome-nextjs   unicodeveloper/awesome-nextjs master 483a40d51d2e8b4daac81fb517ca29abf7ca33df
check awesome-svelte   TheComputerM/awesome-svelte   main   8a61443bf7d815998df11ca16f8cdeb0d4d7fd81
check awesome-solid-js one-aalam/awesome-solid-js    main   48140bdc0e2d194f0251bfc375681605f93c9d2f
check awesome-react    enaqx/awesome-react           master e6fd973eefe57d288a60e6d21bb9d8f343addfe9
