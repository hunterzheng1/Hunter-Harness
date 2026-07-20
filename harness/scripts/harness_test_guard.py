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

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths  # noqa: E402

SCHEMA_VERSION = 1
MODE = "force-track-touched"
MANIFEST_REL = Path("evidence") / "test-tracking.json"
SNAPSHOT_REL = Path("evidence") / "test-guard-snapshot.json"
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
        except (FileExistsError, PermissionError) as exc:
            if time.monotonic() >= deadline:
                raise LockUnavailable(str(path)) from exc
            time.sleep(0.01)
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
        yield
    finally:
        os.close(descriptor)
        path.unlink(missing_ok=True)


def _state_project_root(project: Path) -> Path:
    result = _git(project, "rev-parse", "--git-common-dir")
    if result.returncode != 0 or not result.stdout.strip():
        return project
    common = Path(result.stdout.strip())
    if not common.is_absolute():
        common = project / common
    resolved = common.resolve()
    return resolved.parent if resolved.name == ".git" else project


def _change_dir(project: Path, change_dir: Path | str) -> Path | None:
    state_project = _state_project_root(project)
    candidate = Path(change_dir)
    if not candidate.is_absolute():
        candidate = (
            state_project / candidate
            if candidate.parts[:2] == (".harness", "changes")
            else project / candidate
        )
    resolved = candidate.resolve()
    allowed_roots = {
        (project / ".harness" / "changes").resolve(),
        (state_project / ".harness" / "changes").resolve(),
    }
    return resolved if any(_inside(resolved, root) for root in allowed_roots) else None


def _state_root(change_root: Path) -> Path:
    return Path(harness_paths.resolve_state_dir_for_contract(change_root))


def _manifest_path(change_root: Path) -> Path | None:
    state_root = _state_root(change_root)
    evidence = state_root / MANIFEST_REL.parent
    manifest = state_root / MANIFEST_REL
    expected_evidence = evidence.absolute()
    resolved_evidence = evidence.resolve()
    if (
        not _inside(resolved_evidence, state_root.resolve())
        or os.path.normcase(str(resolved_evidence))
        != os.path.normcase(str(expected_evidence))
    ):
        return None
    return manifest


def _manifest_target_inside(change_root: Path, manifest: Path) -> bool:
    state_root = _state_root(change_root)
    resolved = manifest.resolve()
    return (
        _inside(resolved, state_root.resolve())
        and _inside(resolved, manifest.parent.absolute())
    )


def _profile_config(project: Path) -> tuple[list[str], list[str]] | None:
    profile_path = project / PROFILE_REL
    if not profile_path.is_file():
        return None
    try:
        profile = _read_json(profile_path)
    except (OSError, json.JSONDecodeError):
        return [], []
    tracking = profile.get("testTracking") if isinstance(profile, dict) else None
    paths = tracking.get("paths") if isinstance(tracking, dict) else None
    if not isinstance(paths, list):
        return [], []
    excluded = profile.get("excludedRoots") if isinstance(profile, dict) else None
    excluded_roots = (
        [item.replace("\\", "/").strip("/") for item in excluded if isinstance(item, str) and item]
        if isinstance(excluded, list)
        else []
    )
    patterns = [
        item.replace("\\", "/") for item in paths if isinstance(item, str) and item
    ]
    return patterns, excluded_roots


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
    config = _profile_config(project)
    if config is None:
        return _standard_test_path(rel)
    patterns, excluded_roots = config
    rel_parts = tuple(os.path.normcase(part) for part in rel.split("/"))
    for excluded in excluded_roots:
        excluded_parts = tuple(os.path.normcase(part) for part in excluded.split("/"))
        if rel_parts[: len(excluded_parts)] == excluded_parts:
            return False
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


def _contract_is_v2(change_root: Path) -> bool:
    try:
        contract = harness_paths.load_change_contract(change_root)
    except (OSError, ValueError):
        return False
    if harness_paths.contract_layout_kind(contract) == "split-v1":
        return True
    version = contract.get("schemaVersion")
    return isinstance(version, int) and version >= 2


