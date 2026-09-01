#!/bin/bash
# Autoresearch measure: run the full local TS test suite exactly like `npm test`
# (pretest included), capture vitest Duration and per-worker sums, emit METRIC lines.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pretest is part of what developers run: sync:harness (no-op when current) + esbuild bundle.
T0=$(date +%s%N)
npm test > .auto/measure.out 2>&1
T1=$(date +%s%N)
REAL_TOTAL=$(awk "BEGIN{printf \"%.1f\", ($T1-$T0)/1e9}")

# Vitest summary lines: " Duration  176.07s (transform 7.84s, setup 0ms, import 48.57s, tests 281.40s, environment 12ms)"
# Strip ANSI escapes first: vitest colors the summary even when piped.
PLAIN=$(sed 's/\x1b\[[0-9;]*m//g' .auto/measure.out)
DUR=$(printf '%s' "$PLAIN" | grep -aoE "Duration[[:space:]]+[0-9.]+s" | head -1 | grep -oE "[0-9.]+" || echo 0)
IMPORT=$(printf '%s' "$PLAIN" | grep -aoE "import [0-9.]+s" | head -1 | grep -oE "[0-9.]+" || echo 0)
TESTS_SUM=$(printf '%s' "$PLAIN" | grep -aoE "tests [0-9.]+s" | head -1 | grep -oE "[0-9.]+" || echo 0)
TRANSFORM=$(printf '%s' "$PLAIN" | grep -aoE "transform [0-9.]+s" | head -1 | grep -oE "[0-9.]+" || echo 0)
COUNT=$(printf '%s' "$PLAIN" | grep -aoE "Tests[[:space:]]+[0-9]+ passed" | head -1 | grep -oE "[0-9]+" || echo 0)

echo "METRIC test_wall_seconds=$DUR"
echo "METRIC test_count=$COUNT"
echo "METRIC import_seconds=$IMPORT"
echo "METRIC tests_sum_seconds=$TESTS_SUM"
echo "METRIC transform_seconds=$TRANSFORM"
echo "METRIC real_total_seconds=$REAL_TOTAL"
