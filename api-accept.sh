#!/usr/bin/env bash
# REST + GraphQL + MCP acceptance against the running forge, every assertion from
# RULES.txt. Prints one PASS/FAIL line per contract point.
set -uo pipefail
cd /home/ilham/makefun-work/gh-forge-entry || exit 1
export MAKEFUN_SHOP_TOKEN=tok123
PORT=8120
B="http://127.0.0.1:$PORT"
H="Authorization: Bearer tok123"
J='Content-Type: application/json'

node --experimental-strip-types -e "
import('./app.ts').then(m => m.createApp().listen($PORT, '127.0.0.1', () => console.log('up')));
" > /tmp/api-server.log 2>&1 &
SRV=$!
sleep 2

pass=0; fail=0
ck() { if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "  PASS $3"; else fail=$((fail+1)); echo "  FAIL $3 (got '$1', want '$2')"; fi; }
code() { curl -s -o /tmp/body.json -w '%{http_code}' "$@"; }

echo "=== REST: root and meta ==="
ck "$(code $B/api/v3/ -H "$H")" 200 "GET /api/v3 200"
ck "$(curl -s -D- -o /dev/null $B/api/v3/ -H "$H" | grep -ci 'x-oauth-scopes')" 1 "X-OAuth-Scopes present"
ck "$(code $B/api/v3/meta -H "$H")" 200 "GET /api/v3/meta 200"
ck "$(python3 -c "import json;print(bool(json.load(open('/tmp/body.json')).get('installed_version')))")" True "installed_version non-empty"
ck "$(code $B/api/v3/ -H 'Authorization: Bearer wrong')" 401 "wrong token 401"
ck "$(code $B/api/v3/nope -H "$H")" 404 "unknown route 404"
ck "$(python3 -c "import json;print('message' in json.load(open('/tmp/body.json')))")" True "404 body has message"

echo "=== REST: repositories ==="
ck "$(code -X POST $B/api/v3/user/repos -H "$H" -H "$J" -d '{"name":"r1","description":"d0"}')" 201 "POST user/repos 201"
ck "$(code $B/api/v3/repos/adaiversen/r1 -H "$H")" 200 "GET repo 200"
ck "$(code $B/api/v3/repos/adaiversen/missing -H "$H")" 404 "missing repo 404"
ck "$(code -X PATCH $B/api/v3/repos/adaiversen/r1 -H "$H" -H "$J" -d '{"description":"d1"}')" 200 "PATCH repo 200"
ck "$(python3 -c "import json;print(json.load(open('/tmp/body.json'))['description'])")" d1 "description updated"
ck "$(curl -s -D- -o /dev/null "$B/api/v3/user/repos?per_page=1" -H "$H" | grep -ci 'rel="next"')" 0 "single page has no Link (correct)"
ck "$(code -X POST $B/api/v3/user/repos -H "$H" -H "$J" -d '{"name":"r2"}')" 201 "second repo 201"
ck "$(curl -s -D- -o /dev/null "$B/api/v3/user/repos?per_page=1" -H "$H" | grep -ci 'rel="next"')" 1 "two repos link next page"

echo "=== REST: labels and issues ==="
ck "$(code -X POST $B/api/v3/repos/adaiversen/r1/labels -H "$H" -H "$J" -d '{"name":"bug","color":"ff0000"}')" 201 "create label 201"
ck "$(code -X POST $B/api/v3/repos/adaiversen/r1/issues -H "$H" -H "$J" -d '{"title":"t1","body":"b1","labels":["bug"]}')" 201 "create issue 201"
ck "$(code -X POST $B/api/v3/repos/adaiversen/r1/issues -H "$H" -H "$J" -d '{"title":"t2","labels":["nope"]}')" 422 "unknown label 422"
ck "$(code $B/api/v3/repos/adaiversen/r1/issues -H "$H")" 200 "list issues 200"
ck "$(python3 -c "import json;print(len(json.load(open('/tmp/body.json'))))")" 1 "one open issue"

echo "=== REST: contents ==="
B64=$(printf 'file body\n' | base64 -w0)
ck "$(code -X PUT $B/api/v3/repos/adaiversen/r1/contents/doc.txt -H "$H" -H "$J" -d "{\"message\":\"add\",\"content\":\"$B64\"}")" 201 "PUT new file 201"
SHA=$(python3 -c "import json;print(json.load(open('/tmp/body.json'))['content']['sha'])")
ck "$(code $B/api/v3/repos/adaiversen/r1/contents/doc.txt -H "$H")" 200 "GET file 200"
ck "$(code -X PUT $B/api/v3/repos/adaiversen/r1/contents/doc.txt -H "$H" -H "$J" -d "{\"message\":\"upd\",\"content\":\"$B64\",\"sha\":\"deadbeef\"}")" 409 "stale sha 409"
ck "$(code -X PUT $B/api/v3/repos/adaiversen/r1/contents/doc.txt -H "$H" -H "$J" -d "{\"message\":\"upd\",\"content\":\"$B64\",\"sha\":\"$SHA\"}")" 200 "update with right sha 200"
ck "$(code -X DELETE $B/api/v3/repos/adaiversen/r1/contents/doc.txt -H "$H" -H "$J" -d '{"message":"rm"}')" 200 "DELETE file 200"
ck "$(code $B/api/v3/repos/adaiversen/r1/contents/doc.txt -H "$H")" 404 "deleted file 404"

