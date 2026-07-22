#!/usr/bin/env python3
"""Harness verification-ledger inputsHash fingerprint reuse (D6).

Subcommands:
  hash       — compute order-independent inputsHash for a file set
  can-reuse  — decide reuse / rerun / insufficient-evidence
  record     — write validation result + inputsHash/inputsFiles into ledger

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths  # noqa: E402
import harness_profile  # noqa: E402


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


VERIFICATIONS = frozenset(
    {
        "compile",
        "unitTest",
        "unitTestFull",
        "apiTest",
        "install",
        "package",
        "dbCompatibility",
    }
)
STATUS_MAP = {
    "ok": "OK",
    "OK": "OK",
    "fail": "FAIL",
    "FAIL": "FAIL",
    "not_run": "NOT_RUN",
    "NOT_RUN": "NOT_RUN",
}
BROAD_SCOPES = frozenset({"module", "module-am", "full"})

# --- Ledger v2 (cluster 2) ---
LEDGER_VERSION = "harness-ledger-2"
DIFF_HASH_VERSION = "content-changeset-2"
TEST_TRACKING_REL = Path("evidence") / "test-tracking.json"
TEST_TRACKING_REASONS = frozenset({"tdd-created", "stale-test-repair", "test-updated"})
# Coverage lattice: a recorded verification's coverage rank must meet the
# verification's required rank. Prevents incremental evidence from satisfying
# a module/full gate (UT-015 / API-005).
COVERAGE_RANK = {"incremental": 0, "module": 1, "module-am": 2, "full": 3}
REQUIRED_COVERAGE = {
    "unitTest": 0,      # incremental suffices (scope checked separately)
    "unitTestFull": 1,  # module or broader
    "compile": 1,
    "apiTest": 1,
    "install": 2,       # module-am or broader
    "package": 2,
    "dbCompatibility": 1,
}
# git empty-tree object id (used as base fallback when no commit exists).
_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def emit_json(payload: dict[str, Any], *, as_json: bool) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if as_json:
        sys.stdout.write(text)
    else:
        ok = payload.get("ok", True)
        reuse = payload.get("reuse")
        if reuse is not None:
            sys.stdout.write(f"reuse={reuse} reason={payload.get('reason')}\n")
        elif "diffHash" in payload:
            sys.stdout.write(f"{payload['diffHash']}\n")
        elif "inputsHash" in payload:
            sys.stdout.write(f"{payload['inputsHash']}\n")
        else:
            sys.stdout.write(("ok" if ok else "error") + "\n")


def _compact_record_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """C5: record compact — ok/action/verification/status only."""
    return {
        "ok": payload.get("ok", True),
        "action": payload.get("action"),
        "verification": payload.get("verification"),
        "status": payload.get("status"),
    }


def _compact_can_reuse_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """C5: can-reuse compact — ok/reuse/code only."""
    return {
        "ok": payload.get("ok", True),
        "reuse": payload.get("reuse"),
        "code": payload.get("code"),
    }


def emit_compact_or_verbose(
    payload: dict[str, Any],
    *,
    as_json: bool,
    verbose: bool,
    compact_fn,
) -> None:
    """Emit compact payload by default; full payload when --verbose."""
    out = payload if verbose else compact_fn(payload)
    emit_json(out, as_json=as_json)


def emit_error(
    message: str,
    *,
    as_json: bool,
    code: int = 1,
    error_code: str | None = None,
    extra: dict[str, Any] | None = None,
) -> int:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if error_code:
        payload["code"] = error_code
    if extra:
        payload.update(extra)
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message}\n")
    return code


def resolve_path(raw: str) -> Path:
    return Path(raw).expanduser().resolve()


def parse_files_arg(raw: str | None) -> list[str]:
    if raw is None or not str(raw).strip():
        return []
    parts = [p.strip() for p in str(raw).split(",")]
    return [p for p in parts if p]


def parse_files_manifest(raw: str | None) -> list[str]:
    if raw is None or not str(raw).strip():
        return []
    path = Path(str(raw)).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"files manifest not found: {path}")
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def resolve_input_files(
    files: list[str], project_root: Path | None
) -> list[str]:
    if project_root is None:
        return files
    root = project_root.expanduser().resolve()
    resolved: list[str] = []
    for raw in files:
        candidate = Path(raw).expanduser()
        candidate = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError(
                f"INPUT_OUTSIDE_PROJECT: {candidate} is outside {root}"
            ) from exc
        resolved.append(str(candidate))
    return resolved


def input_files_from_args(args: argparse.Namespace) -> tuple[list[str], Path | None]:
    project_raw = getattr(args, "project", None)
    project_root = (
        Path(str(project_raw)).expanduser().resolve() if project_raw else None
    )
    files = parse_files_arg(getattr(args, "files", None))
    manifest = parse_files_manifest(getattr(args, "files_from", None))
    if files and manifest:
        raise ValueError("use only one of --files and --files-from")
    return resolve_input_files(files or manifest, project_root), project_root


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def compute_inputs_hash(file_paths: list[str]) -> tuple[str, list[str]]:
    """Per-file content sha256 → sort digests → hash again (order-independent)."""
    by_path: dict[str, str] = {}
    for raw in file_paths:
        path = resolve_path(raw)
        if not path.is_file():
            raise FileNotFoundError(f"file not found: {raw}")
        by_path[path.as_posix()] = sha256_file(path)

    # Stable file list for callers; bind every resolved path to its digest.
    # Hashing only the content multiset let a path swap incorrectly reuse a
    # verification result.
    resolved_files_sorted = sorted(by_path.keys())

    combined = hashlib.sha256()
    for path in resolved_files_sorted:
        combined.update(path.encode("utf-8"))
        combined.update(b"\0")
        combined.update(by_path[path].encode("ascii"))
        combined.update(b"\n")
    return f"sha256:{combined.hexdigest()}", resolved_files_sorted


def _git_bytes(args: list[str], cwd: Path) -> bytes:
    """Run git, return raw stdout bytes. Raises RuntimeError on non-zero exit."""
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True)
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {msg}")
    return proc.stdout


def _git_text(cwd: Path, *args: str) -> str | None:
    """Run git, return stripped stdout; None on non-zero exit."""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def _root_commit(repo_root: Path) -> str | None:
    out = _git_bytes(["rev-list", "--max-parents=0", "HEAD"], repo_root)
    lines = [ln for ln in out.decode("utf-8", "replace").splitlines() if ln.strip()]
    return lines[0] if lines else None


def _changed_paths(repo_root: Path, base: str | None) -> tuple[str, list[str]]:
    """Commit-invariant change set: tracked files differing from base (working
    tree) plus untracked files. Sorted by repo-relative path.

    Working-tree content is unchanged by a checkpoint commit, so the change set
    and its bytes are identical before/after commit (UT-011).
    """
    if not base:
        base = _root_commit(repo_root) or _EMPTY_TREE
    out = _git_bytes(["diff", "--name-only", "--no-renames", "-z", base], repo_root)
    paths: set[str] = set()
    for name in out.split(b"\x00"):
        if name:
            paths.add(name.decode("utf-8"))
    out2 = _git_bytes(["ls-files", "--others", "--exclude-standard", "-z"], repo_root)
    for name in out2.split(b"\x00"):
        if name:
            paths.add(name.decode("utf-8"))
    return base, sorted(paths)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _tracked_test_contents(
    repo_root: Path,
    change_dir: Path | str | None,
) -> tuple[dict[str, bytes], str | None]:
    """Load exact test paths recorded by harness_test_guard.

    The ledger validates the same security-critical manifest fields again so a
    hand-edited manifest cannot silently widen the fingerprint or reuse stale
    evidence. Missing manifests remain backward-compatible and contribute no
    additional paths.
    """
    if change_dir is None:
        return {}, None
    candidate = Path(change_dir)
    if not candidate.is_absolute():
        candidate = repo_root / candidate
    change_root = candidate.resolve()
    main_root = harness_paths.resolve_main_project_root(repo_root)
    if not (_inside(change_root, repo_root) or _inside(change_root, main_root)):
        raise ValueError("TEST_TRACKING_CHANGE_DIR_OUTSIDE_PROJECT")
    state_root = _state_dir(change_root)
    manifest_path = (state_root / TEST_TRACKING_REL).resolve()
    if not _inside(manifest_path, state_root):
        raise ValueError("TEST_TRACKING_MANIFEST_OUTSIDE_CHANGE")
    if not manifest_path.is_file():
        return {}, None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"TEST_TRACKING_MANIFEST_INVALID: {exc}") from exc
    if isinstance(manifest, dict) and manifest.get("schemaVersion") == 2:
        return _tracked_test_contents_v2(repo_root, manifest, manifest_path)
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("mode") != "force-track-touched"
        or manifest.get("projectRoot") != str(repo_root)
    ):
        raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("TEST_TRACKING_MANIFEST_INVALID: EMPTY_FILES")

    contents: dict[str, bytes] = {}
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
        rel = item.get("path")
        expected_hash = item.get("sha256")
        if (
            not isinstance(rel, str)
            or not rel
            or not isinstance(expected_hash, str)
            or item.get("reason") not in TEST_TRACKING_REASONS
            or type(item.get("ignored")) is not bool
            or type(item.get("trackedBefore")) is not bool
        ):
            raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
        raw_path = Path(rel)
        resolved = (repo_root / raw_path).resolve()
        if raw_path.is_absolute() or not _inside(resolved, repo_root):
            raise ValueError(f"TEST_TRACKING_PATH_OUTSIDE_PROJECT: {rel}")
        normalized = resolved.relative_to(repo_root).as_posix()
        if normalized != rel or not resolved.is_file():
            raise ValueError(f"TEST_TRACKING_FILE_INVALID: {rel}")
        content = resolved.read_bytes()
        actual_hash = "sha256:" + hashlib.sha256(content).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(f"TEST_TRACKING_HASH_DRIFT: {rel}")
        contents[rel] = content
    return {rel: contents[rel] for rel in sorted(contents)}, str(manifest_path)


def _tracked_test_contents_v2(
    repo_root: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
) -> tuple[dict[str, bytes], str | None]:
    """Validate a schema-2 manifest: repositoryId equality + logical hashes."""
    if manifest.get("mode") != "force-track-touched":
        raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
    repository_id = manifest.get("repositoryId")
    if not isinstance(repository_id, str) or not repository_id.startswith("sha256:"):
        raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
    if repository_id != harness_paths.repository_identity(repo_root):
        raise ValueError("TEST_TRACKING_REPOSITORY_MISMATCH")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("TEST_TRACKING_MANIFEST_INVALID: EMPTY_FILES")

    contents: dict[str, bytes] = {}
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
        rel = item.get("path")
        expected = item.get("logicalHash") or item.get("binaryHash")
        if (
            not isinstance(rel, str)
            or not rel
            or not isinstance(expected, str)
            or not (expected.startswith("gitblob:") or expected.startswith("sha256:"))
            or item.get("reason") not in TEST_TRACKING_REASONS
            or type(item.get("ignored")) is not bool
            or not isinstance(item.get("introducedBy"), str)
            or not isinstance(item.get("touchedBy"), list)
            or item.get("commitScope") not in ("current-change", "foreign-change")
        ):
            raise ValueError("TEST_TRACKING_MANIFEST_INVALID")
        raw_path = Path(rel)
        resolved = (repo_root / raw_path).resolve()
        if raw_path.is_absolute() or not _inside(resolved, repo_root):
            raise ValueError(f"TEST_TRACKING_PATH_OUTSIDE_PROJECT: {rel}")
        normalized = resolved.relative_to(repo_root).as_posix()
        if normalized != rel or not resolved.is_file():
            raise ValueError(f"TEST_TRACKING_FILE_INVALID: {rel}")
        content = resolved.read_bytes()
        actual = _logical_file_hash(repo_root, rel, content)
        if actual != expected:
            raise ValueError(f"TEST_TRACKING_HASH_DRIFT: {rel}")
        contents[rel] = content
    return {rel: contents[rel] for rel in sorted(contents)}, str(manifest_path)


def _logical_file_hash(repo_root: Path, rel: str, content: bytes) -> str:
    """Mirror of harness_test_guard.logical_file_hash for validation."""
    attr = subprocess.run(
        ["git", "check-attr", "text", "--", rel],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    attr_out = attr.stdout.strip() if attr.returncode == 0 else ""
    byte_hash = "sha256:" + hashlib.sha256(content).hexdigest()
    if attr_out.endswith(": unset") or b"\x00" in content:
        return byte_hash
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return byte_hash
    proc = subprocess.run(
        ["git", "hash-object", "--path", rel, "--stdin"],
        input=content,
        capture_output=True,
        cwd=str(repo_root),
        check=False,
    )
    if proc.returncode != 0:
        return byte_hash
    return "gitblob:" + proc.stdout.decode("ascii").strip()


def compute_diff_hash(
    repo_root: Path,
    base: str | None = None,
    change_dir: Path | str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Byte-level, commit-invariant diff hash (cluster 2).

    Content-based change set: every file whose working-tree content differs
    from base, plus untracked files. Each entry is length-framed
    (path-len | path | exists-flag | content-len | content) so the payload is
    independent of shell, console encoding, BOM and system newlines. Stable
    across a checkpoint commit because git does not mutate the working tree.
    """
    repo_root = Path(repo_root).resolve()
    base, paths = _changed_paths(repo_root, base)
    tracked_test_contents, manifest_path = _tracked_test_contents(repo_root, change_dir)
    paths = sorted(set(paths).union(tracked_test_contents))
    digest = hashlib.sha256()
    digest.update(DIFF_HASH_VERSION.encode("utf-8"))
    digest.update(b"\x00")
    for rel in paths:
        path_bytes = rel.encode("utf-8")
        digest.update(len(path_bytes).to_bytes(4, "big"))
        digest.update(path_bytes)
        abs_path = repo_root / rel
        if rel in tracked_test_contents:
            content = tracked_test_contents[rel]
            digest.update(b"\x01")
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
        elif abs_path.is_file():
            content = abs_path.read_bytes()
            digest.update(b"\x01")
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
        else:
            # Deleted since base: record absence with no content.
            digest.update(b"\x00")
            digest.update((0).to_bytes(8, "big"))
    for rel, verified_content in tracked_test_contents.items():
        path = repo_root / rel
        try:
            current_content = path.read_bytes()
        except OSError as exc:
            raise ValueError(f"TEST_TRACKING_HASH_DRIFT: {rel}") from exc
        if current_content != verified_content:
            raise ValueError(f"TEST_TRACKING_HASH_DRIFT: {rel}")
    try:
        head = _git_bytes(["rev-parse", "HEAD"], repo_root).decode("utf-8", "replace").strip()
    except RuntimeError:
        head = ""
    meta = {
        "algorithmVersion": DIFF_HASH_VERSION,
        "fileCount": len(paths),
        "base": base,
        "head": head or None,
        "trackedTestFileCount": len(tracked_test_contents),
        "testTrackingManifest": manifest_path,
    }
    return f"sha256:{digest.hexdigest()}", meta


