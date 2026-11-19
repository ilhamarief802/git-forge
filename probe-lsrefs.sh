#!/usr/bin/env bash
# Prove ls-refs filtering end to end: push a branch over git, then ask v2
# ls-refs for it by prefix, exactly as the fixture does.
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
export FORGE_DEBUG=1
PORT=8146

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/lsrefs.log 2>&1 &
SRV=$!
sleep 2

curl -s -X POST "http://127.0.0.1:$PORT/api/v3/user/repos" -H "Authorization: Bearer tok123" \
  -H 'Content-Type: application/json' -d '{"name":"t1"}' > /dev/null

W=$(mktemp -d); cd "$W" || exit 1
git init -q r; cd "$W/r" || exit 1
git config user.name t; git config user.email t@e.x
printf 'x\n' > a.txt; git add -A; git commit -qm c1
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer tok123" \
  push "http://127.0.0.1:$PORT/adaiversen/t1.git" HEAD:refs/heads/main >/dev/null 2>&1
echo "pushed main: $?"

echo "=== ls-refs with ref-prefix refs/heads/main ==="
python3 - "$PORT" <<'PY'
import sys, urllib.request
port = sys.argv[1]
def pkt(s):
    b = s.encode()
    return ("%04x" % (len(b) + 4)).encode() + b
body = (pkt("command=ls-refs\n") + pkt("agent=git/2.55.0\n") + pkt("object-format=sha1\n")
        + pkt("peel\n") + pkt("symrefs\n") + pkt("ref-prefix HEAD\n")
        + pkt("ref-prefix refs/heads/main\n") + b"0000")
req = urllib.request.Request(
    "http://127.0.0.1:%d/adaiversen/t1.git/git-upload-pack" % port, data=body,
    headers={"Git-Protocol": "version=2",
             "Content-Type": "application/x-git-upload-pack-request"})
raw = urllib.request.urlopen(req, timeout=10).read()
print("raw:", raw[:300])
PY

echo "=== server log ==="
tail -6 /tmp/lsrefs.log
kill "$SRV" 2>/dev/null
exit 0
