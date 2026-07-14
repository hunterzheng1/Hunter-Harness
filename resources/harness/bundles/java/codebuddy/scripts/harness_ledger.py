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
import subprocess
import sys
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


VERIFICATIONS = frozenset({"compile", "unitTest", "unitTestFull", "apiTest", "install", "package"})
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
DIFF_HASH_VERSION = "content-changeset-1"
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


def emit_error(message: str, *, as_json: bool, code: int = 1) -> int:
    payload = {"ok": False, "error": message}
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


def compute_diff_hash(repo_root: Path, base: str | None = None) -> tuple[str, dict[str, Any]]:
    """Byte-level, commit-invariant diff hash (cluster 2).

    Content-based change set: every file whose working-tree content differs
    from base, plus untracked files. Each entry is length-framed
    (path-len | path | exists-flag | content-len | content) so the payload is
    independent of shell, console encoding, BOM and system newlines. Stable
    across a checkpoint commit because git does not mutate the working tree.
    """
    repo_root = Path(repo_root).resolve()
    base, paths = _changed_paths(repo_root, base)
    digest = hashlib.sha256()
    digest.update(DIFF_HASH_VERSION.encode("utf-8"))
    digest.update(b"\x00")
    for rel in paths:
        path_bytes = rel.encode("utf-8")
        digest.update(len(path_bytes).to_bytes(4, "big"))
        digest.update(path_bytes)
        abs_path = repo_root / rel
        if abs_path.is_file():
            content = abs_path.read_bytes()
            digest.update(b"\x01")
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
        else:
            # Deleted since base: record absence with no content.
            digest.update(b"\x00")
            digest.update((0).to_bytes(8, "big"))
    try:
        head = _git_bytes(["rev-parse", "HEAD"], repo_root).decode("utf-8", "replace").strip()
    except RuntimeError:
        head = ""
    meta = {
        "algorithmVersion": DIFF_HASH_VERSION,
        "fileCount": len(paths),
        "base": base,
        "head": head or None,
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

    Globs are relative to project; only files inside project are kept
    (deduped, path-sorted). Returns (files, error); error is None on success.
    profile 缺失 / key 缺失 / glob 无匹配 / 结果为空 → 返回 ([], "<reason>")，
    调用方据此返回 insufficient-evidence，执行全量测试但不允许缓存复用。
    """
    profile_path = project / ".harness" / "config" / "build-profile.json"
    if not profile_path.is_file():
        return [], "build-profile.json missing; run harness_preflight.py detect"
    try:
        profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return [], f"build-profile.json unreadable: {exc}"
    if not isinstance(profile, dict):
        return [], "build-profile.json is not an object"
    inputs = profile.get("verificationInputs")
    if not isinstance(inputs, dict) or profile_input not in inputs:
        return [], f"verificationInputs.{profile_input} missing in build-profile.json"
    patterns = inputs[profile_input]
    if not isinstance(patterns, list) or not patterns:
        return [], f"verificationInputs.{profile_input} is empty or invalid"

    base = project.resolve()
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


def ledger_candidates(change_dir: Path) -> list[Path]:
    return [
        change_dir / "evidence" / "verification-ledger.json",
        change_dir / "verification-ledger.json",
    ]


def find_ledger_path(change_dir: Path) -> Path | None:
    for path in ledger_candidates(change_dir):
        if path.is_file():
            return path
    return None


def preferred_write_path(change_dir: Path) -> Path:
    # New writes always go to evidence/ (protocol preferred path).
    return change_dir / "evidence" / "verification-ledger.json"


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
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.write_text(payload, encoding="utf-8", newline="\n")


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
    files = parse_files_arg(args.files)
    try:
        inputs_hash, inputs_files = compute_inputs_hash(files)
    except (OSError, FileNotFoundError) as exc:
        return emit_error(str(exc), as_json=as_json)

    payload = {
        "ok": True,
        "action": "hash",
        "inputsHash": inputs_hash,
        "inputsFiles": inputs_files,
        "fileCount": len(inputs_files),
    }
    emit_json(payload, as_json=as_json)
    return 0


def cmd_can_reuse(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    verification = args.verification
    if verification not in VERIFICATIONS:
        return emit_error(
            f"unsupported verification: {verification}; expected one of {sorted(VERIFICATIONS)}",
            as_json=as_json,
        )
    change_dir = resolve_path(args.change_dir)
    files = parse_files_arg(args.files)
    profile_input = getattr(args, "profile_input", None)
    project_raw = getattr(args, "project", None)
    if profile_input:
        if not project_raw:
            return emit_error("--profile-input requires --project", as_json=as_json)
        resolved_files, err = expand_profile_input_files(
            Path(str(project_raw)).expanduser().resolve(), profile_input
        )
        if err:
            # profile 未正确配置：不允许缓存复用，返回 insufficient-evidence（exit 0）。
            payload = {
                "ok": True,
                "reuse": False,
                "reason": "insufficient-evidence",
                "verification": verification,
                "detail": err,
            }
            emit_json(payload, as_json=as_json)
            return 0
        files = resolved_files
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

    emit_json(payload, as_json=as_json)
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    change_dir = resolve_path(args.change_dir)
    verification = args.verification
    files = parse_files_arg(args.files)
    profile_input = getattr(args, "profile_input", None)
    project_raw = getattr(args, "project", None)
    if profile_input:
        if not project_raw:
            return emit_error("--profile-input requires --project", as_json=as_json)
        resolved_files, err = expand_profile_input_files(
            Path(str(project_raw)).expanduser().resolve(), profile_input
        )
        if err:
            return emit_error(f"record failed: {err}", as_json=as_json)
        files = resolved_files
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

        ledger["validations"][verification] = entry
        if "changeName" not in ledger:
            ledger["changeName"] = change_dir.name
        if "stateDir" not in ledger:
            ledger["stateDir"] = str(change_dir)

        out_path = preferred_write_path(change_dir)
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
    }
    emit_json(payload, as_json=as_json)
    return 0


def cmd_diff_hash(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    repo_raw = getattr(args, "repo", None)
    repo = Path(repo_raw).expanduser().resolve() if repo_raw else Path.cwd().resolve()
    base = getattr(args, "base", None)
    try:
        diff_hash, meta = compute_diff_hash(repo, base=base)
    except (OSError, RuntimeError) as exc:
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
    p_hash.add_argument(
        "--files",
        required=True,
        help="comma-separated source file paths",
    )
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
    p_reuse.set_defaults(func=cmd_can_reuse)

    p_record = sub.add_parser("record", parents=[shared_json], help="write validation result into ledger")
    p_record.add_argument("--change-dir", required=True)
    p_record.add_argument("--verification", required=True)
    p_record.add_argument("--status", required=True)
    p_record.add_argument("--command", required=True)
    p_record.add_argument("--exit-code", type=int, required=True)
    p_record.add_argument("--duration-ms", type=int, required=True)
    p_record.add_argument("--files", default=None)
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
    p_record.set_defaults(func=cmd_record)

    p_diff = sub.add_parser(
        "diff-hash",
        parents=[shared_json],
        help="compute commit-invariant byte-level diff hash for a repo",
    )
    p_diff.add_argument("--repo", default=None, help="repo root (default: cwd)")
    p_diff.add_argument("--base", default=None, help="base commit (default: root commit)")
    p_diff.set_defaults(func=cmd_diff_hash)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
