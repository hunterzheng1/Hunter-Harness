#!/usr/bin/env python3
"""AutoLoop evaluator for Hunter-Harness simplification research.

Emits METRIC lines (metric_lines format) for the autoloop CLI.

Metric: repo_python_loc — total non-blank, non-comment lines of Python
source under harness/scripts (excluding tests). Direction: lower.
This is a *research candidate* metric, not a score; the semantic layer
(researcher judgment + code evidence) must confirm real simplification.

Guardrail mode (--guardrail): exit 0 iff the tracked working tree is
clean of syntax errors in remaining Python modules (compileall) and
the harness safe unittest profile passes. Full TS suite is run by the
researcher outside autoloop when needed (too slow for per-experiment).
"""
from __future__ import annotations

import compileall
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.join(REPO_ROOT, "harness", "scripts")
TESTS_DIR = os.path.join(SCRIPTS_DIR, "tests")


def count_python_loc() -> int:
    total = 0
    for root, dirs, files in os.walk(SCRIPTS_DIR):
        # exclude test directory from the "production code" metric
        if os.path.normpath(root) == os.path.normpath(TESTS_DIR):
            continue
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    stripped = line.strip()
                    if not stripped or stripped.startswith("#"):
                        continue
                    total += 1
    return total


def count_dead_modules() -> int:
    """Count modules listed in the simplification analysis as dead code."""
    dead = [
        "harness_plan_aggregate.py",
        "harness_retry.py",
        "harness_orchestration.py",
        "harness_headless.py",
        "harness_test_cleanup.py",
        "harness_sync.py",
        "harness_check_gate.py",
    ]
    return sum(1 for m in dead if os.path.exists(os.path.join(SCRIPTS_DIR, m)))


def run_guardrail() -> int:
    # 1. syntax-compile all remaining python modules
    ok = compileall.compile_dir(SCRIPTS_DIR, quiet=2, force=True)
    if not ok:
        print("guardrail: compileall failed", file=sys.stderr)
        return 1
    # 2. safe unittest profile (authoritative behavioral guardrail)
    proc = subprocess.run(
        [
            sys.executable,
            os.path.join(SCRIPTS_DIR, "harness_test_runner.py"),
            "unittest",
            "--profile",
            "safe",
            "--timeout-seconds",
            "600",
            "--verbosity",
            "0",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-4000:])
        sys.stderr.write(proc.stderr[-4000:])
        return 1
    return 0


def main() -> int:
    if "--guardrail" in sys.argv[1:]:
        return run_guardrail()
    print(f"METRIC repo_python_loc={count_python_loc()}")
    print(f"METRIC dead_modules={count_dead_modules()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
