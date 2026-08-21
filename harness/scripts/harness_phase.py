#!/usr/bin/env python3
"""Phase reconciliation, trace projection, and normalized CI metrics.

The reconciler is deliberately an evidence orchestrator: it decides REUSE,
RUN, or BLOCK for the required gate DAG. It never executes user test commands.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Any


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events as he  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hpaths  # noqa: E402


SCHEMA_VERSION = 1
CI_METRICS_SCHEMA_VERSION = 1
# 唯一权威清单在 harness_paths，harness_context 引的是同一个对象。此前这里另有
# 一份拷贝，少了 merge，worktree 变更走到 merge 就在 target_required_dag 里硬 raise。
PHASE_ORDER = hpaths.WORKFLOW_PHASES
VALIDATION_PHASES = {
    "compile": "execute",
    "unitTest": "execute",
    "unitTestFull": "execute",
    "apiTest": "execute",
    "browserTest": "execute",
    "dbCompatibility": "execute",
    "package": "package",
}
FINAL_SEQUENCE_RECEIPTS_REL = (
    Path("evidence") / "final-sequence-receipts.json"
)
ENVIRONMENT_EXECUTIONS_REL = (
    Path("evidence") / "environment-executions.json"
)


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON object required: {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        temp.replace(path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def _final_sequence_contract(change_dir: Path) -> dict[str, Any] | None:
    policy_path = change_dir / "meta" / "gate-policy.json"
    if not policy_path.is_file():
        return None
    policy = _read_json(policy_path)
    declared = policy.get("finalSequence")
    if isinstance(declared, dict) and isinstance(declared.get("nodeIds"), list):
        return declared
    dag = policy.get("requiredGateDag")
    if not isinstance(dag, dict):
        return None
    sequence_nodes = [
        node
        for node in (dag.get("nodes") or [])
        if isinstance(node, dict) and node.get("kind") == "sequence"
    ]
    if not sequence_nodes:
        return None
    sequence_nodes.sort(key=lambda node: int(node.get("sequenceIndex") or 0))
    node_ids = [str(node.get("id") or "") for node in sequence_nodes]
    return {
        "schemaVersion": 1,
        "nodeIds": node_ids,
        "freezeNodeId": (
            "sequence:code-freeze"
            if "sequence:code-freeze" in node_ids
            else None
        ),
        "terminalNodeId": node_ids[-1],
    }


def _load_sequence_receipts(change_dir: Path) -> dict[str, Any]:
    path = change_dir / FINAL_SEQUENCE_RECEIPTS_REL
    if not path.is_file():
        return {
            "schemaVersion": 1,
            "changeId": change_dir.name,
            "receipts": {},
            "attempts": [],
        }
    value = _read_json(path)
    if value.get("schemaVersion") != 1:
        raise ValueError("unsupported final-sequence receipt schema")
    receipts = value.get("receipts")
    if not isinstance(receipts, dict):
        raise ValueError("final-sequence receipts must be an object")
    attempts = value.get("attempts")
    if attempts is not None and not isinstance(attempts, list):
        raise ValueError("final-sequence attempts must be an array")
    value.setdefault("attempts", [])
    return value


def _validated_sequence_subject(subject: dict[str, Any]) -> dict[str, str]:
    required = ("productCommit", "productTreeHash", "environmentHash")
    missing = [
        field
        for field in required
        if not isinstance(subject.get(field), str)
        or not str(subject[field]).strip()
    ]
    if missing:
        raise ValueError(
            "final-sequence subject missing: " + ", ".join(missing)
        )
    return {field: str(subject[field]).strip() for field in required}


def _record_sequence_attempt(
    change_dir: Path,
    journal: dict[str, Any],
    *,
    node_id: str,
    ok: bool,
    code: str,
    subject: dict[str, str],
) -> None:
    attempts = journal.setdefault("attempts", [])
    attempts.append(
        {
            "nodeId": node_id,
            "ok": ok,
            "code": code,
            "subject": subject,
            "recordedAt": he.now_iso(),
        }
    )
    _write_json(change_dir / FINAL_SEQUENCE_RECEIPTS_REL, journal)


def record_sequence_receipt(
    change_dir: Path,
    node_id: str,
    subject: dict[str, Any],
    *,
    status: str = "OK",
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Record one final-sequence transition after validating its predecessor."""
    change_dir = change_dir.resolve()
    contract = _final_sequence_contract(change_dir)
    if contract is None:
        return {
            "ok": False,
            "code": "FINAL_SEQUENCE_NOT_CONFIGURED",
            "message": "gate policy does not declare finalSequence",
        }
    node_ids = [
        str(item)
        for item in contract.get("nodeIds") or []
        if isinstance(item, str)
    ]
    if node_id not in node_ids:
        return {
            "ok": False,
            "code": "SEQUENCE_NODE_UNKNOWN",
            "message": f"node is not in finalSequence: {node_id}",
        }
    try:
        normalized_subject = _validated_sequence_subject(subject)
        journal = _load_sequence_receipts(change_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "SEQUENCE_RECEIPT_INVALID",
            "message": str(exc),
        }
    receipts = journal["receipts"]
    index = node_ids.index(node_id)
    predecessor_id = node_ids[index - 1] if index else None
    if predecessor_id is not None:
        predecessor = receipts.get(predecessor_id)
        if (
            not isinstance(predecessor, dict)
            or str(predecessor.get("status") or "").upper() != "OK"
        ):
            code = "SEQUENCE_PREDECESSOR_MISSING"
            _record_sequence_attempt(
                change_dir,
                journal,
                node_id=node_id,
                ok=False,
                code=code,
                subject=normalized_subject,
            )
            return {
                "ok": False,
                "code": code,
                "message": f"required predecessor is not complete: {predecessor_id}",
                "predecessor": predecessor_id,
            }
        if predecessor.get("subject") != normalized_subject:
            code = "SEQUENCE_SUBJECT_CHANGED"
            _record_sequence_attempt(
                change_dir,
                journal,
                node_id=node_id,
                ok=False,
                code=code,
                subject=normalized_subject,
            )
            return {
                "ok": False,
                "code": code,
                "message": "candidate subject differs from predecessor receipt",
                "expected": predecessor.get("subject"),
                "actual": normalized_subject,
            }

    freeze_node_id = str(contract.get("freezeNodeId") or "")
    freeze_receipt = receipts.get(freeze_node_id)
    if (
        freeze_node_id
        and isinstance(freeze_receipt, dict)
        and freeze_receipt.get("subject") != normalized_subject
    ):
        code = "SEQUENCE_SUBJECT_CHANGED"
        _record_sequence_attempt(
            change_dir,
            journal,
            node_id=node_id,
            ok=False,
            code=code,
            subject=normalized_subject,
        )
        return {
            "ok": False,
            "code": code,
            "message": "candidate subject changed after code-freeze",
            "expected": freeze_receipt.get("subject"),
            "actual": normalized_subject,
        }

    normalized_status = status.strip().upper()
    if normalized_status not in {"OK", "WARN", "FAIL"}:
        return {
            "ok": False,
            "code": "SEQUENCE_STATUS_INVALID",
            "message": f"unsupported final-sequence status: {status}",
        }
    normalized_evidence = evidence if isinstance(evidence, dict) else {}
    if node_id == "sequence:unit-test-full":
        full_execution_id = str(
            normalized_evidence.get("fullExecutionId") or ""
        ).strip()
        try:
            environment_journal = load_environment_execution_journal(
                change_dir
            )
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            environment_journal = {"fullExecutions": []}
            environment_error = str(exc)
        else:
            environment_error = ""
        full_execution = next(
            (
                item
                for item in environment_journal.get("fullExecutions") or []
                if isinstance(item, dict)
                and item.get("fullExecutionId") == full_execution_id
            ),
            None,
        )
        if (
            not full_execution_id
            or not isinstance(full_execution, dict)
            or full_execution.get("subject") != normalized_subject
            or full_execution.get("status") != "OK"
            or full_execution.get("assertionBearing") is not True
        ):
            code = "FULL_EXECUTION_EVIDENCE_REQUIRED"
            _record_sequence_attempt(
                change_dir,
                journal,
                node_id=node_id,
                ok=False,
                code=code,
                subject=normalized_subject,
            )
            return {
                "ok": False,
                "code": code,
                "message": (
                    "unit-test-full requires a successful assertion-bearing "
                    "Full execution bound to the frozen subject"
                ),
                "fullExecutionId": full_execution_id or None,
                "journalError": environment_error or None,
            }
    receipt = {
        "schemaVersion": 1,
        "nodeId": node_id,
        "status": normalized_status,
        "subject": normalized_subject,
        "evidence": normalized_evidence,
        "recordedAt": he.now_iso(),
    }
    existing = receipts.get(node_id)
    reused = (
        isinstance(existing, dict)
        and existing.get("status") == normalized_status
        and existing.get("subject") == normalized_subject
        and existing.get("evidence") == receipt["evidence"]
    )
    if not reused:
        receipts[node_id] = receipt
    _record_sequence_attempt(
        change_dir,
        journal,
        node_id=node_id,
        ok=normalized_status == "OK",
        code=(
            "SEQUENCE_RECEIPT_REUSED"
            if reused
            else (
                "SEQUENCE_STEP_RECORDED"
                if normalized_status == "OK"
                else "SEQUENCE_STEP_FAILED"
            )
        ),
        subject=normalized_subject,
    )
    ok = normalized_status == "OK"
    return {
        "ok": ok,
        "code": (
            "SEQUENCE_RECEIPT_REUSED"
            if reused
            else ("SEQUENCE_STEP_RECORDED" if ok else "SEQUENCE_STEP_FAILED")
        ),
        "nodeId": node_id,
        "receipt": receipts.get(node_id),
        "reused": reused,
    }


