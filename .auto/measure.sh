#!/bin/bash
# Autoresearch measure: archive execute benchmark + correctness backpressure.
#
# NOTE: run_experiment on this machine executes scripts through WSL bash
# (System32\bash.exe). Two environment quirks are handled here:
#   - .auto/checks.sh cannot be launched by the tool (it passes a Windows-style
#     path that WSL bash cannot open), so correctness backpressure is embedded
#     in this script: benchmark first, then the archive unittest modules.
#   - The WSLInterop binfmt registration is periodically cleared by systemd on
#     this machine; self-heal it (same flags as WSL's own generator) before
#     delegating to the Windows toolchain. python.exe is the same interpreter
#     as the dev shell, so the benchmark measures the real Windows environment.
set -uo pipefail
cd "$(dirname "$0")/.."

if grep -qi microsoft /proc/version 2>/dev/null; then
  PY=python.exe
  if ! "$PY" -c "pass" >/dev/null 2>&1; then
    sudo -n sh -c \
      'echo ":WSLInterop:M::MZ::/init:P" > /proc/sys/fs/binfmt_misc/register' \
      2>/dev/null || true
  fi
  if ! "$PY" -c "pass" >/dev/null 2>&1; then
    echo "FATAL: WSL interop unavailable; cannot run Windows python.exe" >&2
    exit 126
  fi
else
  PY=python
fi
# test_harness_archive_c imports its sibling test_harness_archive directly.
# WSL -> Win32 env vars must be whitelisted via WSLENV to reach python.exe.
export PYTHONPATH="harness/scripts/tests${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8
export WSLENV="PYTHONPATH/w:PYTHONUTF8/w:PYTHONIOENCODING/w${WSLENV:+:$WSLENV}"

# --- 1) benchmark -----------------------------------------------------------
"$PY" .auto/bench_archive.py | tr -d '\r'
BENCH_RC=${PIPESTATUS[0]}
if [ "$BENCH_RC" -ne 0 ]; then
  echo "BENCHMARK INTEGRITY FAILED (rc=$BENCH_RC)"
  exit "$BENCH_RC"
fi

# --- 2) correctness backpressure (archive behavior contract) -----------------
"$PY" -m unittest \
  harness.scripts.tests.test_harness_archive \
  harness.scripts.tests.test_harness_archive_c \
  harness.scripts.tests.test_harness_archive_preflight \
  harness.scripts.tests.test_harness_archive_remote \
  harness.scripts.tests.test_harness_runtime \
  harness.scripts.tests.test_harness_archive_perf_guards \
  > .auto/archive-tests.out 2>&1
TESTS_RC=$?
if [ "$TESTS_RC" -ne 0 ]; then
  echo "ARCHIVE PYTHON TESTS FAILED:"
  tail -80 .auto/archive-tests.out | tr -d '\r'
  exit 1
fi
echo "ARCHIVE TESTS OK"
