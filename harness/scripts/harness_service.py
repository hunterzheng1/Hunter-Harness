#!/usr/bin/env python3
"""Harness service-session manager (D7).

Subcommands:
  ensure  — reuse / restart / start / needs-user-decision
  status  — session + liveness + fingerprint match
  stop    — stop AI-managed service and clear session

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.

Safety: never kill a process that cannot be verified as AI-started.
Missing or corrupt session → treat as user process → needs-user-decision.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from harness_ledger import compute_inputs_hash  # noqa: E402
import harness_process as _process_provider  # noqa: E402
from harness_profile import (  # noqa: E402
    normalize_service_start,
    resolve_service_argv,
)


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


PROFILE_REL = Path(".harness") / "config" / "build-profile.json"
SESSION_REL = Path("runtime") / "service-session.json"
LOG_REL = Path("logs") / "service-start.log"
MUTATION_LOCK_REL = Path("runtime") / "service-mutation.lock"
MUTATION_STATE_REL = Path("runtime") / "service-mutation.json"
HEARTBEAT_TTL_SECONDS = 30

FATAL_KEYWORDS = (
    "BindException",
    "Could not resolve placeholder",
    "BeanCreationException",
    "BUILD FAILURE",
)

# Process create-time vs session.startedAt tolerance (seconds).
IDENTITY_TOLERANCE_SEC = 5.0
STOP_CONFIRM_TIMEOUT_SEC = 5.0

# Windows process flags
_DETACHED_PROCESS = 0x00000008
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000
_STILL_ACTIVE = 259


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def emit_json(payload: dict[str, Any], *, as_json: bool) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if as_json:
        sys.stdout.write(text)
    else:
        action = payload.get("action") or payload.get("status")
        ok = payload.get("ok", True)
        sys.stdout.write(f"ok={ok} action={action}\n")


def emit_error(message: str, *, as_json: bool, code: int = 1, **extra: Any) -> int:
    payload: dict[str, Any] = {"ok": False, "error": message}
    payload.update(extra)
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message}\n")
    return code


def resolve_path(raw: str | Path) -> Path:
    return Path(raw).expanduser().resolve()


def parse_files_arg(raw: str | None) -> list[str]:
    if raw is None or not str(raw).strip():
        return []
    parts = [p.strip() for p in str(raw).split(",")]
    return [p for p in parts if p]


def sha256_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def session_path(change_dir: Path) -> Path:
    return change_dir / SESSION_REL


def log_path(change_dir: Path) -> Path:
    return change_dir / LOG_REL


def mutation_lock_path(change_dir: Path) -> Path:
    return change_dir / MUTATION_LOCK_REL


def mutation_state_path(change_dir: Path) -> Path:
    return change_dir / MUTATION_STATE_REL


def _allocate_service_generation(change_dir: Path) -> int:
    """Allocate a monotonic incarnation number under the per-change lock."""

    previous: list[int] = []
    try:
        current = load_session(change_dir)
    except SessionCorrupt:
        current = None
    if isinstance(current, dict):
        value = current.get("serviceGeneration")
        if value is not None:
            previous.append(_normalize_service_generation(value))
    state_path = mutation_state_path(change_dir)
    if state_path.is_file():
        try:
            state = read_json(state_path)
        except (OSError, ValueError, json.JSONDecodeError):
            state = None
        if isinstance(state, dict) and state.get("serviceGeneration") is not None:
            previous.append(_normalize_service_generation(state.get("serviceGeneration")))
    retired_root = change_dir / "runtime" / "retired-service-sessions"
    if retired_root.is_dir():
        for receipt_path in retired_root.glob("*.receipt.json"):
            try:
                receipt = read_json(receipt_path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(receipt, dict) and receipt.get("oldGeneration") is not None:
                previous.append(_normalize_service_generation(receipt.get("oldGeneration")))
    now_generation = max(1, int(time.time_ns() // 1_000_000))
    return max([now_generation, *(value + 1 for value in previous)])


class ServiceMutationLock:
    """Small CAS-style lock for ensure/stop/retire writers.

    The lock record is diagnostic only; ownership is the exclusive file
    descriptor plus a random token.  A dead owner may be reclaimed, while a
    live owner always produces a typed conflict and no state mutation.
    """

    def __init__(self, change_dir: Path, *, operation: str) -> None:
        self.change_dir = change_dir.resolve()
        self.operation = operation
        self.path = mutation_lock_path(self.change_dir)
        self.token = uuid.uuid4().hex
        self._owned = False

    def acquire(self) -> dict[str, Any] | None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "operation": self.operation,
            "operationId": self.token,
            "pid": os.getpid(),
            "startedAt": now_iso(),
        }
        encoded = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        for _attempt in range(2):
            try:
                fd = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
            except FileExistsError:
                try:
                    current = read_json(self.path)
                except (OSError, ValueError, json.JSONDecodeError):
                    current = None
                owner_pid = current.get("pid") if isinstance(current, dict) else None
                if (
                    isinstance(owner_pid, int)
                    and owner_pid > 0
                    and not _process_provider.is_pid_alive(owner_pid)
                ):
                    try:
                        self.path.unlink()
                    except FileNotFoundError:
                        pass
                    continue
                return {
                    "ok": False,
                    "code": "SERVICE_MUTATION_CONFLICT",
                    "path": str(self.path),
                    "owner": current,
                }
            else:
                try:
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(encoded)
                        handle.flush()
                        os.fsync(handle.fileno())
                except BaseException:
                    self.path.unlink(missing_ok=True)
                    raise
                self._owned = True
                return None
        return {
            "ok": False,
            "code": "SERVICE_MUTATION_CONFLICT",
            "path": str(self.path),
        }

    def release(self) -> None:
        if not self._owned:
            return
        try:
            current = read_json(self.path)
        except (OSError, ValueError, json.JSONDecodeError):
            current = None
        if isinstance(current, dict) and current.get("operationId") == self.token:
            self.path.unlink(missing_ok=True)
        self._owned = False


def profile_path(project: Path) -> Path:
    return project / PROFILE_REL


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # 原子写 temp+os.replace：崩溃后不留半写文件（与 runtime-helpers.mjs writeJsonUtf8NoBom 一致）。
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def load_build_profile(project: Path) -> dict[str, Any]:
    path = profile_path(project)
    if not path.is_file():
        raise FileNotFoundError(
            f"build-profile.json missing: {path}; run harness_preflight.py detect first"
        )
    data = read_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"build-profile.json must be an object: {path}")
    return data


def get_service_start(profile: dict[str, Any]) -> dict[str, Any]:
    svc = profile.get("serviceStart")
    if not isinstance(svc, dict):
        raise ValueError("build-profile.json missing serviceStart object")
    command = svc.get("command")
    argv_template = svc.get("argvTemplate")
    if not (
        isinstance(command, str)
        and command.strip()
    ) and not (
        isinstance(argv_template, list)
        and argv_template
        and all(isinstance(item, str) and "\0" not in item for item in argv_template)
    ):
        raise ValueError(
            "build-profile.json serviceStart.command/argvTemplate is empty; "
            "configure the service start argv explicitly (will not guess)"
        )
    return svc


# Worktree/change 路径标记：持久 profile 的 serviceStart 不得含这些具体路径。
# runtime resolve 把具体 overlay/profile 注入到 session，不写回持久 profile
# （spec §3.1 持久 profile 只保存模板；§3.4 修复输入端陈旧 profile）。
STALE_WORKTREE_MARKERS: tuple[str, ...] = (
    ".worktrees/",
    ".claude/worktrees/",
    ".cursor/worktrees/",
    ".codeium/worktrees/",
)


def _detect_stale_persistent_values(service_start: dict[str, Any]) -> list[str]:
    """检测 serviceStart 是否含具体旧 worktree/change 持久路径。

    持久 profile 只保存模板；command/overlayPath/profile 嵌入 worktree 路径
    说明是 v1 残留或被错误写回的已解析 overlay，必须拒绝（spec §3.4）。
    """
    stale: list[str] = []
    for field in ("command", "argvTemplate", "overlayPath", "profile"):
        val = service_start.get(field)
        if isinstance(val, list):
            values = [item for item in val if isinstance(item, str)]
        else:
            values = [val] if isinstance(val, str) else []
        if not values:
            continue
        for value in values:
            for marker in STALE_WORKTREE_MARKERS:
                if marker in value:
                    stale.append(f"{field} contains stale worktree path: {marker}")
                    break
    return stale


def resolve_service_start(
    profile: dict[str, Any],
    *,
    change_name: str | None = None,
    worktree_root: Path | None = None,
    overlay_path: str | None = None,
    leased_port: int | None = None,
    lease_owner: str | None = None,
) -> dict[str, Any]:
    """从模板 serviceStart + runtime context 生成 resolved serviceStart。

    spec §3.1：持久 profile 的 serviceStart 是模板（profile/overlayPath 留空）；
    runtime 注入具体 overlay/profile 到返回值，写入 session，**不写回持久 profile**。
    spec §3.4：含 worktree/change 陈旧持久值时拒绝（修复输入端陈旧 profile）。

    向后兼容：持久 profile.profile 非空（如 v1 残留 "local-dev"）→ 保留；
    overlay_path 未提供 → 保留持久 overlayPath（可能为空）。
    """
    service_start = get_service_start(profile)  # 校验结构化 argv/legacy command 非空

    stale = _detect_stale_persistent_values(service_start)
    if stale:
        raise ValueError(
            "serviceStart contains stale persistent worktree/change values; "
            "run harness_profile.py migrate to clear: " + "; ".join(stale)
        )

    resolved = dict(service_start)
    # runtime overlay 注入：显式 overlay_path 覆盖；否则保留持久模板值
    if overlay_path is not None:
        resolved["overlayPath"] = overlay_path
    # runtime profile 注入：持久 profile 留空时用 change_name；非空则保留
    if not str(resolved.get("profile") or "").strip():
        resolved["profile"] = change_name or "local-dev"
    if leased_port is not None:
        if not lease_owner:
            raise ValueError("lease owner is required when leased port is provided")
        resolved["leasedPort"] = leased_port
        resolved["leaseOwner"] = lease_owner
        resolved["port"] = leased_port
        for field in ("command", "healthUrl", "healthFile", "overlayPath"):
            value = resolved.get(field)
            if isinstance(value, str):
                resolved[field] = value.replace("{leasedPort}", str(leased_port))
    # Resolve legacy commands through the tested platform parser and resolve
    # placeholders element-by-element.  The consumer below only receives
    # ``argv`` and never invokes a shell.
    resolved["argv"] = resolve_service_argv(
        resolved,
        {"{leasedPort}": str(leased_port)} if leased_port is not None else {},
    )
    # worktree_root 预留给未来相对 overlay 路径解析（spec §3.6 state snapshot）；
    # 不写入返回值，避免污染 session。
    _ = worktree_root
    return resolved


def resolve_service_input_files(
    project: Path,
    service_start: dict[str, Any],
    cli_files: list[str],
) -> list[str]:
    """Union of CLI ``--files`` and ``serviceStart.inputFiles`` globs.

    Globs expand relative to project; only files inside project are kept
    (deduped, path-sorted). Empty result raises ValueError -- never produce a
    reusable empty fingerprint (§5.1/§5.2). Never globs outside project.
    """
    base = project.resolve()
    seen: set[str] = set()

    for raw in cli_files:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = base / p
        try:
            p = p.resolve()
        except OSError:
            continue
        if not p.is_file():
            continue
        try:
            p.relative_to(base)
        except ValueError:
            continue  # reject project-external path
        seen.add(p.as_posix())

    input_files = service_start.get("inputFiles")
    if isinstance(input_files, list):
        for pat in input_files:
            if not isinstance(pat, str) or not pat.strip():
                continue
            for match in base.glob(pat):
                if not match.is_file():
                    continue
                resolved = match.resolve()
                try:
                    resolved.relative_to(base)
                except ValueError:
                    continue  # reject project-external glob escape
                seen.add(resolved.as_posix())

    result = sorted(seen)
    if not result:
        raise ValueError(
            "service inputs are empty; configure serviceStart.inputFiles "
            "(or pass --files) so the service fingerprint covers real source"
        )
    return result


# ---------------------------------------------------------------------------
# Process liveness / identity (stdlib-first; ctypes best-effort on Windows)
# ---------------------------------------------------------------------------


def is_pid_alive(pid: int) -> bool:
    """Compatibility re-export; process facts come from the shared provider."""
    return _process_provider.is_pid_alive(pid)


def _windows_pid_alive(pid: int) -> bool:
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            handle = kernel32.OpenProcess(0x0400, False, pid)  # PROCESS_QUERY_INFORMATION
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return int(exit_code.value) == _STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return False


def get_process_create_time(pid: int) -> dt.datetime | None:
    """Best-effort process create time (timezone-aware). None if unavailable."""
    return _process_provider.get_process_create_time(pid)


def get_process_executable(pid: int) -> str | None:
    """Best-effort executable identity for PID-reuse protection."""
    return _process_provider.get_process_executable(pid)


def _windows_process_create_time(pid: int) -> dt.datetime | None:
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            handle = kernel32.OpenProcess(0x0400, False, pid)
        if not handle:
            return None
        try:
            creation = wintypes.FILETIME()
            exit_time = wintypes.FILETIME()
            kernel_time = wintypes.FILETIME()
            user_time = wintypes.FILETIME()
            ok = kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel_time),
                ctypes.byref(user_time),
            )
            if not ok:
                return None
            val = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
            # FILETIME: 100-ns since 1601-01-01 UTC
            unix_sec = (val - 116444736000000000) / 10_000_000
            return dt.datetime.fromtimestamp(unix_sec, tz=dt.timezone.utc)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None


def _posix_process_create_time(pid: int) -> dt.datetime | None:
    try:
        stat_path = Path(f"/proc/{pid}/stat")
        if not stat_path.is_file():
            # macOS / other: no reliable stdlib create-time
            return None
        text = stat_path.read_text(encoding="utf-8", errors="replace")
        # comm may contain spaces/parens — split after last ')'
        rparen = text.rfind(")")
        if rparen < 0:
            return None
        fields = text[rparen + 2 :].split()
        # field index 20 in remaining = starttime (clock ticks since boot)
        start_ticks = int(fields[19])
        ticks = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK"))
        if not ticks:
            ticks = 100
        boot = _linux_boot_time()
        if boot is None:
            return None
        return dt.datetime.fromtimestamp(boot + start_ticks / ticks, tz=dt.timezone.utc)
    except Exception:
        return None


def _linux_boot_time() -> float | None:
    try:
        for line in Path("/proc/stat").read_text(encoding="utf-8").splitlines():
            if line.startswith("btime "):
                return float(line.split()[1])
    except Exception:
        return None
    return None


def parse_iso(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        # Support "...Z" and space separator
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.astimezone()
        return parsed
    except ValueError:
        return None


def verify_process_identity(session: dict[str, Any]) -> bool | None:
    """True=same process, False=definitely different/dead, None=cannot verify.

    Requires pid alive AND create-time within tolerance of session.startedAt.
    If create-time unavailable → None (conservative → needs-user-decision).
    """
    pid = session.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    process_identity = session.get("processIdentity")
    process_identity = process_identity if isinstance(process_identity, dict) else {}
    process_attestation = session.get("processAttestation")
    process_attestation = (
        process_attestation if isinstance(process_attestation, dict) else {}
    )
    attested_identity = process_attestation or process_identity
    expected: dict[str, Any] = {
        "schemaVersion": 1,
        "pid": pid,
        "createdAt": attested_identity.get("createdAt")
        or process_identity.get("startedAt")
        or session.get("startedAt"),
        "executable": attested_identity.get("executable")
        or process_identity.get("executable"),
        "argvHash": attested_identity.get("argvHash")
        or process_identity.get("argvHash")
        or session.get("argvHash"),
        "workingDirectory": attested_identity.get("workingDirectory")
        or process_identity.get("workingDirectory")
        or session.get("workingDirectory"),
        "parentIdentity": attested_identity.get("parentIdentity")
        or process_identity.get("parentIdentity"),
        "ownerTokenHash": attested_identity.get("ownerTokenHash")
        or process_identity.get("ownerTokenHash")
        or session.get("ownerTokenHash"),
        "fieldProvenance": attested_identity.get("fieldProvenance")
        or process_identity.get("fieldProvenance")
        or {},
    }
    if expected["createdAt"] is None:
        return None
    observed = _process_provider.observe_process_identity(pid)
    # Keep the historical service re-export seam observable for callers and
    # tests that temporarily disable a platform capability.  In normal use
    # these wrappers delegate to the provider, so this does not create a
    # second identity implementation.
    compatibility_created = get_process_create_time(pid)
    if compatibility_created is None:
        observed["createdAt"] = None
        observed["fieldProvenance"]["createdAt"] = "UNAVAILABLE"
        observed["capabilities"]["canObserveCreateTime"] = False
    else:
        observed["createdAt"] = compatibility_created.astimezone(
            dt.timezone.utc
        ).isoformat(timespec="microseconds")
        observed["fieldProvenance"]["createdAt"] = "OBSERVED"
    compatibility_executable = get_process_executable(pid)
    if compatibility_executable is None:
        observed["executable"] = None
        observed["fieldProvenance"]["executable"] = "UNAVAILABLE"
        observed["capabilities"]["canObserveExecutable"] = False
    else:
        observed["executable"] = compatibility_executable
        observed["fieldProvenance"]["executable"] = "OBSERVED"
        observed["capabilities"]["canObserveExecutable"] = True
    decision = _process_provider.verify_process_identity(expected, observed)
    if decision.get("ok") is True:
        return True
    if decision.get("reasonCode") in {
        "PROCESS_IDENTITY_MISMATCH",
        "PROCESS_CREATE_TIME_MISMATCH",
        "PROCESS_EXECUTABLE_MISMATCH",
        "PROCESS_ARGV_MISMATCH",
        "PROCESS_CWD_MISMATCH",
        "PROCESS_PARENT_MISMATCH",
        "PROCESS_OWNER_MISMATCH",
    }:
        return False
    return None


def terminate_process_tree(
    pid: int,
    *,
    expected_attestation: dict[str, Any] | None = None,
    ownership_proof: dict[str, Any] | None = None,
    timeout_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compatibility facade requiring a complete attestation and proof.

    The old PID-only API is intentionally diagnostic-only.  Callers that
    cannot supply a platform ownership proof receive a fail-closed result and
    no signal is sent.
    """
    if not isinstance(expected_attestation, dict):
        expected_attestation = {"pid": pid}
    return _process_provider.terminate_owned_tree(
        expected_attestation,
        ownership_proof,
        timeout_policy,
    )


