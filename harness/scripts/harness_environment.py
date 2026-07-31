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
import os
import sys
from pathlib import Path
from typing import Any

import harness_service as hservice


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

REQUIRED_CONTENT_EVIDENCE_FIELDS = (
    "instanceId",
    "instanceStartedAt",
    "migrationHead",
    "seedVersion",
    "apiBuildIdentity",
    "redisPing",
    "databaseIndex",
    "isolationPrefixHash",
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


def _canonical_content_evidence(raw: dict[str, Any]) -> dict[str, Any]:
    content = {
        key: str(raw.get(key) or "").strip()
        for key in (
            "instanceId",
            "instanceStartedAt",
            "migrationHead",
            "seedVersion",
            "apiBuildIdentity",
            "redisPing",
            "databaseIndex",
            "isolationPrefixHash",
        )
        if str(raw.get(key) or "").strip()
    }
    canaries_raw = raw.get("canaries")
    canaries: list[dict[str, str]] = []
    if isinstance(canaries_raw, list):
        for index, item in enumerate(canaries_raw):
            if not isinstance(item, dict):
                raise ValueError(f"content canaries[{index}] must be an object")
            name = str(item.get("name") or "").strip()
            status = str(item.get("status") or "").strip().upper()
            identity = str(item.get("identity") or "").strip()
            if not name or status not in {"PASS", "FAIL", "UNKNOWN"}:
                raise ValueError(
                    f"content canaries[{index}] requires name and PASS/FAIL/UNKNOWN status"
                )
            canonical = {"name": name, "status": status}
            if identity:
                canonical["identity"] = identity
            canaries.append(canonical)
    content["canaries"] = sorted(
        canaries,
        key=lambda item: (item["name"], item.get("identity", "")),
    )
    return content


def create_environment_receipt(
    project: Path,
    *,
    stack_id: str,
    content_evidence: dict[str, Any],
    environment_values: dict[str, str] | None = None,
    powershell: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Create a typed, secret-free receipt for reusable environment contents."""
    content = _canonical_content_evidence(content_evidence)
    canonical_content = json.dumps(
        content,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    fields = {
        str(name): "sha256:" + _sha256_bytes(str(value).encode("utf-8"))
        for name, value in sorted((environment_values or {}).items())
        if str(name).strip() and value is not None
    }
    shell = {
        key: str((powershell or {}).get(key) or "").strip()
        for key in ("edition", "version")
        if str((powershell or {}).get(key) or "").strip()
    }
    receipt = {
        "schemaVersion": 1,
        "stackId": stack_id,
        "preparedAt": now_iso(),
        "environmentHash": compute_environment_hash(project),
        "content": content,
        "contentFingerprint": "sha256:" + _sha256_bytes(canonical_content),
        "environmentFields": fields,
        "powershell": shell,
    }
    identity_payload = json.dumps(
        {
            key: value
            for key, value in receipt.items()
            if key not in {"preparedAt", "receiptId"}
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    receipt["receiptId"] = "sha256:" + _sha256_bytes(identity_payload)
    return receipt


def resolve_verification_environment(
    receipt: dict[str, Any],
    *,
    required_fields: list[str],
    source_environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Close a verification's dynamic environment over a typed receipt."""
    source = source_environment if source_environment is not None else dict(os.environ)
    identities = receipt.get("environmentFields")
    if receipt.get("schemaVersion") != 1 or not isinstance(identities, dict):
        return {
            "ok": False,
            "code": "VERIFICATION_ENVIRONMENT_INCOMPLETE",
            "message": "environment receipt is missing typed environmentFields",
            "missing": sorted(set(required_fields)),
            "changed": [],
        }
    required = sorted({str(item).strip() for item in required_fields if str(item).strip()})
    missing = [
        field
        for field in required
        if field not in identities or field not in source or source[field] == ""
    ]
    changed = [
        field
        for field in required
        if field not in missing
        and identities.get(field)
        != "sha256:" + _sha256_bytes(str(source[field]).encode("utf-8"))
    ]
    if missing or changed:
        return {
            "ok": False,
            "code": "VERIFICATION_ENVIRONMENT_INCOMPLETE",
            "message": "required dynamic environment fields are missing or changed",
            "missing": missing,
            "changed": changed,
        }
    return {
        "ok": True,
        "code": "VERIFICATION_ENVIRONMENT_READY",
        "environment": {field: str(source[field]) for field in required},
        "receiptId": receipt.get("receiptId"),
    }


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


def _parse_expiry(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def classify_leases(lease_root: Path) -> list[dict[str, Any]]:
    """Classify leases without mutating or terminating any owner process."""
    results: list[dict[str, Any]] = []
    if not lease_root.is_dir():
        return results
    now = dt.datetime.now(dt.timezone.utc)
    for path in sorted(lease_root.glob("*.json")):
        try:
            lease = _read_json(path)
        except (OSError, json.JSONDecodeError) as exc:
            results.append(
                {
                    "stackId": path.stem,
                    "classification": "LEASE_UNREADABLE",
                    "message": str(exc),
                    "sourcePath": str(path),
                }
            )
            continue
        if not isinstance(lease, dict):
            continue
        item = {
            "stackId": str(lease.get("stackId") or path.stem),
            "changeId": lease.get("changeId"),
            "expiresAt": lease.get("expiresAt"),
            "sourcePath": str(path),
        }
        expires_at = _parse_expiry(lease.get("expiresAt"))
        if expires_at is None:
            item["classification"] = "LEASE_EXPIRY_INVALID"
            results.append(item)
            continue
        if now < expires_at:
            item["classification"] = (
                "STALE_CONTENT"
                if lease.get("status") == "STALE_CONTENT"
                else "ACTIVE"
            )
            results.append(item)
            continue
        owner = lease.get("owner")
        if not isinstance(owner, dict) or any(
            not owner.get(field) for field in ("pid", "executable", "startedAt")
        ):
            item["classification"] = "OWNER_IDENTITY_INCOMPLETE"
            results.append(item)
            continue
        try:
            owner_pid = int(owner["pid"])
        except (TypeError, ValueError):
            item["classification"] = "OWNER_IDENTITY_INCOMPLETE"
            results.append(item)
            continue
        if not hservice.is_pid_alive(owner_pid):
            item["classification"] = "RECLAIMABLE"
            results.append(item)
            continue
        identity = hservice.verify_process_identity(
            {
                "pid": owner_pid,
                "startedAt": owner["startedAt"],
                "processIdentity": {"executable": owner["executable"]},
            }
        )
        item["classification"] = (
            "OWNER_ACTIVE"
            if identity is True
            else (
                "OWNER_IDENTITY_UNCONFIRMED"
                if identity is None
                else "OWNER_IDENTITY_MISMATCH"
            )
        )
        results.append(item)
    return results


def reap_expired_leases(lease_root: Path) -> dict[str, Any]:
    """Remove only expired leases whose recorded owner is definitely gone."""
    leases = classify_leases(lease_root)
    reaped: list[str] = []
    for item in leases:
        if item.get("classification") != "RECLAIMABLE":
            continue
        path = Path(str(item["sourcePath"]))
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        reaped.append(str(item["stackId"]))
    receipt = {
        "schemaVersion": 1,
        "action": "environment-lease-reap",
        "completedAt": now_iso(),
        "reaped": reaped,
        "leases": leases,
    }
    receipt_path = (
        lease_root
        / "reap-receipts"
        / f"{dt.datetime.now().strftime('%Y%m%dT%H%M%S')}-{os.getpid()}.json"
    )
    _write_json(receipt_path, receipt)
    return {
        "ok": True,
        "code": "LEASE_REAP_COMPLETE",
        "reaped": reaped,
        "leases": leases,
        "receiptPath": str(receipt_path),
    }


def require_writable_lease(
    project: Path,
    *,
    change_id: str,
    stack_id: str,
    lease_root: Path | None = None,
    environment_receipt: dict[str, Any] | None = None,
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
        expires_at = _parse_expiry(expires_raw)
        if expires_at is None:
            return {
                "ok": False,
                "code": "ENVIRONMENT_LEASE_REQUIRED",
                "message": f"lease expiresAt unreadable: {expires_raw}",
                "changeId": change_id,
                "stackId": stack_id,
            }
        if dt.datetime.now(dt.timezone.utc) >= expires_at:
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
    if lease.get("status") == "STALE_CONTENT":
        return {
            "ok": False,
            "code": "STALE_CONTENT",
            "message": "lease content was previously marked stale; prepare again",
            "lease": lease,
        }
    expected_content = str(lease.get("contentFingerprint") or "").strip()
    if expected_content:
        if not isinstance(environment_receipt, dict):
            return {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_RECEIPT_REQUIRED",
                "message": "current typed environment receipt is required before reuse",
                "changeId": change_id,
                "stackId": stack_id,
            }
        observed_content = str(
            environment_receipt.get("contentFingerprint") or ""
        ).strip()
        canaries = (
            environment_receipt.get("content", {}).get("canaries")
            if isinstance(environment_receipt.get("content"), dict)
            else None
        )
        canaries_ok = isinstance(canaries, list) and all(
            isinstance(item, dict) and item.get("status") == "PASS"
            for item in canaries
        )
        if observed_content != expected_content or not canaries_ok:
            lease["status"] = "STALE_CONTENT"
            lease["staleAt"] = now_iso()
            lease["expectedContentFingerprint"] = expected_content
            lease["observedContentFingerprint"] = observed_content
            _write_json(path, lease)
            return {
                "ok": False,
                "code": "STALE_CONTENT",
                "message": "environment content fingerprint or canary changed",
                "expectedContentFingerprint": expected_content,
                "observedContentFingerprint": observed_content,
            }
    lease["heartbeatAt"] = now_iso()
    _write_json(path, lease)
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
    environment_receipt: dict[str, Any] | None = None,
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
    if environment_receipt is not None:
        if (
            environment_receipt.get("schemaVersion") != 1
            or environment_receipt.get("stackId") != stack_id
            or not str(environment_receipt.get("contentFingerprint") or "").strip()
        ):
            return {
                "ok": False,
                "code": "ENVIRONMENT_RECEIPT_INVALID",
                "message": "environment receipt identity does not match requested stack",
            }
        canaries = (
            environment_receipt.get("content", {}).get("canaries")
            if isinstance(environment_receipt.get("content"), dict)
            else None
        )
        if not isinstance(canaries, list) or not canaries or any(
            not isinstance(item, dict) or item.get("status") != "PASS"
            for item in canaries
        ):
            return {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_NOT_READY",
                "message": "all environment content canaries must pass before acquire",
            }
    lease = {
        "schemaVersion": 2 if environment_receipt is not None else 1,
        "changeId": change_id,
        "stackId": stack_id,
        "environmentHash": environment_hash,
        "writableVolumes": volumes,
        "acquiredAt": started.isoformat(timespec="seconds"),
        "heartbeatAt": started.isoformat(timespec="seconds"),
        "expiresAt": expires.isoformat(timespec="seconds"),
        "projectRoot": str(project.resolve()),
        "status": "ACTIVE",
        "owner": {
            "pid": os.getpid(),
            "executable": hservice.get_process_executable(os.getpid())
            or str(Path(sys.executable).resolve()),
            "startedAt": (
                hservice.get_process_create_time(os.getpid())
                or started
            ).isoformat(timespec="seconds"),
        },
    }
    if environment_receipt is not None:
        lease["contentFingerprint"] = environment_receipt["contentFingerprint"]
        lease["environmentReceiptId"] = environment_receipt.get("receiptId")
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


def _load_receipt_arg(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    path = Path(value).resolve()
    data = _read_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"environment receipt must be a JSON object: {path}")
    return data


def cmd_prepare(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    evidence_path = Path(args.content_evidence_file).resolve()
    try:
        evidence = _read_json(evidence_path)
    except (OSError, json.JSONDecodeError) as exc:
        return emit_json(
            {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_EVIDENCE_INVALID",
                "message": str(exc),
            },
            ok=False,
        )
    if not isinstance(evidence, dict):
        return emit_json(
            {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_EVIDENCE_INVALID",
                "message": "content evidence must be a JSON object",
            },
            ok=False,
        )
    try:
        canonical_evidence = _canonical_content_evidence(evidence)
    except ValueError as exc:
        return emit_json(
            {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_EVIDENCE_INVALID",
                "message": str(exc),
            },
            ok=False,
        )
    missing_content = [
        field
        for field in REQUIRED_CONTENT_EVIDENCE_FIELDS
        if not canonical_evidence.get(field)
    ]
    if not canonical_evidence.get("canaries"):
        missing_content.append("canaries")
    if missing_content:
        return emit_json(
            {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_EVIDENCE_INCOMPLETE",
                "message": "formal environment receipts require complete content evidence",
                "missing": missing_content,
            },
            ok=False,
        )
    field_names = sorted(
        {str(item).strip() for item in (args.environment_field or []) if str(item).strip()}
    )
    missing = [field for field in field_names if not os.environ.get(field)]
    if missing:
        return emit_json(
            {
                "ok": False,
                "code": "VERIFICATION_ENVIRONMENT_INCOMPLETE",
                "message": "declared environment fields are missing",
                "missing": missing,
            },
            ok=False,
        )
    powershell = {
        "edition": str(
            args.powershell_edition
            or os.environ.get("HARNESS_POWERSHELL_EDITION")
            or ""
        ),
        "version": str(
            args.powershell_version
            or os.environ.get("HARNESS_POWERSHELL_VERSION")
            or ""
        ),
    }
    if bool(powershell["edition"]) != bool(powershell["version"]):
        return emit_json(
            {
                "ok": False,
                "code": "POWERSHELL_RUNTIME_INCOMPLETE",
                "message": "PowerShell edition and version must be recorded together",
            },
            ok=False,
        )
    try:
        receipt = create_environment_receipt(
            project,
            stack_id=args.stack_id,
            content_evidence=evidence,
            environment_values={field: os.environ[field] for field in field_names},
            powershell=powershell,
        )
    except ValueError as exc:
        return emit_json(
            {
                "ok": False,
                "code": "ENVIRONMENT_CONTENT_EVIDENCE_INVALID",
                "message": str(exc),
            },
            ok=False,
        )
    output = Path(args.output).resolve()
    _write_json(output, receipt)
    return emit_json(
        {
            "ok": True,
            "code": "ENVIRONMENT_RECEIPT_PREPARED",
            "receiptId": receipt["receiptId"],
            "contentFingerprint": receipt["contentFingerprint"],
            "output": str(output),
        }
    )


def cmd_acquire(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    root = Path(args.lease_root).resolve() if args.lease_root else default_lease_root(project)
    env_hash = args.environment_hash or compute_environment_hash(project)
    volumes = [v for v in (args.writable_volume or []) if v]
    try:
        receipt = _load_receipt_arg(args.environment_receipt)
        result = acquire_lease(
            project,
            change_id=args.change,
            stack_id=args.stack_id,
            environment_hash=env_hash,
            lease_root=root,
            writable_volumes=volumes,
            ttl_seconds=int(args.ttl_seconds or 3600),
            environment_receipt=receipt,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        result = {
            "ok": False,
            "code": "ENVIRONMENT_RECEIPT_INVALID",
            "message": str(exc),
        }
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
    try:
        receipt = _load_receipt_arg(args.environment_receipt)
        result = require_writable_lease(
            project,
            change_id=args.change,
            stack_id=args.stack_id,
            lease_root=root,
            environment_receipt=receipt,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        result = {
            "ok": False,
            "code": "ENVIRONMENT_RECEIPT_INVALID",
            "message": str(exc),
        }
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
            "leases": classify_leases(root),
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


def cmd_reap_expired(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    root = Path(args.lease_root).resolve() if args.lease_root else default_lease_root(project)
    return emit_json(reap_expired_leases(root))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_environment.py")
    sub = parser.add_subparsers(dest="command", required=True)

    prep = sub.add_parser("prepare")
    prep.add_argument("--project", required=True)
    prep.add_argument("--stack-id", required=True)
    prep.add_argument("--content-evidence-file", required=True)
    prep.add_argument("--environment-field", action="append", default=[])
    prep.add_argument("--powershell-edition")
    prep.add_argument("--powershell-version")
    prep.add_argument("--output", required=True)
    prep.set_defaults(func=cmd_prepare)

    fp = sub.add_parser("fingerprint")
    fp.add_argument("--project", required=True)
    fp.set_defaults(func=cmd_fingerprint)

    ac = sub.add_parser("acquire")
    ac.add_argument("--project", required=True)
    ac.add_argument("--change", required=True)
    ac.add_argument("--stack-id", required=True)
    ac.add_argument("--environment-hash")
    ac.add_argument("--environment-receipt")
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
    req.add_argument("--environment-receipt")
    req.set_defaults(func=cmd_require)

    st = sub.add_parser("status")
    st.add_argument("--project", required=True)
    st.add_argument("--lease-root")
    st.set_defaults(func=cmd_status)

    reap = sub.add_parser("reap-expired")
    reap.add_argument("--project", required=True)
    reap.add_argument("--lease-root")
    reap.set_defaults(func=cmd_reap_expired)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