def _byte_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def logical_file_hash(repo_root: Path, rel: str) -> str:
    """Logical identity for a tracked file (RET-10).

    Text files hash with git blob semantics (path filters/attributes applied,
    so LF/CRLF spellings of one logical text agree). Binary files keep byte
    hash. Indeterminate content falls back to byte hash.
    """
    path = repo_root / rel
    content = path.read_bytes()
    attr = _git(repo_root, "check-attr", "text", "--", rel)
    attr_out = attr.stdout.strip() if attr.returncode == 0 else ""
    if attr_out.endswith(": unset"):
        return _byte_hash(path)
    if b"\x00" in content:
        return _byte_hash(path)
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return _byte_hash(path)
    proc = subprocess.run(
        ["git", "hash-object", "--path", rel, "--stdin"],
        input=content,
        capture_output=True,
        cwd=str(repo_root),
        check=False,
    )
    if proc.returncode != 0:
        return _byte_hash(path)
    return "gitblob:" + proc.stdout.decode("ascii").strip()


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


def _entry_shape_valid_v2(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    if not isinstance(item.get("path"), str) or not item["path"]:
        return False
    logical = item.get("logicalHash")
    binary = item.get("binaryHash")
    logical_ok = isinstance(logical, str) and (
        logical.startswith("gitblob:") or logical.startswith("sha256:")
    )
    binary_ok = binary is None or (
        isinstance(binary, str) and binary.startswith("sha256:")
    )
    if not (logical_ok or binary_ok):
        return False
    if item.get("reason") not in REASONS:
        return False
    if type(item.get("ignored")) is not bool:
        return False
    if not isinstance(item.get("introducedBy"), str) or not item["introducedBy"]:
        return False
    touched = item.get("touchedBy")
    if not isinstance(touched, list) or not all(isinstance(t, str) for t in touched):
        return False
    return item.get("commitScope") in ("current-change", "foreign-change")


def _validate_existing_manifest_v2(
    project: Path,
    manifest: Any,
    *,
    allow_hash_drift: set[str] | None = None,
    require_files: bool,
) -> tuple[str | None, dict[str, dict[str, Any]]]:
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 2
        or manifest.get("mode") != MODE
    ):
        return "MANIFEST_INVALID", {}
    repository_id = manifest.get("repositoryId")
    if not isinstance(repository_id, str) or not repository_id.startswith("sha256:"):
        return "MANIFEST_INVALID", {}
    if repository_id != harness_paths.repository_identity(project):
        return "MANIFEST_PROJECT_MISMATCH", {}
    entries = manifest.get("files")
    if not isinstance(entries, list):
        return "MANIFEST_INVALID", {}
    if require_files and not entries:
        return "EMPTY_MANIFEST", {}

    allowed_drift = allow_hash_drift or set()
    validated: dict[str, dict[str, Any]] = {}
    for item in entries:
        if not _entry_shape_valid_v2(item):
            return "MANIFEST_INVALID", {}
        rel = item["path"]
        if rel in validated:
            return "MANIFEST_INVALID", {}
        path, normalized, error = _validate_file(project, rel)
        if error or normalized != rel or path is None:
            return error or "MANIFEST_INVALID", {}
        expected = item.get("logicalHash") or item.get("binaryHash")
        if expected != logical_file_hash(project, rel) and rel not in allowed_drift:
            return "HASH_DRIFT" if require_files else "MANIFEST_INVALID", {}
        ignored_now = _is_ignored(project, rel)
        if item["ignored"] != ignored_now:
            return "MANIFEST_INVALID", {}
        validated[rel] = dict(item)
    return None, validated


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
        checkpointed = not item["trackedBefore"] and tracked_now
        if (
            item["trackedBefore"] != tracked_now and not checkpointed
        ) or (
            item["ignored"] != ignored_now and not checkpointed
        ):
            return "MANIFEST_INVALID", {}
        normalized_item = dict(item)
        if checkpointed:
            normalized_item["trackedBefore"] = True
            normalized_item["ignored"] = ignored_now
        validated[rel] = normalized_item
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

    manifest_path = _manifest_path(change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])
    lock_path = manifest_path.with_name(manifest_path.name + ".lock")
    try:
        with _exclusive_lock(lock_path, wait_seconds=5.0):
            if not _manifest_target_inside(change_root, manifest_path):
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
                validator = (
                    _validate_existing_manifest_v2
                    if isinstance(existing, dict) and existing.get("schemaVersion") == 2
                    else _validate_existing_manifest
                )
                error, existing_files = validator(
                    project_root,
                    existing,
                    allow_hash_drift={rel for _, rel in validated},
                    require_files=False,
                )
                if error:
                    return _result(False, action, error, [])

            if _contract_is_v2(change_root):
                change_id = change_root.name
                for path, rel in validated:
                    ignored = _is_ignored(project_root, rel)
                    previous = existing_files.get(rel, {})
                    touched = [
                        item for item in previous.get("touchedBy", [])
                        if isinstance(item, str)
                    ]
                    if change_id not in touched:
                        touched.append(change_id)
                    digest = logical_file_hash(project_root, rel)
                    existing_files[rel] = {
                        "path": rel,
                        "logicalHash": digest,
                        "binaryHash": None if digest.startswith("gitblob:") else digest,
                        "reason": reason,
                        "ignored": ignored,
                        "introducedBy": previous.get("introducedBy", change_id),
                        "touchedBy": touched,
                        "commitScope": "current-change",
                    }
                manifest = {
                    "schemaVersion": 2,
                    "repositoryId": harness_paths.repository_identity(project_root),
                    "mode": MODE,
                    "files": [existing_files[key] for key in sorted(existing_files)],
                }
            else:
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