# ---------------------------------------------------------------------------
# Port / health probing
# ---------------------------------------------------------------------------


def extract_port(service_start: dict[str, Any]) -> int | None:
    for key in ("port", "listenPort"):
        val = service_start.get(key)
        if isinstance(val, int) and 0 < val < 65536:
            return val
        if isinstance(val, str) and val.strip().isdigit():
            p = int(val.strip())
            if 0 < p < 65536:
                return p

    health = service_start.get("healthUrl") or service_start.get("healthFile") or ""
    if not isinstance(health, str) or not health.strip():
        return None
    return port_from_health_spec(health.strip())


def port_from_health_spec(spec: str) -> int | None:
    lower = spec.lower()
    if lower.startswith("file:") or lower.startswith("path:"):
        return None
    # bare path (Windows drive or relative) — not a URL
    if re.match(r"^[A-Za-z]:[\\/]", spec) or (os.sep in spec and "://" not in spec):
        return None
    if lower.startswith("tcp://") or lower.startswith("socket://"):
        rest = spec.split("://", 1)[1]
        host_port = rest.split("/", 1)[0]
        if ":" in host_port:
            try:
                return int(host_port.rsplit(":", 1)[1])
            except ValueError:
                return None
        return None
    try:
        parsed = urlparse(spec if "://" in spec else f"http://{spec}")
        if parsed.port:
            return int(parsed.port)
    except ValueError:
        return None
    return None


