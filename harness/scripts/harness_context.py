#!/usr/bin/env python3
"""Cross-agent workflow context and append-only transition receipts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


PHASE_GRAPH = {
    "plan": ("run",),
    "run": ("test",),
    "test": ("review", "run"),
    "review": ("submit", "run"),
    "submit": (),
}

WORKFLOW_PHASES = (
    "plan",
    "run",
    "test",
    "review",
    "package",
    "apidoc",
    "submit",
    "merge",
    "archive",
)

DISPLAY_TITLE_MAX_LENGTH = 80


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"JSON object required: {path}")
    return data


def _normalize_display_title(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("display title must be text")
    title = value.strip()
    if not title:
        raise ValueError("display title must not be empty")
    if len(title) > DISPLAY_TITLE_MAX_LENGTH:
        raise ValueError(
            f"display title exceeds {DISPLAY_TITLE_MAX_LENGTH} characters"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in title):
        raise ValueError("display title contains control characters")
    return title


def _ensure_display_title(contract_root: Path, value: Any) -> str | None:
    path = contract_root / "meta" / "change-title.json"
    if path.is_file():
        payload = _read_json(path)
        return _normalize_display_title(payload.get("displayTitle"))
    title = _normalize_display_title(value)
    if title is None:
        return None
    _write_json_atomic(
        path,
        {
            "schemaVersion": 1,
            "displayTitle": title,
        },
    )
    return title


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temp = Path(raw)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _append_ndjson(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_suffix(path.suffix + ".lock")
    deadline = time.monotonic() + 2
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"context transition log locked: {path}")
            time.sleep(0.02)
    try:
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(
                json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
            )
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
        lock.unlink(missing_ok=True)


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    entries: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            entries.append(item)
    return entries


def _sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _payload_hash(payload: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _head(project: Path) -> str | None:
    process = subprocess.run(
        ["git", "-C", str(project), "rev-parse", "--verify", "HEAD"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    value = process.stdout.strip()
    return value if process.returncode == 0 and value else None


def _git_common_dir(project: Path) -> Path | None:
    process = subprocess.run(
        ["git", "-C", str(project), "rev-parse", "--git-common-dir"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    value = process.stdout.strip()
    if process.returncode != 0 or not value:
        return None
    common = Path(value)
    return common.resolve() if common.is_absolute() else (project / common).resolve()


def _same_repository(project: Path, candidate: Path) -> bool:
    project_common = _git_common_dir(project)
    candidate_common = _git_common_dir(candidate)
    if project_common is not None or candidate_common is not None:
        return (
            project_common is not None
            and candidate_common is not None
            and project_common == candidate_common
        )
    return candidate.is_relative_to(project)


def _contract(project: Path, change: str) -> tuple[Path, dict[str, Any], Path]:
    root = project.resolve()
    contract_root = (root / ".harness" / "changes" / change).resolve()
    changes_root = (root / ".harness" / "changes").resolve()
    if not contract_root.is_relative_to(changes_root) or not contract_root.is_dir():
        raise ValueError(f"CHANGE_NOT_FOUND: {change}")
    context_path = contract_root / "meta" / "change-context.json"
    contract = _read_json(context_path) if context_path.is_file() else {}
    ownership = contract.get("stateOwnership")
    runtime_rel = (
        ownership.get("runtimeRoot")
        if isinstance(ownership, dict)
        else None
    )
    if runtime_rel:
        candidate = (root / str(runtime_rel)).resolve()
        state_parent = (root / ".harness" / "state" / "changes").resolve()
        expected = (state_parent / change).resolve()
        if candidate != expected or not candidate.is_relative_to(state_parent):
            raise ValueError("STATE_ROOT_INVALID")
        state_root = candidate
    else:
        state_root = contract_root
    return contract_root, contract, state_root


def _phase_plan(contract_root: Path) -> tuple[list[str] | None, str]:
    policy_path = contract_root / "meta" / "gate-policy.json"
    if not policy_path.is_file():
        return None, "legacy"
    try:
        policy = _read_json(policy_path)
    except (OSError, ValueError, json.JSONDecodeError):
        return None, "legacy"
    for field, source in (
        ("plannedPhases", "change"),
        ("defaultPhases", "policy-default"),
    ):
        raw = policy.get(field)
        if not isinstance(raw, list):
            continue
        phases = [str(item).strip() for item in raw if str(item).strip()]
        if (
            phases
            and len(phases) == len(set(phases))
            and all(item in WORKFLOW_PHASES for item in phases)
        ):
            return phases, source
    return None, "legacy"


def _allowed_next_phases(contract_root: Path, from_phase: str) -> list[str]:
    planned, _source = _phase_plan(contract_root)
    if planned is None:
        return list(PHASE_GRAPH.get(from_phase, ()))
    if from_phase not in planned:
        return []
    index = planned.index(from_phase)
    allowed = planned[index + 1 : index + 2]
    if from_phase in {"test", "review"} and "run" in planned:
        allowed = [*allowed, "run"]
    return list(dict.fromkeys(allowed))


def configure_phase_plan(
    project: Path,
    change: str,
    *,
    phases: list[str],
    operator: str,
    reason: str,
) -> dict[str, Any]:
    """Persist the single phase plan consumed by Context, Archive and Platform."""
    project = Path(project).resolve()
    try:
        contract_root, _contract_data, _state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "CHANGE_NOT_FOUND", "error": str(exc)}
    normalized = [str(item).strip() for item in phases if str(item).strip()]
    if (
        not normalized
        or len(normalized) != len(set(normalized))
        or any(item not in WORKFLOW_PHASES for item in normalized)
        or normalized[0] != "plan"
        or normalized[-1] != "archive"
    ):
        return {
            "ok": False,
            "code": "PHASE_PLAN_INVALID",
            "message": "phase plan must be unique, start with plan, and end with archive",
            "allowedPhases": list(WORKFLOW_PHASES),
        }
    if not operator.strip() or not reason.strip():
        return {
            "ok": False,
            "code": "PHASE_PLAN_JUSTIFICATION_REQUIRED",
        }
    policy_path = contract_root / "meta" / "gate-policy.json"
    policy = _read_json(policy_path) if policy_path.is_file() else {"schemaVersion": 1}
    skipped = [
        {
            "phase": phase,
            "reason": reason.strip(),
            "operator": operator.strip(),
            "decidedAt": _now().isoformat(),
        }
        for phase in WORKFLOW_PHASES
        if phase not in normalized and phase != "merge"
    ]
    policy["plannedPhases"] = normalized
    policy["skippedPhases"] = skipped
    policy["phasePlan"] = {
        "source": "change-override",
        "operator": operator.strip(),
        "reason": reason.strip(),
        "updatedAt": _now().isoformat(),
    }
    _write_json_atomic(policy_path, policy)
    return {
        "ok": True,
        "code": "PHASE_PLAN_CONFIGURED",
        "plannedPhases": normalized,
        "skippedPhases": skipped,
        "path": str(policy_path),
    }


def _active_changes(project: Path) -> list[str]:
    root = project.resolve() / ".harness" / "changes"
    if not root.is_dir():
        return []
    active: list[str] = []
    for child in sorted(root.iterdir()):
        path = child / "meta" / "change-context.json"
        if not child.is_dir() or not path.is_file():
            continue
        try:
            contract = _read_json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        lifecycle = contract.get("lifecycle")
        if isinstance(lifecycle, dict) and lifecycle.get("status") == "active":
            active.append(child.name)
    return active


def _paths(state_root: Path) -> dict[str, Path]:
    runtime = state_root / "runtime"
    return {
        "runtime": runtime,
        "transitions": runtime / "transitions.ndjson",
        "begins": runtime / "transition-begins.ndjson",
        "current": runtime / "current-context.json",
        "lease": runtime / "context-lease.json",
    }


def _parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _execution_root(project: Path, contract_root: Path, state_root: Path) -> Path:
    for candidate in (
        state_root / "meta" / "worktree.json",
        contract_root / "meta" / "worktree.json",
    ):
        if not candidate.is_file():
            continue
        try:
            worktree = _read_json(candidate)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        path = worktree.get("path")
        if not path and worktree.get("worktreeRoot"):
            path = Path(str(worktree["worktreeRoot"])) / contract_root.name
        if path:
            unresolved = Path(str(path))
            resolved = (
                unresolved.resolve()
                if unresolved.is_absolute()
                else (project / unresolved).resolve()
            )
            if resolved.is_dir() and _same_repository(project, resolved):
                return resolved
    return project.resolve()


def prepare_context(
    project: Path,
    *,
    phase: str,
    executor: str,
    change: str | None = None,
    display_title: str | None = None,
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    project = Path(project).resolve()
    candidates = _active_changes(project)
    if change is None:
        if not candidates:
            return {
                "ok": False,
                "code": "ACTIVE_CHANGE_MISSING",
                "candidates": [],
            }
        if len(candidates) > 1:
            return {
                "ok": False,
                "code": "ACTIVE_CHANGE_AMBIGUOUS",
                "candidates": candidates,
            }
        change = candidates[0]
    try:
        contract_root, contract, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": str(exc).split(":", 1)[0], "error": str(exc)}
    try:
        resolved_display_title = _ensure_display_title(
            contract_root, display_title
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "DISPLAY_TITLE_INVALID",
            "error": str(exc),
        }
    lifecycle = contract.get("lifecycle")
    if (
        isinstance(lifecycle, dict)
        and lifecycle.get("status") not in {None, "active"}
    ):
        return {"ok": False, "code": "CHANGE_NOT_ACTIVE", "changeName": change}
    planned_phases, phase_plan_source = _phase_plan(contract_root)
    if planned_phases is not None and phase not in planned_phases:
        return {
            "ok": False,
            "code": "PHASE_NOT_PLANNED",
            "phase": phase,
            "plannedPhases": planned_phases,
        }
    paths = _paths(state_root)
    paths["runtime"].mkdir(parents=True, exist_ok=True)
    recovery: dict[str, Any] | None = None
    if paths["lease"].is_file():
        try:
            lease = _read_json(paths["lease"])
        except (OSError, ValueError, json.JSONDecodeError):
            return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
        expiry = _parse_time(lease.get("expiresAt"))
        expired = expiry is None or _now() >= expiry
        if not expired and lease.get("owner") != executor:
            return {
                "ok": False,
                "code": "CONTEXT_LEASE_HELD",
                "holder": lease.get("owner"),
                "expiresAt": lease.get("expiresAt"),
            }
        if expired:
            recovery = {
                "code": "LEASE_EXPIRED_RECOVERED",
                "previousOwner": lease.get("owner"),
                "expiredAt": lease.get("expiresAt"),
            }

    transitions = _read_ndjson(paths["transitions"])
    latest = transitions[-1] if transitions else None
    current = (
        _read_json(paths["current"])
        if paths["current"].is_file()
        else None
    )
    if recovery is None and isinstance(current, dict) and (
        current.get("executor") != executor or current.get("phase") != phase
    ):
        valid_receipt = (
            isinstance(latest, dict)
            and latest.get("toPhase") == phase
            and latest.get("fromPhase") == current.get("phase")
        )
        if not valid_receipt:
            return {
                "ok": False,
                "code": "HANDOFF_REQUIRED",
                "fromExecutor": current.get("executor"),
                "fromPhase": current.get("phase"),
                "toExecutor": executor,
                "toPhase": phase,
            }

    execution_root = _execution_root(project, contract_root, state_root)
    now = _now()
    lease = {
        "schemaVersion": 1,
        "changeName": change,
        "phase": phase,
        "owner": executor,
        "acquiredAt": now.isoformat(),
        "expiresAt": (
            now + dt.timedelta(seconds=max(1, int(ttl_seconds)))
        ).isoformat(),
    }
    _write_json_atomic(paths["lease"], lease)
    _write_json_atomic(
        paths["current"],
        {
            "schemaVersion": 1,
            "changeName": change,
            "phase": phase,
            "executor": executor,
            "executionRoot": str(execution_root),
            "preparedAt": now.isoformat(),
            "receiptHash": latest.get("receiptHash") if latest else None,
            "displayTitle": resolved_display_title,
        },
    )
    next_phases = (
        _allowed_next_phases(contract_root, phase)
        if planned_phases is not None
        else (
            list(PHASE_GRAPH.get(str(latest.get("toPhase")), ()))
            if latest
            else ["plan", "run"]
        )
    )
    return {
        "ok": True,
        "code": "CONTEXT_PREPARED",
        "changeName": change,
        "phase": phase,
        "executionRoot": str(execution_root),
        "contractRoot": str(contract_root),
        "stateRoot": str(state_root),
        "nextPhases": next_phases,
        "plannedPhases": planned_phases,
        "phasePlanSource": phase_plan_source,
        "legacyBootstrap": not transitions,
        "latestTransition": latest,
        "lease": lease,
        "recovery": recovery,
        "displayTitle": resolved_display_title,
    }


def _invalidate_for_fixback(
    state_root: Path,
    *,
    transition_hash: str,
    from_phase: str,
    to_phase: str,
) -> dict[str, Any]:
    # A review→run handoff happens before product files are changed. Invalidating
    # every target here made unrelated API/build evidence unusable. The Fixback
    # resolver now invalidates only entries whose inputsFiles intersect the
    # issue's actual changedFiles.
    record = {
        "schemaVersion": 1,
        "code": "FIXBACK_INVALIDATION_DEFERRED",
        "transitionHash": transition_hash,
        "fromPhase": from_phase,
        "toPhase": to_phase,
        "targetIds": [],
        "deferred": True,
        "reason": "changed-files-not-known",
        "createdAt": _now().isoformat(),
    }
    _append_ndjson(
        state_root / "evidence" / "verification-invalidations.ndjson",
        record,
    )
    return record


def close_transition(
    project: Path,
    change: str,
    *,
    from_phase: str,
    to_phase: str,
    executor: str | None,
    artifacts: list[str] | None = None,
    status: str = "OK",
) -> dict[str, Any]:
    project = Path(project).resolve()
    try:
        contract_root, _contract_data, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "CHANGE_NOT_FOUND", "error": str(exc)}
    allowed_next = _allowed_next_phases(contract_root, from_phase)
    if to_phase not in allowed_next:
        planned_phases, source = _phase_plan(contract_root)
        return {
            "ok": False,
            "code": "TRANSITION_ILLEGAL",
            "fromPhase": from_phase,
            "toPhase": to_phase,
            "allowedNextPhases": allowed_next,
            "plannedPhases": planned_phases,
            "phasePlanSource": source,
        }
    paths = _paths(state_root)

    artifact_entries: list[dict[str, Any]] = []
    for raw in artifacts or []:
        requested = Path(raw)
        candidates = (
            [requested]
            if requested.is_absolute()
            else [project / requested, contract_root / requested]
        )
        valid: list[Path] = []
        for candidate in candidates:
            try:
                resolved_candidate = candidate.resolve()
            except OSError:
                continue
            if resolved_candidate in valid:
                continue
            if resolved_candidate.is_relative_to(project) and resolved_candidate.is_file():
                valid.append(resolved_candidate)
        if len(valid) > 1:
            return {
                "ok": False,
                "code": "TRANSITION_ARTIFACT_AMBIGUOUS",
                "path": raw,
                "candidates": [item.relative_to(project).as_posix() for item in valid],
                "message": "relative artifact exists under both project and change roots",
            }
        if not valid:
            return {
                "ok": False,
                "code": "TRANSITION_ARTIFACT_INVALID",
                "path": raw,
                "acceptedBases": [str(project), str(contract_root)],
                "examples": [
                    str(contract_root / "meta" / "plan-finalization.json"),
                    f".harness/changes/{change}/meta/plan-finalization.json",
                    "meta/plan-finalization.json",
                ],
            }
        resolved_artifact = valid[0]
        artifact_entries.append(
            {
                "path": resolved_artifact.relative_to(project).as_posix(),
                "sha256": _sha256(resolved_artifact),
            }
        )

    transitions = _read_ndjson(paths["transitions"])
    if not paths["lease"].is_file():
        latest = transitions[-1] if transitions else None
        if (
            isinstance(latest, dict)
            and latest.get("fromPhase") == from_phase
            and latest.get("toPhase") == to_phase
            and latest.get("status") == status
            and latest.get("artifacts") == artifact_entries
            and (executor is None or latest.get("executor") == executor)
        ):
            return {
                "ok": True,
                "code": "TRANSITION_ALREADY_CLOSED",
                "idempotent": True,
                "receipt": latest,
                "path": str(paths["transitions"]),
                "invalidation": None,
            }
        return {"ok": False, "code": "CONTEXT_LEASE_REQUIRED"}
    try:
        lease = _read_json(paths["lease"])
    except (OSError, ValueError, json.JSONDecodeError):
        return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
    effective_executor = executor or str(lease.get("owner") or "")
    if not effective_executor:
        return {"ok": False, "code": "CONTEXT_EXECUTOR_REQUIRED"}
    if lease.get("owner") != effective_executor or lease.get("phase") != from_phase:
        return {
            "ok": False,
            "code": "CONTEXT_LEASE_MISMATCH",
            "holder": lease.get("owner"),
            "leasePhase": lease.get("phase"),
        }
    expiry = _parse_time(lease.get("expiresAt"))
    if expiry is None or _now() >= expiry:
        return {"ok": False, "code": "CONTEXT_LEASE_EXPIRED"}

    previous_hash = transitions[-1].get("receiptHash") if transitions else None
    attempt = (
        1
        + sum(
            1
            for item in transitions
            if item.get("fromPhase") == from_phase
            and item.get("toPhase") == to_phase
        )
    )
    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "changeName": change,
        "fromPhase": from_phase,
        "toPhase": to_phase,
        "status": status,
        "executor": effective_executor,
        "productCommit": _head(project),
        "artifacts": artifact_entries,
        "attempt": attempt,
        "closedAt": _now().isoformat(),
        "previousReceiptHash": previous_hash,
    }
    receipt["receiptHash"] = _payload_hash(receipt)
    _append_ndjson(paths["transitions"], receipt)
    paths["lease"].unlink(missing_ok=True)
    invalidation = None
    if to_phase == "run" and from_phase in {"test", "review"}:
        invalidation = _invalidate_for_fixback(
            state_root,
            transition_hash=receipt["receiptHash"],
            from_phase=from_phase,
            to_phase=to_phase,
        )
    return {
        "ok": True,
        "code": "TRANSITION_CLOSED",
        "receipt": receipt,
        "path": str(paths["transitions"]),
        "invalidation": invalidation,
    }


def begin_transition(
    project: Path,
    change: str,
    *,
    phase: str,
    executor: str,
) -> dict[str, Any]:
    project = Path(project).resolve()
    try:
        _contract_root, _contract_data, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "CHANGE_NOT_FOUND", "error": str(exc)}
    paths = _paths(state_root)
    transitions = _read_ndjson(paths["transitions"])
    if not transitions:
        return {
            "ok": False,
            "code": "LEGACY_BOOTSTRAP_REQUIRED",
            "legacyBootstrap": True,
        }
    receipt = transitions[-1]
    if receipt.get("toPhase") != phase:
        return {
            "ok": False,
            "code": "HANDOFF_REQUIRED",
            "expectedPhase": receipt.get("toPhase"),
            "requestedPhase": phase,
        }
    unhashed = {key: value for key, value in receipt.items() if key != "receiptHash"}
    issues: list[str] = []
    if _payload_hash(unhashed) != receipt.get("receiptHash"):
        issues.append("receipt hash mismatch")
    if len(transitions) > 1 and receipt.get("previousReceiptHash") != transitions[-2].get(
        "receiptHash"
    ):
        issues.append("receipt chain mismatch")
    if receipt.get("productCommit") != _head(project):
        issues.append("HEAD drift")
    for artifact in receipt.get("artifacts", []):
        if not isinstance(artifact, dict):
            issues.append("artifact entry invalid")
            continue
        path = (project / str(artifact.get("path") or "")).resolve()
        if (
            not path.is_relative_to(project)
            or not path.is_file()
            or _sha256(path) != artifact.get("sha256")
        ):
            issues.append(f"artifact drift: {artifact.get('path')}")
    if issues:
        return {
            "ok": False,
            "code": "HANDOFF_IDENTITY_MISMATCH",
            "issues": issues,
            "receipt": receipt,
        }
    acknowledgment = {
        "schemaVersion": 1,
        "changeName": change,
        "phase": phase,
        "executor": executor,
        "receiptHash": receipt["receiptHash"],
        "begunAt": _now().isoformat(),
    }
    _append_ndjson(paths["begins"], acknowledgment)
    _write_json_atomic(
        paths["current"],
        {
            "schemaVersion": 1,
            "changeName": change,
            "phase": phase,
            "executor": executor,
            "executionRoot": str(_execution_root(project, project / ".harness/changes" / change, state_root)),
            "receiptHash": receipt["receiptHash"],
            "begunAt": acknowledgment["begunAt"],
        },
    )
    return {
        "ok": True,
        "code": "TRANSITION_BEGUN",
        "receipt": receipt,
        "acknowledgment": acknowledgment,
    }


def context_view(project: Path, change: str) -> dict[str, Any]:
    project = Path(project).resolve()
    try:
        contract_root, contract, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "CHANGE_NOT_FOUND", "error": str(exc)}
    paths = _paths(state_root)
    transitions = _read_ndjson(paths["transitions"])
    begins = _read_ndjson(paths["begins"])
    current = (
        _read_json(paths["current"]) if paths["current"].is_file() else None
    )
    ledger_path = state_root / "evidence" / "verification-ledger.json"
    findings_path = state_root / "evidence" / "review-findings.json"
    events_paths = [state_root / "events.ndjson"]
    if state_root != contract_root:
        events_paths.append(contract_root / "events.ndjson")
    return {
        "ok": True,
        "code": "CONTEXT_VIEW",
        "changeName": change,
        "lifecycle": contract.get("lifecycle"),
        "currentPhase": (
            transitions[-1].get("toPhase")
            if transitions
            else current.get("phase")
            if isinstance(current, dict)
            else None
        ),
        "transitions": transitions,
        "attemptHistory": {"closes": transitions, "begins": begins},
        "current": current,
        "ledger": _read_json(ledger_path) if ledger_path.is_file() else None,
        "findings": _read_json(findings_path) if findings_path.is_file() else None,
        "events": [
            item
            for path in events_paths
            for item in _read_ndjson(path)
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_context.py")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--json", action="store_true")
    prepare.add_argument("--project", required=True, type=Path)
    prepare.add_argument("--change")
    prepare.add_argument("--phase", required=True)
    prepare.add_argument("--executor", required=True)
    prepare.add_argument("--title")
    prepare.add_argument("--ttl-seconds", type=int, default=3600)
    close = sub.add_parser("close")
    close.add_argument("--json", action="store_true")
    close.add_argument("--project", required=True, type=Path)
    close.add_argument("--change", required=True)
    close.add_argument("--from-phase", required=True)
    close.add_argument("--to-phase", required=True)
    close.add_argument("--executor", required=True)
    close.add_argument("--artifact", action="append", default=[])
    close.add_argument("--status", default="OK")
    begin = sub.add_parser("begin")
    begin.add_argument("--json", action="store_true")
    begin.add_argument("--project", required=True, type=Path)
    begin.add_argument("--change", required=True)
    begin.add_argument("--phase", required=True)
    begin.add_argument("--executor", required=True)
    configure = sub.add_parser("configure-plan")
    configure.add_argument("--json", action="store_true")
    configure.add_argument("--project", required=True, type=Path)
    configure.add_argument("--change", required=True)
    configure.add_argument("--phases", required=True)
    configure.add_argument("--operator", required=True)
    configure.add_argument("--reason", required=True)
    view = sub.add_parser("view")
    view.add_argument("--json", action="store_true")
    view.add_argument("--project", required=True, type=Path)
    view.add_argument("--change", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "prepare":
        result = prepare_context(
            args.project,
            phase=args.phase,
            executor=args.executor,
            change=args.change,
            display_title=args.title,
            ttl_seconds=args.ttl_seconds,
        )
    elif args.command == "close":
        result = close_transition(
            args.project,
            args.change,
            from_phase=args.from_phase,
            to_phase=args.to_phase,
            executor=args.executor,
            artifacts=args.artifact,
            status=args.status,
        )
    elif args.command == "begin":
        result = begin_transition(
            args.project,
            args.change,
            phase=args.phase,
            executor=args.executor,
        )
    elif args.command == "configure-plan":
        result = configure_phase_plan(
            args.project,
            args.change,
            phases=[item.strip() for item in args.phases.split(",") if item.strip()],
            operator=args.operator,
            reason=args.reason,
        )
    else:
        result = context_view(args.project, args.change)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