def evaluate_final_sequence(
    change_dir: Path,
    subject: dict[str, Any],
    *,
    exclude_nodes: set[str] | None = None,
) -> dict[str, Any]:
    """Evaluate all required sequence receipts against one candidate subject."""
    change_dir = change_dir.resolve()
    try:
        contract = _final_sequence_contract(change_dir)
        if contract is None:
            return {
                "ok": True,
                "code": "FINAL_SEQUENCE_NOT_CONFIGURED",
                "skipped": True,
                "missing": [],
                "invalid": [],
            }
        normalized_subject = _validated_sequence_subject(subject)
        journal = _load_sequence_receipts(change_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "FINAL_SEQUENCE_INVALID",
            "message": str(exc),
        }
    excluded = exclude_nodes or set()
    required = [
        str(item)
        for item in contract.get("nodeIds") or []
        if isinstance(item, str) and item not in excluded
    ]
    receipts = journal["receipts"]
    missing = [node_id for node_id in required if node_id not in receipts]
    invalid = []
    for node_id in required:
        receipt = receipts.get(node_id)
        if not isinstance(receipt, dict):
            continue
        if (
            str(receipt.get("status") or "").upper() != "OK"
            or receipt.get("subject") != normalized_subject
        ):
            invalid.append(
                {
                    "nodeId": node_id,
                    "status": receipt.get("status"),
                    "subject": receipt.get("subject"),
                }
            )
    ok = not missing and not invalid
    return {
        "ok": ok,
        "code": (
            "FINAL_SEQUENCE_COMPLETE"
            if ok
            else "FINAL_SEQUENCE_INCOMPLETE"
        ),
        "message": (
            "all required final-sequence receipts match the candidate"
            if ok
            else f"missing={len(missing)} invalid={len(invalid)}"
        ),
        "subject": normalized_subject,
        "required": required,
        "missing": missing,
        "invalid": invalid,
        "receiptsPath": str(change_dir / FINAL_SEQUENCE_RECEIPTS_REL),
    }


def load_environment_execution_journal(
    change_dir: Path,
) -> dict[str, Any]:
    path = change_dir.resolve() / ENVIRONMENT_EXECUTIONS_REL
    if not path.is_file():
        return {
            "schemaVersion": 1,
            "changeId": change_dir.name,
            "environmentAttempts": [],
            "fullExecutions": [],
        }
    journal = _read_json(path)
    if journal.get("schemaVersion") != 1:
        raise ValueError("unsupported environment execution journal schema")
    for field in ("environmentAttempts", "fullExecutions"):
        if not isinstance(journal.get(field), list):
            raise ValueError(f"environment journal {field} must be an array")
    return journal


