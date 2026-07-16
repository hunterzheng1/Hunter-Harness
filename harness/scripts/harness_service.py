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
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from harness_ledger import compute_inputs_hash  # noqa: E402


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


PROFILE_REL = Path(".harness") / "config" / "build-profile.json"
SESSION_REL = Path("runtime") / "service-session.json"
LOG_REL = Path("logs") / "service-start.log"

FATAL_KEYWORDS = (
    "BindException",
    "Could not resolve placeholder",
    "BeanCreationException",
    "BUILD FAILURE",
)

# Process create-time vs session.startedAt tolerance (seconds).
IDENTITY_TOLERANCE_SEC = 5.0

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
    if not isinstance(command, str) or not command.strip():
        raise ValueError(
            "build-profile.json serviceStart.command is empty; "
            "configure the service start command explicitly (will not guess)"
        )
    return svc


# Worktree/change 路径标记：持久 profile 的 serviceStart 不得含这些具体路径。
# runtime resolve 把具体 overlay/profile 注入到 session，不写回持久 profile
# （spec §3.1 持久 profile 只保存模板；§3.4 修复输入端陈旧 profile）。
STALE_WORKTREE_MARKERS: tuple[str, ...] = (
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
    for field in ("command", "overlayPath", "profile"):
        val = service_start.get(field)
        if not isinstance(val, str) or not val:
            continue
        for marker in STALE_WORKTREE_MARKERS:
            if marker in val:
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
    service_start = get_service_start(profile)  # 校验 command 非空

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
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


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
    if os.name == "nt":
        return _windows_process_create_time(pid)
    return _posix_process_create_time(pid)


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
    if not is_pid_alive(pid):
        return False

    started_at = parse_iso(session.get("startedAt"))
    if started_at is None:
        return None

    create_time = get_process_create_time(pid)
    if create_time is None:
        return None

    # Compare in UTC
    started_utc = started_at.astimezone(dt.timezone.utc)
    create_utc = create_time.astimezone(dt.timezone.utc)
    delta = abs((create_utc - started_utc).total_seconds())
    return delta <= IDENTITY_TOLERANCE_SEC


def terminate_process_tree(pid: int) -> None:
    """Stop process (and children on Windows via taskkill /T). Never raises for missing pid."""
    if not isinstance(pid, int) or pid <= 0:
        return
    if not is_pid_alive(pid):
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    # Brief wait then SIGKILL
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and is_pid_alive(pid):
        time.sleep(0.1)
    if is_pid_alive(pid):
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


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


def probe_health(service_start: dict[str, Any]) -> bool:
    """Return True if service appears healthy per serviceStart health config."""
    # Prefer explicit healthFile
    health_file = service_start.get("healthFile")
    if isinstance(health_file, str) and health_file.strip():
        return Path(health_file.strip()).is_file()

    spec = service_start.get("healthUrl")
    if not isinstance(spec, str) or not spec.strip():
        # No health probe configured → treat as healthy once process is up
        # (caller should still have started the process). For wait loop, require
        # at least that we have a running pid — handled by caller.
        return True

    spec = spec.strip()
    file_path = resolve_health_file(spec)
    if file_path is not None:
        return file_path.is_file()

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
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            return 200 <= int(getattr(resp, "status", 200)) < 300
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
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
        if probe_health(service_start):
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


# ---------------------------------------------------------------------------
# Start / stop helpers
# ---------------------------------------------------------------------------

_WIN_LAUNCHER_SOURCE = """\
#!/usr/bin/env python3
\"\"\"Harness Windows service launcher (internal).\"\"\"
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def main() -> int:
    log_path = Path(sys.argv[1])
    command_path = Path(sys.argv[2])
    pid_path = Path(sys.argv[3])
    command = command_path.read_text(encoding="utf-8").strip()
    if not command:
        raise SystemExit("empty service command")

    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_handle = log_path.open("w", encoding="utf-8", errors="replace")
    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=(
                _CREATE_NEW_PROCESS_GROUP
                | _CREATE_NO_WINDOW
                | _CREATE_BREAKAWAY_FROM_JOB
            ),
            close_fds=False,
        )
    finally:
        log_handle.close()

    pid_path.write_text(str(proc.pid), encoding="utf-8")
    # Exit immediately: the detached service (shell) continues on its own.
    # Staying alive to wait() would keep the launcher process running and
    # trigger ResourceWarning when the harness_service Popen is GC'd.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
"""


def _runtime_dir(change_dir: Path) -> Path:
    path = change_dir / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _launcher_pid_path(change_dir: Path) -> Path:
    return _runtime_dir(change_dir) / "_harness_service.launcher.pid"


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


def _start_detached_service_windows(
    command: str,
    *,
    change_dir: Path,
    cwd: Path,
    log_file: Path,
) -> int:
    runtime = _runtime_dir(change_dir)
    launcher = _write_windows_launcher(change_dir)
    command_path = runtime / "_harness_service.command.txt"
    pid_path = runtime / "_harness_service.child.pid"
    command_path.write_text(command, encoding="utf-8", newline="\n")
    if pid_path.exists():
        pid_path.unlink()

    launcher_args = [
        sys.executable,
        str(launcher),
        str(log_file),
        str(command_path),
        str(pid_path),
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
    # Reap the short-lived launcher (it exits right after recording the child
    # pid) so its Popen does not ResourceWarning at GC.
    try:
        launcher_proc.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        pass
    return _wait_for_child_pid(pid_path)


def start_detached_service(
    command: str,
    *,
    change_dir: Path,
    cwd: Path,
) -> int:
    """Start service detached from this script; log to logs/service-start.log."""
    log_file = log_path(change_dir)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    if log_file.is_file():
        log_file.unlink()

    if os.name == "nt":
        return _start_detached_service_windows(
            command,
            change_dir=change_dir,
            cwd=cwd,
            log_file=log_file,
        )

    log_handle = log_file.open("w", encoding="utf-8", errors="replace")
    popen_kwargs: dict[str, Any] = {
        "args": command,
        "shell": True,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "cwd": str(cwd),
        "stdin": subprocess.DEVNULL,
        "start_new_session": True,
        "close_fds": True,
    }
    try:
        proc = subprocess.Popen(**popen_kwargs)
    finally:
        try:
            log_handle.close()
        except OSError:
            pass

    return int(proc.pid)


def build_session(
    *,
    pid: int,
    module_inputs_hash: str,
    module_inputs_files: list[str],
    command: str,
    service_start: dict[str, Any],
    started_at: str | None = None,
) -> dict[str, Any]:
    profile_name = service_start.get("profile") or "local-dev"
    overlay = service_start.get("overlayPath") or ""
    session = {
        "pid": pid,
        "startedBy": "AI",
        "moduleInputsHash": module_inputs_hash,
        "moduleInputsFiles": module_inputs_files,
        "profile": profile_name,
        "startCommandHash": sha256_text(command),
        "overlayPath": overlay,
        "startedAt": started_at or now_iso(),
        "command": command,
    }
    if isinstance(service_start.get("leasedPort"), int):
        session["leasedPort"] = service_start["leasedPort"]
        session["leaseOwner"] = service_start.get("leaseOwner")
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


def stop_ai_session(
    change_dir: Path,
    session: dict[str, Any],
    *,
    require_identity: bool = True,
) -> dict[str, Any]:
    """Stop verified AI session process and clear session file."""
    pid = session.get("pid")
    if require_identity:
        identity = verify_process_identity(session)
        if identity is not True:
            return {
                "ok": True,
                "action": "needs-user-decision",
                "reason": (
                    "cannot-verify-process-identity"
                    if identity is None
                    else "process-identity-mismatch"
                ),
                "pid": pid,
                "killed": False,
            }
    if isinstance(pid, int) and is_pid_alive(pid):
        terminate_process_tree(pid)
    _cleanup_windows_launcher(change_dir)
    clear_session(change_dir)
    return {
        "ok": True,
        "action": "stopped",
        "pid": pid,
        "killed": True,
        "sessionCleared": True,
    }


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_ensure(args: argparse.Namespace) -> int:
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

    command = str(service_start["command"]).strip()
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
            current_cmd_hash = sha256_text(command)
            current_profile = service_start.get("profile") or "local-dev"
            current_overlay = service_start.get("overlayPath") or ""
            fingerprint_match = (
                stored_hash == current_hash
                and session.get("startCommandHash") == current_cmd_hash
                and session.get("profile") == current_profile
                and session.get("overlayPath") == current_overlay
                and session.get("leasedPort") == service_start.get("leasedPort")
                and session.get("leaseOwner") == service_start.get("leaseOwner")
            )
            if fingerprint_match:
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

            return _start_and_record(
                change_dir=change_dir,
                project=project,
                service_start=service_start,
                command=command,
                files=files if files else current_files,
                as_json=as_json,
                action="restarted",
                previousPid=pid,
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
        files=files,
        as_json=as_json,
        action="started",
    )


def _start_and_record(
    *,
    change_dir: Path,
    project: Path,
    service_start: dict[str, Any],
    command: str,
    files: list[str],
    as_json: bool,
    action: str,
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
    try:
        pid = start_detached_service(command, change_dir=change_dir, cwd=project)
    except (OSError, TimeoutError) as exc:
        _cleanup_windows_launcher(change_dir)
        return emit_error(f"failed to start service: {exc}", as_json=as_json)

    # Give the OS a moment to register the process before identity/create-time reads
    time.sleep(0.15)

    try:
        wait_for_healthy(service_start, log_path(change_dir), pid=pid)
    except ServiceStartError as exc:
        # Best-effort cleanup of the failed start
        if is_pid_alive(pid):
            terminate_process_tree(pid)
        _cleanup_windows_launcher(change_dir)
        clear_session(change_dir)
        return emit_error(
            str(exc),
            as_json=as_json,
            action="start-failed",
            pid=pid,
            fatalKeyword=exc.fatal_keyword,
        )

    session = build_session(
        pid=pid,
        module_inputs_hash=module_hash,
        module_inputs_files=module_files,
        command=command,
        service_start=service_start,
        started_at=started_at,
    )
    write_session(change_dir, session)

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
        "fingerprintMatch": fingerprint_match,
        "currentModuleInputsHash": current_hash,
        "startedBy": session.get("startedBy"),
    }
    emit_json(payload, as_json=as_json)
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
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
    return 0


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
