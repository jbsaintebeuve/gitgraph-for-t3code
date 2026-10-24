#!/usr/bin/env bash
# Runs inside the Linux test container (see Dockerfile.test).
set -euo pipefail
echo "== $(. /etc/os-release && echo "$PRETTY_NAME") | node $(node -v) | $(git --version)"
git config --global user.email test@example.com
git config --global user.name Test
git config --global init.defaultBranch main

npm ci
npm run typecheck
npm test
npm run build

# Throwaway repo with a couple of commits and a dirty tree.
REPO=$(mktemp -d)
git -C "$REPO" init -q
echo a > "$REPO/a.txt" && git -C "$REPO" add . && git -C "$REPO" commit -qm "first"
echo b > "$REPO/B.txt" && git -C "$REPO" add . && git -C "$REPO" commit -qm "second"
echo dirty >> "$REPO/a.txt"

PORT=4777
node bin/gitgraph.js --repo "$REPO" --port "$PORT" > /tmp/gitgraph.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1 && break; sleep 0.2; done

echo "== /api/ping"
curl -fs "http://127.0.0.1:$PORT/api/ping" | tee /dev/stderr | grep -q gitgraph-t3
echo
echo "== / (token injected?)"
curl -fs "http://127.0.0.1:$PORT/" | grep -qi "token" && echo "token present" || { echo "FAIL: no token in index"; exit 1; }

echo "== instance.json permissions"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/gitgraph-t3"
[ "$(stat -c %a "$CFG")" = 700 ] && [ "$(stat -c %a "$CFG/instance.json")" = 600 ]

echo "== gitgraph doctor"
DOCTOR=$(node bin/gitgraph.js doctor)   # exit 0 expected; PATH warning is fine (no npm link here)
echo "$DOCTOR"
grep -q "instance running" <<<"$DOCTOR"

echo "== gitgraph init"
(cd "$REPO" && node ~/gitgraph/bin/gitgraph.js init && grep -q '"Git Graph"' t3.json)

echo "== OK"
