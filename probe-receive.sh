#!/usr/bin/env bash
# Probe receive-pack directly: send a valid command block with an empty pack and
# print the raw response, so the failure shows up as bytes rather than git's
# "remote end hung up".
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
export FORGE_DEBUG=1
PORT=8102

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/probe-server.log 2>&1 &
SRV=$!
sleep 2

curl -s -X POST "http://127.0.0.1:$PORT/api/v3/user/repos" \
  -H "Authorization: Bearer tok123" -H 'Content-Type: application/json' \
  -d '{"name":"p1"}' > /dev/null
echo "repo created"

python3 - "$PORT" <<'PY'
import sys, urllib.request
port = sys.argv[1]
zero = '0'*40
payload = f"{zero} {'a'*40} refs/heads/main\0report-status side-band-64k\n".encode()
pkt = (f"{len(payload)+4:04x}").encode() + payload
body = pkt + b"0000"          # command list, then flush, then no pack
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/adaiversen/p1.git/git-receive-pack",
    data=body,
    headers={"Authorization": "Bearer tok123",
             "Content-Type": "application/x-git-receive-pack-request"})
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
    print("status", r.status, "bytes", len(raw))
    print("body repr:", repr(raw[:200]))
except Exception as exc:
    print("POST FAILED:", type(exc).__name__, exc)
PY

echo "=== server log ==="
cat /tmp/probe-server.log
kill "$SRV" 2>/dev/null
exit 0
