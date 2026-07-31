#!/usr/bin/env python3
"""Resource-safe test command runner for Hunter Harness workflows.

The runner keeps test commands sequential, lowers their scheduling priority,
enforces a single active run per project, and tears down the managed process
tree after every command. Resource-intensive profiles require an explicit
confirmation outside CI.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import harness_environment as henv

DEFAULT_MAX_WORKERS = 2
DEFAULT_TIMEOUT_SECONDS = 300.0
RESOURCE_INTENSIVE_PROFILES = frozenset({"system", "full"})
DEFAULT_RESOURCE_MODULES = (
    "test_harness_integration.py",
    "test_harness_service.py",
)
DEFAULT_DETACHED_SERVICE_MODULES = (
    "test_harness_service.py",
    "test_harness_runtime.py",
)
TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})


@dataclass(frozen=True)
class TestModule:
    """One isolated unittest module."""

    name: str
    path: Path


@dataclass(frozen=True)
class CommandResult:
    """Result of one managed command."""

    returncode: int
    timed_out: bool
    duration_seconds: float
    process_tree_isolated: bool
    output_tail: str = ""


class TestRunAlreadyActive(RuntimeError):
    """Raised when another resource-safe runner owns the project lock."""


def _truthy(value: object) -> bool:
    return str(value or "").strip().lower() in TRUTHY_VALUES


def bounded_worker_count(
    requested: int,
    environ: Mapping[str, str] | None = None,
) -> int:
    """Return a positive worker count that never exceeds the global safe cap."""

    env = os.environ if environ is None else environ
    raw_limit = env.get("HARNESS_TEST_MAX_WORKERS", str(DEFAULT_MAX_WORKERS))
    try:
        configured = int(raw_limit)
    except (TypeError, ValueError):
        configured = DEFAULT_MAX_WORKERS
    configured = max(1, min(DEFAULT_MAX_WORKERS, configured))
    return max(1, min(int(requested), configured))


def resource_profile_allowed(
    profile: str,
    confirmed: bool,
    environ: Mapping[str, str] | None = None,
) -> bool:
    """Return whether a profile may execute in the current environment."""

    if profile not in RESOURCE_INTENSIVE_PROFILES:
        return True
    env = os.environ if environ is None else environ
    return bool(
        confirmed
        or _truthy(env.get("CI"))
        or _truthy(env.get("HARNESS_ALLOW_RESOURCE_INTENSIVE_TESTS"))
    )


def discover_test_modules(tests_dir: Path) -> list[TestModule]:
    """Discover deterministic top-level unittest modules."""

    root = Path(tests_dir).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"test directory does not exist: {root}")
    return [
        TestModule(path.name, path)
        for path in sorted(root.glob("test_*.py"), key=lambda item: item.name)
        if path.is_file()
    ]


def build_unittest_plan(
    tests_dir: Path,
    profile: str,
    *,
    resource_modules: Sequence[str] = DEFAULT_RESOURCE_MODULES,
) -> list[TestModule]:
    """Partition unittest modules into safe, system, or full execution plans."""

    if profile not in {"safe", "system", "full"}:
        raise ValueError(f"unsupported test profile: {profile}")
    modules = discover_test_modules(tests_dir)
    resource_names = {Path(item).name for item in resource_modules}
    regular = [item for item in modules if item.name not in resource_names]
    intensive = [item for item in modules if item.name in resource_names]
    if profile == "safe":
        return regular
    if profile == "system":
        return intensive
    return [*regular, *intensive]


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        process_query_limited_information = 0x1000
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = ctypes.c_void_p
        handle = kernel32.OpenProcess(
            process_query_limited_information,
            False,
            pid,
        )
        if not handle:
            return False
        try:
            exit_code = ctypes.c_uint32()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return int(exit_code.value) == 259
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def classify_test_lock(path: Path) -> dict[str, object]:
    """Classify one lock without mutating it or terminating a process."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"classification": "ABSENT", "path": str(path)}
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "classification": "LOCK_UNREADABLE",
            "path": str(path),
            "message": str(exc),
        }
    if not isinstance(payload, dict):
        return {"classification": "LOCK_UNREADABLE", "path": str(path)}
    owner = payload.get("owner")
    expires = payload.get("expiresAtUnix")
    if not isinstance(expires, (int, float)) or isinstance(expires, bool):
        return {
            "classification": "OWNER_IDENTITY_INCOMPLETE",
            "path": str(path),
            "token": payload.get("token"),
        }
    unexpired = time.time() < float(expires)
    if not isinstance(owner, dict) or any(
        not owner.get(field) for field in ("pid", "executable", "startedAt")
    ):
        if unexpired:
            return {
                "classification": "ACTIVE",
                "path": str(path),
                "token": payload.get("token"),
                "owner": owner,
            }
        return {
            "classification": "OWNER_IDENTITY_INCOMPLETE",
            "path": str(path),
            "token": payload.get("token"),
        }
    try:
        owner_pid = int(owner["pid"])
    except (TypeError, ValueError):
        if unexpired:
            return {
                "classification": "ACTIVE",
                "path": str(path),
                "token": payload.get("token"),
                "owner": owner,
            }
        return {
            "classification": "OWNER_IDENTITY_INCOMPLETE",
            "path": str(path),
            "token": payload.get("token"),
        }
    if not _pid_is_running(owner_pid):
        return {
            "classification": "RECLAIMABLE",
            "path": str(path),
            "token": payload.get("token"),
            "owner": owner,
        }
    if unexpired:
        return {
            "classification": "ACTIVE",
            "path": str(path),
            "token": payload.get("token"),
            "owner": owner,
        }
    verified = henv.hservice.verify_process_identity(
        {
            "pid": owner_pid,
            "startedAt": owner["startedAt"],
            "processIdentity": {"executable": owner["executable"]},
        }
    )
    classification = (
        "OWNER_ACTIVE"
        if verified is True
        else (
            "OWNER_IDENTITY_UNCONFIRMED"
            if verified is None
            else "OWNER_IDENTITY_MISMATCH"
        )
    )
    return {
        "classification": classification,
        "path": str(path),
        "token": payload.get("token"),
        "owner": owner,
    }


