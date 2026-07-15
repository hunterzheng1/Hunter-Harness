#!/usr/bin/env python3
"""Record and force-stage only explicitly touched test files.

Python 3.10+ stdlib only. Git is always invoked with an argv list.
"""

from __future__ import annotations

import argparse
import contextlib
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MODE = "force-track-touched"
MANIFEST_REL = Path("evidence") / "test-tracking.json"
PROFILE_REL = Path(".harness") / "config" / "build-profile.json"
REASONS = ("tdd-created", "stale-test-repair", "test-updated")


class LockUnavailable(RuntimeError):
    """A compatible lock file is already held by another process."""

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def _result(ok: bool, action: str, code: str, files: list[str], **extra: Any) -> dict[str, Any]:
    return {"ok": ok, "action": action, "code": code, "files": files, **extra}


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _git(
    project: Path,
    *args: str,
    index_file: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if index_file is not None:
        env["GIT_INDEX_FILE"] = str(index_file)
    return subprocess.run(
        [
            "git",
            "--literal-pathspecs",
            "-c",
            "core.quotepath=false",
            "-C",
            str(project),
            *args,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
        env=env,
    )


def _is_ignored(project: Path, rel: str) -> bool:
    status = _git(
        project,
        "status",
        "--ignored=matching",
        "--untracked-files=all",
        "--porcelain=v1",
        "--",
        rel,
    )
    return status.returncode == 0 and any(
        line.startswith("!! ") for line in status.stdout.splitlines()
    )


def _inside(path: Path, root: Path) -> bool:
    try:
        normalized_path = os.path.normcase(str(path))
        normalized_root = os.path.normcase(str(root))
        return os.path.commonpath((normalized_path, normalized_root)) == normalized_root
    except ValueError:
        return False


@contextlib.contextmanager
def _exclusive_lock(path: Path, *, wait_seconds: float) -> Any:
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + wait_seconds
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            if time.monotonic() >= deadline:
                raise LockUnavailable(str(path)) from exc
            time.sleep(0.01)
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
        yield
    finally:
        os.close(descriptor)
        path.unlink(missing_ok=True)


def _change_dir(project: Path, change_dir: Path | str) -> Path | None:
    candidate = Path(change_dir)
    if not candidate.is_absolute():
        candidate = project / candidate
    resolved = candidate.resolve()
    return resolved if _inside(resolved, project) else None


def _manifest_path(project: Path, change_root: Path) -> Path | None:
    evidence = change_root / MANIFEST_REL.parent
    manifest = change_root / MANIFEST_REL
    for candidate in (change_root, evidence):
        if not _inside(candidate.resolve(), project):
            return None
    return manifest


def _profile_patterns(project: Path) -> list[str] | None:
    profile_path = project / PROFILE_REL
    if not profile_path.is_file():
        return None
    try:
        profile = _read_json(profile_path)
    except (OSError, json.JSONDecodeError):
        return []
    tracking = profile.get("testTracking") if isinstance(profile, dict) else None
    paths = tracking.get("paths") if isinstance(tracking, dict) else None
    if not isinstance(paths, list):
        return []
    return [item.replace("\\", "/") for item in paths if isinstance(item, str) and item]


def _matches_pattern(rel: str, pattern: str) -> bool:
    # fnmatch does not give **/ its usual zero-or-more-directory meaning, so
    # also try the form with every **/ removed.
    if fnmatch.fnmatchcase(rel, pattern):
        return True
    compact = pattern
    while "**/" in compact:
        compact = compact.replace("**/", "", 1)
        if fnmatch.fnmatchcase(rel, compact):
            return True
    if pattern.endswith("/**"):
        prefix = pattern[:-3].rstrip("/")
        return rel == prefix or rel.startswith(prefix + "/")
    return False


def _standard_test_path(rel: str) -> bool:
    parts = rel.split("/")
    if len(parts) >= 2 and parts[0] in ("test", "tests"):
        return True
    if any(parts[index:index + 2] == ["src", "test"] for index in range(len(parts) - 1)):
        return True
    return False


def _allowed_test_path(project: Path, rel: str) -> bool:
    patterns = _profile_patterns(project)
    if patterns is None:
        return _standard_test_path(rel)
    return any(_matches_pattern(rel, pattern) for pattern in patterns)


def _validate_file(project: Path, raw: str) -> tuple[Path | None, str | None, str | None]:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = project / candidate
    resolved = candidate.resolve()
    if not _inside(resolved, project):
        return None, None, "PATH_OUTSIDE_PROJECT"
    if not resolved.exists():
        return None, None, "FILE_NOT_FOUND"
    if not resolved.is_file():
        return None, None, "NOT_REGULAR_FILE"
    rel = resolved.relative_to(project).as_posix()
    if not _allowed_test_path(project, rel):
        return None, rel, "TEST_PATH_NOT_ALLOWED"
    return resolved, rel, None


def _entry_shape_valid(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and isinstance(item.get("path"), str)
        and bool(item["path"])
        and isinstance(item.get("sha256"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", item["sha256"]) is not None
        and item.get("reason") in REASONS
        and type(item.get("ignored")) is bool
        and type(item.get("trackedBefore")) is bool
    )


def _validate_existing_manifest(
    project: Path,
    manifest: Any,
    *,
    allow_hash_drift: set[str] | None = None,
    require_files: bool,
) -> tuple[str | None, dict[str, dict[str, Any]]]:
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != SCHEMA_VERSION
        or manifest.get("mode") != MODE
    ):
        return "MANIFEST_INVALID", {}
    if manifest.get("projectRoot") != str(project):
        return "MANIFEST_PROJECT_MISMATCH", {}
    entries = manifest.get("files")
    if not isinstance(entries, list):
        return "MANIFEST_INVALID", {}
    if require_files and not entries:
        return "EMPTY_MANIFEST", {}

    allowed_drift = allow_hash_drift or set()
    validated: dict[str, dict[str, Any]] = {}
    for item in entries:
        if not _entry_shape_valid(item):
            return "MANIFEST_INVALID", {}
        rel = item["path"]
        if rel in validated:
            return "MANIFEST_INVALID", {}
        path, normalized, error = _validate_file(project, rel)
        if error or normalized != rel or path is None:
            return error or "MANIFEST_INVALID", {}
        if item["sha256"] != _sha256(path) and rel not in allowed_drift:
            return "HASH_DRIFT" if require_files else "MANIFEST_INVALID", {}
        ignored_now = _is_ignored(project, rel)
        tracked_now = _git(
            project, "ls-files", "--error-unmatch", "--", rel
        ).returncode == 0
        if item["ignored"] != ignored_now or item["trackedBefore"] != tracked_now:
            return "MANIFEST_INVALID", {}
        validated[rel] = dict(item)
    return None, validated


def record(
    project: Path | str,
    change_dir: Path | str,
    files: list[str],
    reason: str,
) -> dict[str, Any]:
    action = "record"
    project_root = Path(project).resolve()
    if not files:
        return _result(False, action, "EMPTY_FILES", [])
    if reason not in REASONS:
        return _result(False, action, "INVALID_REASON", [])
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])

    validated: list[tuple[Path, str]] = []
    for raw in files:
        path, rel, error = _validate_file(project_root, raw)
        if error:
            return _result(False, action, error, [rel or str(raw)])
        assert path is not None and rel is not None
        validated.append((path, rel))

    manifest_path = _manifest_path(project_root, change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])
    lock_path = manifest_path.with_name(manifest_path.name + ".lock")
    try:
        with _exclusive_lock(lock_path, wait_seconds=5.0):
            if not _inside(manifest_path.resolve(), project_root):
                return _result(
                    False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", []
                )
            existing_files: dict[str, dict[str, Any]] = {}
            if manifest_path.is_file():
                try:
                    existing = _read_json(manifest_path)
                except (OSError, json.JSONDecodeError) as exc:
                    return _result(
                        False, action, "MANIFEST_INVALID", [], error=str(exc)
                    )
                error, existing_files = _validate_existing_manifest(
                    project_root,
                    existing,
                    allow_hash_drift={rel for _, rel in validated},
                    require_files=False,
                )
                if error:
                    return _result(False, action, error, [])

            for path, rel in validated:
                ignored = _is_ignored(project_root, rel)
                tracked = _git(
                    project_root, "ls-files", "--error-unmatch", "--", rel
                ).returncode == 0
                existing_files[rel] = {
                    "path": rel,
                    "sha256": _sha256(path),
                    "reason": reason,
                    "ignored": ignored,
                    "trackedBefore": tracked,
                }

            manifest = {
                "schemaVersion": SCHEMA_VERSION,
                "mode": MODE,
                "projectRoot": str(project_root),
                "files": [existing_files[key] for key in sorted(existing_files)],
            }
            _write_json(manifest_path, manifest)
    except LockUnavailable:
        return _result(False, action, "MANIFEST_LOCKED", [])
    return _result(True, action, "RECORDED", [rel for _, rel in validated], manifestPath=str(manifest_path))


