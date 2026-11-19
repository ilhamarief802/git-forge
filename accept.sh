#!/usr/bin/env bash
# Full real-git acceptance: push, clone, verify contents, fast-forward, refuse a
# non-fast-forward, and confirm the clone sees the latest commit.
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
PORT=8110

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/acc-server.log 2>&1 &
SRV=$!
sleep 2

curl -s -X POST "http://127.0.0.1:$PORT/api/v3/user/repos" \
  -H "Authorization: Bearer tok123" -H 'Content-Type: application/json' \
  -d '{"name":"acc"}' > /dev/null

AUTH='Authorization: Bearer tok123'
URL="http://127.0.0.1:$PORT/adaiversen/acc.git"
W=$(mktemp -d); cd "$W" || exit 1
git init -q r; cd "$W/r" || exit 1
git config user.name tester; git config user.email t@example.invalid
mkdir -p lib
printf 'hello forge\n' > README.md
printf 'export const x = 1;\n' > lib/a.js
git add -A && git commit -qm "first"

pass=0; fail=0
check() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  PASS $2"; else fail=$((fail+1)); echo "  FAIL $2"; fi; }

echo "=== push ==="
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="$AUTH" push "$URL" HEAD:refs/heads/main >/dev/null 2>&1
check "$([ $? -eq 0 ] && echo 1 || echo 0)" "push a new branch"

echo "=== clone ==="
cd "$W" || exit 1
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="$AUTH" clone -q "$URL" c1 >/dev/null 2>&1
check "$([ -f "$W/c1/README.md" ] && echo 1 || echo 0)" "clone checks out README.md"
check "$([ "$(cat "$W/c1/README.md" 2>/dev/null)" = "hello forge" ] && echo 1 || echo 0)" "clone has the right content"
check "$([ -f "$W/c1/lib/a.js" ] && echo 1 || echo 0)" "clone has the nested file"

echo "=== second push (fast-forward) ==="
cd "$W/r" || exit 1
printf 'second line\n' >> README.md
git commit -qam "second"
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="$AUTH" push "$URL" HEAD:refs/heads/main >/dev/null 2>&1
check "$([ $? -eq 0 ] && echo 1 || echo 0)" "fast-forward push accepted"

echo "=== non-fast-forward must be refused ==="
git reset -q --hard HEAD~1
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="$AUTH" push "$URL" HEAD:refs/heads/main >/dev/null 2>&1
check "$([ $? -ne 0 ] && echo 1 || echo 0)" "non-fast-forward refused"

echo "=== fresh clone sees the latest commit ==="
cd "$W" && rm -rf c2
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="$AUTH" clone -q "$URL" c2 >/dev/null 2>&1
check "$(grep -q 'second line' "$W/c2/README.md" 2>/dev/null && echo 1 || echo 0)" "clone has the second commit"

echo
echo "RESULT: $pass passed, $fail failed"
tail -3 /tmp/acc-server.log
kill "$SRV" 2>/dev/null
exit 0