def record_environment_attempt(
    change_dir: Path,
    subject: dict[str, Any],
    *,
    stage: str,
    status: str,
    duration_ms: int,
    failure_signature: str | None = None,
) -> dict[str, Any]:
    """Record environment lifecycle work without manufacturing Full results."""
    change_dir = change_dir.resolve()
    if stage not in {"prepare", "verify", "release"}:
        return {
            "ok": False,
            "code": "ENVIRONMENT_STAGE_INVALID",
            "message": f"unsupported environment stage: {stage}",
        }
    normalized_status = status.strip().upper()
    if normalized_status not in {
        "OK",
        "ENVIRONMENT_ERROR",
        "INTERRUPTED",
        "FAIL",
    }:
        return {
            "ok": False,
            "code": "ENVIRONMENT_STATUS_INVALID",
            "message": f"unsupported environment status: {status}",
        }
    if not isinstance(duration_ms, int) or duration_ms < 0:
        return {
            "ok": False,
            "code": "ENVIRONMENT_DURATION_INVALID",
            "message": "duration_ms must be a non-negative integer",
        }
    try:
        normalized_subject = _validated_sequence_subject(subject)
        journal = load_environment_execution_journal(change_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "ENVIRONMENT_JOURNAL_INVALID",
            "message": str(exc),
        }
    attempt = {
        "attemptId": "env-" + uuid.uuid4().hex,
        "stage": stage,
        "status": normalized_status,
        "subject": normalized_subject,
        "durationMs": duration_ms,
        "failureSignature": failure_signature,
        "recordedAt": he.now_iso(),
    }
    journal["environmentAttempts"].append(attempt)
    _write_json(change_dir / ENVIRONMENT_EXECUTIONS_REL, journal)
    ok = normalized_status == "OK"
    return {
        "ok": ok,
        "code": (
            "ENVIRONMENT_STAGE_RECORDED"
            if ok
            else "ENVIRONMENT_ERROR_RECORDED"
        ),
        "attempt": attempt,
        "fullExecutionCreated": False,
    }


def record_full_test_execution(
    change_dir: Path,
    subject: dict[str, Any],
    *,
    status: str,
    prepare_ms: int,
    test_ms: int,
    cleanup_ms: int,
    result_digest: str,
    supersedes: str | None = None,
) -> dict[str, Any]:
    """Record one assertion-bearing Full execution after environment success."""
    change_dir = change_dir.resolve()
    normalized_status = status.strip().upper()
    if normalized_status not in {"OK", "FAIL"}:
        return {
            "ok": False,
            "code": "FULL_STATUS_INVALID",
            "message": "Full status must be OK or FAIL",
        }
    durations = (prepare_ms, test_ms, cleanup_ms)
    if any(not isinstance(value, int) or value < 0 for value in durations):
        return {
            "ok": False,
            "code": "FULL_DURATION_INVALID",
            "message": "prepare/test/cleanup durations must be non-negative",
        }
    if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", result_digest):
        return {
            "ok": False,
            "code": "FULL_RESULT_DIGEST_INVALID",
            "message": "result_digest must be a sha256 digest",
        }
    try:
        normalized_subject = _validated_sequence_subject(subject)
        journal = load_environment_execution_journal(change_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "ENVIRONMENT_JOURNAL_INVALID",
            "message": str(exc),
        }
    successful_environment = {
        str(item.get("stage") or ""): item
        for item in journal["environmentAttempts"]
        if isinstance(item, dict)
        and item.get("subject") == normalized_subject
        and str(item.get("status") or "").upper() == "OK"
    }
    missing = [
        stage
        for stage in ("prepare", "verify")
        if stage not in successful_environment
    ]
    if missing:
        return {
            "ok": False,
            "code": "ENVIRONMENT_NOT_READY",
            "message": (
                "Full execution requires successful environment stages: "
                + ", ".join(missing)
            ),
            "missing": missing,
        }
    prior_success = next(
        (
            item
            for item in reversed(journal["fullExecutions"])
            if isinstance(item, dict)
            and item.get("subject") == normalized_subject
            and item.get("status") == "OK"
        ),
        None,
    )
    if prior_success is not None:
        if prior_success.get("resultDigest") == result_digest:
            sequence_receipt = record_sequence_receipt(
                change_dir,
                "sequence:unit-test-full",
                normalized_subject,
                evidence={
                    "fullExecutionId": prior_success.get("fullExecutionId"),
                    "resultDigest": result_digest,
                    "assertionBearing": True,
                },
            )
            return {
                "ok": True,
                "code": "FULL_EXECUTION_REUSED",
                "execution": prior_success,
                "reused": True,
                "sequenceReceipt": sequence_receipt,
            }
        return {
            "ok": False,
            "code": "FULL_ALREADY_COMPLETED",
            "message": (
                "a successful assertion-bearing Full already exists for this identity"
            ),
            "existingExecutionId": prior_success.get("fullExecutionId"),
        }
    prior_failed_ids = {
        str(item.get("fullExecutionId") or "")
        for item in journal["fullExecutions"]
        if isinstance(item, dict)
        and item.get("subject") == normalized_subject
        and item.get("status") == "FAIL"
    }
    if prior_failed_ids and supersedes not in prior_failed_ids:
        return {
            "ok": False,
            "code": "FULL_SUPERSESSION_REQUIRED",
            "message": "Full rerun after assertion failure must name supersedes",
            "priorFailedExecutionIds": sorted(prior_failed_ids),
        }
    execution = {
        "fullExecutionId": "full-" + uuid.uuid4().hex,
        "status": normalized_status,
        "subject": normalized_subject,
        "environmentAttemptIds": [
            successful_environment[stage]["attemptId"]
            for stage in ("prepare", "verify")
        ],
        "prepareMs": prepare_ms,
        "testExecutionMs": test_ms,
        "cleanupMs": cleanup_ms,
        "totalMs": prepare_ms + test_ms + cleanup_ms,
        "resultDigest": result_digest,
        "supersedes": supersedes,
        "assertionBearing": True,
        "recordedAt": he.now_iso(),
    }
    journal["fullExecutions"].append(execution)
    _write_json(change_dir / ENVIRONMENT_EXECUTIONS_REL, journal)
    sequence_receipt = None
    if normalized_status == "OK":
        sequence_receipt = record_sequence_receipt(
            change_dir,
            "sequence:unit-test-full",
            normalized_subject,
            evidence={
                "fullExecutionId": execution["fullExecutionId"],
                "resultDigest": result_digest,
                "assertionBearing": True,
            },
        )
    return {
        "ok": normalized_status == "OK",
        "code": (
            "FULL_EXECUTION_RECORDED"
            if normalized_status == "OK"
            else "FULL_ASSERTIONS_FAILED"
        ),
        "execution": execution,
        "reused": False,
        "sequenceReceipt": sequence_receipt,
    }


def _stable_hex(*parts: Any, length: int) -> str:
    raw = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:length]