def derive_coverage(verification: str, scope: str | None) -> str:
    """Derive coverage lattice value from verification + scope (cluster 2)."""
    s = str(scope).strip() if scope else ""
    if verification == "unitTest":
        return "module" if s in BROAD_SCOPES else "incremental"
    if verification == "unitTestFull":
        return "full" if s == "full" else "module"
    if verification in ("install", "package"):
        return "module-am"
    return "module"


def expand_profile_input_files(
    project: Path, profile_input: str
) -> tuple[list[str], str | None]:
    """Expand verificationInputs[profile_input] globs from build-profile.json.

    Profile is loaded via ``harness_profile.load_profile`` (C7: common_root then
    execution overlay) so linked worktrees without a local build-profile still
    reuse the main checkout profile. Globs remain relative to the execution
    ``project`` root (not common_root) so inputsHash tracks the tree under test.

    Returns (files, error); error is None on success.
    profile 缺失 / key 缺失 / glob 无匹配 / 结果为空 → 返回 ([], "<reason>")，
    调用方据此返回 insufficient-evidence，执行全量测试但不允许缓存复用。
    """
    profile = harness_profile.load_profile(Path(project))
    if profile is None:
        # load_profile swallows JSON errors; restore actionable unreadable diag
        # when a profile file exists but cannot be parsed (review YELLOW-1).
        project_root = Path(project).resolve()
        common = harness_paths.common_root(project_root)
        for root in (common, project_root):
            candidate = root / ".harness" / "config" / "build-profile.json"
            if not candidate.is_file():
                continue
            try:
                json.loads(candidate.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError) as exc:
                return [], f"build-profile.json unreadable: {exc}"
        return [], "build-profile.json missing; run harness_preflight.py detect"
    if not isinstance(profile, dict):
        return [], "build-profile.json is not an object"
    inputs = profile.get("verificationInputs")
    if not isinstance(inputs, dict) or profile_input not in inputs:
        return [], f"verificationInputs.{profile_input} missing in build-profile.json"
    patterns = inputs[profile_input]
    if not isinstance(patterns, list) or not patterns:
        return [], f"verificationInputs.{profile_input} is empty or invalid"

    base = Path(project).resolve()
    seen: set[str] = set()
    for pat in patterns:
        if not isinstance(pat, str) or not pat.strip():
            continue
        for match in base.glob(pat):
            if not match.is_file():
                continue
            resolved = match.resolve()
            try:
                resolved.relative_to(base)
            except ValueError:
                # 拒绝 project 外部路径，禁止 glob 逃逸。
                continue
            seen.add(resolved.as_posix())
    if not seen:
        return [], f"verificationInputs.{profile_input} matched no files"
    return sorted(seen), None


