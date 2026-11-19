#!/usr/bin/env bash
# End-to-end test of the forge with the REAL git client: create a repo over REST,
# push a real repository into it, clone it back, and compare the trees.
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
export MAKEFUN_ENV_URL=""
PORT=8099

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('listening')));
" > /tmp/forge-server.log 2>&1 &
SRV=$!
sleep 2

say() { printf '\n=== %s\n' "$*"; }

say "healthz"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/healthz

LOGIN=$(curl -s http://127.0.0.1:$PORT/api/v3/user -H "Authorization: Bearer tok123" | python3 -c "import sys,json;print(json.load(sys.stdin)['login'])")
say "viewer login: $LOGIN"

say "create repo over REST"
curl -s -X POST http://127.0.0.1:$PORT/api/v3/user/repos \
  -H "Authorization: Bearer tok123" -H 'Content-Type: application/json' \
  -d '{"name":"demo","description":"e2e"}' | head -c 220; echo

say "401 without token"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/api/v3/user/repos -H 'Authorization: Bearer wrong'

say "unknown route is JSON 404"
curl -s http://127.0.0.1:$PORT/api/v3/nope -H "Authorization: Bearer tok123" | head -c 80; echo

# ── real git push ──────────────────────────────────────────────────────────
WORK=$(mktemp -d)
cd "$WORK" || exit 1
git init -q src
cd "$WORK/src" || exit 1
git config user.name tester && git config user.email t@example.invalid
printf 'hello forge\n' > README.md
mkdir -p lib && printf 'export const x = 1;\n' > lib/a.js
git add -A && git commit -qm "first commit"
cd "$WORK" || exit 1

say "git push into the forge"
cd "$WORK/src" || exit 1
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/$LOGIN/demo.git" HEAD:refs/heads/main 2>&1 | tail -6

say "git clone back"
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  clone -q "http://127.0.0.1:$PORT/$LOGIN/demo.git" clone1 2>&1 | tail -4
ls clone1 2>/dev/null && cat clone1/README.md 2>/dev/null

say "second push (fast-forward) and a forced non-fast-forward"
cd "$WORK/src" || exit 1
printf 'second line\n' >> README.md
git commit -qam "second commit"
FIRST=$(git rev-parse HEAD~1)
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/$LOGIN/demo.git" HEAD:refs/heads/main 2>&1 | tail -3
git reset -q --hard "$FIRST"
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/$LOGIN/demo.git" HEAD:refs/heads/main 2>&1 | tail -4

say "clone again sees the latest"
cd "$WORK" && rm -rf clone2
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  clone -q "http://127.0.0.1:$PORT/$LOGIN/demo.git" clone2 2>&1 | tail -3
cat "$WORK/clone2/README.md" 2>/dev/null

say "server log"
tail -5 /tmp/forge-server.log
kill $SRV 2>/dev/null
echo "done"
