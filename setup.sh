#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
node scripts/preflight.cjs
npm ci
npm run install:electron
echo "Setup complete. Run ./start.sh"
