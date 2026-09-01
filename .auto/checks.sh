#!/bin/bash
# Correctness checks for each iteration: typecheck must stay green.
# Test correctness is enforced by the benchmark itself (vitest exit code + test_count).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck > .auto/typecheck.out 2>&1 || {
  echo "TYPECHECK FAILED:"
  tail -60 .auto/typecheck.out
  exit 1
}