def reap_test_lock(path: Path) -> dict[str, object]:
    """Reap only a lock whose exact recorded owner is definitely absent."""
    classification = classify_test_lock(path)
    reaped = classification.get("classification") == "RECLAIMABLE"
    if reaped:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        receipt = {
            "schemaVersion": 1,
            "action": "test-run-lock-reap",
            "status": "REAPED",
            "completedAtUnix": time.time(),
            "lockPath": str(path),
            "prior": classification,
        }
        receipt_dir = path.parent / "receipts"
        receipt_dir.mkdir(parents=True, exist_ok=True)
        target = receipt_dir / f"{path.stem}-reap-{uuid.uuid4().hex}.json"
        target.write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    return {
        "ok": True,
        "code": "TEST_RUN_LOCK_REAPED" if reaped else "TEST_RUN_LOCK_REPORT_ONLY",
        "reaped": reaped,
        "lock": classification,
    }


class TestRunLock:
    """Atomic per-project single-instance lock with stale-owner recovery."""

    def __init__(self, project: Path, *, lock_root: Path | None = None) -> None:
        resolved = str(Path(project).resolve())
        if os.name == "nt":
            resolved = resolved.casefold()
        digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:24]
        root = (
            Path(lock_root)
            if lock_root is not None
            else Path(
                os.environ.get(
                    "HARNESS_TEST_LOCK_ROOT",
                    str(Path(tempfile.gettempdir()) / "hunter-harness-test-locks"),
                )
            )
        )
        self.path = root / f"{digest}.lock"
        self.token = uuid.uuid4().hex
        self._owned = False
        self._ttl_seconds = 3600.0

    def _owner(self) -> dict[str, object]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(2):
            try:
                descriptor = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
            except FileExistsError:
                classification = classify_test_lock(self.path)
                if classification.get("classification") != "RECLAIMABLE":
                    raise TestRunAlreadyActive(
                        "TEST_RUN_ALREADY_ACTIVE: "
                        f"lock={self.path} "
                        f"classification={classification.get('classification')}"
                    )
                reap_test_lock(self.path)
                if attempt == 0:
                    continue
                raise TestRunAlreadyActive(
                    f"TEST_RUN_ALREADY_ACTIVE: could not reclaim {self.path}"
                )
            else:
                now = time.time()
                created = henv.hservice.get_process_create_time(os.getpid())
                executable = (
                    henv.hservice.get_process_executable(os.getpid())
                    or str(Path(sys.executable).resolve())
                )
                payload = {
                    "schemaVersion": 2,
                    "token": self.token,
                    "status": "ACTIVE",
                    "createdAtUnix": now,
                    "heartbeatAtUnix": now,
                    "expiresAtUnix": now + self._ttl_seconds,
                    "owner": {
                        "pid": os.getpid(),
                        "executable": executable,
                        "startedAt": (
                            created.isoformat(timespec="seconds")
                            if created is not None
                            else ""
                        ),
                    },
                }
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    json.dump(payload, stream, ensure_ascii=False)
                    stream.flush()
                self._owned = True
                return
        raise TestRunAlreadyActive(f"TEST_RUN_ALREADY_ACTIVE: {self.path}")

    def heartbeat(self) -> None:
        if not self._owned:
            return
        owner = self._owner()
        if owner.get("token") != self.token:
            raise TestRunAlreadyActive(
                f"TEST_RUN_LOCK_OWNERSHIP_LOST: lock={self.path}"
            )
        now = time.time()
        owner["heartbeatAtUnix"] = now
        owner["expiresAtUnix"] = now + self._ttl_seconds
        with self.path.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(owner, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())

    def _write_closeout_receipt(self, *, status: str) -> None:
        receipt = {
            "schemaVersion": 1,
            "action": "test-run-lock-closeout",
            "status": status,
            "token": self.token,
            "lockPath": str(self.path),
            "closedAtUnix": time.time(),
            "ownerPid": os.getpid(),
        }
        receipt_dir = self.path.parent / "receipts"
        receipt_dir.mkdir(parents=True, exist_ok=True)
        target = receipt_dir / f"{self.path.stem}-{self.token}.json"
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        os.replace(temporary, target)

    def release(self, *, status: str = "COMPLETED") -> None:
        if not self._owned:
            return
        owner = self._owner()
        if owner.get("token") == self.token:
            self._write_closeout_receipt(status=status)
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
        self._owned = False

    def __enter__(self) -> "TestRunLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.release(status="ABNORMAL" if exc_type is not None else "COMPLETED")


