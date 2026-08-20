#!/usr/bin/env python3
"""Resolve Harness runtimes into a reusable, argv-based phase capsule."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
import fnmatch
from collections.abc import Sequence
from typing import Any, Callable

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SCHEMA_VERSION = 1
RUN_SESSION_SCHEMA_VERSION = 1
RUN_TERMINAL_STATUSES = {"OK", "FAIL", "INCOMPLETE", "CANCELLED"}
_CHANGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SECRET_SCAN_RULES_VERSION = "secret-scan-v2"
SECRET_SCAN_RECEIPT_REL = Path("meta") / "secret-scan-receipt.json"
# 变更目录里只有一部分内容会被发布：归档包成员是 reports/final/summary-data.json、
# spec/**.md、plans/**.md、candidates/knowledge.json、meta/archive-meta.md、
# meta/change-context.json。runtime/ 是各阶段的草稿（review 的 diff、临时校验
# 脚本、命令输出重定向），从不入包——拿它挡发布，挡的是永远不会离开本机的字节。
PUBLICATION_EXCLUDED_DIRS: tuple[str, ...] = ("runtime",)
_SENSITIVE_ASSIGNMENT = re.compile(
    rb"(?i)[\"']?(?:password|passwd|token|secret|cookie|database[_-]?url)"
    rb"[\"']?\s*[:=]\s*[\"']?(?P<value>[^\s\"']{4,})"
)
_AUTHORIZATION_ASSIGNMENT = re.compile(
    rb"(?i)[\"']?authorization[\"']?\s*[:=]\s*[\"']?"
    rb"(?:(?:bearer|basic)\s+)?(?P<value>[^\s\"']{4,})"
)
_ADAPTERS = {
    "claude-code": (".worktrees", "harness/"),
    "codex": (".worktrees", "harness/"),
    "cursor": (".worktrees", "harness/"),
    "codebuddy": (".worktrees", "harness/"),
}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def _stage_transition(receipt: dict[str, Any], next_stage: str) -> None:
    ended_at = now_iso()
    started_at = str(receipt.get("stageStartedAt") or ended_at)
    try:
        started = dt.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        ended = dt.datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
        wall_ms = max(0, int((ended - started).total_seconds() * 1000))
    except ValueError:
        wall_ms = 0
    stage = str(receipt.get("stage") or "unknown")
    timings = receipt.setdefault("stageTimings", [])
    if isinstance(timings, list):
        timings.append(
            {
                "stage": stage,
                "createdAt": started_at,
                "endedAt": ended_at,
                "wallClockMs": wall_ms,
                "activeTimeMs": 0 if stage == "resource-wait" else wall_ms,
                "resourceWaitMs": wall_ms if stage == "resource-wait" else 0,
            }
        )
    receipt["stage"] = next_stage
    receipt["stageStartedAt"] = ended_at


def _close_current_stage(receipt: dict[str, Any]) -> None:
    current = str(receipt.get("stage") or "record")
    _stage_transition(receipt, current)
    timings = receipt.get("stageTimings")
    if isinstance(timings, list) and timings:
        receipt["stageStartedAt"] = timings[-1].get("endedAt")


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    fd, raw_tmp = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    tmp = Path(raw_tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # Windows can transiently deny replacement while another process has
        # just finished reading the receipt.  Keep the atomic replace contract,
        # but retry the sharing violation within a small bounded window.
        for attempt in range(20):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.01 * (attempt + 1))
    finally:
        tmp.unlink(missing_ok=True)


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _is_excluded(relative: str, exclude_dirs: Sequence[str]) -> bool:
    """Path is inside one of the excluded top-level directories."""
    head = relative.split("/", 1)[0]
    return head in exclude_dirs


def _publishable_tree_digest(
    root: Path, *, exclude_dirs: Sequence[str] = ()
) -> str:
    """Hash publishable bytes while excluding the self-referential scan receipt."""
    root = root.expanduser().resolve()
    digest = hashlib.sha256()
    receipt = (root / SECRET_SCAN_RECEIPT_REL).resolve()
    if not root.is_dir():
        raise OSError(f"publishable evidence root not found: {root}")
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.resolve() == receipt:
            continue
        if exclude_dirs and _is_excluded(
            path.relative_to(root).as_posix(), exclude_dirs
        ):
            continue
        relative = path.relative_to(root).as_posix()
        data = path.read_bytes()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(len(data)).encode("ascii"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(data).digest())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def _sensitive_evidence_receipt_path(change_root: Path) -> Path:
    return change_root.expanduser().resolve() / SECRET_SCAN_RECEIPT_REL


def _private_evidence_root(explicit: Path | None = None) -> Path:
    configured = os.environ.get("HARNESS_PRIVATE_EVIDENCE_ROOT")
    return (explicit if explicit is not None else Path(configured) if configured else
            Path.home() / ".harness" / "private-evidence").expanduser().resolve()


def private_evidence_root_for(source: Path, explicit: Path | None = None) -> Path:
    """私有隔离根：必须与源同一驱动器。

    `os.replace` 跨驱动器会直接失败（Windows 上是 WinError 17）。默认根
    `~/.harness/private-evidence` 在 Windows 落 C 盘，项目在别的盘时隔离必然失败
    ——而隔离是归档的硬前置，等于整条归档路被堵死。同盘时沿用配置/默认值；不同盘
    时退到源所在驱动器根下的 `.harness-private-evidence`（天然在任何项目根之外）。
    POSIX 上 drive 恒为空串，行为不变。
    """
    source = source.expanduser().resolve()
    preferred = _private_evidence_root(explicit)
    if preferred.drive.lower() == source.drive.lower():
        return preferred
    return (Path(source.anchor) / ".harness-private-evidence").resolve()


def _infer_project_root(change_root: Path) -> Path | None:
    """change 目录形如 `<project>/.harness/changes/<name>`：取路径里 `.harness` 段的父目录。

    不做"向上找存在 .harness 的目录"式搜索——用户 HOME 下通常也有 `.harness`，
    那样会把 HOME 误判成项目根，把合法的临时隔离位置一并拒掉。
    """
    parts = change_root.parts
    for index in range(len(parts) - 1, 0, -1):
        if parts[index] == ".harness":
            return Path(*parts[:index])
    return None


def _secure_private_path(path: Path, *, directory: bool) -> str:
    """Best-effort owner-only permissions, with an explicit ACL result on Windows."""
    mode = 0o700 if directory else 0o600
    try:
        path.chmod(mode)
    except OSError:
        pass
    if os.name != "nt":
        return "POSIX_OWNER_ONLY"
    try:
        account = os.environ.get("USERNAME") or os.environ.get("USER")
        if not account:
            account = subprocess.check_output(
                ["whoami"], stderr=subprocess.DEVNULL, text=True, encoding="utf-8"
            ).strip()
        result = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{account}:F"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
        return "WINDOWS_CURRENT_USER_ONLY" if result.returncode == 0 else "WINDOWS_ACL_UNVERIFIED"
    except (OSError, subprocess.SubprocessError):
        return "WINDOWS_ACL_UNVERIFIED"


# runtime/ 下哪些是**过程草稿**。白名单式判断：只删明确列举的形态，
# 其余一律保留——门禁、租约、恢复和证据都住在这棵树里，宁可留垃圾也不能误删。
SCRATCH_PATTERNS: tuple[str, ...] = (
    "*.patch",
    "*.diff",
    "*-input.json",
    "*-input[0-9].json",
    "findings-rereview.json",
    "archive-out*.json",
    "fixback-*-check.*",
)
# 即便命中上面的形态也必须留下的名字：它们是运行态，不是草稿。
SCRATCH_KEEP: frozenset[str] = frozenset({
    "context-lease.json",
    "fixback-session.json",
    "preflight.json",
})


def sweep_scratch(change_root: Path, *, dry_run: bool = False) -> dict[str, Any]:
    """清掉 runtime/ 顶层的过程草稿，保留运行态、会话、证据与报告。

    一轮流程下来 runtime/ 会堆满 diff、临时校验脚本和命令输出重定向。没人清，
    而且它们会被其他门禁读到——2026-08-19 那次，review 自己生成的两个 diff
    直接把归档挡住了。

    只扫 runtime/ 顶层文件：run-sessions/ 等子目录是托管会话证据，不进扫描。
    """
    change_root = change_root.expanduser().resolve()
    runtime_dir = change_root / "runtime"
    removed: list[str] = []
    if not runtime_dir.is_dir():
        return {"ok": True, "code": "SCRATCH_SWEPT", "removed": [], "dryRun": dry_run}
    errors: list[dict[str, str]] = []
    for path in sorted(runtime_dir.iterdir()):
        if not path.is_file() or path.name in SCRATCH_KEEP:
            continue
        if not any(fnmatch.fnmatch(path.name, pattern) for pattern in SCRATCH_PATTERNS):
            continue
        relative = path.relative_to(change_root).as_posix()
        if dry_run:
            removed.append(relative)
            continue
        try:
            path.unlink()
        except OSError as exc:
            errors.append({"path": relative, "error": str(exc)})
            continue
        removed.append(relative)
    return {
        "ok": not errors,
        "code": "SCRATCH_SWEPT" if not errors else "SCRATCH_SWEEP_PARTIAL",
        "removed": removed,
        "errors": errors,
        "dryRun": dry_run,
    }


def _sensitive_candidates(
    root: Path, *, exclude_dirs: Sequence[str] = ()
) -> list[dict[str, Any]]:
    """Find high-confidence plaintext assignments without treating prose as a secret.

    ``exclude_dirs`` scopes the scan to what a caller actually publishes. The
    default stays whole-tree: the quarantine flow depends on seeing legacy
    plaintext anywhere under the change, including scratch directories.
    """
    # Compare by relative path, not by resolve() per file: this loop covers the
    # whole change tree, and on Windows each resolve() is a realpath syscall.
    receipt_rel = SECRET_SCAN_RECEIPT_REL.as_posix()
    candidates: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if relative == receipt_rel:
            continue
        if exclude_dirs and _is_excluded(relative, exclude_dirs):
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        finding = next(
            (
                match
                for pattern in (_SENSITIVE_ASSIGNMENT, _AUTHORIZATION_ASSIGNMENT)
                for match in pattern.finditer(raw)
                if not _is_sensitive_placeholder(match.group("value"))
            ),
            None,
        )
        if finding is None:
            continue
        candidates.append({
            "path": path.relative_to(root).as_posix(),
            "reasonCode": "PLAINTEXT_SENSITIVE_ASSIGNMENT",
            "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        })
    return candidates


def _is_sensitive_placeholder(value: bytes) -> bool:
    text = value.decode("utf-8", errors="ignore").strip().strip("`'").strip()
    return bool(
        re.fullmatch(r"<[^<>]+>", text)
        or re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", text)
        or re.fullmatch(r"\{\{[^{}]+\}\}", text)
        or re.fullmatch(
            r"(?i)(?:example|placeholder|redacted|masked|bearer|basic|"
            r"your[-_][A-Za-z0-9_-]+|x{4,})",
            text,
        )
    )


def publishable_tree_digest(
    root: Path, *, exclude_dirs: Sequence[str] = ()
) -> str:
    """Public digest helper shared by the archive publication gate."""
    return _publishable_tree_digest(root, exclude_dirs=exclude_dirs)


def sensitive_evidence_receipt_path(change_root: Path) -> Path:
    return _sensitive_evidence_receipt_path(change_root)


def sensitive_evidence_candidates(
    root: Path, *, exclude_dirs: Sequence[str] = ()
) -> list[dict[str, Any]]:
    return _sensitive_candidates(root, exclude_dirs=exclude_dirs)


def _build_sensitive_scan_receipt(
    change_root: Path,
    *,
    entries: list[dict[str, Any]],
    unresolved: list[dict[str, Any]],
    status: str,
    exclude_dirs: Sequence[str] = (),
) -> dict[str, Any]:
    change_root = change_root.expanduser().resolve()
    return {
        "schemaVersion": 1,
        "rulesVersion": SECRET_SCAN_RULES_VERSION,
        "changeId": change_root.name,
        "status": status,
        "unresolvedFailures": unresolved,
        "entries": entries,
        "publishableTreeDigest": _publishable_tree_digest(
            change_root, exclude_dirs=exclude_dirs
        ),
        # 收据自述扫描范围：复算摘要的一方据此排除同样的目录，
        # 否则两侧口径不同会误报 digest 漂移。
        "publicationExcludedDirs": list(exclude_dirs),
        "publicationExcluded": True,
        "recordedAt": now_iso(),
    }


def _write_sensitive_scan_receipt(
    change_root: Path,
    *,
    entries: list[dict[str, Any]],
    unresolved: list[dict[str, Any]],
    status: str,
    exclude_dirs: Sequence[str] = (),
) -> dict[str, Any]:
    change_root = change_root.expanduser().resolve()
    receipt = _build_sensitive_scan_receipt(
        change_root,
        entries=entries,
        unresolved=unresolved,
        status=status,
        exclude_dirs=exclude_dirs,
    )
    atomic_write_json(_sensitive_evidence_receipt_path(change_root), receipt)
    return receipt


def quarantine_sensitive_evidence(
    source: Path,
    *,
    change_root: Path,
    reason: str = "sensitive evidence",
    private_root: Path | None = None,
    project_root: Path | None = None,
) -> dict[str, Any]:
    """Atomically move legacy plaintext evidence outside any publishable tree."""
    source = source.expanduser().resolve()
    change_root = change_root.expanduser().resolve()
    private = private_evidence_root_for(source, private_root)
    if not source.is_file():
        return {"ok": False, "reasonCode": "SENSITIVE_EVIDENCE_SOURCE_MISSING", "sourcePath": str(source)}
    if private == change_root or private.is_relative_to(change_root):
        return {
            "ok": False,
            "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
            "error": "private quarantine root must be outside the publishable change root",
        }
    # 归档的密钥扫描门禁按**项目根**判定（SECRET_SCAN_PRIVATE_PATH_IN_COPY_ROOT）。
    # 这里此前只看 change_root，比门禁宽——于是隔离"成功"了，门禁再拒一次，调用方
    # 得多试一轮才找到合法位置。对齐到同一条边界，错就错在当场。
    resolved_project = (
        project_root.expanduser().resolve()
        if project_root is not None
        else _infer_project_root(change_root)
    )
    if resolved_project is not None and (
        private == resolved_project or private.is_relative_to(resolved_project)
    ):
        return {
            "ok": False,
            "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
            "error": (
                "private quarantine root must be outside the project root "
                f"({resolved_project}); archive's secret scan rejects paths inside it"
            ),
        }
    try:
        raw_digest = "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
        quarantine_dir = private / uuid.uuid4().hex
        quarantine_dir.mkdir(parents=True, exist_ok=False)
        acl_dir = _secure_private_path(quarantine_dir, directory=True)
        target = quarantine_dir / "payload.bin"
        os.replace(source, target)
        acl_file = _secure_private_path(target, directory=False)
        if os.name == "nt" and (
            acl_dir != "WINDOWS_CURRENT_USER_ONLY"
            or acl_file != "WINDOWS_CURRENT_USER_ONLY"
        ):
            os.replace(target, source)
            shutil.rmtree(quarantine_dir, ignore_errors=True)
            return {
                "ok": False,
                "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
                "error": "private quarantine ACL could not be restricted to the current user",
            }
        moved_digest = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
        if moved_digest != raw_digest:
            os.replace(target, source)
            shutil.rmtree(quarantine_dir, ignore_errors=True)
            return {
                "ok": False,
                "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
                "error": "quarantine digest verification failed",
            }
        try:
            prior = json.loads(
                _sensitive_evidence_receipt_path(change_root).read_text(
                    encoding="utf-8-sig"
                )
            )
        except (OSError, json.JSONDecodeError):
            prior = {}
        entries = list(prior.get("entries") or []) if isinstance(prior, dict) else []
        entries.append({
            "sourcePath": (
                source.relative_to(change_root).as_posix()
                if source.is_relative_to(change_root)
                else source.name
            ),
            "sourceDigest": raw_digest,
            "privatePath": str(target),
            "reason": reason[:160],
            "status": "QUARANTINED",
            "acl": {"directory": acl_dir, "file": acl_file},
            "movedAt": now_iso(),
        })
        try:
            receipt = _write_sensitive_scan_receipt(
                change_root,
                entries=entries,
                unresolved=[],
                status="QUARANTINED",
            )
        except BaseException as exc:
            try:
                os.replace(target, source)
            except OSError:
                pass
            shutil.rmtree(quarantine_dir, ignore_errors=True)
            return {
                "ok": False,
                "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
                "error": str(exc),
            }
        return {
            "ok": True,
            "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINED",
            "sourceDigest": raw_digest,
            "privatePath": str(target),
            "receiptPath": str(_sensitive_evidence_receipt_path(change_root)),
            "receipt": receipt,
        }
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        # No copy is retained on failure.  If os.replace crossed filesystems it
        # fails before removing the source, which is the required fail-closed path.
        return {
            "ok": False,
            "reasonCode": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
            "error": str(exc),
        }


def ensure_sensitive_evidence_scan_receipt(change_root: Path) -> dict[str, Any]:
    """Create a digest-bound scan receipt for a tree with no plaintext findings."""
    change_root = change_root.expanduser().resolve()
    unresolved = _sensitive_candidates(change_root)
    if unresolved:
        return _write_sensitive_scan_receipt(
            change_root,
            entries=[],
            unresolved=unresolved,
            status="FAIL",
        )
    return _write_sensitive_scan_receipt(
        change_root,
        entries=[],
        unresolved=[],
        status="OK",
    )


def refresh_sensitive_evidence_scan_receipt(
    change_root: Path,
    *,
    persist: bool = True,
    exclude_dirs: Sequence[str] = (),
) -> dict[str, Any]:
    """Rescan current bytes while preserving valid quarantine audit entries."""
    change_root = change_root.expanduser().resolve()
    receipt_path = _sensitive_evidence_receipt_path(change_root)
    entries: list[dict[str, Any]] = []
    if receipt_path.is_file():
        try:
            prior = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            return {
                "ok": False,
                "reasonCode": "SECRET_SCAN_RECEIPT_INVALID",
                "receiptPath": str(receipt_path),
                "error": str(exc),
            }
        if not isinstance(prior, dict):
            return {
                "ok": False,
                "reasonCode": "SECRET_SCAN_RECEIPT_INVALID",
                "receiptPath": str(receipt_path),
                "error": "receipt must be an object",
            }
        prior_entries = prior.get("entries")
        prior_unresolved = prior.get("unresolvedFailures")
        valid_identity = (
            prior.get("schemaVersion") == 1
            and prior.get("rulesVersion") == SECRET_SCAN_RULES_VERSION
            and prior.get("changeId") == change_root.name
            and prior.get("publicationExcluded") is True
            and str(prior.get("status") or "").upper()
            in {"OK", "QUARANTINED", "FAIL"}
        )
        if (
            not valid_identity
            or not isinstance(prior_entries, list)
            or not isinstance(prior_unresolved, list)
        ):
            return {
                "ok": False,
                "reasonCode": "SECRET_SCAN_RECEIPT_INVALID",
                "receiptPath": str(receipt_path),
                "error": "receipt identity or collection fields are invalid",
            }
        entries = list(prior_entries)

    unresolved = _sensitive_candidates(change_root, exclude_dirs=exclude_dirs)
    status = "FAIL" if unresolved else "QUARANTINED" if entries else "OK"
    if persist:
        try:
            receipt = _write_sensitive_scan_receipt(
                change_root,
                entries=entries,
                unresolved=unresolved,
                status=status,
                exclude_dirs=exclude_dirs,
            )
        except OSError as exc:
            return {
                "ok": False,
                "reasonCode": "SECRET_SCAN_RECEIPT_REFRESH_FAILED",
                "receiptPath": str(receipt_path),
                "error": str(exc),
            }
    else:
        receipt = _build_sensitive_scan_receipt(
            change_root,
            entries=entries,
            unresolved=unresolved,
            status=status,
            exclude_dirs=exclude_dirs,
        )
    return {
        "ok": not unresolved,
        "reasonCode": (
            "SENSITIVE_EVIDENCE_UNQUARANTINED"
            if unresolved
            else "SECRET_SCAN_RECEIPT_REFRESHED"
        ),
        "receiptPath": str(receipt_path),
        "receipt": receipt,
        "persisted": persist,
        "unresolvedFailures": unresolved,
    }


def _run_sessions_root(state_root: Path) -> Path:
    return state_root.expanduser().resolve() / "runtime" / "run-sessions"


def _run_session_root(state_root: Path, session_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", session_id):
        raise ValueError(f"RUN_SESSION_ID_INVALID: {session_id}")
    return _run_sessions_root(state_root) / session_id


def _run_receipt_path(state_root: Path, session_id: str) -> Path:
    return _run_session_root(state_root, session_id) / "session.json"


def _resource_lock_secrets_path(state_root: Path, session_id: str) -> Path:
    return _run_session_root(state_root, session_id) / "resource-lock-secrets.json"


def _load_run_receipt(state_root: Path, session_id: str) -> dict[str, Any]:
    path = _run_receipt_path(state_root, session_id)
    last_error: OSError | None = None
    for attempt in range(20):
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            break
        except FileNotFoundError as exc:
            raise ValueError(f"RUN_SESSION_NOT_FOUND: {session_id}") from exc
        except PermissionError as exc:
            last_error = exc
            if attempt == 19:
                raise ValueError(
                    f"RUN_SESSION_RECEIPT_BUSY: {session_id}"
                ) from exc
            time.sleep(0.01 * (attempt + 1))
    else:
        raise ValueError(f"RUN_SESSION_RECEIPT_BUSY: {session_id}") from last_error
    if not isinstance(value, dict):
        raise ValueError(f"RUN_SESSION_CORRUPT: {session_id}")
    return value


def _load_resource_lock_tokens(
    state_root: Path,
    session_id: str,
    receipt: dict[str, Any],
) -> dict[str, str]:
    """Load lock tokens from a private sidecar; legacy receipts may inline them."""
    path = _resource_lock_secrets_path(state_root, session_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        if isinstance(value, dict) and isinstance(value.get("tokens"), dict):
            return {
                str(name): str(token)
                for name, token in value["tokens"].items()
                if isinstance(name, str) and isinstance(token, str)
            }
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    legacy = receipt.get("resourceLockTokens")
    if isinstance(legacy, dict):
        return {
            str(name): str(token)
            for name, token in legacy.items()
            if isinstance(name, str) and isinstance(token, str)
        }
    return {}


def _receipt_identity_state(
    receipt: dict[str, Any],
    *,
    field: str = "workerIdentity",
) -> bool | None:
    """Verify a canonical provider attestation, with legacy facade fallback."""
    identity = receipt.get(field)
    pid = identity.get("pid") if isinstance(identity, dict) else receipt.get("workerPid")
    if isinstance(identity, dict) and {
        "schemaVersion",
        "createdAt",
        "fieldProvenance",
        "capabilities",
    } <= set(identity):
        from harness_process import observe_process_identity, verify_process_identity

        observed = observe_process_identity(pid)
        decision = verify_process_identity(identity, observed)
        if decision.get("ok") is True:
            return True
        if decision.get("reasonCode") == "IDENTITY_UNVERIFIABLE":
            return None
        return False
    from harness_service import verify_process_identity

    legacy = {
        "pid": pid,
        "startedAt": (
            identity.get("startedAt")
            if isinstance(identity, dict)
            else None
        ),
        "processIdentity": {
            "executable": (
                identity.get("executable")
                if isinstance(identity, dict)
                else None
            )
        },
    }
    return verify_process_identity(legacy)


def _capture_provider_members(spawned: Any) -> None:
    """Persist current provider-owned members before a later cleanup."""
    proof = getattr(spawned, "ownershipProof", None)
    leader = getattr(spawned, "attestation", None)
    if not isinstance(proof, dict) or not isinstance(leader, dict):
        return
    from harness_process import capture_owned_members

    capture_owned_members(spawned)


def _resource_lock_root() -> Path:
    return Path(
        os.environ.get(
            "HARNESS_RESOURCE_LOCK_ROOT",
            str(Path(tempfile.gettempdir()) / "hunter-harness-resource-locks"),
        )
    ).expanduser().resolve()


def _resource_lock_path(_state_root: Path, lock_name: str) -> Path:
    digest = hashlib.sha256(lock_name.encode("utf-8")).hexdigest()
    return _resource_lock_root() / f"{digest}.json"


def _lock_owner_identity(owner: Any) -> bool | None:
    if not isinstance(owner, dict):
        return None
    pid = owner.get("pid")
    started_at = owner.get("startedAt")
    executable = owner.get("executable")
    if (
        not isinstance(pid, int)
        or pid <= 0
        or not isinstance(started_at, str)
        or not started_at
        or not isinstance(executable, str)
        or not executable
    ):
        return None
    from harness_service import verify_process_identity

    return verify_process_identity(
        {
            "pid": pid,
            "startedAt": started_at,
            "processIdentity": {"executable": executable},
        }
    )


def _valid_resource_lock_record(
    record: Any,
    *,
    lock_name: str,
) -> bool:
    return bool(
        isinstance(record, dict)
        and record.get("schemaVersion") == 2
        and record.get("lockName") == lock_name
        and isinstance(record.get("sessionId"), str)
        and record.get("sessionId")
        and isinstance(record.get("token"), str)
        and record.get("token")
        and isinstance(record.get("heartbeatAtUnix"), (int, float))
        and isinstance(record.get("expiresAtUnix"), (int, float))
        and _lock_owner_identity(record.get("owner")) is not None
    )


def _write_resource_lock(
    path: Path,
    *,
    lock_name: str,
    session_id: str,
    token: str,
    owner: dict[str, Any],
    acquired_at: str,
) -> None:
    now = time.time()
    atomic_write_json(
        path,
        {
            "schemaVersion": 2,
            "lockName": lock_name,
            "sessionId": session_id,
            "token": token,
            "acquiredAt": acquired_at,
            "heartbeatAtUnix": now,
            "expiresAtUnix": now + 300.0,
            "owner": owner,
        },
    )


def _refresh_resource_locks(
    state_root: Path,
    session_id: str,
    tokens: dict[str, str],
    owner: dict[str, Any],
) -> bool:
    refreshed = True
    for lock_name, token in sorted(tokens.items()):
        path = _resource_lock_path(state_root, lock_name)
        try:
            record = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            refreshed = False
            continue
        if (
            not _valid_resource_lock_record(record, lock_name=lock_name)
            or record.get("sessionId") != session_id
            or record.get("token") != token
        ):
            refreshed = False
            continue
        _write_resource_lock(
            path,
            lock_name=lock_name,
            session_id=session_id,
            token=token,
            owner=owner,
            acquired_at=str(record["acquiredAt"]),
        )
    return refreshed


def _release_resource_locks(
    state_root: Path,
    session_id: str,
    tokens: dict[str, str],
) -> bool:
    released = True
    for lock_name, token in sorted(tokens.items()):
        path = _resource_lock_path(state_root, lock_name)
        try:
            record = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            continue
        except (OSError, json.JSONDecodeError):
            released = False
            continue
        if (
            not isinstance(record, dict)
            or record.get("sessionId") != session_id
            or record.get("token") != token
        ):
            released = False
            continue
        try:
            path.unlink()
        except OSError:
            released = False
    return released


def _acquire_resource_locks(
    state_root: Path,
    session_id: str,
    lock_names: list[str],
) -> tuple[dict[str, str], dict[str, Any] | None]:
    tokens: dict[str, str] = {}
    for lock_name in lock_names:
        path = _resource_lock_path(state_root, lock_name)
        path.parent.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        owner_identity = _process_identity(os.getpid(), sys.executable)
        now = time.time()
        record = {
            "schemaVersion": 2,
            "lockName": lock_name,
            "sessionId": session_id,
            "token": token,
            "acquiredAt": now_iso(),
            "heartbeatAtUnix": now,
            "expiresAtUnix": now + 300.0,
            "owner": owner_identity,
        }
        encoded = (
            json.dumps(record, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        for attempt in range(2):
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                owner: dict[str, Any] | None = None
                try:
                    loaded = json.loads(path.read_text(encoding="utf-8-sig"))
                    owner = loaded if isinstance(loaded, dict) else None
                except (OSError, json.JSONDecodeError):
                    owner = None
                reclaimable = bool(
                    _valid_resource_lock_record(owner, lock_name=lock_name)
                    and _lock_owner_identity(owner.get("owner")) is False
                )
                if reclaimable and attempt == 0:
                    try:
                        current = json.loads(path.read_text(encoding="utf-8-sig"))
                        if current.get("token") == owner.get("token"):
                            path.unlink()
                            continue
                    except (OSError, json.JSONDecodeError):
                        pass
                _release_resource_locks(state_root, session_id, tokens)
                return {}, {
                    "lockName": lock_name,
                    "ownerSessionId": (
                        owner.get("sessionId") if owner is not None else None
                    ),
                    "lockRecordValid": bool(
                        _valid_resource_lock_record(owner, lock_name=lock_name)
                    ),
                    "ownerIdentity": (
                        _lock_owner_identity(owner.get("owner"))
                        if owner is not None
                        else None
                    ),
                }
            else:
                break
        else:
            raise RuntimeError("RESOURCE_LOCK_ACQUIRE_RETRY_EXHAUSTED")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            _release_resource_locks(state_root, session_id, tokens)
            raise
        tokens[lock_name] = token
    return tokens, None


def _write_run_receipt(state_root: Path, receipt: dict[str, Any]) -> None:
    _update_receipt_contract(receipt)
    publishable = json.loads(json.dumps(receipt, ensure_ascii=False))
    raw_tokens = publishable.pop("resourceLockTokens", {})
    if isinstance(raw_tokens, dict):
        publishable["resourceLockTokenHashes"] = {
            str(name): _sha256_json(str(token))
            for name, token in raw_tokens.items()
            if isinstance(name, str) and isinstance(token, str)
        }
    atomic_write_json(
        _run_receipt_path(state_root, str(receipt["sessionId"])),
        publishable,
    )


def _process_identity(pid: int, executable_hint: str) -> dict[str, Any]:
    from harness_process import observe_process_identity

    observed = observe_process_identity(pid)
    if not observed.get("executable"):
        observed["executable"] = _absolute_executable(executable_hint)
        observed["fieldProvenance"]["executable"] = "ATTESTED"
    if not observed.get("createdAt"):
        observed["createdAt"] = now_iso()
        observed["fieldProvenance"]["createdAt"] = "ATTESTED"
    # ``startedAt`` is a compatibility alias used by legacy session readers;
    # canonical identity comparisons use ``createdAt`` and provenance.
    observed["startedAt"] = observed.get("createdAt")
    return observed


def _log_contract(path: Path) -> dict[str, Any]:
    raw = b""
    if path.is_file():
        try:
            raw = path.read_bytes()
        except OSError:
            raw = b""
    try:
        raw.decode("utf-8")
        decode_status = "OK"
    except UnicodeDecodeError:
        decode_status = "LOG_DECODE_DEGRADED"
    return {
        "cursor": len(raw),
        "rawDigest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "decodeStatus": decode_status,
    }


def _update_receipt_contract(receipt: dict[str, Any]) -> None:
    worker = receipt.get("workerIdentity")
    writer_source = worker if isinstance(worker, dict) else {
        "pid": receipt.get("workerPid") or receipt.get("launcherPid")
    }
    heartbeat_kind = "WORKER" if isinstance(worker, dict) else "SUPERVISOR"
    receipt["heartbeat"] = {
        "kind": heartbeat_kind,
        "writerIdentity": _sha256_json(writer_source),
        "lastSeenAt": str(receipt.get("lastHeartbeatAt") or now_iso()),
        "ttlSeconds": max(1, int(float(receipt.get("heartbeatSeconds") or 30))),
        "staleReason": (
            "SERVICE_HEARTBEAT_STALE"
            if receipt.get("reasonCode") == "HEARTBEAT_LOST"
            else None
        ),
    }
    receipt["logs"] = {
        "stdout": _log_contract(Path(str(receipt.get("stdoutPath") or ""))),
        "stderr": _log_contract(Path(str(receipt.get("stderrPath") or ""))),
    }
    cleanup_status = str(receipt.get("cleanupStatus") or "")
    complete = cleanup_status in {
        "NO_CHILD",
        "PROCESS_EXITED",
        "PROCESS_TREE_TERMINATED",
    }
    receipt["cleanup"] = {
        "complete": complete,
        "reasonCode": None if complete else receipt.get("reasonCode"),
    }


def _spawn_detached_worker(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    output: Any = subprocess.DEVNULL,
) -> subprocess.Popen[bytes]:
    kwargs: dict[str, Any] = {
        "cwd": str(cwd),
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": output,
        "stderr": output,
        "close_fds": True,
    }
    if os.name == "nt":
        detached = 0x00000008
        new_group = 0x00000200
        no_window = 0x08000000
        breakaway = 0x01000000
        try:
            return subprocess.Popen(
                argv,
                creationflags=detached | new_group | no_window | breakaway,
                **kwargs,
            )
        except OSError:
            return subprocess.Popen(
                argv,
                creationflags=detached | new_group | no_window,
                **kwargs,
            )
    return subprocess.Popen(argv, start_new_session=True, **kwargs)


def start_run_session(
    *,
    state_root: Path,
    verification: str,
    argv: list[str],
    working_directory: Path,
    environment: dict[str, str] | None = None,
    timeout_seconds: float | None = None,
    heartbeat_seconds: float = 30.0,
    expected_duration_seconds: float | None = None,
    product_identity: str | None = None,
    resource_locks: list[str] | None = None,
    run_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Start a re-attachable managed command without shell re-parsing.

    The short-lived launch specification is removed by the worker immediately
    after spawn. Environment values are inherited by the worker and hashed in
    the durable receipt; they are never serialized.
    """
    if not verification.strip():
        raise ValueError("RUN_SESSION_VERIFICATION_REQUIRED")
    if not argv or not all(isinstance(item, str) and item for item in argv):
        raise ValueError("RUN_SESSION_ARGV_REQUIRED")
    if heartbeat_seconds <= 0:
        raise ValueError("RUN_SESSION_HEARTBEAT_INVALID")
    if timeout_seconds is not None and timeout_seconds <= 0:
        raise ValueError("RUN_SESSION_TIMEOUT_INVALID")
    normalized_resource_locks: list[str] = []
    for raw_lock in resource_locks or []:
        if (
            not isinstance(raw_lock, str)
            or not raw_lock.strip()
            or len(raw_lock.strip()) > 256
        ):
            raise ValueError("RUN_SESSION_RESOURCE_LOCK_INVALID")
        normalized_resource_locks.append(raw_lock.strip())
    normalized_resource_locks = sorted(set(normalized_resource_locks))

    state_root = state_root.expanduser().resolve()
    working_directory = working_directory.expanduser().resolve()
    if not working_directory.is_dir():
        raise ValueError(f"RUN_SESSION_WORKDIR_MISSING: {working_directory}")
    session_id = session_id or f"run-{uuid.uuid4().hex}"
    run_id = run_id or session_id
    session_root = _run_session_root(state_root, session_id)
    session_root.mkdir(parents=True, exist_ok=False)
    created_at = now_iso()
    stdout_path = session_root / "stdout.log"
    stderr_path = session_root / "stderr.log"
    worker_log_path = session_root / "worker.log"
    spec_path = session_root / "launch-spec.json"
    overrides = dict(environment or {})
    command_hash = _sha256_json(argv)
    environment_hash = _sha256_json(overrides)
    receipt: dict[str, Any] = {
        "schemaVersion": RUN_SESSION_SCHEMA_VERSION,
        "sessionId": session_id,
        "runId": run_id,
        "verification": verification,
        "commandHash": command_hash,
        "workingDirectory": str(working_directory),
        "environmentHash": environment_hash,
        "launcherPid": os.getpid(),
        "workerPid": None,
        "servicePid": None,
        "processIdentity": None,
        "createdAt": created_at,
        "lastHeartbeatAt": created_at,
        "startedAt": None,
        "endedAt": None,
        "exitCode": None,
        "status": "STARTING",
        "reasonCode": "WORKER_STARTING",
        "stage": "prepare",
        "stageStartedAt": created_at,
        "stageTimings": [],
        "stdoutPath": str(stdout_path),
        "stderrPath": str(stderr_path),
        "workerLogPath": str(worker_log_path),
        "resultDigest": None,
        "cleanupStatus": "PENDING",
        "testProcessStarted": False,
        "timeoutSeconds": timeout_seconds,
        "heartbeatSeconds": heartbeat_seconds,
        "expectedDurationSeconds": expected_duration_seconds,
        "productIdentity": product_identity,
        "resourceLocks": normalized_resource_locks,
        "resourceLockTokens": {},
        "resourceWaitMs": 0,
        "activeTimeMs": 0,
        "wallClockMs": 0,
        "diagnosticPath": None,
    }
    _write_run_receipt(state_root, receipt)
    lock_tokens, lock_conflict = _acquire_resource_locks(
        state_root,
        session_id,
        normalized_resource_locks,
    )
    if lock_conflict is not None:
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "RESOURCE_LOCK_BUSY",
                "endedAt": now_iso(),
                "cleanupStatus": "NO_CHILD",
                "resourceLockConflict": lock_conflict,
            }
        )
        _write_run_receipt(state_root, receipt)
        return receipt
    receipt["resourceLockTokens"] = lock_tokens
    atomic_write_json(
        _resource_lock_secrets_path(state_root, session_id),
        {"schemaVersion": 1, "tokens": lock_tokens},
    )
    try:
        _resource_lock_secrets_path(state_root, session_id).chmod(0o600)
    except OSError:
        pass
    _write_run_receipt(state_root, receipt)
    atomic_write_json(
        spec_path,
        {
            "schemaVersion": 1,
            "stateRoot": str(state_root),
            "sessionId": session_id,
            "argv": argv,
            "heartbeatSeconds": heartbeat_seconds,
        },
    )
    try:
        spec_path.chmod(0o600)
    except OSError:
        pass

    worker_env = {**os.environ, **overrides}
    worker_env["PYTHONUTF8"] = "1"
    worker_env["PYTHONIOENCODING"] = "utf-8"
    worker_env["HARNESS_RUN_SESSION_WORKER"] = "1"
    worker_argv = [
        _absolute_executable(sys.executable),
        str(Path(__file__).resolve()),
        "_worker",
        "--state-root",
        str(state_root),
        "--session-id",
        session_id,
    ]
    try:
        worker_log_path.touch()
        worker = _spawn_detached_worker(
            worker_argv,
            cwd=working_directory,
            env=worker_env,
        )
    except OSError as exc:
        spec_path.unlink(missing_ok=True)
        _resource_lock_secrets_path(state_root, session_id).unlink(missing_ok=True)
        locks_released = _release_resource_locks(
            state_root,
            session_id,
            lock_tokens,
        )
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "WORKER_LAUNCH_FAILED",
                "endedAt": now_iso(),
                "cleanupStatus": (
                    "NO_CHILD"
                    if locks_released
                    else "RESOURCE_LOCK_RELEASE_FAILED"
                ),
                "error": str(exc),
            }
        )
        _write_run_receipt(state_root, receipt)
        return receipt
    receipt["workerPid"] = worker.pid
    receipt["workerIdentity"] = _process_identity(worker.pid, sys.executable)
    # Best-effort early handoff. The worker repeats and verifies this transfer
    # before spawning the managed command. Do not rewrite the session receipt
    # here: the detached worker may already have advanced it to RUNNING.
    _refresh_resource_locks(
        state_root,
        session_id,
        lock_tokens,
        dict(receipt["workerIdentity"]),
    )
    threading.Thread(target=worker.wait, daemon=True).start()
    return receipt


