#!/usr/bin/env python3
"""Harness state/context snapshot (cluster 3, spec §3.6).

Per-segment fingerprints for project/worktree/git/profile/rules/map/knowledge/
diff. Each segment fails independently; cache miss re-captures only the affected
segment. plan/run/test/review/submit read this snapshot; stale segments are
re-captured by the script. Never skip code or verification gates on cache alone.

Python 3.10+ stdlib only. UTF-8 without BOM. Windows path friendly.
"""

from __future__ import annotations

import datetime as dt
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from harness_ledger import compute_inputs_hash  # noqa: E402


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SNAPSHOT_SCHEMA_VERSION = 1
SNAPSHOT_REL = Path("meta") / "state-snapshot.json"


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def read_json(path: Path) -> Any:
    # utf-8-sig 兼容可能残留的 BOM（与 harness_ledger.py 保持一致）。
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # 强制 LF，UTF-8 无 BOM（与 harness_ledger/harness_profile 保持一致）。
    # 原子写 temp+os.replace：崩溃后不留半写文件（与 runtime-helpers.mjs writeJsonUtf8NoBom 一致）。
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def snapshot_path(change_dir: Path) -> Path:
    return change_dir / SNAPSHOT_REL


def _empty_segment_fingerprint() -> str:
    return "sha256:" + hashlib.sha256(b"").hexdigest()


def capture_file_segment(
    files: list[str], *, captured_at: str | None = None
) -> dict[str, Any]:
    """对一组文件算指纹（compute_inputs_hash，order-independent），返回 segment dict。

    空文件集 → 稳定空指纹 + 空 files（段存在但无输入，不算失效）。
    缺失文件由 compute_inputs_hash 抛 FileNotFoundError（调用方应保证文件存在）。
    """
    if files:
        fp, resolved = compute_inputs_hash(files)
        return {
            "fingerprint": fp,
            "files": resolved,
            "capturedAt": captured_at or now_iso(),
        }
    return {
        "fingerprint": _empty_segment_fingerprint(),
        "files": [],
        "capturedAt": captured_at or now_iso(),
    }


