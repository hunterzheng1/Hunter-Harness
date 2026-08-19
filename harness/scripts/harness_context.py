#!/usr/bin/env python3
"""Cross-agent workflow context and append-only transition receipts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_ledger as hl  # noqa: E402


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


@contextmanager
def _exclusive_state_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 2
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"context state locked: {path}")
            time.sleep(0.02)
    try:
        yield
    finally:
        os.close(descriptor)
        path.unlink(missing_ok=True)


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
        encoding="utf-8",
        errors="replace",
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
        encoding="utf-8",
        errors="replace",
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


def _contract_error_code(exc: BaseException) -> str:
    """Keep PROJECT_ROOT_INVALID distinct from a genuinely missing change."""
    if str(exc).startswith("PROJECT_ROOT_INVALID"):
        return "PROJECT_ROOT_INVALID"
    return "CHANGE_NOT_FOUND"


def _contract(project: Path, change: str) -> tuple[Path, dict[str, Any], Path]:
    root = project.resolve()
    # A bare project *name* (--project udp) resolves to <cwd>/udp and then
    # reports CHANGE_NOT_FOUND, which sends the caller hunting for the change
    # instead of fixing the argument. Separate the two failures.
    if not root.is_dir():
        raise ValueError(
            f"PROJECT_ROOT_INVALID: {root} is not a directory — --project takes "
            "a path to the project root (use '.'), not the project name"
        )
    changes_root = (root / ".harness" / "changes").resolve()
    if not changes_root.is_dir():
        raise ValueError(
            f"PROJECT_ROOT_INVALID: {changes_root} does not exist — "
            f"{root} is not a harness project root"
        )
    contract_root = (root / ".harness" / "changes" / change).resolve()
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
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
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
    worktree_path = contract_root / "meta" / "worktree.json"
    if worktree_path.is_file():
        try:
            worktree = _read_json(worktree_path)
        except (OSError, ValueError, json.JSONDecodeError):
            worktree = {}
        if bool(worktree.get("requested") or worktree.get("created")) and "merge" not in normalized:
            normalized.insert(normalized.index("archive"), "merge")
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
    declared = False
    # Context、ledger 与 gate 必须以同一份可信 worktree 契约为准。split
    # state 可能携带运行元数据，因此两个根都交给统一解析器检查。
    for change_root in (state_root, contract_root):
        inferred = hl.infer_execution_project_root(change_root)
        if inferred is not None:
            return inferred
        declared = declared or hl.declares_execution_worktree(change_root)
    if declared:
        raise ValueError("EXECUTION_WORKTREE_INVALID")
    return project.resolve()


def _reselect_review_fixback(
    project: Path,
    change: str,
    *,
    contract_root: Path,
    state_root: Path,
    executor: str,
) -> dict[str, Any]:
    """Supersede an unbegun review→submit choice with review→run."""

    paths = _paths(state_root)
    with _exclusive_state_lock(paths["runtime"] / "branch-selection.lock"):
        transitions = _read_ndjson(paths["transitions"])
        latest = transitions[-1] if transitions else None
        if (
            isinstance(latest, dict)
            and latest.get("fromPhase") == "review"
            and latest.get("toPhase") == "run"
            and latest.get("trigger") == "review-fixback"
        ):
            return {
                "ok": True,
                "code": "FIXBACK_BRANCH_ALREADY_SELECTED",
                "receipt": latest,
            }
        if not (
            isinstance(latest, dict)
            and latest.get("fromPhase") == "review"
            and latest.get("toPhase") == "submit"
        ):
            return {
                "ok": False,
                "code": "FIXBACK_RESELECT_UNAVAILABLE",
                "message": "当前没有可安全重选的评审后继分支。",
            }
        begins = _read_ndjson(paths["begins"])
        submit_begun = any(
            isinstance(item, dict)
            and item.get("phase") == "submit"
            and item.get("receiptHash") == latest.get("receiptHash")
            for item in begins
        )
        event_paths = [state_root / "events.ndjson"]
        if state_root != contract_root:
            event_paths.append(contract_root / "events.ndjson")
        submit_started = any(
            item.get("phase") == "submit" and item.get("type") == "phase.start"
            for path in event_paths
            for item in _read_ndjson(path)
        )
        if submit_begun or submit_started:
            return {
                "ok": False,
                "code": "FIXBACK_RESELECT_UNSAFE",
                "message": "提交阶段已经开始，不能自动切回修复；请先完成或明确恢复提交现场。",
            }
        if paths["lease"].is_file():
            try:
                lease = _read_json(paths["lease"])
            except (OSError, ValueError, json.JSONDecodeError):
                return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
            if lease.get("phase") != "submit" or lease.get("owner") != executor:
                return {
                    "ok": False,
                    "code": "FIXBACK_RESELECT_UNSAFE",
                    "message": "当前阶段租约不属于本次可撤销的提交准备。",
                }
            paths["lease"].unlink(missing_ok=True)
        # Any submit context present here was only prepared, never begun.  The
        # new run context is written by prepare_context after this atomic choice.
        paths["current"].unlink(missing_ok=True)

        receipt: dict[str, Any] = {
            "schemaVersion": 1,
            "changeName": change,
            "fromPhase": "review",
            "toPhase": "run",
            "status": "OK",
            "executor": executor,
            "productCommit": _head(project),
            "artifacts": [],
            "attempt": 1
            + sum(
                1
                for item in transitions
                if item.get("fromPhase") == "review"
                and item.get("toPhase") == "run"
            ),
            "closedAt": _now().isoformat(),
            "previousReceiptHash": latest.get("receiptHash"),
            "supersedesReceiptHash": latest.get("receiptHash"),
            "trigger": "review-fixback",
            "selectionReason": "用户选择处理评审中的代码修复项",
        }
        receipt["receiptHash"] = _payload_hash(receipt)
        _append_ndjson(paths["transitions"], receipt)
        invalidation = _invalidate_for_fixback(
            state_root,
            transition_hash=receipt["receiptHash"],
            from_phase="review",
            to_phase="run",
        )
        return {
            "ok": True,
            "code": "FIXBACK_BRANCH_RESELECTED",
            "receipt": receipt,
            "invalidation": invalidation,
        }


def _claim_prepared_context(
    project: Path,
    change: str,
    *,
    contract_root: Path,
    state_root: Path,
    phase: str,
    executor: str,
    ttl_seconds: int,
    preparation_id: str | None,
    display_title: str | None,
) -> dict[str, Any]:
    """Atomically check and claim the lease/current preparation pair."""

    paths = _paths(state_root)
    with _exclusive_state_lock(paths["runtime"] / "branch-selection.lock"):
        recovery: dict[str, Any] | None = None
        if paths["lease"].is_file():
            try:
                existing_lease = _read_json(paths["lease"])
            except (OSError, ValueError, json.JSONDecodeError):
                return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
            expiry = _parse_time(existing_lease.get("expiresAt"))
            expired = expiry is None or _now() >= expiry
            if not expired and existing_lease.get("owner") != executor:
                return {
                    "ok": False,
                    "code": "CONTEXT_LEASE_HELD",
                    "holder": existing_lease.get("owner"),
                    "expiresAt": existing_lease.get("expiresAt"),
                }
            if (
                not expired
                and preparation_id is not None
                and existing_lease.get("preparationId") != preparation_id
            ):
                return {
                    "ok": False,
                    "code": "CONTEXT_PREPARATION_ACTIVE",
                    "message": "已有一轮修复准备或执行正在进行，本次重复启动未修改现有上下文。",
                    "preparationId": existing_lease.get("preparationId"),
                    "expiresAt": existing_lease.get("expiresAt"),
                }
            if expired:
                recovery = {
                    "code": "LEASE_EXPIRED_RECOVERED",
                    "previousOwner": existing_lease.get("owner"),
                    "expiredAt": existing_lease.get("expiresAt"),
                }

        transitions = _read_ndjson(paths["transitions"])
        latest = transitions[-1] if transitions else None
        try:
            current = (
                _read_json(paths["current"])
                if paths["current"].is_file()
                else None
            )
        except (OSError, ValueError, json.JSONDecodeError):
            return {"ok": False, "code": "CONTEXT_CURRENT_INVALID"}
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

        try:
            execution_root = _execution_root(project, contract_root, state_root)
        except ValueError as exc:
            return {
                "ok": False,
                "code": "EXECUTION_WORKTREE_INVALID",
                "error": str(exc),
            }
        now = _now()
        lease: dict[str, Any] = {
            "schemaVersion": 1,
            "changeName": change,
            "phase": phase,
            "owner": executor,
            "acquiredAt": now.isoformat(),
            "expiresAt": (
                now + dt.timedelta(seconds=max(1, int(ttl_seconds)))
            ).isoformat(),
        }
        if preparation_id is not None:
            lease["preparationId"] = preparation_id
        current_context: dict[str, Any] = {
            "schemaVersion": 1,
            "changeName": change,
            "phase": phase,
            "executor": executor,
            "executionRoot": str(execution_root),
            "preparedAt": now.isoformat(),
            "receiptHash": latest.get("receiptHash") if latest else None,
            "displayTitle": display_title,
        }
        if preparation_id is not None:
            current_context["preparationId"] = preparation_id
        _write_json_atomic(paths["lease"], lease)
        _write_json_atomic(paths["current"], current_context)
        return {
            "ok": True,
            "lease": lease,
            "current": current_context,
            "transitions": transitions,
            "latestTransition": latest,
            "recovery": recovery,
            "executionRoot": str(execution_root),
        }


def prepare_context(
    project: Path,
    *,
    phase: str,
    executor: str,
    change: str | None = None,
    display_title: str | None = None,
    ttl_seconds: int = 3600,
    trigger: str | None = None,
    preparation_id: str | None = None,
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
    reselection: dict[str, Any] | None = None
    if trigger == "review-fixback" and phase == "run":
        reselection = _reselect_review_fixback(
            project,
            change,
            contract_root=contract_root,
            state_root=state_root,
            executor=executor,
        )
        if not reselection.get("ok"):
            return reselection
    # v2 计划的交接凭证由此补录：finalize 不写 context 事务，缺它 run 阶段进不去
    if phase != "plan":
        _bootstrap_v2_plan_transition(
            project,
            change,
            contract_root=contract_root,
            state_root=state_root,
            to_phase=phase,
            executor=executor,
        )
    claim = _claim_prepared_context(
        project,
        change,
        contract_root=contract_root,
        state_root=state_root,
        phase=phase,
        executor=executor,
        ttl_seconds=ttl_seconds,
        preparation_id=preparation_id,
        display_title=resolved_display_title,
    )
    if not claim.get("ok"):
        return claim
    transitions = claim["transitions"]
    latest = claim["latestTransition"]
    execution_root = Path(claim["executionRoot"])
    lease = claim["lease"]
    recovery = claim["recovery"]
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
        "branchSelection": reselection,
    }


def _plan_run_identity(change_dir: Path) -> tuple[str, int] | None:
    """已存在的 plan `phase.start` 身份（run-id, attempt）。

    finalize 按生命周期身份 fail-closed：重跑引导时换一个 run-id，整条链路就对不上。
    因此引导必须复用已有身份，而不是每次新生成。
    """
    for item in reversed(_read_ndjson(change_dir / "events.ndjson")):
        if item.get("phase") != "plan" or item.get("type") != "phase.start":
            continue
        run_id = item.get("run_id")
        if isinstance(run_id, str) and run_id:
            attempt = item.get("attempt")
            return run_id, attempt if isinstance(attempt, int) and attempt > 0 else 1
    return None


def bootstrap_plan(
    project: Path,
    *,
    change: str,
    executor: str,
    display_title: str | None = None,
    stage: str = "plan",
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    """阶段 0 一次性引导：doctor + prepare + capture + classify + phase.start。

    拆成五条子进程调用时，每条的完整 argv 都要调用方记住（少 `--project` 或
    `--change-dir` 就白跑一轮），run-id 还要调用方自己保证小写字母开头。这些都是
    确定性工作，交给脚本做；调用方只需要一次调用和一份紧凑摘要。

    重跑安全：已有 plan `phase.start` 时复用同一 run-id / attempt，不追加第二条。
    """
    import uuid

    import harness_change as hchg
    import harness_events as he
    import harness_gate as hg
    import harness_runtime as hr
    import harness_state as hs

    project = Path(project).resolve()
    changes_root = project / ".harness" / "changes"
    if not changes_root.is_dir():
        return {
            "ok": False,
            "code": "PROJECT_ROOT_INVALID",
            "error": f"{changes_root} 不存在——先在该项目运行 hunter-harness init",
        }

    # 新 change 的目录此前没有任何脚本负责创建，靠的是后续 Write 的副作用；
    # 引导阶段显式建立骨架，prepare 才有 contract 可读
    change_dir = changes_root / change
    created_change = not change_dir.is_dir()
    if created_change:
        (change_dir / "meta").mkdir(parents=True, exist_ok=True)
    hchg.migrate_change(project, change)

    prepared = prepare_context(
        project,
        phase="plan",
        executor=executor,
        change=change,
        display_title=display_title,
        ttl_seconds=ttl_seconds,
    )
    if not prepared.get("ok"):
        return prepared

    change_name = str(prepared["changeName"])
    # executionRoot 是代码执行根（无 worktree 时等于项目根），change_dir 才是状态目录。
    # 计划产物一律落 change_dir，混用会把 gate-policy/events 写到项目根去。
    change_dir = (changes_root / change_name).resolve()
    execution_root = Path(prepared["executionRoot"])

    # doctor 失败不阻断引导：它是环境体检，结论随摘要返回给调用方判断
    try:
        health = hr.doctor(project, change_dir, agent=executor)
    except Exception as exc:  # noqa: BLE001 - 体检失败要报告而不是中断引导
        health = {"ok": False, "code": "DOCTOR_FAILED", "error": str(exc)}

    # 首次 capture 把当时的 HEAD 固定为不可变 changeBase（design §3.6）
    snapshot, changed_segments = hs.capture_current_state(
        project=project,
        change_dir=change_dir,
        change_name=change_name,
        worktree_root=project,
    )
    git_state = snapshot.get("git") or {}

    workflow = hg._load_workflow_policy(project=project)
    classification = hg.classify_risk(change_dir, stage, workflow=workflow)
    classification.setdefault("tierOverride", None)
    classification["classifiedAt"] = _now().isoformat().replace("+00:00", "Z")
    policy_path = change_dir / "meta" / "gate-policy.json"
    hg._write_json(policy_path, hg.gate_policy_document(classification))

    identity = _plan_run_identity(change_dir)
    reused = identity is not None
    if identity is None:
        # v2 identity：必须小写字母开头，裸 UUID 有 10/16 概率数字开头被拒
        run_id = f"plan_{uuid.uuid4()}"
        attempt = 1
        appended = he.append_event(
            change_dir,
            phase="plan",
            type_="phase.start",
            run_id=run_id,
            attempt=attempt,
            executor_tool=executor,
            note=f"/harness-plan 引导：{change_name}",
        )
        if not appended.get("ok", True):
            return appended
    else:
        run_id, attempt = identity

    return {
        "ok": True,
        "code": "PLAN_BOOTSTRAPPED",
        "changeName": change_name,
        "displayTitle": prepared.get("displayTitle"),
        "changeCreated": created_change,
        "changeDir": str(change_dir),
        "executionRoot": str(execution_root),
        "runId": run_id,
        "attempt": attempt,
        "reused": reused,
        "tier": classification.get("tier"),
        "tierSource": classification.get("source"),
        "defaultPhases": list(classification.get("defaultPhases") or []),
        "conditionalPhases": list(classification.get("conditionalPhases") or []),
        "requiredValidations": list(classification.get("requiredValidations") or []),
        "gatePolicyPath": str(policy_path),
        "plannedPhases": prepared.get("plannedPhases"),
        "changeBase": git_state.get("base"),
        "head": git_state.get("head"),
        "changedSegments": sorted(changed_segments),
        "legacyBootstrap": prepared.get("legacyBootstrap"),
        "doctorOk": bool(health.get("ok", True)),
        "doctor": health,
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


def _committed_publication_journal(contract_root: Path) -> Path | None:
    """已 committed 的 v2 发布 journal —— plan 确实完成的机器证据。"""
    journal_dir = contract_root / "meta" / "publication-journals"
    if not journal_dir.is_dir():
        return None
    for path in sorted(journal_dir.glob("*.json")):
        try:
            payload = _read_json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and payload.get("state") == "committed":
            return path
    return None


def _published_plan_artifacts(project: Path, contract_root: Path, change: str) -> list[dict[str, Any]]:
    """交接携带的 v2 发布产物（存在者入账，缺失者跳过）。"""
    entries: list[dict[str, Any]] = []
    for rel in (
        f"plans/{change}-design.md",
        f"plans/{change}-plan.md",
        f"plans/{change}-implementation-detail.md",
        f"plans/{change}-test-scenarios.md",
        "meta/scenario-manifest.json",
    ):
        candidate = contract_root / rel
        if candidate.is_file():
            entries.append(
                {
                    "path": candidate.resolve().relative_to(project).as_posix(),
                    "sha256": _sha256(candidate),
                }
            )
    return entries


def _bootstrap_v2_plan_transition(
    project: Path,
    change: str,
    *,
    contract_root: Path,
    state_root: Path,
    to_phase: str,
    executor: str,
) -> dict[str, Any] | None:
    """v2 发布已 committed 却没有交接凭证时，补录 plan → to_phase 凭证。

    v2 plan finalize 只写 plan-events.ndjson 与发布 journal，不碰 context 事务
    存储，于是 run 阶段 prepare 必报 HANDOFF_REQUIRED、begin 必报
    LEGACY_BOOTSTRAP_REQUIRED——两个错误都不给恢复路径，调用方只能读脚本源码
    自己拼出 classify + configure-plan + close，参数全靠现编，可审计性更差。

    committed 的发布 journal 是比人工 close 更强的完成证据：据此补录，并在凭证上
    留 bootstrapSource/bootstrapEvidence，事后能与人工 close 区分。没有该证据时
    返回 None，交接继续 fail-closed。
    """
    paths = _paths(state_root)
    if _read_ndjson(paths["transitions"]):
        return None
    if to_phase not in _allowed_next_phases(contract_root, "plan"):
        return None
    journal = _committed_publication_journal(contract_root)
    if journal is None:
        return None
    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "changeName": change,
        "fromPhase": "plan",
        "toPhase": to_phase,
        "status": "OK",
        "executor": executor,
        "productCommit": _head(project),
        "artifacts": _published_plan_artifacts(project, contract_root, change),
        "attempt": 1,
        "closedAt": _now().isoformat(),
        "previousReceiptHash": None,
        "bootstrapSource": "plan_publication_journal",
        "bootstrapEvidence": journal.resolve().relative_to(project).as_posix(),
    }
    receipt["receiptHash"] = _payload_hash(receipt)
    _append_ndjson(paths["transitions"], receipt)
    return receipt


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
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
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
        artifact_bases: list[Path] = []
        for base in (project, contract_root, state_root):
            resolved_base = base.resolve()
            if resolved_base not in artifact_bases:
                artifact_bases.append(resolved_base)
        candidates = (
            [requested]
            if requested.is_absolute()
            else [base / requested for base in artifact_bases]
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
                "acceptedBases": [str(base) for base in artifact_bases],
                "examples": [
                    str(contract_root / "meta" / "plan-finalization.json"),
                    f".harness/changes/{change}/meta/plan-finalization.json",
                    f".harness/state/changes/{change}/evidence/verification-ledger.json",
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
    # Owner and phase already matched above, so nobody took this lease over: a
    # takeover rewrites the file and would have produced CONTEXT_LEASE_MISMATCH.
    # A lapsed deadline therefore proves only that the phase outlived the TTL.
    expiry = _parse_time(lease.get("expiresAt"))
    lease_lapsed = expiry is None or _now() >= expiry

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
    if lease_lapsed:
        # Recorded, not hidden: the phase ran past its lease without a renewal.
        receipt["leaseLapsed"] = {
            "expiresAt": lease.get("expiresAt"),
            "acquiredAt": lease.get("acquiredAt"),
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


def _begin_transition_unlocked(
    project: Path,
    change: str,
    *,
    phase: str,
    executor: str,
    preparation_id: str | None = None,
) -> dict[str, Any]:
    project = Path(project).resolve()
    try:
        contract_root, _contract_data, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
    paths = _paths(state_root)
    try:
        execution_root = _execution_root(project, contract_root, state_root)
    except ValueError as exc:
        return {
            "ok": False,
            "code": "EXECUTION_WORKTREE_INVALID",
            "error": str(exc),
        }
    if preparation_id is not None:
        current = _read_json(paths["current"]) if paths["current"].is_file() else None
        lease = _read_json(paths["lease"]) if paths["lease"].is_file() else None
        if not (
            isinstance(current, dict)
            and isinstance(lease, dict)
            and current.get("preparationId") == preparation_id
            and lease.get("preparationId") == preparation_id
        ):
            return {
                "ok": False,
                "code": "CONTEXT_PREPARATION_MISMATCH",
                "message": "本次修复准备凭证与当前上下文不一致，未启动新阶段。",
            }
    transitions = _read_ndjson(paths["transitions"])
    if not transitions and phase != "plan":
        # prepare 之外的入口（或跳过了 prepare）同样要能从发布证据恢复
        _bootstrap_v2_plan_transition(
            project,
            change,
            contract_root=contract_root,
            state_root=state_root,
            to_phase=phase,
            executor=executor,
        )
        transitions = _read_ndjson(paths["transitions"])
    if not transitions:
        return {
            "ok": False,
            "code": "LEGACY_BOOTSTRAP_REQUIRED",
            "legacyBootstrap": True,
            "message": (
                "没有交接凭证。v2 计划应有 committed 的 meta/publication-journals/*.json "
                "作为补录证据；legacy 计划需先完成 plan 阶段的 close。"
                "首次进入某阶段（还没有任何 transition 凭证）时不要用 context begin——"
                "改跑 `harness_gate.py begin --change-dir .harness/changes/<change> "
                "--phase <phase> --run-id <phase>_<uuid4hex> --note \"<触发指令>\"`，"
                "它会领取租约并写好 phase.start。"
            ),
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
    if preparation_id is not None:
        acknowledgment["preparationId"] = preparation_id
    _append_ndjson(paths["begins"], acknowledgment)
    current_context = {
            "schemaVersion": 1,
            "changeName": change,
            "phase": phase,
            "executor": executor,
            "executionRoot": str(execution_root),
            "receiptHash": receipt["receiptHash"],
            "begunAt": acknowledgment["begunAt"],
        }
    if preparation_id is not None:
        current_context["preparationId"] = preparation_id
    _write_json_atomic(paths["current"], current_context)
    return {
        "ok": True,
        "code": "TRANSITION_BEGUN",
        "receipt": receipt,
        "acknowledgment": acknowledgment,
    }


def begin_transition(
    project: Path,
    change: str,
    *,
    phase: str,
    executor: str,
    preparation_id: str | None = None,
) -> dict[str, Any]:
    """Acknowledge a transition while serializing branch selection."""

    project = Path(project).resolve()
    try:
        _contract_root, _contract_data, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
    paths = _paths(state_root)
    with _exclusive_state_lock(paths["runtime"] / "branch-selection.lock"):
        return _begin_transition_unlocked(
            project,
            change,
            phase=phase,
            executor=executor,
            preparation_id=preparation_id,
        )


def cancel_prepared_context(
    project: Path,
    change: str,
    *,
    phase: str,
    executor: str,
    preparation_id: str | None = None,
) -> dict[str, Any]:
    """Remove a target-phase preparation that never obtained its gate."""

    project = Path(project).resolve()
    try:
        _contract_root, _contract_data, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
    paths = _paths(state_root)
    removed: list[str] = []
    receipt_hash: str | None = None
    with _exclusive_state_lock(paths["runtime"] / "branch-selection.lock"):
        if paths["current"].is_file():
            try:
                current = _read_json(paths["current"])
            except (OSError, ValueError, json.JSONDecodeError):
                current = None
            if isinstance(current, dict) and (
                current.get("phase") == phase and current.get("executor") == executor
                and (
                    preparation_id is None
                    or current.get("preparationId") == preparation_id
                )
            ):
                receipt_hash = str(current.get("receiptHash") or "") or None
                paths["current"].unlink(missing_ok=True)
                removed.append("current")
        if paths["lease"].is_file():
            try:
                lease = _read_json(paths["lease"])
            except (OSError, ValueError, json.JSONDecodeError):
                lease = None
            if isinstance(lease, dict) and (
                lease.get("phase") == phase and lease.get("owner") == executor
                and (
                    preparation_id is None
                    or lease.get("preparationId") == preparation_id
                )
            ):
                paths["lease"].unlink(missing_ok=True)
                removed.append("lease")
        begins = _read_ndjson(paths["begins"])
        retained = [
            item
            for item in begins
            if not (
                receipt_hash is not None
                and item.get("phase") == phase
                and item.get("executor") == executor
                and item.get("receiptHash") == receipt_hash
                and (
                    preparation_id is None
                    or item.get("preparationId") == preparation_id
                )
            )
        ]
        if len(retained) != len(begins):
            paths["begins"].parent.mkdir(parents=True, exist_ok=True)
            payload = "".join(
                json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n"
                for item in retained
            )
            fd, raw = tempfile.mkstemp(
                prefix=f".{paths['begins'].name}.",
                suffix=".tmp",
                dir=str(paths["begins"].parent),
            )
            temporary = Path(raw)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, paths["begins"])
            finally:
                temporary.unlink(missing_ok=True)
            removed.append("begin")
    return {
        "ok": True,
        "code": (
            "PREPARED_CONTEXT_CANCELLED"
            if removed
            else "PREPARED_CONTEXT_NOT_OWNED"
        ),
        "removed": removed,
    }


def renew_lease(
    project: Path,
    change: str,
    *,
    executor: str,
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    """Extend the current phase lease in place.

    Only the recorded owner may renew, and only while no other executor has
    taken the lease over. Renewal touches nothing but ``expiresAt``, so it is
    safe to call on a heartbeat during a long phase.
    """
    project = project.resolve()
    try:
        _, _, state_root = _contract(project, change)
    except ValueError as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
    paths = _paths(state_root)
    if not paths["lease"].is_file():
        return {"ok": False, "code": "CONTEXT_LEASE_REQUIRED"}
    with _exclusive_state_lock(paths["runtime"] / "branch-selection.lock"):
        try:
            lease = _read_json(paths["lease"])
        except (OSError, ValueError, json.JSONDecodeError):
            return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
        if lease.get("owner") != executor:
            return {
                "ok": False,
                "code": "CONTEXT_LEASE_MISMATCH",
                "holder": lease.get("owner"),
            }
        expiry = _parse_time(lease.get("expiresAt"))
        lapsed = expiry is None or _now() >= expiry
        lease["expiresAt"] = (
            _now() + dt.timedelta(seconds=max(1, int(ttl_seconds)))
        ).isoformat()
        lease["renewedAt"] = _now().isoformat()
        _write_json_atomic(paths["lease"], lease)
    return {
        "ok": True,
        "code": "CONTEXT_LEASE_RENEWED",
        "lease": lease,
        "wasLapsed": lapsed,
    }


def context_view(project: Path, change: str) -> dict[str, Any]:
    project = Path(project).resolve()
    try:
        contract_root, contract, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
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
    prepare.add_argument("--trigger", choices=["review-fixback"])
    bootstrap = sub.add_parser("bootstrap-plan")
    bootstrap.add_argument("--json", action="store_true")
    bootstrap.add_argument("--project", required=True, type=Path)
    bootstrap.add_argument("--change", required=True)
    bootstrap.add_argument("--executor", required=True)
    bootstrap.add_argument("--title")
    bootstrap.add_argument("--stage", default="plan", choices=["plan", "post-run"])
    bootstrap.add_argument("--ttl-seconds", type=int, default=3600)
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
    renew = sub.add_parser(
        "renew", help="extend the current phase lease without touching context"
    )
    renew.add_argument("--json", action="store_true")
    renew.add_argument("--project", required=True, type=Path)
    renew.add_argument("--change", required=True)
    renew.add_argument("--executor", required=True)
    renew.add_argument("--ttl-seconds", type=int, default=3600)
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
            trigger=args.trigger,
        )
    elif args.command == "bootstrap-plan":
        result = bootstrap_plan(
            args.project,
            change=args.change,
            executor=args.executor,
            display_title=args.title,
            stage=args.stage,
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
    elif args.command == "renew":
        result = renew_lease(
            args.project,
            args.change,
            executor=args.executor,
            ttl_seconds=args.ttl_seconds,
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
