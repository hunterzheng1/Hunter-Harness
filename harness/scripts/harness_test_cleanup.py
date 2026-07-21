#!/usr/bin/env python3
"""Controlled cleanup helper for test fixtures (retro §5.23).

Provides a host-policy-friendly entry point for removing gitignored test
fixtures (e.g. .pytest_data) within an execution root. Performs realpath
containment, rejects symlink/reparse escapes, lists exact counts before
deletion, and outputs a structured receipt.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def _resolve_within(execution_root: Path, rel: str) -> Path | None:
    """Resolve rel under execution_root, rejecting escapes and symlinks."""
    if not rel or rel.startswith("/"):
        return None
    # Reject absolute paths (Windows drive letter or POSIX).
    if len(rel) >= 2 and rel[1] == ":":
        return None
    parts = rel.replace("\\", "/").split("/")
    if ".." in parts:
        return None
    candidate = (execution_root / rel).resolve(strict=False)
    # Containment check: candidate must be under execution_root.
    try:
        candidate.relative_to(execution_root.resolve(strict=False))
    except ValueError:
        return None
    # Reject symlink/reparse escape: if the path is a symlink, check its target.
    if candidate.is_symlink():
        target = Path(os.readlink(candidate)).resolve(strict=False)
        try:
            target.relative_to(execution_root.resolve(strict=False))
        except ValueError:
            return None
        # Even if target is inside, a symlinked cleanup root is suspicious;
        # reject to avoid following links into unexpected locations.
        return None
    return candidate


def _count_files(root: Path) -> tuple[int, int]:
    """Count files and total bytes under root."""
    count = 0
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            fp = Path(dirpath) / name
            try:
                total += fp.stat().st_size
                count += 1
            except OSError:
                continue
    return count, total


def cleanup(execution_root: Path, cleanup_roots: list[str]) -> dict[str, Any]:
    """Remove allowlisted cleanup roots within execution_root.

    Returns a structured receipt. Any path escape, symlink escape, or
    unallowed root results in ok=false with zero files removed.
    """
    execution_root = Path(execution_root).resolve(strict=False)
    if not execution_root.is_dir():
        return {
            "ok": False,
            "code": "EXECUTION_ROOT_MISSING",
            "executionRoot": str(execution_root),
            "removedFiles": 0,
            "removedBytes": 0,
            "rejectedEscapes": [],
        }

    rejected: list[dict[str, str]] = []
    removed_files = 0
    removed_bytes = 0
    cleaned: list[str] = []

    for rel in cleanup_roots:
        target = _resolve_within(execution_root, rel)
        if target is None:
            rejected.append({"path": rel, "reason": "PATH_ESCAPE_REJECTED"})
            continue
        if not target.exists():
            # Already absent — idempotent reentry.
            continue
        # Re-check symlink after resolution (the parent might be a symlink).
        if target.is_symlink():
            rejected.append({"path": rel, "reason": "SYMLINK_ESCAPE_REJECTED"})
            continue
        # Count before deletion for the receipt.
        try:
            count, total = _count_files(target)
        except OSError:
            count, total = 0, 0
        # Delete.
        try:
            shutil.rmtree(target)
        except OSError as exc:
            rejected.append({"path": rel, "reason": f"DELETE_FAILED: {exc}"})
            continue
        removed_files += count
        removed_bytes += total
        cleaned.append(rel)

    if rejected:
        return {
            "ok": False,
            "code": rejected[0]["reason"],
            "executionRoot": str(execution_root),
            "removedFiles": removed_files,
            "removedBytes": removed_bytes,
            "rejectedEscapes": rejected,
            "cleaned": cleaned,
        }

    if removed_files == 0 and not cleaned:
        return {
            "ok": True,
            "code": "ALREADY_ABSENT",
            "executionRoot": str(execution_root),
            "removedFiles": 0,
            "removedBytes": 0,
            "rejectedEscapes": [],
            "cleaned": [],
        }

    return {
        "ok": True,
        "code": "CLEANUP_COMPLETE",
        "executionRoot": str(execution_root),
        "removedFiles": removed_files,
        "removedBytes": removed_bytes,
        "rejectedEscapes": [],
        "cleaned": cleaned,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    clean_parser = sub.add_parser("cleanup")
    clean_parser.add_argument("--execution-root", required=True)
    clean_parser.add_argument("--cleanup-roots", required=True, help="JSON array of relative paths")
    clean_parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        roots = json.loads(args.cleanup_roots)
        if not isinstance(roots, list):
            raise ValueError("cleanup-roots must be a JSON array")
    except (json.JSONDecodeError, ValueError) as exc:
        result = {"ok": False, "code": "INVALID_CLEANUP_ROOTS", "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    result = cleanup(Path(args.execution_root), roots)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