def _terminate_managed_child(
    process: subprocess.Popen[bytes],
    job: Any,
    *,
    attestation: dict[str, Any] | None = None,
    ownership_proof: dict[str, Any] | None = None,
) -> bool:
    from harness_process import terminate_owned_tree

    if isinstance(attestation, dict) and isinstance(ownership_proof, dict):
        result = terminate_owned_tree(
            attestation,
            ownership_proof,
            {"graceSeconds": 3.0},
        )
        if not result.get("cleanupComplete"):
            return False
    elif job is not None and getattr(job, "handle", None) is not None:
        # Compatibility for callers still passing the old Windows job object;
        # this branch is only used for an already-owned handle, never a PID.
        job.terminate_and_wait()
    else:
        # PID-only cleanup is intentionally forbidden by the process provider.
        return False
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return False
    return process.poll() is not None


def _run_session_worker(state_root: Path, session_id: str) -> int:
    from harness_service import verify_process_identity

    session_root = _run_session_root(state_root, session_id)
    spec_path = session_root / "launch-spec.json"
    receipt = _load_run_receipt(state_root, session_id)
    receipt["resourceLockTokens"] = _load_resource_lock_tokens(
        state_root,
        session_id,
        receipt,
    )
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        _release_resource_locks(
            state_root,
            session_id,
            dict(receipt.get("resourceLockTokens") or {}),
        )
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "LAUNCH_SPEC_INVALID",
                "endedAt": now_iso(),
                "cleanupStatus": "NO_CHILD",
                "error": str(exc),
            }
        )
        _write_run_receipt(state_root, receipt)
        return 1
    argv = [str(item) for item in spec.get("argv", [])]
    heartbeat_seconds = max(float(spec.get("heartbeatSeconds") or 30.0), 0.01)
    spec_path.unlink(missing_ok=True)
    started_monotonic = time.monotonic()
    _stage_transition(receipt, "spawn")
    receipt.update(
        {
            "workerPid": os.getpid(),
            "workerIdentity": _process_identity(os.getpid(), sys.executable),
            "lastHeartbeatAt": now_iso(),
        }
    )
    if not _refresh_resource_locks(
        state_root,
        session_id,
        dict(receipt.get("resourceLockTokens") or {}),
        dict(receipt["workerIdentity"]),
    ):
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "RESOURCE_LOCK_OWNERSHIP_LOST",
                "endedAt": now_iso(),
                "cleanupStatus": "NO_CHILD",
            }
        )
        _write_run_receipt(state_root, receipt)
        return 1
    _write_run_receipt(state_root, receipt)

    stdout_path = Path(str(receipt["stdoutPath"]))
    stderr_path = Path(str(receipt["stderrPath"]))
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    job = None
    spawned = None
    ownership_proof: dict[str, Any] | None = None
    identity: dict[str, Any] | None = None
    process: subprocess.Popen[bytes] | None = None
    try:
        with stdout_path.open("wb", buffering=0) as stdout, stderr_path.open(
            "wb", buffering=0
        ) as stderr:
            try:
                from harness_process import spawn_structured_argv

                spawned = spawn_structured_argv(
                    argv,
                    cwd=Path(str(receipt["workingDirectory"])),
                    environment={
                        "PYTHONUTF8": "1",
                        "PYTHONIOENCODING": "utf-8",
                    },
                    owner_token=f"run:{session_id}",
                    stdout=stdout,
                    stderr=stderr,
                )
                process = spawned.process
                ownership_proof = spawned.ownershipProof
                _capture_provider_members(spawned)
            except (OSError, ValueError, RuntimeError) as exc:
                receipt.update(
                    {
                        "status": "INCOMPLETE",
                        "reasonCode": "LAUNCHER_FAILED",
                        "endedAt": now_iso(),
                        "exitCode": None,
                        "testProcessStarted": False,
                        "cleanupStatus": "NO_CHILD",
                        "error": str(exc),
                    }
                )
                return 1
            assert spawned is not None and process is not None
            identity = spawned.attestation
            receipt["processOwnershipProof"] = ownership_proof
            _stage_transition(receipt, "execute")
            receipt.update(
                {
                    "servicePid": process.pid,
                    "processIdentity": identity,
                    "startedAt": identity.get("createdAt"),
                    "status": "RUNNING",
                    "reasonCode": "CHILD_RUNNING",
                    "testProcessStarted": True,
                    "processTreeIsolated": ownership_proof is not None,
                }
            )
            _write_run_receipt(state_root, receipt)

            timeout_seconds = receipt.get("timeoutSeconds")
            next_heartbeat = time.monotonic()
            termination_reason: str | None = None
            while process.poll() is None:
                now = time.monotonic()
                if timeout_seconds is not None and (
                    now - started_monotonic >= float(timeout_seconds)
                ):
                    termination_reason = "TIMEOUT"
                cancel_path = session_root / "cancel-request.json"
                if cancel_path.is_file():
                    termination_reason = "CANCEL_REQUESTED"
                if termination_reason is not None:
                    diagnostic_path = session_root / "diagnostic.json"
                    from harness_process import (
                        observe_process_identity,
                        verify_process_identity as verify_attestation,
                    )

                    verified = verify_attestation(
                        identity,
                        observe_process_identity(process.pid),
                    ).get("ok") is True
                    job_owned = ownership_proof is not None
                    if spawned is not None:
                        _capture_provider_members(spawned)
                    diagnostic = {
                        "schemaVersion": 1,
                        "sessionId": session_id,
                        "reasonCode": termination_reason,
                        "observedAt": now_iso(),
                        "processIdentityVerified": verified,
                        "terminationAuthority": (
                            "JOB_OBJECT_OWNED"
                            if job_owned
                            else (
                                "PROCESS_IDENTITY_VERIFIED"
                                if verified
                                else "NONE"
                            )
                        ),
                        "pid": process.pid,
                        "stdoutBytes": (
                            stdout_path.stat().st_size if stdout_path.exists() else 0
                        ),
                        "stderrBytes": (
                            stderr_path.stat().st_size if stderr_path.exists() else 0
                        ),
                    }
                    atomic_write_json(diagnostic_path, diagnostic)
                    receipt["diagnosticPath"] = str(diagnostic_path)
                    if job_owned and verified:
                        terminated = _terminate_managed_child(
                            process,
                            job,
                            attestation=identity,
                            ownership_proof=ownership_proof,
                        )
                        job = None
                        if not terminated:
                            receipt.update(
                                {
                                    "status": "INCOMPLETE",
                                    "reasonCode": "PROCESS_TERMINATION_UNCONFIRMED",
                                    "cleanupStatus": "PROCESS_TERMINATION_UNCONFIRMED",
                                }
                            )
                    else:
                        receipt.update(
                            {
                                "status": "INCOMPLETE",
                                "reasonCode": "PROCESS_IDENTITY_UNVERIFIED",
                                "cleanupStatus": "UNKNOWN_PROCESS_UNTOUCHED",
                            }
                        )
                    break
                if now >= next_heartbeat:
                    receipt["lastHeartbeatAt"] = now_iso()
                    receipt["activeTimeMs"] = int(
                        (now - started_monotonic) * 1000
                    )
                    receipt["wallClockMs"] = receipt["activeTimeMs"]
                    if not _refresh_resource_locks(
                        state_root,
                        session_id,
                        dict(receipt.get("resourceLockTokens") or {}),
                        dict(receipt["workerIdentity"]),
                    ):
                        receipt.update(
                            {
                                "status": "INCOMPLETE",
                                "reasonCode": "RESOURCE_LOCK_OWNERSHIP_LOST",
                                "cleanupStatus": "PROCESS_TREE_TERMINATION_REQUIRED",
                            }
                        )
                        if spawned is not None:
                            _capture_provider_members(spawned)
                        _terminate_managed_child(
                            process,
                            job,
                            attestation=identity,
                            ownership_proof=ownership_proof,
                        )
                        job = None
                        break
                    _write_run_receipt(state_root, receipt)
                    next_heartbeat = now + heartbeat_seconds
                time.sleep(min(heartbeat_seconds, 0.05))

            exit_code = process.poll()
            _stage_transition(receipt, "summarize")
            if termination_reason is not None and receipt["reasonCode"] not in {
                "PROCESS_IDENTITY_UNVERIFIED",
                "PROCESS_TERMINATION_UNCONFIRMED",
                "RESOURCE_LOCK_OWNERSHIP_LOST",
            }:
                receipt.update(
                    {
                        "status": "CANCELLED",
                        "reasonCode": termination_reason,
                        "exitCode": exit_code,
                        "cleanupStatus": "PROCESS_TREE_TERMINATED",
                    }
                )
            elif receipt["reasonCode"] not in {
                "PROCESS_IDENTITY_UNVERIFIED",
                "PROCESS_TERMINATION_UNCONFIRMED",
                "RESOURCE_LOCK_OWNERSHIP_LOST",
            }:
                receipt.update(
                    {
                        "status": "OK" if exit_code == 0 else "FAIL",
                        "reasonCode": (
                            "CHILD_EXIT_ZERO"
                            if exit_code == 0
                            else "CHILD_EXIT_NONZERO"
                        ),
                        "exitCode": exit_code,
                        "cleanupStatus": "PROCESS_EXITED",
                    }
                )
    except BaseException as exc:
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "WORKER_FAILED",
                "exitCode": None if process is None else process.poll(),
                "cleanupStatus": "WORKER_EXCEPTION",
                "error": str(exc),
            }
        )
    finally:
        if process is not None and process.poll() is None and ownership_proof is not None:
            if spawned is not None:
                _capture_provider_members(spawned)
            tree_drained = _terminate_managed_child(
                process,
                job,
                attestation=identity if isinstance(identity, dict) else None,
                ownership_proof=ownership_proof,
            )
            if not tree_drained:
                receipt.update(
                    {
                        "status": "INCOMPLETE",
                        "reasonCode": "PROCESS_TREE_TERMINATION_UNCONFIRMED",
                        "cleanupStatus": "PROCESS_TREE_TERMINATION_UNCONFIRMED",
                    }
                )
            elif receipt.get("cleanupStatus") == "PROCESS_EXITED":
                receipt["cleanupStatus"] = "PROCESS_TREE_TERMINATED"
        ended = time.monotonic()
        _stage_transition(receipt, "record")
        receipt["endedAt"] = now_iso()
        receipt["lastHeartbeatAt"] = receipt["endedAt"]
        receipt["activeTimeMs"] = int((ended - started_monotonic) * 1000)
        receipt["wallClockMs"] = receipt["activeTimeMs"] + int(
            receipt.get("resourceWaitMs") or 0
        )
        digest = hashlib.sha256()
        for path in (stdout_path, stderr_path):
            if path.is_file():
                digest.update(path.read_bytes())
        receipt["resultDigest"] = "sha256:" + digest.hexdigest()
        locks_released = _release_resource_locks(
            state_root,
            session_id,
            dict(receipt.get("resourceLockTokens") or {}),
        )
        try:
            _resource_lock_secrets_path(state_root, session_id).unlink(missing_ok=True)
        except OSError:
            locks_released = False
        if not locks_released:
            receipt.update(
                {
                    "status": "INCOMPLETE",
                    "reasonCode": "RESOURCE_LOCK_RELEASE_FAILED",
                    "cleanupStatus": "RESOURCE_LOCK_RELEASE_FAILED",
                }
            )
        _close_current_stage(receipt)
        _write_run_receipt(state_root, receipt)
    return 0 if receipt.get("status") == "OK" else 1