def rehome(
    from_project: Path | str,
    to_project: Path | str,
    change_dir: Path | str,
    expected_head: str,
) -> dict[str, Any]:
    """Atomically hand test ownership from a merged feature worktree to target."""
    action = "rehome"
    from_root = Path(from_project).resolve()
    to_root = Path(to_project).resolve()
    if not from_root.is_dir() or not to_root.is_dir():
        return _result(False, action, "PROJECT_ROOT_MISSING", [])
    if harness_paths.repository_identity(from_root) != harness_paths.repository_identity(to_root):
        return _result(False, action, "REPOSITORY_MISMATCH", [])
    to_head_result = _git(to_root, "rev-parse", "--verify", "HEAD")
    to_head = to_head_result.stdout.strip() if to_head_result.returncode == 0 else ""
    if not expected_head or to_head != expected_head:
        return _result(
            False, action, "EXPECTED_HEAD_MISMATCH", [],
            expectedHead=expected_head, actualHead=to_head,
        )
    from_head_result = _git(from_root, "rev-parse", "--verify", "HEAD")
    from_head = from_head_result.stdout.strip() if from_head_result.returncode == 0 else ""
    from_tree_result = _git(from_root, "rev-parse", "HEAD^{tree}")
    to_tree_result = _git(to_root, "rev-parse", f"{expected_head}^{{tree}}")
    from_tree = from_tree_result.stdout.strip() if from_tree_result.returncode == 0 else ""
    to_tree = to_tree_result.stdout.strip() if to_tree_result.returncode == 0 else ""
    if not from_tree or from_tree != to_tree:
        return _result(
            False, action, "TREE_MISMATCH", [],
            fromHead=from_head, toHead=to_head, fromTree=from_tree, toTree=to_tree,
        )

    change_root = _change_dir(from_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    manifest_path = _manifest_path(change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])
    lock_path = manifest_path.with_name(manifest_path.name + ".lock")
    try:
        with _exclusive_lock(lock_path, wait_seconds=5.0):
            try:
                manifest = _read_json(manifest_path)
            except FileNotFoundError:
                return _result(False, action, "MANIFEST_MISSING", [])
            except (OSError, json.JSONDecodeError) as exc:
                return _result(False, action, "MANIFEST_INVALID", [], error=str(exc))
            is_v2 = isinstance(manifest, dict) and manifest.get("schemaVersion") == 2
            entries = manifest.get("files") if isinstance(manifest, dict) else None
            if not isinstance(entries, list):
                return _result(False, action, "MANIFEST_INVALID", [])
            if not is_v2 and (
                manifest.get("schemaVersion") != SCHEMA_VERSION
                or manifest.get("mode") != MODE
                or manifest.get("projectRoot") != str(from_root)
            ):
                return _result(False, action, "MANIFEST_PROJECT_MISMATCH", [])
            if is_v2:
                error, validated = _validate_existing_manifest_v2(
                    from_root, manifest, require_files=False
                )
                if error:
                    return _result(False, action, error, [])
            else:
                validated: dict[str, dict[str, Any]] = {}
                for item in entries:
                    if not _entry_shape_valid(item):
                        return _result(False, action, "MANIFEST_INVALID", [])
                    rel = item["path"]
                    source, normalized, error = _validate_file(from_root, rel)
                    if error or normalized != rel or source is None:
                        return _result(False, action, error or "MANIFEST_INVALID", [rel])
                    if item["sha256"] != _sha256(source):
                        return _result(False, action, "HASH_DRIFT", [rel])
                    validated[rel] = dict(item)

            updated = json.loads(json.dumps(manifest))
            updated_entries: list[dict[str, Any]] = []
            for rel, item in sorted(validated.items()):
                target, normalized, error = _validate_file(to_root, rel)
                if error or normalized != rel or target is None:
                    return _result(False, action, "TARGET_CONTENT_MISMATCH", [rel])
                replacement = dict(item)
                if is_v2:
                    digest = logical_file_hash(to_root, rel)
                    source_digest = item.get("logicalHash") or item.get("binaryHash")
                    if digest != source_digest:
                        return _result(False, action, "TARGET_CONTENT_MISMATCH", [rel])
                    replacement["logicalHash"] = digest
                    replacement["binaryHash"] = (
                        None if digest.startswith("gitblob:") else digest
                    )
                    replacement["ignored"] = _is_ignored(to_root, rel)
                else:
                    digest = _sha256(target)
                    if digest != item["sha256"]:
                        return _result(False, action, "TARGET_CONTENT_MISMATCH", [rel])
                    replacement["sha256"] = digest
                    replacement["ignored"] = _is_ignored(to_root, rel)
                    replacement["trackedBefore"] = (
                        _git(to_root, "ls-files", "--error-unmatch", "--", rel).returncode == 0
                    )
                updated_entries.append(replacement)

            before_hash = _sha256(manifest_path)
            handoff_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            handoff_id = "handoff-" + hashlib.sha256(
                f"{from_root}\0{to_root}\0{from_head}\0{to_head}".encode("utf-8")
            ).hexdigest()[:20]
            handoffs = updated.get("handoffs")
            if handoffs is None:
                handoffs = []
            if not isinstance(handoffs, list):
                return _result(False, action, "MANIFEST_INVALID", [])
            handoff = {
                "id": handoff_id,
                "fromRoot": str(from_root),
                "toRoot": str(to_root),
                "fromHead": from_head,
                "toHead": to_head,
                "expectedHead": expected_head,
                "treeHash": to_tree,
                "at": handoff_at,
                "manifestHashBefore": before_hash,
            }
            if not any(isinstance(item, dict) and item.get("id") == handoff_id for item in handoffs):
                handoffs.append(handoff)
            updated["files"] = updated_entries
            updated["projectRoot"] = str(to_root)
            updated["head"] = to_head
            updated["handoffs"] = handoffs
            _write_json(manifest_path, updated)
            after_hash = _sha256(manifest_path)
    except LockUnavailable:
        return _result(False, action, "MANIFEST_LOCKED", [])
    return _result(
        True,
        action,
        "REHOMED",
        sorted(validated),
        fromRoot=str(from_root),
        toRoot=str(to_root),
        fromHead=from_head,
        toHead=to_head,
        treeHash=to_tree,
        handoffId=handoff_id,
        manifestHashBefore=before_hash,
        manifestHashAfter=after_hash,
        manifestPath=str(manifest_path),
    )