def stage(project: Path | str, change_dir: Path | str) -> dict[str, Any]:
    action = "stage"
    project_root = Path(project).resolve()
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    manifest_path = _manifest_path(project_root, change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])

    index_result = _git(project_root, "rev-parse", "--git-path", "index")
    if index_result.returncode != 0 or not index_result.stdout.strip():
        return _result(False, action, "GIT_INDEX_NOT_FOUND", [])
    index_path = Path(index_result.stdout.strip())
    if not index_path.is_absolute():
        index_path = (project_root / index_path).resolve()
    index_path.parent.mkdir(parents=True, exist_ok=True)

    index_lock = index_path.with_name(index_path.name + ".lock")
    try:
        with _exclusive_lock(index_lock, wait_seconds=0.0):
            manifest_lock = manifest_path.with_name(manifest_path.name + ".lock")
            try:
                with _exclusive_lock(manifest_lock, wait_seconds=0.0):
                    if not _inside(manifest_path.resolve(), project_root):
                        return _result(
                            False,
                            action,
                            "MANIFEST_PATH_OUTSIDE_PROJECT",
                            [],
                        )
                    try:
                        manifest = _read_json(manifest_path)
                    except FileNotFoundError:
                        return _result(False, action, "MANIFEST_MISSING", [])
                    except (OSError, json.JSONDecodeError) as exc:
                        return _result(
                            False,
                            action,
                            "MANIFEST_INVALID",
                            [],
                            error=str(exc),
                        )
                    error, entries = _validate_existing_manifest(
                        project_root, manifest, require_files=True
                    )
            except LockUnavailable:
                return _result(False, action, "MANIFEST_LOCKED", [])
            if error:
                return _result(False, action, error, [])
            rels = list(entries)

            before_cached_result = _git(
                project_root, "diff", "--cached", "--name-only"
            )
            if before_cached_result.returncode != 0:
                return _result(False, action, "CACHED_DIFF_FAILED", rels)
            before_cached = set(before_cached_result.stdout.splitlines())

            handle, temp_name = tempfile.mkstemp(
                prefix=f".{index_path.name}.test-guard.", dir=index_path.parent
            )
            os.close(handle)
            temp_index = Path(temp_name)
            temp_index.unlink(missing_ok=True)
            try:
                if index_path.is_file():
                    shutil.copy2(index_path, temp_index)
                added = _git(
                    project_root, "add", "-f", "--", *rels, index_file=temp_index
                )
                if added.returncode != 0:
                    return _result(
                        False,
                        action,
                        "GIT_ADD_FAILED",
                        rels,
                        error=added.stderr.strip(),
                    )
                cached = _git(
                    project_root,
                    "diff",
                    "--cached",
                    "--name-only",
                    index_file=temp_index,
                )
                if cached.returncode != 0:
                    return _result(False, action, "CACHED_DIFF_FAILED", rels)
                after_cached = set(cached.stdout.splitlines())
                missing = [rel for rel in rels if rel not in after_cached]
                unexpected = sorted((after_cached - before_cached) - set(rels))
                if missing or unexpected:
                    return _result(
                        False,
                        action,
                        "CACHED_DIFF_MISMATCH",
                        missing or unexpected,
                    )
                os.replace(temp_index, index_path)
                return _result(True, action, "STAGED", rels)
            finally:
                temp_index.unlink(missing_ok=True)
    except LockUnavailable:
        return _result(False, action, "INDEX_LOCKED", [])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    record_parser = sub.add_parser("record")
    record_parser.add_argument("--project", required=True)
    record_parser.add_argument("--change-dir", required=True)
    record_parser.add_argument("--files", required=True)
    record_parser.add_argument("--reason", required=True, choices=REASONS)
    record_parser.add_argument("--json", action="store_true")
    stage_parser = sub.add_parser("stage")
    stage_parser.add_argument("--project", required=True)
    stage_parser.add_argument("--change-dir", required=True)
    stage_parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.action == "record":
        files = [item.strip() for item in args.files.split(",") if item.strip()]
        result = record(args.project, args.change_dir, files, args.reason)
    else:
        result = stage(args.project, args.change_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