def _run_session_worker_with_log(state_root: Path, session_id: str) -> int:
    worker_log_path = _run_session_root(state_root, session_id) / "worker.log"
    try:
        worker_log = worker_log_path.open(
            "a",
            encoding="utf-8",
            errors="replace",
            buffering=1,
        )
    except OSError:
        return _run_session_worker(state_root, session_id)
    with worker_log:
        with (
            contextlib.redirect_stdout(worker_log),
            contextlib.redirect_stderr(worker_log),
        ):
            return _run_session_worker(state_root, session_id)


def _run_session_status_raw(state_root: Path, session_id: str) -> dict[str, Any]:
    from harness_service import is_pid_alive

    receipt = _load_run_receipt(state_root, session_id)
    worker_pid = receipt.get("workerPid")
    worker_identity = receipt.get("workerIdentity")
    if receipt.get("status") in RUN_TERMINAL_STATUSES:
        if (
            isinstance(worker_pid, int)
            and worker_pid > 0
            and is_pid_alive(worker_pid)
            and _receipt_identity_state(receipt) is True
        ):
            finalizing = dict(receipt)
            finalizing.update(
                {
                    "status": "FINALIZING",
                    "reasonCode": "WORKER_FINALIZING",
                }
            )
            return finalizing
        return receipt
    heartbeat_text = str(receipt.get("lastHeartbeatAt") or "")
    try:
        heartbeat_at = dt.datetime.fromisoformat(
            heartbeat_text.replace("Z", "+00:00")
        )
        if heartbeat_at.tzinfo is None:
            heartbeat_at = heartbeat_at.astimezone()
        heartbeat_age = (
            dt.datetime.now().astimezone() - heartbeat_at
        ).total_seconds()
    except ValueError:
        heartbeat_age = float("inf")
    grace = max(float(receipt.get("heartbeatSeconds") or 30.0) * 4, 2.0)
    startup_grace = max(grace, 10.0)
    # The detached worker owns the durable identity record.  The launcher can
    # return before the worker has published it, so STARTING is intentionally
    # treated as a bounded handshake window rather than an identity failure.
    if (
        receipt.get("status") == "STARTING"
        and receipt.get("workerIdentity") is None
        and heartbeat_age < startup_grace
    ):
        return receipt
    identity_state = _receipt_identity_state(receipt)
    worker_gone = (
        isinstance(worker_pid, int)
        and worker_pid > 0
        and not is_pid_alive(worker_pid)
    )
    if worker_gone or identity_state is False or heartbeat_age >= grace:
        latest = _load_run_receipt(state_root, session_id)
        if latest.get("status") in RUN_TERMINAL_STATUSES:
            return latest
        if heartbeat_age < grace and worker_gone and identity_state is not False:
            return latest
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": (
                    "WORKER_IDENTITY_MISMATCH"
                    if identity_state is False and not worker_gone
                    else "HEARTBEAT_LOST"
                ),
                "endedAt": now_iso(),
                "cleanupStatus": "WORKER_EXITED_WITHOUT_FINAL_RECEIPT",
            }
        )
        _write_run_receipt(state_root, receipt)
    return receipt


