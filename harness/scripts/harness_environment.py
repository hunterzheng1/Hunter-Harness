#!/usr/bin/env python3
"""Minimal environment fingerprint + lease manager (IA-3 Wave-A).

Contract: prepare → fingerprint → acquire lease → reset/clone → run → record → release.
This module implements fingerprint/lease gates with a file-backed stub suitable for
unit tests. Full Docker orchestration is out of scope for Wave-A.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


FINGERPRINT_CANDIDATES = (
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "poetry.lock",
    "Pipfile.lock",
    "requirements.txt",
    "requirements.lock",
    "Cargo.lock",
    "go.sum",
    "composer.lock",
    ".nvmrc",
    ".node-version",
    ".python-version",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
)


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def emit_json(payload: dict[str, Any], *, ok: bool = True) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def default_lease_root(project: Path) -> Path:
    return project / ".harness" / "runtime" / "env-leases"


def _migration_head_token(project: Path) -> str:
    cfg = project / ".harness" / "config" / "migration-head.json"
    if cfg.is_file():
        try:
            data = _read_json(cfg)
            if isinstance(data, dict):
                head = data.get("head") or data.get("revision") or data.get("version")
                if head:
                    return f"migration-head:{head}"
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    versions = project / "alembic" / "versions"
    if versions.is_dir():
        names = sorted(p.name for p in versions.glob("*.py"))
        if names:
            return "alembic:" + ",".join(names[-3:])
    return "migration-head:none"


def compute_environment_hash(
    project: Path,
    *,
    extra_paths: list[str] | None = None,
) -> str:
    """Stable hash over lockfiles/toolchain/compose/migration head inputs."""
    project = project.resolve()
    lines: list[str] = []
    seen: set[str] = set()
    for rel in list(FINGERPRINT_CANDIDATES) + list(extra_paths or []):
        if rel in seen:
            continue
        seen.add(rel)
        path = project / rel
        if path.is_file():
            lines.append(f"file:{rel}:{_sha256_file(path)}")
    lines.append(_migration_head_token(project))
    # Desensitized runner hint (presence only).
    for runner in ("playwright.config.ts", "playwright.config.js", "vitest.config.ts"):
        if (project / runner).is_file():
            lines.append(f"runner:{runner}:present")
    payload = "\n".join(sorted(lines)).encode("utf-8")
    return "sha256:" + _sha256_bytes(payload)


def _lease_path(lease_root: Path, stack_id: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in stack_id)
    return lease_root / f"{safe}.json"


def list_leases(lease_root: Path) -> list[dict[str, Any]]:
    if not lease_root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(lease_root.glob("*.json")):
        try:
            data = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            out.append(data)
    return out


def require_writable_lease(
    project: Path,
    *,
    change_id: str,
    stack_id: str,
    lease_root: Path | None = None,
) -> dict[str, Any]:
    """Gate: a writable stack may be used only with an active matching lease."""
    root = lease_root or default_lease_root(project)
    path = _lease_path(root, stack_id)
    if not path.is_file():
        return {
            "ok": False,
            "code": "ENVIRONMENT_LEASE_REQUIRED",
            "message": f"no lease for stack={stack_id}; acquire before writable use",
            "changeId": change_id,
            "stackId": stack_id,
        }
    try:
        lease = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "ENVIRONMENT_LEASE_REQUIRED",
            "message": f"lease unreadable: {exc}",
            "changeId": change_id,
            "stackId": stack_id,
        }
    if str(lease.get("changeId") or "") != change_id:
        return {
            "ok": False,
            "code": "ENVIRONMENT_LEASE_REQUIRED",
            "message": (
                f"stack={stack_id} leased by change={lease.get('changeId')}; "
                f"requested change={change_id}"
            ),
            "changeId": change_id,
            "stackId": stack_id,
            "holder": lease.get("changeId"),
        }
    # Review Y2: expired leases must not remain writable.
    expires_raw = lease.get("expiresAt")
    if isinstance(expires_raw, str) and expires_raw.strip():
        try:
            raw = expires_raw.strip().replace("Z", "+00:00")
            expires_at = dt.datetime.fromisoformat(raw)
            # Normalize both sides to UTC so naive/aware/offset mixes compare safely.
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=dt.timezone.utc)
            else:
                expires_at = expires_at.astimezone(dt.timezone.utc)
            now_utc = dt.datetime.now(dt.timezone.utc)
            if now_utc >= expires_at:
                return {
                    "ok": False,
                    "code": "ENVIRONMENT_LEASE_EXPIRED",
                    "message": (
                        f"lease for stack={stack_id} expired at {expires_raw}; "
                        "re-acquire before writable use"
                    ),
                    "changeId": change_id,
                    "stackId": stack_id,
                    "expiresAt": expires_raw,
                }
        except ValueError:
            return {
                "ok": False,
                "code": "ENVIRONMENT_LEASE_REQUIRED",
                "message": f"lease expiresAt unreadable: {expires_raw}",
                "changeId": change_id,
                "stackId": stack_id,
            }
    return {"ok": True, "code": "LEASE_HELD", "lease": lease}


def acquire_lease(
    project: Path,
    *,
    change_id: str,
    stack_id: str,
    environment_hash: str,
    lease_root: Path | None = None,
    writable_volumes: list[str] | None = None,
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    """Acquire a lease; reject cross-change sharing of the same writable volume."""
    root = lease_root or default_lease_root(project)
    root.mkdir(parents=True, exist_ok=True)
    volumes = [str(v).replace("\\", "/") for v in (writable_volumes or [])]
    for existing in list_leases(root):
        holder = str(existing.get("changeId") or "")
        if holder == change_id:
            continue
        other_vols = {
            str(v).replace("\\", "/")
            for v in (existing.get("writableVolumes") or [])
        }
        overlap = sorted(set(volumes) & other_vols)
        if overlap:
            return {
                "ok": False,
                "code": "ENVIRONMENT_LEASE_CROSS_CHANGE",
                "message": (
                    f"writable volume(s) {overlap} already held by change={holder}"
                ),
                "changeId": change_id,
                "holder": holder,
                "overlap": overlap,
            }
        if existing.get("stackId") == stack_id and holder and holder != change_id:
            return {
                "ok": False,
                "code": "ENVIRONMENT_LEASE_CROSS_CHANGE",
                "message": f"stack={stack_id} already leased by change={holder}",
                "changeId": change_id,
                "holder": holder,
            }

    path = _lease_path(root, stack_id)
    if path.is_file():
        try:
            current = _read_json(path)
        except (OSError, json.JSONDecodeError):
            current = {}
        if str(current.get("changeId") or "") not in {"", change_id}:
            return {
                "ok": False,
                "code": "ENVIRONMENT_LEASE_CROSS_CHANGE",
                "message": (
                    f"stack={stack_id} already leased by change={current.get('changeId')}"
                ),
                "changeId": change_id,
                "holder": current.get("changeId"),
            }

    started = dt.datetime.now().astimezone()
    expires = started + dt.timedelta(seconds=max(60, int(ttl_seconds)))
    lease = {
        "schemaVersion": 1,
        "changeId": change_id,
        "stackId": stack_id,
        "environmentHash": environment_hash,
        "writableVolumes": volumes,
        "acquiredAt": started.isoformat(timespec="seconds"),
        "expiresAt": expires.isoformat(timespec="seconds"),
        "projectRoot": str(project.resolve()),
    }
    _write_json(path, lease)
    return {"ok": True, "code": "LEASE_ACQUIRED", "lease": lease, "path": str(path)}


def release_lease(
    project: Path,
    *,
    change_id: str,
    stack_id: str,
    lease_root: Path | None = None,
) -> dict[str, Any]:
    root = lease_root or default_lease_root(project)
    path = _lease_path(root, stack_id)
    if not path.is_file():
        return {
            "ok": True,
            "code": "LEASE_ABSENT",
            "message": "nothing to release",
            "changeId": change_id,
            "stackId": stack_id,
        }
    try:
        lease = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "LEASE_UNREADABLE", "message": str(exc)}
    if str(lease.get("changeId") or "") != change_id:
        return {
            "ok": False,
            "code": "ENVIRONMENT_LEASE_CROSS_CHANGE",
            "message": "cannot release lease owned by another change",
            "holder": lease.get("changeId"),
            "changeId": change_id,
        }
    path.unlink(missing_ok=True)
    return {"ok": True, "code": "LEASE_RELEASED", "changeId": change_id, "stackId": stack_id}


def cmd_fingerprint(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    digest = compute_environment_hash(project)
    return emit_json(
        {
            "ok": True,
            "action": "fingerprint",
            "projectRoot": str(project),
            "environmentHash": digest,
        }
    )


def cmd_acquire(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    root = Path(args.lease_root).resolve() if args.lease_root else default_lease_root(project)
    env_hash = args.environment_hash or compute_environment_hash(project)
    volumes = [v for v in (args.writable_volume or []) if v]
    result = acquire_lease(
        project,
        change_id=args.change,
        stack_id=args.stack_id,
        environment_hash=env_hash,
        lease_root=root,
        writable_volumes=volumes,
        ttl_seconds=int(args.ttl_seconds or 3600),
    )
    return emit_json(result, ok=bool(result.get("ok")))


def cmd_release(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    root = Path(args.lease_root).resolve() if args.lease_root else default_lease_root(project)
    result = release_lease(
        project,
        change_id=args.change,
        stack_id=args.stack_id,
        lease_root=root,
    )
    return emit_json(result, ok=bool(result.get("ok")))


def cmd_require(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    root = Path(args.lease_root).resolve() if args.lease_root else default_lease_root(project)
    result = require_writable_lease(
        project,
        change_id=args.change,
        stack_id=args.stack_id,
        lease_root=root,
    )
    return emit_json(result, ok=bool(result.get("ok")))


def cmd_status(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    root = Path(args.lease_root).resolve() if args.lease_root else default_lease_root(project)
    return emit_json(
        {
            "ok": True,
            "action": "status",
            "projectRoot": str(project),
            "environmentHash": compute_environment_hash(project),
            "leases": list_leases(root),
            "leaseRoot": str(root),
            "contract": [
                "prepare",
                "fingerprint",
                "acquire",
                "reset/clone",
                "run",
                "record",
                "release",
            ],
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_environment.py")
    sub = parser.add_subparsers(dest="command", required=True)

    fp = sub.add_parser("fingerprint")
    fp.add_argument("--project", required=True)
    fp.set_defaults(func=cmd_fingerprint)

    ac = sub.add_parser("acquire")
    ac.add_argument("--project", required=True)
    ac.add_argument("--change", required=True)
    ac.add_argument("--stack-id", required=True)
    ac.add_argument("--environment-hash")
    ac.add_argument("--lease-root")
    ac.add_argument("--writable-volume", action="append", default=[])
    ac.add_argument("--ttl-seconds", type=int, default=3600)
    ac.set_defaults(func=cmd_acquire)

    rel = sub.add_parser("release")
    rel.add_argument("--project", required=True)
    rel.add_argument("--change", required=True)
    rel.add_argument("--stack-id", required=True)
    rel.add_argument("--lease-root")
    rel.set_defaults(func=cmd_release)

    req = sub.add_parser("require")
    req.add_argument("--project", required=True)
    req.add_argument("--change", required=True)
    req.add_argument("--stack-id", required=True)
    req.add_argument("--lease-root")
    req.set_defaults(func=cmd_require)

    st = sub.add_parser("status")
    st.add_argument("--project", required=True)
    st.add_argument("--lease-root")
    st.set_defaults(func=cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