def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is accepting connections on host:port."""
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def resolve_health_file(spec: str) -> Path | None:
    lower = spec.lower()
    if lower.startswith("file:"):
        raw = spec[5:]
        # file:///C:/path or file:C:/path or file:/path
        if raw.startswith("///"):
            raw = raw[3:]
        elif raw.startswith("//"):
            raw = raw[2:]
        return Path(raw)
    if lower.startswith("path:"):
        return Path(spec[5:])
    if re.match(r"^[A-Za-z]:[\\/]", spec) or (spec.startswith(".") and "://" not in spec):
        return Path(spec)
    return None


def probe_health(
    service_start: dict[str, Any],
    *,
    expected_instance_token: str | None = None,
) -> bool:
    """Return True if service appears healthy per serviceStart health config."""
    # Prefer explicit healthFile
    health_file = service_start.get("healthFile")
    if isinstance(health_file, str) and health_file.strip():
        path = Path(health_file.strip())
        if not path.is_file():
            return False
        if expected_instance_token:
            try:
                return expected_instance_token in path.read_text(
                    encoding="utf-8", errors="replace"
                )
            except OSError:
                return False
        return True

    spec = service_start.get("healthUrl")
    if not isinstance(spec, str) or not spec.strip():
        # No health probe configured → treat as healthy once process is up
        # (caller should still have started the process). For wait loop, require
        # at least that we have a running pid — handled by caller.
        return True

    spec = spec.strip()
    file_path = resolve_health_file(spec)
    if file_path is not None:
        if not file_path.is_file():
            return False
        if expected_instance_token:
            try:
                return expected_instance_token in file_path.read_text(
                    encoding="utf-8", errors="replace"
                )
            except OSError:
                return False
        return True

    lower = spec.lower()
    if lower.startswith("tcp://") or lower.startswith("socket://"):
        rest = spec.split("://", 1)[1]
        host_port = rest.split("/", 1)[0]
        if ":" not in host_port:
            return False
        host, port_s = host_port.rsplit(":", 1)
        try:
            port = int(port_s)
        except ValueError:
            return False
        return is_port_in_use(port, host or "127.0.0.1")

    # HTTP(S)
    url = spec if "://" in spec else f"http://{spec}"
    try:
        headers = (
            {"X-Harness-Instance-Token": expected_instance_token}
            if expected_instance_token
            else {}
        )
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            if not 200 <= int(getattr(resp, "status", 200)) < 300:
                return False
            if not expected_instance_token:
                return True
            response_token = resp.headers.get("X-Harness-Instance-Token")
            if response_token == expected_instance_token:
                return True
            body = resp.read().decode("utf-8", errors="replace")
            return expected_instance_token in body
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return False


def _listener_identity_is_owned(
    session: dict[str, Any],
    service_start: dict[str, Any],
) -> bool:
    """Require an owned process-tree proof before reusing tokenless listeners."""
    if extract_port(service_start) is None:
        return True
    attestation = session.get("processAttestation")
    proof = session.get("ownershipProof")
    if not isinstance(attestation, dict) or not isinstance(proof, dict):
        return False
    try:
        observed = _process_provider._observe_proof_members(proof)
        decision = _process_provider.validate_ownership_proof(
            attestation,
            proof,
            observed,
        )
        return decision.get("ok") is True
    except (OSError, TypeError, ValueError):
        return False


def log_has_fatal(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    # Check last ~200 lines for fatal keywords
    lines = text.splitlines()
    tail = "\n".join(lines[-200:])
    for kw in FATAL_KEYWORDS:
        if kw in tail:
            return kw
    return None


class ServiceStartError(Exception):
    def __init__(self, message: str, *, fatal_keyword: str | None = None) -> None:
        super().__init__(message)
        self.fatal_keyword = fatal_keyword


def wait_for_healthy(
    service_start: dict[str, Any],
    log_file: Path,
    *,
    pid: int | None = None,
    expected_instance_token: str | None = None,
) -> None:
    """Startup wait state machine: 0–30s /2s, 30–120s /5s; fatal keywords abort."""
    timeout_sec = service_start.get("startTimeoutSec", 120)
    try:
        timeout_sec = float(timeout_sec)
    except (TypeError, ValueError):
        timeout_sec = 120.0
    if timeout_sec <= 0:
        timeout_sec = 120.0

    start = time.monotonic()
    while True:
        elapsed = time.monotonic() - start
        fatal = log_has_fatal(log_file)
        if fatal:
            raise ServiceStartError(
                f"service start aborted: fatal keyword in log: {fatal}",
                fatal_keyword=fatal,
            )
        if pid is not None and not is_pid_alive(pid):
            raise ServiceStartError(f"service process exited early (pid={pid})")
        if probe_health(
            service_start,
            expected_instance_token=expected_instance_token,
        ):
            return
        if elapsed >= timeout_sec:
            raise ServiceStartError(
                f"service start timed out after {timeout_sec:.0f}s "
                f"(health probe not ready; see {log_file})"
            )
        # 0–30s every 2s; 30–120s every 5s
        if elapsed < 30.0:
            time.sleep(2.0)
        else:
            time.sleep(5.0)


# ---------------------------------------------------------------------------
# Session I/O
# ---------------------------------------------------------------------------


class SessionCorrupt(Exception):
    pass


class ServiceTransitionConflict(Exception):
    """Raised only when a caller explicitly requests an illegal service edge."""


_SERVICE_REASON_ALIASES = {
    "SERVICE_STARTING": "SERVICE_START_REQUESTED",
    "SERVICE_HEALTH_FAILED": "SERVICE_START_FAILED",
    "SERVICE_STOPPING": "SERVICE_STOP_REQUESTED",
    "SERVICE_STOP_CONFIRMED": "SERVICE_STOPPED",
    "STALE_IDENTITY_MISMATCH": "SERVICE_IDENTITY_STALE",
    "STALE_IDENTITY_RETIRED": "SERVICE_RETIRED",
    "PROCESS_TREE_EXIT_UNCONFIRMED": "SERVICE_STOP_FAILED",
    "OWNED_PORT_RELEASE_UNCONFIRMED": "SERVICE_CLEANUP_INCOMPLETE",
    "LISTENER_IDENTITY_UNVERIFIED": "LISTENER_IDENTITY_UNVERIFIABLE",
}

_SERVICE_TRANSITIONS: dict[str | None, set[str]] = {
    # ``READY``/``FAILED`` are retained for legacy sessions that predate the
    # explicit STARTING record; new writers always persist STARTING first.
    None: {"STARTING", "READY", "FAILED", "STALE_IDENTITY_MISMATCH"},
    "STARTING": {"READY", "FAILED", "STALE_IDENTITY_MISMATCH"},
    "READY": {"READY", "STOPPING", "STALE_IDENTITY_MISMATCH"},
    "STOPPING": {"STOPPED", "FAILED", "STALE_IDENTITY_MISMATCH"},
    "FAILED": {"RETIRED"},
    "STALE_IDENTITY_MISMATCH": {"RETIRED"},
    "STOPPED": {"RETIRED"},
    "RETIRED": set(),
}


def _canonical_service_reason(reason_code: str) -> str:
    return _SERVICE_REASON_ALIASES.get(reason_code, reason_code)


def _normalize_service_generation(value: Any) -> int:
    if isinstance(value, bool):
        return 1
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str):
        try:
            parsed = int(value)
            if parsed > 0:
                return parsed
        except ValueError:
            if value.strip():
                # Legacy writers used opaque ``generation-*`` strings.  Keep
                # their identity stable while moving the durable contract to
                # a positive integer; this is migration-only, not a new
                # generation allocator.
                return max(1, int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:15], 16))
    return 1


def load_session(change_dir: Path) -> dict[str, Any] | None:
    """Return session dict, None if missing, raise SessionCorrupt if damaged."""
    path = session_path(change_dir)
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise SessionCorrupt(f"cannot read session: {exc}") from exc
    if not text.strip():
        raise SessionCorrupt("session file is empty")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SessionCorrupt(f"session JSON corrupt: {exc}") from exc
    if not isinstance(data, dict):
        raise SessionCorrupt("session must be a JSON object")
    # Minimal required fields for a usable AI session
    pid = data.get("pid")
    if not isinstance(pid, int):
        raise SessionCorrupt("session.pid missing or not an int")
    if "startedBy" not in data:
        raise SessionCorrupt("session.startedBy missing")
    if "startedAt" not in data:
        raise SessionCorrupt("session.startedAt missing")
    if "identityCompleteness" not in data:
        data["identityCompleteness"] = (
            "COMPLETE"
            if isinstance(data.get("processAttestation"), dict)
            and isinstance(data.get("ownershipProof"), dict)
            else "PARTIAL"
        )
    if "serviceGeneration" in data:
        data["serviceGeneration"] = _normalize_service_generation(
            data.get("serviceGeneration")
        )
    # Legacy sessions may have persisted a raw health token.  Keep only its
    # digest in the durable session; the configured profile remains the sole
    # source from which a probe may obtain the token value.
    legacy_token = data.pop("instanceToken", None)
    if isinstance(legacy_token, str) and legacy_token:
        data.setdefault("instanceTokenHash", sha256_text(legacy_token))
    return data


def clear_session(change_dir: Path) -> None:
    path = session_path(change_dir)
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            pass


def write_session(change_dir: Path, session: dict[str, Any]) -> Path:
    path = session_path(change_dir)
    write_json(path, session)
    return path


def _service_operation_id(session: dict[str, Any] | None = None) -> str:
    value = session.get("operationId") if isinstance(session, dict) else None
    return str(value or uuid.uuid4().hex)


def _transition(
    session: dict[str, Any],
    status: str,
    *,
    reason_code: str,
    operation_id: str,
) -> dict[str, Any]:
    previous = session.get("status")
    allowed = _SERVICE_TRANSITIONS.get(previous)
    if allowed is None or status not in allowed:
        return {
            "ok": False,
            "code": "SERVICE_TRANSITION_CONFLICT",
            "from": previous,
            "to": status,
            "operationId": operation_id,
        }
    revision = session.get("stateRevision")
    try:
        revision_number = int(revision)
    except (TypeError, ValueError):
        revision_number = 0
    session["stateRevision"] = revision_number + 1
    session["status"] = status
    session["reasonCode"] = _canonical_service_reason(reason_code)
    session["operationId"] = operation_id
    history = session.setdefault("transitionHistory", [])
    if not isinstance(history, list):
        history = []
        session["transitionHistory"] = history
    history.append(
        {
            "from": previous,
            "to": status,
            "reasonCode": _canonical_service_reason(reason_code),
            "operationId": operation_id,
            "at": now_iso(),
            "revision": session["stateRevision"],
        }
    )
    return {
        "ok": True,
        "from": previous,
        "to": status,
        "reasonCode": session["reasonCode"],
        "revision": session["stateRevision"],
    }


def _ensure_session_state(
    session: dict[str, Any],
    *,
    operation_id: str,
    generation: int | None = None,
) -> None:
    # Legacy durable service sessions did not persist an explicit status.  A
    # session carrying a process identity is an existing READY incarnation,
    # while synthetic transition fixtures intentionally remain status-less so
    # they can exercise the ``None -> STARTING`` edge.
    if "pid" in session and not isinstance(session.get("status"), str):
        session["status"] = "READY"
        session.setdefault("reasonCode", "SERVICE_READY")
    if not isinstance(session.get("serviceGeneration"), int) or session.get(
        "serviceGeneration"
    ) <= 0:
        session["serviceGeneration"] = _normalize_service_generation(generation)
    if not isinstance(session.get("stateRevision"), int):
        session["stateRevision"] = 0
    session.setdefault("transitionHistory", [])
    session["heartbeat"] = {
        "kind": "SUPERVISOR",
        "writerIdentity": _process_provider.canonical_argv_hash(
            [str(Path(sys.executable).resolve()), str(os.getpid())]
        ),
        "generation": session["serviceGeneration"],
        "lastSeenAt": now_iso(),
        "ttlSeconds": HEARTBEAT_TTL_SECONDS,
        "staleReason": None,
    }
    legacy_token = session.pop("instanceToken", None)
    if isinstance(legacy_token, str) and legacy_token:
        session.setdefault("instanceTokenHash", sha256_text(legacy_token))
    session.setdefault("instanceTokenHash", None)
    session.setdefault("identityCompleteness", "COMPLETE")
    session["operationId"] = operation_id


def _heartbeat_status(session: dict[str, Any]) -> dict[str, Any]:
    heartbeat = session.get("heartbeat")
    if not isinstance(heartbeat, dict):
        return {"status": "UNKNOWN", "stale": False, "reasonCode": None}
    raw = heartbeat.get("lastSeenAt")
    ttl = heartbeat.get("ttlSeconds")
    try:
        seen = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=dt.timezone.utc)
        age = (dt.datetime.now(dt.timezone.utc) - seen.astimezone(dt.timezone.utc)).total_seconds()
        stale = age > float(ttl)
    except (TypeError, ValueError):
        age = float("inf")
        stale = True
    return {
        "status": "STALE" if stale else "FRESH",
        "stale": stale,
        "ageSeconds": age,
        "reasonCode": "SERVICE_HEARTBEAT_STALE" if stale else None,
    }


def _same_path(left: Any, right: Path | None) -> bool:
    if right is None or not isinstance(left, str) or not left.strip():
        return False
    try:
        return Path(left).resolve() == right.resolve()
    except OSError:
        return False


def session_is_owned(
    session: dict[str, Any],
    *,
    change_id: str | None = None,
    execution_root: Path | None = None,
    worktree_root: Path | None = None,
) -> bool:
    """Return true for an AI session owned by the supplied change/root filters.

    ``change_id`` is required when provided. Root filters match if the session's
    ``executionRoot`` or ``worktreeRoot`` equals any supplied root (OR).
    """
    if session.get("startedBy") != "AI":
        return False
    if change_id is not None and session.get("changeId") != change_id:
        return False
    root_matches: list[bool] = []
    if execution_root is not None:
        root_matches.append(_same_path(session.get("executionRoot"), execution_root))
        root_matches.append(_same_path(session.get("worktreeRoot"), execution_root))
    if worktree_root is not None:
        root_matches.append(_same_path(session.get("worktreeRoot"), worktree_root))
        root_matches.append(_same_path(session.get("executionRoot"), worktree_root))
    if root_matches and not any(root_matches):
        return False
    return True


def find_owned_sessions(
    project_root: Path,
    *,
    change_id: str | None = None,
    execution_root: Path | None = None,
    worktree_root: Path | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Discover persisted sessions and classify them without stopping anything."""
    project = resolve_path(project_root)
    candidate_dirs: list[Path] = []
    if change_id:
        candidate_dirs.extend(
            [
                project / ".harness" / "changes" / change_id,
                project / ".harness" / "state" / "changes" / change_id,
            ]
        )
    else:
        for root in (
            project / ".harness" / "changes",
            project / ".harness" / "state" / "changes",
        ):
            if root.is_dir():
                candidate_dirs.extend(path for path in root.iterdir() if path.is_dir())

    owned: list[dict[str, Any]] = []
    reported: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for change_dir in candidate_dirs:
        path = session_path(change_dir)
        try:
            path = path.resolve()
        except OSError:
            continue
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        try:
            session = load_session(change_dir)
        except SessionCorrupt as exc:
            reported.append(
                {
                    "sessionPath": str(path),
                    "reason": "session-corrupt",
                    "detail": str(exc),
                }
            )
            continue
        if session is None:
            continue
        item = {"changeDir": str(change_dir.resolve()), "session": session}
        if session_is_owned(
            session,
            change_id=change_id,
            execution_root=execution_root,
            worktree_root=worktree_root,
        ):
            owned.append(item)
        else:
            reported.append(
                {
                    "sessionPath": str(path),
                    "reason": "not-owned",
                    "startedBy": session.get("startedBy"),
                    "pid": session.get("pid"),
                    "leasedPort": session.get("leasedPort"),
                }
            )
    return {"owned": owned, "reported": reported}