# 终态判定此前只活在脚本内部的 RUN_TERMINAL_STATUSES 里，从不出现在返回体中。
# 调用方于是只能按状态名猜——而 "INCOMPLETE" 读起来最像"还没结束"，实际是终态。
# 2026-08-18 的一次 fixback 执行里，一个启动即失败（LAUNCHER_FAILED）的会话
# 被连等 20s、60s，纯属这个缺口造成的浪费。
_TERMINAL_HINTS = {
    "LAUNCHER_FAILED": (
        "被测进程未能启动（testProcessStarted=false），不是超时；"
        "先核对 argv 的可执行文件在该工作目录下能否直接运行，再重跑 run-start。"
    ),
    "HEARTBEAT_LOST": "worker 心跳丢失，会话已判定结束；日志可能不完整。",
    "WORKER_IDENTITY_MISMATCH": "worker 身份校验不通过，会话已终止且未采信其结果。",
    "WORKER_EXITED_WITHOUT_FINAL_RECEIPT": "worker 未写最终回执即退出。",
}


def _annotate_run_status(receipt: dict[str, Any]) -> dict[str, Any]:
    """给回执补上可判定的终态标记与可行动线索。

    FINALIZING 刻意判为非终态：结果虽已确定，但 worker 尚未退出，
    调用方此时取读数会与清理竞争。
    """
    status = receipt.get("status")
    terminal = status in RUN_TERMINAL_STATUSES and status != "FINALIZING"
    annotated = dict(receipt)
    annotated["terminal"] = bool(terminal)
    hint = _TERMINAL_HINTS.get(str(receipt.get("reasonCode") or ""))
    if terminal and hint is not None:
        annotated["terminalHint"] = hint
    return annotated


