#!/usr/bin/env bash
# Create a fresh disposable repo for a browser-verify CLI scenario.
# Args: <required:true|false> <engine:cdp|http|auto> <port> <server_kind:healthy|consoleerr|boom|noserver|deadport> [probe_port]
set -euo pipefail
REQUIRED="$1"; ENGINE="$2"; PORT="$3"; KIND="$4"; PROBE_PORT="${5:-$PORT}"
WORK="$TMPDIR/al-bv-$(date +%s)-$RANDOM"
mkdir -p "$WORK"
git -C "$WORK" init -q
git -C "$WORK" config user.email t@t.local
git -C "$WORK" config user.name t
git -C "$WORK" config commit.gpgsign false
printf '%s\n' '{' '  "name": "bv-target",' '  "version": "0.0.0",' '  "private": true,' '  "scripts": { "test": "node -e \"process.exit(0)\"" }' '}' > "$WORK/package.json"
git -C "$WORK" add -A && git -C "$WORK" commit -qm baseline
node /Users/abtrk/Dev/loop/agent-loop/dist/bin/agent-loop.js init --root "$WORK" >/dev/null 2>&1
node /Users/abtrk/Dev/loop/agent-loop/dist/bin/agent-loop.js plan --root "$WORK" --idea "Add a tiny web app served by a node http server" >/dev/null 2>&1
# commit the top-level .gitignore init created so the tree is clean
git -C "$WORK" add .gitignore >/dev/null 2>&1 || true
git -C "$WORK" commit -qm "agent-loop gitignore" >/dev/null 2>&1 || true

# server body depends on KIND
case "$KIND" in
  healthy)    BODY="res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body><h1>OK</h1></body></html>');" ;;
  consoleerr) BODY="res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body><h1>page</h1><script>console.error(\"__BROWSER_ERROR__ boom\");</script></body></html>');" ;;
  boom)       BODY="res.writeHead(500,{'content-type':'text/html'});res.end('<!doctype html><html><body><h1>boom</h1></body></html>');" ;;
  *)          BODY="res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body><h1>OK</h1></body></html>');" ;;
esac

# Build the browser config. For noserver/deadport, omit startCommand.
{
  echo ""
  echo "browser:"
  echo "  enabled: true"
  if [ "$KIND" != "noserver" ] && [ "$KIND" != "deadport" ]; then
    echo "  startCommand: [\"node\", \"server.mjs\"]"
  fi
  echo "  baseUrl: \"http://127.0.0.1:${PROBE_PORT}\""
  echo "  routes: [\"/\"]"
  echo "  readyPath: \"/\""
  echo "  startupTimeoutMs: 5000"
  echo "  navigationTimeoutMs: 8000"
  echo "  failOnConsoleError: true"
  echo "  required: ${REQUIRED}"
  echo "  engine: ${ENGINE}"
} >> "$WORK/.agent-loop/config.yml"

# fake-provider.json: write a server.mjs that binds PORT (only meaningful for server kinds)
SERVER_SRC="import { createServer } from 'node:http';\nconst port=${PORT};\nconst server=createServer((req,res)=>{${BODY}});\nserver.listen(port,'127.0.0.1',()=>console.log('LISTENING '+port));\n"
python3 - "$WORK" "$SERVER_SRC" <<'PY'
import json, sys
work, src = sys.argv[1], sys.argv[2]
script = {"slices": {"S-001": {"summary": "scenario app", "files": {"server.mjs": src.encode().decode('unicode_escape')}}}}
with open(f"{work}/.agent-loop/fake-provider.json","w") as f:
    json.dump(script, f, indent=2)
PY
echo "$WORK"
