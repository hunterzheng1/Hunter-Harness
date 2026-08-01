#!/usr/bin/env python3
"""Canonical managed execution contract reader.

The JSON Schema files under ``harness/contracts`` are the publication source
of truth.  This stdlib-only reader applies the same security-sensitive
invariants at runtime without accepting caller-provided identity assertions as
observed OS facts.
"""

from __future__ import annotations

from copy import deepcopy
import re
from typing import Any, Callable


SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PROVENANCE = {"OBSERVED", "ATTESTED", "UNAVAILABLE"}
RUN_STATUSES = {
    "PREPARING",
    "STARTING",
    "RUNNING",
    "FINALIZING",
    "OK",
    "FAIL",
    "CANCELLED",
    "INCOMPLETE",
}
SERVICE_STATUSES = {
    "STARTING",
    "READY",
    "STOPPING",
    "STOPPED",
    "FAILED",
    "STALE_IDENTITY_MISMATCH",
    "RETIRED",
}
MANAGED_EXECUTION_EXIT_CODE_BY_REASON = {
    "CHILD_EXIT_ZERO": 0,
    "USER_CANCELLED": 0,
    "SERVICE_START_REQUESTED": 0,
    "SERVICE_READY": 0,
    "SERVICE_REUSED": 0,
    "SERVICE_STOP_REQUESTED": 0,
    "SERVICE_STOPPED": 0,
    "SERVICE_RETIRED": 0,
    "SERVICE_SUPERSEDER_ALREADY_LINKED": 0,
    "ARGUMENT_INVALID": 2,
    "CURSOR_INVALID": 2,
    "PROFILE_INVALID": 2,
    "PROFILE_MIGRATION_UNSAFE": 2,
    "SESSION_SCHEMA_INVALID": 2,
    "PYTHON_RUNTIME_NOT_FOUND": 3,
    "WORKER_LAUNCH_FAILED": 3,
    "LAUNCHER_FAILED": 3,
    "CHILD_EXIT_NONZERO": 3,
    "TIMEOUT": 3,
    "SERVICE_START_FAILED": 3,
    "SERVICE_STOP_FAILED": 3,
    "SERVICE_STOP_TIMEOUT": 3,
    "RESOURCE_LOCK_BUSY": 4,
    "SERVICE_MUTATION_CONFLICT": 4,
    "SERVICE_TRANSITION_CONFLICT": 4,
    "SERVICE_SUPERSEDER_CONFLICT": 4,
    "PROCESS_CREATE_TIME_MISMATCH": 5,
    "PROCESS_EXECUTABLE_MISMATCH": 5,
    "PROCESS_ARGV_MISMATCH": 5,
    "PROCESS_CWD_MISMATCH": 5,
    "PROCESS_PARENT_MISMATCH": 5,
    "PROCESS_OWNER_MISMATCH": 5,
    "PROCESS_IDENTITY_MISMATCH": 5,
    "WORKER_IDENTITY_MISMATCH": 5,
    "SERVICE_IDENTITY_STALE": 5,
    "SERVICE_STOP_IDENTITY_LOST": 5,
    "LEASE_CAS_MISMATCH": 5,
    "LISTENER_IDENTITY_UNVERIFIABLE": 5,
    "SENSITIVE_EVIDENCE_QUARANTINE_FAILED": 5,
    "IDENTITY_UNVERIFIABLE": 6,
    "HEARTBEAT_LOST": 6,
    "SERVICE_HEARTBEAT_STALE": 6,
    "SERVICE_CLEANUP_INCOMPLETE": 6,
    "LOG_DECODE_DEGRADED": 6,
}
MANAGED_EXECUTION_REASON_CODES = frozenset(
    MANAGED_EXECUTION_EXIT_CODE_BY_REASON
)


def _record(
    value: Any,
    required: set[str],
    *,
    optional: set[str] | None = None,
) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(value, dict):
        return None, ["value must be an object"]
    keys = set(value)
    missing = sorted(required - keys)
    unexpected = sorted(keys - required - (optional or set()))
    errors = [f"missing field: {item}" for item in missing]
    errors.extend(f"unexpected field: {item}" for item in unexpected)
    return value, errors


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _nullable_nonempty(value: Any) -> bool:
    return value is None or _nonempty(value)