def run_session_status(state_root: Path, session_id: str) -> dict[str, Any]:
    return _annotate_run_status(_run_session_status_raw(state_root, session_id))


def await_run_session(
    state_root: Path,
    session_id: str,
    *,
    timeout_seconds: float = 600.0,
    poll_seconds: float = 2.0,
) -> dict[str, Any]:
    """阻塞到会话进入终态，或超时后带 waitTimedOut 标记返回。

    没有这个入口时，调用方只能 `sleep <猜一个时长>` 再查一次；上述执行日志里
    连猜了 5s / 20s / 60s / 100s 四轮。等待逻辑属于会话语义，应由这里承担。
    """
    deadline = time.monotonic() + max(float(timeout_seconds), 0.0)
    while True:
        current = run_session_status(state_root, session_id)
        if current.get("terminal") is True:
            current["waitTimedOut"] = False
            return current
        if time.monotonic() >= deadline:
            current["waitTimedOut"] = True
            return current
        time.sleep(max(float(poll_seconds), 0.01))


def read_run_session_log(
    state_root: Path,
    session_id: str,
    *,
    stream: str = "stdout",
    cursor: int = 0,
    max_bytes: int = 64 * 1024,
) -> dict[str, Any]:
    if stream not in {"stdout", "stderr"}:
        raise ValueError(f"RUN_SESSION_STREAM_INVALID: {stream}")
    if cursor < 0 or max_bytes <= 0:
        raise ValueError("RUN_SESSION_CURSOR_INVALID")
    receipt = _load_run_receipt(state_root, session_id)
    path = Path(str(receipt[f"{stream}Path"]))
    raw = b""
    decode_status = "OK"
    size = path.stat().st_size if path.is_file() else 0
    if path.is_file() and cursor < size:
        with path.open("rb") as handle:
            handle.seek(cursor)
            raw = handle.read(max_bytes)
        while raw:
            try:
                text = raw.decode("utf-8")
                break
            except UnicodeDecodeError as exc:
                if exc.end != len(raw):
                    # An invalid sequence in the middle is durable evidence,
                    # so consume it and expose replacement text instead of
                    # silently dropping bytes from the cursor stream.
                    text = raw.decode("utf-8", errors="replace")
                    decode_status = "LOG_DECODE_DEGRADED"
                    break
                if (
                    receipt.get("status") in RUN_TERMINAL_STATUSES
                    and cursor + len(raw) >= size
                ):
                    # Once the producer is terminal, an incomplete trailing
                    # sequence cannot be completed by a later write. Preserve
                    # and consume it with an explicit degraded status.
                    text = raw.decode("utf-8", errors="replace")
                    decode_status = "LOG_DECODE_DEGRADED"
                    break
                # A live writer may have split a multibyte character across
                # this read. Keep the incomplete suffix for the next cursor
                # request so callers never see duplicate replacement glyphs.
                raw = raw[: exc.start]
        else:
            text = ""
    else:
        text = ""
    next_cursor = cursor + len(raw)
    terminal = receipt.get("status") in RUN_TERMINAL_STATUSES
    return {
        "ok": True,
        "sessionId": session_id,
        "stream": stream,
        "cursor": cursor,
        "nextCursor": next_cursor,
        "text": text,
        "eof": terminal and next_cursor >= size,
        "status": receipt.get("status"),
        "rawDigest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "decodeStatus": decode_status,
    }