def target_required_dag(policy: dict[str, Any], target_phase: str) -> dict[str, Any]:
    """Return only the required predecessors needed to close ``target_phase``.

    Validations owned by the target phase are prerequisites to closing it;
    stage nodes for the target itself are deliberately excluded because their
    ``phase.end`` is the result of close, not evidence required before close.
    """
    # 未知阶段名先过读时映射：阶段改名后，历史 change 的 gate-policy.json 与
    # plannedPhases 里仍然是旧名，靠 LEGACY_PHASE_ALIASES 继续可读，不必迁移已落盘
    # 的 change（本仓库没有 change 级 schema 迁移机制，硬 raise 等于让在途变更报废）。
    resolved_target = hpaths.resolve_phase_name(target_phase)
    if resolved_target is None:
        raise ValueError(
            f"unsupported reconcile target phase: {target_phase}; "
            f"已知阶段 {', '.join(PHASE_ORDER)}。"
            "若这是改名前的旧阶段，在 harness_paths.LEGACY_PHASE_ALIASES 登记映射；"
            "若这份 gate-policy.json 本身过期，重跑 harness_gate.py classify 重建"
        )
    target_phase = resolved_target
    dag = policy.get("requiredGateDag")
    if not isinstance(dag, dict) or not isinstance(dag.get("nodes"), list):
        raise ValueError("gate policy missing requiredGateDag; run harness_gate.py classify")
    target_rank = PHASE_ORDER.index(target_phase)
    selected: list[dict[str, Any]] = []
    for raw in dag["nodes"]:
        if not isinstance(raw, dict):
            raise ValueError("requiredGateDag node must be an object")
        node = dict(raw)
        node_id = str(node.get("id") or "")
        node_kind, _, node_name = node_id.partition(":")
        inferred_phase = (
            VALIDATION_PHASES.get(node_name)
            if node_kind == "validation"
            else node_name
        )
        raw_phase = str(node.get("phase") or inferred_phase or "")
        node_phase = hpaths.resolve_phase_name(raw_phase)
        if node_phase is None:
            raise ValueError(
                f"requiredGateDag node has unsupported phase: {node_id} (phase={raw_phase!r})；"
                "旧阶段名在 harness_paths.LEGACY_PHASE_ALIASES 登记映射，"
                "或重跑 harness_gate.py classify 重建这份 gate-policy.json"
            )
        node["phase"] = node_phase
        node_rank = PHASE_ORDER.index(node_phase)
        is_validation = node.get("kind") == "validation" or node_id.startswith(
            "validation:"
        )
        if node_rank < target_rank or (is_validation and node_rank == target_rank):
            selected.append(node)
    selected_ids = {str(node.get("id")) for node in selected}
    for node in selected:
        excluded_dependencies = [
            dependency
            for dependency in (node.get("dependsOn") or [])
            if dependency not in selected_ids
        ]
        if excluded_dependencies:
            raise ValueError(
                f"target DAG for {target_phase} excludes dependencies of "
                f"{node.get('id')}: {', '.join(excluded_dependencies)}"
            )
    return {
        "schemaVersion": dag.get("schemaVersion", 1),
        "nodes": selected,
        "edges": [
            edge
            for edge in (dag.get("edges") or [])
            if isinstance(edge, dict)
            and edge.get("from") in selected_ids
            and edge.get("to") in selected_ids
        ],
        "targetPhase": target_phase,
    }


