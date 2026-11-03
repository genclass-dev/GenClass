#!/usr/bin/env bash
# Type conformance of opencode-genclass's built default export against the published OpenCode plugin APIs
# (@opencode-ai/plugin 1.19.5 for OpenCode 1.x, @opencode/plugin 2.2.5 for 2.x), with no casts. Run from the
# repository root after `npm run build -w opencode-genclass`; installs the two packages into a temporary directory.
set -euo pipefail
ROOT=$(pwd)
W=$(mktemp -d)
cd "$W"
npm init -y > /dev/null
npm install --no-audit --no-fund @opencode-ai/plugin@1.19.5 @opencode/plugin@2.2.5 effect@4.0.6 typescript@5.9.3 > /dev/null
mkdir check
cp -r "$ROOT/packages/opencode-plugin/dist" check/dist
cp "$ROOT/docs/adoption/contributions/opencode/types/conformance.ts" check/
cat > check/tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "skipLibCheck": true, "noEmit": true, "types": [] }, "include": ["conformance.ts"] }
JSON
cd check && ../node_modules/.bin/tsc -p tsconfig.json && echo "conformance: ok (V1 PluginModule and Hooks, V2 Plugin.define)"