def cancel_run_session(
    state_root: Path,
    session_id: str,
    *,
    reason: str = "CANCEL_REQUESTED",
) -> dict[str, Any]:
    receipt = _load_run_receipt(state_root, session_id)
    if receipt.get("status") in RUN_TERMINAL_STATUSES:
        return receipt
    if _receipt_identity_state(receipt) is not True:
        return {
            **receipt,
            "ok": False,
            "code": "WORKER_IDENTITY_UNVERIFIED",
            "unknownProcessUntouched": True,
        }
    atomic_write_json(
        _run_session_root(state_root, session_id) / "cancel-request.json",
        {"reasonCode": reason, "requestedAt": now_iso()},
    )
    return {**receipt, "ok": True, "action": "cancel-requested"}


def adapter_worktree(agent: str, change_id: str) -> dict[str, str]:
    if agent not in _ADAPTERS:
        raise ValueError(f"ADAPTER_UNKNOWN: {agent}")
    if not _CHANGE_ID.fullmatch(change_id) or change_id in {".", ".."}:
        raise ValueError(f"ADAPTER_CHANGE_ID_INVALID: {change_id}")
    root, prefix = _ADAPTERS[agent]
    return {
        "agent": agent,
        "worktreeRoot": root,
        "path": f"{root}/{change_id}",
        "branchPrefix": prefix,
        "branch": f"{prefix}{change_id}",
    }