echo "=== REST: malformed JSON and deletes ==="
ck "$(code -X POST $B/api/v3/user/repos -H "$H" -H "$J" -d '{oops')" 400 "malformed JSON 400"
ck "$(code -X DELETE $B/api/v3/repos/adaiversen/r2 -H "$H")" 204 "DELETE repo 204"
ck "$(code $B/api/v3/repos/adaiversen/r2 -H "$H")" 404 "deleted repo 404"

echo "=== GraphQL ==="
ck "$(code -X POST $B/api/graphql -H "$H" -H "$J" -d '{"query":"{ repository(owner:\"adaiversen\", name:\"r1\") { name nameWithOwner } }"}')" 200 "graphql 200"
ck "$(python3 -c "import json;print(json.load(open('/tmp/body.json'))['data']['repository']['nameWithOwner'])")" adaiversen/r1 "repository nameWithOwner"
ck "$(code -X POST $B/api/graphql -H 'Authorization: Bearer wrong' -H "$J" -d '{"query":"{viewer{login}}"}')" 401 "graphql unauth 401"
ck "$(code -X POST $B/api/graphql -H "$H" -H "$J" -d '{"query":"{ repository(owner:\"adaiversen\", name:\"nope\") { id } }"}')" 200 "unknown repo 200"
ck "$(python3 -c "import json;d=json.load(open('/tmp/body.json'));print(d['data']['repository'] is None)")" True "unknown repo null"
ck "$(python3 -c "import json;d=json.load(open('/tmp/body.json'));print('errors' in d)")" False "unknown repo no errors"
ck "$(code -X POST $B/api/graphql -H "$H" -H "$J" -d '{"query":"{ __type(name:\"Issue\") { name } }"}')" 200 "introspection 200"
ck "$(python3 -c "import json;print(json.load(open('/tmp/body.json'))['data']['__type']['name'])")" Issue "introspection Issue"
ck "$(code -X POST $B/api/graphql -H "$H" -H "$J" -d '{"query":"{ bogusField }"}')" 200 "unknown field 200"
ck "$(python3 -c "import json;d=json.load(open('/tmp/body.json'));print(bool(d.get('errors')))")" True "unknown field errors"
ck "$(code -X POST $B/api/graphql -H "$H" -H "$J" -d '[{"query":"{viewer{login}}"},{"query":"{viewer{login}}"}]')" 200 "batch 200"
ck "$(python3 -c "import json;print(len(json.load(open('/tmp/body.json'))))")" 2 "batch returns two"

echo "=== MCP ==="
ck "$(code -X POST $B/mcp -H "$H" -H "$J" -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}')" 200 "discover 200"
ck "$(python3 -c "import json;d=json.load(open('/tmp/body.json'));print(len(d['result']['supportedVersions'])>0)")" True "supportedVersions non-empty"
ck "$(code -X POST $B/mcp -H "$H" -H "$J" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')" 200 "tools/list 200"
ck "$(python3 -c "import json;d=json.load(open('/tmp/body.json'));print(len(d['result']['tools']))")" 6 "six tools"
ck "$(code -X POST $B/mcp -H 'Authorization: Bearer wrong' -H "$J" -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')" 401 "mcp unauth 401"
ck "$(code -X POST $B/mcp -H "$H" -H "$J" -d 'not json')" 400 "bad body 400"
ck "$(python3 -c "import json;print(json.load(open('/tmp/body.json'))['error']['code'])")" -32700 "parse error -32700"
ck "$(code -X POST $B/mcp -H "$H" -H "$J" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_issue","arguments":{"owner":"adaiversen","repo":"r1","title":"via mcp"}}}')" 200 "mcp create_issue 200"
ck "$(code -X POST $B/mcp -H "$H" -H "$J" -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_issues","arguments":{"owner":"adaiversen","repo":"r1"}}}')" 200 "mcp list_issues 200"
ck "$(python3 -c "
import json
d=json.load(open('/tmp/body.json'))
txt=d['result']['content'][0]['text']
print('via mcp' in txt)
")" True "mcp issue visible through REST store"
ck "$(code -X POST $B/api/v3/repos/adaiversen/r1/issues -H "$H" -H "$J" -d '{"title":"via rest"}')" 201 "REST issue after MCP 201"
ck "$(code -X POST $B/mcp -H "$H" -H "$J" -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nope","arguments":{}}}')" 200 "unknown tool 200"
ck "$(python3 -c "import json;print(json.load(open('/tmp/body.json'))['error']['code'])")" -32601 "unknown tool -32601"

echo
echo "RESULT: $pass passed, $fail failed"
tail -3 /tmp/api-server.log
kill "$SRV" 2>/dev/null
exit 0