def _stage_locked(
    project_root: Path, change_root: Path, manifest_path: Path, index_path: Path
) -> dict[str, Any]:
    action = "stage"
    if not _manifest_target_inside(change_root, manifest_path):
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])
    try:
        manifest = _read_json(manifest_path)
    except FileNotFoundError:
        return _result(False, action, "MANIFEST_MISSING", [])
    except (OSError, json.JSONDecodeError) as exc:
        return _result(False, action, "MANIFEST_INVALID", [], error=str(exc))
    is_v2 = isinstance(manifest, dict) and manifest.get("schemaVersion") == 2
    validator = _validate_existing_manifest_v2 if is_v2 else _validate_existing_manifest
    error, entries = validator(project_root, manifest, require_files=True)
    if error:
        return _result(False, action, error, [])
    rels: list[str] = []
    for rel, entry in entries.items():
        if is_v2:
            if entry.get("commitScope") == "current-change":
                rels.append(rel)
            continue
        if not entry["trackedBefore"]:
            rels.append(rel)
            continue
        changed = _git(project_root, "diff", "--quiet", "HEAD", "--", rel)
        if changed.returncode == 1:
            rels.append(rel)
        elif changed.returncode != 0:
            return _result(
                False,
                action,
                "GIT_DIFF_FAILED",
                [rel],
                error=changed.stderr.strip(),
            )
    if not rels:
        return _result(True, action, "STAGED", [])

    before_cached_result = _git(project_root, "diff", "--cached", "--name-only")
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
        added = _git(project_root, "add", "-f", "--", *rels, index_file=temp_index)
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


