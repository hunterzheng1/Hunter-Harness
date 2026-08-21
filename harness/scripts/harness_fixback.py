#!/usr/bin/env python3
"""Batch related fixback issues without weakening RED/GREEN evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import tempfile
import sys
import time
import uuid
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from harness_paths import resolve_state_dir_for_contract
import harness_events as he
import harness_review as hr


SCHEMA_VERSION = 1
_BATCH_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RISK_VERIFICATIONS = {
    "security": {"security", "unitTestFull"},
    "migration": {"migration", "unitTestFull"},
    "public-contract": {"apiTest", "unitTestFull"},
    "database": {"dbCompatibility", "unitTestFull"},
    "browser": {"browserTest"},
    "performance": {"performance"},
}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def _state_root(change_dir: Path) -> Path:
    return Path(resolve_state_dir_for_contract(change_dir)).resolve()


def _batch_root(change_dir: Path) -> Path:
    return _state_root(change_dir) / "fixback" / "batches"


def _batch_path(change_dir: Path, batch_id: str) -> Path:
    if not _BATCH_ID.fullmatch(batch_id):
        raise ValueError(f"FIXBACK_BATCH_ID_INVALID: {batch_id}")
    return _batch_root(change_dir) / f"{batch_id}.json"


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    fd, raw = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    temporary = Path(raw)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _load(change_dir: Path, batch_id: str) -> dict[str, Any]:
    path = _batch_path(change_dir, batch_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise ValueError(f"FIXBACK_BATCH_NOT_FOUND: {batch_id}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"FIXBACK_BATCH_CORRUPT: {batch_id}")
    return value


def _all_batches(change_dir: Path) -> list[dict[str, Any]]:
    root = _batch_root(change_dir)
    if not root.is_dir():
        return []
    batches: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.json")):
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            batches.append(value)
    return batches


def _session_path(change_dir: Path) -> Path:
    return _state_root(change_dir) / "runtime" / "fixback-session.json"


def _next_step(batch: dict[str, Any]) -> str:
    issues = [item for item in batch.get("issues", []) if isinstance(item, dict)]
    if not issues:
        return "add-issues"
    if any(item.get("status") != "RESOLVED" for item in issues):
        return "resolve-issues"
    receipts = batch.get("receipts") if isinstance(batch.get("receipts"), dict) else {}
    if not receipts.get("affected"):
        return "verify-affected"
    if not receipts.get("review"):
        return "review"
    return "close"


def review_fixback_plan(change_dir: Path) -> dict[str, Any]:
    """Read Review sidecars and return only actionable product-code fixes."""

    review_root = _state_root(change_dir) / "reports" / "review"
    findings_path = review_root / "review-findings.json"
    dispositions_path = review_root / "fixback-dispositions.json"
    if not findings_path.is_file() or not dispositions_path.is_file():
        return {
            "ok": False,
            "code": "FIXBACK_REVIEW_OUTPUTS_REQUIRED",
            "message": "评审结构化记录不完整，无法安全创建修复批次。",
            "recoveryAction": "先补齐评审发现与处置记录，再重新执行修复",
        }
    try:
        findings_doc = json.loads(findings_path.read_text(encoding="utf-8-sig"))
        dispositions_doc = json.loads(
            dispositions_path.read_text(encoding="utf-8-sig")
        )
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "FIXBACK_REVIEW_OUTPUTS_INVALID",
            "message": f"评审结构化记录无法读取：{exc}",
        }
    if not isinstance(findings_doc, dict) or not isinstance(dispositions_doc, dict):
        return {
            "ok": False,
            "code": "FIXBACK_REVIEW_OUTPUTS_INVALID",
            "message": "评审结构化记录格式无效。",
        }
    if findings_doc.get("runId") != dispositions_doc.get("runId"):
        return {
            "ok": False,
            "code": "FIXBACK_REVIEW_RUN_MISMATCH",
            "message": "评审发现与处置记录不属于同一轮评审。",
        }
    finding_problems = hr.validate_findings(findings_doc, require_ids=True)
    known_ids = {
        str(item.get("id"))
        for item in findings_doc.get("findings", [])
        if isinstance(item, dict) and item.get("id")
    }
    disposition_problems = hr.validate_dispositions(dispositions_doc, known_ids)
    if finding_problems or disposition_problems:
        return {
            "ok": False,
            "code": "FIXBACK_REVIEW_OUTPUTS_INVALID",
            "message": "评审结构化记录不完整，无法安全创建修复批次。",
            "problems": [*finding_problems, *disposition_problems],
            "recoveryAction": "重新写入完整的评审发现与处置记录后重试",
        }
    dispositions = {
        str(item.get("findingId")): str(item.get("disposition") or "UNKNOWN")
        for item in dispositions_doc.get("dispositions", [])
        if isinstance(item, dict) and item.get("findingId")
    }
    finding_ids = {
        str(item.get("id"))
        for item in findings_doc.get("findings", [])
        if isinstance(item, dict) and item.get("id")
    }
    invalid_actions = sorted(
        str(item.get("id") or f"index-{index}")
        for index, item in enumerate(findings_doc.get("findings", []))
        if isinstance(item, dict)
        and item.get("fixbackAction") not in {"code", "manual", "workflow"}
    )
    missing_dispositions = sorted(finding_ids - set(dispositions))
    if invalid_actions or missing_dispositions:
        return {
            "ok": False,
            "code": "FIXBACK_REVIEW_OUTPUTS_INVALID",
            "message": "评审项缺少明确的修复动作或处置状态。",
            "invalidActions": invalid_actions,
            "missingDispositions": missing_dispositions,
            "recoveryAction": "补齐评审发现的 fixbackAction 与 disposition 后重试",
        }
    actionable: list[dict[str, Any]] = []
    informational: list[dict[str, Any]] = []
    for finding in findings_doc.get("findings", []):
        if not isinstance(finding, dict) or not finding.get("id"):
            continue
        disposition = dispositions.get(str(finding["id"]), "UNKNOWN")
        action = str(finding.get("fixbackAction"))
        item = {
            "issueId": str(finding["id"]),
            "summary": str(finding.get("title") or "评审问题"),
            "severity": str(finding.get("severity") or "YELLOW"),
            "path": str(finding.get("path") or ""),
            "line": int(finding.get("line") or 0),
            "riskTags": sorted(
                {
                    str(tag)
                    for tag in finding.get("riskTags", [])
                    if str(tag).strip()
                }
            ),
            "disposition": disposition,
            "fixbackAction": action,
        }
        if (
            action == "code"
            and item["severity"] in {"RED", "YELLOW"}
            and disposition in {"OPEN", "UNKNOWN"}
        ):
            actionable.append(item)
        else:
            informational.append(item)
    if not actionable:
        return {
            "ok": True,
            "code": "FIXBACK_NOTHING_TO_APPLY",
            "message": "本轮评审没有需要执行的代码修复。",
            "reviewRunId": findings_doc.get("runId"),
            "issues": [],
            "informationalItems": informational,
            "writesState": False,
        }
    return {
        "ok": True,
        "code": "FIXBACK_READY",
        "message": f"已找到 {len(actionable)} 个需要处理的代码修复项。",
        "reviewRunId": findings_doc.get("runId"),
        "issues": actionable,
        "informationalItems": informational,
        "writesState": False,
    }


def open_review_batch(
    change_dir: Path,
    *,
    plan: dict[str, Any],
    batch_id: str,
    product_identity: str,
    run_id: str,
    attempt: int,
) -> dict[str, Any]:
    """Atomically create a populated batch from a validated Review plan."""

    issues = plan.get("issues") if isinstance(plan, dict) else None
    if plan.get("code") != "FIXBACK_READY" or not isinstance(issues, list) or not issues:
        raise ValueError("FIXBACK_NOTHING_TO_APPLY")
    if not product_identity.strip():
        raise ValueError("FIXBACK_PRODUCT_IDENTITY_REQUIRED")
    opened = [item for item in _all_batches(change_dir) if item.get("status") == "OPEN"]
    if opened:
        existing = sorted(opened, key=lambda item: str(item.get("openedAt") or ""))[0]
        if existing.get("sourceReviewRunId") == plan.get("reviewRunId"):
            result = dict(existing)
            result.update(
                {
                    "ok": True,
                    "code": "FIXBACK_RESUMED",
                    "resumed": True,
                    "runId": run_id,
                    "attempt": max(1, int(attempt)),
                    "nextStep": _next_step(existing),
                }
            )
            return result
        raise ValueError(
            "FIXBACK_BATCH_ALREADY_OPEN: " + str(existing.get("batchId"))
        )
    path = _batch_path(change_dir, batch_id)
    if path.exists():
        raise ValueError(f"FIXBACK_BATCH_EXISTS: {batch_id}")
    opened_at = now_iso()
    issue_entries = [
        {
            "issueId": str(item["issueId"]),
            "summary": str(item["summary"]),
            "status": "OPEN",
            "riskTags": list(item.get("riskTags") or []),
            "severity": item.get("severity"),
            "path": item.get("path"),
            "line": item.get("line"),
            "redEvidence": None,
            "greenEvidence": None,
            "changedFiles": [],
            "resolvedAt": None,
        }
        for item in issues
    ]
    batch = {
        "schemaVersion": SCHEMA_VERSION,
        "batchId": batch_id,
        "status": "OPEN",
        "rootCause": "处理评审中明确要求的代码修复项",
        "sourceReviewRunId": plan.get("reviewRunId"),
        "openedAt": opened_at,
        "updatedAt": opened_at,
        "closedAt": None,
        "baseProductIdentity": product_identity,
        "finalProductIdentity": None,
        "issues": issue_entries,
        "changedFiles": [],
        "requiredVerifications": _required_verifications(issue_entries),
        "receipts": {"affected": None, "review": None},
        "verificationRuns": {"affected": 0, "review": 0},
    }
    _write_json(path, batch)
    session = {
        "schemaVersion": 1,
        "status": "ACTIVE",
        "batchId": batch_id,
        "runId": run_id,
        "attempt": max(1, int(attempt)),
        "nextStep": _next_step(batch),
        "updatedAt": opened_at,
    }
    _write_json(_session_path(change_dir), session)
    he.append_event(
        change_dir,
        phase="execute",
        type_="decision",
        note=f"已从评审结果创建修复批次，共 {len(issue_entries)} 个代码修复项。",
        run_id=run_id,
        attempt=session["attempt"],
        trigger="review-fixback",
        from_phase="review",
    )
    return {
        "ok": True,
        "code": "FIXBACK_OPENED",
        "resumed": False,
        **batch,
        **session,
    }


def _default_context_prepare(**kwargs: Any) -> dict[str, Any]:
    import harness_context as hctx

    return hctx.prepare_context(
        kwargs["project"],
        phase="execute",
        executor=kwargs["executor"],
        change=kwargs["change"],
        trigger="review-fixback",
        preparation_id=kwargs["preparation_id"],
    )


def _default_context_begin(**kwargs: Any) -> dict[str, Any]:
    import harness_context as hctx

    return hctx.begin_transition(
        kwargs["project"],
        kwargs["change"],
        phase="execute",
        executor=kwargs["executor"],
        preparation_id=kwargs["preparation_id"],
    )


def _default_context_cancel(**kwargs: Any) -> dict[str, Any]:
    import harness_context as hctx

    return hctx.cancel_prepared_context(
        kwargs["project"],
        kwargs["change"],
        phase="execute",
        executor=kwargs["executor"],
        preparation_id=kwargs["preparation_id"],
    )


def _default_gate_begin(**kwargs: Any) -> dict[str, Any]:
    command = [
        sys.executable,
        str(SCRIPTS_DIR / "harness_gate.py"),
        "begin",
        "--json",
        "--phase",
        "execute",
        "--change",
        str(kwargs["change"]),
        "--project",
        str(kwargs["project"]),
        "--skills-root",
        str(kwargs["skills_root"]),
        "--run-id",
        str(kwargs["run_id"]),
        "--note",
        "开始处理评审中确认需要修改的代码问题。",
        # 显式标记这一轮是 review fixback。以前靠 gate 嗅探 note 里有没有
        # "fixback" 字样——而上面这条 note 一个都没有，于是 fixback 的 run 事件
        # 从来没被打上 trigger/from_phase。
        "--fixback",
    ]
    for option, key in (
        ("--executor-tool", "executor_tool"),
        ("--executor-agent", "executor_agent"),
        ("--executor-model", "executor_model"),
    ):
        value = kwargs.get(key)
        if value:
            command.extend([option, str(value)])
    if kwargs.get("task") is not None:
        command.extend(["--task", str(kwargs["task"])])
    completed = subprocess.run(
        command,
        cwd=str(kwargs["project"]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    raw = completed.stdout.strip() or completed.stderr.strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {
            "ok": False,
            "code": "FIXBACK_GATE_COMMAND_FAILED",
            "message": raw or "修复门禁未返回有效结果。",
        }
    if not isinstance(payload, dict):
        payload = {
            "ok": False,
            "code": "FIXBACK_GATE_COMMAND_FAILED",
            "message": "修复门禁返回了无效结果。",
        }
    payload.setdefault("ok", completed.returncode == 0)
    return payload


def launch_review_fixback(
    *,
    project: Path,
    change: str,
    change_dir: Path,
    executor: str,
    skills_root: Path,
    product_identity: str,
    run_id: str | None = None,
    attempt: int = 2,
    batch_id: str | None = None,
    task: int | None = None,
    executor_tool: str | None = None,
    executor_agent: str | None = None,
    executor_model: str | None = None,
    context_prepare: Any = None,
    context_begin: Any = None,
    gate_begin: Any = None,
    context_cancel: Any = None,
) -> dict[str, Any]:
    """Plan, claim and begin Review Fixback through one fail-closed command."""

    project = Path(project).resolve()
    change_dir = Path(change_dir).resolve()
    plan = review_fixback_plan(change_dir)
    if not plan.get("ok") or plan.get("code") == "FIXBACK_NOTHING_TO_APPLY":
        return plan
    effective_run_id = run_id or "fixback-" + uuid.uuid4().hex
    effective_attempt = max(2, int(attempt))
    if batch_id is None:
        source = f"{change}:{plan.get('reviewRunId') or 'review'}"
        batch_id = "fb-" + hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
    prepare_fn = context_prepare or _default_context_prepare
    begin_fn = context_begin or _default_context_begin
    gate_fn = gate_begin or _default_gate_begin
    cancel_fn = context_cancel or _default_context_cancel
    started_at = time.monotonic()
    start_event = he.append_event(
        change_dir,
        phase="execute",
        type_="phase.prepare.start",
        note="正在检查评审修复的前置条件。",
        run_id=effective_run_id,
        attempt=effective_attempt,
        trigger="review-fixback",
        from_phase="review",
        executor_tool=executor_tool,
        executor_agent=executor_agent,
        executor_model=executor_model,
    )
    if not start_event.get("ok"):
        return start_event
    callback_args = {
        "project": project,
        "change": change,
        "change_dir": change_dir,
        "executor": executor,
        "skills_root": Path(skills_root).resolve(),
        "run_id": effective_run_id,
        "attempt": effective_attempt,
        "task": task,
        "executor_tool": executor_tool,
        "executor_agent": executor_agent,
        "executor_model": executor_model,
        "preparation_id": effective_run_id,
    }

    def blocked(result: dict[str, Any], *, cancel: bool) -> dict[str, Any]:
        cancellation = cancel_fn(**callback_args) if cancel else None
        duration = max(0, round((time.monotonic() - started_at) * 1000))
        code = str(result.get("code") or "FIXBACK_PREPARATION_BLOCKED")
        message = str(result.get("message") or result.get("error") or "前置条件未满足，修复未启动。")
        he.append_event(
            change_dir,
            phase="execute",
            type_="phase.prepare.end",
            status="BLOCKED",
            code=code,
            message=message,
            run_id=effective_run_id,
            attempt=effective_attempt,
            trigger="review-fixback",
            from_phase="review",
            orchestration_active_ms=duration,
            wall_clock_ms=duration,
            executor_tool=executor_tool,
            executor_agent=executor_agent,
            executor_model=executor_model,
        )
        return {
            "ok": False,
            "code": code,
            "message": message,
            "recoveryAction": "处理提示的前置条件后重新执行 /harness-execute --fixback",
            "preparationDurationMs": duration,
            "contextCancellation": cancellation,
        }

    prepared = prepare_fn(**callback_args)
    if not prepared.get("ok"):
        return blocked(prepared, cancel=False)
    begun = begin_fn(**callback_args)
    if not begun.get("ok"):
        return blocked(begun, cancel=True)
    gate = gate_fn(**callback_args)
    if not gate.get("ok"):
        return blocked(gate, cancel=True)
    batch = open_review_batch(
        change_dir,
        plan=plan,
        batch_id=batch_id,
        product_identity=product_identity,
        run_id=effective_run_id,
        attempt=effective_attempt,
    )
    duration = max(0, round((time.monotonic() - started_at) * 1000))
    he.append_event(
        change_dir,
        phase="execute",
        type_="phase.prepare.end",
        status="STARTED",
        message="前置条件已满足，修复编码已启动。",
        run_id=effective_run_id,
        attempt=effective_attempt,
        trigger="review-fixback",
        from_phase="review",
        orchestration_active_ms=duration,
        wall_clock_ms=duration,
        executor_tool=executor_tool,
        executor_agent=executor_agent,
        executor_model=executor_model,
    )
    return {
        "ok": True,
        "code": "FIXBACK_STARTED",
        "message": f"修复编码已启动，共 {len(batch.get('issues') or [])} 个代码修复项。",
        "runId": effective_run_id,
        "attempt": effective_attempt,
        # close 的 --final-product-identity 必须与 GREEN 证据一致。回显这个值，
        # 调用方就不用自己再推导一遍（推导方式不同就会撞身份不匹配）。
        "resolvedProductIdentity": product_identity,
        "preparationDurationMs": duration,
        "context": prepared,
        "transition": begun,
        "gate": gate,
        "batch": batch,
        # 证据要求随开批次一起交底：晚一步暴露，调用方就已经改完代码，
        # 只能回退伪造 RED。
        "evidenceContract": evidence_contract(
            change_dir=str(change_dir),
            batch_id=str(batch.get("batchId") or ""),
            product_identity=str(batch.get("productIdentity") or ""),
        ),
    }


def resume_batch(
    change_dir: Path,
    *,
    batch_id: str | None,
    product_identity: str | None,
    root_cause: str | None,
    run_id: str | None,
    attempt: int | None,
) -> dict[str, Any]:
    """Open once or resume the active Fixback session with a stable run identity."""
    opened = [item for item in _all_batches(change_dir) if item.get("status") == "OPEN"]
    resumed = bool(opened)
    if opened:
        batch = sorted(opened, key=lambda item: str(item.get("openedAt") or ""))[0]
    else:
        if not batch_id or not product_identity or not root_cause:
            raise ValueError(
                "FIXBACK_RESUME_INPUT_REQUIRED: new sessions require batch-id, "
                "product-identity and root-cause"
            )
        batch = open_batch(
            change_dir,
            batch_id=batch_id,
            product_identity=product_identity,
            root_cause=root_cause,
        )
    session_path = _session_path(change_dir)
    existing: dict[str, Any] = {}
    if session_path.is_file():
        try:
            loaded = json.loads(session_path.read_text(encoding="utf-8-sig"))
            existing = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            existing = {}
    same_open_session = (
        existing.get("status") == "ACTIVE"
        and existing.get("batchId") == batch.get("batchId")
    )
    effective_run_id = (
        str(existing.get("runId"))
        if same_open_session and existing.get("runId")
        else str(run_id or "fixback-" + uuid.uuid4().hex)
    )
    effective_attempt = (
        int(existing.get("attempt"))
        if same_open_session and isinstance(existing.get("attempt"), int)
        else max(1, int(attempt or 1))
    )
    next_step = _next_step(batch)
    session = {
        "schemaVersion": 1,
        "status": "ACTIVE",
        "batchId": batch.get("batchId"),
        "runId": effective_run_id,
        "attempt": effective_attempt,
        "nextStep": next_step,
        "updatedAt": now_iso(),
    }
    _write_json(session_path, session)
    he.append_event(
        change_dir,
        phase="execute",
        type_="decision",
        note=(
            "已恢复现有修复批次，将从未完成步骤继续。"
            if resumed
            else "已创建修复批次，将按问题逐项执行 RED/GREEN。"
        ),
        run_id=effective_run_id,
    )
    return {
        "ok": True,
        "code": "FIXBACK_RESUMED" if resumed else "FIXBACK_OPENED",
        "resumed": resumed,
        "batchId": batch.get("batchId"),
        "runId": effective_run_id,
        "attempt": effective_attempt,
        "nextStep": next_step,
        "requiredVerifications": batch.get("requiredVerifications", []),
        "changedFiles": batch.get("changedFiles", []),
        "sessionPath": str(session_path),
    }


def invalidate_affected_evidence(
    change_dir: Path,
    *,
    changed_files: list[str],
    batch_id: str,
) -> dict[str, Any]:
    """Invalidate only verification targets whose declared inputs were changed."""
    normalized = {
        str(path).replace("\\", "/").lstrip("./")
        for path in changed_files
        if str(path).strip()
    }
    ledger_path = _state_root(change_dir) / "evidence" / "verification-ledger.json"
    if not normalized or not ledger_path.is_file():
        return {"ok": True, "targetIds": [], "validations": []}
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {"ok": False, "code": "FIXBACK_LEDGER_INVALID"}
    if not isinstance(ledger, dict):
        return {"ok": False, "code": "FIXBACK_LEDGER_INVALID"}

    def affected(entry: dict[str, Any]) -> bool:
        inputs = entry.get("inputsFiles")
        if not isinstance(inputs, list):
            return False
        input_set = {
            str(path).replace("\\", "/").lstrip("./")
            for path in inputs
            if str(path).strip()
        }
        return bool(normalized & input_set)

    invalidation = {
        "code": "FIXBACK_AFFECTED_INPUT_CHANGED",
        "batchId": batch_id,
        "changedFiles": sorted(normalized),
        "invalidatedAt": now_iso(),
    }
    target_ids: list[str] = []
    targets = ledger.get("verificationTargets")
    if isinstance(targets, dict):
        for target_id, target in targets.items():
            if isinstance(target, dict) and affected(target):
                target["reusable"] = False
                target["invalidation"] = dict(invalidation)
                target_ids.append(str(target_id))
    validation_names: list[str] = []
    validations = ledger.get("validations")
    if isinstance(validations, dict):
        for name, entry in validations.items():
            if isinstance(entry, dict) and affected(entry):
                entry["reusable"] = False
                entry["invalidation"] = dict(invalidation)
                validation_names.append(str(name))
    _write_json(ledger_path, ledger)
    return {
        "ok": True,
        "targetIds": sorted(target_ids),
        "validations": sorted(validation_names),
    }


def _required_verifications(issues: list[dict[str, Any]]) -> list[str]:
    required = {"affected", "review"}
    for issue in issues:
        for risk in issue.get("riskTags", []):
            required.update(RISK_VERIFICATIONS.get(str(risk), set()))
    return sorted(required)


def _project_root(change_dir: Path) -> Path:
    resolved = change_dir.resolve()
    if (
        resolved.parent.name == "changes"
        and resolved.parent.parent.name == ".harness"
    ):
        return resolved.parent.parent.parent
    return resolved


def _is_within(path: Path, roots: list[Path]) -> bool:
    for root in roots:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _evidence_ledger_path(change_dir: Path) -> Path:
    return _state_root(change_dir) / "fixback" / "evidence-ledger.json"


def _load_evidence_ledger(change_dir: Path) -> dict[str, Any]:
    path = _evidence_ledger_path(change_dir)
    if not path.is_file():
        return {"schemaVersion": 1, "evidence": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"FIXBACK_EVIDENCE_LEDGER_INVALID: {exc}") from exc
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != 1
        or not isinstance(value.get("evidence"), dict)
    ):
        raise ValueError("FIXBACK_EVIDENCE_LEDGER_INVALID")
    return value


def _resolve_evidence_path(change_dir: Path, raw_path: str) -> Path:
    raw = Path(raw_path)
    contract_root = change_dir.resolve()
    state_root = _state_root(change_dir)
    project_root = _project_root(change_dir)
    candidates = (
        [raw.resolve()]
        if raw.is_absolute()
        else [
            (contract_root / raw).resolve(),
            (state_root / raw).resolve(),
            (project_root / raw).resolve(),
        ]
    )
    path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if path is None:
        raise ValueError(evidence_error_message("FIXBACK_EVIDENCE_MISSING", raw_path))
    if not _is_within(path, [contract_root, state_root, project_root]):
        raise ValueError(
            evidence_error_message("FIXBACK_EVIDENCE_OUTSIDE_PROJECT", raw_path)
        )
    return path


def evidence_contract(
    *,
    change_dir: str | None = None,
    batch_id: str | None = None,
    product_identity: str | None = None,
) -> dict[str, Any]:
    """开批次时就交出证据契约，而不是等 resolve-issue 报错才逼调用方逆向。

    契约本身没变过：每个 code 项需要一条修复前的 RED（会话 FAIL）与一条修复后的
    GREEN（会话 OK），两者都必须是 run-start 产出的托管会话证据，且先注册后引用。
    问题在于它此前只写在实现里——调用方通常已经改完代码才发现 RED 要"修复前"，
    于是把改动回退、跑一次假 RED、再改回来，凭空多出一轮返工与一段脏工作树。
    """
    change = change_dir or "<change-dir>"
    batch = batch_id or "<batch-id>"
    product = product_identity or "<product-identity>"
    return {
        "why": "RED 证明问题真实存在，GREEN 证明修复真的生效；缺任一条都无法关批次。",
        "order": [
            "1. 修复前：先用 run-start 跑一次能复现该问题的命令，得到 status=FAIL 的会话（RED）",
            "2. 实施修复",
            "3. 修复后：用同一条命令再跑一次 run-start，得到 status=OK 的会话（GREEN）",
            "4. 两条证据用 evidence-template 生成，再分别 register-evidence 注册",
            "5. resolve-issue 引用这两个已注册的证据文件",
            "6. 关批次前还需两张收据：affected（kind=verification，受影响链的托管会话）"
            "与 review（kind=review，指向 review-findings.json）",
            "7. close 引用这两张收据，--final-product-identity 取 launch-review 回显的 "
            "resolvedProductIdentity",
        ],
        "antiPattern": (
            "不要先改完再把修改回退来凑 RED：那样 RED 证明的只是回退后的状态，"
            "不是原始缺陷，中途还会留下脏工作树。"
        ),
        "commands": {
            "collectSession": (
                "python harness_runtime.py run-start --state-root "
                f"{change} --verification <名称> --working-directory . "
                f"--product-identity {product} --json -- <复现/验证命令>"
            ),
            "awaitSession": (
                "python harness_runtime.py run-status --state-root "
                f"{change} --session-id <sessionId> --wait --json"
            ),
            "register": (
                "python harness_fixback.py register-evidence --change-dir "
                f"{change} --evidence <证据 JSON 路径>"
            ),
            "resolve": (
                "python harness_fixback.py resolve-issue --change-dir "
                f"{change} --batch-id {batch} --issue-id <issueId> "
                "--red-evidence <red.json> --green-evidence <green.json>"
            ),
            "template": (
                "python harness_fixback.py evidence-template --change-dir "
                f"{change} --kind red|green|verification|review "
                "--session <sessionId> --out <证据 JSON 路径>"
            ),
            "close": (
                "python harness_fixback.py close --change-dir "
                f"{change} --batch-id {batch} --final-product-identity {product} "
                "--affected-receipt <verification.json> --review-receipt <review.json>"
            ),
        },
        "evidenceFile": {
            "schemaVersion": 2,
            "kind": ["red", "green"],
            "status": {"red": "FAIL", "green": "OK"},
            "provenance": {
                "type": "managed-run-session",
                "note": "指向 run-start 产出的 runtime/run-sessions/<sessionId>/session.json",
                "requiredFields": [
                    "sessionId",
                    "commandHash",
                    "resultDigest",
                    "runReceiptPath",
                ],
                "hint": "这四个字段都从 session.json 直接读；用 evidence-template 生成即可，不必手抄。",
            },
        },
        "reviewReceipt": {
            "kind": "review",
            "provenance": {
                "type": "harness-review",
                "reviewReportPath": "reports/review/review-findings.json",
                "engine": "harness-review-6d",
            },
            "blocks": (
                "只有 disposition 为 OPEN/未登记 的 RED/YELLOW 会挡住收据。"
                "已判定 FIXED / NOT_APPLICABLE 的放行；ACCEPTED_RISK / DEFERRED 放行"
                "并记入收据的 residualRisks。"
            ),
            "antiPattern": (
                "不要为了让 close 通过而清空或删改 review-findings.json——那是发现的真相源，"
                "写空等于抹掉整轮审查的审计轨迹。处置结论写进 fixback-dispositions.json："
                "python harness_review.py write-dispositions --change-dir <dir> --input <json>"
            ),
        },
    }


_EVIDENCE_ERROR_HINTS = {
    "FIXBACK_EVIDENCE_MISSING": (
        "路径未找到证据文件。它应当是 run-start 产出的托管会话证据 JSON"
        "（schemaVersion=2，kind=red|green，provenance.type=managed-run-session）；"
        "先用 run-start 采集会话，再据此写证据文件。"
    ),
    "FIXBACK_EVIDENCE_UNREGISTERED": (
        "证据文件存在但未注册，或注册后内容已变。"
        "先执行 register-evidence 注册（内容改动后需重新注册），再引用。"
    ),
    "FIXBACK_EVIDENCE_INVALID": (
        "证据文件不是合法的 schemaVersion=2 托管会话证据。"
        "检查 kind / status / provenance 三个字段。"
    ),
    "FIXBACK_EVIDENCE_OUTSIDE_PROJECT": (
        "证据路径落在项目之外。证据必须放在变更目录或项目内，便于随归档留痕。"
    ),
}


def evidence_error_message(code: str, raw_path: str) -> str:
    """把只回显路径的错误码，补成能直接照做的一句话。"""
    hint = _EVIDENCE_ERROR_HINTS.get(code)
    base = f"{code}: {raw_path}"
    return base if hint is None else f"{base} — {hint}"


# 一条发现"还没被处置"才该挡住收据。OPEN 是显式待办，UNKNOWN 是根本没登记；
# 其余（FIXED / NOT_APPLICABLE / ACCEPTED_RISK / DEFERRED）都已有人做过判断。
_UNPROCESSED_DISPOSITIONS = {"OPEN", "UNKNOWN"}


def _load_dispositions(change_dir: Path) -> dict[str, str]:
    """读 fixback-dispositions.json；缺失或损坏都按"无处置"处理，不抛。"""
    path = hr.dispositions_path(change_dir)
    if not path.is_file():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(doc, dict):
        return {}
    mapping: dict[str, str] = {}
    for item in doc.get("dispositions") or []:
        if isinstance(item, dict):
            finding_id = item.get("findingId")
            if isinstance(finding_id, str) and finding_id.strip():
                mapping[finding_id] = str(item.get("disposition") or "")
    return mapping


def classify_review_findings(
    change_dir: Path, findings: Any
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """按 disposition 把 RED/YELLOW 分成"未处置（阻塞）"与"已接受的残留风险"。

    此前这里只看 severity：只要 findings 里还有一条 RED/YELLOW，收据就永远注册
    不了。唯一能过关的做法是把 review-findings.json 清空——2026-08-19 的执行记录
    里就是这么干的，3 条原始发现加 2 条复审发现的审计轨迹被一次写空抹掉。

    findings sidecar 是发现的真相源，dispositions sidecar 才是处置的真相源。
    门禁该问的是"还有没有没人处理的问题"，不是"还有没有问题"。
    """
    dispositions = _load_dispositions(change_dir)
    blocking: list[dict[str, Any]] = []
    residual: list[dict[str, Any]] = []
    for item in findings or []:
        if not isinstance(item, dict) or item.get("severity") not in {"RED", "YELLOW"}:
            continue
        finding_id = str(item.get("id") or "")
        disposition = dispositions.get(finding_id) or "UNKNOWN"
        if disposition not in hr.DISPOSITIONS:
            disposition = "UNKNOWN"
        entry = {
            "findingId": finding_id,
            "severity": item.get("severity"),
            "title": item.get("title"),
            "disposition": disposition,
        }
        if disposition in _UNPROCESSED_DISPOSITIONS:
            blocking.append(entry)
        elif disposition in hr.CURRENT_RISK_DISPOSITIONS:
            residual.append(entry)
    return residual, blocking


def _provenance_error(code: str, problems: list[dict[str, Any]], recovery: str) -> ValueError:
    """把只有错误码的失败，补成"哪个字段、期望什么、实际什么、怎么修"。"""
    detail = "; ".join(
        f"{item['field']}: expected={item['expected']!r} actual={item['actual']!r}"
        for item in problems
    )
    return ValueError(f"{code}: {detail} — {recovery}")


def resolve_product_identity(change_dir: Path) -> str:
    """推导当前产品身份。

    `--product-identity` 在 5 个子命令里必填，却在全仓文档里零命中；调用方只能去
    读源码猜，猜完还要在 close 时原样复述一遍。规范取值就是当前 HEAD——把它做成
    可推导的默认值，猜的环节就没有了。
    """
    project_root = _project_root(change_dir)
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        result = None
    if result is not None and result.returncode == 0:
        head = (result.stdout or "").strip()
        if head:
            return head
    # 非 git 工作区（或 git 不可用）仍需一个稳定值，否则两次推导不一致会让
    # close 的身份比对无故失败。
    digest = hashlib.sha256(str(project_root).encode("utf-8")).hexdigest()
    return f"unversioned:{digest}"


_EVIDENCE_KINDS = ("red", "green", "verification", "review")
_KIND_EXPECTED_SESSION_STATUS = {"red": "FAIL", "green": "OK", "verification": "OK"}
_KIND_EVIDENCE_STATUS = {"red": "FAIL", "green": "OK", "verification": "OK", "review": "OK"}
_KIND_DEFAULT_GATES = {"verification": ["affected"], "review": ["review"]}


def evidence_template(
    change_dir: Path,
    *,
    kind: str,
    session_id: str | None = None,
    out: str | None = None,
    evidence_id: str | None = None,
    product_identity: str | None = None,
    passed_gates: list[str] | None = None,
) -> dict[str, Any]:
    """从托管会话/审查 sidecar 直接生成可注册的证据文件。

    ledger 早就有 scenario-receipt-template，一次就能给对骨架；fixback 没有同类
    入口，于是每条证据都得手写 JSON，再靠 FIXBACK_*_PROVENANCE_INVALID 反推缺了
    哪个字段。sessionId / commandHash / resultDigest 三个字段全都能从 session.json
    直接读出来——让人手抄它们没有任何意义。
    """
    if kind not in _EVIDENCE_KINDS:
        return {
            "ok": False,
            "code": "FIXBACK_EVIDENCE_KIND_INVALID",
            "kind": kind,
            "recoveryAction": f"--kind 必须是 {'/'.join(_EVIDENCE_KINDS)} 之一。",
        }
    state_root = _state_root(change_dir)
    identity = (product_identity or "").strip()
    gates = list(passed_gates) if passed_gates else list(_KIND_DEFAULT_GATES.get(kind, []))

    if kind == "review":
        review_path = (state_root / "reports" / "review" / "review-findings.json").resolve()
        if not review_path.is_file():
            return {
                "ok": False,
                "code": "FIXBACK_REVIEW_FINDINGS_MISSING",
                "expectedPath": str(review_path),
                "recoveryAction": (
                    "先用 harness_review.py write-findings 写入本轮审查发现，"
                    "再生成 review 证据。"
                ),
            }
        review = json.loads(review_path.read_text(encoding="utf-8-sig"))
        residual, blocking = classify_review_findings(change_dir, review.get("findings"))
        if blocking:
            return {
                "ok": False,
                "code": "FIXBACK_REVIEW_FINDINGS_UNDISPOSITIONED",
                "blocking": blocking,
                "recoveryAction": (
                    "以下发现尚未处置："
                    + ", ".join(str(item["findingId"]) for item in blocking)
                    + "。用 harness_review.py write-dispositions 标注 FIXED / "
                    "ACCEPTED_RISK / DEFERRED / NOT_APPLICABLE 后重试；"
                    "不要删改 review-findings.json——它是发现的真相源。"
                ),
            }
        provenance = {
            "type": "harness-review",
            "reviewReportPath": str(review_path),
            "reviewRunId": review.get("runId"),
            "engine": "harness-review-6d",
            "sourceDigest": "sha256:" + hashlib.sha256(review_path.read_bytes()).hexdigest(),
        }
        resolved_id = evidence_id or f"review-{review.get('runId') or uuid.uuid4().hex}"
        if not identity:
            identity = resolve_product_identity(change_dir)
        extra: dict[str, Any] = {"residualRisks": residual}
    else:
        if not (session_id or "").strip():
            return {
                "ok": False,
                "code": "FIXBACK_SESSION_REQUIRED",
                "recoveryAction": (
                    f"--kind {kind} 需要 --session <sessionId>；先用 "
                    "harness_runtime.py run-start 采集托管会话，再用它的 sessionId。"
                ),
            }
        run_path = (
            state_root / "runtime" / "run-sessions" / str(session_id) / "session.json"
        ).resolve()
        if not run_path.is_file():
            return {
                "ok": False,
                "code": "FIXBACK_SESSION_MISSING",
                "expectedPath": str(run_path),
                "recoveryAction": (
                    "该 sessionId 下没有 session.json。确认 run-start 的 "
                    f"--state-root 指向 {state_root}，并用 run-status --wait 等到终态。"
                ),
            }
        run = json.loads(run_path.read_text(encoding="utf-8-sig"))
        expected_status = _KIND_EXPECTED_SESSION_STATUS[kind]
        actual_status = str(run.get("status") or "")
        if actual_status != expected_status:
            return {
                "ok": False,
                "code": "FIXBACK_SESSION_STATUS_MISMATCH",
                "kind": kind,
                "expectedStatus": expected_status,
                "actualStatus": actual_status,
                "recoveryAction": (
                    f"kind={kind} 需要 status={expected_status} 的会话，实际是 "
                    f"{actual_status or '(空)'}。RED 必须来自**修复前**能复现问题的失败"
                    "会话（FAIL）；不要先改完再回退代码去凑 RED——那证明的是回退后的"
                    "状态，不是原始缺陷。"
                ),
            }
        provenance = {
            "type": "managed-run-session",
            "runReceiptPath": str(run_path),
            "sessionId": run.get("sessionId"),
            "commandHash": run.get("commandHash"),
            "resultDigest": run.get("resultDigest"),
        }
        resolved_id = evidence_id or f"{kind}-{session_id}"
        if not identity:
            identity = str(run.get("productIdentity") or "").strip() or resolve_product_identity(
                change_dir
            )
        extra = {}

    evidence = {
        "schemaVersion": 2,
        "kind": kind,
        "status": _KIND_EVIDENCE_STATUS[kind],
        "evidenceId": resolved_id,
        "productIdentity": identity,
        "passedGates": gates,
        "provenance": provenance,
    }
    target = Path(out) if out else Path("runtime") / f"fixback-{resolved_id}.json"
    path = target if target.is_absolute() else (change_dir / target)
    path = path.resolve()
    if not _is_within(path, [change_dir.resolve(), state_root, _project_root(change_dir)]):
        return {
            "ok": False,
            "code": "FIXBACK_EVIDENCE_OUTSIDE_PROJECT",
            "path": str(path),
            "recoveryAction": "--out 必须落在变更目录或项目内，证据才能随归档留痕。",
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return {
        "ok": True,
        "code": "FIXBACK_EVIDENCE_TEMPLATE_WRITTEN",
        "path": str(path),
        "kind": kind,
        "evidenceId": resolved_id,
        "productIdentity": identity,
        "evidence": evidence,
        "nextAction": (
            "python harness_fixback.py register-evidence --change-dir "
            f"{change_dir} --evidence {path}"
        ),
        **extra,
    }


def register_evidence(change_dir: Path, raw_path: str) -> dict[str, Any]:
    """Register evidence only after validating its authoritative provenance."""
    path = _resolve_evidence_path(change_dir, raw_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != 2:
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}")
    kind = str(value.get("kind") or "")
    status = str(value.get("status") or "").upper()
    evidence_id = str(value.get("evidenceId") or "").strip()
    product_identity = str(value.get("productIdentity") or "").strip()
    passed_gates = value.get("passedGates")
    provenance = value.get("provenance")
    if (
        kind not in {"red", "green", "verification", "review"}
        or status not in {"FAIL", "PASS", "OK"}
        or not evidence_id
        or not product_identity
        or not isinstance(passed_gates, list)
        or any(not isinstance(item, str) or not item.strip() for item in passed_gates)
        or not isinstance(provenance, dict)
    ):
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}")
    state_root = _state_root(change_dir)
    residual_risks: list[dict[str, Any]] = []
    if kind in {"red", "green", "verification"}:
        if provenance.get("type") != "managed-run-session":
            raise ValueError("FIXBACK_RUN_PROVENANCE_REQUIRED")
        run_path = _resolve_evidence_path(
            change_dir, str(provenance.get("runReceiptPath") or "")
        )
        expected_run_root = (state_root / "runtime" / "run-sessions").resolve()
        if not _is_within(run_path, [expected_run_root]) or run_path.name != "session.json":
            raise ValueError("FIXBACK_RUN_PROVENANCE_INVALID")
        try:
            run = json.loads(run_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("FIXBACK_RUN_PROVENANCE_INVALID") from exc
        expected_status = "FAIL" if kind == "red" else "OK"
        if not isinstance(run, dict):
            raise _provenance_error(
                "FIXBACK_RUN_PROVENANCE_INVALID",
                [{"field": "session.json", "expected": "object", "actual": type(run).__name__}],
                "run-start 产出的 session.json 应当是一个 JSON 对象。",
            )
        # 逐字段比对而不是一个大 or：只回显错误码时，调用方唯一的出路是去读源码
        # 反推是哪一项不匹配（2026-08-19 的执行记录里就读了三遍）。
        checks = [
            ("status", expected_status, run.get("status")),
            ("testProcessStarted", True, run.get("testProcessStarted")),
            ("session.productIdentity", product_identity, run.get("productIdentity")),
            ("provenance.sessionId", run.get("sessionId"), provenance.get("sessionId")),
            ("provenance.commandHash", run.get("commandHash"), provenance.get("commandHash")),
            ("provenance.resultDigest", run.get("resultDigest"), provenance.get("resultDigest")),
        ]
        problems = [
            {"field": field, "expected": expected, "actual": actual}
            for field, expected, actual in checks
            if expected != actual
        ]
        for field in ("commandHash", "resultDigest"):
            value = str(run.get(field) or "")
            if not value.startswith("sha256:"):
                problems.append(
                    {"field": f"session.{field}", "expected": "sha256:...", "actual": value}
                )
        if not str(run.get("endedAt") or "").strip():
            problems.append({"field": "session.endedAt", "expected": "非空时间戳", "actual": ""})
        if problems:
            raise _provenance_error(
                "FIXBACK_RUN_PROVENANCE_INVALID",
                problems,
                "不要手改证据文件去对齐；用 `harness_fixback.py evidence-template "
                f"--change-dir {change_dir} --kind {kind} --session <sessionId>` "
                "重新生成，它直接从 session.json 取这些字段。",
            )
    else:
        if provenance.get("type") != "harness-review":
            raise ValueError("FIXBACK_REVIEW_PROVENANCE_REQUIRED")
        review_path = _resolve_evidence_path(
            change_dir, str(provenance.get("reviewReportPath") or "")
        )
        expected_review_path = (
            state_root / "reports" / "review" / "review-findings.json"
        ).resolve()
        if review_path != expected_review_path:
            raise ValueError("FIXBACK_REVIEW_PROVENANCE_INVALID")
        try:
            review = json.loads(review_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("FIXBACK_REVIEW_PROVENANCE_INVALID") from exc
        source_digest = "sha256:" + hashlib.sha256(review_path.read_bytes()).hexdigest()
        findings = review.get("findings") if isinstance(review, dict) else None
        problems: list[dict[str, Any]] = []
        if not isinstance(review, dict) or review.get("schemaVersion") != 1:
            problems.append({
                "field": "review-findings.schemaVersion",
                "expected": 1,
                "actual": review.get("schemaVersion") if isinstance(review, dict) else None,
            })
        if not isinstance(findings, list):
            problems.append({
                "field": "review-findings.findings",
                "expected": "list",
                "actual": type(findings).__name__,
            })
        for field, expected, actual in (
            (
                "provenance.reviewRunId",
                review.get("runId") if isinstance(review, dict) else None,
                provenance.get("reviewRunId"),
            ),
            ("provenance.engine", "harness-review-6d", provenance.get("engine")),
            ("provenance.sourceDigest", source_digest, provenance.get("sourceDigest")),
        ):
            if expected != actual:
                problems.append({"field": field, "expected": expected, "actual": actual})
        if problems:
            raise _provenance_error(
                "FIXBACK_REVIEW_PROVENANCE_INVALID",
                problems,
                "用 `harness_fixback.py evidence-template --change-dir "
                f"{change_dir} --kind review` 重新生成 review 证据。",
            )
        # 只有"没人处置过"的 RED/YELLOW 才该挡住收据；已判定 FIXED / ACCEPTED_RISK /
        # DEFERRED / NOT_APPLICABLE 的照常放行，findings sidecar 原样保留。
        residual_risks, blocking = classify_review_findings(change_dir, findings)
        if blocking:
            raise _provenance_error(
                "FIXBACK_REVIEW_PROVENANCE_INVALID",
                [
                    {
                        "field": f"finding[{item['findingId']}]",
                        "expected": "已处置（FIXED / ACCEPTED_RISK / DEFERRED / NOT_APPLICABLE）",
                        "actual": item["disposition"],
                    }
                    for item in blocking
                ],
                "用 `harness_review.py write-dispositions` 为这些发现登记处置结论后重试。"
                "**不要**清空或删改 review-findings.json——它是发现的真相源，"
                "处置结论属于 fixback-dispositions.json。",
            )
    record = {
        "path": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "evidenceId": evidence_id,
        "kind": kind,
        "status": status,
        "productIdentity": product_identity,
        "passedGates": sorted(set(passed_gates)),
        "provenance": provenance,
        # 已接受/已推迟的风险必须随收据留痕，否则"放行"会读成"没有问题"。
        "residualRisks": residual_risks,
        "registeredAt": now_iso(),
    }
    ledger = _load_evidence_ledger(change_dir)
    existing = ledger["evidence"].get(evidence_id)
    if existing is not None:
        # residualRisks 是从 dispositions 派生的上下文，不属于证据自身的身份；
        # 把它算进比对会让"处置结论更新后重新注册"误报 ID 复用。
        derived = {"registeredAt", "residualRisks"}
        comparable = {
            key: value
            for key, value in record.items()
            if key not in derived
        }
        existing_comparable = {
            key: value
            for key, value in existing.items()
            if key not in derived
        } if isinstance(existing, dict) else {}
        if existing_comparable != comparable:
            raise ValueError(f"FIXBACK_EVIDENCE_ID_REUSED: {evidence_id}")
        return existing
    ledger["evidence"][evidence_id] = record
    _write_json(_evidence_ledger_path(change_dir), ledger)
    return record


def _evidence_record(
    change_dir: Path,
    raw_path: str,
    *,
    kind: str,
    statuses: set[str],
    product_identity: str | None = None,
) -> dict[str, Any]:
    path = _resolve_evidence_path(change_dir, raw_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}")
    status = str(value.get("status") or "").upper()
    evidence_product = str(value.get("productIdentity") or "").strip()
    evidence_id = str(value.get("evidenceId") or "").strip()
    if (
        value.get("schemaVersion") != 2
        or value.get("kind") != kind
        or status not in statuses
        or not evidence_product
        or not evidence_id
    ):
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}")
    passed_gates = value.get("passedGates")
    if not isinstance(passed_gates, list) or any(
        not isinstance(item, str) or not item.strip()
        for item in passed_gates
    ):
        raise ValueError(f"FIXBACK_EVIDENCE_INVALID: {raw_path}")
    ledger_record = _load_evidence_ledger(change_dir)["evidence"].get(evidence_id)
    current_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if (
        not isinstance(ledger_record, dict)
        or ledger_record.get("path") != str(path)
        or ledger_record.get("sha256") != current_sha
        or ledger_record.get("kind") != kind
        or ledger_record.get("status") != status
        or ledger_record.get("productIdentity") != evidence_product
        or ledger_record.get("passedGates") != sorted(set(passed_gates))
    ):
        raise ValueError(
            evidence_error_message("FIXBACK_EVIDENCE_UNREGISTERED", raw_path)
        )
    if product_identity is not None and evidence_product != product_identity:
        raise ValueError(
            "FIXBACK_EVIDENCE_IDENTITY_MISMATCH: "
            f"{raw_path}: expected={product_identity} actual={evidence_product}"
        )
    return {
        "path": str(path),
        "sha256": current_sha,
        "evidenceId": evidence_id,
        "kind": kind,
        "status": status,
        "productIdentity": evidence_product,
        "passedGates": sorted(set(passed_gates)),
        "provenance": ledger_record["provenance"],
    }


def _changed_file_record(change_dir: Path, raw_path: str) -> dict[str, str]:
    root = _project_root(change_dir)
    raw = Path(raw_path)
    path = raw.resolve() if raw.is_absolute() else (root / raw).resolve()
    if not path.is_file():
        raise ValueError(f"FIXBACK_CHANGED_FILE_MISSING: {raw_path}")
    if not _is_within(path, [root]):
        raise ValueError(f"FIXBACK_CHANGED_FILE_OUTSIDE_PROJECT: {raw_path}")
    return {
        "path": str(path.relative_to(root)).replace("\\", "/"),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def _evidence_digest_matches(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    try:
        path = Path(str(record["path"]))
        expected = str(record["sha256"])
        return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected
    except (KeyError, OSError):
        return False


def open_batch(
    change_dir: Path,
    *,
    batch_id: str,
    product_identity: str,
    root_cause: str,
) -> dict[str, Any]:
    if not product_identity.strip():
        raise ValueError("FIXBACK_PRODUCT_IDENTITY_REQUIRED")
    if not root_cause.strip():
        raise ValueError("FIXBACK_ROOT_CAUSE_REQUIRED")
    open_batches = [
        item for item in _all_batches(change_dir)
        if item.get("status") == "OPEN"
    ]
    if open_batches:
        raise ValueError(
            "FIXBACK_BATCH_ALREADY_OPEN: " + str(open_batches[0].get("batchId"))
        )
    path = _batch_path(change_dir, batch_id)
    if path.exists():
        raise ValueError(f"FIXBACK_BATCH_EXISTS: {batch_id}")
    opened_at = now_iso()
    batch = {
        "schemaVersion": SCHEMA_VERSION,
        "batchId": batch_id,
        "status": "OPEN",
        "rootCause": root_cause,
        "openedAt": opened_at,
        "updatedAt": opened_at,
        "closedAt": None,
        "baseProductIdentity": product_identity,
        "finalProductIdentity": None,
        "issues": [],
        "changedFiles": [],
        "requiredVerifications": ["affected", "review"],
        "receipts": {
            "affected": None,
            "review": None,
        },
        "verificationRuns": {
            "affected": 0,
            "review": 0,
        },
    }
    _write_json(path, batch)
    return batch


def add_issue(
    change_dir: Path,
    *,
    batch_id: str,
    issue_id: str,
    summary: str,
    risk_tags: list[str],
) -> dict[str, Any]:
    batch = _load(change_dir, batch_id)
    if batch.get("status") != "OPEN":
        raise ValueError(f"FIXBACK_BATCH_CLOSED: {batch_id}")
    if any(item.get("issueId") == issue_id for item in batch["issues"]):
        raise ValueError(f"FIXBACK_ISSUE_EXISTS: {issue_id}")
    issue = {
        "issueId": issue_id,
        "summary": summary,
        "status": "OPEN",
        "riskTags": sorted(set(risk_tags)),
        "redEvidence": None,
        "greenEvidence": None,
        "changedFiles": [],
        "resolvedAt": None,
    }
    batch["issues"].append(issue)
    batch["requiredVerifications"] = _required_verifications(batch["issues"])
    batch["updatedAt"] = now_iso()
    _write_json(_batch_path(change_dir, batch_id), batch)
    return issue


def resolve_issue(
    change_dir: Path,
    *,
    batch_id: str,
    issue_id: str,
    red_evidence: str,
    green_evidence: str,
    changed_files: list[str],
) -> dict[str, Any]:
    if not red_evidence.strip() or not green_evidence.strip():
        raise ValueError(f"FIXBACK_RED_GREEN_REQUIRED: {issue_id}")
    batch = _load(change_dir, batch_id)
    if batch.get("status") != "OPEN":
        raise ValueError(f"FIXBACK_BATCH_CLOSED: {batch_id}")
    issue = next(
        (item for item in batch["issues"] if item.get("issueId") == issue_id),
        None,
    )
    if issue is None:
        raise ValueError(f"FIXBACK_ISSUE_NOT_FOUND: {issue_id}")
    red_record = _evidence_record(
        change_dir,
        red_evidence,
        kind="red",
        statuses={"FAIL"},
        product_identity=str(batch["baseProductIdentity"]),
    )
    green_record = _evidence_record(
        change_dir,
        green_evidence,
        kind="green",
        statuses={"PASS", "OK"},
    )
    if red_record["evidenceId"] == green_record["evidenceId"]:
        raise ValueError(f"FIXBACK_EVIDENCE_ID_REUSED: {issue_id}")
    changed_records = [
        _changed_file_record(change_dir, raw_path)
        for raw_path in sorted(set(changed_files))
    ]
    resolved_at = now_iso()
    issue.update(
        {
            "status": "RESOLVED",
            "redEvidence": red_record,
            "greenEvidence": green_record,
            "changedFiles": changed_records,
            "resolvedAt": resolved_at,
        }
    )
    batch["changedFiles"] = sorted(
        {
            record["path"]
            for item in batch["issues"]
            for record in item.get("changedFiles", [])
        }
    )
    batch["updatedAt"] = resolved_at
    batch["invalidation"] = invalidate_affected_evidence(
        change_dir,
        changed_files=[record["path"] for record in changed_records],
        batch_id=batch_id,
    )
    _write_json(_batch_path(change_dir, batch_id), batch)
    return issue


def close_batch(
    change_dir: Path,
    *,
    batch_id: str,
    final_product_identity: str,
    affected_receipt: str,
    review_receipt: str,
) -> dict[str, Any]:
    batch = _load(change_dir, batch_id)
    if batch.get("status") != "OPEN":
        raise ValueError(f"FIXBACK_BATCH_CLOSED: {batch_id}")
    unresolved = [
        str(item.get("issueId"))
        for item in batch["issues"]
        if item.get("status") != "RESOLVED"
        or not item.get("redEvidence")
        or not item.get("greenEvidence")
    ]
    if unresolved:
        raise ValueError(
            "FIXBACK_ISSUES_UNRESOLVED: " + ",".join(unresolved)
        )
    if not affected_receipt.strip() or not review_receipt.strip():
        raise ValueError("FIXBACK_BATCH_RECEIPTS_REQUIRED")
    if not final_product_identity.strip():
        raise ValueError("FIXBACK_FINAL_IDENTITY_REQUIRED")
    for issue in batch["issues"]:
        green = issue.get("greenEvidence")
        if not isinstance(green, dict) or (
            green.get("productIdentity") != final_product_identity
        ):
            raise ValueError(
                "FIXBACK_GREEN_IDENTITY_MISMATCH: "
                + str(issue.get("issueId"))
            )
    affected_record = _evidence_record(
        change_dir,
        affected_receipt,
        kind="verification",
        statuses={"PASS", "OK"},
        product_identity=final_product_identity,
    )
    review_record = _evidence_record(
        change_dir,
        review_receipt,
        kind="review",
        statuses={"PASS", "OK"},
        product_identity=final_product_identity,
    )
    passed_gates = set(affected_record["passedGates"]) | set(
        review_record["passedGates"]
    )
    missing_gates = sorted(
        set(batch["requiredVerifications"]) - passed_gates
    )
    if missing_gates:
        raise ValueError(
            "FIXBACK_REQUIRED_GATES_MISSING: " + ",".join(missing_gates)
        )
    closed_at = now_iso()
    batch.update(
        {
            "status": "CLOSED",
            "closedAt": closed_at,
            "updatedAt": closed_at,
            "finalProductIdentity": final_product_identity,
            "receipts": {
                "affected": affected_record,
                "review": review_record,
            },
            "verificationRuns": {
                "affected": 1,
                "review": 1,
            },
        }
    )
    _write_json(_batch_path(change_dir, batch_id), batch)
    return batch


def batch_status(change_dir: Path, batch_id: str) -> dict[str, Any]:
    return _load(change_dir, batch_id)


def freeze_readiness(
    change_dir: Path,
    *,
    product_identity: str,
) -> dict[str, Any]:
    batches = _all_batches(change_dir)
    opened = [item for item in batches if item.get("status") == "OPEN"]
    if opened:
        return {
            "ok": False,
            "code": "FIXBACK_BATCH_OPEN",
            "batchIds": [item.get("batchId") for item in opened],
        }
    closed = sorted(
        (
            item for item in batches
            if item.get("status") == "CLOSED"
        ),
        key=lambda item: str(item.get("closedAt") or ""),
    )
    if closed and closed[-1].get("finalProductIdentity") != product_identity:
        return {
            "ok": False,
            "code": "FIXBACK_IDENTITY_CHANGED_AFTER_CLOSE",
            "batchId": closed[-1].get("batchId"),
            "expected": closed[-1].get("finalProductIdentity"),
            "actual": product_identity,
        }
    for batch in closed:
        records = [
            batch.get("receipts", {}).get("affected"),
            batch.get("receipts", {}).get("review"),
        ]
        for issue in batch.get("issues", []):
            records.extend(
                [issue.get("redEvidence"), issue.get("greenEvidence")]
            )
        if any(not _evidence_digest_matches(record) for record in records):
            return {
                "ok": False,
                "code": "FIXBACK_EVIDENCE_CHANGED",
                "batchId": batch.get("batchId"),
            }
    return {
        "ok": True,
        "code": "FIXBACK_READY_FOR_FREEZE",
        "closedBatchCount": len(closed),
    }


def _emit(value: dict[str, Any]) -> int:
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0 if value.get("ok", True) else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_fixback.py")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    resume = sub.add_parser("resume")
    resume.add_argument("--json", action="store_true")
    resume.add_argument("--change-dir", required=True)
    resume.add_argument("--batch-id")
    resume.add_argument("--product-identity", help="产品身份指纹，用于把 RED/GREEN 证据绑定到同一产品状态。规范取值是当前 git HEAD；省略则自动推导并在返回体的 resolvedProductIdentity 里回显，close 时原样引用即可。")
    resume.add_argument("--root-cause")
    resume.add_argument("--run-id")
    resume.add_argument("--attempt", type=int)
    opened = sub.add_parser("open")
    opened.add_argument("--change-dir", required=True)
    opened.add_argument("--batch-id", required=True)
    opened.add_argument("--product-identity", required=True, help="产品身份指纹，用于把 RED/GREEN 证据绑定到同一产品状态。规范取值是当前 git HEAD；省略则自动推导并在返回体的 resolvedProductIdentity 里回显，close 时原样引用即可。")
    opened.add_argument("--root-cause", required=True)
    issue = sub.add_parser("add-issue")
    issue.add_argument("--change-dir", required=True)
    issue.add_argument("--batch-id", required=True)
    issue.add_argument("--issue-id", required=True)
    issue.add_argument("--summary", required=True)
    issue.add_argument("--risk-tag", action="append", default=[])
    resolve = sub.add_parser("resolve-issue")
    resolve.add_argument("--change-dir", required=True)
    resolve.add_argument("--batch-id", required=True)
    resolve.add_argument("--issue-id", required=True)
    resolve.add_argument("--red-evidence", required=True)
    resolve.add_argument("--green-evidence", required=True)
    resolve.add_argument("--changed-file", action="append", default=[])
    close = sub.add_parser("close")
    close.add_argument("--change-dir", required=True)
    close.add_argument("--batch-id", required=True)
    close.add_argument(
        "--final-product-identity",
        required=True,
        help=(
            "关批次时的产品身份，必须与每条 GREEN 证据的 productIdentity 相同。"
            "取 launch-review 回显的 resolvedProductIdentity，不要另行推导。"
        ),
    )
    close.add_argument("--affected-receipt", required=True)
    close.add_argument("--review-receipt", required=True)
    status = sub.add_parser("status")
    status.add_argument("--change-dir", required=True)
    status.add_argument("--batch-id", required=True)
    freeze = sub.add_parser("freeze-readiness")
    freeze.add_argument("--change-dir", required=True)
    freeze.add_argument("--product-identity", required=True, help="产品身份指纹，用于把 RED/GREEN 证据绑定到同一产品状态。规范取值是当前 git HEAD；省略则自动推导并在返回体的 resolvedProductIdentity 里回显，close 时原样引用即可。")
    register = sub.add_parser("register-evidence")
    register.add_argument("--change-dir", required=True)
    register.add_argument("--evidence", required=True)
    template = sub.add_parser(
        "evidence-template",
        help="从托管会话/审查 sidecar 生成可直接注册的证据 JSON",
    )
    template.add_argument("--change-dir", required=True)
    template.add_argument(
        "--kind",
        required=True,
        choices=list(_EVIDENCE_KINDS),
        help="red=修复前失败会话；green=修复后成功会话；verification=受影响链；review=审查收据",
    )
    template.add_argument(
        "--session",
        help="run-start 产出的 sessionId（kind=red/green/verification 必填）",
    )
    template.add_argument("--out", help="输出路径，默认 runtime/fixback-<evidenceId>.json")
    template.add_argument("--evidence-id")
    template.add_argument("--product-identity", help="产品身份指纹，用于把 RED/GREEN 证据绑定到同一产品状态。规范取值是当前 git HEAD；省略则自动推导并在返回体的 resolvedProductIdentity 里回显，close 时原样引用即可。")
    template.add_argument("--passed-gate", action="append", default=[])
    template.add_argument("--json", action="store_true")
    review_plan = sub.add_parser("review-plan")
    review_plan.add_argument("--change-dir", required=True)
    review_plan.add_argument("--json", action="store_true")
    review_start = sub.add_parser("start-review")
    review_start.add_argument("--change-dir", required=True)
    review_start.add_argument("--batch-id", required=True)
    review_start.add_argument("--product-identity", required=True, help="产品身份指纹，用于把 RED/GREEN 证据绑定到同一产品状态。规范取值是当前 git HEAD；省略则自动推导并在返回体的 resolvedProductIdentity 里回显，close 时原样引用即可。")
    review_start.add_argument("--run-id", required=True)
    review_start.add_argument("--attempt", type=int, required=True)
    review_start.add_argument("--json", action="store_true")
    launch_review = sub.add_parser("launch-review")
    launch_review.add_argument("--project", required=True)
    launch_review.add_argument("--change", required=True)
    launch_review.add_argument("--change-dir", required=True)
    launch_review.add_argument("--executor", required=True)
    launch_review.add_argument("--skills-root", required=True)
    launch_review.add_argument("--product-identity", help="产品身份指纹，用于把 RED/GREEN 证据绑定到同一产品状态。规范取值是当前 git HEAD；省略则自动推导并在返回体的 resolvedProductIdentity 里回显，close 时原样引用即可。")
    launch_review.add_argument("--run-id")
    launch_review.add_argument("--attempt", type=int, default=2)
    launch_review.add_argument("--batch-id")
    launch_review.add_argument("--task", type=int)
    launch_review.add_argument("--executor-tool")
    launch_review.add_argument("--executor-agent")
    launch_review.add_argument("--executor-model")
    launch_review.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    change_dir = Path(args.change_dir)
    try:
        if args.command == "review-plan":
            value = review_fixback_plan(change_dir)
        elif args.command == "start-review":
            value = open_review_batch(
                change_dir,
                plan=review_fixback_plan(change_dir),
                batch_id=args.batch_id,
                product_identity=args.product_identity,
                run_id=args.run_id,
                attempt=args.attempt,
            )
        elif args.command == "launch-review":
            value = launch_review_fixback(
                project=Path(args.project),
                change=args.change,
                change_dir=change_dir,
                executor=args.executor,
                skills_root=Path(args.skills_root),
                # 省略时推导当前 HEAD：这个值全仓文档零命中，硬性必填只会
                # 逼调用方去 grep 源码猜（2026-08-19 那轮猜了 8 次）。
                product_identity=(
                    args.product_identity
                    or resolve_product_identity(change_dir)
                ),
                run_id=args.run_id,
                attempt=args.attempt,
                batch_id=args.batch_id,
                task=args.task,
                executor_tool=args.executor_tool,
                executor_agent=args.executor_agent,
                executor_model=args.executor_model,
            )
        elif args.command == "resume":
            value = resume_batch(
                change_dir,
                batch_id=args.batch_id,
                product_identity=args.product_identity,
                root_cause=args.root_cause,
                run_id=args.run_id,
                attempt=args.attempt,
            )
        elif args.command == "open":
            value = open_batch(
                change_dir,
                batch_id=args.batch_id,
                product_identity=args.product_identity,
                root_cause=args.root_cause,
            )
        elif args.command == "add-issue":
            value = add_issue(
                change_dir,
                batch_id=args.batch_id,
                issue_id=args.issue_id,
                summary=args.summary,
                risk_tags=args.risk_tag,
            )
        elif args.command == "resolve-issue":
            value = resolve_issue(
                change_dir,
                batch_id=args.batch_id,
                issue_id=args.issue_id,
                red_evidence=args.red_evidence,
                green_evidence=args.green_evidence,
                changed_files=args.changed_file,
            )
        elif args.command == "close":
            value = close_batch(
                change_dir,
                batch_id=args.batch_id,
                final_product_identity=args.final_product_identity,
                affected_receipt=args.affected_receipt,
                review_receipt=args.review_receipt,
            )
        elif args.command == "status":
            value = batch_status(change_dir, args.batch_id)
        elif args.command == "register-evidence":
            value = register_evidence(change_dir, args.evidence)
        elif args.command == "evidence-template":
            value = evidence_template(
                change_dir,
                kind=args.kind,
                session_id=args.session,
                out=args.out,
                evidence_id=args.evidence_id,
                product_identity=args.product_identity,
                passed_gates=args.passed_gate or None,
            )
        else:
            value = freeze_readiness(
                change_dir,
                product_identity=args.product_identity,
            )
    except (OSError, ValueError) as exc:
        return _emit({"ok": False, "code": str(exc).split(":", 1)[0], "error": str(exc)})
    return _emit(value)


if __name__ == "__main__":
    raise SystemExit(main())
