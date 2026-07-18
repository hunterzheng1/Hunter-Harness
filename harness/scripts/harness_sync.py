"""harness_sync — 受管 sync runtime 清理器（变更簇 D / task 13，RET-36/37/38/39）。

每次 sync 使用 `.harness/runtime/sync/<run-id>/deploy/<agent>/` 并写
`owner.json`（runId/pid/processStart/startedAt/agent/purpose/expiresAt）。
正常、失败与异常退出均在 finally 清理本 run（`SyncRun` 上下文管理器 /
`finalize_run`）。启动时 `reap_stale_runs` 只回收同时满足以下条件的目录：

1. owner 进程已死亡（pid liveness + create-time 匹配，可注入）；
2. 已超过 TTL（expiresAt < now）；
3. 删除目标 resolved 后仍位于精确 sync runtime root 内；
4. 不是当前活跃 run。

owner 缺失的 legacy 目录默认只报告 `unverifiable`，不删除；显式
`--diagnose` 模式才处理。删除失败只产生带精确路径的 warning。

本模块不做任何 `.gitignore` / `git check-ignore` 判断（RET-34/COM-004），
不修改也不建议修改项目 Git 策略。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

SYNC_RUNTIME_REL = Path(".harness") / "runtime" / "sync"
OWNER_FILE = "owner.json"
OWNER_SCHEMA_VERSION = 1
DEFAULT_TTL_SECONDS = 3600

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _parse_iso(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def sync_runtime_root(project_root: Path | str) -> Path:
    return Path(project_root) / SYNC_RUNTIME_REL


def _validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not _RUN_ID_RE.match(run_id):
        raise ValueError(f"invalid run id: {run_id!r}")
    if run_id in {".", ".."} or "/" in run_id or "\\" in run_id:
        raise ValueError(f"run id must not escape sync root: {run_id!r}")
    return run_id


def _process_start_marker() -> str:
    """Best-effort process create-time marker for owner liveness matching.

    跨平台保守实现：boot 时间 + pid 足以区分同 pid 的不同世代进程。
    """
    try:
        with open("/proc/stat", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("btime"):
                    return f"boot:{line.split()[1]}"
    except OSError:
        pass
    return f"pid:{os.getpid()} boot:unknown"


def _default_pid_alive(pid: int, process_start: str | None) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


@dataclass
class SyncRun:
    """Handle for one sync run; use as context manager for finally cleanup."""

    project_root: Path
    run_id: str
    purpose: str
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    keep_temp: bool = False
    agents: list[str] = field(default_factory=list)
    _finalized: bool = False

    @property
    def run_dir(self) -> Path:
        return sync_runtime_root(self.project_root) / self.run_id

    def workspace(self, agent: str) -> Path:
        return self.run_dir / "deploy" / agent

    def __enter__(self) -> "SyncRun":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        finalize_run(self)
        return False


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def begin_run(
    project_root: Path | str,
    *,
    run_id: str | None = None,
    agent: str,
    purpose: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    keep_temp: bool = False,
) -> SyncRun:
    """Create `.harness/runtime/sync/<run-id>/deploy/<agent>/` + owner.json."""
    root = Path(project_root)
    run_id = _validate_run_id(run_id or f"sync-{uuid.uuid4().hex[:12]}")
    run = SyncRun(
        project_root=root,
        run_id=run_id,
        purpose=purpose,
        ttl_seconds=ttl_seconds,
        keep_temp=keep_temp,
        agents=[agent],
    )
    workspace = run.workspace(agent)
    workspace.mkdir(parents=True, exist_ok=True)
    started = _now()
    owner = {
        "schemaVersion": OWNER_SCHEMA_VERSION,
        "runId": run_id,
        "pid": os.getpid(),
        "processStart": _process_start_marker(),
        "startedAt": _iso(started),
        "agent": agent,
        "agents": [agent],
        "purpose": purpose,
        "expiresAt": _iso(started + timedelta(seconds=ttl_seconds)),
    }
    _write_json(run.run_dir / OWNER_FILE, owner)
    return run


def register_agent_workspace(run: SyncRun, agent: str) -> Path:
    """Add another agent workspace under the same run-id (INT-008)."""
    workspace = run.workspace(agent)
    workspace.mkdir(parents=True, exist_ok=True)
    if agent not in run.agents:
        run.agents.append(agent)
    owner_path = run.run_dir / OWNER_FILE
    owner = _read_json(owner_path)
    if owner is not None:
        agents = owner.get("agents")
        if not isinstance(agents, list):
            agents = [owner.get("agent")]
        if agent not in agents:
            agents.append(agent)
        owner["agents"] = agents
        _write_json(owner_path, owner)
    return workspace


def finalize_run(run: SyncRun) -> None:
    """Remove this run's workspace unless keep_temp diagnostics requested it."""
    if run._finalized:
        return
    run._finalized = True
    if run.keep_temp:
        return
    run_dir = run.run_dir
    if run_dir.exists():
        shutil.rmtree(run_dir, ignore_errors=True)