def _path_is_excluded(rel: str, excluded_roots: list[str]) -> bool:
    rel_parts = tuple(os.path.normcase(part) for part in rel.split("/") if part)
    for excluded in excluded_roots:
        excluded_parts = tuple(
            os.path.normcase(part) for part in excluded.split("/") if part
        )
        if excluded_parts and rel_parts[: len(excluded_parts)] == excluded_parts:
            return True
    return False


def _walk_matching_files(
    base: Path, patterns: list[str], excluded_roots: list[str]
) -> list[Path]:
    """Walk once and prune excluded roots before matching recursive globs."""
    matches: list[Path] = []
    for root_raw, dir_names, file_names in os.walk(base, followlinks=False):
        root = Path(root_raw)
        root_rel = root.relative_to(base).as_posix()
        prefix = "" if root_rel == "." else root_rel + "/"
        dir_names[:] = [
            name
            for name in dir_names
            if not _path_is_excluded(prefix + name, excluded_roots)
        ]
        for name in file_names:
            rel = prefix + name
            if _path_is_excluded(rel, excluded_roots):
                continue
            if any(_matches_pattern(rel, pattern) for pattern in patterns):
                matches.append(root / name)
    return matches


def _enumerate_allowed_test_files(project_root: Path) -> dict[str, str]:
    """Map repo-relative test path -> sha256 for all allowed existing files."""
    found: dict[str, str] = {}
    config = _profile_config(project_root)
    if config is None:
        patterns = ["test/**", "tests/**", "src/test/**"]
        excluded_roots = [
            ".git", ".harness", "node_modules", "dist", "build", "__pycache__"
        ]
    else:
        patterns, excluded_roots = config
    base = project_root.resolve()
    seen: set[str] = set()
    for match in _walk_matching_files(base, patterns, excluded_roots):
        resolved = match.resolve()
        if not _inside(resolved, base):
            continue
        rel = resolved.relative_to(base).as_posix()
        if rel in seen or not _allowed_test_path(project_root, rel):
            continue
        seen.add(rel)
        found[rel] = _sha256(resolved)
    return found