def _digest(value: Any) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _nullable_digest(value: Any) -> bool:
    return value is None or _digest(value)


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate_process_identity(value: Any) -> list[str]:
    required = {
        "schemaVersion",
        "pid",
        "alive",
        "createdAt",
        "executable",
        "argvHash",
        "workingDirectory",
        "parentIdentity",
        "ownerTokenHash",
        "treeIdentity",
        "fieldProvenance",
        "capabilities",
    }
    record, errors = _record(
        value,
        required,
        optional={"commandHash", "parentChain", "startedAt"},
    )
    if record is None:
        return errors
    if record["schemaVersion"] != 1:
        errors.append("schemaVersion must equal 1")
    if not _positive_int(record["pid"]):
        errors.append("pid must be a positive integer")
    if not isinstance(record["alive"], bool):
        errors.append("alive must be boolean")
    for field in ("createdAt", "executable", "workingDirectory"):
        if not _nullable_nonempty(record[field]):
            errors.append(f"{field} must be null or a non-empty string")
    for field in ("argvHash", "ownerTokenHash"):
        if not _nullable_digest(record[field]):
            errors.append(f"{field} must be null or a sha256 digest")
    if "commandHash" in record and not _digest(record["commandHash"]):
        errors.append("commandHash must be a sha256 digest")
    if "parentChain" in record and not isinstance(record["parentChain"], list):
        errors.append("parentChain must be an array")
    if "startedAt" in record and not _nonempty(record["startedAt"]):
        errors.append("startedAt must be a non-empty string")

    parent = record["parentIdentity"]
    if parent is not None:
        parent_record, parent_errors = _record(
            parent, {"pid", "createdAt", "executable"}
        )
        errors.extend(f"parentIdentity.{item}" for item in parent_errors)
        if parent_record is not None:
            if not _positive_int(parent_record["pid"]):
                errors.append("parentIdentity.pid must be positive")
            for field in ("createdAt", "executable"):
                if not _nullable_nonempty(parent_record[field]):
                    errors.append(f"parentIdentity.{field} is invalid")

    tree = record["treeIdentity"]
    if tree is not None:
        tree_record, tree_errors = _record(
            tree,
            {"platform", "proofKind", "memberPids", "complete"},
            optional={"groupId", "sessionId"},
        )
        errors.extend(f"treeIdentity.{item}" for item in tree_errors)
        if tree_record is not None:
            if tree_record["platform"] not in {"WINDOWS", "LINUX", "POSIX"}:
                errors.append("treeIdentity.platform is invalid")
            if not _nonempty(tree_record["proofKind"]):
                errors.append("treeIdentity.proofKind is invalid")
            members = tree_record["memberPids"]
            if (
                not isinstance(members, list)
                or any(not _positive_int(item) for item in members)
                or len(set(members)) != len(members)
            ):
                errors.append("treeIdentity.memberPids is invalid")
            if not isinstance(tree_record["complete"], bool):
                errors.append("treeIdentity.complete must be boolean")
            for field in ("groupId", "sessionId"):
                if field in tree_record and not _positive_int(tree_record[field]):
                    errors.append(f"treeIdentity.{field} is invalid")

    provenance_fields = {
        "pid",
        "createdAt",
        "executable",
        "argvHash",
        "workingDirectory",
        "parentIdentity",
        "ownerTokenHash",
        "treeIdentity",
    }
    provenance, provenance_errors = _record(
        record["fieldProvenance"], provenance_fields
    )
    errors.extend(f"fieldProvenance.{item}" for item in provenance_errors)
    if provenance is not None:
        if provenance["pid"] != "OBSERVED":
            errors.append("fieldProvenance.pid must be OBSERVED")
        for field in provenance_fields - {"pid"}:
            if provenance[field] not in PROVENANCE:
                errors.append(f"fieldProvenance.{field} is invalid")

    capability_fields = {
        "canObserveCreateTime",
        "canObserveExecutable",
        "canObserveArgv",
        "canObserveWorkingDirectory",
        "canObserveParent",
        "canEnumerateTree",
        "canVerifyOwnership",
    }
    capabilities, capability_errors = _record(
        record["capabilities"], capability_fields
    )
    errors.extend(f"capabilities.{item}" for item in capability_errors)
    if capabilities is not None:
        for field in capability_fields:
            if not isinstance(capabilities[field], bool):
                errors.append(f"capabilities.{field} must be boolean")
    return errors