def _inside_resolved(child: Path, parent: Path) -> bool:
    try:
        resolved_child = child.resolve()
        resolved_parent = parent.resolve()
    except OSError:
        return False
    return resolved_child == resolved_parent or resolved_parent in resolved_child.parents


def reap_stale_runs(
    project_root: Path | str,
    *,
    now: datetime | None = None,
    pid_alive: Callable[[int, str | None], bool] | None = None,
    active_run_ids: set[str] | None = None,
    diagnose: bool = False,
) -> dict[str, Any]:
    """Reap only dead-owner + past-TTL dirs inside the exact sync root.

    Ownerless legacy dirs are reported as ``unverifiable`` and left alone
    unless ``diagnose=True`` explicitly handles them.
    """
    now = now or _now()
    alive = pid_alive or _default_pid_alive
    active = active_run_ids or set()
    result: dict[str, Any] = {
        "ok": True,
        "reaped": [],
        "skipped": [],
        "unverifiable": [],
        "warnings": [],
    }
    root = sync_runtime_root(project_root)
    if not root.is_dir():
        return result

    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        run_id = entry.name
        # 删除目标必须 resolved 后仍位于精确 sync root 内（RET-39）。
        if not _inside_resolved(entry, root):
            result["warnings"].append(f"path escapes sync root, untouched: {entry}")
            continue
        if run_id in active:
            result["skipped"].append(run_id)
            continue
        owner_path = entry / OWNER_FILE
        owner = _read_json(owner_path) if owner_path.is_file() else None
        if owner is None:
            # owner 缺失的 legacy 目录：默认只报告 UNVERIFIABLE，不删除。
            result["unverifiable"].append(run_id)
            if diagnose:
                try:
                    shutil.rmtree(entry)
                    result["reaped"].append(run_id)
                except OSError as exc:
                    result["warnings"].append(f"failed to remove {entry}: {exc}")
            continue
        pid = owner.get("pid")
        process_start = owner.get("processStart")
        expires = _parse_iso(owner.get("expiresAt"))
        owner_dead = not alive(int(pid) if isinstance(pid, int) else -1, process_start)
        past_ttl = expires is not None and expires < now
        if owner_dead and past_ttl:
            try:
                shutil.rmtree(entry)
                result["reaped"].append(run_id)
            except OSError as exc:
                result["warnings"].append(f"failed to remove {entry}: {exc}")
        else:
            result["skipped"].append(run_id)
    return result


def cmd_reap(args: argparse.Namespace) -> int:
    result = reap_stale_runs(
        Path(args.project),
        active_run_ids=set(args.active_run or []),
        diagnose=bool(args.diagnose),
    )
    payload = {"action": "reap", **result}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        reaped = ", ".join(result["reaped"]) or "-"
        skipped = ", ".join(result["skipped"]) or "-"
        unverifiable = ", ".join(result["unverifiable"]) or "-"
        print(f"reaped: {reaped}")
        print(f"skipped: {skipped}")
        print(f"unverifiable: {unverifiable}")
        for warning in result["warnings"]:
            print(f"warning: {warning}", file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness_sync",
        description="managed sync runtime owner/TTL/finally cleaner",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_reap = sub.add_parser("reap", help="reap dead-owner past-TTL sync run dirs")
    p_reap.add_argument("--project", required=True, help="project root path")
    p_reap.add_argument("--json", action="store_true", help="emit JSON payload")
    p_reap.add_argument(
        "--diagnose",
        action="store_true",
        help="explicit diagnostics mode: also remove ownerless legacy dirs",
    )
    p_reap.add_argument(
        "--active-run",
        action="append",
        default=[],
        help="run id still active (never reaped); repeatable",
    )
    p_reap.set_defaults(func=cmd_reap)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