def _absolute_executable(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve())


def _run_version(executable: str, *args: str) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [executable, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "error": str(exc)}
    version = (proc.stdout or proc.stderr).strip().splitlines()
    return {
        "available": proc.returncode == 0,
        "version": version[0] if version else "",
        "exitCode": proc.returncode,
    }


def probe_powershell(
    executable: Path,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    """Probe Windows PowerShell/Pwsh without relying on PowerShell 6 Test-Json."""
    script = (
        "$value = [ordered]@{"
        "edition = [string]$PSVersionTable.PSEdition;"
        "version = [string]$PSVersionTable.PSVersion.ToString()"
        "}; $value | ConvertTo-Json -Compress"
    )
    argv = [
        _absolute_executable(executable),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]
    try:
        proc = runner(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
        if proc.returncode != 0:
            return {
                "available": False,
                "executable": argv[0],
                "argvPrefix": [argv[0], "-NoLogo", "-NoProfile", "-NonInteractive"],
                "error": proc.stderr.strip(),
                "jsonCapability": "convert-to-json",
            }
        raw = json.loads(proc.stdout.strip())
        return {
            "available": True,
            "executable": argv[0],
            "argvPrefix": [argv[0], "-NoLogo", "-NoProfile", "-NonInteractive"],
            "edition": str(raw.get("edition") or "Desktop"),
            "version": str(raw.get("version") or ""),
            "jsonCapability": "convert-to-json",
        }
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        return {
            "available": False,
            "executable": argv[0],
            "argvPrefix": [argv[0], "-NoLogo", "-NoProfile", "-NonInteractive"],
            "error": str(exc),
            "jsonCapability": "convert-to-json",
        }


def _optional_runtime(name: str, version_arg: str = "--version") -> dict[str, Any]:
    found = shutil.which(name)
    if not found:
        return {"available": False, "executable": None, "argvPrefix": []}
    executable = _absolute_executable(found)
    return {
        "executable": executable,
        "argvPrefix": [executable],
        **_run_version(executable, version_arg),
    }


def doctor(project: Path, change_dir: Path, *, agent: str) -> dict[str, Any]:
    project = project.expanduser().resolve()
    change_dir = change_dir.expanduser().resolve()
    python_executable = _absolute_executable(sys.executable)
    python_version = _run_version(python_executable, "--version")

    powershell_path = shutil.which("pwsh") or shutil.which("powershell")
    powershell = (
        probe_powershell(Path(powershell_path))
        if powershell_path
        else {
            "available": False,
            "executable": None,
            "argvPrefix": [],
            "edition": None,
            "version": None,
            "jsonCapability": "python-json",
        }
    )
    sample = {"path": "E:/示例/计划", "ok": True}
    json_round_trip = json.loads(json.dumps(sample, ensure_ascii=False)) == sample
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "projectRoot": str(project),
        "changeDir": str(change_dir),
        "adapter": adapter_worktree(agent, change_dir.name),
        "runtimes": {
            "python": {
                "available": python_version.get("available", True),
                "executable": python_executable,
                "argvPrefix": [python_executable],
                "version": python_version.get("version") or sys.version.split()[0],
                "stdioEncoding": "utf-8",
                "filesystemEncoding": sys.getfilesystemencoding(),
            },
            "node": _optional_runtime("node"),
            "powershell": powershell,
        },
        "capabilities": {
            "jsonRoundTrip": json_round_trip,
            "argvArrays": True,
            "utf8NoBom": True,
        },
    }
    atomic_write_json(change_dir / "meta" / "runtime.json", payload)
    return {"ok": True, "action": "doctor", **payload}


def cmd_quarantine_evidence(args: argparse.Namespace) -> dict[str, Any]:
    """隔离命令：把明文敏感证据原子移出可发布树，逐条返回结果。

    单条失败不吞掉其余条目——归档阻断项常常一次报多个文件，逐条报告才能一轮修完。
    """
    project = Path(args.project).expanduser().resolve()
    change_root = Path(args.change_dir).expanduser().resolve()
    private_root = Path(args.private_root) if args.private_root else None
    entries: list[dict[str, Any]] = []
    for raw in args.file:
        candidate = Path(raw)
        source = candidate if candidate.is_absolute() else change_root / candidate
        outcome = quarantine_sensitive_evidence(
            source,
            change_root=change_root,
            reason=args.reason,
            private_root=private_root,
            project_root=project,
        )
        entries.append({"file": raw, **outcome})
    failed = [item for item in entries if not item.get("ok")]
    return {
        "ok": not failed,
        "action": "quarantine-evidence",
        "code": "SENSITIVE_EVIDENCE_QUARANTINED" if not failed else "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
        "quarantined": len(entries) - len(failed),
        "failed": len(failed),
        "entries": entries,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_runtime.py")
    sub = parser.add_subparsers(dest="command", required=True)
    p_doctor = sub.add_parser("doctor")
    p_doctor.add_argument("--project", required=True)
    p_doctor.add_argument("--change-dir", required=True)
    p_doctor.add_argument("--agent", choices=sorted(_ADAPTERS), required=True)
    p_doctor.add_argument("--json", action="store_true")
    # 归档的 SENSITIVE_EVIDENCE_UNQUARANTINED 是硬阻断，此前却没有任何命令行入口
    # ——调用方只能写 python -c + sys.path hack 去调内部函数。
    p_quarantine = sub.add_parser(
        "quarantine-evidence",
        help="move plaintext sensitive evidence outside the publishable tree",
    )
    p_quarantine.add_argument("--project", required=True)
    p_quarantine.add_argument("--change-dir", required=True)
    p_quarantine.add_argument(
        "--file", required=True, action="append",
        help="path to quarantine, relative to --change-dir or absolute; repeatable",
    )
    p_quarantine.add_argument("--reason", default="sensitive evidence")
    p_quarantine.add_argument(
        "--private-root", default=None,
        help="override the private root; must be outside the project root and on its drive",
    )
    p_quarantine.add_argument("--json", action="store_true")
    p_sweep = sub.add_parser(
        "sweep-scratch",
        help="删除 runtime/ 顶层的过程草稿（diff、临时输入、命令输出）",
    )
    p_sweep.add_argument("--change-dir", required=True)
    p_sweep.add_argument(
        "--dry-run", action="store_true", help="只列出会删什么，不真删"
    )
    p_sweep.add_argument("--json", action="store_true")
    p_adapter = sub.add_parser("adapter")
    p_adapter.add_argument("--agent", choices=sorted(_ADAPTERS), required=True)
    p_adapter.add_argument("--change", required=True)
    p_adapter.add_argument("--json", action="store_true")
    p_start = sub.add_parser("run-start", help="start a managed background run")
    p_start.add_argument("--state-root", required=True)
    p_start.add_argument("--verification", required=True)
    p_start.add_argument("--working-directory", required=True)
    p_start.add_argument("--timeout-seconds", type=float)
    p_start.add_argument("--heartbeat-seconds", type=float, default=30.0)
    p_start.add_argument("--expected-duration-seconds", type=float)
    p_start.add_argument("--product-identity")
    p_start.add_argument("--resource-lock", action="append", default=[])
    p_start.add_argument("--json", action="store_true")
    p_start.add_argument("argv", nargs=argparse.REMAINDER)
    p_status = sub.add_parser("run-status", help="read a managed run receipt")
    p_status.add_argument("--state-root", required=True)
    p_status.add_argument("--session-id", required=True)
    p_status.add_argument(
        "--wait",
        action="store_true",
        help="阻塞到会话进入终态再返回，替代调用方自己 sleep 猜时长",
    )
    p_status.add_argument("--wait-timeout-seconds", type=float, default=600.0)
    p_status.add_argument("--poll-seconds", type=float, default=2.0)
    p_status.add_argument("--json", action="store_true")
    p_log = sub.add_parser("run-log", help="read an incremental log page")
    p_log.add_argument("--state-root", required=True)
    p_log.add_argument("--session-id", required=True)
    p_log.add_argument("--stream", choices=("stdout", "stderr"), default="stdout")
    p_log.add_argument("--cursor", type=int, default=0)
    p_log.add_argument("--max-bytes", type=int, default=64 * 1024)
    p_log.add_argument("--json", action="store_true")
    p_cancel = sub.add_parser("run-cancel", help="request identity-safe cancellation")
    p_cancel.add_argument("--state-root", required=True)
    p_cancel.add_argument("--session-id", required=True)
    p_cancel.add_argument("--json", action="store_true")
    p_worker = sub.add_parser("_worker", help=argparse.SUPPRESS)
    p_worker.add_argument("--state-root", required=True)
    p_worker.add_argument("--session-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "doctor":
            result = doctor(Path(args.project), Path(args.change_dir), agent=args.agent)
        elif args.command == "quarantine-evidence":
            result = cmd_quarantine_evidence(args)
        elif args.command == "sweep-scratch":
            result = sweep_scratch(
                Path(args.change_dir), dry_run=bool(args.dry_run)
            )
        elif args.command == "adapter":
            result = {"ok": True, "action": "adapter", **adapter_worktree(args.agent, args.change)}
        elif args.command == "_worker":
            return _run_session_worker_with_log(
                Path(args.state_root),
                args.session_id,
            )
        elif args.command == "run-start":
            command_argv = list(args.argv)
            if command_argv and command_argv[0] == "--":
                command_argv = command_argv[1:]
            result = start_run_session(
                state_root=Path(args.state_root),
                verification=args.verification,
                argv=command_argv,
                working_directory=Path(args.working_directory),
                timeout_seconds=args.timeout_seconds,
                heartbeat_seconds=args.heartbeat_seconds,
                expected_duration_seconds=args.expected_duration_seconds,
                product_identity=args.product_identity,
                resource_locks=list(args.resource_lock),
            )
        elif args.command == "run-status":
            if getattr(args, "wait", False):
                result = await_run_session(
                    Path(args.state_root),
                    args.session_id,
                    timeout_seconds=args.wait_timeout_seconds,
                    poll_seconds=args.poll_seconds,
                )
            else:
                result = run_session_status(Path(args.state_root), args.session_id)
        elif args.command == "run-log":
            result = read_run_session_log(
                Path(args.state_root),
                args.session_id,
                stream=args.stream,
                cursor=args.cursor,
                max_bytes=args.max_bytes,
            )
        else:
            result = cancel_run_session(Path(args.state_root), args.session_id)
    except (OSError, ValueError) as exc:
        code = str(exc).split(":", 1)[0]
        result = {"ok": False, "code": code, "error": str(exc)}
        stream = sys.stderr
        stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 1
    if getattr(args, "json", False):
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(str(result.get("action")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
