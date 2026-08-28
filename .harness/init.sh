#!/bin/bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
if [ ! -d node_modules ]; then
  npm ci
fi
npm run check
echo "[harness] Session Search ready"
