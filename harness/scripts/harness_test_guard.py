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
MANDATORY_EXCLUDED_ROOTS = (
    ".git",
    ".harness",
    ".worktrees",
    ".claude/worktrees",
    ".codex/worktrees",
    ".cursor/worktrees",
    ".codebuddy/worktrees",
    ".codeium/worktrees",
    "target",
    "build",
    "dist",
    "node_modules",
    ".gradle",
    "__pycache__",
    ".pytest_cache",
    ".cache",
)
REASONS = ("tdd-created", "stale-test-repair", "test-updated")


class LockUnavailable(RuntimeError):
    """A compatible lock file is already held by another process."""


class ProfileConfigInvalid(ValueError):
    """The selected project-owned test-tracking profile is malformed."""


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


def _invalid_project_root(
    action: str, project: Path | str, resolved: Path
) -> dict[str, Any] | None:
    """Reject a --project that is not an existing directory.

    Passing the *project name* (``--project udp``) instead of its path used to
    resolve to ``<cwd>/udp`` and then surface as SNAPSHOT_MISSING — an error
    that points at the wrong thing entirely. Fail here with the resolved path
    so the real mistake is visible.
    """
    if resolved.is_dir():
        return None
    return _result(
        False,
        action,
        "PROJECT_ROOT_INVALID",
        [],
        project=str(project),
        resolvedProject=str(resolved),
        hint=(
            "--project takes a filesystem path to the project root "
            "(use '.' when running from it), not the project name"
        ),
    )


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


def _profile_config(
    project: Path,
    *,
    strict: bool = False,
) -> tuple[list[str], list[str]] | None:
    def invalid(message: str) -> tuple[list[str], list[str]]:
        if strict:
            raise ProfileConfigInvalid(message)
        return [], []

    local_profile = project / PROFILE_REL
    if os.path.lexists(local_profile):
        profile_path = local_profile
        if not profile_path.is_file():
            return invalid(f"{PROFILE_REL.as_posix()} is not a regular file")
    else:
        state_project = _state_project_root(project)
        common_root = harness_paths.common_root(project)
        common_profile = state_project / PROFILE_REL
        if (
            state_project == project
            or state_project != common_root
            or not os.path.lexists(common_profile)
        ):
            return None
        if not common_profile.is_file():
            return invalid(
                f"common {PROFILE_REL.as_posix()} is not a regular file"
            )
        profile_path = common_profile
    try:
        profile = _read_json(profile_path)
    except (OSError, json.JSONDecodeError) as exc:
        return invalid(f"cannot read {profile_path}: {exc}")
    if not isinstance(profile, dict):
        return invalid(f"{profile_path} must contain a JSON object")
    tracking = profile.get("testTracking")
    if not isinstance(tracking, dict):
        return invalid(f"{profile_path} testTracking must be an object")
    paths = tracking.get("paths") if isinstance(tracking, dict) else None
    if (
        not isinstance(paths, list)
        or not paths
        or any(not isinstance(item, str) or not item.strip() for item in paths)
    ):
        return invalid(
            f"{profile_path} testTracking.paths must be a non-empty string list"
        )
    excluded = profile.get("excludedRoots")
    if excluded is not None and (
        not isinstance(excluded, list)
        or any(not isinstance(item, str) or not item.strip() for item in excluded)
    ):
        return invalid(f"{profile_path} excludedRoots must be a string list")
    configured_roots = (
        [item.replace("\\", "/").strip("/") for item in excluded]
        if isinstance(excluded, list)
        else []
    )
    excluded_roots = list(
        dict.fromkeys([*configured_roots, *MANDATORY_EXCLUDED_ROOTS])
    )
    patterns = [item.replace("\\", "/") for item in paths]
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
    if _path_is_excluded(rel, excluded_roots):
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