def stop_owned_sessions(
    project_root: Path,
    *,
    change_id: str | None = None,
    execution_root: Path | None = None,
    worktree_root: Path | None = None,
) -> dict[str, Any]:
    """Stop only discovered AI sessions whose persisted ownership still matches."""
    discovered = find_owned_sessions(
        project_root,
        change_id=change_id,
        execution_root=execution_root,
        worktree_root=worktree_root,
    )
    stopped: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    ports_still_in_use: list[int] = []
    for item in discovered["owned"]:
        change_dir = Path(item["changeDir"])
        session = item["session"]
        if not session_is_owned(
            session,
            change_id=change_id,
            execution_root=execution_root,
            worktree_root=worktree_root,
        ):
            blocked.append(
                {"sessionPath": str(session_path(change_dir)), "reason": "ownership-changed"}
            )
            continue
        result = stop_ai_session(change_dir, session, require_identity=True)
        result["sessionPath"] = str(session_path(change_dir))
        if result.get("action") == "needs-user-decision":
            blocked.append(result)
            continue
        pid = session.get("pid")
        if isinstance(pid, int) and is_pid_alive(pid):
            blocked.append(
                {
                    "sessionPath": str(session_path(change_dir)),
                    "reason": "owned-process-still-alive",
                    "pid": pid,
                }
            )
            continue
        stopped.append(result)
        port = session.get("leasedPort")
        if isinstance(port, int) and is_port_in_use(port):
            ports_still_in_use.append(port)
    return {
        "ok": not blocked,
        "ownedSessions": len(discovered["owned"]),
        "stopped": stopped,
        "blocked": blocked,
        "reported": discovered["reported"],
        "portsStillInUse": ports_still_in_use,
    }


# ---------------------------------------------------------------------------
# Start / stop helpers
# ---------------------------------------------------------------------------

_WIN_LAUNCHER_SOURCE = """\
#!/usr/bin/env python3
\"\"\"Harness Windows service launcher (internal).\"\"\"
from __future__ import annotations

import ctypes
import json
import subprocess
import sys
from pathlib import Path

_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _create_job(name: str) -> int:
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    handle = kernel32.CreateJobObjectW(None, name)
    if not handle:
        raise OSError("CreateJobObjectW failed")
    info = _ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    configured = kernel32.SetInformationJobObject(
        ctypes.c_void_p(handle),
        _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if not configured:
        kernel32.CloseHandle(ctypes.c_void_p(handle))
        raise OSError("SetInformationJobObject failed")
    return int(handle)


def main() -> int:
    log_path = Path(sys.argv[1])
    argv_path = Path(sys.argv[2])
    pid_path = Path(sys.argv[3])
    job_name = sys.argv[4]
    argv = json.loads(argv_path.read_text(encoding="utf-8"))
    if not isinstance(argv, list) or not argv or any(
        not isinstance(item, str) or "\\0" in item for item in argv
    ):
        raise SystemExit("empty or invalid service argv")

    job_handle = _create_job(job_name)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_handle = log_path.open("w", encoding="utf-8", errors="replace")
    try:
        proc = subprocess.Popen(
            argv,
            shell=False,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=(_CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW),
            close_fds=False,
        )
    finally:
        log_handle.close()

    kernel32 = ctypes.windll.kernel32
    assigned = kernel32.AssignProcessToJobObject(
        ctypes.c_void_p(job_handle),
        ctypes.c_void_p(int(proc._handle)),
    )
    if not assigned:
        proc.terminate()
        kernel32.CloseHandle(ctypes.c_void_p(job_handle))
        raise OSError("AssignProcessToJobObject failed")
    pid_path.write_text(str(proc.pid), encoding="utf-8")
    try:
        return int(proc.wait())
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(job_handle))


if __name__ == "__main__":
    raise SystemExit(main())
"""


def _runtime_dir(change_dir: Path) -> Path:
    path = change_dir / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _launcher_pid_path(change_dir: Path) -> Path:
    return _runtime_dir(change_dir) / "_harness_service.launcher.pid"


def _job_id_path(change_dir: Path) -> Path:
    return _runtime_dir(change_dir) / "_harness_service.job.id"


def _child_pid_path(change_dir: Path) -> Path:
    return _runtime_dir(change_dir) / "_harness_service.child.pid"


def _cleanup_windows_launcher(change_dir: Path) -> None:
    if os.name != "nt":
        return
    path = _launcher_pid_path(change_dir)
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8").strip()
    try:
        path.unlink()
    except OSError:
        pass
    if text.isdigit():
        pid = int(text)
        if is_pid_alive(pid):
            terminate_process_tree(pid)


def _wait_for_windows_launcher_exit(
    change_dir: Path,
    *,
    timeout_sec: float = STOP_CONFIRM_TIMEOUT_SEC,
) -> bool:
    """Wait for the detached Job owner to release log/file handles.

    The launcher is deliberately not killed by PID.  Its named Job has
    already been terminated through the ownership proof; this wait merely
    observes the launcher completing its ``proc.wait()`` and avoids a race
    with archive/temp-directory cleanup.
    """
    pid = _read_positive_int(_launcher_pid_path(change_dir))
    if pid is None:
        return True
    deadline = time.monotonic() + max(0.0, timeout_sec)
    while is_pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not is_pid_alive(pid)


def _write_windows_launcher(change_dir: Path) -> Path:
    launcher = _runtime_dir(change_dir) / "_harness_service_launcher.py"
    launcher.write_text(_WIN_LAUNCHER_SOURCE, encoding="utf-8", newline="\n")
    return launcher


def _wait_for_child_pid(pid_path: Path, *, timeout_sec: float = 15.0) -> int:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if pid_path.is_file():
            text = pid_path.read_text(encoding="utf-8").strip()
            if text.isdigit():
                return int(text)
        time.sleep(0.05)
    raise TimeoutError(f"service child pid not recorded within {timeout_sec:.0f}s ({pid_path})")


def _read_positive_int(path: Path) -> int | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() and int(text) > 0 else None


