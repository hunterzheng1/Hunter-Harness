#!/usr/bin/env python3
"""Batch related fixback issues without weakening RED/GREEN evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import tempfile
import sys
import uuid
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from harness_paths import resolve_state_dir_for_contract
import harness_events as he


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
        phase="run",
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
        raise ValueError(f"FIXBACK_EVIDENCE_MISSING: {raw_path}")
    if not _is_within(path, [contract_root, state_root, project_root]):
        raise ValueError(f"FIXBACK_EVIDENCE_OUTSIDE_PROJECT: {raw_path}")
    return path


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
        if (
            not isinstance(run, dict)
            or run.get("status") != expected_status
            or run.get("testProcessStarted") is not True
            or run.get("productIdentity") != product_identity
            or provenance.get("sessionId") != run.get("sessionId")
            or provenance.get("commandHash") != run.get("commandHash")
            or provenance.get("resultDigest") != run.get("resultDigest")
            or not str(run.get("commandHash") or "").startswith("sha256:")
            or not str(run.get("resultDigest") or "").startswith("sha256:")
            or not str(run.get("endedAt") or "").strip()
        ):
            raise ValueError("FIXBACK_RUN_PROVENANCE_INVALID")
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
        unresolved = [
            item
            for item in findings or []
            if isinstance(item, dict) and item.get("severity") in {"RED", "YELLOW"}
        ]
        if (
            not isinstance(review, dict)
            or review.get("schemaVersion") != 1
            or not isinstance(findings, list)
            or review.get("runId") != provenance.get("reviewRunId")
            or provenance.get("engine") != "harness-review-6d"
            or provenance.get("sourceDigest") != source_digest
            or unresolved
        ):
            raise ValueError("FIXBACK_REVIEW_PROVENANCE_INVALID")
    record = {
        "path": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "evidenceId": evidence_id,
        "kind": kind,
        "status": status,
        "productIdentity": product_identity,
        "passedGates": sorted(set(passed_gates)),
        "provenance": provenance,
        "registeredAt": now_iso(),
    }
    ledger = _load_evidence_ledger(change_dir)
    existing = ledger["evidence"].get(evidence_id)
    if existing is not None:
        comparable = {
            key: value
            for key, value in record.items()
            if key != "registeredAt"
        }
        existing_comparable = {
            key: value
            for key, value in existing.items()
            if key != "registeredAt"
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
        raise ValueError(f"FIXBACK_EVIDENCE_UNREGISTERED: {raw_path}")
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
    sub = parser.add_subparsers(dest="command", required=True)
    resume = sub.add_parser("resume")
    resume.add_argument("--change-dir", required=True)
    resume.add_argument("--batch-id")
    resume.add_argument("--product-identity")
    resume.add_argument("--root-cause")
    resume.add_argument("--run-id")
    resume.add_argument("--attempt", type=int)
    opened = sub.add_parser("open")
    opened.add_argument("--change-dir", required=True)
    opened.add_argument("--batch-id", required=True)
    opened.add_argument("--product-identity", required=True)
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
    close.add_argument("--final-product-identity", required=True)
    close.add_argument("--affected-receipt", required=True)
    close.add_argument("--review-receipt", required=True)
    status = sub.add_parser("status")
    status.add_argument("--change-dir", required=True)
    status.add_argument("--batch-id", required=True)
    freeze = sub.add_parser("freeze-readiness")
    freeze.add_argument("--change-dir", required=True)
    freeze.add_argument("--product-identity", required=True)
    register = sub.add_parser("register-evidence")
    register.add_argument("--change-dir", required=True)
    register.add_argument("--evidence", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    change_dir = Path(args.change_dir)
    try:
        if args.command == "resume":
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
