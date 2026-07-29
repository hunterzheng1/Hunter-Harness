#!/usr/bin/env python3
"""Normalized report facts shared by archive collection and rendering."""

from __future__ import annotations

import copy
import datetime as dt
from typing import Any, Iterable, Mapping

REPORT_MODEL_SCHEMA_VERSION = 1
UNKNOWN_VALUES = frozenset({"", "unknown", "not_available", "n/a", "null"})
TERMINAL_STATUSES = frozenset(
    {
        "OK",
        "PASS",
        "PASSED",
        "WARN",
        "FAIL",
        "FAILED",
        "ERROR",
        "BLOCKED",
        "BLOCKED_BY_ENV",
        "BLOCKED_BY_DBA",
        "NOT_RUN",
        "SKIPPED",
        "USER_SKIPPED",
        "NOT_APPLICABLE",
        "CANCELLED",
        "TIMED_OUT",
        "TERMINATED",
    }
)
IDENTITY_FIELDS = (
    "repositoryId",
    "changeName",
    "baseCommit",
    "productCommit",
    "featureMergeHash",
    "releaseTipHash",
    "productTreeHash",
    "environmentHash",
    "candidateId",
)
CONTENT_HASH_FIELDS = frozenset({"productTreeHash", "environmentHash"})
TARGET_IDENTITY_FIELDS = (
    "target",
    "repositoryId",
    "changeName",
    "productCommit",
    "productTreeHash",
    "environmentHash",
    "profile",
    "candidateId",
)
CURRENT_DISPOSITIONS = frozenset(
    {"OPEN", "ACCEPTED_RISK", "DEFERRED", "UNKNOWN"}
)


def measurement(
    value: Any = None,
    *,
    applicable: bool | None = True,
    reason: str | None = None,
) -> dict[str, Any]:
    if isinstance(value, Mapping) and value.get("state") in {
        "unknown",
        "not_applicable",
        "zero",
        "known",
    }:
        return copy.deepcopy(dict(value))
    if applicable is False:
        result = {"state": "not_applicable", "value": None}
    elif value is None or (
        isinstance(value, str) and value.strip().lower() in UNKNOWN_VALUES
    ):
        result = {"state": "unknown", "value": None}
    elif isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0:
        result = {"state": "zero", "value": value}
    else:
        result = {"state": "known", "value": copy.deepcopy(value)}
    if reason:
        result["reason"] = reason
    return result


def canonical_identity(summary: Mapping[str, Any]) -> dict[str, str]:
    nested = summary.get("changeIdentity")
    nested = nested if isinstance(nested, Mapping) else {}
    fallbacks: dict[str, tuple[str, ...]] = {
        "repositoryId": ("repositoryId",),
        "changeName": ("changeName",),
        "baseCommit": ("baseCommit",),
        "productCommit": ("productCommit", "finalCommit"),
        "featureMergeHash": ("featureMergeHash", "productCommit", "finalCommit"),
        "releaseTipHash": ("releaseTipHash", "archiveCommit", "finalCommit"),
        "productTreeHash": ("productTreeHash",),
        "environmentHash": ("environmentHash",),
        "candidateId": ("candidateId",),
    }
    identity: dict[str, str] = {}
    for field in IDENTITY_FIELDS:
        candidates = (nested.get(field),) + tuple(
            summary.get(key) for key in fallbacks[field]
        )
        value = next(
            (
                str(candidate).strip()
                for candidate in candidates
                if candidate is not None and str(candidate).strip()
            ),
            "",
        )
        if field in CONTENT_HASH_FIELDS and value and value != "not_available":
            value = "sha256:" + value.removeprefix("sha256:")
        identity[field] = value
    return identity