def _state_dir(change_dir: Path) -> Path:
    return Path(harness_paths.resolve_state_dir_for_contract(change_dir))


def ledger_candidates(change_dir: Path) -> list[Path]:
    state = _state_dir(change_dir)
    contract = Path(change_dir)
    candidates = [state / "evidence" / "verification-ledger.json"]
    if state != contract:
        candidates.append(contract / "evidence" / "verification-ledger.json")
    candidates.append(state / "verification-ledger.json")
    if state != contract:
        candidates.append(contract / "verification-ledger.json")
    return candidates


def find_ledger_path(change_dir: Path) -> Path | None:
    for path in ledger_candidates(change_dir):
        if path.is_file():
            return path
    return None


def preferred_write_path(change_dir: Path) -> Path:
    # New writes always go to evidence/ (protocol preferred path); split-v1
    # changes route to the dynamic state root.
    return _state_dir(change_dir) / "evidence" / "verification-ledger.json"


def load_ledger(change_dir: Path) -> tuple[dict[str, Any] | None, Path | None]:
    path = find_ledger_path(change_dir)
    if path is None:
        return None, None
    text = path.read_text(encoding="utf-8-sig")
    if not text.strip():
        return {}, path
    data = json.loads(text)
    if data is None:
        return {}, path
    if not isinstance(data, dict):
        raise ValueError(f"ledger must be a JSON object: {path}")
    return data, path


def write_ledger(path: Path, data: dict[str, Any]) -> None:
    """Atomic ledger write: temp -> fsync -> replace (ledger v3)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


LEDGER_SCHEMA_VERSION = 3
LEDGER_IDENTITY_FIELDS = (
    "repositoryId",
    "changeName",
    "baseCommit",
    "currentHead",
    "diffHash",
    "ownershipHash",
)


def validate_ledger_identity(ledger: dict[str, Any]) -> list[str]:
    """Missing/invalid top-level identity fields (ledger v3)."""
    missing: list[str] = []
    if not isinstance(ledger, dict):
        return ["ledger"]
    if ledger.get("schemaVersion") != LEDGER_SCHEMA_VERSION:
        missing.append("schemaVersion")
    for field in LEDGER_IDENTITY_FIELDS:
        value = ledger.get(field)
        if not isinstance(value, str) or not value.strip():
            missing.append(field)
    return missing


def record_integration_hashes(
    ledger_path: Path,
    *,
    change_dir: Path | None = None,
    repository_id: str,
    merge_final_hash: str,
    ci_expected_head: str,
    remote_head: str,
) -> dict[str, Any]:
    """Atomically attach post-push hashes using the change contract's ledger rules."""
    path = Path(ledger_path).resolve()
    if not path.is_file():
        return {"ok": False, "code": "LEDGER_MISSING", "ledgerPath": str(path)}
    try:
        ledger = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False, "code": "LEDGER_INVALID", "ledgerPath": str(path),
            "message": str(exc),
        }
    legacy_contract = False
    if change_dir is not None:
        resolved_change_dir = Path(change_dir).resolve()
        if ledger.get("changeName") != resolved_change_dir.name:
            return {
                "ok": False,
                "code": "LEDGER_CHANGE_MISMATCH",
                "ledgerPath": str(path),
            }
        legacy_contract = not _contract_is_v2(resolved_change_dir)

    missing = validate_ledger_identity(ledger)
    if missing and not legacy_contract:
        return {
            "ok": False,
            "code": "LEDGER_IDENTITY_INVALID",
            "ledgerPath": str(path),
            "missing": missing,
        }
    if not missing and ledger.get("repositoryId") != repository_id:
        return {
            "ok": False,
            "code": "LEDGER_REPOSITORY_MISMATCH",
            "ledgerPath": str(path),
        }
    values = {
        "mergeFinalHash": merge_final_hash,
        "ciExpectedHead": ci_expected_head,
        "remoteHead": remote_head,
    }
    invalid = [
        field for field, value in values.items()
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None
    ]
    if invalid:
        return {
            "ok": False,
            "code": "FINAL_HASH_INVALID",
            "ledgerPath": str(path),
            "invalid": invalid,
        }
    if len(set(values.values())) != 1:
        return {
            "ok": False,
            "code": "FINAL_HASH_MISMATCH",
            "ledgerPath": str(path),
            **values,
        }
    ledger.update(values)
    ledger["integrationFinalizedAt"] = now_iso()
    write_ledger(path, ledger)
    return {"ok": True, "code": "INTEGRATION_HASHES_RECORDED", "ledgerPath": str(path), **values}