def _read_optional_text(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def _start_detached_service_windows(
    argv: list[str],
    *,
    change_dir: Path,
    cwd: Path,
    log_file: Path,
    owner_token: str,
) -> _process_provider.SpawnedProcess:
    runtime = _runtime_dir(change_dir)
    launcher = _write_windows_launcher(change_dir)
    command_path = runtime / "_harness_service.command.txt"
    pid_path = _child_pid_path(change_dir)
    owner_hash = _process_provider._token_hash(owner_token)
    proof_id = "proof-" + uuid.uuid4().hex
    job_id = (
        "Local\\HunterHarness-"
        + owner_hash.split(":", 1)[1][:16]
        + "-"
        + proof_id
    )
    command_path.write_text(
        json.dumps(argv, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )
    _job_id_path(change_dir).write_text(job_id, encoding="utf-8", newline="\n")
    if pid_path.exists():
        pid_path.unlink()

    launcher_args = [
        sys.executable,
        str(launcher),
        str(log_file),
        str(command_path),
        str(pid_path),
        job_id,
    ]
    win_flags = (
        _DETACHED_PROCESS
        | _CREATE_NEW_PROCESS_GROUP
        | _CREATE_NO_WINDOW
        | _CREATE_BREAKAWAY_FROM_JOB
    )
    launcher_proc = subprocess.Popen(
        launcher_args,
        cwd=str(cwd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=win_flags,
        close_fds=False,
    )
    _launcher_pid_path(change_dir).write_text(str(launcher_proc.pid), encoding="utf-8")
    _wait_for_child_pid(pid_path)
    # The launcher intentionally remains alive as the Job Object owner. Close
    # only this controller's process handle so Popen does not warn at teardown.
    launcher_handle = getattr(launcher_proc, "_handle", None)
    if launcher_handle is not None:
        launcher_handle.Close()
        launcher_proc.returncode = 0
    child_pid = _read_positive_int(pid_path)
    if child_pid is None:
        raise TimeoutError(f"service child pid is invalid ({pid_path})")
    observed = _process_provider.observe_process_identity(child_pid)
    attestation = json.loads(json.dumps(observed))
    attestation["argvHash"] = _process_provider.canonical_argv_hash(argv)
    attestation["workingDirectory"] = str(cwd.resolve())
    attestation["ownerTokenHash"] = owner_hash
    attestation["fieldProvenance"]["argvHash"] = (
        "OBSERVED" if observed.get("argvHash") is not None else "ATTESTED"
    )
    attestation["fieldProvenance"]["workingDirectory"] = (
        "OBSERVED"
        if observed.get("workingDirectory") is not None
        else "ATTESTED"
    )
    attestation["fieldProvenance"]["ownerTokenHash"] = "ATTESTED"
    attestation["capabilities"]["canVerifyOwnership"] = True
    proof = {
        "schemaVersion": 1,
        "proofId": proof_id,
        "kind": "WINDOWS_NAMED_JOB",
        "jobName": job_id,
        "ownershipTokenHash": owner_hash,
        "leaderPid": child_pid,
        "leaderCreatedAt": attestation.get("createdAt"),
        "members": [attestation],
        "membersComplete": True,
        "leaderExited": False,
    }
    return _process_provider.SpawnedProcess(
        process=launcher_proc,
        attestation=attestation,
        observedIdentity=observed,
        ownershipProof=proof,
    )


def start_detached_service(
    argv: list[str] | tuple[str, ...] | str,
    *,
    change_dir: Path,
    cwd: Path,
) -> _process_provider.SpawnedProcess:
    """Start service with structured argv; log to logs/service-start.log.

    ``str`` is retained only for callers from the legacy facade and is parsed
    by the same profile parser; no caller is allowed to reach ``shell=True``.
    """
    if isinstance(argv, str):
        argv = resolve_service_argv({"command": argv})
    argv = list(argv)
    if not argv:
        raise ValueError("ARGUMENT_INVALID: service argv is empty")
    log_file = log_path(change_dir)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    if log_file.is_file():
        log_file.unlink()

    owner_token = f"service:{change_dir.resolve()}:{uuid.uuid4().hex}"
    if os.name == "nt":
        return _start_detached_service_windows(
            argv,
            change_dir=change_dir,
            cwd=cwd,
            log_file=log_file,
            owner_token=owner_token,
        )

    log_handle = log_file.open("w", encoding="utf-8", errors="replace")
    try:
        return _process_provider.spawn_structured_argv(
            argv,
            cwd=cwd,
            environment={
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
            },
            owner_token=owner_token,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
        )
    finally:
        try:
            log_handle.close()
        except OSError:
            pass


def build_session(
    *,
    pid: int,
    module_inputs_hash: str,
    module_inputs_files: list[str],
    command: str,
    service_start: dict[str, Any],
    argv: list[str] | None = None,
    process_attestation: dict[str, Any] | None = None,
    ownership_proof: dict[str, Any] | None = None,
    started_at: str | None = None,
    worktree_root: Path | None = None,
    execution_root: Path | None = None,
    change_id: str | None = None,
    attempt_id: str | None = None,
    service_pid: int | None = None,
    job_id: str | None = None,
) -> dict[str, Any]:
    profile_name = service_start.get("profile") or "local-dev"
    overlay = service_start.get("overlayPath") or ""
    effective_started_at = started_at or now_iso()
    executable = get_process_executable(pid) or (
        sys.executable if os.name == "nt" else os.environ.get("SHELL", "/bin/sh")
    )
    owned_ports: set[int] = set()
    port = extract_port(service_start)
    if port is not None:
        owned_ports.add(port)
    configured_ports = service_start.get("ownedPorts")
    if isinstance(configured_ports, list):
        for item in configured_ports:
            try:
                candidate = int(item)
            except (TypeError, ValueError):
                continue
            if 0 < candidate < 65536:
                owned_ports.add(candidate)
    resolved_argv = list(argv or [])
    argv_hash = (
        _process_provider.canonical_argv_hash(resolved_argv)
        if resolved_argv
        else sha256_text(command)
    )
    attestation = (
        json.loads(json.dumps(process_attestation))
        if isinstance(process_attestation, dict)
        else None
    )
    process_identity = {
        "executable": str(executable),
        "commandHash": argv_hash,
        "argvHash": argv_hash,
        "startedAt": effective_started_at,
        "parentChain": [
            {
                "pid": os.getpid(),
                "executable": str(Path(sys.executable).resolve()),
            }
        ],
    }
    if attestation is not None:
        process_identity.update(attestation)
        # Preserve the service's public legacy field names while keeping the
        # provider attestation as the source of truth for destructive actions.
        process_identity["commandHash"] = argv_hash
        process_identity["argvHash"] = attestation.get("argvHash", argv_hash)
    session = {
        "schemaVersion": 1,
        "serviceId": str(
            service_start.get("serviceId")
            or change_id
            or profile_name
        ),
        "sessionId": "service-" + uuid.uuid4().hex,
        "status": "STARTING",
        "reasonCode": "SERVICE_START_REQUESTED",
        "pid": pid,
        "startedBy": "AI",
        "moduleInputsHash": module_inputs_hash,
        "moduleInputsFiles": module_inputs_files,
        "profile": profile_name,
        "startCommandHash": argv_hash,
        "overlayPath": overlay,
        "startedAt": effective_started_at,
        "command": command,
        "argv": resolved_argv,
        "ownedPorts": sorted(owned_ports),
        "processIdentity": process_identity,
        "fingerprint": module_inputs_hash,
        "cleanupComplete": False,
        "supersedesSessionId": None,
        "leaseIdentity": None,
    }
    if attestation is not None:
        session["processAttestation"] = attestation
    if isinstance(ownership_proof, dict):
        session["ownershipProof"] = json.loads(json.dumps(ownership_proof))
    if isinstance(service_pid, int) and service_pid > 0:
        session["servicePid"] = service_pid
    if job_id:
        session["jobId"] = str(job_id)
    if isinstance(service_start.get("leasedPort"), int):
        session["leasedPort"] = service_start["leasedPort"]
        session["leaseOwner"] = service_start.get("leaseOwner")
    lease_id = service_start.get("leaseId")
    lease_change_id = service_start.get("leaseChangeId") or change_id
    lease_run_id = service_start.get("runId") or attempt_id
    lease_expires_at = service_start.get("leaseExpiresAt")
    lease_generation = service_start.get("leaseGeneration")
    if (
        isinstance(lease_id, str)
        and lease_id
        and isinstance(lease_change_id, str)
        and lease_change_id
        and isinstance(lease_run_id, str)
        and lease_run_id
        and isinstance(lease_expires_at, str)
        and lease_expires_at
    ):
        session["leaseIdentity"] = {
            "leaseId": lease_id,
            "changeId": lease_change_id,
            "runId": lease_run_id,
            "expiresAt": lease_expires_at,
            "generation": _normalize_service_generation(lease_generation),
        }
        if isinstance(service_start.get("listenerIdentity"), dict):
            session["leaseIdentity"]["listenerIdentity"] = json.loads(
                json.dumps(service_start["listenerIdentity"], ensure_ascii=False)
            )
    if worktree_root is not None:
        session["worktreeRoot"] = str(worktree_root.resolve())
    if execution_root is not None:
        session["executionRoot"] = str(execution_root.resolve())
    if change_id:
        session["changeId"] = change_id
    if attempt_id:
        session["attemptId"] = attempt_id
    return session


def compute_module_hash(
    files: list[str],
    session: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    """Compute inputsHash from --files, else session.moduleInputsFiles, else empty."""
    use_files = list(files)
    if not use_files and session is not None:
        stored = session.get("moduleInputsFiles")
        if isinstance(stored, list):
            use_files = [str(x) for x in stored if str(x).strip()]
    if not use_files:
        # Empty set → stable empty hash (order-independent)
        return compute_inputs_hash([])
    return compute_inputs_hash(use_files)


def needs_user_decision(
    *,
    reason: str,
    as_json: bool,
    **extra: Any,
) -> int:
    payload: dict[str, Any] = {
        "ok": True,
        "action": "needs-user-decision",
        "reason": reason,
    }
    payload.update(extra)
    emit_json(payload, as_json=as_json)
    return 0


def _confirm_service_shutdown(session: dict[str, Any]) -> dict[str, Any]:
    tracked_pids = sorted(
        {
            value
            for value in (session.get("pid"), session.get("servicePid"))
            if isinstance(value, int) and value > 0
        }
    )
    ports = sorted(
        {
            int(value)
            for value in (session.get("ownedPorts") or [])
            if isinstance(value, int) and 0 < value < 65536
        }
    )
    deadline = time.monotonic() + STOP_CONFIRM_TIMEOUT_SEC
    while True:
        alive_pids = [pid for pid in tracked_pids if is_pid_alive(pid)]
        occupied_ports = [port for port in ports if is_port_in_use(port)]
        if not alive_pids and not occupied_ports:
            return {
                "ok": True,
                "alivePids": [],
                "occupiedPorts": [],
            }
        if time.monotonic() >= deadline:
            return {
                "ok": False,
                "alivePids": alive_pids,
                "occupiedPorts": occupied_ports,
            }
        time.sleep(0.05)


def _remove_windows_service_metadata(change_dir: Path) -> None:
    if os.name != "nt":
        return
    runtime = change_dir / "runtime"
    for name in (
        "_harness_service.launcher.pid",
        "_harness_service.child.pid",
        "_harness_service.job.id",
        "_harness_service.command.txt",
        "_harness_service_launcher.py",
    ):
        try:
            (runtime / name).unlink(missing_ok=True)
        except OSError:
            pass


def stop_ai_session(
    change_dir: Path,
    session: dict[str, Any],
    *,
    require_identity: bool = True,
) -> dict[str, Any]:
    """Stop verified AI session process and clear session file."""
    operation_id = _service_operation_id(session)
    _ensure_session_state(session, operation_id=operation_id)
    pid = session.get("pid")
    if require_identity:
        identity = verify_process_identity(session)
        if identity is not True:
            _transition(
                session,
                "STALE_IDENTITY_MISMATCH" if identity is False else "FAILED",
                reason_code=(
                    "STALE_IDENTITY_MISMATCH"
                    if identity is False
                    else "IDENTITY_UNVERIFIABLE"
                ),
                operation_id=operation_id,
            )
            write_session(change_dir, session)
            return {
                "ok": True,
                "action": "needs-user-decision",
                "reasonCode": (
                    "PROCESS_IDENTITY_MISMATCH"
                    if identity is False
                    else "IDENTITY_UNVERIFIABLE"
                ),
                "reason": (
                    "cannot-verify-process-identity"
                    if identity is None
                    else "process-identity-mismatch"
                ),
                "pid": pid,
                "killed": False,
            }
    stopping_transition = _transition(
        session,
        "STOPPING",
        reason_code="SERVICE_STOPPING",
        operation_id=operation_id,
    )
    if not stopping_transition.get("ok"):
        return {
            "ok": False,
            "code": "SERVICE_TRANSITION_CONFLICT",
            "reasonCode": "SERVICE_TRANSITION_CONFLICT",
            "action": "stop-refused",
            "from": stopping_transition.get("from"),
            "to": stopping_transition.get("to"),
            "operationId": operation_id,
            "killed": False,
            "sessionCleared": False,
        }
    write_session(change_dir, session)
    termination: dict[str, Any] | None = None
    if isinstance(pid, int) and is_pid_alive(pid):
        termination = terminate_process_tree(
            pid,
            expected_attestation=(
                session.get("processAttestation")
                if isinstance(session.get("processAttestation"), dict)
                else None
            ),
            ownership_proof=(
                session.get("ownershipProof")
                if isinstance(session.get("ownershipProof"), dict)
                else None
            ),
            timeout_policy={"graceSeconds": STOP_CONFIRM_TIMEOUT_SEC},
        )
        if (
            isinstance(termination, dict)
            and termination.get("reasonCode") == "IDENTITY_UNVERIFIABLE"
        ):
            _transition(
                session,
                "STALE_IDENTITY_MISMATCH",
                reason_code="STALE_IDENTITY_MISMATCH",
                operation_id=operation_id,
            )
            write_session(change_dir, session)
            return {
                "ok": True,
                "action": "needs-user-decision",
                "reasonCode": "IDENTITY_UNVERIFIABLE",
                "reason": "ownership-proof-unavailable",
                "pid": pid,
                "killed": False,
            }
    confirmation = _confirm_service_shutdown(session)
    if confirmation["alivePids"]:
        _transition(
            session,
            "FAILED",
            reason_code="PROCESS_TREE_EXIT_UNCONFIRMED",
            operation_id=operation_id,
        )
        write_session(change_dir, session)
        return {
            "ok": False,
            "code": "PROCESS_TREE_EXIT_UNCONFIRMED",
            "reasonCode": "SERVICE_STOP_FAILED",
            "action": "cleanup-unconfirmed",
            "pid": pid,
            "alivePids": confirmation["alivePids"],
            "occupiedPorts": confirmation["occupiedPorts"],
            "killed": True,
            "sessionCleared": False,
        }
    if confirmation["occupiedPorts"]:
        _transition(
            session,
            "FAILED",
            reason_code="OWNED_PORT_RELEASE_UNCONFIRMED",
            operation_id=operation_id,
        )
        write_session(change_dir, session)
        return {
            "ok": False,
            "code": "OWNED_PORT_RELEASE_UNCONFIRMED",
            "reasonCode": "SERVICE_CLEANUP_INCOMPLETE",
            "action": "cleanup-unconfirmed",
            "pid": pid,
            "alivePids": [],
            "occupiedPorts": confirmation["occupiedPorts"],
            "killed": True,
            "sessionCleared": False,
        }
    if os.name == "nt" and not _wait_for_windows_launcher_exit(change_dir):
        _transition(
            session,
            "FAILED",
            reason_code="SERVICE_STOP_TIMEOUT",
            operation_id=operation_id,
        )
        write_session(change_dir, session)
        return {
            "ok": False,
            "code": "SERVICE_STOP_TIMEOUT",
            "reasonCode": "SERVICE_STOP_TIMEOUT",
            "action": "cleanup-unconfirmed",
            "pid": pid,
            "alivePids": [],
            "occupiedPorts": [],
            "launcherStillAlive": True,
            "killed": True,
            "sessionCleared": False,
        }
    stopped_transition = _transition(
        session,
        "STOPPED",
        reason_code="SERVICE_STOP_CONFIRMED",
        operation_id=operation_id,
    )
    if not stopped_transition.get("ok"):
        write_session(change_dir, session)
        return {
            "ok": False,
            "code": "SERVICE_TRANSITION_CONFLICT",
            "reasonCode": "SERVICE_TRANSITION_CONFLICT",
            "action": "cleanup-unconfirmed",
            "pid": pid,
            "killed": True,
            "sessionCleared": False,
            "alivePids": [],
            "occupiedPorts": [],
        }
    _remove_windows_service_metadata(change_dir)
    clear_session(change_dir)
    return {
        "ok": True,
        "code": "SERVICE_STOP_CONFIRMED",
        "reasonCode": "SERVICE_STOPPED",
        "action": "stopped",
        "pid": pid,
        "killed": True,
        "sessionCleared": True,
        "alivePids": [],
        "occupiedPorts": [],
    }


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_ensure(args: argparse.Namespace) -> int:
    """Serialize ensure mutations and expose a stable conflict receipt."""

    change_dir = resolve_path(args.change_dir)
    lock = ServiceMutationLock(change_dir, operation="ensure")
    conflict = lock.acquire()
    if conflict is not None:
        emit_json(conflict, as_json=bool(args.json))
        return 4
    setattr(args, "_service_operation_id", lock.token)
    try:
        return _cmd_ensure_impl(args)
    finally:
        lock.release()


def _cmd_ensure_impl(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    change_dir = resolve_path(args.change_dir)
    project = resolve_path(args.project)
    files = parse_files_arg(getattr(args, "files", None))

    try:
        profile = load_build_profile(project)
    except (OSError, ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
        return emit_error(str(exc), as_json=as_json)

    # cluster 3 (spec §3.1/§3.4): resolve 模板 serviceStart + runtime context。
    # 持久 profile 只保存模板；runtime overlay/profile 注入到 session，不写回持久 profile。
    # 含 worktree/change 陈旧持久值时拒绝（修复输入端陈旧 profile）。
    change_name = getattr(args, "change_name", None) or change_dir.name
    worktree_root_raw = getattr(args, "worktree_root", None)
    execution_root_raw = getattr(args, "execution_root", None)
    attempt_id = str(getattr(args, "attempt_id", None) or "").strip() or None
    worktree_root = (
        resolve_path(worktree_root_raw) if worktree_root_raw else project
    )
    execution_root = (
        resolve_path(execution_root_raw) if execution_root_raw else None
    )
    overlay = getattr(args, "overlay", None)
    leased_port = getattr(args, "leased_port", None)
    lease_owner = str(getattr(args, "lease_owner", None) or "").strip() or None
    try:
        service_start = resolve_service_start(
            profile,
            change_name=change_name,
            worktree_root=project,
            overlay_path=overlay,
            leased_port=leased_port,
            lease_owner=lease_owner,
        )
    except ValueError as exc:
        return emit_error(str(exc), as_json=as_json)

    argv = list(service_start.get("argv") or [])
    if not argv:
        return emit_error(
            "serviceStart resolved to an empty argv; run profile migration and review",
            as_json=as_json,
        )
    command = str(service_start.get("command") or " ".join(argv)).strip()
    port = extract_port(service_start)

    # Resolve service input file set (CLI --files ∪ serviceStart.inputFiles).
    # Empty result is deferred: _start_and_record rejects it before generating a
    # reusable empty fingerprint; the port-occupied / reuse paths still proceed.
    try:
        files = resolve_service_input_files(project, service_start, files)
    except ValueError:
        files = []

    try:
        session = load_session(change_dir)
    except SessionCorrupt as exc:
        return needs_user_decision(
            reason=f"session-corrupt: {exc}",
            as_json=as_json,
            detail="missing or corrupt session is treated as a user process; will not kill",
        )

    # --- Branch 1: existing AI session with live verified process ---
    if session is not None:
        pid = session["pid"]
        alive = is_pid_alive(pid)
        if alive:
            identity = verify_process_identity(session)
            if identity is not True:
                return needs_user_decision(
                    reason=(
                        "cannot-verify-process-identity"
                        if identity is None
                        else "process-identity-mismatch"
                    ),
                    as_json=as_json,
                    pid=pid,
                    reasonCode=(
                        "IDENTITY_UNVERIFIABLE"
                        if identity is None
                        else "PROCESS_IDENTITY_MISMATCH"
                    ),
                    sessionPath=str(session_path(change_dir)),
                    detail=(
                        "pid is alive but create-time/cmdline identity could not be "
                        "confirmed against session; refusing to reuse or kill"
                    ),
                )

            try:
                current_hash, current_files = compute_module_hash(files, session)
            except (OSError, FileNotFoundError) as exc:
                return emit_error(f"inputsHash failed: {exc}", as_json=as_json)

            stored_hash = session.get("moduleInputsHash")
            # §5.3: reuse must compare inputsHash + startCommandHash + profile
            # + overlayPath (process identity already verified above). Any
            # change -> restart; never reuse on a partial match.
            current_cmd_hash = _process_provider.canonical_argv_hash(argv)
            current_profile = service_start.get("profile") or "local-dev"
            current_overlay = service_start.get("overlayPath") or ""
            health_match = probe_health(
                service_start,
                expected_instance_token=(
                    str(service_start.get("instanceToken"))
                    if service_start.get("requireInstanceToken") is True
                    and service_start.get("instanceToken")
                    else None
                ),
            )
            configured_token = service_start.get("instanceToken")
            if (
                service_start.get("requireInstanceToken") is True
                and isinstance(configured_token, str)
                and session.get("instanceTokenHash") is not None
                and session.get("instanceTokenHash") != sha256_text(configured_token)
            ):
                health_match = False
            if (
                health_match
                and service_start.get("requireInstanceToken") is not True
                and extract_port(service_start) is not None
            ):
                health_match = _listener_identity_is_owned(session, service_start)
            fingerprint_match = (
                stored_hash == current_hash
                and session.get("startCommandHash") == current_cmd_hash
                and session.get("profile") == current_profile
                and session.get("overlayPath") == current_overlay
                and session.get("leasedPort") == service_start.get("leasedPort")
                and session.get("leaseOwner") == service_start.get("leaseOwner")
                and health_match
            )
            if fingerprint_match:
                operation_id = str(
                    getattr(args, "_service_operation_id", "") or uuid.uuid4().hex
                )
                _ensure_session_state(
                    session,
                    operation_id=operation_id,
                )
                _transition(
                    session,
                    "READY",
                    reason_code="SERVICE_REUSED",
                    operation_id=operation_id,
                )
                write_session(change_dir, session)
                payload = {
                    "ok": True,
                    "action": "reused",
                    "pid": pid,
                    "moduleInputsHash": current_hash,
                    "moduleInputsFiles": current_files,
                    "sessionPath": str(session_path(change_dir)),
                }
                emit_json(payload, as_json=as_json)
                return 0

            # Fingerprint mismatch → stop old, start new
            stop_result = stop_ai_session(change_dir, session, require_identity=True)
            if stop_result.get("action") == "needs-user-decision":
                emit_json(stop_result, as_json=as_json)
                return 0
            if not stop_result.get("ok"):
                emit_json(stop_result, as_json=as_json)
                return 1

            return _start_and_record(
                change_dir=change_dir,
                project=project,
                service_start=service_start,
                command=command,
                argv=argv,
                files=files if files else current_files,
                as_json=as_json,
                action="restarted",
                previousPid=pid,
                worktree_root=worktree_root,
                execution_root=execution_root,
                change_id=change_name,
                attempt_id=attempt_id,
                operation_id=str(getattr(args, "_service_operation_id", "") or uuid.uuid4().hex),
            )

        # pid dead → stale session; clear and fall through
        clear_session(change_dir)

    # --- Branch 2: no usable session; port occupied → user decision ---
    if port is not None and is_port_in_use(port):
        return needs_user_decision(
            reason="port-occupied-without-ai-session",
            as_json=as_json,
            port=port,
            detail=(
                "port is in use but no verified AI service-session exists; "
                "treated as user process — will not kill"
            ),
        )

    # --- Branch 3: start fresh ---
    return _start_and_record(
        change_dir=change_dir,
        project=project,
        service_start=service_start,
        command=command,
        argv=argv,
        files=files,
        as_json=as_json,
        action="started",
        worktree_root=worktree_root,
        execution_root=execution_root,
        change_id=change_name,
        attempt_id=attempt_id,
        operation_id=str(getattr(args, "_service_operation_id", "") or uuid.uuid4().hex),
    )


def _start_and_record(
    *,
    change_dir: Path,
    project: Path,
    service_start: dict[str, Any],
    command: str,
    argv: list[str],
    files: list[str],
    as_json: bool,
    action: str,
    worktree_root: Path | None = None,
    execution_root: Path | None = None,
    change_id: str | None = None,
    attempt_id: str | None = None,
    operation_id: str | None = None,
    **extra: Any,
) -> int:
    if not files:
        # §5.1/§5.2: never generate a reusable empty service fingerprint.
        return emit_error(
            "service inputs are empty; configure serviceStart.inputFiles "
            "(or pass --files) so the service fingerprint covers real source",
            as_json=as_json,
        )
    try:
        module_hash, module_files = compute_module_hash(files, None)
    except (OSError, FileNotFoundError) as exc:
        return emit_error(f"inputsHash failed: {exc}", as_json=as_json)

    # Clear stale file-based health markers so wait_for_healthy cannot
    # succeed on a leftover marker from a previous process.
    _clear_file_health_markers(service_start)

    started_at = now_iso()
    operation_id = operation_id or uuid.uuid4().hex
    generation = _allocate_service_generation(change_dir)
    mutation_state = {
        "schemaVersion": 1,
        "status": "STARTING",
        "reasonCode": "SERVICE_START_REQUESTED",
        "serviceGeneration": generation,
        "stateRevision": 1,
        "operationId": operation_id,
        "startedAt": started_at,
        "argvHash": _process_provider.canonical_argv_hash(argv),
    }
    write_json(mutation_state_path(change_dir), mutation_state)
    spawned: _process_provider.SpawnedProcess
    try:
        spawned = start_detached_service(argv, change_dir=change_dir, cwd=project)
        pid = int(spawned.attestation.get("pid") or spawned.process.pid)
    except (OSError, TimeoutError, ValueError, RuntimeError) as exc:
        _cleanup_windows_launcher(change_dir)
        mutation_state.update(
            {
                "status": "FAILED",
                "reasonCode": "SERVICE_START_FAILED",
                "endedAt": now_iso(),
            }
        )
        write_json(mutation_state_path(change_dir), mutation_state)
        return emit_error(f"failed to start service: {exc}", as_json=as_json)

    # Give the OS a moment to register the process before identity/create-time reads
    time.sleep(0.15)

    try:
        wait_for_healthy(
            service_start,
            log_path(change_dir),
            pid=pid,
            expected_instance_token=(
                str(service_start.get("instanceToken"))
                if service_start.get("requireInstanceToken") is True
                and service_start.get("instanceToken")
                else None
            ),
        )
    except ServiceStartError as exc:
        # Best-effort cleanup of the failed start
        if is_pid_alive(pid):
            _capture_owned_service_members(spawned)
            terminate_process_tree(
                pid,
                expected_attestation=spawned.attestation,
                ownership_proof=spawned.ownershipProof,
            )
        _cleanup_windows_launcher(change_dir)
        clear_session(change_dir)
        mutation_state.update(
            {
                "status": "FAILED",
                "reasonCode": "SERVICE_START_FAILED",
                "endedAt": now_iso(),
            }
        )
        write_json(mutation_state_path(change_dir), mutation_state)
        return emit_error(
            str(exc),
            as_json=as_json,
            action="start-failed",
            pid=pid,
            fatalKeyword=exc.fatal_keyword,
        )

    _capture_owned_service_members(spawned)
    session = build_session(
        pid=pid,
        module_inputs_hash=module_hash,
        module_inputs_files=module_files,
        command=command,
        service_start=service_start,
        started_at=started_at,
        worktree_root=worktree_root,
        execution_root=execution_root,
        change_id=change_id,
        attempt_id=attempt_id,
        service_pid=(
            _read_positive_int(_child_pid_path(change_dir))
            if os.name == "nt"
            else pid
        ),
        job_id=(
            _read_optional_text(_job_id_path(change_dir))
            if os.name == "nt"
            else None
        ),
        process_attestation=spawned.attestation,
        ownership_proof=spawned.ownershipProof,
        argv=argv,
    )
    _ensure_session_state(
        session,
        operation_id=operation_id,
        generation=generation,
    )
    if isinstance(service_start.get("instanceToken"), str):
        session["instanceTokenHash"] = sha256_text(
            service_start["instanceToken"]
        )
    _transition(
        session,
        "READY",
        reason_code="SERVICE_READY",
        operation_id=operation_id,
    )
    write_session(change_dir, session)
    mutation_state.update(
        {
            "status": "READY",
            "reasonCode": "SERVICE_READY",
            "stateRevision": session.get("stateRevision"),
            "endedAt": now_iso(),
        }
    )
    write_json(mutation_state_path(change_dir), mutation_state)

    payload: dict[str, Any] = {
        "ok": True,
        "action": action,
        "pid": pid,
        "moduleInputsHash": module_hash,
        "moduleInputsFiles": module_files,
        "sessionPath": str(session_path(change_dir)),
        "logPath": str(log_path(change_dir)),
        "startedAt": started_at,
    }
    payload.update(extra)
    emit_json(payload, as_json=as_json)
    return 0


def _capture_owned_service_members(
    spawned: _process_provider.SpawnedProcess,
) -> None:
    """Materialize the provider's current owned members before persistence."""
    proof = spawned.ownershipProof
    if not isinstance(proof, dict):
        return
    _process_provider.capture_owned_members(spawned)


def _clear_file_health_markers(service_start: dict[str, Any]) -> None:
    candidates: list[Path] = []
    hf = service_start.get("healthFile")
    if isinstance(hf, str) and hf.strip():
        candidates.append(Path(hf.strip()))
    spec = service_start.get("healthUrl")
    if isinstance(spec, str) and spec.strip():
        resolved = resolve_health_file(spec.strip())
        if resolved is not None:
            candidates.append(resolved)
    for path in candidates:
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            pass


def cmd_status(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    change_dir = resolve_path(args.change_dir)
    files = parse_files_arg(getattr(args, "files", None))

    try:
        session = load_session(change_dir)
    except SessionCorrupt as exc:
        payload = {
            "ok": True,
            "action": "status",
            "sessionPresent": True,
            "sessionCorrupt": True,
            "reason": str(exc),
            "alive": False,
            "identityVerified": False,
            "fingerprintMatch": None,
            "treatAsUserProcess": True,
        }
        emit_json(payload, as_json=as_json)
        return 0

    if session is None:
        payload = {
            "ok": True,
            "action": "status",
            "sessionPresent": False,
            "alive": False,
            "identityVerified": False,
            "fingerprintMatch": None,
        }
        emit_json(payload, as_json=as_json)
        return 0

    pid = session.get("pid")
    alive = isinstance(pid, int) and is_pid_alive(pid)
    identity = verify_process_identity(session) if alive else False
    heartbeat = _heartbeat_status(session)

    fingerprint_match: bool | None = None
    current_hash: str | None = None
    try:
        current_hash, _ = compute_module_hash(files, session)
        stored = session.get("moduleInputsHash")
        if isinstance(stored, str) and stored:
            fingerprint_match = stored == current_hash
    except (OSError, FileNotFoundError):
        fingerprint_match = None

    payload = {
        "ok": True,
        "action": "status",
        "sessionPresent": True,
        "sessionCorrupt": False,
        "session": session,
        "pid": pid,
        "alive": alive,
        "identityVerified": identity is True,
        "identityStatus": (
            "verified" if identity is True else ("unknown" if identity is None else "mismatch")
        ),
        "reasonCode": (
            "SERVICE_READY"
            if identity is True
            else ("IDENTITY_UNVERIFIABLE" if identity is None else "PROCESS_IDENTITY_MISMATCH")
        ),
        "fingerprintMatch": fingerprint_match,
        "currentModuleInputsHash": current_hash,
        "startedBy": session.get("startedBy"),
        "serviceGeneration": session.get("serviceGeneration"),
        "stateRevision": session.get("stateRevision"),
        "serviceStatus": session.get("status"),
        "heartbeat": heartbeat,
    }
    emit_json(payload, as_json=as_json)
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    lock = ServiceMutationLock(change_dir, operation="stop")
    conflict = lock.acquire()
    if conflict is not None:
        emit_json(conflict, as_json=bool(args.json))
        return 4
    setattr(args, "_service_operation_id", lock.token)
    try:
        return _cmd_stop_impl(args)
    finally:
        lock.release()


def _cmd_stop_impl(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    change_dir = resolve_path(args.change_dir)
    if_started_by_ai = bool(getattr(args, "if_started_by_ai", False))

    try:
        session = load_session(change_dir)
    except SessionCorrupt as exc:
        return needs_user_decision(
            reason=f"session-corrupt: {exc}",
            as_json=as_json,
            detail="corrupt session treated as user process; will not kill",
            killed=False,
        )

    if session is None:
        payload = {
            "ok": True,
            "action": "already-stopped",
            "killed": False,
            "sessionCleared": False,
            "detail": "no service-session.json",
        }
        emit_json(payload, as_json=as_json)
        return 0

    started_by = session.get("startedBy")
    if if_started_by_ai and started_by != "AI":
        payload = {
            "ok": True,
            "action": "skipped",
            "reason": "not-started-by-ai",
            "startedBy": started_by,
            "killed": False,
            "sessionCleared": False,
        }
        emit_json(payload, as_json=as_json)
        return 0

    # Default stop also refuses to kill non-AI / unverified processes
    if started_by != "AI":
        return needs_user_decision(
            reason="not-started-by-ai",
            as_json=as_json,
            startedBy=started_by,
            killed=False,
            detail="session not marked startedBy=AI; will not kill",
        )

    result = stop_ai_session(change_dir, session, require_identity=True)
    emit_json(result, as_json=as_json)
    return 0 if result.get("ok") else 1


def retire_stale_session(change_dir: Path) -> dict[str, Any]:
    change_dir = resolve_path(change_dir)
    lock = ServiceMutationLock(change_dir, operation="retire-stale")
    conflict = lock.acquire()
    if conflict is not None:
        return conflict
    try:
        return _retire_stale_session_impl(change_dir, operation_id=lock.token)
    finally:
        lock.release()


def _project_root_for_change(change_dir: Path) -> Path | None:
    resolved = resolve_path(change_dir)
    for candidate in (resolved, *resolved.parents):
        if candidate.name == "changes" and candidate.parent.name == ".harness":
            return candidate.parent.parent
        if (candidate / ".harness").is_dir():
            return candidate
    return None


def _retirement_receipt_digest(receipt: dict[str, Any]) -> str:
    unsigned = {
        key: value for key, value in receipt.items() if key != "receiptDigest"
    }
    return sha256_text(
        json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


def _retirement_lease_cleanup(
    change_dir: Path,
    session: dict[str, Any],
) -> dict[str, Any]:
    """Attempt lease cleanup only with a complete lease/listener identity."""

    lease = session.get("leaseIdentity")
    if not isinstance(lease, dict):
        return {
            "status": "RETAINED",
            "reasonCode": "LISTENER_IDENTITY_UNVERIFIABLE",
            "leaseId": None,
        }
    lease_id = lease.get("leaseId")
    change_id = lease.get("changeId") or session.get("changeId")
    run_id = lease.get("runId") or session.get("attemptId")
    port = session.get("leasedPort")
    if not (
        isinstance(lease_id, str)
        and lease_id
        and isinstance(change_id, str)
        and change_id
        and isinstance(run_id, str)
        and run_id
        and isinstance(port, int)
        and 0 < port < 65536
    ):
        return {
            "status": "UNVERIFIED",
            "reasonCode": "LEASE_CAS_MISMATCH",
            "leaseId": lease_id if isinstance(lease_id, str) else None,
        }
    # A lease without a separately persisted listener identity cannot be
    # released during stale retirement.  The old process is precisely the
    # identity that is no longer trusted, so do not reconstruct it from PID.
    listener_identity = lease.get("listenerIdentity")
    if not isinstance(listener_identity, dict):
        return {
            "status": "UNVERIFIED",
            "reasonCode": "LISTENER_IDENTITY_UNVERIFIABLE",
            "leaseId": lease_id,
        }
    project_root = _project_root_for_change(change_dir)
    if project_root is None:
        return {
            "status": "UNVERIFIED",
            "reasonCode": "LEASE_CAS_MISMATCH",
            "leaseId": lease_id,
        }
    try:
        import harness_change

        release = harness_change.release_port(
            project_root,
            change_id=change_id,
            run_id=run_id,
            port=port,
            lease_id=lease_id,
            generation=_normalize_service_generation(lease.get("generation")),
            listener_identity=listener_identity,
        )
    except (ImportError, OSError, TypeError, ValueError) as exc:
        return {
            "status": "UNVERIFIED",
            "reasonCode": "LEASE_CAS_MISMATCH",
            "leaseId": lease_id,
        }
    if release.get("ok"):
        return {
            "status": "RELEASED",
            "reasonCode": "SERVICE_RETIRED",
            "leaseId": lease_id,
        }
    code = str(release.get("code") or "")
    reason = (
        "LISTENER_IDENTITY_UNVERIFIABLE"
        if "LISTENER" in code or code == "IDENTITY_UNVERIFIABLE"
        else "LEASE_CAS_MISMATCH"
    )
    return {
        "status": "RETAINED" if reason.startswith("LISTENER") else "UNVERIFIED",
        "reasonCode": reason,
        "leaseId": lease_id,
    }


def _retire_stale_session_impl(
    change_dir: Path,
    *,
    operation_id: str,
) -> dict[str, Any]:
    """Finalize one stale generation without touching an unknown process."""
    change_dir = resolve_path(change_dir)
    try:
        session = load_session(change_dir)
    except SessionCorrupt as exc:
        return {
            "ok": False,
            "code": "SERVICE_SESSION_CORRUPT",
            "action": "retire-refused",
            "error": str(exc),
            "unknownProcessUntouched": True,
        }
    if session is None:
        retired_root = change_dir / "runtime" / "retired-service-sessions"
        for receipt_path in sorted(retired_root.glob("*.receipt.json")):
            try:
                existing_receipt = read_json(receipt_path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(existing_receipt, dict) and (
                existing_receipt.get("state") == "FINALIZED"
                or existing_receipt.get("action") == "retired-stale"
            ):
                evidence = retired_root / f"{receipt_path.name[:-len('.receipt.json')]}.json"
                return {
                    "ok": True,
                    "code": "SERVICE_RETIRED",
                    "action": "already-retired",
                    "receipt": existing_receipt,
                    "retiredEvidence": str(evidence) if evidence.is_file() else None,
                    "unknownProcessUntouched": True,
                }
        return {
            "ok": True,
            "code": "SERVICE_SESSION_ABSENT",
            "action": "already-retired",
            "unknownProcessUntouched": True,
        }
    identity = verify_process_identity(session)
    if identity is True:
        return {
            "ok": False,
            "code": "SERVICE_PROCESS_STILL_OWNED",
            "action": "retire-refused",
            "unknownProcessUntouched": True,
        }
    if identity is None:
        return {
            "ok": False,
            "code": "SERVICE_PROCESS_IDENTITY_UNVERIFIED",
            "action": "retire-refused",
            "unknownProcessUntouched": True,
        }
    service_id = str(session.get("serviceId") or change_dir.name)
    old_session_id = str(
        session.get("sessionId")
        or "legacy-" + sha256_text(json.dumps(session, sort_keys=True))[7:23]
    )
    old_generation = _normalize_service_generation(session.get("serviceGeneration"))
    retired_root = change_dir / "runtime" / "retired-service-sessions"
    retired_root.mkdir(parents=True, exist_ok=True)
    safe_service = re.sub(r"[^A-Za-z0-9._-]+", "-", service_id).strip("-") or "service"
    receipt_path = retired_root / f"{safe_service}-{old_generation}.receipt.json"
    if receipt_path.is_file():
        try:
            existing_receipt = read_json(receipt_path)
        except (OSError, ValueError, json.JSONDecodeError):
            existing_receipt = None
        if (
            isinstance(existing_receipt, dict)
            and existing_receipt.get("serviceId") == service_id
            and _normalize_service_generation(existing_receipt.get("oldGeneration"))
            == old_generation
        ):
            evidence = existing_receipt.get("retiredEvidence")
            return {
                "ok": True,
                "code": "SERVICE_RETIRED",
                "action": "already-retired",
                "receipt": existing_receipt,
                "retiredEvidence": evidence,
                "unknownProcessUntouched": True,
            }
    pending_path = change_dir / "runtime" / "retirement.pending.json"
    write_json(
        pending_path,
        {
            "schemaVersion": 1,
            "serviceId": service_id,
            "oldSessionId": old_session_id,
            "oldGeneration": old_generation,
            "operationId": operation_id,
            "state": "PENDING",
        },
    )
    lease_cleanup = _retirement_lease_cleanup(change_dir, session)
    retired_session = json.loads(json.dumps(session, ensure_ascii=False))
    _ensure_session_state(retired_session, operation_id=operation_id, generation=old_generation)
    if retired_session.get("status") not in {"STALE_IDENTITY_MISMATCH", "RETIRED"}:
        _transition(
            retired_session,
            "STALE_IDENTITY_MISMATCH",
            reason_code="SERVICE_IDENTITY_STALE",
            operation_id=operation_id,
        )
    if retired_session.get("status") != "RETIRED":
        _transition(
            retired_session,
            "RETIRED",
            reason_code="SERVICE_RETIRED",
            operation_id=operation_id,
        )
    retired_session["cleanupComplete"] = lease_cleanup["status"] == "RELEASED"
    retired_session["supersedesSessionId"] = None
    source = session_path(change_dir)
    destination = retired_root / f"{safe_service}-{old_generation}.json"
    quarantined = False
    if source.is_file():
        try:
            import harness_runtime as _runtime

            sensitive = [
                item
                for item in _runtime.sensitive_evidence_candidates(source.parent)
                if item.get("path") == source.name
            ]
            if sensitive:
                quarantine = _runtime.quarantine_sensitive_evidence(
                    source,
                    change_root=change_dir,
                    reason="service retirement legacy evidence",
                )
                if not quarantine.get("ok"):
                    return {
                        "ok": False,
                        "code": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
                        "action": "retire-refused",
                        "quarantine": quarantine,
                        "unknownProcessUntouched": True,
                    }
                quarantined = True
        except (ImportError, OSError, ValueError, TypeError) as exc:
            return {
                "ok": False,
                "code": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
                "action": "retire-refused",
                "error": str(exc),
                "unknownProcessUntouched": True,
            }
    if source.is_file():
        os.replace(source, destination)
        # Replace the moved legacy payload with the sanitized, typed retired
        # state only after the atomic move has succeeded.
        write_json(destination, retired_session)
    elif not destination.is_file() and not quarantined:
        return {
            "ok": False,
            "code": "SERVICE_SESSION_ABSENT",
            "action": "retire-refused",
            "unknownProcessUntouched": True,
        }
    receipt = {
        "schemaVersion": 1,
        "receiptId": f"retirement-{safe_service}-{old_generation}",
        "operationId": operation_id,
        "serviceId": service_id,
        "oldSessionId": old_session_id,
        "oldGeneration": old_generation,
        "state": "FINALIZED",
        "retirementStateCommit": {
            "status": "COMMITTED",
            "reasonCode": "SERVICE_RETIRED",
        },
        "leaseCleanup": lease_cleanup,
        "cleanupComplete": lease_cleanup["status"] == "RELEASED",
        "awaitingSuperseder": True,
        "supersededBySessionId": None,
    }
    receipt["receiptDigest"] = _retirement_receipt_digest(receipt)
    # Keep the evidence path in the response/pending journal, not in the
    # strict receipt contract; the destination is derived from the receipt.
    write_json(receipt_path, receipt)
    pending_path.unlink(missing_ok=True)
    return {
        "ok": True,
        "code": "SERVICE_RETIRED",
        "action": "retired-stale",
        "receipt": receipt,
        "retiredEvidence": str(destination),
        "unknownProcessUntouched": True,
    }


def cmd_retire_stale(args: argparse.Namespace) -> int:
    result = retire_stale_session(resolve_path(args.change_dir))
    emit_json(result, as_json=bool(args.json))
    return 0 if result.get("ok") else 1


def _link_superseder_unlocked(
    change_dir: Path,
    *,
    retirement_receipt: Path,
    new_session: dict[str, Any],
    operation_id: str | None = None,
) -> dict[str, Any]:
    """CAS-link one future service generation to a finalized retirement."""

    change_dir = resolve_path(change_dir)
    receipt_path = resolve_path(retirement_receipt)
    try:
        receipt = read_json(receipt_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "RETIREMENT_RECEIPT_INVALID", "error": str(exc)}
    if not isinstance(receipt, dict):
        return {"ok": False, "code": "RETIREMENT_RECEIPT_INVALID"}
    raw_old_generation = receipt.get("oldGeneration")
    raw_new_generation = new_session.get("serviceGeneration")
    if raw_old_generation is None or raw_new_generation is None:
        return {"ok": False, "code": "SUPERSEDER_GENERATION_INVALID"}
    old_generation = _normalize_service_generation(raw_old_generation)
    new_generation = _normalize_service_generation(raw_new_generation)
    if old_generation == new_generation:
        return {"ok": False, "code": "SUPERSEDER_GENERATION_INVALID"}
    receipt["schemaVersion"] = 1
    receipt["oldGeneration"] = old_generation
    receipt.setdefault("receiptId", f"retirement-{change_dir.name}-{old_generation}")
    receipt.setdefault("operationId", operation_id or uuid.uuid4().hex)
    receipt.setdefault("serviceId", str(receipt.get("serviceId") or change_dir.name))
    receipt.setdefault("oldSessionId", str(receipt.get("sessionId") or "legacy-" + change_dir.name))
    receipt.setdefault("state", "FINALIZED")
    receipt.setdefault(
        "retirementStateCommit",
        {"status": "COMMITTED", "reasonCode": "SERVICE_RETIRED"},
    )
    receipt.setdefault(
        "leaseCleanup",
        {
            "status": "RETAINED",
            "reasonCode": "LISTENER_IDENTITY_UNVERIFIABLE",
            "leaseId": None,
        },
    )
    receipt["cleanupComplete"] = receipt["leaseCleanup"].get("status") == "RELEASED"
    receipt.setdefault("supersededBySessionId", None)
    legacy_superseder = receipt.pop("superseder", None)
    if receipt.get("supersededBySessionId") is None and isinstance(legacy_superseder, dict):
        legacy_id = legacy_superseder.get("sessionId")
        if isinstance(legacy_id, str) and legacy_id:
            receipt["supersededBySessionId"] = legacy_id
    existing_id = receipt.get("supersededBySessionId")
    if isinstance(existing_id, str) and existing_id:
        if existing_id == new_session.get("sessionId"):
            return {
                "ok": True,
                "code": "SUPERSEDER_ALREADY_LINKED",
                "receipt": receipt,
            }
        return {
            "ok": False,
            "code": "SUPERSEDER_LINK_CONFLICT",
            "receipt": receipt,
        }
    if receipt.get("awaitingSuperseder") is False:
        return {
            "ok": False,
            "code": "SUPERSEDER_LINK_CONFLICT",
            "receipt": receipt,
        }
    operation_id = operation_id or uuid.uuid4().hex
    new_session["schemaVersion"] = 1
    new_session.setdefault("serviceId", receipt["serviceId"])
    new_session.setdefault("sessionId", "service-" + uuid.uuid4().hex)
    new_session.setdefault("status", "STARTING")
    new_session.setdefault("reasonCode", "SERVICE_START_REQUESTED")
    new_session.setdefault("stateRevision", 1)
    new_session.setdefault("operationId", operation_id)
    new_session.setdefault("fingerprint", sha256_text(""))
    new_session.setdefault("processIdentity", None)
    new_session.setdefault("heartbeat", None)
    new_session.setdefault("leaseIdentity", None)
    new_session.setdefault("transitionHistory", [])
    new_session.setdefault("cleanupComplete", False)
    new_session["serviceGeneration"] = new_generation
    new_session["supersedesSessionId"] = receipt["oldSessionId"]
    retirement_commit = receipt.get("retirementStateCommit")
    if not isinstance(retirement_commit, dict):
        retirement_commit = {}
    lease_cleanup = receipt.get("leaseCleanup")
    if not isinstance(lease_cleanup, dict):
        lease_cleanup = {}
    commit_status = str(retirement_commit.get("status") or "COMMITTED")
    if commit_status not in {"PENDING", "COMMITTED", "CONFLICT"}:
        commit_status = "COMMITTED"
    lease_status = str(lease_cleanup.get("status") or "RETAINED")
    if lease_status not in {"PENDING", "RELEASED", "RETAINED", "UNVERIFIED"}:
        lease_status = "UNVERIFIED"
    canonical_receipt = {
        "schemaVersion": 1,
        "receiptId": str(receipt["receiptId"]),
        "operationId": operation_id,
        "serviceId": str(receipt["serviceId"]),
        "oldSessionId": str(receipt["oldSessionId"]),
        "oldGeneration": old_generation,
        "state": "FINALIZED",
        "retirementStateCommit": {
            "status": commit_status,
            "reasonCode": _canonical_service_reason(
                str(retirement_commit.get("reasonCode") or "SERVICE_RETIRED")
            ),
        },
        "leaseCleanup": {
            "status": lease_status,
            "reasonCode": _canonical_service_reason(
                str(lease_cleanup.get("reasonCode") or "LISTENER_IDENTITY_UNVERIFIABLE")
            ),
            "leaseId": lease_cleanup.get("leaseId")
            if isinstance(lease_cleanup.get("leaseId"), str)
            else None,
        },
        "cleanupComplete": lease_status == "RELEASED",
        "awaitingSuperseder": False,
        "supersededBySessionId": new_session.get("sessionId"),
    }
    receipt = canonical_receipt
    receipt["receiptDigest"] = _retirement_receipt_digest(receipt)
    write_json(receipt_path, receipt)
    write_session(change_dir, new_session)
    return {
        "ok": True,
        "code": "SUPERSEDER_LINKED",
        "receipt": receipt,
        "session": new_session,
    }


def link_superseder(
    change_dir: Path,
    *,
    retirement_receipt: Path,
    new_session: dict[str, Any],
    operation_id: str | None = None,
) -> dict[str, Any]:
    """CAS-link one superseder while serializing writers for this service."""

    change_dir = resolve_path(change_dir)
    lock = ServiceMutationLock(change_dir, operation="link-superseder")
    conflict = lock.acquire()
    if conflict is not None:
        return conflict
    try:
        return _link_superseder_unlocked(
            change_dir,
            retirement_receipt=retirement_receipt,
            new_session=new_session,
            operation_id=operation_id or lock.token,
        )
    finally:
        lock.release()


def cmd_link_superseder(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    try:
        new_session = load_session(change_dir)
    except SessionCorrupt as exc:
        return emit_error(str(exc), as_json=bool(args.json))
    if new_session is None:
        return emit_error(
            "new service session is missing",
            as_json=bool(args.json),
            code=4,
        )
    result = link_superseder(
        change_dir,
        retirement_receipt=resolve_path(args.retirement_receipt),
        new_session=new_session,
    )
    emit_json(result, as_json=bool(args.json))
    return 0 if result.get("ok") else 4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness_service.py",
        description="Manage AI service-session lifecycle (ensure/status/stop)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON on stdout",
    )
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_ensure = sub.add_parser("ensure", help="reuse / restart / start service")
    p_ensure.add_argument("--change-dir", required=True)
    p_ensure.add_argument("--project", required=True)
    p_ensure.add_argument(
        "--files",
        default=None,
        help="comma-separated service module source files for inputsHash",
    )
    p_ensure.add_argument(
        "--change-name",
        default=None,
        help="change-name for runtime profile resolve (default: change-dir name)",
    )
    p_ensure.add_argument(
        "--overlay",
        default=None,
        help="runtime overlay path injected into resolved serviceStart",
    )
    p_ensure.add_argument(
        "--leased-port",
        type=int,
        default=None,
        help="port allocated by harness_change.py lease-port",
    )
    p_ensure.add_argument(
        "--lease-owner",
        default=None,
        help="run id that owns --leased-port",
    )
    p_ensure.add_argument(
        "--worktree-root",
        default=None,
        help="worktree that owns the service (default: --project)",
    )
    p_ensure.add_argument(
        "--execution-root",
        default=None,
        help="ephemeral execution worktree that owns the service",
    )
    p_ensure.add_argument(
        "--attempt-id",
        default=None,
        help="phase or transaction attempt that started the service",
    )
    p_ensure.add_argument("--json", action="store_true")
    p_ensure.set_defaults(func=cmd_ensure)

    p_status = sub.add_parser("status", help="show session + liveness + fingerprint")
    p_status.add_argument("--change-dir", required=True)
    p_status.add_argument(
        "--files",
        default=None,
        help="optional files for current fingerprint comparison",
    )
    p_status.add_argument("--json", action="store_true")
    p_status.set_defaults(func=cmd_status)

    p_stop = sub.add_parser("stop", help="stop service and clear session")
    p_stop.add_argument("--change-dir", required=True)
    p_stop.add_argument(
        "--if-started-by-ai",
        action="store_true",
        help="only stop when session.startedBy == AI (archive cleanup)",
    )
    p_stop.add_argument("--json", action="store_true")
    p_stop.set_defaults(func=cmd_stop)

    p_retire = sub.add_parser(
        "retire-stale",
        help="retire stale Harness state without terminating unknown processes",
    )
    p_retire.add_argument("--change-dir", required=True)
    p_retire.add_argument("--json", action="store_true")
    p_retire.set_defaults(func=cmd_retire_stale)

    p_link = sub.add_parser(
        "link-superseder",
        help="CAS-link a new service generation to a retirement receipt",
    )
    p_link.add_argument("--change-dir", required=True)
    p_link.add_argument("--retirement-receipt", required=True)
    p_link.add_argument("--json", action="store_true")
    p_link.set_defaults(func=cmd_link_superseder)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # Allow top-level --json as well as subcommand --json
    if getattr(args, "json", False) is False and "--json" in (argv or sys.argv[1:]):
        args.json = True
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