def select_phase_capsule(
    change_dir: Path,
    project_root: Path,
    *,
    phase: str,
    run_id: str | None,
) -> dict[str, Any]:
    """Select a phase capsule by its exact phase/run identity, never by mtime."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", phase):
        return {
            "ok": False,
            "code": "PHASE_INVALID",
            "message": f"invalid phase selector: {phase}",
            "remediation": "pass the phase name emitted by harness_gate.py begin",
        }
    # 在途 change 的 capsule 可能按旧名（run/test）写入：归一后按 canonical
    # 优先、旧名兜底查找。新写一律 canonical。
    phase = hpaths.resolve_phase_name(phase) or phase
    phase_names = [phase] + [
        legacy for legacy, canonical in hpaths.LEGACY_PHASE_ALIASES.items()
        if canonical == phase
    ]
    state_dir = hpaths.resolve_state_dir_for_contract(change_dir, project_root)
    capsule_dir = state_dir / "runtime" / "phase-context"
    candidates = (
        [
            path
            for path in capsule_dir.iterdir()
            if path.is_file()
            and any(path.name.startswith(f"{name}-") for name in phase_names)
            and path.suffix == ".json"
        ]
        if capsule_dir.is_dir()
        else []
    )
    if not run_id:
        if not candidates:
            return {
                "ok": True,
                "code": "PHASE_CAPSULE_ABSENT",
                "capsule": None,
                "path": None,
            }
        return {
            "ok": False,
            "code": "PHASE_RUN_ID_REQUIRED",
            "message": f"{len(candidates)} capsule(s) exist for phase {phase}",
            "remediation": f"rerun reconcile with --phase {phase} --run-id <run-id>",
        }
    path: Path | None = None
    for name in phase_names:
        key = hashlib.sha256(f"{name}\0{run_id}".encode("utf-8")).hexdigest()[:20]
        candidate = capsule_dir / f"{name}-{key}.json"
        if candidate.is_file():
            path = candidate
            break
    if path is None:
        key = hashlib.sha256(f"{phase}\0{run_id}".encode("utf-8")).hexdigest()[:20]
        return {
            "ok": False,
            "code": "PHASE_CAPSULE_NOT_FOUND",
            "message": f"no capsule for phase {phase} and run-id {run_id}",
            "expectedPath": str(capsule_dir / f"{phase}-{key}.json"),
            "remediation": f"begin/resume the phase or verify --phase {phase} --run-id {run_id}",
        }
    try:
        capsule = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "PHASE_CAPSULE_INVALID",
            "message": str(exc),
            "path": str(path),
            "remediation": f"repair or resume the capsule for --phase {phase} --run-id {run_id}",
        }
    if (
        hpaths.resolve_phase_name(capsule.get("phase")) != phase
        or capsule.get("runId") != run_id
    ):
        return {
            "ok": False,
            "code": "PHASE_CAPSULE_IDENTITY_MISMATCH",
            "message": "capsule content does not match the requested phase/run-id",
            "path": str(path),
            "remediation": f"resume the exact phase with --phase {phase} --run-id {run_id}",
        }
    return {
        "ok": True,
        "code": "PHASE_CAPSULE_SELECTED",
        "capsule": capsule,
        "path": str(path),
    }


def reconcile_dag(
    dag: dict[str, Any],
    evidence: dict[str, dict[str, Any]],
    *,
    identity: dict[str, Any],
) -> dict[str, Any]:
    """Reduce a required DAG to deterministic REUSE/RUN/BLOCK decisions."""
    raw_nodes = dag.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ValueError("requiredGateDag.nodes must be an array")
    if not raw_nodes:
        raise ValueError("requiredGateDag.nodes must not be empty")
    nodes_by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_nodes:
        if not isinstance(raw, dict) or not str(raw.get("id") or "").strip():
            raise ValueError("requiredGateDag node requires a non-empty id")
        node_id = str(raw["id"])
        if node_id in nodes_by_id:
            raise ValueError(f"duplicate DAG node: {node_id}")
        depends = raw.get("dependsOn") or []
        if not isinstance(depends, list) or any(not isinstance(item, str) for item in depends):
            raise ValueError(f"invalid dependsOn for {node_id}")
        nodes_by_id[node_id] = dict(raw)
    for node_id, node in nodes_by_id.items():
        missing = [dep for dep in node.get("dependsOn") or [] if dep not in nodes_by_id]
        if missing:
            raise ValueError(f"unknown dependency for {node_id}: {', '.join(missing)}")

    if not identity.get("ok"):
        blocker = {
            "code": str(identity.get("code") or "IDENTITY_MISMATCH"),
            "message": str(identity.get("message") or "identity validation failed"),
        }
        return {
            "nodes": [
                {
                    **node,
                    "decision": "BLOCK",
                    "reason": blocker["code"],
                    "evidence": evidence.get(node_id) or {},
                }
                for node_id, node in nodes_by_id.items()
            ],
            "blockers": [blocker],
            "canClose": False,
        }

    pending = set(nodes_by_id)
    decided: dict[str, dict[str, Any]] = {}
    while pending:
        progressed = False
        for node_id in list(pending):
            node = nodes_by_id[node_id]
            dependencies = list(node.get("dependsOn") or [])
            if any(dep not in decided for dep in dependencies):
                continue
            facts = evidence.get(node_id) or {}
            upstream = [decided[dep] for dep in dependencies]
            if any(item["decision"] == "BLOCK" for item in upstream):
                decision, reason = "BLOCK", "upstream-blocked"
            elif any(item["decision"] != "REUSE" for item in upstream):
                decision, reason = "RUN", "upstream-invalidated"
            elif bool(facts.get("reusable")):
                decision, reason = "REUSE", str(facts.get("reason") or "evidence-current")
            elif str(facts.get("decision") or "").upper() == "BLOCK":
                decision, reason = "BLOCK", str(facts.get("reason") or "evidence-blocked")
            else:
                decision, reason = "RUN", str(facts.get("reason") or "evidence-missing")
            decided[node_id] = {
                **node,
                "decision": decision,
                "reason": reason,
                "evidence": facts,
            }
            pending.remove(node_id)
            progressed = True
        if not progressed:
            raise ValueError("requiredGateDag contains a cycle")

    ordered = [decided[str(raw["id"])] for raw in raw_nodes]
    blockers = [
        {"code": "NODE_BLOCKED", "nodeId": node["id"], "message": node["reason"]}
        for node in ordered
        if node["decision"] == "BLOCK"
    ]
    return {
        "nodes": ordered,
        "blockers": blockers,
        "canClose": bool(ordered) and all(node["decision"] == "REUSE" for node in ordered),
    }


def _event_groups(events: list[dict[str, Any]]) -> list[tuple[str, int, list[dict[str, Any]]]]:
    order: list[tuple[str, int]] = []
    groups: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        key = (str(event.get("phase") or "unknown"), int(event.get("attempt") or 1))
        if key not in groups:
            order.append(key)
        groups[key].append(event)
    return [(phase, attempt, groups[(phase, attempt)]) for phase, attempt in order]


def timing_dimensions(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep runner, orchestration-active, wall-clock, and user wait distinct."""
    output: list[dict[str, Any]] = []
    for phase, attempt, grouped in _event_groups(events):
        timing = he.canonical_phase_timing(grouped)
        runner_values = [
            event.get("duration_ms", event.get("durationMs"))
            for event in grouped
            if event.get("type") == "command"
            and isinstance(event.get("duration_ms", event.get("durationMs")), int)
        ]
        wait_values = [
            event.get("user_wait_ms", event.get("userWaitMs"))
            for event in grouped
            if isinstance(event.get("user_wait_ms", event.get("userWaitMs")), int)
        ]
        output.append(
            {
                "phase": phase,
                "attempt": attempt,
                "runnerMs": sum(runner_values) if runner_values else None,
                "orchestrationActiveMs": timing.get("activeExecutionMs"),
                "wallClockMs": timing.get("wallClockSpanMs"),
                "userWaitMs": sum(wait_values) if wait_values else None,
                "lateEventCount": timing.get("lateEventCount"),
            }
        )
    return output


def build_trace(events: list[dict[str, Any]], *, change_id: str) -> dict[str, Any]:
    """Project legacy or trace-aware events into stable phase/attempt/tool spans."""
    event_ids = [str(event.get("id") or index) for index, event in enumerate(events)]
    explicit_trace = next(
        (
            str(event.get("traceId") or event.get("trace_id"))
            for event in events
            if event.get("traceId") or event.get("trace_id")
        ),
        "",
    )
    trace_id = explicit_trace if len(explicit_trace) == 32 else _stable_hex(change_id, *event_ids, length=32)
    root_span = _stable_hex(trace_id, "root", length=16)
    spans: list[dict[str, Any]] = [
        {
            "traceId": trace_id,
            "spanId": root_span,
            "parentSpanId": None,
            "kind": "change",
            "changeId": change_id,
        }
    ]
    for phase, attempt, grouped in _event_groups(events):
        phase_span = _stable_hex(trace_id, phase, attempt, length=16)
        spans.append(
            {
                "traceId": trace_id,
                "spanId": phase_span,
                "parentSpanId": root_span,
                "kind": "phase-attempt",
                "phase": phase,
                "attempt": attempt,
            }
        )
        tools: list[str] = []
        for event in grouped:
            tool = str(event.get("executor_tool") or event.get("executorTool") or "").strip()
            if tool and tool not in tools:
                tools.append(tool)
        for tool in tools:
            spans.append(
                {
                    "traceId": trace_id,
                    "spanId": _stable_hex(trace_id, phase, attempt, tool, length=16),
                    "parentSpanId": phase_span,
                    "kind": "tool",
                    "phase": phase,
                    "attempt": attempt,
                    "tool": tool,
                }
            )
    return {"schemaVersion": 1, "traceId": trace_id, "spans": spans}


def _number(value: Any, *, integer: bool = True) -> int | float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if integer else number