def _contract_is_v2(change_dir: Path) -> bool:
    try:
        contract = harness_paths.load_change_contract(change_dir)
    except (OSError, ValueError):
        return False
    if harness_paths.contract_layout_kind(contract) == "split-v1":
        return True
    version = contract.get("schemaVersion")
    return isinstance(version, int) and version >= 2


def ownership_hash(contract: dict[str, Any]) -> str:
    ownership = contract.get("ownership") or {}
    canonical = json.dumps(ownership, ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_METRICS_SCHEMAS: dict[str, dict[str, tuple[str, ...]]] = {
    "unitTest": {"required": ("total", "passed", "failed"), "optional": ("errors", "skipped")},
    "unitTestFull": {"required": ("total", "passed", "failed"), "optional": ("errors", "skipped")},
    "apiTest": {"required": ("total", "passed", "failed"), "optional": ("blocked",)},
    "apiContract": {"required": ("scenariosTotal", "passed", "failed"), "optional": ("blocked",)},
    "browserE2E": {"required": ("total", "passed", "failed"), "optional": ("skipped", "retries")},
}


def validate_metrics(verification: str, metrics: Any) -> list[str]:
    """Typed metrics schema check; unknown verification types pass through."""
    problems: list[str] = []
    if not isinstance(metrics, dict):
        return ["metrics must be an object"]
    if verification == "dbCompatibility":
        applicability = metrics.get("applicability")
        if applicability not in ("APPLICABLE", "NOT_APPLICABLE"):
            return ["dbCompatibility.applicability must be APPLICABLE|NOT_APPLICABLE"]
        if applicability == "NOT_APPLICABLE":
            reason = metrics.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                problems.append("dbCompatibility.reason required for NOT_APPLICABLE")
            unknown = sorted(set(metrics) - {"applicability", "reason"})
            problems.extend(
                f"dbCompatibility.{field} is not valid for NOT_APPLICABLE"
                for field in unknown
            )
        else:
            allowed = {
                "applicability", "status", "total", "passed", "failed", "evidenceHash"
            }
            status = metrics.get("status")
            if status not in {"OK", "FAIL"}:
                problems.append("dbCompatibility.status must be OK|FAIL for APPLICABLE")
            for field in ("total", "passed", "failed"):
                value = metrics.get(field)
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    problems.append(f"dbCompatibility.{field} must be a non-negative int")
            total = metrics.get("total")
            passed = metrics.get("passed")
            failed = metrics.get("failed")
            if all(isinstance(value, int) and not isinstance(value, bool)
                   for value in (total, passed, failed)) and passed + failed != total:
                problems.append("dbCompatibility counts must satisfy passed + failed == total")
            evidence_hash = metrics.get("evidenceHash")
            if not isinstance(evidence_hash, str) or not re.fullmatch(
                r"sha256:[0-9a-f]{64}", evidence_hash
            ):
                problems.append("dbCompatibility.evidenceHash must be sha256:<64 lowercase hex>")
            problems.extend(
                f"dbCompatibility.{field} is not a supported field"
                for field in sorted(set(metrics) - allowed)
            )
        return problems
    schema = _METRICS_SCHEMAS.get(verification)
    if schema is None:
        return problems
    allowed = set(schema["required"]) | set(schema["optional"])
    for field in schema["required"]:
        value = metrics.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            problems.append(f"metrics.{field} must be a non-negative int")
    for field, value in metrics.items():
        if field not in allowed:
            problems.append(f"metrics.{field} is not a {verification} field")
        elif not isinstance(value, int) or isinstance(value, bool) or value < 0:
            problems.append(f"metrics.{field} must be a non-negative int")
    return problems


def build_applicability_entry(value: str, reason: str | None = None) -> dict[str, Any]:
    if value not in ("APPLICABLE", "NOT_APPLICABLE"):
        raise ValueError("applicability must be APPLICABLE|NOT_APPLICABLE")
    if value == "NOT_APPLICABLE" and not (isinstance(reason, str) and reason.strip()):
        raise ValueError("NOT_APPLICABLE requires a scope reason")
    entry: dict[str, Any] = {"applicability": value}
    if reason and reason.strip():
        entry["reason"] = reason.strip()
    return entry


def applicability_counts_as_success(entry: dict[str, Any]) -> bool:
    """Applicability never contributes to success counters (RET-24)."""
    return False


def applicability_counts_as_failure(entry: dict[str, Any]) -> bool:
    """NOT_APPLICABLE is not a failure; status decides for APPLICABLE."""
    return False


_DYNAMIC_OWN_DIRS = ("events.ndjson", "logs", "evidence", "reports", "runtime", "backups")


def _matches_ownership_path(rel: str, declared: Any) -> bool:
    scope = str(declared).replace("\\", "/").strip("/")
    if not scope:
        return False
    normalized = rel.replace("\\", "/").strip("/")
    return normalized == scope or normalized.startswith(scope + "/")


def _classify_ownership_path(
    rel: str, change_name: str, ownership: dict[str, Any]
) -> str:
    """owned | staticEvidence | excludedRuntime | foreign."""
    normalized = rel.replace("\\", "/")
    if normalized.startswith(".harness/state/changes/"):
        owner = normalized.split("/")[3] if len(normalized.split("/")) > 3 else ""
        return "excludedRuntime" if owner == change_name else "foreign"
    if normalized.startswith(".harness/state/"):
        return "excludedRuntime"
    if normalized.startswith(".harness/changes/"):
        parts = normalized.split("/")
        owner = parts[2] if len(parts) > 2 else ""
        if owner and owner != change_name:
            return "foreign"
        remainder = "/".join(parts[3:]) if len(parts) > 3 else ""
        head = remainder.split("/")[0] if remainder else ""
        if remainder in _DYNAMIC_OWN_DIRS or head in _DYNAMIC_OWN_DIRS:
            return "excludedRuntime"
    for excluded in ownership.get("excludedPaths") or []:
        if _matches_ownership_path(normalized, excluded):
            return "excludedRuntime"
    for static_path in ownership.get("staticEvidencePaths") or []:
        if _matches_ownership_path(normalized, static_path):
            return "staticEvidence"
    for product_path in ownership.get("productPaths") or []:
        if _matches_ownership_path(normalized, product_path):
            return "owned"
    return "foreign"


def compute_ownership_diff(
    repo_root: Path, *, base: str, change_dir: Path, head: str | None = None
) -> dict[str, Any]:
    """diffHash over the change's ownership scope only (RET-18).

    Excludes .harness/state/** and dynamic evidence; reports foreign change
    paths separately instead of folding them into the hash.
    """
    repo_root = Path(repo_root).resolve()
    change_dir = Path(change_dir).resolve()
    try:
        contract = harness_paths.load_change_contract(change_dir)
    except (OSError, ValueError):
        contract = {}
    ownership = contract.get("ownership") or {}
    diff_args = ["diff", "--name-only", base]
    if head:
        diff_args.append(head)
    raw = _git_text(repo_root, *diff_args) or ""
    changed_paths = {line.strip() for line in raw.splitlines() if line.strip()}
    if head is None:
        untracked = _git_text(
            repo_root, "ls-files", "--others", "--exclude-standard"
        ) or ""
        changed_paths.update(
            line.strip() for line in untracked.splitlines() if line.strip()
        )
    owned: list[str] = []
    static_evidence: list[str] = []
    foreign: list[str] = []
    excluded_runtime = 0
    for rel in sorted(changed_paths):
        verdict = _classify_ownership_path(rel, change_dir.name, ownership)
        if verdict == "foreign":
            foreign.append(rel)
        elif verdict == "staticEvidence":
            static_evidence.append(rel)
        elif verdict == "excludedRuntime":
            excluded_runtime += 1
        else:
            owned.append(rel)
    owned.sort()
    static_evidence.sort()
    foreign.sort()

    hasher = hashlib.sha256()
    for rel in owned:
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\x00")
        if head:
            try:
                content = _git_bytes(["show", f"{head}:{rel}"], repo_root)
            except RuntimeError:
                content = None
            hasher.update(
                hashlib.sha256(content).hexdigest().encode("ascii")
                if content is not None
                else b"<deleted>"
            )
        else:
            content_path = (repo_root / rel).resolve()
            if content_path.is_file() and _inside(content_path, repo_root):
                hasher.update(hashlib.sha256(content_path.read_bytes()).hexdigest().encode("ascii"))
            else:
                hasher.update(b"<deleted>")
        hasher.update(b"\x00")
    return {
        "diffHash": "sha256:" + hasher.hexdigest(),
        "files": owned,
        "staticEvidenceFiles": static_evidence,
        "foreignPaths": foreign,
        "excludedRuntimeCount": excluded_runtime,
        "ownedFileCount": len(owned),
        "ownershipHash": ownership_hash(contract),
    }


def normalize_status(raw: str) -> str:
    if raw not in STATUS_MAP:
        raise ValueError(
            f"unsupported status: {raw}; expected one of ok|fail|not_run (case variants OK/FAIL/NOT_RUN)"
        )
    return STATUS_MAP[raw]


def evidence_summary(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": entry.get("status"),
        "command": entry.get("command"),
        "evidence": entry.get("evidence"),
        "scope": entry.get("scope"),
        "inputsHash": entry.get("inputsHash"),
        "inputsFiles": entry.get("inputsFiles"),
        "durationMs": entry.get("durationMs"),
        "exitCode": entry.get("exitCode"),
        "finishedAt": entry.get("finishedAt"),
    }


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _scope_covers(ledger_scope: Any, requested_scope: str | None) -> bool:
    """unitTest: ledger scope must cover requested scope (broad scopes cover all)."""
    if not _nonempty_str(ledger_scope) and not isinstance(ledger_scope, list):
        return False
    if requested_scope is None or not str(requested_scope).strip():
        # No requested scope → only require ledger to have some scope recorded.
        return True

    req = str(requested_scope).strip()
    if isinstance(ledger_scope, list):
        ledger_items = {str(x).strip() for x in ledger_scope if str(x).strip()}
    else:
        text = str(ledger_scope).strip()
        if text in BROAD_SCOPES:
            return True
        ledger_items = {p.strip() for p in text.split(",") if p.strip()}

    if req in BROAD_SCOPES:
        # Requesting broad scope only reusable if ledger also broad (same or broader).
        return str(ledger_scope).strip() in BROAD_SCOPES if not isinstance(ledger_scope, list) else False

    req_items = {p.strip() for p in req.split(",") if p.strip()}
    return req_items.issubset(ledger_items)


def worktree_ready(ledger: dict[str, Any], change_dir: Path) -> bool:
    root = ledger.get("worktreeRoot")
    if root is not None and _nonempty_str(root):
        return True
    meta = change_dir / "meta" / "worktree.json"
    if not meta.is_file():
        return False
    try:
        data = json.loads(meta.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    if data.get("requested") is True and data.get("created") is True:
        return True
    if _nonempty_str(data.get("path")) or _nonempty_str(data.get("worktreeRoot")):
        return True
    return False


def decide_can_reuse(
    *,
    change_dir: Path,
    verification: str,
    files: list[str],
    requested_scope: str | None = None,
    requested_command: str | None = None,
    requested_toolchain_hash: str | None = None,
    requested_profile_hash: str | None = None,
    requested_environment_hash: str | None = None,
) -> dict[str, Any]:
    ledger, ledger_path = load_ledger(change_dir)
    if ledger is None:
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "LEDGER_MISSING",
            "verification": verification,
            "detail": "ledger missing",
        }

    validations = ledger.get("validations")
    if not isinstance(validations, dict):
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "VALIDATIONS_MISSING",
            "verification": verification,
            "detail": "validations missing",
            "ledger_path": str(ledger_path) if ledger_path else None,
        }

    entry = validations.get(verification)
    if not isinstance(entry, dict):
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "VALIDATION_MISSING",
            "verification": verification,
            "detail": f"validation '{verification}' missing",
            "ledger_path": str(ledger_path) if ledger_path else None,
        }

    stored_hash = entry.get("inputsHash")
    stored_files = entry.get("inputsFiles")
    status = entry.get("status")
    evidence = entry.get("evidence")
    command = entry.get("command")
    scope = entry.get("scope")
    algorithm_version = entry.get("algorithmVersion")
    coverage = entry.get("coverage")

    # v2 fields: a v1 entry (no algorithmVersion/coverage) is conservatively
    # invalidated once and must be re-recorded with v2 fields (COM-002). No
    # silent upgrade of stale evidence.
    v2_missing: list[str] = []
    if not _nonempty_str(algorithm_version):
        v2_missing.append("algorithmVersion")
    if not (_nonempty_str(coverage) and str(coverage).strip() in COVERAGE_RANK):
        v2_missing.append("coverage")

    missing: list[str] = []
    if not _nonempty_str(stored_hash):
        missing.append("inputsHash")
    if not isinstance(stored_files, list):
        missing.append("inputsFiles")
    elif verification == "unitTestFull" and not stored_files:
        # 全量门禁的依赖闭包文件集必须非空，禁止空/staged-only 闭包冒充全量。
        missing.append("inputsFiles")
    if status != "OK":
        missing.append("status=OK")
    if not _nonempty_str(evidence):
        missing.append("evidence")
    if not _nonempty_str(command):
        missing.append("command")
    if verification == "unitTest" and not (
        _nonempty_str(scope) or isinstance(scope, list)
    ):
        missing.append("scope")
    if verification == "unitTestFull":
        # 独立 full-scope 检查：增量范围（如 FooTest）不能冒充全量门禁。
        # 不并入 _scope_covers()，避免依赖增量复用的隐含行为。
        if not isinstance(scope, str) or scope.strip() not in BROAD_SCOPES:
            missing.append("scope=module|full")
    if verification == "install" and not worktree_ready(ledger, change_dir):
        missing.append("worktree")

    all_missing = v2_missing + missing
    if all_missing:
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "MISSING_V2_FIELDS" if v2_missing else "MISSING_FIELDS",
            "verification": verification,
            "detail": "missing or invalid: " + ", ".join(all_missing),
            "ledger_path": str(ledger_path) if ledger_path else None,
        }

    # Coverage lattice: recorded coverage rank must meet the verification's
    # required rank. Stops incremental evidence satisfying a module/full gate
    # (UT-015 / API-005).
    required = REQUIRED_COVERAGE.get(verification, 1)
    if COVERAGE_RANK.get(str(coverage).strip(), -1) < required:
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "COVERAGE_INSUFFICIENT",
            "verification": verification,
            "detail": f"coverage '{coverage}' below required rank {required} for {verification}",
            "ledger_path": str(ledger_path) if ledger_path else None,
            "stored_coverage": coverage,
        }

    if requested_command is not None and str(requested_command).strip():
        if str(command).strip() != str(requested_command).strip():
            return {
                "ok": True,
                "reuse": False,
                "reason": "rerun",
                "code": "COMMAND_CHANGED",
                "verification": verification,
                "detail": "command changed",
                "ledger_path": str(ledger_path) if ledger_path else None,
                "stored_command": command,
                "requested_command": requested_command,
            }

    # Toolchain / profile / environment hash drift -> structured rerun (UT-017).
    # Only compared when both the stored entry and the request carry the field.
    for field, requested, code_name in (
        ("toolchainHash", requested_toolchain_hash, "TOOLCHAIN_CHANGED"),
        ("profileHash", requested_profile_hash, "PROFILE_CHANGED"),
        ("environmentHash", requested_environment_hash, "ENVIRONMENT_CHANGED"),
    ):
        stored = entry.get(field)
        if (
            requested
            and str(requested).strip()
            and _nonempty_str(stored)
            and str(stored).strip() != str(requested).strip()
        ):
            return {
                "ok": True,
                "reuse": False,
                "reason": "rerun",
                "code": code_name,
                "verification": verification,
                "detail": f"{field} changed",
                "ledger_path": str(ledger_path) if ledger_path else None,
                "field": field,
                "stored": stored,
                "requested": requested,
            }

    if verification == "unitTest" and not _scope_covers(scope, requested_scope):
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "SCOPE_INSUFFICIENT",
            "verification": verification,
            "detail": "scope does not cover requested tests",
            "ledger_path": str(ledger_path) if ledger_path else None,
            "stored_scope": scope,
            "requested_scope": requested_scope,
        }

    try:
        current_hash, current_files = compute_inputs_hash(files)
    except FileNotFoundError as exc:
        return {
            "ok": True,
            "reuse": False,
            "reason": "insufficient-evidence",
            "code": "INPUT_FILE_MISSING",
            "verification": verification,
            "detail": str(exc),
            "ledger_path": str(ledger_path) if ledger_path else None,
        }

    if current_hash != stored_hash:
        return {
            "ok": True,
            "reuse": False,
            "reason": "rerun",
            "code": "INPUTS_HASH_CHANGED",
            "verification": verification,
            "detail": "inputsHash changed",
            "ledger_path": str(ledger_path) if ledger_path else None,
            "stored_inputsHash": stored_hash,
            "current_inputsHash": current_hash,
            "inputsFiles": current_files,
        }

    return {
        "ok": True,
        "reuse": True,
        "reason": "reuse",
        "code": "REUSED",
        "verification": verification,
        "ledger_path": str(ledger_path) if ledger_path else None,
        "inputsHash": stored_hash,
        "inputsFiles": stored_files,
        "evidence_summary": evidence_summary(entry),
        "marker": "REUSED",
    }


