#!/usr/bin/env python3
"""Pre-push gate: skip `npm run check` when a recent check-ok marker matches
the tree of the commit being pushed.

Triple check (all must pass to skip, else exit 1 → hook runs npm run check):
  1. marker exists and its `ts` is within MAX_AGE_S (10 min) of now
  2. marker `command` == EXPECTED_CMD ("npm run check")
  3. current `git rev-parse HEAD^{tree}` == marker `treeHash`

The marker is written by harness-submit M5 after a green `npm run check` and
records `git write-tree`. This remains valid after commit because the new HEAD
has the same tree. Any mismatch (no marker, stale, command or tree changed)
forces a full re-run — the safe default. This is a local convenience only;
non-harness pushes have no marker and always run the check.

Exit 0 = skip (recent verified), exit 1 = run npm run check.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # harness/scripts/../.. = repo root
MARKER = ROOT / ".harness" / "check-ok.marker"
MAX_AGE_S = 600  # 10 minutes
EXPECTED_CMD = "npm run check"


def _git_output(args: list[str]) -> str | None:
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def _current_index_tree() -> str | None:
    return _git_output(["write-tree"])


def _current_head_tree() -> str | None:
    return _git_output(["rev-parse", "HEAD^{tree}"])


def write_marker() -> int:
    """Record the verified index tree so the marker survives the next commit."""
    tree = _current_index_tree()
    if tree is None:
        return 1
    MARKER.parent.mkdir(parents=True, exist_ok=True)
    payload = {"ts": time.time(), "treeHash": tree, "command": EXPECTED_CMD}
    MARKER.write_text(
        json.dumps(payload, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"check-ok marker written for tree {tree[:7]}")
    return 0


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="pre-push check gate")
    ap.add_argument(
        "--write",
        action="store_true",
        help="write a check-ok marker for current HEAD (harness-submit M5)",
    )
    args = ap.parse_args(argv)
    if args.write:
        return write_marker()
    if not MARKER.is_file():
        return 1
    try:
        data = json.loads(MARKER.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return 1
    if not isinstance(data, dict):
        return 1
    ts = data.get("ts")
    if not isinstance(ts, (int, float)) or time.time() - ts > MAX_AGE_S:
        return 1
    if data.get("command") != EXPECTED_CMD:
        return 1
    marker_tree = data.get("treeHash")
    if not isinstance(marker_tree, str):
        return 1
    tree = _current_head_tree()
    if tree is None or tree != marker_tree:
        return 1
    # All three checks passed: a green npm run check ran on this exact HEAD
    # within the last 10 minutes. Safe to skip.
    print(
        f"pre-push: skipping npm run check (verified {int(time.time() - ts)}s ago "
        f"for tree {tree[:7]})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