def _junit_metrics(text: str) -> dict[str, Any]:
    root = ET.fromstring(text)
    suites = [root] if root.tag.endswith("testsuite") else list(root.findall(".//testsuite"))
    aggregate = root if root.tag.endswith(("testsuite", "testsuites")) else None
    attrs = aggregate.attrib if aggregate is not None else {}
    def attribute_total(name: str, fallback: str | None = None) -> int | None:
        direct = _number(attrs.get(name, attrs.get(fallback) if fallback else None))
        if direct is not None:
            return int(direct)
        values = [
            _number(item.attrib.get(name, item.attrib.get(fallback) if fallback else None))
            for item in suites
        ]
        return (
            sum(int(value) for value in values if value is not None)
            if any(value is not None for value in values)
            else None
        )

    total = attribute_total("tests")
    failures = attribute_total("failures")
    errors = attribute_total("errors")
    skipped = attribute_total("skipped", "disabled")
    duration_seconds = _number(attrs.get("time"), integer=False)
    if duration_seconds is None:
        durations = [_number(item.attrib.get("time"), integer=False) for item in suites]
        duration_seconds = (
            sum(value for value in durations if value is not None)
            if any(value is not None for value in durations)
            else None
        )
    passed = None
    if all(value is not None for value in (total, failures, errors, skipped)):
        passed = max(int(total) - int(failures) - int(errors) - int(skipped), 0)
    return {
        "suites": len(suites) if suites else None,
        "passed": passed,
        "failed": failures,
        "skipped": skipped,
        "setupErrors": errors,
        "durationMs": int(duration_seconds * 1000) if duration_seconds is not None else None,
    }


def normalize_ci_metrics(
    raw: str | dict[str, Any],
    *,
    runner: str,
    head_sha: str | None,
    source: str | None = None,
) -> dict[str, Any]:
    """Normalize JUnit, Vitest, or Playwright machine output without inventing zeros."""
    normalized_runner = runner.lower()
    if normalized_runner == "junit":
        if not isinstance(raw, str):
            raise ValueError("JUnit input must be XML text")
        metrics = _junit_metrics(raw)
    else:
        if isinstance(raw, str):
            value = json.loads(raw)
        else:
            value = raw
        if not isinstance(value, dict):
            raise ValueError("runner metrics must be a JSON object")
        if normalized_runner == "vitest":
            runtimes = [
                _number((item.get("perfStats") or {}).get("runtime"))
                for item in (value.get("testResults") or [])
                if isinstance(item, dict)
            ]
            metrics = {
                "suites": _number(value.get("numTotalTestSuites")),
                "passed": _number(value.get("numPassedTests")),
                "failed": _number(value.get("numFailedTests")),
                "skipped": _number(value.get("numPendingTests")),
                "setupErrors": _number(value.get("numRuntimeErrorTestSuites")),
                "durationMs": sum(item for item in runtimes if item is not None)
                if any(item is not None for item in runtimes)
                else None,
            }
        elif normalized_runner == "playwright":
            stats = value.get("stats") if isinstance(value.get("stats"), dict) else {}
            suites = value.get("suites")
            error_counts = []
            for raw_errors in (value.get("errors"), stats.get("errors")):
                count = len(raw_errors) if isinstance(raw_errors, list) else _number(raw_errors)
                if count is not None:
                    error_counts.append(count)
            setup_errors = max(error_counts) if error_counts else None
            metrics = {
                "suites": len(suites) if isinstance(suites, list) else None,
                "passed": _number(stats.get("expected")),
                "failed": _number(stats.get("unexpected")),
                "skipped": _number(stats.get("skipped")),
                "setupErrors": _number(setup_errors),
                "durationMs": _number(stats.get("duration")),
            }
        else:
            raise ValueError(f"unsupported runner: {runner}")
    result = {
        "schemaVersion": CI_METRICS_SCHEMA_VERSION,
        "runner": normalized_runner,
        "source": source,
        **metrics,
        "headSha": head_sha,
    }
    for field in ("suites", "passed", "failed", "skipped", "setupErrors", "durationMs"):
        value = result.get(field)
        if value is not None and (not isinstance(value, int) or value < 0):
            raise ValueError(f"invalid CI metric {field}: expected nonnegative integer or null")
    if head_sha is not None and not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", head_sha):
        raise ValueError("headSha must be a lowercase 40- or 64-character hex commit id")
    return result


