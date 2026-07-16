#!/usr/bin/env python3
"""Harness change resolution, leases, ports, and integration lock.

Subcommands:
  list              — list active changes
  resolve           — resolve explicit or sole active change-id
  migrate           — backfill change metadata without touching business files
  claim / release   — per-change phase lease
  lease-port        — assign an unused port from a configured range
  integration-lock  — acquire|release global main-branch integration lock

When run from a git worktree, state is resolved via git common dir to the main
project root (.harness/changes lives there). Python 3.10+, stdlib only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


RUNTIME_REL = Path(".harness") / "runtime"
LEASES_REL = RUNTIME_REL / "leases"
PORTS_REL = RUNTIME_REL / "ports"
INTEGRATION_LOCK_REL = RUNTIME_REL / "integration-lock.json"
CHANGE_CONTEXT_REL = Path("meta") / "change-context.json"
WORKTREE_META_REL = Path("meta") / "worktree.json"
CHECKPOINTS_REL = Path("meta") / "implementation-checkpoints.json"


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def emit(payload: dict[str, Any], *, as_json: bool) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    sys.stdout.write(text if as_json else _human_line(payload))


def _human_line(payload: dict[str, Any]) -> str:
    if payload.get("ok"):
        code = payload.get("code", "OK")
        change = payload.get("changeId") or payload.get("change")
        if change:
            return f"ok code={code} change={change}\n"
        return f"ok code={code}\n"
    return f"error code={payload.get('code', 'ERROR')} message={payload.get('message')}\n"


def emit_error(
    code: str,
    message: str,
    *,
    as_json: bool,
    extra: dict[str, Any] | None = None,
    exit_code: int = 1,
) -> int:
    payload: dict[str, Any] = {"ok": False, "code": code, "message": message}
    if extra:
        payload.update(extra)
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message} ({code})\n")
    return exit_code


def _git_text(cwd: Path, *args: str) -> str | None:
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


def resolve_main_project_root(cwd: Path | None = None) -> Path:
    """Locate main project root from a worktree or main checkout."""
    start = (cwd or Path.cwd()).resolve()
    common_raw = _git_text(start, "rev-parse", "--git-common-dir")
    if not common_raw:
        return start
    common = Path(common_raw)
    if not common.is_absolute():
        common = (start / common).resolve()
    if common.name == ".git":
        return common.parent
    return start


def changes_dir(project_root: Path) -> Path:
    return project_root / ".harness" / "changes"


def runtime_dir(project_root: Path) -> Path:
    return project_root / RUNTIME_REL


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


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


def list_active_changes(project_root: Path) -> list[dict[str, Any]]:
    root = changes_dir(project_root)
    if not root.is_dir():
        return []
    active: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        meta_archived = entry / "meta" / "archived.json"
        if meta_archived.is_file():
            try:
                archived = _read_json(meta_archived)
            except (OSError, json.JSONDecodeError):
                archived = {}
            if isinstance(archived, dict) and archived.get("status") == "archived":
                continue
        active.append(
            {
                "changeId": entry.name,
                "path": str(entry.resolve()),
                "hasPlan": (entry / "plans").is_dir(),
                "hasWorktreeMeta": (entry / WORKTREE_META_REL).is_file(),
            }
        )
    return active


def change_dir_for_id(project_root: Path, change_id: str) -> Path | None:
    candidate = changes_dir(project_root) / change_id
    if candidate.is_dir():
        return candidate.resolve()
    return None


def resolve_change(
    project_root: Path,
    change_id: str | None,
) -> dict[str, Any]:
    active = list_active_changes(project_root)
    if change_id:
        resolved = change_dir_for_id(project_root, change_id)
        if resolved is None:
            return {
                "ok": False,
                "code": "CHANGE_NOT_FOUND",
                "message": f"change not found: {change_id}",
                "changeId": change_id,
            }
        return {
            "ok": True,
            "code": "RESOLVED",
            "changeId": change_id,
            "changeDir": str(resolved),
            "projectRoot": str(project_root.resolve()),
            "activeCount": len(active),
        }
    if not active:
        return {
            "ok": False,
            "code": "NO_ACTIVE_CHANGE",
            "message": "no active change under .harness/changes",
            "activeChanges": [],
        }
    if len(active) == 1:
        only = active[0]
        return {
            "ok": True,
            "code": "RESOLVED",
            "changeId": only["changeId"],
            "changeDir": only["path"],
            "projectRoot": str(project_root.resolve()),
            "activeCount": 1,
            "autoSelected": True,
        }
    return {
        "ok": False,
        "code": "CHANGE_SELECTION_REQUIRED",
        "message": "multiple active changes; pass --change <id>",
        "activeChanges": active,
        "activeCount": len(active),
    }


def migrate_change(project_root: Path, change_id: str) -> dict[str, Any]:
    resolved = resolve_change(project_root, change_id)
    if not resolved.get("ok"):
        return resolved
    change_dir = Path(resolved["changeDir"])
    created: list[str] = []

    context_path = change_dir / CHANGE_CONTEXT_REL
    if not context_path.is_file():
        worktree_meta = change_dir / WORKTREE_META_REL
        worktree_root = project_root.resolve()
        branch = _git_text(project_root, "rev-parse", "--abbrev-ref", "HEAD") or ""
        if worktree_meta.is_file():
            try:
                wt = _read_json(worktree_meta)
                if isinstance(wt, dict):
                    if isinstance(wt.get("path"), str) and wt["path"].strip():
                        worktree_root = Path(wt["path"]).expanduser().resolve()
                    elif isinstance(wt.get("worktreeRoot"), str) and wt["worktreeRoot"].strip():
                        worktree_root = Path(wt["worktreeRoot"]).expanduser().resolve()
                    if isinstance(wt.get("branch"), str) and wt["branch"].strip():
                        branch = wt["branch"].strip()
            except (OSError, json.JSONDecodeError):
                pass
        context = {
            "schemaVersion": 1,
            "changeId": change_id,
            "mainProjectRoot": str(project_root.resolve()),
            "worktreeRoot": str(worktree_root),
            "stateDir": str(change_dir.resolve()),
            "branch": branch,
            "migratedAt": now_iso(),
        }
        _write_json(context_path, context)
        created.append(str(context_path.relative_to(change_dir)))

    checkpoints_path = change_dir / CHECKPOINTS_REL
    if not checkpoints_path.is_file():
        checkpoints = {
            "schemaVersion": 1,
            "changeName": change_id,
            "checkpoints": [
                {
                    "id": "foundation-gate",
                    "afterTasks": [1, 2, 3, 4],
                    "beforeTasks": [6, 7, 8, 9, 10],
                    "reviewerTool": "codex",
                    "status": "pending",
                    "blocking": True,
                    "requiredReport": "reports/review/foundation-gate-review.md",
                    "purpose": "Block tasks 6+ until foundation interfaces are reviewed.",
                }
            ],
        }
        _write_json(checkpoints_path, checkpoints)
        created.append(str(checkpoints_path.relative_to(change_dir)))

    return {
        "ok": True,
        "code": "MIGRATED",
        "changeId": change_id,
        "changeDir": str(change_dir),
        "created": created,
    }


def _lease_path(project_root: Path, change_id: str) -> Path:
    return project_root / LEASES_REL / f"{change_id}.json"


def _lease_expired(lease: dict[str, Any]) -> bool:
    expires = lease.get("expiresAt")
    if not isinstance(expires, str) or not expires.strip():
        return True
    try:
        exp_dt = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError:
        return True
    return dt.datetime.now().astimezone() >= exp_dt


def claim_lease(
    project_root: Path,
    *,
    change_id: str,
    phase: str,
    run_id: str,
    ttl_seconds: int,
    steal: bool = False,
) -> dict[str, Any]:
    path = _lease_path(project_root, change_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone()
    expires = now + dt.timedelta(seconds=max(1, ttl_seconds))
    new_lease = {
        "changeId": change_id,
        "phase": phase,
        "runId": run_id,
        "pid": os.getpid(),
        "acquiredAt": now.isoformat(timespec="milliseconds"),
        "expiresAt": expires.isoformat(timespec="milliseconds"),
        "ttlSeconds": ttl_seconds,
    }
    if path.is_file():
        try:
            existing = _read_json(path)
        except (OSError, json.JSONDecodeError):
            existing = None
        if isinstance(existing, dict) and not _lease_expired(existing):
            same_owner = (
                str(existing.get("runId")) == run_id
                and int(existing.get("pid", -1)) == os.getpid()
            )
            if same_owner:
                existing.update(
                    {
                        "phase": phase,
                        "expiresAt": expires.isoformat(timespec="milliseconds"),
                        "refreshedAt": now.isoformat(timespec="milliseconds"),
                    }
                )
                _write_json(path, existing)
                return {"ok": True, "code": "LEASE_REFRESHED", "lease": existing}
            if not steal:
                return {
                    "ok": False,
                    "code": "LEASE_CONFLICT",
                    "message": "change lease held by another run",
                    "holder": existing,
                }
    _write_json(path, new_lease)
    return {"ok": True, "code": "LEASE_CLAIMED", "lease": new_lease}


def release_lease(
    project_root: Path,
    *,
    change_id: str,
    phase: str,
    run_id: str,
) -> dict[str, Any]:
    path = _lease_path(project_root, change_id)
    if not path.is_file():
        return {
            "ok": True,
            "code": "LEASE_ABSENT",
            "message": "no lease file present",
        }
    try:
        existing = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "LEASE_INVALID",
            "message": str(exc),
        }
    if not isinstance(existing, dict):
        return {"ok": False, "code": "LEASE_INVALID", "message": "lease is not an object"}
    if str(existing.get("runId")) != run_id:
        return {
            "ok": False,
            "code": "LEASE_OWNER_MISMATCH",
            "message": "run id does not match lease owner",
            "holder": existing,
        }
    if str(existing.get("phase")) != phase:
        return {
            "ok": False,
            "code": "LEASE_PHASE_MISMATCH",
            "message": f"lease phase is {existing.get('phase')}, not {phase}",
            "holder": existing,
        }
    path.unlink(missing_ok=True)
    return {"ok": True, "code": "LEASE_RELEASED", "changeId": change_id, "phase": phase}


def lease_port(
    project_root: Path,
    *,
    change_id: str,
    run_id: str,
    port_range: tuple[int, int],
) -> dict[str, Any]:
    start, end = port_range
    if start > end:
        return {
            "ok": False,
            "code": "INVALID_PORT_RANGE",
            "message": f"invalid range {start}-{end}",
        }
    ports_root = project_root / PORTS_REL
    ports_root.mkdir(parents=True, exist_ok=True)
    registry_path = ports_root / "registry.json"
    registry: dict[str, Any] = {"leases": []}
    if registry_path.is_file():
        try:
            loaded = _read_json(registry_path)
            if isinstance(loaded, dict) and isinstance(loaded.get("leases"), list):
                registry = loaded
        except (OSError, json.JSONDecodeError):
            registry = {"leases": []}

    leases = [item for item in registry["leases"] if isinstance(item, dict)]
    used = {
        int(item["port"])
        for item in leases
        if isinstance(item.get("port"), int)
        and not _lease_expired(item)
    }
    for port in range(start, end + 1):
        if port not in used:
            entry = {
                "changeId": change_id,
                "runId": run_id,
                "pid": os.getpid(),
                "port": port,
                "acquiredAt": now_iso(),
                "expiresAt": (
                    dt.datetime.now().astimezone() + dt.timedelta(hours=4)
                ).isoformat(timespec="milliseconds"),
            }
            leases.append(entry)
            registry["leases"] = leases
            _write_json(registry_path, registry)
            return {"ok": True, "code": "PORT_LEASED", "port": port, "lease": entry}
    return {
        "ok": False,
        "code": "PORT_RANGE_EXHAUSTED",
        "message": f"no free port in {start}-{end}",
    }


def integration_lock_acquire(
    project_root: Path,
    *,
    run_id: str,
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    path = project_root / INTEGRATION_LOCK_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone()
    payload = {
        "runId": run_id,
        "pid": os.getpid(),
        "acquiredAt": now.isoformat(timespec="milliseconds"),
        "expiresAt": (now + dt.timedelta(seconds=ttl_seconds)).isoformat(
            timespec="milliseconds"
        ),
    }
    if path.is_file():
        try:
            existing = _read_json(path)
        except (OSError, json.JSONDecodeError):
            existing = None
        if isinstance(existing, dict) and not _lease_expired(existing):
            if str(existing.get("runId")) == run_id:
                _write_json(path, payload)
                return {"ok": True, "code": "INTEGRATION_LOCK_REFRESHED", "lock": payload}
            return {
                "ok": False,
                "code": "INTEGRATION_LOCK_HELD",
                "message": "integration lock held by another run",
                "holder": existing,
            }
    _write_json(path, payload)
    return {"ok": True, "code": "INTEGRATION_LOCK_ACQUIRED", "lock": payload}


def integration_lock_release(project_root: Path, *, run_id: str) -> dict[str, Any]:
    path = project_root / INTEGRATION_LOCK_REL
    if not path.is_file():
        return {"ok": True, "code": "INTEGRATION_LOCK_ABSENT"}
    try:
        existing = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "INTEGRATION_LOCK_INVALID", "message": str(exc)}
    if not isinstance(existing, dict):
        return {"ok": False, "code": "INTEGRATION_LOCK_INVALID", "message": "not an object"}
    if str(existing.get("runId")) != run_id:
        return {
            "ok": False,
            "code": "INTEGRATION_LOCK_OWNER_MISMATCH",
            "message": "run id does not match lock owner",
            "holder": existing,
        }
    path.unlink(missing_ok=True)
    return {"ok": True, "code": "INTEGRATION_LOCK_RELEASED"}


def parse_port_range(raw: str) -> tuple[int, int] | None:
    if "-" not in raw:
        return None
    left, right = raw.split("-", 1)
    try:
        return int(left.strip()), int(right.strip())
    except ValueError:
        return None


def cmd_list(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    payload = {
        "ok": True,
        "code": "LISTED",
        "projectRoot": str(project),
        "activeChanges": list_active_changes(project),
    }
    emit(payload, as_json=bool(args.json))
    return 0


def cmd_resolve(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    payload = resolve_change(project, args.change)
    if payload.get("ok"):
        emit(payload, as_json=bool(args.json))
        return 0
    return emit_error(
        str(payload.get("code", "RESOLVE_FAILED")),
        str(payload.get("message", "resolve failed")),
        as_json=bool(args.json),
        extra={k: v for k, v in payload.items() if k not in {"ok", "message"}},
    )


def cmd_migrate(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    if not args.change:
        return emit_error("CHANGE_REQUIRED", "--change is required", as_json=bool(args.json))
    payload = migrate_change(project, args.change)
    if payload.get("ok"):
        emit(payload, as_json=bool(args.json))
        return 0
    return emit_error(
        str(payload.get("code", "MIGRATE_FAILED")),
        str(payload.get("message", "migrate failed")),
        as_json=bool(args.json),
        extra={k: v for k, v in payload.items() if k not in {"ok", "message"}},
    )


def cmd_claim(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    payload = claim_lease(
        project,
        change_id=args.change,
        phase=args.phase,
        run_id=args.run_id,
        ttl_seconds=int(args.ttl_seconds),
        steal=bool(args.steal),
    )
    if payload.get("ok"):
        emit(payload, as_json=bool(args.json))
        return 0
    return emit_error(
        str(payload.get("code", "CLAIM_FAILED")),
        str(payload.get("message", "claim failed")),
        as_json=bool(args.json),
        extra={k: v for k, v in payload.items() if k not in {"ok", "message"}},
    )


def cmd_release(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    payload = release_lease(
        project,
        change_id=args.change,
        phase=args.phase,
        run_id=args.run_id,
    )
    if payload.get("ok"):
        emit(payload, as_json=bool(args.json))
        return 0
    return emit_error(
        str(payload.get("code", "RELEASE_FAILED")),
        str(payload.get("message", "release failed")),
        as_json=bool(args.json),
        extra={k: v for k, v in payload.items() if k not in {"ok", "message"}},
    )


def cmd_lease_port(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    parsed = parse_port_range(args.range)
    if parsed is None:
        return emit_error(
            "INVALID_PORT_RANGE",
            f"expected --range <start-end>, got {args.range!r}",
            as_json=bool(args.json),
        )
    payload = lease_port(
        project,
        change_id=args.change,
        run_id=args.run_id,
        port_range=parsed,
    )
    if payload.get("ok"):
        emit(payload, as_json=bool(args.json))
        return 0
    return emit_error(
        str(payload.get("code", "PORT_LEASE_FAILED")),
        str(payload.get("message", "port lease failed")),
        as_json=bool(args.json),
        extra={k: v for k, v in payload.items() if k not in {"ok", "message"}},
    )


def cmd_integration_lock(args: argparse.Namespace) -> int:
    project = resolve_main_project_root()
    if args.integration_action == "acquire":
        payload = integration_lock_acquire(
            project,
            run_id=args.run_id,
            ttl_seconds=int(args.ttl_seconds),
        )
    else:
        payload = integration_lock_release(project, run_id=args.run_id)
    if payload.get("ok"):
        emit(payload, as_json=bool(args.json))
        return 0
    return emit_error(
        str(payload.get("code", "INTEGRATION_LOCK_FAILED")),
        str(payload.get("message", "integration lock failed")),
        as_json=bool(args.json),
        extra={k: v for k, v in payload.items() if k not in {"ok", "message"}},
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_change.py")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command_name", required=True)

    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--json", action="store_true", default=argparse.SUPPRESS)

    p_list = sub.add_parser("list", parents=[shared])
    p_list.set_defaults(func=cmd_list)

    p_resolve = sub.add_parser("resolve", parents=[shared])
    p_resolve.add_argument("--change", default=None)
    p_resolve.set_defaults(func=cmd_resolve)

    p_migrate = sub.add_parser("migrate", parents=[shared])
    p_migrate.add_argument("--change", required=True)
    p_migrate.set_defaults(func=cmd_migrate)

    p_claim = sub.add_parser("claim", parents=[shared])
    p_claim.add_argument("--change", required=True)
    p_claim.add_argument("--phase", required=True)
    p_claim.add_argument("--run-id", required=True)
    p_claim.add_argument("--ttl-seconds", type=int, default=3600)
    p_claim.add_argument("--steal", action="store_true")
    p_claim.set_defaults(func=cmd_claim)

    p_release = sub.add_parser("release", parents=[shared])
    p_release.add_argument("--change", required=True)
    p_release.add_argument("--phase", required=True)
    p_release.add_argument("--run-id", required=True)
    p_release.set_defaults(func=cmd_release)

    p_port = sub.add_parser("lease-port", parents=[shared])
    p_port.add_argument("--change", required=True)
    p_port.add_argument("--run-id", required=True)
    p_port.add_argument("--range", required=True)
    p_port.set_defaults(func=cmd_lease_port)

    p_lock = sub.add_parser("integration-lock", parents=[shared])
    p_lock.add_argument("integration_action", choices=["acquire", "release"])
    p_lock.add_argument("--run-id", required=True)
    p_lock.add_argument("--ttl-seconds", type=int, default=3600)
    p_lock.set_defaults(func=cmd_integration_lock)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