def capture_snapshot(
    change_dir: Path,
    *,
    change_name: str,
    project: Path,
    worktree_root: Path,
    base: str | None = None,
    head: str | None = None,
    segment_files: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """采集全段 state snapshot。

    segment_files 指定每段（profile/rules/map/knowledge/...）的文件集；调用方
    （各 skill）决定每段采什么文件，snapshot 只负责采集 + 比对 + 失效。
    git 段记录 base/head；diff 指纹由调用方按需用 harness_ledger.compute_diff_hash
    采后填入 segment_files（spec §3.6）。
    """
    _ = change_dir  # 预留给未来 write-back；当前 capture 只返回 dict
    segment_files = segment_files or {}
    segments: dict[str, Any] = {}
    for name, files in segment_files.items():
        segments[name] = capture_file_segment(files)

    return {
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "changeName": change_name,
        "project": {"root": str(project.resolve())},
        "worktree": {"root": str(Path(worktree_root).resolve())},
        "git": {"base": base or "", "head": head or ""},
        "segments": segments,
    }


def write_snapshot(change_dir: Path, snapshot: dict[str, Any]) -> Path:
    path = snapshot_path(change_dir)
    write_json(path, snapshot)
    return path


def load_snapshot(change_dir: Path) -> dict[str, Any] | None:
    path = snapshot_path(change_dir)
    if not path.is_file():
        return None
    try:
        data = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def is_segment_stale(
    snapshot: dict[str, Any], segment: str, current_fingerprint: str
) -> bool:
    """某段指纹是否变化。段不存在 → True（需采集）。"""
    segs = snapshot.get("segments") or {}
    seg = segs.get(segment)
    if not isinstance(seg, dict):
        return True
    return seg.get("fingerprint") != current_fingerprint


def refresh_segments(
    change_dir: Path,
    snapshot: dict[str, Any],
    *,
    project: Path,
    worktree_root: Path,
    segment_files: dict[str, list[str]],
    segments: list[str],
) -> dict[str, Any]:
    """只重采指定段；其他段保留原 capturedAt/fingerprint。

    spec §3.6：缓存失效只重采受影响段，不得仅凭缓存跳过代码或验证门禁。
    返回 refreshed snapshot（不写盘；调用方按需 write_snapshot）。
    """
    _ = change_dir  # 预留给未来 write-back
    refreshed = dict(snapshot)
    refreshed["project"] = {"root": str(project.resolve())}
    refreshed["worktree"] = {"root": str(Path(worktree_root).resolve())}
    refreshed_segments = dict(snapshot.get("segments") or {})
    for name in segments:
        files = segment_files.get(name, [])
        refreshed_segments[name] = capture_file_segment(files)
    refreshed["segments"] = refreshed_segments
    refreshed["generatedAt"] = now_iso()
    return refreshed


def _git(project: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(project), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _existing_files(paths: list[Path]) -> list[str]:
    return sorted({str(path.resolve()) for path in paths if path.is_file()})


def discover_segment_files(
    project: Path, change_dir: Path, *, base: str = "", head: str = "HEAD"
) -> dict[str, list[str]]:
    """Discover the compact inputs shared by plan/run/test/review/submit."""
    project = project.resolve()
    rules = [project / "AGENTS.md", project / "CLAUDE.md"]
    for pattern in (
        ".claude/rules/**/*",
        ".cursor/rules/**/*",
        ".codebuddy/rules/**/*",
        ".codebuddy/.rules/**/*",
    ):
        rules.extend(project.glob(pattern))

    profile = [
        project / ".harness/config/build-profile.json",
        project / ".harness/context-index.json",
        project / "project.yaml",
        project / "harness.json",
    ]
    codebase_map = list((project / ".harness/codebase/map").glob("**/*"))
    knowledge = [
        project / ".harness/knowledge/index.json",
        project / ".harness/knowledge/status.json",
        project / ".harness/knowledge/config.json",
    ]
    change_inputs: list[Path] = []
    for folder in ("spec", "plans", "meta"):
        change_inputs.extend((change_dir / folder).glob("**/*"))
    change_inputs = [path for path in change_inputs if path != snapshot_path(change_dir)]

    changed_names: list[str] = []
    if base:
        raw = _git(project, "diff", "--name-only", "--diff-filter=ACMRT", f"{base}..{head}")
        changed_names = [line for line in raw.splitlines() if line.strip()]
    code = [project / name for name in changed_names]
    return {
        "profile": _existing_files(profile),
        "rules": _existing_files(rules),
        "map": _existing_files(codebase_map),
        "knowledge": _existing_files(knowledge),
        "change": _existing_files(change_inputs),
        "code": _existing_files(code),
    }


def capture_current_state(
    *,
    project: Path,
    change_dir: Path,
    change_name: str,
    worktree_root: Path,
    base: str = "",
    head: str = "HEAD",
) -> tuple[dict[str, Any], list[str]]:
    resolved_head = _git(project, "rev-parse", head) or head
    resolved_base = _git(project, "rev-parse", base) if base else ""
    files = discover_segment_files(project, change_dir, base=resolved_base, head=resolved_head)
    previous = load_snapshot(change_dir)
    fresh = capture_snapshot(
        change_dir,
        change_name=change_name,
        project=project,
        worktree_root=worktree_root,
        base=resolved_base,
        head=resolved_head,
        segment_files=files,
    )
    changed: list[str] = []
    baseline_created = previous is None
    unresolved: list[str] = []
    unresolved_reasons: list[dict[str, str]] = []
    if previous:
        old_segments = previous.get("segments") or {}
        for name, segment in fresh["segments"].items():
            old = old_segments.get(name)
            if isinstance(old, dict) and old.get("fingerprint") == segment.get("fingerprint"):
                segment["capturedAt"] = old.get("capturedAt", segment["capturedAt"])
            else:
                changed.append(name)
    # First observation establishes the baseline; it is not evidence that
    # segments changed, nor that they are "unresolved". Segments are only
    # unresolved when they genuinely fail to read/compute (retro §5.6).
    # On first capture, all successfully-captured segments are baseline,
    # not unresolved.
    fresh["baselineCreated"] = baseline_created
    fresh["changedSegments"] = sorted(changed)
    fresh["unresolvedSegments"] = unresolved
    fresh["unresolvedReasons"] = unresolved_reasons
    fresh["comparisonAvailable"] = not baseline_created
    fresh["baselineStatus"] = "created" if baseline_created else "reused"
    write_snapshot(change_dir, fresh)
    return fresh, changed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Capture reusable Harness state")
    sub = parser.add_subparsers(dest="command", required=True)
    capture = sub.add_parser("capture", help="capture or refresh changed segments")
    capture.add_argument("--project", default=".")
    capture.add_argument("--change-dir", required=True)
    capture.add_argument("--change-name")
    capture.add_argument("--worktree-root")
    capture.add_argument("--base", default="")
    capture.add_argument("--head", default="HEAD")
    capture.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project = Path(args.project).resolve()
    change_dir = Path(args.change_dir).resolve()
    name = args.change_name or change_dir.name
    worktree = Path(args.worktree_root).resolve() if args.worktree_root else project
    snapshot, changed = capture_current_state(
        project=project,
        change_dir=change_dir,
        change_name=name,
        worktree_root=worktree,
        base=args.base,
        head=args.head,
    )
    result = {
        "ok": True,
        "path": str(snapshot_path(change_dir)),
        "changedSegments": changed,
        "reusedSegments": sorted(
            set(snapshot["segments"])
            - set(changed)
            - set(snapshot.get("unresolvedSegments") or [])
        ),
        "baselineCreated": bool(snapshot.get("baselineCreated")),
        "baselineStatus": snapshot.get("baselineStatus", "reused"),
        "comparisonAvailable": bool(snapshot.get("comparisonAvailable", True)),
        "unresolvedSegments": list(snapshot.get("unresolvedSegments") or []),
        "unresolvedReasons": list(snapshot.get("unresolvedReasons") or []),
        "git": snapshot["git"],
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"state snapshot: {result['path']}")
        print(f"changed: {', '.join(changed) if changed else 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