def _validate_heartbeat(
    value: Any,
    *,
    service: bool,
) -> list[str]:
    if value is None:
        return []
    required = {
        "kind",
        "writerIdentity",
        "lastSeenAt",
        "ttlSeconds",
        "staleReason",
    }
    if service:
        required.add("generation")
    record, errors = _record(value, required)
    if record is None:
        return errors
    kinds = {"SUPERVISOR", "OBSERVER"} if service else {
        "WORKER",
        "SUPERVISOR",
        "OBSERVER",
    }
    if record["kind"] not in kinds:
        errors.append("kind is invalid")
    if not _digest(record["writerIdentity"]):
        errors.append("writerIdentity must be a sha256 digest")
    if not _nonempty(record["lastSeenAt"]):
        errors.append("lastSeenAt is invalid")
    if not _positive_int(record["ttlSeconds"]):
        errors.append("ttlSeconds must be positive")
    if not _nullable_nonempty(record["staleReason"]):
        errors.append("staleReason is invalid")
    if service and not _positive_int(record["generation"]):
        errors.append("generation must be positive")
    return errors


def _validate_run_session(value: Any) -> list[str]:
    required = {
        "schemaVersion",
        "sessionId",
        "status",
        "reasonCode",
        "exitCode",
        "processIdentity",
        "heartbeat",
        "logs",
        "cleanup",
        "resultDigest",
    }
    record, errors = _record(value, required)
    if record is None:
        return errors
    if record["schemaVersion"] != 1:
        errors.append("schemaVersion must equal 1")
    if not _nonempty(record["sessionId"]):
        errors.append("sessionId is invalid")
    if record["status"] not in RUN_STATUSES:
        errors.append("status is invalid")
    if record["reasonCode"] not in MANAGED_EXECUTION_REASON_CODES:
        errors.append("reasonCode is invalid")
    if record["processIdentity"] is not None:
        errors.extend(
            f"processIdentity.{item}"
            for item in _validate_process_identity(record["processIdentity"])
        )
    errors.extend(
        f"heartbeat.{item}"
        for item in _validate_heartbeat(record["heartbeat"], service=False)
    )

    logs, log_errors = _record(record["logs"], {"stdout", "stderr"})
    errors.extend(f"logs.{item}" for item in log_errors)
    if logs is not None:
        for stream in ("stdout", "stderr"):
            stream_record, stream_errors = _record(
                logs[stream], {"cursor", "rawDigest", "decodeStatus"}
            )
            errors.extend(f"logs.{stream}.{item}" for item in stream_errors)
            if stream_record is None:
                continue
            if not _nonnegative_int(stream_record["cursor"]):
                errors.append(f"logs.{stream}.cursor is invalid")
            if not _digest(stream_record["rawDigest"]):
                errors.append(f"logs.{stream}.rawDigest is invalid")
            if stream_record["decodeStatus"] not in {
                "OK",
                "LOG_DECODE_DEGRADED",
            }:
                errors.append(f"logs.{stream}.decodeStatus is invalid")

    cleanup, cleanup_errors = _record(
        record["cleanup"], {"complete", "reasonCode"}
    )
    errors.extend(f"cleanup.{item}" for item in cleanup_errors)
    if cleanup is not None:
        if not isinstance(cleanup["complete"], bool):
            errors.append("cleanup.complete must be boolean")
        reason = cleanup["reasonCode"]
        if reason is not None and reason not in MANAGED_EXECUTION_REASON_CODES:
            errors.append("cleanup.reasonCode is invalid")

    status = record["status"]
    exit_code = record["exitCode"]
    if status in {"OK", "FAIL"}:
        if not isinstance(exit_code, int) or isinstance(exit_code, bool):
            errors.append("OK/FAIL requires a final exitCode")
        if not _digest(record["resultDigest"]):
            errors.append("terminal run requires resultDigest")
    elif status == "INCOMPLETE":
        if exit_code is not None:
            errors.append("INCOMPLETE must not contain an exitCode")
        if not _digest(record["resultDigest"]):
            errors.append("INCOMPLETE requires an evidence digest")
    elif exit_code is not None and (
        not isinstance(exit_code, int) or isinstance(exit_code, bool)
    ):
        errors.append("exitCode must be integer or null")
    if not _nullable_digest(record["resultDigest"]):
        errors.append("resultDigest must be null or a sha256 digest")
    return errors