def begin(project: Path | str, change_dir: Path | str) -> dict[str, Any]:
    action = "begin"
    project_root = Path(project).resolve()
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    manifest_path = _manifest_path(change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])
    snapshot_path = _state_root(change_root) / SNAPSHOT_REL
    if not _manifest_target_inside(change_root, snapshot_path):
        return _result(False, action, "SNAPSHOT_PATH_OUTSIDE_PROJECT", [])

    if snapshot_path.is_file():
        try:
            snapshot = _read_json(snapshot_path)
        except (OSError, json.JSONDecodeError) as exc:
            return _result(False, action, "SNAPSHOT_INVALID", [], error=str(exc))
        entries = snapshot.get("files") if isinstance(snapshot, dict) else None
        if (
            not isinstance(snapshot, dict)
            or snapshot.get("schemaVersion") != SCHEMA_VERSION
            or snapshot.get("mode") != MODE
            or snapshot.get("projectRoot") != str(project_root)
            or not isinstance(entries, list)
            or any(not isinstance(item, dict) or not isinstance(item.get("path"), str)
                   for item in entries)
        ):
            return _result(False, action, "SNAPSHOT_INVALID", [])
        return _result(
            True,
            action,
            "SNAPSHOT_REUSED",
            [item["path"] for item in entries],
            snapshotPath=str(snapshot_path),
            fileCount=len(entries),
        )

    files = _enumerate_allowed_test_files(project_root)
    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "mode": MODE,
        "projectRoot": str(project_root),
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "files": [
            {"path": rel, "sha256": digest, "ignored": _is_ignored(project_root, rel)}
            for rel, digest in sorted(files.items())
        ],
    }
    _write_json(snapshot_path, snapshot)
    return _result(
        True,
        action,
        "SNAPSHOT_CAPTURED",
        list(files),
        snapshotPath=str(snapshot_path),
        fileCount=len(files),
    )


def close(project: Path | str, change_dir: Path | str) -> dict[str, Any]:
    action = "close"
    project_root = Path(project).resolve()
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    snapshot_path = _state_root(change_root) / SNAPSHOT_REL
    if not snapshot_path.is_file():
        return _result(False, action, "SNAPSHOT_MISSING", [])
    try:
        snapshot = _read_json(snapshot_path)
    except (OSError, json.JSONDecodeError) as exc:
        return _result(False, action, "SNAPSHOT_INVALID", [], error=str(exc))
    if (
        not isinstance(snapshot, dict)
        or snapshot.get("schemaVersion") != SCHEMA_VERSION
    ):
        return _result(False, action, "SNAPSHOT_INVALID", [])
    # Execution-root contract (retro §5.10): a snapshot captured against a
    # different project root must fail with EXECUTION_ROOT_MISMATCH before
    # the generic SNAPSHOT_INVALID, so callers can distinguish "wrong root"
    # from "corrupt snapshot".
    snapshot_root = snapshot.get("projectRoot")
    if snapshot_root is not None and snapshot_root != str(project_root):
        return _result(
            False,
            action,
            "EXECUTION_ROOT_MISMATCH",
            [],
            expectedRoot=snapshot_root,
            actualRoot=str(project_root),
        )

    before_entries = snapshot.get("files")
    if not isinstance(before_entries, list):
        return _result(False, action, "SNAPSHOT_INVALID", [])
    before: dict[str, dict[str, Any]] = {}
    for item in before_entries:
        if not isinstance(item, dict):
            return _result(False, action, "SNAPSHOT_INVALID", [])
        rel = item.get("path")
        digest = item.get("sha256")
        if not isinstance(rel, str) or not rel or not isinstance(digest, str):
            return _result(False, action, "SNAPSHOT_INVALID", [])
        path, normalized, error = _validate_file(project_root, rel)
        if error:
            return _result(False, action, error, [rel])
        if normalized != rel or path is None:
            return _result(False, action, "PATH_ESCAPE", [rel])
        before[rel] = item

    current = _enumerate_allowed_test_files(project_root)
    for rel in current:
        path, normalized, error = _validate_file(project_root, rel)
        if error:
            return _result(False, action, error, [rel])
        if normalized != rel or path is None:
            return _result(False, action, "PATH_ESCAPE", [rel])

    touched: list[tuple[str, str]] = []
    for rel, digest in current.items():
        if rel not in before:
            touched.append((rel, "tdd-created"))
            continue
        if before[rel]["sha256"] != digest:
            touched.append((rel, "test-updated"))

    for reason in ("tdd-created", "test-updated"):
        rels = [rel for rel, item_reason in touched if item_reason == reason]
        if not rels:
            continue
        result = record(
            project_root,
            change_root,
            [str(project_root / rel) for rel in rels],
            reason,
        )
        if not result.get("ok"):
            code = result.get("code", "RECORD_FAILED")
            if code == "TEST_PATH_NOT_ALLOWED":
                return _result(False, action, "UNCLASSIFIABLE_TEST", rels)
            return result

    recorded = [rel for rel, _ in touched]

    # Cross-check (retro §5.10): if the manifest has active entries for this
    # change but close computed recordedCount=0, the snapshot/manifest/diff
    # are inconsistent. Fail closed instead of silently returning success.
    manifest_path = _manifest_path(change_root)
    if manifest_path is not None and manifest_path.is_file():
        try:
            manifest = _read_json(manifest_path)
        except (OSError, json.JSONDecodeError):
            manifest = None
        if isinstance(manifest, dict):
            manifest_files = manifest.get("files")
            if isinstance(manifest_files, list):
                active_entries = [
                    f for f in manifest_files
                    if isinstance(f, dict)
                    and f.get("reason") in ("tdd-created", "test-updated", "stale-test-repair")
                ]
                if active_entries and not recorded:
                    return _result(
                        False,
                        action,
                        "MANIFEST_DIFF_HASH_MISMATCH",
                        [],
                        manifestEntries=len(active_entries),
                        recordedCount=0,
                        detail="manifest has active entries but close computed 0 recorded tests",
                    )

    return _result(
        True,
        action,
        "CLOSED",
        recorded,
        recordedCount=len(recorded),
        unchangedPreexisting=len(before) - sum(1 for rel, _ in touched if rel in before),
    )


