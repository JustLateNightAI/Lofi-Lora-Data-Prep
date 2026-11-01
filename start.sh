#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
node scripts/preflight.cjs
exec npm run dev
