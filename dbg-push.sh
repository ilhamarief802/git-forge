#!/usr/bin/env bash
# Focused receive-pack debug: start the forge, create a repo, push one commit,
# and print the full git stderr plus the server's own log.
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
export FORGE_DEBUG=1
PORT=8101

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/dbg-server.log 2>&1 &
SRV=$!
sleep 2

curl -s -X POST "http://127.0.0.1:$PORT/api/v3/user/repos" \
  -H "Authorization: Bearer tok123" -H 'Content-Type: application/json' \
  -d '{"name":"d1"}' > /dev/null

W=$(mktemp -d)
cd "$W" || exit 1
git init -q r
cd "$W/r" || exit 1
git config user.name tester
git config user.email t@example.invalid
printf 'hi\n' > a.txt
git add -A && git commit -qm "c1"

echo "=== push, full stderr ==="
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/adaiversen/d1.git" HEAD:refs/heads/main 2>&1 | tail -14

echo "=== server log ==="
cat /tmp/dbg-server.log

echo "=== receive-pack advertisement ==="
curl -s -i "http://127.0.0.1:$PORT/adaiversen/d1.git/info/refs?service=git-receive-pack" | head -10

kill "$SRV" 2>/dev/null
exit 0