def mark(
    project: Path | str,
    change_dir: Path | str,
    files: list[str],
) -> dict[str, Any]:
    return record(project, change_dir, files, "stale-test-repair")


def stage(project: Path | str, change_dir: Path | str) -> dict[str, Any]:
    action = "stage"
    project_root = Path(project).resolve()
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    manifest_path = _manifest_path(change_root)
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
                    return _stage_locked(
                        project_root, change_root, manifest_path, index_path
                    )
            except LockUnavailable:
                return _result(False, action, "MANIFEST_LOCKED", [])
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
    begin_parser = sub.add_parser("begin")
    begin_parser.add_argument("--project", required=True)
    begin_parser.add_argument("--change-dir", required=True)
    begin_parser.add_argument("--json", action="store_true")
    close_parser = sub.add_parser("close")
    close_parser.add_argument("--project", required=True)
    close_parser.add_argument("--change-dir", required=True)
    close_parser.add_argument("--json", action="store_true")
    rehome_parser = sub.add_parser("rehome")
    rehome_parser.add_argument("--from", dest="from_project", required=True)
    rehome_parser.add_argument("--to", dest="to_project", required=True)
    rehome_parser.add_argument("--change-dir", required=True)
    rehome_parser.add_argument("--expected-head", required=True)
    rehome_parser.add_argument("--json", action="store_true")
    mark_parser = sub.add_parser("mark")
    mark_parser.add_argument("--project", required=True)
    mark_parser.add_argument("--change-dir", required=True)
    mark_parser.add_argument("--files", required=True)
    mark_parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.action == "record":
        files = [item.strip() for item in args.files.split(",") if item.strip()]
        result = record(args.project, args.change_dir, files, args.reason)
    elif args.action == "begin":
        result = begin(args.project, args.change_dir)
    elif args.action == "close":
        result = close(args.project, args.change_dir)
    elif args.action == "mark":
        files = [item.strip() for item in args.files.split(",") if item.strip()]
        result = mark(args.project, args.change_dir, files)
    elif args.action == "rehome":
        result = rehome(
            args.from_project, args.to_project, args.change_dir, args.expected_head
        )
    else:
        result = stage(args.project, args.change_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
