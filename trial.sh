#!/usr/bin/env bash
# A full practice trial, as the grader runs it: the kit's env drives my forge
# through the whole suite (conformance + the four workloads), then the kit's own
# scorer turns the export into the official three columns.
set -uo pipefail
KIT=/home/ilham/makefun-work/gh-forge/github-core-clone-01-kit
BOT=/home/ilham/makefun-work/gh-forge-entry
STATE=$(mktemp -d)
SCORES=$(mktemp -d)
PORT=8130
export MAKEFUN_SHOP_TOKEN="$(head -c 16 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"

echo "state dir: $STATE"
cd "$KIT" || exit 1
MAKEFUN_STATE_DIR="$STATE" MAKEFUN_ENV_PORT=$PORT \
  node program/env/server.mjs > /tmp/trial-env.log 2>&1 &
ENV=$!
sleep 3

cd "$BOT" || exit 1
MAKEFUN_ENV_URL="http://127.0.0.1:$PORT" \
  timeout 600 node --experimental-strip-types main.ts > /tmp/trial-bot.log 2>&1
BOTRC=$?
echo "forge exited rc=$BOTRC"

sleep 3
echo "=== env log (tail) ==="
tail -12 /tmp/trial-env.log

echo "=== export files ==="
ls -la "$STATE/export" 2>/dev/null || find "$STATE" -maxdepth 2 -type f | head

echo "=== official scorer ==="
cd "$KIT" || exit 1
MAKEFUN_EXPORT_DIR="$STATE/export" MAKEFUN_SCORES_DIR="$SCORES" node program/scorer/score.mjs
echo "=== scores.json ==="
cat "$SCORES/scores.json" 2>/dev/null

kill "$ENV" 2>/dev/null
echo "STATE=$STATE"
exit 0