def apply_identity_mirrors(
    summary: Mapping[str, Any],
    identity: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    result = copy.deepcopy(dict(summary))
    canonical = dict(identity or canonical_identity(summary))
    result["changeIdentity"] = copy.deepcopy(canonical)
    for field in (
        "productCommit",
        "featureMergeHash",
        "releaseTipHash",
        "productTreeHash",
        "environmentHash",
    ):
        if canonical.get(field):
            result[field] = canonical[field]
    git_facts = result.get("gitFacts")
    git_facts = copy.deepcopy(git_facts) if isinstance(git_facts, Mapping) else {}
    for field in (
        "baseCommit",
        "productCommit",
        "featureMergeHash",
        "releaseTipHash",
        "productTreeHash",
        "environmentHash",
    ):
        if canonical.get(field):
            git_facts[field] = canonical[field]
    result["gitFacts"] = git_facts
    return result


def _identity_value(field: str, value: Any) -> str:
    text = str(value or "").strip()
    if field in CONTENT_HASH_FIELDS and text and text != "not_available":
        return text.removeprefix("sha256:")
    return text


def _record_time(record: Mapping[str, Any]) -> dt.datetime:
    for field in ("finishedAt", "completedAt", "endedAt", "timestamp", "recordedAt"):
        value = str(record.get(field) or "").strip()
        if not value:
            continue
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            continue
    return dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def select_latest_terminal_verification(
    records: Iterable[Mapping[str, Any]],
    target_identity: Mapping[str, Any],
) -> dict[str, Any] | None:
    matches: list[Mapping[str, Any]] = []
    for record in records:
        if str(record.get("status") or "").strip().upper() not in TERMINAL_STATUSES:
            continue
        matches_identity = True
        for field in TARGET_IDENTITY_FIELDS:
            expected = _identity_value(field, target_identity.get(field))
            if not expected:
                continue
            actual = _identity_value(field, record.get(field))
            if actual != expected:
                matches_identity = False
                break
        if matches_identity:
            matches.append(record)
    if not matches:
        return None
    return copy.deepcopy(dict(max(matches, key=_record_time)))


def current_findings(items: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    current: list[dict[str, Any]] = []
    for item in items:
        disposition = (
            str(item.get("disposition") or "UNKNOWN")
            .strip()
            .upper()
            .replace("-", "_")
        )
        if disposition not in CURRENT_DISPOSITIONS:
            continue
        entry = copy.deepcopy(dict(item))
        entry["disposition"] = disposition
        current.append(entry)
    return current


def latest_terminal_validations(
    ledger: Mapping[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """Project validation history onto the current immutable product target."""
    if not isinstance(ledger, Mapping):
        return {}
    raw_validations = ledger.get("validations")
    raw_validations = (
        raw_validations if isinstance(raw_validations, Mapping) else {}
    )
    global_history: list[Mapping[str, Any]] = []
    dynamic_targets = ledger.get("verificationTargets")
    if isinstance(dynamic_targets, Mapping):
        for key, item in dynamic_targets.items():
            if isinstance(item, Mapping):
                global_history.append(
                    {
                        **dict(item),
                        "target": (
                            item.get("target")
                            or item.get("verification")
                            or str(key)
                        ),
                    }
                )
    elif isinstance(dynamic_targets, list):
        global_history.extend(
            item for item in dynamic_targets if isinstance(item, Mapping)
        )
    for key in ("verificationHistory", "validationHistory", "validationsHistory"):
        items = ledger.get(key)
        if isinstance(items, list):
            global_history.extend(
                item for item in items if isinstance(item, Mapping)
            )
    projected: dict[str, dict[str, Any]] = {}
    targets = {
        str(key) for key in raw_validations
    } | {
        str(item.get("target") or item.get("verification") or "")
        for item in global_history
        if item.get("target") or item.get("verification")
    }
    base_target = {
        "repositoryId": ledger.get("repositoryId"),
        "changeName": ledger.get("changeName"),
        "productCommit": (
            ledger.get("productCommit")
            or ledger.get("headCommit")
            or ledger.get("currentHead")
        ),
        "productTreeHash": ledger.get("productTreeHash"),
        "environmentHash": ledger.get("environmentHash"),
        "profile": ledger.get("profile"),
        "candidateId": ledger.get("candidateId"),
    }
    for target in sorted(item for item in targets if item):
        direct = raw_validations.get(target)
        candidates: list[Mapping[str, Any]] = [
            {
                **dict(item),
                "target": item.get("target") or item.get("verification") or target,
            }
            for item in global_history
            if str(item.get("target") or item.get("verification") or "") == target
        ]
        if isinstance(direct, Mapping):
            for key in ("history", "attempts"):
                items = direct.get(key)
                if isinstance(items, list):
                    candidates.extend(
                        {**dict(item), "target": target}
                        for item in items
                        if isinstance(item, Mapping)
                    )
            candidates.append({**dict(direct), "target": target})
        selected = select_latest_terminal_verification(
            candidates,
            {"target": target, **base_target},
        )
        if selected is not None:
            selected.pop("target", None)
            projected[target] = selected
        elif isinstance(direct, Mapping):
            projected[target] = copy.deepcopy(dict(direct))
    return projected


def _measure_record(value: Any) -> Any:
    if not isinstance(value, Mapping):
        return measurement(value)
    return {
        str(key): _measure_record(item)
        for key, item in value.items()
    }


def _mark_uncollected_metrics(
    measured: dict[str, Any],
    *paths: tuple[str, ...],
) -> None:
    for path in paths:
        current: Any = measured
        for key in path[:-1]:
            if not isinstance(current, dict):
                current = None
                break
            current = current.get(key)
        if isinstance(current, dict) and path:
            current[path[-1]] = measurement(
                None,
                reason="metric was not collected",
            )


def normalize_report(summary: Mapping[str, Any]) -> dict[str, Any]:
    canonical = canonical_identity(summary)
    review_items = summary.get("reviewFindings")
    review_items = review_items if isinstance(review_items, list) else []
    risks = current_findings(review_items)
    remote_cost = summary.get("remoteCost")
    remote_cost = remote_cost if isinstance(remote_cost, Mapping) else {}
    artifact_storage = summary.get("artifactStorage")
    artifact_storage = (
        artifact_storage if isinstance(artifact_storage, Mapping) else {}
    )
    candidate = summary.get("candidateVerification")
    candidate = copy.deepcopy(candidate) if isinstance(candidate, Mapping) else {}
    current = {
        "status": str(summary.get("finalStatus") or "UNKNOWN"),
        "reasons": copy.deepcopy(list(summary.get("finalStatusReasons") or [])),
        "stages": copy.deepcopy(dict(summary.get("stageStatus") or {})),
        "findings": risks,
        "knownRisks": (
            copy.deepcopy(risks)
            if review_items
            else copy.deepcopy(list(summary.get("knownRisks") or []))
        ),
    }
    history = {
        "timeline": copy.deepcopy(list(summary.get("timeline") or [])),
        "attempts": copy.deepcopy(
            list((summary.get("timing") or {}).get("attempts") or [])
            if isinstance(summary.get("timing"), Mapping)
            else []
        ),
    }
    release_raw = summary.get("releaseDecision")
    release_raw = release_raw if isinstance(release_raw, Mapping) else {}
    release_intent = str(summary.get("archiveIntent") or "")
    release_decision = (
        "NOT_REQUESTED"
        if release_intent == "record-only"
        else str(
            release_raw.get("code")
            or summary.get("releaseDecision")
            or "NOT_DECIDED"
        )
    )
    release = {
        "decision": release_decision,
        "eligible": (
            False
            if release_intent == "record-only"
            else bool(
                release_raw.get("releaseEligible")
                if "releaseEligible" in release_raw
                else summary.get("releaseEligible")
            )
        ),
        "candidate": candidate,
        "intent": release_intent,
    }
    remote_measurements = _measure_record(remote_cost)
    if remote_cost.get("available") is False:
        _mark_uncollected_metrics(
            remote_measurements,
            ("totals", "runCount"),
            ("totals", "runnerMinutes"),
            ("totals", "queueWaitMs"),
            ("totals", "artifactBytes"),
            ("totals", "duplicateRunCount"),
        )
    storage_measurements = _measure_record(artifact_storage)
    if artifact_storage.get("available") is not True:
        _mark_uncollected_metrics(
            storage_measurements,
            ("artifactCount",),
            ("bytesAdded",),
            ("bytesReused",),
            ("bytesPruned",),
        )
    return {
        "schemaVersion": REPORT_MODEL_SCHEMA_VERSION,
        "changeName": str(summary.get("changeName") or ""),
        "identity": canonical,
        "outcomes": {
            "current": current,
            "history": history,
            "release": release,
        },
        "verification": copy.deepcopy(dict(summary.get("verification") or {})),
        "timing": copy.deepcopy(dict(summary.get("timing") or {})),
        "measurements": {
            "remoteCost": remote_measurements,
            "artifactStorage": storage_measurements,
        },
    }