def _validate_service_session(value: Any) -> list[str]:
    required = {
        "schemaVersion",
        "serviceId",
        "sessionId",
        "status",
        "reasonCode",
        "serviceGeneration",
        "stateRevision",
        "operationId",
        "fingerprint",
        "processIdentity",
        "heartbeat",
        "leaseIdentity",
        "transitionHistory",
        "cleanupComplete",
        "supersedesSessionId",
    }
    record, errors = _record(
        value,
        required,
        optional={
            "pid",
            "startedBy",
            "moduleInputsHash",
            "moduleInputsFiles",
            "profile",
            "startCommandHash",
            "overlayPath",
            "startedAt",
            "command",
            "argv",
            "ownedPorts",
            "processAttestation",
            "ownershipProof",
            "servicePid",
            "jobId",
            "leasedPort",
            "leaseOwner",
            "worktreeRoot",
            "executionRoot",
            "changeId",
            "attemptId",
            "instanceTokenHash",
            "identityCompleteness",
        },
    )
    if record is None:
        return errors
    if record["schemaVersion"] != 1:
        errors.append("schemaVersion must equal 1")
    for field in ("serviceId", "sessionId", "operationId"):
        if not _nonempty(record[field]):
            errors.append(f"{field} is invalid")
    if record["status"] not in SERVICE_STATUSES:
        errors.append("status is invalid")
    if record["reasonCode"] not in MANAGED_EXECUTION_REASON_CODES:
        errors.append("reasonCode is invalid")
    for field in ("serviceGeneration", "stateRevision"):
        if not _positive_int(record[field]):
            errors.append(f"{field} must be positive")
    if not _digest(record["fingerprint"]):
        errors.append("fingerprint must be a sha256 digest")
    if record["processIdentity"] is not None:
        errors.extend(
            f"processIdentity.{item}"
            for item in _validate_process_identity(record["processIdentity"])
        )
    errors.extend(
        f"heartbeat.{item}"
        for item in _validate_heartbeat(record["heartbeat"], service=True)
    )
    lease = record["leaseIdentity"]
    if lease is not None:
        lease_record, lease_errors = _record(
            lease,
            {"leaseId", "changeId", "runId", "expiresAt", "generation"},
            optional={"listenerIdentity"},
        )
        errors.extend(f"leaseIdentity.{item}" for item in lease_errors)
        if lease_record is not None:
            for field in ("leaseId", "changeId", "runId", "expiresAt"):
                if not _nonempty(lease_record[field]):
                    errors.append(f"leaseIdentity.{field} is invalid")
            if not _positive_int(lease_record["generation"]):
                errors.append("leaseIdentity.generation must be positive")
    history = record["transitionHistory"]
    if not isinstance(history, list):
        errors.append("transitionHistory must be an array")
    else:
        for index, item in enumerate(history):
            transition, transition_errors = _record(
                item,
                {"from", "to", "reasonCode", "revision"},
                optional={"operationId", "at"},
            )
            errors.extend(
                f"transitionHistory[{index}].{error}"
                for error in transition_errors
            )
            if transition is None:
                continue
            if not _nullable_nonempty(transition["from"]):
                errors.append(f"transitionHistory[{index}].from is invalid")
            if not _nonempty(transition["to"]):
                errors.append(f"transitionHistory[{index}].to is invalid")
            if transition["reasonCode"] not in MANAGED_EXECUTION_REASON_CODES:
                errors.append(
                    f"transitionHistory[{index}].reasonCode is invalid"
                )
            if not _positive_int(transition["revision"]):
                errors.append(f"transitionHistory[{index}].revision is invalid")
    if not isinstance(record["cleanupComplete"], bool):
        errors.append("cleanupComplete must be boolean")
    if not _nullable_nonempty(record["supersedesSessionId"]):
        errors.append("supersedesSessionId is invalid")
    return errors