def _git_head(project_root: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else None


def assess_identity(
    change_dir: Path,
    project_root: Path,
    ledger: dict[str, Any] | None,
    *,
    target_phase: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    current_head = _git_head(project_root)
    capsule: dict[str, Any] | None = None
    capsule_selection: dict[str, Any] | None = None
    if target_phase is not None:
        capsule_selection = select_phase_capsule(
            change_dir,
            project_root,
            phase=target_phase,
            run_id=run_id,
        )
        if not capsule_selection.get("ok"):
            return {
                "ok": False,
                "code": capsule_selection.get("code"),
                "message": capsule_selection.get("message"),
                "remediation": capsule_selection.get("remediation"),
                "capsuleSelection": {
                    key: value
                    for key, value in capsule_selection.items()
                    if key != "capsule"
                },
            }
        selected = capsule_selection.get("capsule")
        capsule = selected if isinstance(selected, dict) else None
    if capsule is not None:
        stored_head = capsule.get("currentHead")
        if stored_head and current_head and stored_head != current_head:
            return {
                "ok": False,
                "code": "HEAD_MISMATCH",
                "message": f"phase capsule head {stored_head} != current {current_head}",
                "storedHead": stored_head,
                "currentHead": current_head,
                "capsuleSelection": capsule_selection,
            }
    if not ledger or ledger.get("schemaVersion") != 3:
        return {
            "ok": True,
            "code": "IDENTITY_NOT_REUSABLE",
            "message": "no ledger v3 identity; validations must RUN unless their own evidence is current",
            "currentHead": current_head,
            "capsuleSelection": capsule_selection,
        }
    missing = hl.validate_ledger_identity(ledger)
    if missing:
        return {
            "ok": False,
            "code": "LEDGER_IDENTITY_INVALID",
            "message": "missing: " + ", ".join(missing),
        }
    if capsule is not None and capsule.get("baseCommit") not in {
        None,
        ledger.get("baseCommit"),
    }:
        return {
            "ok": False,
            "code": "BASE_MISMATCH",
            "message": "phase capsule and ledger base commits differ",
            "capsuleBase": capsule.get("baseCommit"),
            "ledgerBase": ledger.get("baseCommit"),
        }
    try:
        contract = hpaths.load_change_contract(change_dir)
        current_repository = hpaths.repository_identity(project_root)
        current_ownership = hl.ownership_hash(contract)
        current_diff = hl.compute_ownership_diff(
            project_root,
            base=str(ledger["baseCommit"]),
            change_dir=change_dir,
        )["diffHash"]
    except (OSError, ValueError, RuntimeError) as exc:
        return {"ok": False, "code": "IDENTITY_RESOLUTION_FAILED", "message": str(exc)}
    identity_dimensions = {
        "repositoryId": (ledger.get("repositoryId"), current_repository),
        "ownershipHash": (ledger.get("ownershipHash"), current_ownership),
        "currentHead": (ledger.get("currentHead"), current_head),
    }
    changed = {
        key: {"stored": stored, "current": current}
        for key, (stored, current) in identity_dimensions.items()
        if stored != current
    }
    if changed:
        return {
            "ok": False,
            "code": "LEDGER_IDENTITY_MISMATCH",
            "message": "ledger identity does not match current change",
            "mismatches": changed,
        }
    if ledger.get("diffHash") != current_diff:
        return {
            "ok": True,
            "code": "DIFF_CHANGED",
            "message": "ownership diff changed; reuse is decided per node inputs",
            "storedDiffHash": ledger.get("diffHash"),
            "currentDiffHash": current_diff,
            "currentHead": current_head,
        }
    return {
        "ok": True,
        "code": "IDENTITY_OK",
        "currentHead": current_head,
        "capsuleSelection": capsule_selection,
    }


def _latest_phase_status(events: list[dict[str, Any]], phase: str) -> str | None:
    status = None
    for event in he.apply_event_corrections(events):
        if event.get("type") == "phase.end" and event.get("phase") == phase:
            status = str(event.get("status") or "").upper() or None
    return status


def collect_node_evidence(
    dag: dict[str, Any],
    change_dir: Path,
    events: list[dict[str, Any]],
    ledger: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    validations = (ledger or {}).get("validations") or {}
    sequence_receipts = _load_sequence_receipts(change_dir).get("receipts") or {}
    for node in dag.get("nodes") or []:
        node_id = str(node.get("id") or "")
        if node.get("kind") == "sequence" or node_id.startswith("sequence:"):
            receipt = (
                sequence_receipts.get(node_id)
                if isinstance(sequence_receipts, dict)
                else None
            )
            status = (
                str(receipt.get("status") or "").upper()
                if isinstance(receipt, dict)
                else ""
            )
            result[node_id] = {
                "reusable": status == "OK",
                "reason": f"sequence-status:{status or 'missing'}",
                "receipt": receipt,
            }
        elif node.get("kind") == "validation" or node_id.startswith("validation:"):
            verification = node_id.split(":", 1)[1]
            entry = validations.get(verification) if isinstance(validations, dict) else None
            if not isinstance(entry, dict):
                result[node_id] = {"reusable": False, "reason": "validation-missing"}
                continue
            files = entry.get("inputsFiles") if isinstance(entry.get("inputsFiles"), list) else []
            if not files:
                result[node_id] = {"reusable": False, "reason": "inputs-missing"}
                continue
            reuse = hl.decide_can_reuse(
                change_dir=change_dir,
                verification=verification,
                files=[str(item) for item in files],
                requested_scope=entry.get("scope") if isinstance(entry.get("scope"), str) else None,
                requested_command=str(entry.get("command") or "") or None,
            )
            result[node_id] = {
                "reusable": bool(reuse.get("reuse")),
                "reason": str(reuse.get("code") or reuse.get("reason") or "not-reusable"),
                "reuse": reuse,
            }
        else:
            phase = str(node.get("phase") or node_id.split(":", 1)[-1])
            status = _latest_phase_status(events, phase)
            result[node_id] = {
                "reusable": status in {"OK", "WARN"},
                "reason": f"phase-status:{status or 'missing'}",
                "status": status,
            }
    return result


def reconcile(
    change_dir: Path,
    project_root: Path,
    *,
    target_phase: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    change_dir = change_dir.resolve()
    project_root = project_root.resolve()
    policy = _read_json(change_dir / "meta" / "gate-policy.json")
    dag = (
        target_required_dag(policy, target_phase)
        if target_phase is not None
        else policy.get("requiredGateDag")
    )
    if not isinstance(dag, dict):
        raise ValueError("gate policy missing requiredGateDag; run harness_gate.py classify")
    ledger, ledger_path = hl.load_ledger(change_dir)
    events_file = he.events_path(change_dir)
    events = he.load_events(events_file) if events_file.is_file() else []
    identity = assess_identity(
        change_dir,
        project_root,
        ledger,
        target_phase=target_phase,
        run_id=run_id,
    )
    evidence = collect_node_evidence(dag, change_dir, events, ledger)
    if identity.get("code") not in {"IDENTITY_OK", "DIFF_CHANGED"}:
        for facts in evidence.values():
            facts["reusable"] = False
            facts["reason"] = "identity-not-reusable"
    if dag.get("nodes"):
        decision = reconcile_dag(dag, evidence, identity=identity)
    elif identity.get("ok"):
        decision = {"nodes": [], "blockers": [], "canClose": True}
    else:
        decision = {
            "nodes": [],
            "blockers": [
                {
                    "code": str(identity.get("code") or "IDENTITY_MISMATCH"),
                    "message": str(identity.get("message") or "identity validation failed"),
                }
            ],
            "canClose": False,
        }
    guard_path = change_dir / "evidence" / "test-guard-snapshot.json"
    guard = _read_json(guard_path) if guard_path.is_file() else None
    return {
        "ok": not decision["blockers"],
        "action": "reconcile",
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "changeId": change_dir.name,
        "projectRoot": str(project_root),
        "changeDir": str(change_dir),
        "targetPhase": target_phase,
        "runId": run_id,
        "identity": identity,
        **decision,
        "guard": guard,
        "ledgerPath": str(ledger_path) if ledger_path else None,
        "trace": build_trace(events, change_id=change_dir.name),
        "timing": timing_dimensions(events),
    }


def format_compact(result: dict[str, Any]) -> str:
    lines: list[str] = []
    for node in result.get("nodes") or []:
        decision = str(node.get("decision") or "")
        if decision == "REUSE":
            continue
        lines.append(f"{decision} {node.get('id')}: {node.get('reason')}")
    for blocker in result.get("blockers") or []:
        lines.append(f"BLOCK {blocker.get('code')}: {blocker.get('message')}")
    if not lines:
        nodes = result.get("nodes") or []
        if not result.get("ok") or not nodes:
            lines.append(
                f"BLOCK {result.get('code') or 'EMPTY_RECONCILIATION'}: "
                f"{result.get('error') or 'no required nodes were reconciled'}"
            )
        else:
            lines.append(f"REUSED {len(nodes)} required nodes; safe to close")
    return "\n".join(lines)


def _close_gate(args: argparse.Namespace) -> dict[str, Any]:
    command = [
        sys.executable,
        str(SCRIPTS_DIR / "harness_gate.py"),
        "close",
        "--json",
        "--phase",
        args.phase,
        "--change",
        Path(args.change_dir).name,
        "--project",
        str(Path(args.project).resolve()),
        "--status",
        "OK",
    ]
    if args.run_id:
        command.extend(["--run-id", args.run_id])
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        payload = {"ok": False, "code": "GATE_CLOSE_INVALID_OUTPUT", "stderr": proc.stderr}
    payload["exitCode"] = proc.returncode
    return payload


def _cmd_reconcile(args: argparse.Namespace) -> int:
    try:
        result = reconcile(
            Path(args.change_dir),
            Path(args.project),
            target_phase=args.phase,
            run_id=args.run_id,
        )
        if args.close:
            if not result.get("canClose"):
                result["close"] = {
                    "ok": False,
                    "code": "RECONCILE_NOT_CLOSABLE",
                    "message": "required nodes still need RUN or are BLOCKED",
                }
                result["ok"] = False
                result.setdefault("blockers", []).append(
                    {
                        "code": "RECONCILE_NOT_CLOSABLE",
                        "message": "explicit close refused because required nodes are not reusable",
                    }
                )
            else:
                result["close"] = _close_gate(args)
                if not result["close"].get("ok"):
                    result["ok"] = False
        if args.output:
            _write_json(Path(args.output).resolve(), result)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"ok": False, "action": "reconcile", "code": "RECONCILE_FAILED", "error": str(exc)}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_compact(result))
    return 0 if result.get("ok") else 2


def _cmd_metrics(args: argparse.Namespace) -> int:
    input_path = Path(args.input).resolve()
    try:
        text = input_path.read_text(encoding="utf-8-sig")
        runner = args.runner
        if runner == "auto":
            if input_path.suffix.lower() == ".xml":
                runner = "junit"
                raw: str | dict[str, Any] = text
            else:
                raw = json.loads(text)
                runner = (
                    "playwright"
                    if isinstance(raw, dict) and "stats" in raw and "suites" in raw
                    else "vitest"
                )
        else:
            raw = text if runner == "junit" else json.loads(text)
        result = normalize_ci_metrics(
            raw,
            runner=runner,
            head_sha=args.head_sha,
            source=str(input_path),
        )
        if args.output:
            _write_json(Path(args.output).resolve(), result)
    except (OSError, ValueError, ET.ParseError, json.JSONDecodeError) as exc:
        result = {"ok": False, "code": "CI_METRICS_FAILED", "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _cmd_record_sequence(args: argparse.Namespace) -> int:
    result = record_sequence_receipt(
        Path(args.change_dir),
        args.node,
        {
            "productCommit": args.product_commit,
            "productTreeHash": args.product_tree_hash,
            "environmentHash": args.environment_hash,
        },
        status=args.status,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


def _cmd_sequence_status(args: argparse.Namespace) -> int:
    result = evaluate_final_sequence(
        Path(args.change_dir),
        {
            "productCommit": args.product_commit,
            "productTreeHash": args.product_tree_hash,
            "environmentHash": args.environment_hash,
        },
        exclude_nodes={"sequence:archive"} if args.pre_archive else set(),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


def _subject_from_args(args: argparse.Namespace) -> dict[str, str]:
    return {
        "productCommit": args.product_commit,
        "productTreeHash": args.product_tree_hash,
        "environmentHash": args.environment_hash,
    }


def _cmd_record_environment(args: argparse.Namespace) -> int:
    result = record_environment_attempt(
        Path(args.change_dir),
        _subject_from_args(args),
        stage=args.stage,
        status=args.status,
        duration_ms=args.duration_ms,
        failure_signature=args.failure_signature,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


def _cmd_record_full(args: argparse.Namespace) -> int:
    result = record_full_test_execution(
        Path(args.change_dir),
        _subject_from_args(args),
        status=args.status,
        prepare_ms=args.prepare_ms,
        test_ms=args.test_ms,
        cleanup_ms=args.cleanup_ms,
        result_digest=args.result_digest,
        supersedes=args.supersedes,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


def _add_subject_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--change-dir", required=True)
    parser.add_argument("--product-commit", required=True)
    parser.add_argument("--product-tree-hash", required=True)
    parser.add_argument("--environment-hash", required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_phase.py")
    sub = parser.add_subparsers(dest="command", required=True)
    reconcile_parser = sub.add_parser("reconcile")
    reconcile_parser.add_argument("--change-dir", required=True)
    reconcile_parser.add_argument("--project", required=True)
    reconcile_parser.add_argument("--json", action="store_true")
    reconcile_parser.add_argument("--output")
    reconcile_parser.add_argument("--close", action="store_true")
    reconcile_parser.add_argument("--phase", default="execute")
    reconcile_parser.add_argument("--run-id")
    reconcile_parser.set_defaults(func=_cmd_reconcile)

    metrics_parser = sub.add_parser("metrics")
    metrics_parser.add_argument("--input", required=True)
    metrics_parser.add_argument("--runner", choices=("auto", "junit", "vitest", "playwright"), default="auto")
    metrics_parser.add_argument("--head-sha")
    metrics_parser.add_argument("--output")
    metrics_parser.set_defaults(func=_cmd_metrics)

    record_parser = sub.add_parser("record-sequence")
    record_parser.add_argument("--change-dir", required=True)
    record_parser.add_argument("--node", required=True)
    record_parser.add_argument("--product-commit", required=True)
    record_parser.add_argument("--product-tree-hash", required=True)
    record_parser.add_argument("--environment-hash", required=True)
    record_parser.add_argument(
        "--status",
        choices=("OK", "WARN", "FAIL"),
        default="OK",
    )
    record_parser.set_defaults(func=_cmd_record_sequence)

    sequence_parser = sub.add_parser("sequence-status")
    sequence_parser.add_argument("--change-dir", required=True)
    sequence_parser.add_argument("--product-commit", required=True)
    sequence_parser.add_argument("--product-tree-hash", required=True)
    sequence_parser.add_argument("--environment-hash", required=True)
    sequence_parser.add_argument("--pre-archive", action="store_true")
    sequence_parser.set_defaults(func=_cmd_sequence_status)

    environment_parser = sub.add_parser("record-environment")
    _add_subject_arguments(environment_parser)
    environment_parser.add_argument(
        "--stage",
        choices=("prepare", "verify", "release"),
        required=True,
    )
    environment_parser.add_argument(
        "--status",
        choices=("OK", "ENVIRONMENT_ERROR", "INTERRUPTED", "FAIL"),
        required=True,
    )
    environment_parser.add_argument("--duration-ms", type=int, required=True)
    environment_parser.add_argument("--failure-signature")
    environment_parser.set_defaults(func=_cmd_record_environment)

    full_parser = sub.add_parser("record-full")
    _add_subject_arguments(full_parser)
    full_parser.add_argument("--status", choices=("OK", "FAIL"), required=True)
    full_parser.add_argument("--prepare-ms", type=int, required=True)
    full_parser.add_argument("--test-ms", type=int, required=True)
    full_parser.add_argument("--cleanup-ms", type=int, required=True)
    full_parser.add_argument("--result-digest", required=True)
    full_parser.add_argument("--supersedes")
    full_parser.set_defaults(func=_cmd_record_full)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