def lower_process_priority() -> bool:
    """Best-effort scheduling priority reduction inherited by child processes."""

    try:
        if os.name == "nt":
            below_normal_priority_class = 0x00004000
            kernel32 = ctypes.windll.kernel32
            return bool(
                kernel32.SetPriorityClass(
                    kernel32.GetCurrentProcess(),
                    below_normal_priority_class,
                )
            )
        os.nice(5)
        return True
    except (AttributeError, OSError):
        return False


class _WindowsIoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _WindowsBasicLimitInformation(ctypes.Structure):
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


class _WindowsExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _WindowsBasicLimitInformation),
        ("IoInfo", _WindowsIoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _WindowsBasicAccountingInformation(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_int64),
        ("TotalKernelTime", ctypes.c_int64),
        ("ThisPeriodTotalUserTime", ctypes.c_int64),
        ("ThisPeriodTotalKernelTime", ctypes.c_int64),
        ("TotalPageFaultCount", ctypes.c_uint32),
        ("TotalProcesses", ctypes.c_uint32),
        ("ActiveProcesses", ctypes.c_uint32),
        ("TotalTerminatedProcesses", ctypes.c_uint32),
    ]


class _WindowsKillOnCloseJob:
    """Best-effort Windows Job Object that kills descendants when closed."""

    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
    _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1

    def __init__(self) -> None:
        self.handle: int | None = None

    def assign(self, process: subprocess.Popen[object]) -> bool:
        if os.name != "nt":
            return False
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            return False
        info = _WindowsExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = self._JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        configured = kernel32.SetInformationJobObject(
            ctypes.c_void_p(handle),
            self._JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        process_handle = getattr(process, "_handle", None)
        assigned = bool(
            configured
            and process_handle
            and kernel32.AssignProcessToJobObject(
                ctypes.c_void_p(handle),
                ctypes.c_void_p(int(process_handle)),
            )
        )
        if not assigned:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
            return False
        self.handle = int(handle)
        return True

    def close(self) -> None:
        if self.handle is None:
            return
        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
        self.handle = None

    def terminate_and_wait(self, timeout_seconds: float = 5.0) -> bool:
        if self.handle is None:
            return True
        kernel32 = ctypes.windll.kernel32
        handle = ctypes.c_void_p(self.handle)
        kernel32.TerminateJobObject(handle, 1)
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        drained = False
        while time.monotonic() < deadline:
            accounting = _WindowsBasicAccountingInformation()
            queried = kernel32.QueryInformationJobObject(
                handle,
                self._JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
                ctypes.byref(accounting),
                ctypes.sizeof(accounting),
                None,
            )
            if not queried or accounting.ActiveProcesses == 0:
                drained = True
                break
            time.sleep(0.02)
        self.close()
        return drained


class _WindowsProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_uint32),
        ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def _windows_process_parents() -> dict[int, int] | None:
    if os.name != "nt":
        return {}
    kernel32 = ctypes.windll.kernel32
    create_snapshot = kernel32.CreateToolhelp32Snapshot
    create_snapshot.restype = ctypes.c_void_p
    handle = create_snapshot(0x00000002, 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if not handle or handle == invalid_handle:
        return None
    entry = _WindowsProcessEntry()
    entry.dwSize = ctypes.sizeof(entry)
    parents: dict[int, int] = {}
    try:
        if not kernel32.Process32FirstW(ctypes.c_void_p(handle), ctypes.byref(entry)):
            return None
        while True:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            if not kernel32.Process32NextW(
                ctypes.c_void_p(handle),
                ctypes.byref(entry),
            ):
                break
        return parents
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def _update_windows_descendants(
    root_pid: int,
    known_descendants: set[int],
) -> bool:
    parents = _windows_process_parents()
    if parents is None:
        return False
    changed = True
    while changed:
        changed = False
        for pid, parent_pid in parents.items():
            if pid == root_pid or pid in known_descendants:
                continue
            if parent_pid == root_pid or parent_pid in known_descendants:
                known_descendants.add(pid)
                changed = True
    return True


def _terminate_tracked_windows_descendants(pids: set[int]) -> None:
    targeted: list[int] = []
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = ctypes.c_void_p
    for pid in sorted(pids, reverse=True):
        if not _pid_is_running(pid):
            continue
        targeted.append(pid)
        handle = kernel32.OpenProcess(0x00100001, False, pid)
        terminated = False
        if handle:
            try:
                terminated = bool(
                    kernel32.TerminateProcess(ctypes.c_void_p(handle), 1)
                )
                if terminated:
                    kernel32.WaitForSingleObject(ctypes.c_void_p(handle), 5000)
            finally:
                kernel32.CloseHandle(ctypes.c_void_p(handle))
        if not terminated:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
    deadline = time.monotonic() + 5.0
    while targeted and time.monotonic() < deadline:
        targeted = [pid for pid in targeted if _pid_is_running(pid)]
        if targeted:
            time.sleep(0.05)


def detached_process_capability(cwd: Path) -> tuple[bool, str]:
    """Probe the nested Windows breakaway pattern used by service tests."""

    if os.name != "nt":
        return True, "not-windows"
    flags = 0x00000008 | 0x00000200 | 0x08000000 | 0x01000000
    with tempfile.TemporaryDirectory(prefix="harness-detached-probe-") as raw_tmp:
        marker = Path(raw_tmp) / "nested-breakaway.ok"
        probe_source = (
            "import pathlib,subprocess,sys;"
            "flags=0x00000008|0x00000200|0x08000000|0x01000000;"
            "child=subprocess.Popen([sys.executable,'-c','pass'],"
            "creationflags=flags,stdin=subprocess.DEVNULL,"
            "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
            "code=child.wait(timeout=5);"
            "pathlib.Path(sys.argv[1]).write_text(str(code),encoding='utf-8')"
        )
        try:
            process = subprocess.Popen(
                [sys.executable, "-c", probe_source, str(marker)],
                cwd=str(Path(cwd).resolve()),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=flags,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as exc:
            return False, str(exc)
        try:
            output, _ = process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return False, "nested breakaway probe timed out"
        if process.returncode == 0 and marker.is_file():
            return True, "nested breakaway available"
        detail_lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
        detail = detail_lines[-1] if detail_lines else ""
        return False, detail[-500:] or f"probe exit={process.returncode}"


def _terminate_process_tree(
    process: subprocess.Popen[object],
    *,
    windows_job: _WindowsKillOnCloseJob | None,
) -> None:
    if windows_job is not None and windows_job.handle is not None:
        windows_job.terminate_and_wait()
    elif os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if process.poll() is None:
        process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _cleanup_descendants_after_success(
    process: subprocess.Popen[object],
    *,
    windows_job: _WindowsKillOnCloseJob | None,
) -> None:
    if windows_job is not None and windows_job.handle is not None:
        windows_job.terminate_and_wait()
        return
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def run_managed_command(
    argv: Sequence[str],
    *,
    cwd: Path,
    timeout_seconds: float,
    environ: Mapping[str, str] | None = None,
    capture_output: bool = False,
    allow_detached_processes: bool = False,
) -> CommandResult:
    """Run one command with a timeout and guaranteed process-tree cleanup."""

    if not argv:
        raise ValueError("managed command must not be empty")
    child_env = os.environ.copy()
    if environ:
        child_env.update({str(key): str(value) for key, value in environ.items()})
    child_env.setdefault("PYTHONUNBUFFERED", "1")
    lower_process_priority()

    popen_kwargs: dict[str, object] = {
        "cwd": str(Path(cwd).resolve()),
        "env": child_env,
        "shell": False,
    }
    output_stream = tempfile.TemporaryFile(mode="w+b") if capture_output else None
    if output_stream is not None:
        popen_kwargs["stdout"] = output_stream
        popen_kwargs["stderr"] = subprocess.STDOUT
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(
            subprocess,
            "CREATE_NEW_PROCESS_GROUP",
            0,
        )
    else:
        popen_kwargs["start_new_session"] = True

    started = time.monotonic()
    try:
        process = subprocess.Popen(list(argv), **popen_kwargs)
        windows_job = (
            _WindowsKillOnCloseJob()
            if os.name == "nt" and not allow_detached_processes
            else None
        )
        isolated = bool(windows_job and windows_job.assign(process))
        known_windows_descendants: set[int] = set()
        windows_snapshot_ok = True
        if os.name != "nt":
            isolated = True
        timed_out = False
        try:
            deadline = time.monotonic() + max(0.01, float(timeout_seconds))
            while True:
                if os.name == "nt":
                    windows_snapshot_ok = (
                        _update_windows_descendants(
                            process.pid,
                            known_windows_descendants,
                        )
                        and windows_snapshot_ok
                    )
                polled = process.poll()
                if polled is not None:
                    returncode = polled
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    _terminate_process_tree(process, windows_job=windows_job)
                    returncode = 124
                    break
                time.sleep(0.05)
        except KeyboardInterrupt:
            _terminate_process_tree(process, windows_job=windows_job)
            if os.name == "nt":
                _terminate_tracked_windows_descendants(known_windows_descendants)
            raise
        if not timed_out:
            _cleanup_descendants_after_success(process, windows_job=windows_job)
        if os.name == "nt":
            _update_windows_descendants(process.pid, known_windows_descendants)
            _terminate_tracked_windows_descendants(known_windows_descendants)
            isolated = (
                windows_snapshot_ok
                if allow_detached_processes
                else isolated and windows_snapshot_ok
            )
        duration = time.monotonic() - started
        output_tail = ""
        if output_stream is not None:
            output_stream.flush()
            output_stream.seek(0, os.SEEK_END)
            size = output_stream.tell()
            output_stream.seek(max(0, size - 65536))
            output_tail = output_stream.read().decode("utf-8", errors="replace")
        return CommandResult(
            returncode=returncode,
            timed_out=timed_out,
            duration_seconds=duration,
            process_tree_isolated=isolated,
            output_tail=output_tail,
        )
    finally:
        if output_stream is not None:
            output_stream.close()


def _execution_environment(profile: str, max_workers: int) -> dict[str, str]:
    return {
        "HARNESS_TEST_PROFILE": profile,
        "HARNESS_TEST_MAX_WORKERS": str(
            bounded_worker_count(max_workers, os.environ)
        ),
    }


def load_argv_envelope(path: Path) -> tuple[list[str], dict[str, str]]:
    """Load a shell-neutral UTF-8 argument file without reparsing command text."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"argument file is unreadable: {exc}") from exc
    argv = raw.get("argv") if isinstance(raw, dict) else None
    powershell = raw.get("powershell") if isinstance(raw, dict) else None
    if (
        not isinstance(raw, dict)
        or raw.get("schemaVersion") != 1
        or raw.get("transport") != "utf8-json-argument-file"
        or not isinstance(argv, list)
        or not argv
        or any(not isinstance(item, str) or "\0" in item for item in argv)
        or not isinstance(powershell, dict)
    ):
        raise ValueError(
            "argument file must declare schemaVersion=1, "
            "transport=utf8-json-argument-file, argv[], and powershell metadata"
        )
    shell = {
        field: str(powershell.get(field) or "").strip()
        for field in ("edition", "version")
    }
    if not all(shell.values()):
        raise ValueError("argument file powershell edition/version are required")
    return list(argv), shell


def _is_persistent_service_command(command: Sequence[str]) -> bool:
    """Recognize formal service-manager launches that must outlive this runner."""
    normalized = [str(item).replace("\\", "/").lower() for item in command]
    return "ensure" in normalized and any(
        item.rsplit("/", 1)[-1] == "harness_service.py" for item in normalized
    )


def _write_exec_runtime_receipt(
    path: Path,
    *,
    command: Sequence[str],
    powershell: Mapping[str, str],
    result: CommandResult,
) -> None:
    canonical_argv = json.dumps(
        list(command),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    payload = {
        "schemaVersion": 1,
        "action": "managed-exec",
        "transport": "utf8-json-argument-file",
        "completedAtEpochSeconds": int(time.time()),
        "argvHash": "sha256:" + hashlib.sha256(canonical_argv).hexdigest(),
        "argumentCount": len(command),
        "powershell": {
            "edition": str(powershell["edition"]),
            "version": str(powershell["version"]),
        },
        "returncode": result.returncode,
        "timedOut": result.timed_out,
        "processTreeIsolated": result.process_tree_isolated,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def _print_plan(profile: str, plan: Sequence[TestModule]) -> None:
    payload = {
        "profile": profile,
        "moduleCount": len(plan),
        "modules": [item.name for item in plan],
        "maxWorkers": bounded_worker_count(DEFAULT_MAX_WORKERS, os.environ),
        "processTreeCleanup": True,
        "singleInstance": True,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _run_unittest(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    tests_dir = Path(args.tests_dir)
    if not tests_dir.is_absolute():
        tests_dir = project / tests_dir
    plan = build_unittest_plan(
        tests_dir,
        args.profile,
        resource_modules=args.resource_module,
    )
    if args.dry_run:
        _print_plan(args.profile, plan)
        return 0
    if not resource_profile_allowed(
        args.profile,
        args.confirm_resource_intensive,
        os.environ,
    ):
        print(
            "RESOURCE_CONFIRMATION_REQUIRED: "
            f"profile={args.profile}; rerun with --confirm-resource-intensive",
            file=sys.stderr,
        )
        return 2
    if not plan:
        print(f"NO_TEST_MODULES: profile={args.profile} testsDir={tests_dir}", file=sys.stderr)
        return 2

    environment = _execution_environment(args.profile, args.max_workers)
    failures: list[str] = []
    failed_modules: set[str] = set()
    executed_count = 0
    started = time.monotonic()
    detached_service_modules = set(args.detached_service_module)
    detached_capability_checked = False
    try:
        with TestRunLock(project) as run_lock:
            for index, module in enumerate(plan, start=1):
                run_lock.heartbeat()
                if (
                    module.name in detached_service_modules
                    and not detached_capability_checked
                ):
                    available, detail = detached_process_capability(project)
                    detached_capability_checked = True
                    if not available:
                        print(
                            "DETACHED_PROCESS_CAPABILITY_UNAVAILABLE: "
                            f"{detail}; rerun in an environment that permits "
                            "nested Windows breakaway",
                            file=sys.stderr,
                        )
                        return 5
                print(
                    f"[harness-test] {index}/{len(plan)} {module.name} "
                    f"profile={args.profile} maxWorkers={environment['HARNESS_TEST_MAX_WORKERS']}",
                    flush=True,
                )
                command = [
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    str(tests_dir),
                    "-p",
                    module.name,
                ]
                if args.verbosity == 0:
                    command.append("-q")
                elif args.verbosity == 2:
                    command.append("-v")
                result = run_managed_command(
                    command,
                    cwd=project,
                    timeout_seconds=args.timeout_seconds,
                    environ=environment,
                    capture_output=args.verbosity == 0,
                    allow_detached_processes=module.name in detached_service_modules,
                )
                run_lock.heartbeat()
                executed_count += 1
                module_failure_count = len(failures)
                if result.timed_out:
                    failures.append(f"{module.name}:TIMEOUT")
                    failed_modules.add(module.name)
                elif result.returncode != 0:
                    failures.append(f"{module.name}:EXIT_{result.returncode}")
                    failed_modules.add(module.name)
                if not result.process_tree_isolated:
                    failures.append(f"{module.name}:PROCESS_TREE_ISOLATION_UNAVAILABLE")
                    failed_modules.add(module.name)
                module_failed = len(failures) > module_failure_count
                if module_failed and result.output_tail:
                    print(result.output_tail, file=sys.stderr, end="")
                if module_failed and not args.keep_going:
                    break
    except TestRunAlreadyActive as exc:
        print(str(exc), file=sys.stderr)
        return 3

    duration = time.monotonic() - started
    status = "PASS" if not failures else "FAIL"
    print(
        f"[harness-test] {status} profile={args.profile} "
        f"modulesPassed={executed_count - len(failed_modules)} "
        f"modulesExecuted={executed_count} modulesPlanned={len(plan)} "
        f"durationSeconds={duration:.2f}",
        flush=True,
    )
    if failures:
        print("[harness-test] failures=" + ",".join(failures), file=sys.stderr)
        return 1
    return 0


def _run_exec(args: argparse.Namespace) -> int:
    command = list(args.command)
    powershell: dict[str, str] | None = None
    if args.runtime_receipt and not args.argv_file:
        print(
            "RUNTIME_RECEIPT_REQUIRES_ARGUMENT_FILE: "
            "--runtime-receipt requires --argv-file",
            file=sys.stderr,
        )
        return 2
    if args.argv_file:
        if command:
            print(
                "ARGUMENT_TRANSPORT_CONFLICT: use either --argv-file or a command",
                file=sys.stderr,
            )
            return 2
        argv_file = Path(args.argv_file)
        project_for_path = Path(args.project).resolve()
        if not argv_file.is_absolute():
            argv_file = project_for_path / argv_file
        try:
            command, powershell = load_argv_envelope(argv_file)
        except ValueError as exc:
            print(f"ARGUMENT_FILE_INVALID: {exc}", file=sys.stderr)
            return 2
    elif command and command[0] == "--":
        command = command[1:]
    if not command:
        print(
            "managed exec requires a command after -- or --argv-file",
            file=sys.stderr,
        )
        return 2
    if _is_persistent_service_command(command):
        print(
            "PERSISTENT_SERVICE_MODE_REQUIRED: invoke harness_service.py ensure "
            "outside the bounded test runner",
            file=sys.stderr,
        )
        return 7
    if not resource_profile_allowed(
        args.profile,
        args.confirm_resource_intensive,
        os.environ,
    ):
        print(
            "RESOURCE_CONFIRMATION_REQUIRED: "
            f"profile={args.profile}; rerun with --confirm-resource-intensive",
            file=sys.stderr,
        )
        return 2
    project = Path(args.project).resolve()
    environment = _execution_environment(args.profile, args.max_workers)
    required_environment = list(args.required_environment_field or [])
    if required_environment and not args.environment_receipt:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": "VERIFICATION_ENVIRONMENT_INCOMPLETE",
                    "missing": sorted(set(required_environment)),
                    "changed": [],
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 6
    if args.environment_receipt:
        receipt_path = Path(args.environment_receipt)
        if not receipt_path.is_absolute():
            receipt_path = project / receipt_path
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            print(
                "VERIFICATION_ENVIRONMENT_INCOMPLETE: "
                f"environment receipt is unreadable: {exc}",
                file=sys.stderr,
            )
            return 6
        resolved = henv.resolve_verification_environment(
            receipt,
            required_fields=required_environment,
            source_environment=dict(os.environ),
        )
        if not resolved.get("ok"):
            print(json.dumps(resolved, ensure_ascii=False), file=sys.stderr)
            return 6
        environment.update(resolved["environment"])
    try:
        with TestRunLock(project) as run_lock:
            run_lock.heartbeat()
            if args.allow_detached_processes:
                available, detail = detached_process_capability(project)
                if not available:
                    print(
                        "DETACHED_PROCESS_CAPABILITY_UNAVAILABLE: "
                        f"{detail}; rerun in an environment that permits "
                        "nested Windows breakaway",
                        file=sys.stderr,
                    )
                    return 5
            result = run_managed_command(
                command,
                cwd=project,
                timeout_seconds=args.timeout_seconds,
                environ=environment,
                allow_detached_processes=args.allow_detached_processes,
            )
            run_lock.heartbeat()
    except TestRunAlreadyActive as exc:
        print(str(exc), file=sys.stderr)
        return 3
    if not result.process_tree_isolated:
        print("PROCESS_TREE_ISOLATION_UNAVAILABLE", file=sys.stderr)
        return 4
    if result.timed_out:
        print(
            f"TEST_COMMAND_TIMEOUT: timeoutSeconds={args.timeout_seconds}",
            file=sys.stderr,
        )
        return 124
    if args.runtime_receipt:
        assert powershell is not None
        receipt_path = Path(args.runtime_receipt)
        if not receipt_path.is_absolute():
            receipt_path = project / receipt_path
        _write_exec_runtime_receipt(
            receipt_path,
            command=command,
            powershell=powershell,
            result=result,
        )
    return result.returncode


def _run_lock_status(args: argparse.Namespace) -> int:
    lock = TestRunLock(Path(args.project).resolve())
    print(
        json.dumps(
            {
                "ok": True,
                "action": "lock-status",
                "lock": classify_test_lock(lock.path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _run_lock_reap(args: argparse.Namespace) -> int:
    lock = TestRunLock(Path(args.project).resolve())
    print(json.dumps(reap_test_lock(lock.path), ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run tests with bounded workers, locking, timeout, and cleanup."
    )
    subparsers = parser.add_subparsers(dest="command_name", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--project", default=".")
    common.add_argument(
        "--profile",
        choices=("safe", "system", "full"),
        default="safe",
    )
    common.add_argument(
        "--timeout-seconds",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
    )
    common.add_argument(
        "--max-workers",
        type=int,
        default=DEFAULT_MAX_WORKERS,
    )
    common.add_argument("--confirm-resource-intensive", action="store_true")

    unittest_parser = subparsers.add_parser(
        "unittest",
        parents=[common],
        help="Run discovered Python unittest modules in isolated processes.",
    )
    unittest_parser.add_argument(
        "--tests-dir",
        default="harness/scripts/tests",
    )
    unittest_parser.add_argument(
        "--resource-module",
        action="append",
        default=list(DEFAULT_RESOURCE_MODULES),
        help="Module reserved for system/full profiles; may be repeated.",
    )
    unittest_parser.add_argument(
        "--detached-service-module",
        action="append",
        default=list(DEFAULT_DETACHED_SERVICE_MODULES),
        help="Module that intentionally tests detached services; may be repeated.",
    )
    unittest_parser.add_argument("--keep-going", action="store_true")
    unittest_parser.add_argument("--dry-run", action="store_true")
    unittest_parser.add_argument(
        "--verbosity",
        type=int,
        choices=(0, 1, 2),
        default=1,
    )
    unittest_parser.set_defaults(handler=_run_unittest)

    exec_parser = subparsers.add_parser(
        "exec",
        parents=[common],
        help="Run one arbitrary test command under the same safety controls.",
    )
    exec_parser.add_argument("command", nargs=argparse.REMAINDER)
    exec_parser.add_argument(
        "--argv-file",
        help=(
            "Read argv from a UTF-8 JSON parameter file so PowerShell 5.1 and 7 "
            "use identical native-process argument semantics."
        ),
    )
    exec_parser.add_argument(
        "--runtime-receipt",
        help="Write a secret-free argv hash and PowerShell runtime receipt.",
    )
    exec_parser.add_argument(
        "--environment-receipt",
        help="Typed environment receipt created by harness_environment.py prepare.",
    )
    exec_parser.add_argument(
        "--required-environment-field",
        action="append",
        default=[],
        help="Dynamic environment field required by the command; may be repeated.",
    )
    exec_parser.add_argument(
        "--allow-detached-processes",
        action="store_true",
        help="Use exact Windows PID-lineage tracking instead of a Job Object.",
    )
    exec_parser.set_defaults(handler=_run_exec)

    lock_status = subparsers.add_parser(
        "lock-status",
        help="Classify the project test lock without mutating it.",
    )
    lock_status.add_argument("--project", default=".")
    lock_status.set_defaults(handler=_run_lock_status)

    lock_reap = subparsers.add_parser(
        "lock-reap",
        help="Reap only an expired lock whose exact owner is absent.",
    )
    lock_reap.add_argument("--project", default=".")
    lock_reap.set_defaults(handler=_run_lock_reap)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "timeout_seconds", DEFAULT_TIMEOUT_SECONDS) <= 0:
        parser.error("--timeout-seconds must be positive")
    if getattr(args, "max_workers", DEFAULT_MAX_WORKERS) <= 0:
        parser.error("--max-workers must be positive")
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
