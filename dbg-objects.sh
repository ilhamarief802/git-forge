#!/usr/bin/env bash
# Inspect what a push actually stored: object count and types, so a pack that
# misses blobs shows up before the client says "did not send all necessary
# objects".
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
export FORGE_DEBUG=1
PORT=8104

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/obj-server.log 2>&1 &
SRV=$!
sleep 2

curl -s -X POST "http://127.0.0.1:$PORT/api/v3/user/repos" \
  -H "Authorization: Bearer tok123" -H 'Content-Type: application/json' -d '{"name":"o1"}' >/dev/null

W=$(mktemp -d); cd "$W" || exit 1
git init -q r; cd "$W/r" || exit 1
git config user.name t; git config user.email t@e.x
printf 'hello\n' > a.txt; git add -A; git commit -qm c1
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/adaiversen/o1.git" HEAD:refs/heads/main >/dev/null 2>&1

echo "=== objects in the forge (via a REST-independent probe) ==="
curl -s "http://127.0.0.1:$PORT/api/v3/repos/adaiversen/o1/branches" \
  -H "Authorization: Bearer tok123" | head -c 300; echo
cat /tmp/obj-server.log
kill "$SRV" 2>/dev/null
exit 0
