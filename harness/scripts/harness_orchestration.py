#!/usr/bin/env python3
"""Compose environment, identity, verification, and progress decisions.

The planner is deliberately side-effect free. It consumes already-produced
receipts and declarations; provider operations and managed test execution stay
in their existing lifecycle modules.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

try:
    import harness_efficiency
    import harness_verification
except ImportError:  # pragma: no cover - supports direct source loading
    SCRIPTS_DIR = Path(__file__).resolve().parent
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    import harness_efficiency
    import harness_verification


SCHEMA_VERSION = 1
VALID_ENVIRONMENT_MODES = {"change-session", "ephemeral"}


def _timestamp(value: Any) -> dt.datetime | None:
    if isinstance(value, dt.datetime):
        parsed = value
    elif value:
        try:
            parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _targets(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        return [
            {**dict(value), "id": str(value.get("id") or key)}
            for key, value in sorted(raw.items())
            if isinstance(value, dict)
        ]
    if isinstance(raw, list):
        return [
            dict(value)
            for value in raw
            if isinstance(value, dict) and str(value.get("id") or "").strip()
        ]
    return []


def _record(reason_code: str, explanation: str, *, target_id: str = "", path: str = "") -> dict[str, Any]:
    result = {
        "reasonCode": reason_code,
        "explanation": explanation,
    }
    if target_id:
        result["targetId"] = target_id
    if path:
        result["path"] = path
    return result


def build_invalidation_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    changed = sorted(
        {str(path).replace("\\", "/") for path in payload.get("changedFiles", []) if str(path).strip()}
    )
    records: list[dict[str, Any]] = []
    targets = _targets(payload.get("targets", []))
    for target in sorted(targets, key=lambda item: str(item.get("id") or "")):
        target_id = str(target.get("id") or "")
        patterns = [str(pattern) for pattern in target.get("inputs", [])]
        for path in changed:
            if any(fnmatch.fnmatch(path, pattern) for pattern in patterns):
                records.append(
                    _record(
                        "PRODUCT_INPUT_CHANGED",
                        f"Changed path {path} matches verification input for {target_id}.",
                        target_id=target_id,
                        path=path,
                    )
                )

    product_identity = str(payload.get("productIdentity") or "").strip()
    frozen_identity = str(payload.get("frozenIdentity") or "").strip()
    for target in sorted(targets, key=lambda item: str(item.get("id") or "")):
        if target.get("requiresFrozenIdentity") is True and product_identity and frozen_identity and product_identity != frozen_identity:
            records.append(
                _record(
                    "FROZEN_IDENTITY_DRIFT",
                    "Current product identity differs from the frozen identity required by the target.",
                    target_id=str(target.get("id") or ""),
                )
            )
    graph_identity = str(payload.get("verificationGraphIdentity") or "").strip()
    previous_graph = str(payload.get("previousVerificationGraphIdentity") or "").strip()
    if graph_identity and previous_graph and graph_identity != previous_graph:
        records.append(
            _record(
                "VERIFICATION_GRAPH_CHANGED",
                "The declared verification graph identity changed since the previous plan.",
            )
        )
    environment = payload.get("environment")
    environment_hash = str(environment.get("environmentHash") or "").strip() if isinstance(environment, dict) else ""
    previous_environment = str(payload.get("previousEnvironmentIdentity") or "").strip()
    if environment_hash and previous_environment and environment_hash != previous_environment:
        records.append(
            _record(
                "ENVIRONMENT_IDENTITY_CHANGED",
                "The current environment identity differs from the previous environment session.",
            )
        )
    return sorted(
        records,
        key=lambda item: (
            str(item.get("reasonCode") or ""),
            str(item.get("targetId") or ""),
            str(item.get("path") or ""),
        ),
    )


def validate_environment_contract(payload: dict[str, Any]) -> dict[str, Any]:
    environment = payload.get("environment")
    if not isinstance(environment, dict) or environment.get("required") is False:
        return {
            "ok": True,
            "decision": "NOT_REQUIRED",
            "reasonCode": "ENVIRONMENT_NOT_REQUIRED",
            "explanation": "This orchestration payload does not require a managed environment session.",
        }
    mode = str(environment.get("mode") or "").strip()
    if mode not in VALID_ENVIRONMENT_MODES:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_SESSION_MODE_INVALID",
            "explanation": "Environment mode must be change-session or ephemeral.",
        }
    lease = environment.get("lease")
    if not isinstance(lease, dict):
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_LEASE_REQUIRED",
            "explanation": "A typed active environment lease is required before verification.",
            "mode": mode,
        }
    change_id = str(payload.get("changeId") or "").strip()
    expected_hash = str(environment.get("environmentHash") or "").strip()
    expected_content = str(environment.get("contentFingerprint") or "").strip()
    if lease.get("status") != "ACTIVE":
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_LEASE_INACTIVE",
            "explanation": "The environment lease is not active.",
            "mode": mode,
        }
    if str(lease.get("changeId") or "") != change_id:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_LEASE_CROSS_CHANGE",
            "explanation": "The environment lease is owned by a different change.",
            "mode": mode,
        }
    if str(lease.get("mode") or mode) != mode:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_SESSION_MODE_MISMATCH",
            "explanation": "The lease mode does not match the requested session mode.",
            "mode": mode,
        }
    if expected_hash and str(lease.get("environmentHash") or "") != expected_hash:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_IDENTITY_MISMATCH",
            "explanation": "The active lease environment identity does not match the requested identity.",
            "mode": mode,
        }
    if expected_content and str(lease.get("contentFingerprint") or "") != expected_content:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_CONTENT_IDENTITY_MISMATCH",
            "explanation": "The active lease content fingerprint does not match the typed receipt.",
            "mode": mode,
        }
    expires_at = _timestamp(lease.get("expiresAt"))
    if expires_at is None or expires_at <= dt.datetime.now(dt.timezone.utc):
        return {
            "ok": False,
            "decision": "RESET_REQUIRED",
            "reasonCode": "ENVIRONMENT_LEASE_EXPIRED",
            "explanation": "The environment lease has expired and must be reacquired before verification.",
            "mode": mode,
        }
    if lease.get("ownerVerified") is not True:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "ENVIRONMENT_OWNER_UNVERIFIED",
            "explanation": "The recorded lease owner cannot be verified for this execution.",
            "mode": mode,
        }
    required = {
        str(item).strip()
        for item in environment.get("requiredFields", [])
        if str(item).strip()
    }
    resolved = environment.get("resolvedFields")
    resolved = resolved if isinstance(resolved, dict) else {}
    missing = sorted(field for field in required if not str(resolved.get(field) or "").strip())
    if missing:
        return {
            "ok": False,
            "decision": "BLOCKED",
            "reasonCode": "VERIFICATION_ENVIRONMENT_INCOMPLETE",
            "explanation": "Required dynamic environment identities are missing from the receipt.",
            "missing": missing,
            "mode": mode,
        }
    decision = "REUSE_ELIGIBLE" if environment.get("reuseEligible") is True else "READY"
    reason = "ENVIRONMENT_REUSE_ELIGIBLE" if decision == "REUSE_ELIGIBLE" else "ENVIRONMENT_READY"
    return {
        "ok": True,
        "decision": decision,
        "reasonCode": reason,
        "explanation": (
            "The active environment lease and typed content identity are valid for reuse."
            if decision == "REUSE_ELIGIBLE"
            else "The active environment lease, owner, TTL, content identity, and required fields are valid."
        ),
        "mode": mode,
        "environmentHash": expected_hash,
        "contentFingerprint": expected_content,
    }


def _budget_state(payload: dict[str, Any]) -> dict[str, Any]:
    budget = payload.get("budget")
    if not isinstance(budget, dict):
        return {"state": "NO_BUDGET", "maxDurationSeconds": None}
    raw = budget.get("maxDurationSeconds") or budget.get("budgetSeconds")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = 0
    if seconds <= 0:
        return {"state": "NO_BUDGET", "maxDurationSeconds": None}
    return {
        "state": str(budget.get("state") or "WITHIN_BUDGET").upper(),
        "maxDurationSeconds": int(seconds),
    }


def build_orchestration_plan(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"ok": False, "code": "ORCHESTRATION_PAYLOAD_INVALID"}
    targets = _targets(payload.get("targets", []))
    if not targets:
        return {"ok": False, "code": "VERIFICATION_TARGETS_REQUIRED"}
    selection = harness_verification.select_verifications(payload)
    selected = selection.get("selected") if isinstance(selection, dict) else []
    schedule_payload = dict(payload)
    schedule_payload["targets"] = selected if selected else targets
    verification = harness_verification.schedule_verifications(schedule_payload)
    environment = validate_environment_contract(payload)
    invalidations = build_invalidation_records(payload)
    progress_sessions = payload.get("progressSessions")
    progress = []
    if isinstance(progress_sessions, list):
        progress = [
            harness_efficiency.classify_progress(item)
            for item in progress_sessions
            if isinstance(item, dict)
        ]
    decision_counts = dict(
        sorted(Counter(item.get("decision") for item in verification.get("plan", [])).items())
    )
    ok = bool(verification.get("ok")) and bool(environment.get("ok"))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "ok": ok,
        "code": "ORCHESTRATION_PLAN_READY" if ok else "ORCHESTRATION_PLAN_BLOCKED",
        "changeId": str(payload.get("changeId") or ""),
        "productIdentity": str(payload.get("productIdentity") or ""),
        "frozenIdentity": str(payload.get("frozenIdentity") or ""),
        "selection": selection,
        "invalidations": invalidations,
        "environment": environment,
        "verification": verification,
        "decisionCounts": decision_counts,
        "budget": _budget_state(payload),
        "progress": progress,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="harness_orchestration.py")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--input", required=True)
    plan.add_argument("--out")
    plan.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.command != "plan":
        return 2
    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        result = {"ok": False, "code": "ORCHESTRATION_INPUT_INVALID", "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1
    result = build_orchestration_plan(payload)
    text = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.out:
        output = Path(args.out)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8", newline="\n")
    print(text, end="")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
