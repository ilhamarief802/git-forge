#!/usr/bin/env bash
# Debug the fetch path only: push one commit, then clone with the forge's own
# debug log on, so the request/response shapes are visible.
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
export FORGE_DEBUG=1
PORT=8103

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/fetch-server.log 2>&1 &
SRV=$!
sleep 2

curl -s -X POST "http://127.0.0.1:$PORT/api/v3/user/repos" \
  -H "Authorization: Bearer tok123" -H 'Content-Type: application/json' \
  -d '{"name":"f1"}' > /dev/null

W=$(mktemp -d)
cd "$W" || exit 1
git init -q r
cd "$W/r" || exit 1
git config user.name tester
git config user.email t@example.invalid
printf 'hello\n' > a.txt
git add -A && git commit -qm "c1"
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/adaiversen/f1.git" HEAD:refs/heads/main > /dev/null 2>&1
echo "pushed"

cd "$W" || exit 1
echo "=== clone ==="
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  clone "http://127.0.0.1:$PORT/adaiversen/f1.git" c1 2>&1 | tail -8

echo "=== clone contents ==="
ls "$W/c1" 2>/dev/null && cat "$W/c1/a.txt" 2>/dev/null

echo "=== server log ==="
cat /tmp/fetch-server.log

kill "$SRV" 2>/dev/null
exit 0