def cmd_hash(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    try:
        files, project_root = input_files_from_args(args)
        if not files:
            return emit_error("hash requires --files or --files-from", as_json=as_json)
        inputs_hash, inputs_files = compute_inputs_hash(files)
    except (OSError, FileNotFoundError) as exc:
        return emit_error(str(exc), as_json=as_json)

    payload = {
        "ok": True,
        "action": "hash",
        "inputsHash": inputs_hash,
        "inputsFiles": inputs_files,
        "fileCount": len(inputs_files),
        "resolvedProjectRoot": str(project_root) if project_root else None,
    }
    emit_json(payload, as_json=as_json)
    return 0


def cmd_can_reuse(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    verbose = bool(getattr(args, "verbose", False))
    verification = args.verification
    if verification not in VERIFICATIONS:
        return emit_error(
            f"unsupported verification: {verification}; expected one of {sorted(VERIFICATIONS)}",
            as_json=as_json,
        )
    change_dir = resolve_path(args.change_dir)
    try:
        files, project_root = input_files_from_args(args)
    except (OSError, ValueError) as exc:
        return emit_error(f"can-reuse failed: {exc}", as_json=as_json)
    profile_input = getattr(args, "profile_input", None)
    project_raw = getattr(args, "project", None)
    if profile_input:
        if not project_raw:
            return emit_error("--profile-input requires --project", as_json=as_json)
        resolved_files, err = expand_profile_input_files(project_root, profile_input)
        if err:
            # profile 未正确配置：不允许缓存复用，返回 insufficient-evidence（exit 0）。
            payload = {
                "ok": True,
                "reuse": False,
                "reason": "insufficient-evidence",
                "verification": verification,
                "detail": err,
            }
            emit_compact_or_verbose(
                payload, as_json=as_json, verbose=verbose,
                compact_fn=_compact_can_reuse_payload,
            )
            return 0
        files = resolve_input_files(resolved_files, project_root)
    if not files:
        return emit_error(
            "can-reuse requires --files or a non-empty --profile-input file set",
            as_json=as_json,
        )
    try:
        payload = decide_can_reuse(
            change_dir=change_dir,
            verification=verification,
            files=files,
            requested_scope=getattr(args, "scope", None),
            requested_command=getattr(args, "command", None),
            requested_toolchain_hash=getattr(args, "toolchain_hash", None),
            requested_profile_hash=getattr(args, "profile_hash", None),
            requested_environment_hash=getattr(args, "environment_hash", None),
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return emit_error(f"can-reuse failed: {exc}", as_json=as_json)

    emit_compact_or_verbose(
        payload, as_json=as_json, verbose=verbose,
        compact_fn=_compact_can_reuse_payload,
    )
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    verbose = bool(getattr(args, "verbose", False))
    change_dir = resolve_path(args.change_dir)
    verification = args.verification
    if verification not in VERIFICATIONS:
        return emit_error(
            f"unsupported verification: {verification}; expected one of {sorted(VERIFICATIONS)}",
            as_json=as_json,
        )
    contract_v2 = _contract_is_v2(change_dir)
    if not contract_v2 and any(
        _nonempty_str(getattr(args, field, None))
        for field in ("base_commit", "diff_hash")
    ):
        return emit_error(
            "IDENTITY_UNSUPPORTED: explicit ledger identity requires a v2 change contract",
            as_json=as_json,
        )
    try:
        files, project_root = input_files_from_args(args)
    except (OSError, ValueError) as exc:
        return emit_error(f"record failed: {exc}", as_json=as_json)
    profile_input = getattr(args, "profile_input", None)
    project_raw = getattr(args, "project", None)
    if profile_input:
        if not project_raw:
            return emit_error("--profile-input requires --project", as_json=as_json)
        resolved_files, err = expand_profile_input_files(project_root, profile_input)
        if err:
            return emit_error(f"record failed: {err}", as_json=as_json)
        files = resolve_input_files(resolved_files, project_root)
    if not files:
        return emit_error(
            "record requires --files or a non-empty --profile-input file set",
            as_json=as_json,
        )

    try:
        status = normalize_status(args.status)
        inputs_hash, inputs_files = compute_inputs_hash(files)
        ledger, _existing_path = load_ledger(change_dir)
        if ledger is None:
            ledger = {
                "changeName": change_dir.name,
                "stateDir": str(change_dir),
                "validations": {},
            }
        elif not isinstance(ledger.get("validations"), dict):
            ledger["validations"] = {}

        # Preserve top-level diffHash and all other existing fields (backward compatible).
        entry = {}
        prev = ledger["validations"].get(verification)
        if isinstance(prev, dict):
            entry.update(prev)

        entry.update(
            {
                "status": status,
                "command": args.command,
                "evidence": args.evidence,
                "exitCode": args.exit_code,
                "durationMs": args.duration_ms,
                "inputsHash": inputs_hash,
                "inputsFiles": inputs_files,
                "finishedAt": now_iso(),
            }
        )
        metrics_raw = getattr(args, "metrics_json", None)
        metrics_file = getattr(args, "metrics_file", None)
        if metrics_file and metrics_raw is not None and str(metrics_raw).strip():
            return emit_error(
                "use only one of --metrics-json and --metrics-file",
                as_json=as_json,
            )
        if metrics_file:
            try:
                metrics_raw = Path(str(metrics_file)).expanduser().resolve().read_text(
                    encoding="utf-8-sig"
                )
            except OSError as exc:
                return emit_error(f"invalid --metrics-file: {exc}", as_json=as_json)
        if metrics_raw is not None and str(metrics_raw).strip() != "":
            try:
                metrics_obj = json.loads(str(metrics_raw))
            except json.JSONDecodeError:
                return emit_error("invalid --metrics-json", as_json=as_json)
            if not isinstance(metrics_obj, dict):
                return emit_error("invalid --metrics-json", as_json=as_json)
            if contract_v2:
                # Typed metrics schemas are ledger v3 (contract-gated); legacy
                # changes keep the loose run/failures shape (zero regression).
                problems = validate_metrics(verification, metrics_obj)
                if problems:
                    return emit_error(
                        "invalid metrics: " + "; ".join(problems), as_json=as_json
                    )
            entry["metrics"] = metrics_obj
        elif "metrics" in entry:
            # Fresh record without metrics must not keep stale metrics from prev.
            entry.pop("metrics", None)
        applicability_raw = getattr(args, "applicability", None)
        if applicability_raw:
            try:
                entry["applicability"] = build_applicability_entry(
                    str(applicability_raw).strip(),
                    reason=getattr(args, "applicability_reason", None),
                )
            except ValueError as exc:
                return emit_error(str(exc), as_json=as_json)
        if args.scope is not None and str(args.scope).strip():
            entry["scope"] = str(args.scope).strip()
        # No default scope: recording an incremental run as broad "module" scope
        # would let can-reuse wrongly approve untested classes (D13 guardrail).
        # Missing scope → can-reuse treats unitTest as insufficient-evidence.

        # v2 fields (cluster 2): algorithmVersion + coverage lattice + optional
        # toolchain/profile/environment hashes. v1 entries missing these are
        # conservatively invalidated by can-reuse (COM-002).
        entry["algorithmVersion"] = LEDGER_VERSION
        coverage = getattr(args, "coverage", None)
        if not (_nonempty_str(coverage) and str(coverage).strip() in COVERAGE_RANK):
            coverage = derive_coverage(verification, args.scope)
        entry["coverage"] = coverage
        for field, attr in (
            ("toolchainHash", "toolchain_hash"),
            ("profileHash", "profile_hash"),
            ("environmentHash", "environment_hash"),
        ):
            val = getattr(args, attr, None)
            if _nonempty_str(val):
                entry[field] = str(val).strip()
        # package verification: record build artifact + test-reuse provenance.
        if verification == "package":
            if _nonempty_str(getattr(args, "deploy_artifact", None)):
                entry["deployArtifact"] = str(args.deploy_artifact).strip()
            if _nonempty_str(getattr(args, "artifact_hash", None)):
                entry["sha256"] = str(args.artifact_hash).strip()
            entry["testsExecuted"] = bool(getattr(args, "tests_executed", False))
            if _nonempty_str(getattr(args, "tests_reused_from", None)):
                entry["testsReusedFrom"] = str(args.tests_reused_from).strip()

        # C9: bind scenario IDs from --scenario-ids to this ledger entry.
        scenario_ids_raw = getattr(args, "scenario_ids", None)
        if _nonempty_str(scenario_ids_raw):
            ids = [s.strip() for s in str(scenario_ids_raw).split(",") if s.strip()]
            if ids:
                entry["scenarioIds"] = ids
        elif "scenarioIds" in entry:
            # Fresh record without scenario-ids must not keep stale ids from prev.
            entry.pop("scenarioIds", None)

        ledger["validations"][verification] = entry
        if "changeName" not in ledger:
            ledger["changeName"] = change_dir.name
        if "stateDir" not in ledger:
            ledger["stateDir"] = str(change_dir)

        out_path = preferred_write_path(change_dir)
        if contract_v2:
            # Ledger v3: forced top-level identity (RET-15/16, COM-002).
            repo_probe = project_root or change_dir
            repo_root_raw = _git_text(repo_probe, "rev-parse", "--show-toplevel")
            if not repo_root_raw:
                return emit_error(
                    "record failed: change dir is not inside a git repository",
                    as_json=as_json,
                )
            repo_root = Path(repo_root_raw).resolve()
            try:
                contract = harness_paths.load_change_contract(change_dir)
            except (OSError, ValueError) as exc:
                return emit_error(f"record failed: {exc}", as_json=as_json)
            base_commit = getattr(args, "base_commit", None)
            if not _nonempty_str(base_commit):
                base_commit = ledger.get("baseCommit")
            if not _nonempty_str(base_commit):
                base_commit = _git_text(repo_root, "rev-parse", "--verify", "HEAD")
            current_head = _git_text(repo_root, "rev-parse", "--verify", "HEAD")
            diff_hash = getattr(args, "diff_hash", None)
            if not _nonempty_str(diff_hash) and _nonempty_str(base_commit):
                try:
                    diff_hash = compute_ownership_diff(
                        repo_root, base=str(base_commit).strip(), change_dir=change_dir
                    )["diffHash"]
                except (OSError, ValueError, RuntimeError):
                    diff_hash = None
            ledger["schemaVersion"] = LEDGER_SCHEMA_VERSION
            ledger["repositoryId"] = harness_paths.repository_identity(repo_root)
            ledger["changeName"] = change_dir.name
            if _nonempty_str(base_commit):
                ledger["baseCommit"] = str(base_commit).strip()
            if _nonempty_str(current_head):
                ledger["currentHead"] = str(current_head).strip()
            if _nonempty_str(diff_hash):
                ledger["diffHash"] = str(diff_hash).strip()
            ledger["ownershipHash"] = ownership_hash(contract)
            missing = validate_ledger_identity(ledger)
            if missing:
                return emit_error(
                    "ledger identity incomplete: " + ", ".join(missing),
                    as_json=as_json,
                    error_code="LEDGER_IDENTITY_INVALID",
                    extra={"missing": missing},
                )
        write_ledger(out_path, ledger)
    except (OSError, ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
        return emit_error(f"record failed: {exc}", as_json=as_json)

    payload = {
        "ok": True,
        "action": "record",
        "verification": verification,
        "status": status,
        "inputsHash": inputs_hash,
        "inputsFiles": inputs_files,
        "ledger_path": str(out_path),
        "diffHash": ledger.get("diffHash"),
        "resolvedProjectRoot": str(project_root) if project_root else None,
    }
    emit_compact_or_verbose(
        payload, as_json=as_json, verbose=verbose,
        compact_fn=_compact_record_payload,
    )
    return 0


def cmd_diff_hash(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    repo_raw = getattr(args, "repo", None)
    repo = Path(repo_raw).expanduser().resolve() if repo_raw else Path.cwd().resolve()
    base = getattr(args, "base", None)
    change_dir = getattr(args, "change_dir", None)
    try:
        diff_hash, meta = compute_diff_hash(repo, base=base, change_dir=change_dir)
    except (OSError, RuntimeError, ValueError) as exc:
        return emit_error(str(exc), as_json=as_json)
    payload = {"ok": True, "action": "diff-hash", "diffHash": diff_hash}
    payload.update(meta)
    emit_json(payload, as_json=as_json)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness_ledger.py",
        description="Compute inputsHash and manage verification-ledger reuse",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON on stdout",
    )
    sub = parser.add_subparsers(dest="command_name", required=True)

    # --json 也注册到每个子命令（default=SUPPRESS），使 --json 可放在子命令之后
    # （skill / Gate 命令均把 --json 放最后），且不会用子命令默认值覆盖
    # 在子命令之前传入的顶层 --json=True。
    shared_json = argparse.ArgumentParser(add_help=False)
    shared_json.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
    )

    p_hash = sub.add_parser("hash", parents=[shared_json], help="compute inputsHash for a file set")
    hash_files = p_hash.add_mutually_exclusive_group()
    hash_files.add_argument("--files", default=None, help="comma-separated source file paths")
    hash_files.add_argument("--files-from", default=None, help="UTF-8 newline-delimited source paths")
    p_hash.add_argument("--project", default=None, help="root for relative input paths")
    p_hash.set_defaults(func=cmd_hash)

    p_reuse = sub.add_parser("can-reuse", parents=[shared_json], help="decide whether a verification can be reused")
    p_reuse.add_argument("--change-dir", required=True)
    p_reuse.add_argument(
        "--verification",
        required=True,
        choices=sorted(VERIFICATIONS),
    )
    p_reuse.add_argument(
        "--files",
        default=None,
        help="comma-separated source file paths for current inputsHash",
    )
    p_reuse.add_argument(
        "--files-from",
        default=None,
        help="UTF-8 newline-delimited source paths",
    )
    p_reuse.add_argument(
        "--project",
        default=None,
        help="project root containing .harness/config/build-profile.json (for --profile-input)",
    )
    p_reuse.add_argument(
        "--profile-input",
        default=None,
        help="expand verificationInputs.<key> globs from build-profile as the file set; "
        "unitTestFull 最终门禁用此展开依赖闭包，禁止用仅含 staged 文件的 --files 冒充",
    )
    p_reuse.add_argument(
        "--scope",
        default=None,
        help="optional requested scope (unitTest coverage check)",
    )
    p_reuse.add_argument(
        "--command",
        default=None,
        help="optional command to compare against ledger entry",
    )
    p_reuse.add_argument(
        "--toolchain-hash",
        default=None,
        help="optional toolchain hash to compare against ledger entry (UT-017)",
    )
    p_reuse.add_argument(
        "--profile-hash",
        default=None,
        help="optional profile hash to compare against ledger entry (UT-017)",
    )
    p_reuse.add_argument(
        "--environment-hash",
        default=None,
        help="optional environment hash to compare against ledger entry (UT-017)",
    )
    p_reuse.add_argument(
        "--verbose",
        action="store_true",
        help="emit full payload (default: compact ok/reuse/code)",
    )
    p_reuse.set_defaults(func=cmd_can_reuse)

    p_record = sub.add_parser("record", parents=[shared_json], help="write validation result into ledger")
    p_record.add_argument("--change-dir", required=True)
    p_record.add_argument("--verification", required=True)
    p_record.add_argument("--status", required=True)
    p_record.add_argument("--command", required=True)
    p_record.add_argument("--exit-code", type=int, required=True)
    p_record.add_argument("--duration-ms", type=int, required=True)
    p_record_files = p_record.add_mutually_exclusive_group()
    p_record_files.add_argument("--files", default=None)
    p_record_files.add_argument("--files-from", default=None)
    p_record.add_argument("--evidence", required=True)
    p_record.add_argument(
        "--project",
        default=None,
        help="project root containing .harness/config/build-profile.json (for --profile-input)",
    )
    p_record.add_argument(
        "--profile-input",
        default=None,
        help="expand verificationInputs.<key> globs from build-profile as the file set",
    )
    p_record.add_argument(
        "--scope",
        default=None,
        help="optional scope (default module when absent on new entries)",
    )
    p_record.add_argument(
        "--coverage",
        default=None,
        help="optional coverage lattice value (incremental|module|module-am|full); derived when absent",
    )
    p_record.add_argument("--toolchain-hash", default=None)
    p_record.add_argument("--profile-hash", default=None)
    p_record.add_argument("--environment-hash", default=None)
    p_record.add_argument("--deploy-artifact", default=None, help="package: built artifact path")
    p_record.add_argument("--artifact-hash", default=None, help="package: artifact sha256")
    p_record.add_argument(
        "--tests-executed",
        type=lambda v: str(v).lower() in ("1", "true", "yes", "y"),
        default=False,
        help="package: whether tests ran in this package lifecycle",
    )
    p_record.add_argument(
        "--tests-reused-from",
        default=None,
        help="package: prior verifications reused when testsExecuted=false",
    )
    p_record.add_argument(
        "--metrics-json",
        default=None,
        help='structured counts, e.g. \'{"run":155,"failures":0}\' or \'{"total":3,"passed":3}\'',
    )
    p_record.add_argument(
        "--metrics-file",
        default=None,
        help="UTF-8 JSON file containing typed verification metrics",
    )
    p_record.add_argument(
        "--base-commit",
        default=None,
        help="ledger v3: base commit for identity (default: existing ledger value, else HEAD)",
    )
    p_record.add_argument(
        "--diff-hash",
        default=None,
        help="ledger v3: precomputed ownership diff hash (default: existing, else computed)",
    )
    p_record.add_argument(
        "--applicability",
        choices=("APPLICABLE", "NOT_APPLICABLE"),
        default=None,
        help="ledger v3: applicability of this verification to the change",
    )
    p_record.add_argument(
        "--applicability-reason",
        default=None,
        help="ledger v3: scope reason (required when --applicability NOT_APPLICABLE)",
    )
    p_record.add_argument(
        "--scenario-ids",
        default=None,
        help="comma-separated scenario IDs from scenario-manifest.json to bind to this entry",
    )
    p_record.add_argument(
        "--verbose",
        action="store_true",
        help="emit full payload (default: compact ok/action/verification/status)",
    )
    p_record.set_defaults(func=cmd_record)

    p_diff = sub.add_parser(
        "diff-hash",
        parents=[shared_json],
        help="compute commit-invariant byte-level diff hash for a repo",
    )
    p_diff.add_argument("--repo", default=None, help="repo root (default: cwd)")
    p_diff.add_argument("--base", default=None, help="base commit (default: root commit)")
    p_diff.add_argument(
        "--change-dir",
        default=None,
        help="change directory whose evidence/test-tracking.json contributes ignored tests",
    )
    p_diff.set_defaults(func=cmd_diff_hash)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