def _validate_snapshot_file(
    project: Path,
    raw: str,
) -> tuple[Path | None, str | None, str | None]:
    """Validate a path captured under the begin-time profile.

    The active profile may legitimately change before close. Snapshot paths
    remain constrained to the repository but are not reclassified against the
    newer allowlist.
    """
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
    return resolved, resolved.relative_to(project).as_posix(), None


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
    invalid_root = _invalid_project_root(action, project, project_root)
    if invalid_root is not None:
        return invalid_root
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


def rebind_snapshot(
    from_project: Path | str,
    to_project: Path | str,
    change_dir: Path | str,
    expected_base: str,
) -> dict[str, Any]:
    """Rebind an unchanged pre-change snapshot to a descendant worktree.

    This is the pre-merge counterpart to ``rehome``.  It is intentionally
    narrow: the source root must still be exactly at ``expected_base``, every
    snapshotted file must still match its captured byte hash there, and the
    target HEAD must descend from that base.  A target-owned manifest, when
    present, is validated but never rewritten.
    """

    action = "rebind-snapshot"
    from_root = Path(from_project).resolve()
    to_root = Path(to_project).resolve()
    if not from_root.is_dir() or not to_root.is_dir():
        return _result(False, action, "PROJECT_ROOT_MISSING", [])
    if harness_paths.repository_identity(from_root) != harness_paths.repository_identity(to_root):
        return _result(False, action, "REPOSITORY_MISMATCH", [])

    from_head_result = _git(from_root, "rev-parse", "--verify", "HEAD")
    from_head = from_head_result.stdout.strip() if from_head_result.returncode == 0 else ""
    if not expected_base or from_head != expected_base:
        return _result(
            False,
            action,
            "EXPECTED_BASE_MISMATCH",
            [],
            expectedBase=expected_base,
            actualBase=from_head,
        )

    to_head_result = _git(to_root, "rev-parse", "--verify", "HEAD")
    to_head = to_head_result.stdout.strip() if to_head_result.returncode == 0 else ""
    descendant = _git(
        to_root,
        "merge-base",
        "--is-ancestor",
        expected_base,
        to_head,
    )
    if not to_head or descendant.returncode != 0:
        return _result(
            False,
            action,
            "TARGET_NOT_DESCENDANT",
            [],
            expectedBase=expected_base,
            targetHead=to_head,
        )

    change_root = _change_dir(from_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    snapshot_path = _state_root(change_root) / SNAPSHOT_REL
    if not _manifest_target_inside(change_root, snapshot_path):
        return _result(False, action, "SNAPSHOT_PATH_OUTSIDE_PROJECT", [])
    manifest_path = _manifest_path(change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])

    lock_path = snapshot_path.with_name(snapshot_path.name + ".lock")
    try:
        with _exclusive_lock(lock_path, wait_seconds=5.0):
            try:
                snapshot = _read_json(snapshot_path)
            except FileNotFoundError:
                return _result(False, action, "SNAPSHOT_MISSING", [])
            except (OSError, json.JSONDecodeError) as exc:
                return _result(False, action, "SNAPSHOT_INVALID", [], error=str(exc))

            entries = snapshot.get("files") if isinstance(snapshot, dict) else None
            snapshot_root = snapshot.get("projectRoot") if isinstance(snapshot, dict) else None
            if (
                not isinstance(snapshot, dict)
                or snapshot.get("schemaVersion") != SCHEMA_VERSION
                or snapshot.get("mode") != MODE
                or snapshot_root not in {str(from_root), str(to_root)}
                or not isinstance(entries, list)
            ):
                return _result(False, action, "SNAPSHOT_INVALID", [])

            validated_paths: list[str] = []
            for item in entries:
                if (
                    not isinstance(item, dict)
                    or not isinstance(item.get("path"), str)
                    or not isinstance(item.get("sha256"), str)
                ):
                    return _result(False, action, "SNAPSHOT_INVALID", [])
                rel = item["path"]
                source, normalized, error = _validate_file(from_root, rel)
                if error or normalized != rel or source is None:
                    return _result(False, action, error or "SNAPSHOT_INVALID", [rel])
                if item["sha256"] != _sha256(source):
                    return _result(False, action, "SOURCE_SNAPSHOT_DRIFT", [rel])
                item["logicalHash"] = logical_file_hash(from_root, rel)
                validated_paths.append(rel)

            manifest = None
            if manifest_path.is_file():
                try:
                    manifest = _read_json(manifest_path)
                except (OSError, json.JSONDecodeError) as exc:
                    return _result(False, action, "MANIFEST_INVALID", [], error=str(exc))
                validator = (
                    _validate_existing_manifest_v2
                    if isinstance(manifest, dict) and manifest.get("schemaVersion") == 2
                    else _validate_existing_manifest
                )
                error, _ = validator(to_root, manifest, require_files=False)
                if error:
                    return _result(False, action, error, [])

            before_hash = _sha256(snapshot_path)
            rebound_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            rebind_id = "rebind-" + hashlib.sha256(
                f"{from_root}\0{to_root}\0{expected_base}\0{to_head}".encode("utf-8")
            ).hexdigest()[:20]
            updated = json.loads(json.dumps(snapshot))
            updated["files"] = entries
            rebinds = updated.get("rebinds")
            if rebinds is None:
                rebinds = []
            if not isinstance(rebinds, list):
                return _result(False, action, "SNAPSHOT_INVALID", [])
            record = {
                "id": rebind_id,
                "fromRoot": str(from_root),
                "toRoot": str(to_root),
                "expectedBase": expected_base,
                "targetHead": to_head,
                "at": rebound_at,
                "snapshotHashBefore": before_hash,
            }
            if not any(
                isinstance(item, dict) and item.get("id") == rebind_id
                for item in rebinds
            ):
                rebinds.append(record)
            updated["projectRoot"] = str(to_root)
            updated["rebinds"] = rebinds
            _write_json(snapshot_path, updated)
            after_hash = _sha256(snapshot_path)

            removed_manifest_paths: list[str] = []
            if isinstance(manifest, dict):
                manifest_entries = manifest.get("files")
                if not isinstance(manifest_entries, list):
                    return _result(False, action, "MANIFEST_INVALID", [])
                baseline = {
                    item["path"]: item["logicalHash"]
                    for item in entries
                    if isinstance(item, dict)
                    and isinstance(item.get("path"), str)
                    and isinstance(item.get("logicalHash"), str)
                }
                kept_entries: list[dict[str, Any]] = []
                for item in manifest_entries:
                    rel = item.get("path") if isinstance(item, dict) else None
                    if (
                        isinstance(rel, str)
                        and rel in baseline
                        and item.get("reason") in REASONS
                        and logical_file_hash(to_root, rel) == baseline[rel]
                    ):
                        removed_manifest_paths.append(rel)
                        continue
                    kept_entries.append(item)
                if removed_manifest_paths:
                    cleaned = json.loads(json.dumps(manifest))
                    cleaned["files"] = kept_entries
                    cleanups = cleaned.get("reconciliations")
                    if cleanups is None:
                        cleanups = []
                    if not isinstance(cleanups, list):
                        return _result(False, action, "MANIFEST_INVALID", [])
                    cleanups.append(
                        {
                            "rebindId": rebind_id,
                            "at": rebound_at,
                            "reason": "logical-baseline-match",
                            "removedPaths": sorted(removed_manifest_paths),
                        }
                    )
                    cleaned["reconciliations"] = cleanups
                    _write_json(manifest_path, cleaned)
    except LockUnavailable:
        return _result(False, action, "SNAPSHOT_LOCKED", [])

    return _result(
        True,
        action,
        "SNAPSHOT_REBOUND",
        sorted(validated_paths),
        fromRoot=str(from_root),
        toRoot=str(to_root),
        expectedBase=expected_base,
        targetHead=to_head,
        rebindId=rebind_id,
        snapshotHashBefore=before_hash,
        snapshotHashAfter=after_hash,
        manifestEntriesRemoved=len(removed_manifest_paths),
        removedManifestPaths=sorted(removed_manifest_paths),
        snapshotPath=str(snapshot_path),
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
        if not excluded_parts:
            continue
        width = len(excluded_parts)
        for index in range(len(rel_parts) - width + 1):
            if rel_parts[index : index + width] == excluded_parts:
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


def _enumerate_allowed_test_files(
    project_root: Path,
    *,
    strict_profile: bool = False,
) -> dict[str, str]:
    """Map repo-relative test path -> sha256 for all allowed existing files."""
    found: dict[str, str] = {}
    config = _profile_config(project_root, strict=strict_profile)
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
        if (
            rel in seen
            or _path_is_excluded(rel, excluded_roots)
            or not any(_matches_pattern(rel, pattern) for pattern in patterns)
        ):
            continue
        seen.add(rel)
        found[rel] = _sha256(resolved)
    return found


def _current_head(project_root: Path) -> str | None:
    result = _git(project_root, "rev-parse", "--verify", "HEAD")
    value = result.stdout.strip() if result.returncode == 0 else ""
    return value if re.fullmatch(r"[0-9a-fA-F]{40,64}", value) else None


def _snapshot_baseline_commit(
    project_root: Path,
    change_root: Path,
    snapshot: dict[str, Any],
) -> str | None:
    candidates: list[Any] = [snapshot.get("headCommit")]
    for state_snapshot_path in dict.fromkeys(
        [
            change_root / "meta" / "state-snapshot.json",
            _state_root(change_root) / "meta" / "state-snapshot.json",
        ]
    ):
        if not state_snapshot_path.is_file():
            continue
        try:
            state_snapshot = _read_json(state_snapshot_path)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(state_snapshot, dict):
            git_state = state_snapshot.get("git")
            if isinstance(git_state, dict):
                candidates.extend([git_state.get("base"), git_state.get("head")])
    for candidate in candidates:
        if not isinstance(candidate, str) or re.fullmatch(
            r"[0-9a-fA-F]{40,64}", candidate
        ) is None:
            continue
        exists = _git(project_root, "cat-file", "-e", f"{candidate}^{{commit}}")
        if exists.returncode == 0:
            return candidate
    return None


def _classify_against_baseline(
    project_root: Path,
    rel: str,
    baseline_commit: str | None,
) -> tuple[str | None, str | None]:
    """Return touched reason (or None when unchanged) and an optional error."""
    if baseline_commit is None:
        return None, "BASELINE_COMMIT_MISSING"
    listed = _git(
        project_root,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        baseline_commit,
        "--",
        rel,
    )
    if listed.returncode != 0:
        return None, "BASELINE_LOOKUP_FAILED"
    tracked_at_baseline = rel in {
        item for item in listed.stdout.split("\0") if item
    }
    if not tracked_at_baseline:
        return "tdd-created", None
    changed = _git(
        project_root,
        "diff",
        "--quiet",
        baseline_commit,
        "--",
        rel,
    )
    if changed.returncode == 0:
        return None, None
    if changed.returncode == 1:
        return "test-updated", None
    return None, "BASELINE_DIFF_FAILED"


def _profile_fingerprint(
    project_root: Path,
    *,
    strict_profile: bool = False,
) -> str:
    config = _profile_config(project_root, strict=strict_profile)
    payload = json.dumps(
        {"mode": "fallback"} if config is None else {"mode": "profile", "value": config},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _reconcile_close_manifest(
    project_root: Path,
    change_root: Path,
    recorded: set[str],
    baseline_commit: str | None,
) -> dict[str, Any]:
    manifest_path = _manifest_path(change_root)
    if manifest_path is None:
        return {"ok": False, "code": "MANIFEST_PATH_OUTSIDE_PROJECT"}
    if not manifest_path.is_file():
        return {
            "ok": True,
            "code": "NO_MANIFEST",
            "removedCurrentTouches": 0,
            "deletedEntries": 0,
            "preservedForeignEntries": 0,
        }

    lock_path = manifest_path.with_name(manifest_path.name + ".lock")
    try:
        with _exclusive_lock(lock_path, wait_seconds=5.0):
            try:
                manifest = _read_json(manifest_path)
            except (OSError, json.JSONDecodeError) as exc:
                return {"ok": False, "code": "MANIFEST_INVALID", "error": str(exc)}
            is_v2 = isinstance(manifest, dict) and manifest.get("schemaVersion") == 2
            validator = (
                _validate_existing_manifest_v2
                if is_v2
                else _validate_existing_manifest
            )
            head_before = _current_head(project_root)
            if head_before is None:
                return {"ok": False, "code": "HEAD_MISSING"}
            allow_hash_drift: set[str] = set()
            raw_entries = (
                manifest.get("files")
                if isinstance(manifest, dict)
                else None
            )
            if isinstance(raw_entries, list):
                for raw_item in raw_entries:
                    if not isinstance(raw_item, dict):
                        continue
                    rel = raw_item.get("path")
                    if (
                        not isinstance(rel, str)
                        or not rel
                        or rel in recorded
                        or raw_item.get("reason") == "stale-test-repair"
                    ):
                        continue
                    touched_reason, classify_error = _classify_against_baseline(
                        project_root,
                        rel,
                        baseline_commit,
                    )
                    if classify_error:
                        return {
                            "ok": False,
                            "code": classify_error,
                            "files": [rel],
                        }
                    if touched_reason is None:
                        allow_hash_drift.add(rel)
            error, validated = validator(
                project_root,
                manifest,
                allow_hash_drift=allow_hash_drift,
                require_files=False,
            )
            if error:
                return {"ok": False, "code": error}

            before_hash = _sha256(manifest_path)
            change_id = change_root.name
            reconciled: list[dict[str, Any]] = []
            removed_paths: list[str] = []
            removed_current_touches = 0
            deleted_entries = 0
            preserved_foreign_entries = 0

            for rel in sorted(validated):
                item = dict(validated[rel])
                if rel in recorded or item.get("reason") == "stale-test-repair":
                    reconciled.append(item)
                    continue
                touched_reason, classify_error = _classify_against_baseline(
                    project_root,
                    rel,
                    baseline_commit,
                )
                if classify_error:
                    return {"ok": False, "code": classify_error, "files": [rel]}
                if touched_reason is not None:
                    reconciled.append(item)
                    continue

                if not is_v2:
                    removed_paths.append(rel)
                    deleted_entries += 1
                    continue

                touched_by = list(item.get("touchedBy") or [])
                if change_id not in touched_by:
                    reconciled.append(item)
                    preserved_foreign_entries += 1
                    continue
                remaining = [owner for owner in touched_by if owner != change_id]
                removed_current_touches += 1
                if item.get("introducedBy") == change_id:
                    if remaining:
                        return {
                            "ok": False,
                            "code": "FOREIGN_PROVENANCE_CONFLICT",
                            "files": [rel],
                        }
                    removed_paths.append(rel)
                    deleted_entries += 1
                    continue
                item["touchedBy"] = remaining
                item["commitScope"] = "foreign-change"
                current_hash = logical_file_hash(project_root, rel)
                item["logicalHash"] = current_hash
                item["binaryHash"] = (
                    None if current_hash.startswith("gitblob:") else current_hash
                )
                reconciled.append(item)
                preserved_foreign_entries += 1

            for rel in removed_paths:
                touched_reason, classify_error = _classify_against_baseline(
                    project_root,
                    rel,
                    baseline_commit,
                )
                if classify_error or touched_reason is not None:
                    return {
                        "ok": False,
                        "code": classify_error or "FILE_CHANGED_DURING_RECONCILE",
                        "files": [rel],
                    }
            if _current_head(project_root) != head_before:
                return {"ok": False, "code": "HEAD_MOVED"}

            updated = json.loads(json.dumps(manifest))
            updated["files"] = reconciled
            if reconciled:
                recheck_error, _ = validator(
                    project_root,
                    updated,
                    require_files=False,
                )
                if recheck_error:
                    return {"ok": False, "code": recheck_error}
                _write_json(manifest_path, updated)
                after_hash: str | None = _sha256(manifest_path)
            else:
                manifest_path.unlink()
                after_hash = None
    except LockUnavailable:
        return {"ok": False, "code": "MANIFEST_LOCKED"}

    return {
        "ok": True,
        "code": "RECONCILED",
        "manifestHashBefore": before_hash,
        "manifestHashAfter": after_hash,
        "removedCurrentTouches": removed_current_touches,
        "deletedEntries": deleted_entries,
        "preservedForeignEntries": preserved_foreign_entries,
    }


def begin(project: Path | str, change_dir: Path | str) -> dict[str, Any]:
    action = "begin"
    project_root = Path(project).resolve()
    invalid_root = _invalid_project_root(action, project, project_root)
    if invalid_root is not None:
        return invalid_root
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    manifest_path = _manifest_path(change_root)
    if manifest_path is None:
        return _result(False, action, "MANIFEST_PATH_OUTSIDE_PROJECT", [])
    snapshot_path = _state_root(change_root) / SNAPSHOT_REL
    if not _manifest_target_inside(change_root, snapshot_path):
        return _result(False, action, "SNAPSHOT_PATH_OUTSIDE_PROJECT", [])
    try:
        current_profile_fingerprint = _profile_fingerprint(
            project_root,
            strict_profile=True,
        )
    except ProfileConfigInvalid as exc:
        return _result(
            False,
            action,
            "PROFILE_INVALID",
            [],
            error=str(exc),
        )

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
        if (
            isinstance(snapshot.get("profileFingerprint"), str)
            and snapshot["profileFingerprint"] != current_profile_fingerprint
        ):
            return _result(False, action, "PROFILE_CHANGED", [])
        return _result(
            True,
            action,
            "SNAPSHOT_REUSED",
            [item["path"] for item in entries],
            snapshotPath=str(snapshot_path),
            fileCount=len(entries),
        )

    try:
        files = _enumerate_allowed_test_files(
            project_root,
            strict_profile=True,
        )
    except ProfileConfigInvalid as exc:
        return _result(
            False,
            action,
            "PROFILE_INVALID",
            [],
            error=str(exc),
        )
    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "mode": MODE,
        "projectRoot": str(project_root),
        "repositoryId": harness_paths.repository_identity(project_root),
        "headCommit": _current_head(project_root),
        "profileFingerprint": current_profile_fingerprint,
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
    invalid_root = _invalid_project_root(action, project, project_root)
    if invalid_root is not None:
        return invalid_root
    change_root = _change_dir(project_root, change_dir)
    if change_root is None:
        return _result(False, action, "CHANGE_DIR_OUTSIDE_PROJECT", [])
    snapshot_path = _state_root(change_root) / SNAPSHOT_REL
    if not snapshot_path.is_file():
        # Name the exact path: this snapshot is evidence/test-guard-snapshot.json,
        # not meta/state-snapshot.json, and the two are easy to confuse.
        return _result(
            False,
            action,
            "SNAPSHOT_MISSING",
            [],
            expectedSnapshot=str(snapshot_path),
            hint="run `harness_test_guard.py begin` for this change first",
        )
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
    snapshot_repository = snapshot.get("repositoryId")
    if (
        snapshot_repository is not None
        and snapshot_repository != harness_paths.repository_identity(project_root)
    ):
        return _result(False, action, "REPOSITORY_MISMATCH", [])
    try:
        current_profile_fingerprint = _profile_fingerprint(
            project_root,
            strict_profile=True,
        )
    except ProfileConfigInvalid as exc:
        return _result(
            False,
            action,
            "PROFILE_INVALID",
            [],
            error=str(exc),
        )
    profile_changed = bool(
        isinstance(snapshot.get("profileFingerprint"), str)
        and snapshot["profileFingerprint"] != current_profile_fingerprint
    )
    baseline_commit = _snapshot_baseline_commit(
        project_root,
        change_root,
        snapshot,
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
        path, normalized, error = _validate_snapshot_file(project_root, rel)
        if error:
            return _result(False, action, error, [rel])
        if normalized != rel or path is None:
            return _result(False, action, "PATH_ESCAPE", [rel])
        before[rel] = item

    try:
        current = _enumerate_allowed_test_files(
            project_root,
            strict_profile=True,
        )
    except ProfileConfigInvalid as exc:
        return _result(
            False,
            action,
            "PROFILE_INVALID",
            [],
            error=str(exc),
        )
    for rel in current:
        path, normalized, error = _validate_file(project_root, rel)
        if error:
            return _result(False, action, error, [rel])
        if normalized != rel or path is None:
            return _result(False, action, "PATH_ESCAPE", [rel])

    touched: list[tuple[str, str]] = []
    for rel, digest in current.items():
        if rel not in before:
            reason, classify_error = _classify_against_baseline(
                project_root,
                rel,
                baseline_commit,
            )
            if classify_error:
                return _result(False, action, classify_error, [rel])
            if reason is not None:
                touched.append((rel, reason))
            continue
        before_digest = before[rel].get("logicalHash") or before[rel]["sha256"]
        current_digest = (
            logical_file_hash(project_root, rel)
            if before[rel].get("logicalHash")
            else digest
        )
        if before_digest != current_digest:
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
    reconciliation = (
        {
            "ok": True,
            "code": "PROFILE_REBASED_MANIFEST_PRESERVED",
            "removedCurrentTouches": 0,
            "deletedEntries": 0,
            "preservedForeignEntries": 0,
        }
        if profile_changed
        else _reconcile_close_manifest(
            project_root,
            change_root,
            set(recorded),
            baseline_commit,
        )
    )
    if not reconciliation.get("ok"):
        return _result(
            False,
            action,
            str(reconciliation.get("code") or "MANIFEST_RECONCILE_FAILED"),
            list(reconciliation.get("files") or []),
        )

    # A manifest is change-wide and intentionally survives phase boundaries.
    # Therefore pre-existing entries with no new diff are consistent and must
    # not force a test-guard reset. When the build profile changes mid-phase,
    # retain the diff result and rebaseline the reusable snapshot atomically.
    if profile_changed:
        snapshot.update(
            {
                "profileFingerprint": current_profile_fingerprint,
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "files": [
                    {
                        "path": rel,
                        "sha256": digest,
                        "ignored": _is_ignored(project_root, rel),
                    }
                    for rel, digest in sorted(current.items())
                ],
            }
        )
        _write_json(snapshot_path, snapshot)

    return _result(
        True,
        action,
        "CLOSED",
        recorded,
        recordedCount=len(recorded),
        unchangedPreexisting=len(before) - sum(1 for rel, _ in touched if rel in before),
        baselineCommit=baseline_commit,
        profileChanged=profile_changed,
        manifestReconciliation={
            key: value
            for key, value in reconciliation.items()
            if key != "ok"
        },
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
    invalid_root = _invalid_project_root(action, project, project_root)
    if invalid_root is not None:
        return invalid_root
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
    rebind_parser = sub.add_parser("rebind-snapshot")
    rebind_parser.add_argument("--from", dest="from_project", required=True)
    rebind_parser.add_argument("--to", dest="to_project", required=True)
    rebind_parser.add_argument("--change-dir", required=True)
    rebind_parser.add_argument("--expected-base", required=True)
    rebind_parser.add_argument("--json", action="store_true")
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
    elif args.action == "rebind-snapshot":
        result = rebind_snapshot(
            args.from_project, args.to_project, args.change_dir, args.expected_base
        )
    else:
        result = stage(args.project, args.change_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
