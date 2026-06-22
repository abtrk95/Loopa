#!/bin/zsh
# Build a fresh repo + plan + fake-provider with a CONTROLLABLE SLOW verification check.
# Usage: cr-fixture.sh <dir> <sleep_seconds>
# The slow check runs `sleep N` for each slice's verification, so we can kill mid-run.
set -e
DIR="$1"
SLEEP="${2:-8}"
BIN="node /Users/abtrk/Dev/loop/agent-loop/dist/bin/agent-loop.js"

rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email t@t.local
git config user.name t
git config commit.gpgsign false
cat > package.json <<'EOF'
{ "name": "cr-fixture", "version": "0.0.0", "scripts": { "test": "node -e \"process.exit(0)\"" } }
EOF
git add -A
git commit -qm baseline

# PRD: 3 sequential slices (written OUTSIDE the repo so the tree stays clean)
PRD="${DIR}-prd.json"
cat > "$PRD" <<'EOF'
{
  "project": "cr-fixture",
  "description": "three independent file slices",
  "userStories": [
    { "id": "US1", "title": "alpha file", "description": "create a.txt", "acceptanceCriteria": ["a.txt exists"], "priority": 1, "allowedPaths": ["a.txt"] },
    { "id": "US2", "title": "beta file", "description": "create b.txt", "acceptanceCriteria": ["b.txt exists"], "priority": 2, "allowedPaths": ["b.txt"] },
    { "id": "US3", "title": "gamma file", "description": "create c.txt", "acceptanceCriteria": ["c.txt exists"], "priority": 3, "allowedPaths": ["c.txt"] }
  ]
}
EOF

eval "$BIN init --root $DIR" >/dev/null 2>&1 || true
git add .gitignore 2>/dev/null || true
git commit -qm "add gitignore" >/dev/null 2>&1 || true
eval "$BIN plan --prd $PRD --root $DIR" >/dev/null 2>&1

# Inject a slow check into plan.json: add a "slow" verification command + require it per slice.
node -e '
const fs=require("fs");
const p=process.argv[1]; const s=process.argv[2];
const plan=JSON.parse(fs.readFileSync(p,"utf8"));
plan.verification=plan.verification||[];
plan.verification.push({id:"slow",category:"custom",command:["sleep",String(s)],expect:"exit_zero"});
for(const sl of plan.slices){ sl.requiredChecks=Array.from(new Set([...(sl.requiredChecks||[]),"slow"])); }
fs.writeFileSync(p,JSON.stringify(plan,null,2));
console.error("injected slow check ("+s+"s) into "+plan.slices.length+" slices");
' "$DIR/.agent-loop/plan.json" "$SLEEP"

cat > "$DIR/.agent-loop/fake-provider.json" <<'EOF'
{
  "slices": {
    "S-001": { "files": { "a.txt": "alpha\n" }, "summary": "a" },
    "S-002": { "files": { "b.txt": "beta\n" }, "summary": "b" },
    "S-003": { "files": { "c.txt": "gamma\n" }, "summary": "c" }
  },
  "reviews": {}
}
EOF
echo "fixture ready at $DIR (slow=$SLEEP)"