def _validate_retirement_receipt(value: Any) -> list[str]:
    required = {
        "schemaVersion",
        "receiptId",
        "operationId",
        "serviceId",
        "oldSessionId",
        "oldGeneration",
        "state",
        "retirementStateCommit",
        "leaseCleanup",
        "cleanupComplete",
        "awaitingSuperseder",
        "supersededBySessionId",
        "receiptDigest",
    }
    record, errors = _record(value, required)
    if record is None:
        return errors
    if record["schemaVersion"] != 1:
        errors.append("schemaVersion must equal 1")
    for field in ("receiptId", "operationId", "serviceId", "oldSessionId"):
        if not _nonempty(record[field]):
            errors.append(f"{field} is invalid")
    if not _positive_int(record["oldGeneration"]):
        errors.append("oldGeneration must be positive")
    if record["state"] not in {"PENDING", "FINALIZED"}:
        errors.append("state is invalid")
    state_commit, commit_errors = _record(
        record["retirementStateCommit"], {"status", "reasonCode"}
    )
    errors.extend(f"retirementStateCommit.{item}" for item in commit_errors)
    if state_commit is not None:
        if state_commit["status"] not in {"PENDING", "COMMITTED", "CONFLICT"}:
            errors.append("retirementStateCommit.status is invalid")
        if state_commit["reasonCode"] not in MANAGED_EXECUTION_REASON_CODES:
            errors.append("retirementStateCommit.reasonCode is invalid")
    lease, lease_errors = _record(
        record["leaseCleanup"], {"status", "reasonCode", "leaseId"}
    )
    errors.extend(f"leaseCleanup.{item}" for item in lease_errors)
    if lease is not None:
        if lease["status"] not in {
            "PENDING",
            "RELEASED",
            "RETAINED",
            "UNVERIFIED",
        }:
            errors.append("leaseCleanup.status is invalid")
        if lease["reasonCode"] not in MANAGED_EXECUTION_REASON_CODES:
            errors.append("leaseCleanup.reasonCode is invalid")
        if not _nullable_nonempty(lease["leaseId"]):
            errors.append("leaseCleanup.leaseId is invalid")
        expected_cleanup = lease["status"] == "RELEASED"
        if record["cleanupComplete"] is not expected_cleanup:
            errors.append("cleanupComplete contradicts leaseCleanup.status")
    if not isinstance(record["cleanupComplete"], bool):
        errors.append("cleanupComplete must be boolean")
    if not isinstance(record["awaitingSuperseder"], bool):
        errors.append("awaitingSuperseder must be boolean")
    if not _nullable_nonempty(record["supersededBySessionId"]):
        errors.append("supersededBySessionId is invalid")
    if (
        record["awaitingSuperseder"] is True
        and record["supersededBySessionId"] is not None
    ):
        errors.append("awaiting receipt cannot already name a superseder")
    if not _digest(record["receiptDigest"]):
        errors.append("receiptDigest must be a sha256 digest")
    return errors


_VALIDATORS: dict[str, Callable[[Any], list[str]]] = {
    "process-identity": _validate_process_identity,
    "run-session": _validate_run_session,
    "service-session": _validate_service_session,
    "service-retirement-receipt": _validate_retirement_receipt,
}


def parse_execution_contract(contract: str, value: Any) -> dict[str, Any]:
    """Parse one managed execution contract without mutating caller data."""

    validator = _VALIDATORS.get(contract)
    if validator is None:
        return {
            "ok": False,
            "code": "SESSION_SCHEMA_INVALID",
            "errors": [f"unknown execution contract: {contract}"],
        }
    errors = validator(value)
    if errors:
        return {
            "ok": False,
            "code": "SESSION_SCHEMA_INVALID",
            "errors": errors,
        }
    return {
        "ok": True,
        "code": "CONTRACT_VALID",
        "value": deepcopy(value),
        "errors": [],
    }
