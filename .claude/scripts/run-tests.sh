#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    print(ti.get('file_path', ti.get('path', '')))
except:
    print('')
" 2>/dev/null || echo "")

[[ -z "$FILE" ]] && exit 0
[[ "$FILE" == *"/Readability.js" ]] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
[[ ! -d "$ROOT/tests" ]] && exit 0

if [[ "$FILE" == *.py ]]; then
    cd "$ROOT"
    source ambivenv/bin/activate 2>/dev/null || true
    python -m pytest tests/ -x -q --tb=short
elif [[ "$FILE" == *.ts || "$FILE" == *.tsx || "$FILE" == *.js || "$FILE" == *.jsx ]]; then
    [[ ! -f "$ROOT/node_modules/.bin/vitest" ]] && exit 0
    cd "$ROOT"
    npx vitest run --bail 1 tests/
fi
