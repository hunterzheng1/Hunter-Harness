#!/usr/bin/env python3
"""Cross-agent workflow context and append-only transition receipts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
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
import harness_paths as hpaths  # noqa: E402
import harness_plan_finalize as hpf  # noqa: E402


PHASE_GRAPH = {
    "plan": ("execute",),
    "execute": ("review", "execute"),
    "review": ("submit", "execute"),
    "submit": (),
}

# 唯一权威清单在 harness_paths（叶子模块，harness_phase 引的是同一个对象）。
WORKFLOW_PHASES = hpaths.WORKFLOW_PHASES

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
    """读出阶段计划；无法采信时说明原因，而不是悄悄退成 legacy。

    以前这里遇到未知阶段名一律返回 (None, "legacy")：阶段计划整个失效，
    `_allowed_next_phases` 退回硬编码的 PHASE_GRAPH，而调用方看不出发生过这件事。
    未知阶段名不是假想问题——阶段清单少一个 merge 时，worktree 变更的
    plannedPhases 就会带着 merge 走到这里。

    未知名先过 LEGACY_PHASE_ALIASES 读时映射（阶段改名后历史 change 靠它继续可读），
    仍然解析不了才降级，并把原因与具体阶段名带在 source 里。

    权威切换（2026-08）：v2 发布快照（plan-profile.json）优先，classify 工作
    副本回退——发布后的阶段计划以已审批快照为准。
    """
    loaded = hpaths.load_change_gate_policy(contract_root)
    policy = loaded.get("policy")
    if policy is None:
        if loaded.get("working_error"):
            return None, "legacy:policy-unreadable"
        return None, "legacy"
    unknown: list[str] = []
    for field, source in (
        ("plannedPhases", "change"),
        ("defaultPhases", "policy-default"),
    ):
        raw = policy.get(field)
        if not isinstance(raw, list):
            continue
        phases = [str(item).strip() for item in raw if str(item).strip()]
        if not phases or len(phases) != len(set(phases)):
            continue
        resolved = [hpaths.resolve_phase_name(item) for item in phases]
        missing = [item for item, hit in zip(phases, resolved) if hit is None]
        if missing:
            unknown.extend(missing)
            continue
        # 映射后可能出现重复（两个旧名合并成同一个新阶段），保序去重。
        return list(dict.fromkeys(str(item) for item in resolved)), source
    if unknown:
        return None, "legacy:unknown-phases=" + ",".join(dict.fromkeys(unknown))
    return None, "legacy"


def _allowed_next_phases(contract_root: Path, from_phase: str) -> list[str]:
    planned, _source = _phase_plan(contract_root)
    resolved_from = hpaths.resolve_phase_name(from_phase) or from_phase
    if planned is None:
        return list(PHASE_GRAPH.get(resolved_from, ()))
    if resolved_from not in planned:
        return []
    index = planned.index(resolved_from)
    allowed = planned[index + 1 : index + 2]
    if resolved_from in {"execute", "review"} and "execute" in planned:
        allowed = [*allowed, "execute"]
    return list(dict.fromkeys(allowed))


def allowed_next_phases(project: Path, change: str, phase: str) -> list[str]:
    """公开版后继查询：包装 _contract + _allowed_next_phases。

    gate close 的幂等续跑（phase.end 已写但 handoff 未完成的中间态）需要在
    没有 --to-phase 的情况下派生唯一计划后继；契约读取失败一律回退空表，
    由调用方退到"后继不明确，请显式 --to-phase"的报错路径。
    """
    project = Path(project).resolve()
    try:
        contract_root, _contract_data, _state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError):
        return []
    canonical = hpaths.resolve_phase_name(phase)
    if canonical is None:
        return []
    return _allowed_next_phases(contract_root, canonical)


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
    resolved = [hpaths.resolve_phase_name(item) for item in normalized]
    if (
        not normalized
        or len(normalized) != len(set(normalized))
        or any(item is None for item in resolved)
        or len(set(resolved)) != len(resolved)
        or resolved[0] != "plan"
        or resolved[-1] != "archive"
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
    # 旧名入参（plan,run,test,review,archive）归一为现阶段名后落盘；
    # 上面已校验 resolved 无 None 且保序唯一。
    normalized = [str(item) for item in resolved]
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
        "adoptions": runtime / "context-adoptions.ndjson",
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


def _phase_has_ended(event_paths: list[Path], phase: str) -> bool:
    """目标阶段是否已写入 phase.end（关门事实，与租约/交接状态无关）。"""
    return any(
        hpaths.resolve_phase_name(item.get("phase")) == phase
        and item.get("type") == "phase.end"
        for path in event_paths
        for item in _read_ndjson(path)
    )


def _ensure_phase_end_event(
    contract_root: Path,
    *,
    phase: str,
    status: str,
    executor: str,
) -> dict[str, Any] | None:
    """补齐 phase.start/end 事件对（P0-2）。

    事件对是本地执行日志与阶段计时的权威依据。不经 gate close 收尾的
    阶段（典型：plan 走 finalize + context close）只写 transitions 收据，
    phase.end 永远缺席——连续两个 change 复现，属结构性缺口（2026-08-30
    sales-insight-agent demo-datasource 实测）。
    close_transition 是所有跨阶段推进的共同通道，在此按事件配对补齐：
    有 start 无 end → 复用 start 的 run_id/attempt 代写 end；已有 end（gate
    close 先行写入）或连 start 都没有 → 不动，返回 None。
    """
    import harness_events as he

    events_file = contract_root / "events.ndjson"
    events = _read_ndjson(events_file)
    starts = [
        item
        for item in events
        if hpaths.resolve_phase_name(item.get("phase")) == phase
        and item.get("type") == "phase.start"
    ]
    if not starts or any(
        hpaths.resolve_phase_name(item.get("phase")) == phase
        and item.get("type") == "phase.end"
        for item in events
    ):
        return None
    start = starts[-1]
    result = he.append_event(
        contract_root,
        phase=phase,
        type_="phase.end",
        run_id=str(start.get("run_id") or f"{phase}_unknown"),
        attempt=int(start.get("attempt") or 1),
        status=status,
        executor_tool=executor,
        note="context close 自动补齐 phase.end（平台计时事件对配对）",
    )
    if not result.get("ok"):
        return {"code": "PHASE_END_PAIR_FAILED", "detail": result}
    return {"code": "PHASE_END_AUTO_PAIRED", "event": result.get("event")}


def _reselect_review_fixback(
    project: Path,
    change: str,
    *,
    contract_root: Path,
    state_root: Path,
    executor: str,
) -> dict[str, Any]:
    """Supersede an unbegun review→submit choice with review→execute."""

    paths = _paths(state_root)
    with _exclusive_state_lock(paths["runtime"] / "branch-selection.lock"):
        transitions = _read_ndjson(paths["transitions"])
        latest = transitions[-1] if transitions else None
        if (
            isinstance(latest, dict)
            and hpaths.resolve_phase_name(latest.get("fromPhase")) == "review"
            and hpaths.resolve_phase_name(latest.get("toPhase")) == "execute"
        ):
            # review→execute 已选定即为目标分支：trigger 只区分来源（close 时显式
            # --to-phase execute 的也是同一份意图），不该把修复挡在门外
            return {
                "ok": True,
                "code": "FIXBACK_BRANCH_ALREADY_SELECTED",
                "receipt": latest,
            }
        event_paths = [state_root / "events.ndjson"]
        if state_root != contract_root:
            event_paths.append(contract_root / "events.ndjson")
        review_ended = _phase_has_ended(event_paths, "review")
        if (
            isinstance(latest, dict)
            and hpaths.resolve_phase_name(latest.get("fromPhase")) == "execute"
            and hpaths.resolve_phase_name(latest.get("toPhase")) == "review"
            and review_ended
        ):
            # review 已关门但从没写下后继分支（0.4.7 及之前 plain close 不带
            # --to-phase 的静默断链产物）：此时分支选择还开着，fixback 是唯一
            # 合法的推进——补写 review→execute 收据，与重选 submit 分支同构。
            if paths["lease"].is_file():
                try:
                    lease = _read_json(paths["lease"])
                except (OSError, ValueError, json.JSONDecodeError):
                    return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
                if lease.get("phase") != "review":
                    return {
                        "ok": False,
                        "code": "FIXBACK_RESELECT_UNSAFE",
                        "message": "当前上下文租约不属于已结束的评审阶段。",
                    }
                paths["lease"].unlink(missing_ok=True)
            paths["current"].unlink(missing_ok=True)
            receipt: dict[str, Any] = {
                "schemaVersion": 1,
                "changeName": change,
                "fromPhase": "review",
                "toPhase": "execute",
                "status": "OK",
                "executor": executor,
                "productCommit": _head(project),
                "artifacts": [],
                "attempt": 1
                + sum(
                    1
                    for item in transitions
                    if hpaths.resolve_phase_name(item.get("fromPhase")) == "review"
                    and hpaths.resolve_phase_name(item.get("toPhase")) == "execute"
                ),
                "closedAt": _now().isoformat(),
                "previousReceiptHash": latest.get("receiptHash"),
                "trigger": "review-fixback",
                "selectionReason": "用户选择处理评审中的代码修复项",
            }
            receipt["receiptHash"] = _payload_hash(receipt)
            _append_ndjson(paths["transitions"], receipt)
            invalidation = _invalidate_for_fixback(
                state_root,
                transition_hash=receipt["receiptHash"],
                from_phase="review",
                to_phase="execute",
            )
            return {
                "ok": True,
                "code": "FIXBACK_BRANCH_RESELECTED",
                "receipt": receipt,
                "invalidation": invalidation,
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
                "latestTransition": (
                    {
                        "fromPhase": latest.get("fromPhase"),
                        "toPhase": latest.get("toPhase"),
                        "trigger": latest.get("trigger"),
                    }
                    if isinstance(latest, dict)
                    else None
                ),
                "reviewPhaseEnded": review_ended,
                "recoveryAction": (
                    "修复分支要求评审已关门。若 review 尚未关门：先 "
                    "harness_gate.py close --phase review --status <OK|WARN> "
                    "（0.4.5+ 可省略 --to-phase，唯一后继自动交接；要进修复则显式 "
                    "--to-phase execute），再重跑 /harness-execute --fixback。"
                    "若 submit 已关门，修复窗口已过，请走新一轮评审流程。"
                ),
            }
        begins = _read_ndjson(paths["begins"])
        submit_begun = any(
            isinstance(item, dict)
            and item.get("phase") == "submit"
            and item.get("receiptHash") == latest.get("receiptHash")
            for item in begins
        )
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
        # new execute context is written by prepare_context after this atomic choice.
        paths["current"].unlink(missing_ok=True)

        receipt: dict[str, Any] = {
            "schemaVersion": 1,
            "changeName": change,
            "fromPhase": "review",
            "toPhase": "execute",
            "status": "OK",
            "executor": executor,
            "productCommit": _head(project),
            "artifacts": [],
            "attempt": 1
            + sum(
                1
                for item in transitions
                if hpaths.resolve_phase_name(item.get("fromPhase")) == "review"
                and hpaths.resolve_phase_name(item.get("toPhase")) == "execute"
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
            to_phase="execute",
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
        # 跨阶段推进必须有 receipt 证明它合法；同一个阶段换执行者不需要。
        # 以前两者都要 receipt，于是上一阶段崩溃没能正常 close 时，接手的工具
        # 连"继续把这个阶段干完"都做不到。并发保护不受影响：租约未过期而
        # owner 不同，上面 CONTEXT_LEASE_HELD 已经拦下了，能走到这里只剩
        # 「租约已过期」和「租约已被上一阶段 close 删除」两种情况。
        adoption: dict[str, Any] | None = None
        if recovery is None and isinstance(current, dict) and (
            hpaths.resolve_phase_name(current.get("phase")) != phase
        ):
            valid_receipt = (
                isinstance(latest, dict)
                and hpaths.resolve_phase_name(latest.get("toPhase")) == phase
                and hpaths.resolve_phase_name(latest.get("fromPhase"))
                == hpaths.resolve_phase_name(current.get("phase"))
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
        executor_changed = (
            isinstance(current, dict) and current.get("executor") != executor
        )
        if recovery is not None or executor_changed:
            adoption = {
                "previousExecutor": (
                    current.get("executor") if isinstance(current, dict) else None
                ),
                "newExecutor": executor,
                "reason": (
                    "lease_expired" if recovery is not None else "same_phase_handoff"
                ),
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
        if adoption is not None:
            # 接管必须留痕。过期租约本来就允许任何执行者顶替，但以前只在返回体
            # 里挂一个 recovery，退出进程就没了——事后查"这个阶段是谁接手的"
            # 无据可依。收据形状照 harness_archive.adopt_existing_range。
            adoption = {
                "schemaVersion": 1,
                "changeName": change,
                "phase": phase,
                **adoption,
                "previousOwner": recovery.get("previousOwner") if recovery else None,
                "expiredAt": recovery.get("expiredAt") if recovery else None,
                "adoptedAt": now.isoformat(),
            }
            _append_ndjson(paths["adoptions"], adoption)
        return {
            "ok": True,
            "lease": lease,
            "current": current_context,
            "transitions": transitions,
            "latestTransition": latest,
            "recovery": recovery,
            "adoption": adoption,
            "executionRoot": str(execution_root),
        }


def _unknown_phase_error(phase: Any) -> dict[str, Any]:
    return {
        "ok": False,
        "code": "PHASE_UNKNOWN",
        "phase": str(phase),
        "allowedPhases": list(WORKFLOW_PHASES),
        "legacyAliases": dict(hpaths.LEGACY_PHASE_ALIASES),
        "message": (
            f"未知阶段名 {phase!r}；合法阶段 {list(WORKFLOW_PHASES)}，"
            f"旧名别名 {hpaths.LEGACY_PHASE_ALIASES}。"
        ),
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
    canonical_phase = hpaths.resolve_phase_name(phase)
    if canonical_phase is None:
        return _unknown_phase_error(phase)
    phase = canonical_phase
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
    if trigger == "review-fixback" and phase == "execute":
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
            list(
                PHASE_GRAPH.get(
                    hpaths.resolve_phase_name(str(latest.get("toPhase"))) or "",
                    (),
                )
            )
            if latest
            else ["plan", "execute"]
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
    harness_root = project / ".harness"
    changes_root = harness_root / "changes"
    if not changes_root.is_dir():
        if harness_root.is_dir():
            # 项目已 init 但从未建过 change——changes/ 目录此前没有任何脚本负责创建，
            # 不该把用户误导去重跑 init（init 是空白项目用的）
            changes_root.mkdir(parents=True, exist_ok=True)
        else:
            return {
                "ok": False,
                "code": "PROJECT_ROOT_INVALID",
                "error": f"{harness_root} 不存在——该项目尚未初始化，先运行 hunter-harness init",
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
    # WI-F2：gate-policy 工作副本的文档构建一律走 hg.persist_gate_policy
    # （单写入方）；plannedPhases 由 configure-plan 流程后续补写。
    hg.persist_gate_policy(change_dir, classification)

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
        "gatePolicyPath": str(change_dir / hg.GATE_POLICY_REL),
        "plannedPhases": prepared.get("plannedPhases"),
        "changeBase": git_state.get("base"),
        "head": git_state.get("head"),
        "changedSegments": sorted(changed_segments),
        "legacyBootstrap": prepared.get("legacyBootstrap"),
        "doctorOk": bool(health.get("ok", True)),
        "doctor": health,
    }


def _execute_run_identity(change_dir: Path) -> tuple[str, int] | None:
    """已存在且未关门的 execute `phase.start` 身份（run-id, attempt）。

    与 _plan_run_identity 同语义，但 execute 的 phase.start 由 gate begin 写入
    （含 auto-seal 重试），因此：
    - 只认还没有 phase.end / phase.auto_sealed 收口的 run（已关门的引导
      重跑必须开新 run，不能复活旧身份）；
    - 事件文件经 harness_events.events_path 解析（state 目录权威位置）。
    """
    import harness_events as he

    events_file = he.events_path(change_dir)
    started: list[dict[str, Any]] = []
    closed: set[str] = set()
    for event in he.load_events(events_file):
        if hpaths.resolve_phase_name(event.get("phase")) != "execute":
            continue
        run_id = str(event.get("run_id") or "")
        if not run_id:
            continue
        if event.get("type") == "phase.start":
            started.append(event)
        elif event.get("type") in {"phase.end", "phase.auto_sealed"}:
            closed.add(run_id)
    for event in reversed(started):
        run_id = str(event.get("run_id") or "")
        if run_id in closed:
            continue
        attempt = event.get("attempt")
        return run_id, attempt if isinstance(attempt, int) and attempt > 0 else 1
    return None


# ---------------------------------------------------------------------------
# 执行失败断路器（15-M3）——纯派生判定，不持久化，不引入第二真相源
# ---------------------------------------------------------------------------

_CIRCUIT_THRESHOLD = 2  # 同 (verification, 失败指纹) 连续 FAIL 次数阈值

_CIRCUIT_TS_RE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b"
)
_CIRCUIT_CLOCK_RE = re.compile(r"\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b")
_CIRCUIT_SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b", re.IGNORECASE)
_CIRCUIT_ABSPATH_RE = re.compile(r"(?:[A-Za-z]:)?(?:[\\/][\w.\-]+){2,}")
_CIRCUIT_NUM_RE = re.compile(r"\b\d+\b")
_CIRCUIT_WS_RE = re.compile(r"\s+")


def _circuit_normalize_tail(text: str, *, max_lines: int = 5, max_chars: int = 240) -> str:
    """失败输出尾部归一化（去时间戳/sha/绝对路径/数字等易变段）。

    与 harness_preflight._normalize_output_tail 同族规则但独立演进：
    断路器指纹只在判定内比较，不跨工具消费，不属契约常量。
    """
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    joined = " | ".join(lines[-max_lines:])
    joined = _CIRCUIT_TS_RE.sub("<ts>", joined)
    joined = _CIRCUIT_CLOCK_RE.sub("<ts>", joined)
    joined = _CIRCUIT_SHA_RE.sub("<sha>", joined)
    joined = _CIRCUIT_ABSPATH_RE.sub("<path>", joined)
    joined = _CIRCUIT_NUM_RE.sub("<n>", joined)
    joined = _CIRCUIT_WS_RE.sub(" ", joined)
    return joined[:max_chars]


def _circuit_read_tail(raw_path: Any, *, max_bytes: int = 16384) -> str:
    if not isinstance(raw_path, str) or not raw_path:
        return ""
    path = Path(raw_path)
    try:
        if not path.is_file():
            return ""
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > max_bytes:
                fh.seek(-max_bytes, 2)
            data = fh.read()
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _circuit_fingerprint(receipt: dict[str, Any]) -> str:
    tail = ""
    for key in ("stderrPath", "stdoutPath"):
        tail = _circuit_read_tail(receipt.get(key))
        if tail:
            break
    normalized = _circuit_normalize_tail(tail)
    return hashlib.sha1(
        f"{receipt.get('exitCode')}|{normalized}".encode("utf-8")
    ).hexdigest()[:12]


def execute_circuit_check(change_dir: Path) -> dict[str, Any]:
    """失败断路器判定（只读派生）：同 (verification, 指纹) 最近连续
    ≥_CIRCUIT_THRESHOLD 次 FAIL → open。

    数据源：run-sessions 历史收据（完整时间序列）。ledger validations 是
    覆盖式只留最新，不提供序列，故只作证据补充不作判定输入。
    """
    state_root = hpaths.resolve_state_dir_for_contract(change_dir)
    sessions_root = state_root / "runtime" / "run-sessions"
    if not sessions_root.is_dir():
        return {"state": "closed", "threshold": _CIRCUIT_THRESHOLD,
                "reason": "no-run-sessions", "circuits": []}

    by_kind: dict[str, list[dict[str, Any]]] = {}
    for session_json in sorted(sessions_root.glob("*/session.json")):
        try:
            receipt = json.loads(session_json.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(receipt, dict):
            continue
        kind = str(receipt.get("verification") or "").strip() or "<unknown>"
        by_kind.setdefault(kind, []).append(receipt)

    circuits: list[dict[str, Any]] = []
    for kind, items in sorted(by_kind.items()):
        items.sort(key=lambda r: str(r.get("startedAt") or ""))
        consecutive = 0
        fingerprint: str | None = None
        recent: list[dict[str, Any]] = []
        for receipt in reversed(items):
            if str(receipt.get("status") or "").upper() != "FAIL":
                break
            fp = _circuit_fingerprint(receipt)
            if fingerprint is None:
                fingerprint = fp
            if fp != fingerprint:
                break
            consecutive += 1
            recent.append(receipt)
        if consecutive >= _CIRCUIT_THRESHOLD and fingerprint:
            sample = recent[0]
            circuits.append(
                {
                    "verification": kind,
                    "fingerprint": fingerprint,
                    "consecutiveFailures": consecutive,
                    "exitCode": sample.get("exitCode"),
                    "signature": _circuit_normalize_tail(
                        _circuit_read_tail(sample.get("stderrPath"))
                        or _circuit_read_tail(sample.get("stdoutPath")),
                        max_lines=2,
                        max_chars=160,
                    ),
                    "recentSessions": [
                        {
                            "sessionId": str(r.get("sessionId") or ""),
                            "startedAt": str(r.get("startedAt") or ""),
                            "exitCode": r.get("exitCode"),
                        }
                        for r in recent[:3]
                    ],
                }
            )
    return {
        "state": "open" if circuits else "closed",
        "threshold": _CIRCUIT_THRESHOLD,
        "circuits": circuits,
    }


def bootstrap_execute(
    project: Path,
    *,
    change: str,
    executor: str,
    ttl_seconds: int = 3600,
    note: str = "",
    task: int | None = None,
    skills_root: str | None = None,
    executor_tool: str | None = None,
    executor_agent: str | None = None,
    executor_model: str | None = None,
    circuit_ack: str | None = None,
) -> dict[str, Any]:
    """execute 阶段一次性引导：prepare → context begin → gate begin。

    三条子进程调用（context prepare → context begin → gate begin）的参数
    各自必填，漏 `--project` 或 `--change` 就白跑一轮（F 系列教训）；run-id
    还要调用方自己保证小写字母开头。这些都是确定性工作，交给脚本做。

    幂等：已有未关门的 execute `phase.start` 时复用同一 run-id，不追加
    第二条（与 bootstrap-plan 同语义）。gate begin 的租约领取对同 run-id
    是刷新而非冲突（harness_change._claim_lease_locked 的 same_owner 分支）。

    失败信封带 recoveryAction 指回原三连命令路径——排障出口保留（§10.1：
    旧 change 沿用原序列，不在执行中途静默切换语义）。
    """
    import harness_change as hchg
    import harness_events as he
    import harness_gate as hg

    project = Path(project).resolve()
    changes_root = project / ".harness" / "changes"
    if not changes_root.is_dir():
        return {
            "ok": False,
            "code": "PROJECT_ROOT_INVALID",
            "error": f"{project / '.harness'} 不存在——该项目尚未初始化，先运行 hunter-harness init",
        }
    change_dir = (changes_root / change).resolve()
    if not change_dir.is_dir():
        return {
            "ok": False,
            "code": "CHANGE_NOT_FOUND",
            "error": f"change 目录不存在：{change_dir}",
            "recoveryAction": (
                "确认 --change 与 .harness/changes/ 下的目录名一致；"
                "execute 引导不创建 change（那是 bootstrap-plan 的职责）"
            ),
        }

    # 15-M3：失败断路器在 prepare/begin 副作用之前判定——同 (verification,
    # 失败指纹) 连续 ≥2 次 FAIL 时阻断，人工确认（--circuit-ack）后放行。
    circuit = execute_circuit_check(change_dir)
    if circuit["state"] == "open" and not (circuit_ack or "").strip():
        return {
            "ok": False,
            "code": "EXECUTE_CIRCUIT_OPEN",
            "changeName": change,
            "circuitBreaker": circuit,
            "recoveryAction": (
                "同一验证的同类失败已连续出现 "
                f"≥{circuit['threshold']} 次（详见 circuitBreaker.circuits），"
                "继续盲重试大概率再次失败。\n"
                "1) 先人工定位根因并修复（对照 recentSessions 的输出尾部签名）；\n"
                "2) 确认已修复后重跑 bootstrap-execute 并附 "
                "--circuit-ack \"<根因与修复说明>\" 放行。"
            ),
        }

    # 1. prepare：领取 context 租约；v2 计划的 plan→execute 凭证在此自动补录
    prepared = prepare_context(
        project,
        phase="execute",
        executor=executor,
        change=change,
        ttl_seconds=ttl_seconds,
    )
    if not prepared.get("ok"):
        return _bootstrap_execute_failed(
            "prepare", prepared, project=project, change=change
        )

    # 2. context begin：交接校验（HANDOFF_REQUIRED 在此暴露，不绕过）
    begun = begin_transition(project, change, phase="execute", executor=executor)
    if not begun.get("ok"):
        return _bootstrap_execute_failed(
            "begin", begun, project=project, change=change
        )

    # 3. gate begin：领取阶段租约 + 测试基线 guard + phase.start。
    #    幂等身份先查事件——复用未关门 run-id，避免重复 phase.start。
    identity = _execute_run_identity(change_dir)
    reused = identity is not None
    if identity is None:
        # v2 identity：必须小写字母开头，裸 UUID 有 10/16 概率数字开头被拒
        import uuid

        run_id = f"execute_{uuid.uuid4()}"
    else:
        run_id = identity[0]

    gate_args = argparse.Namespace(
        json=True,
        phase="execute",
        change=change,
        project=None,
        skills_root=skills_root,
        run_id=run_id,
        ttl_seconds=ttl_seconds,
        task=task,
        note=note or f"/harness-execute 引导：{change}",
        fixback=False,
        executor_tool=executor_tool,
        executor_agent=executor_agent,
        executor_model=executor_model,
    )

    class _Capture:
        def __init__(self) -> None:
            self.chunks: list[str] = []

        def write(self, text: str) -> int:
            self.chunks.append(text)
            return len(text)

        def flush(self) -> None:
            pass

        def getvalue(self) -> str:
            return "".join(self.chunks)

    captured_out = _Capture()
    captured_err = _Capture()
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    original_cwd = os.getcwd()
    # cmd_begin 经 resolve_main_project_root() 从 cwd 定位主项目根；进程内
    # 复用时临时切到 project（os.chdir + try/finally 是本仓既有模式，
    # 见 test_harness_fixback.py:559）。emit_error 的 JSON 走 stderr
    # （harness_gate.py:120），两边都捕获才能还原错误信封。
    os.chdir(project)
    sys.stdout = captured_out  # type: ignore[assignment]
    sys.stderr = captured_err  # type: ignore[assignment]
    try:
        rc = hg.cmd_begin(gate_args)
    finally:
        sys.stdout = original_stdout  # type: ignore[assignment]
        sys.stderr = original_stderr  # type: ignore[assignment]
        os.chdir(original_cwd)

    gate_payload: dict[str, Any] | None = None
    for raw in (captured_out.getvalue().strip(), captured_err.getvalue().strip()):
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            gate_payload = parsed
            break
    if rc != 0 or gate_payload is None or not gate_payload.get("ok"):
        failure = gate_payload or {
            "ok": False,
            "code": "BOOTSTRAP_GATE_BEGIN_FAILED",
            "message": f"gate begin 退出码 {rc}，未返回有效 JSON",
        }
        return _bootstrap_execute_failed(
            "gate-begin", failure, project=project, change=change
        )

    # 4. 紧凑摘要：runId/attempt/tier/租约 TTL/测试基线状态
    identity = _execute_run_identity(change_dir) or (run_id, 1)
    effective_run_id, attempt = identity
    policy = hpaths.load_change_gate_policy(change_dir)
    policy_doc = policy.get("policy") if isinstance(policy, dict) else None
    tier = policy_doc.get("tier") if isinstance(policy_doc, dict) else None
    lease = gate_payload.get("lease")
    test_guard = gate_payload.get("testGuard")
    return {
        "ok": True,
        "code": "EXECUTE_BOOTSTRAPPED",
        "changeName": change,
        "changeDir": str(change_dir),
        "executionRoot": gate_payload.get("executionRoot"),
        "runId": effective_run_id,
        "attempt": attempt,
        "reused": reused,
        "tier": tier,
        "lease": lease,
        "leaseTtlSeconds": (
            lease.get("ttlSeconds") if isinstance(lease, dict) else None
        ),
        "testBaseline": test_guard,
        "manifestCalibration": _bootstrap_manifest_calibration(
            project, change_dir
        ),
        "plannedPhases": prepared.get("plannedPhases"),
        "scenarioWaves": _bootstrap_scenario_waves(change_dir),
        "waveDispatch": _bootstrap_wave_dispatch(change_dir),
        "gateWarnings": gate_payload.get("gateWarnings"),
        "nextAction": (
            "TDD 编码与验证；完成后运行 "
            f"harness_gate.py close --phase execute --change {change} --status <OK|WARN> --json"
        ),
        **(
            {
                "circuitBreaker": {
                    **circuit,
                    "overridden": True,
                    "ackNote": circuit_ack.strip(),
                }
            }
            if circuit["state"] == "open" and (circuit_ack or "").strip()
            else {}
        ),
    }


def _load_manifest_scenarios(
    change_dir: Path,
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """读取并解包 scenario-manifest 的场景区列表（16-M1/16-M2 共用读取路径）。

    返回 ``(scenarios, None)`` 或 ``(None, reason)``；reason 沿用既有降级码
    （missing/unreadable/unsupported/empty 或 unpack 错误码）。
    """
    manifest_path = change_dir / "meta" / "scenario-manifest.json"
    if not manifest_path.is_file():
        return None, "scenario-manifest-missing"
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, "scenario-manifest-unreadable"
    if not isinstance(raw, dict):
        return None, "scenario-manifest-unreadable"
    unpacked = hpf.unpack_v2_scenario_manifest(raw)
    if isinstance(unpacked, dict):
        if not unpacked.get("ok"):
            return None, str(
                unpacked.get("code") or "scenario-manifest-unsupported"
            )
        manifest = unpacked.get("manifest")
    elif isinstance(raw.get("scenarios"), list):
        manifest = raw
    else:
        return None, "scenario-manifest-unsupported"
    scenarios = manifest.get("scenarios") if isinstance(manifest, dict) else None
    if not isinstance(scenarios, list) or not scenarios:
        return None, "scenario-manifest-empty"
    return scenarios, None


def _bootstrap_scenario_waves(change_dir: Path) -> dict[str, Any]:
    """16-M1：从 scenario-manifest 派生场景 DAG 拓扑波次（advisory，只读）。

    失败安全：manifest 缺失/畸形/依赖未解析或成环时返回 ``available=False`` +
    ``reason``，绝不阻断 bootstrap——波次是调度建议，不是门禁。
    """
    scenarios, reason = _load_manifest_scenarios(change_dir)
    if scenarios is None:
        return {"available": False, "reason": reason, "waves": []}
    return hpf.compute_scenario_waves(scenarios)


def _derive_completed_scenarios(change_dir: Path) -> set[str]:
    """16-M2：从 verification-ledger 派生已完成场景集（advisory 级信任，不重验收据）。

    判定镜像 gate 场景覆盖语义：条目 ``status`` 为 OK 时取
    ``scenarioCoverage.passed``（v2 收据路径），无 coverage 时退回
    ``scenarioIds``（legacy 路径）；非 OK 条目不贡献完成集。门禁在 close 时
    仍会 fail-closed 重验收据——本派生永不作门禁输入。
    """
    ledger_path = change_dir / "evidence" / "verification-ledger.json"
    if not ledger_path.is_file():
        return set()
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, json.JSONDecodeError):
        return set()
    validations = ledger.get("validations") if isinstance(ledger, dict) else None
    if isinstance(validations, dict):
        entries: list[Any] = list(validations.values())
    elif isinstance(validations, list):
        entries = validations
    else:
        return set()
    completed: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("status") or "").upper() != "OK":
            continue
        coverage = entry.get("scenarioCoverage")
        passed = coverage.get("passed") if isinstance(coverage, dict) else None
        ids = passed if isinstance(passed, list) else entry.get("scenarioIds")
        if isinstance(ids, list):
            completed.update(
                text for text in (str(item).strip() for item in ids) if text
            )
    return completed


def _bootstrap_manifest_calibration(
    project: Path, change_dir: Path
) -> dict[str, Any]:
    """19-M1：test manifest 校准 advisory（只读 report，失败安全不阻断）。

    修复回流编辑测试文件后 manifest 哈希漂移曾靠人工 record 校准
    （研究报告 §4.2 P2）。bootstrap 时自动检出漂移并附 ``calibrate
    --apply`` 提示；attributeDrift/missing/untracked 只报告——校验器
    语义不容许旁路或属破坏性/意图性操作，自动化不代为决策。
    信封不带 untracked 明细（可能很长，属噪音），只带计数。
    """
    try:
        import harness_test_guard as htg

        report = htg.calibrate(project, change_dir)
    except Exception as exc:  # advisory 绝不阻断 bootstrap
        return {
            "available": False,
            "reason": f"calibrate-error:{type(exc).__name__}",
        }
    if not report.get("ok"):
        return {
            "available": False,
            "reason": str(report.get("code") or "calibrate-failed"),
        }
    if report.get("code") == "NO_MANIFEST":
        return {"available": False, "reason": "manifest-missing"}
    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    drifted = bool(
        summary.get("hashDrift")
        or summary.get("attributeDrift")
        or summary.get("missing")
    )
    return {
        "available": True,
        "drifted": drifted,
        "summary": summary,
        "hashDrift": report.get("hashDrift") or [],
        "attributeDrift": report.get("attributeDrift") or [],
        "missing": report.get("missing") or [],
        # 20-M1：plan 声明的验收测试漂移只报告不重录，须人工 ack
        "ackRequired": report.get("ackRequired") or [],
        "hint": report.get("hint"),
    }


def _bootstrap_wave_dispatch(
    change_dir: Path,
    *,
    completed_root: Path | None = None,
    phase: str = "execute",
) -> dict[str, Any]:
    """16-M2：波次派发计划（advisory，只读）。复用 16-M1 的 manifest 读取与降级语义。

    ``completed_root``：ledger 读取根（split-local 状态下与 manifest 所在根
    不同）；缺省与 manifest 同根。
    """
    scenarios, reason = _load_manifest_scenarios(change_dir)
    if scenarios is None:
        return {
            "available": False,
            "reason": reason,
            "phase": hpaths.resolve_phase_name(phase) or "execute",
            "total": 0,
            "runnableNow": [],
            "blocked": [],
            "completed": [],
            "deferred": [],
            "conflictGroups": [],
            "complete": False,
        }
    completed = _derive_completed_scenarios(completed_root or change_dir)
    return hpf.compute_wave_dispatch(scenarios, completed, phase=phase)


def _bootstrap_execute_failed(
    stage: str,
    failure: dict[str, Any],
    *,
    project: Path,
    change: str,
) -> dict[str, Any]:
    """统一失败信封：保留原错误 + recoveryAction 指回原三连命令路径。"""
    return {
        "ok": False,
        "code": f"BOOTSTRAP_EXECUTE_{stage.upper().replace('-', '_')}_FAILED",
        "stage": stage,
        "error": failure,
        "recoveryAction": (
            "bootstrap-execute 失败时按原三连命令路径排障（旧路径保留为出口）：\n"
            f"1) python <skills-root>/scripts/harness_context.py prepare --project . "
            f"--change {change} --phase execute --executor <tool> --json\n"
            f"2) python <skills-root>/scripts/harness_context.py begin --project . "
            f"--change {change} --phase execute --executor <tool> --json\n"
            f"3) python <skills-root>/scripts/harness_gate.py begin --phase execute "
            f"--change {change} --json\n"
            "按上述错误信封定位失败环节后，从该环节起原样重试（各步幂等）。"
        ),
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
    存储，于是 execute 阶段 prepare 必报 HANDOFF_REQUIRED、begin 必报
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
    canonical_from = hpaths.resolve_phase_name(from_phase)
    canonical_to = hpaths.resolve_phase_name(to_phase)
    if canonical_from is None:
        return _unknown_phase_error(from_phase)
    if canonical_to is None:
        return _unknown_phase_error(to_phase)
    from_phase = canonical_from
    to_phase = canonical_to
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
            and hpaths.resolve_phase_name(latest.get("fromPhase")) == from_phase
            and hpaths.resolve_phase_name(latest.get("toPhase")) == to_phase
            and latest.get("status") == status
            and latest.get("artifacts") == artifact_entries
            and (executor is None or latest.get("executor") == executor)
        ):
            paired = _ensure_phase_end_event(
                contract_root,
                phase=from_phase,
                status=status,
                executor=executor or str(latest.get("executor") or "unknown"),
            )
            return {
                "ok": True,
                "code": "TRANSITION_ALREADY_CLOSED",
                "idempotent": True,
                "receipt": latest,
                "path": str(paths["transitions"]),
                "invalidation": None,
                "phaseEndPair": paired,
            }
        return {"ok": False, "code": "CONTEXT_LEASE_REQUIRED"}
    try:
        lease = _read_json(paths["lease"])
    except (OSError, ValueError, json.JSONDecodeError):
        return {"ok": False, "code": "CONTEXT_LEASE_INVALID"}
    effective_executor = executor or str(lease.get("owner") or "")
    if not effective_executor:
        return {"ok": False, "code": "CONTEXT_EXECUTOR_REQUIRED"}
    if lease.get("owner") != effective_executor or (
        hpaths.resolve_phase_name(lease.get("phase")) != from_phase
    ):
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
            if hpaths.resolve_phase_name(item.get("fromPhase")) == from_phase
            and hpaths.resolve_phase_name(item.get("toPhase")) == to_phase
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
    paired = _ensure_phase_end_event(
        contract_root,
        phase=from_phase,
        status=status,
        executor=effective_executor,
    )
    invalidation = None
    if to_phase == "execute" and from_phase in {"execute", "review"}:
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
        "phaseEndPair": paired,
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
    if hpaths.resolve_phase_name(receipt.get("toPhase")) != phase:
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


def handoff_transition(
    project: Path,
    change: str,
    *,
    to_phase: str,
    executor: str,
    from_phase: str | None = None,
    status: str = "OK",
) -> dict[str, Any]:
    """一条命令补齐缺失的阶段交接：补租约 → close → begin 确认。

    0.4.7 及之前的 plain gate close 不写交接，后继阶段 begin 撞
    CONTEXT_HANDOFF_REQUIRED 后，使用者要在 context close（缺租约报错）→
    change claim → context prepare → context close → context begin →
    change release 之间试错（2026-08-30 sales-insight-agent submit 实测，
    六条命令）。本命令把合法恢复收敛为一步：来源阶段必须已关门
    （phase.end 落盘），缺失的 context 租约由 prepare 幂等重建，
    交接收据与 begin 确认走与正常流程完全相同的状态机。阶段租约
    （harness_change）在 gate close 时已释放，无需也不应重新 claim。
    """
    project = Path(project).resolve()
    canonical_to = hpaths.resolve_phase_name(to_phase)
    if canonical_to is None:
        return _unknown_phase_error(to_phase)
    to_phase = canonical_to
    try:
        contract_root, _contract_data, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
    paths = _paths(state_root)
    transitions = _read_ndjson(paths["transitions"])
    latest = transitions[-1] if transitions else None

    if from_phase is None:
        if (
            isinstance(latest, dict)
            and hpaths.resolve_phase_name(latest.get("toPhase")) == to_phase
        ):
            # 交接已写、只剩 begin 确认的半成品状态：来源从收据取
            from_phase = str(latest.get("fromPhase") or "")
        else:
            view = context_view(project, change)
            current = (
                view.get("current") if isinstance(view.get("current"), dict) else {}
            )
            from_phase = str(current.get("phase") or "").strip()
    canonical_from = hpaths.resolve_phase_name(from_phase or "")
    if canonical_from is None:
        return {
            "ok": False,
            "code": "HANDOFF_SOURCE_UNKNOWN",
            "message": "无法确定交接来源阶段；请显式传 --from-phase。",
            "toPhase": to_phase,
        }
    from_phase = canonical_from

    closed: dict[str, Any]
    if (
        isinstance(latest, dict)
        and hpaths.resolve_phase_name(latest.get("fromPhase")) == from_phase
        and hpaths.resolve_phase_name(latest.get("toPhase")) == to_phase
    ):
        # 收据已存在——重放 close 只会写重复 receipt，直接进入 begin 确认
        closed = {
            "ok": True,
            "code": "TRANSITION_ALREADY_CLOSED",
            "idempotent": True,
            "receipt": latest,
        }
    else:
        event_paths = [state_root / "events.ndjson"]
        if state_root != contract_root:
            event_paths.append(contract_root / "events.ndjson")
        if not _phase_has_ended(event_paths, from_phase):
            return {
                "ok": False,
                "code": "HANDOFF_SOURCE_NOT_CLOSED",
                "message": (
                    f"{from_phase} 阶段尚未关门（无 phase.end）；handoff 只补齐"
                    "已关门阶段的交接，不能截胡进行中的阶段。"
                ),
                "fromPhase": from_phase,
                "toPhase": to_phase,
                "recoveryAction": (
                    f"先完成来源阶段关门：harness_gate.py close --phase {from_phase} "
                    f"--change {change} --status <OK|WARN> --json"
                    "（0.4.6+ 缺省 --to-phase 时自动派生交接），再重跑本命令。"
                ),
            }
        # 缺失/过期的 context 租约由 prepare 幂等重建；被他人持有则原样报错
        prepared = prepare_context(
            project,
            change=change,
            phase=from_phase,
            executor=executor,
        )
        if not prepared.get("ok"):
            return prepared
        closed = close_transition(
            project,
            change,
            from_phase=from_phase,
            to_phase=to_phase,
            executor=executor,
            status=status,
        )
        if not closed.get("ok"):
            return closed
    begun = begin_transition(project, change, phase=to_phase, executor=executor)
    if not begun.get("ok"):
        return {
            "ok": False,
            "code": "HANDOFF_BEGIN_FAILED",
            "message": "交接收据已写入，但 begin 确认失败。",
            "transition": closed,
            "begin": begun,
        }
    return {
        "ok": True,
        "code": "HANDOFF_COMPLETED",
        "changeName": change,
        "fromPhase": from_phase,
        "toPhase": to_phase,
        "transition": closed,
        "begin": begun,
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
    canonical_phase = hpaths.resolve_phase_name(phase)
    if canonical_phase is None:
        return _unknown_phase_error(phase)
    phase = canonical_phase
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
    canonical_phase = hpaths.resolve_phase_name(phase)
    if canonical_phase is None:
        return _unknown_phase_error(phase)
    phase = canonical_phase
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
                hpaths.resolve_phase_name(current.get("phase")) == phase
                and current.get("executor") == executor
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
                hpaths.resolve_phase_name(lease.get("phase")) == phase
                and lease.get("owner") == executor
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
                and hpaths.resolve_phase_name(item.get("phase")) == phase
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


def execute_wave_dispatch(
    project: Path, change: str, *, phase: str = "execute"
) -> dict[str, Any]:
    """16-M2：execute 阶段中途重查波次派发计划（只读，零副作用）。

    manifest 从 contract 根读取（与 bootstrap-execute 一致）；完成集从 state
    根的 ledger 派生（split-local 状态下两根本不同）。advisory 降级不阻断。
    """
    project = Path(project).resolve()
    try:
        contract_root, _, state_root = _contract(project, change)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": _contract_error_code(exc), "error": str(exc)}
    dispatch = _bootstrap_wave_dispatch(
        contract_root, completed_root=state_root, phase=phase
    )
    return {
        "ok": True,
        "code": "EXECUTE_WAVE_DISPATCH",
        "changeName": change,
        "dispatch": dispatch,
        "nextAction": (
            "按 runnableNow 波次顺序派发；每波完成并写验收据后重跑本命令获取下一波"
            if dispatch.get("available")
            else "波次不可用，退回既有顺序执行（advisory 降级，不阻断）"
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_context.py")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--json", action="store_true")
    prepare.add_argument("--project", required=True, type=Path)
    prepare.add_argument("--change", "--change-dir", dest="change")
    prepare.add_argument("--phase", required=True)
    prepare.add_argument("--executor", required=True)
    prepare.add_argument("--title")
    prepare.add_argument("--ttl-seconds", type=int, default=3600)
    prepare.add_argument("--trigger", choices=["review-fixback"])
    bootstrap = sub.add_parser("bootstrap-plan")
    bootstrap.add_argument("--json", action="store_true")
    bootstrap.add_argument("--project", required=True, type=Path)
    bootstrap.add_argument("--change", "--change-dir", dest="change", required=True)
    bootstrap.add_argument("--executor", required=True)
    bootstrap.add_argument("--title")
    bootstrap.add_argument("--stage", default="plan", choices=["plan", "post-run"])
    bootstrap.add_argument("--ttl-seconds", type=int, default=3600)
    bootstrap_execute_parser = sub.add_parser(
        "bootstrap-execute",
        help="execute 阶段一次性引导：prepare → context begin → gate begin（幂等）",
    )
    bootstrap_execute_parser.add_argument("--json", action="store_true")
    bootstrap_execute_parser.add_argument("--project", required=True, type=Path)
    bootstrap_execute_parser.add_argument("--change", "--change-dir", dest="change", required=True)
    bootstrap_execute_parser.add_argument("--executor", required=True)
    bootstrap_execute_parser.add_argument("--ttl-seconds", type=int, default=3600)
    bootstrap_execute_parser.add_argument("--note", default="")
    bootstrap_execute_parser.add_argument("--task", type=int, default=None)
    bootstrap_execute_parser.add_argument("--skills-root", default=None)
    bootstrap_execute_parser.add_argument("--executor-tool", default=None)
    bootstrap_execute_parser.add_argument("--executor-agent", default=None)
    bootstrap_execute_parser.add_argument("--executor-model", default=None)
    bootstrap_execute_parser.add_argument(
        "--circuit-ack",
        default=None,
        metavar="NOTE",
        help="15-M3 断路器人工确认：附根因与修复说明后放行 EXECUTE_CIRCUIT_OPEN",
    )
    execute_wave = sub.add_parser(
        "execute-wave",
        help="16-M2：派生当前可并行派发的场景波次计划（只读 advisory，阶段中途重查）",
    )
    execute_wave.add_argument("--json", action="store_true")
    execute_wave.add_argument("--project", required=True, type=Path)
    execute_wave.add_argument("--change", "--change-dir", dest="change", required=True)
    execute_wave.add_argument(
        "--phase",
        default="execute",
        help="派发视角的阶段（ownerPhase 晚于它的场景列为 deferred）",
    )
    close = sub.add_parser("close")
    close.add_argument("--json", action="store_true")
    close.add_argument("--project", required=True, type=Path)
    close.add_argument("--change", "--change-dir", dest="change", required=True)
    close.add_argument("--from-phase", required=True)
    close.add_argument("--to-phase", required=True)
    close.add_argument("--executor", required=True)
    close.add_argument("--artifact", action="append", default=[])
    close.add_argument("--status", default="OK")
    begin = sub.add_parser("begin")
    begin.add_argument("--json", action="store_true")
    begin.add_argument("--project", required=True, type=Path)
    begin.add_argument("--change", "--change-dir", dest="change", required=True)
    begin.add_argument("--phase", required=True)
    begin.add_argument("--executor", required=True)
    handoff = sub.add_parser(
        "handoff",
        help="一条命令补齐缺失的阶段交接：补租约 → close → begin 确认",
    )
    handoff.add_argument("--json", action="store_true")
    handoff.add_argument("--project", required=True, type=Path)
    handoff.add_argument("--change", "--change-dir", dest="change", required=True)
    handoff.add_argument("--to-phase", required=True)
    handoff.add_argument(
        "--from-phase",
        help="缺省从当前上下文/最新交接收据推断",
    )
    handoff.add_argument("--executor", required=True)
    handoff.add_argument("--status", default="OK")
    renew = sub.add_parser(
        "renew", help="extend the current phase lease without touching context"
    )
    renew.add_argument("--json", action="store_true")
    renew.add_argument("--project", required=True, type=Path)
    renew.add_argument("--change", "--change-dir", dest="change", required=True)
    renew.add_argument("--executor", required=True)
    renew.add_argument("--ttl-seconds", type=int, default=3600)
    configure = sub.add_parser("configure-plan")
    configure.add_argument("--json", action="store_true")
    configure.add_argument("--project", required=True, type=Path)
    configure.add_argument("--change", "--change-dir", dest="change", required=True)
    configure.add_argument("--phases", required=True)
    configure.add_argument("--operator", required=True)
    configure.add_argument("--reason", required=True)
    view = sub.add_parser("view")
    view.add_argument("--json", action="store_true")
    view.add_argument("--project", required=True, type=Path)
    view.add_argument("--change", "--change-dir", dest="change", required=True)
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
    elif args.command == "bootstrap-execute":
        result = bootstrap_execute(
            args.project,
            change=args.change,
            executor=args.executor,
            ttl_seconds=args.ttl_seconds,
            note=args.note,
            task=args.task,
            skills_root=args.skills_root,
            executor_tool=args.executor_tool,
            executor_agent=args.executor_agent,
            executor_model=args.executor_model,
            circuit_ack=args.circuit_ack,
        )
    elif args.command == "execute-wave":
        result = execute_wave_dispatch(args.project, args.change, phase=args.phase)
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
    elif args.command == "handoff":
        result = handoff_transition(
            args.project,
            args.change,
            to_phase=args.to_phase,
            from_phase=args.from_phase,
            executor=args.executor,
            status=args.status,
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
