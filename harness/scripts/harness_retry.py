#!/usr/bin/env python3
"""Deterministic retry classifier for remote and deployment side effects."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DECISIONS = {
    "RETRY_ALLOWED_INPUT_CHANGED",
    "WAIT_EXISTING_RUN",
    "BLOCKED_EXTERNAL_PREREQUISITE",
    "NO_NEW_INFORMATION",
    "REOPEN_CANDIDATE",
}


def _same_identity(left: Any, right: Any) -> bool:
    return (
        isinstance(left, dict)
        and isinstance(right, dict)
        and all(
            str(left.get(field) or "") == str(right.get(field) or "")
            for field in (
                "productCommit",
                "productTreeHash",
                "environmentHash",
            )
        )
    )


def classify_retry(
    history: list[dict[str, Any]],
    *,
    candidate_identity: dict[str, Any],
    failure_signature: str,
    input_hash: str,
    external_prerequisite_hash: str | None = None,
    projection_status: str = "verified",
) -> dict[str, Any]:
    """Return a side-effect-safe retry decision from durable facts."""
    matching = [
        item
        for item in history
        if isinstance(item, dict)
        and _same_identity(item.get("candidateIdentity"), candidate_identity)
    ]
    active = next(
        (
            item
            for item in reversed(matching)
            if str(item.get("status") or "").upper()
            in {"QUEUED", "RUNNING", "IN_PROGRESS", "PENDING"}
        ),
        None,
    )
    if active is not None:
        return {
            "ok": True,
            "allowed": False,
            "decision": "WAIT_EXISTING_RUN",
            "message": "an equivalent candidate run is still active",
            "existingRun": active,
        }
    if projection_status.strip().lower() == "degraded":
        return {
            "ok": True,
            "allowed": False,
            "decision": "BLOCKED_EXTERNAL_PREREQUISITE",
            "message": (
                "adapter/config projection is degraded; protocol identity is unknown"
            ),
        }
    latest = matching[-1] if matching else None
    if latest is None:
        return {
            "ok": True,
            "allowed": True,
            "decision": "REOPEN_CANDIDATE",
            "message": "no prior equivalent candidate attempt exists",
        }
    prior_input = str(latest.get("inputHash") or "")
    if prior_input != input_hash:
        return {
            "ok": True,
            "allowed": True,
            "decision": "RETRY_ALLOWED_INPUT_CHANGED",
            "message": "candidate inputs changed since the prior attempt",
            "priorInputHash": prior_input,
            "inputHash": input_hash,
        }
    prior_external = str(latest.get("externalPrerequisiteHash") or "")
    current_external = str(external_prerequisite_hash or "")
    same_failure = (
        str(latest.get("failureSignature") or "") == failure_signature
    )
    if same_failure and prior_external == current_external:
        return {
            "ok": True,
            "allowed": False,
            "decision": "NO_NEW_INFORMATION",
            "message": (
                "same candidate, failure signature, inputs, and external "
                "prerequisites; retry would repeat the same side effect"
            ),
            "priorAttempt": latest,
        }
    if same_failure and prior_external != current_external:
        return {
            "ok": True,
            "allowed": True,
            "decision": "REOPEN_CANDIDATE",
            "message": "external prerequisite identity changed",
        }
    if re_external_failure(failure_signature) and prior_external == current_external:
        return {
            "ok": True,
            "allowed": False,
            "decision": "BLOCKED_EXTERNAL_PREREQUISITE",
            "message": "external prerequisite has not changed",
        }
    return {
        "ok": True,
        "allowed": True,
        "decision": "REOPEN_CANDIDATE",
        "message": "failure signature changed; a new attempt may add information",
    }


def re_external_failure(signature: str) -> bool:
    lowered = signature.lower()
    return any(
        marker in lowered
        for marker in (
            "permission",
            "credential",
            "secret",
            "registry",
            "allowlist",
            "quota",
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="harness_retry.py")
    parser.add_argument("--history", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--failure-signature", required=True)
    parser.add_argument("--input-hash", required=True)
    parser.add_argument("--external-prerequisite-hash")
    parser.add_argument("--projection-status", default="verified")
    args = parser.parse_args(argv)
    history = json.loads(Path(args.history).read_text(encoding="utf-8-sig"))
    candidate = json.loads(Path(args.candidate).read_text(encoding="utf-8-sig"))
    if not isinstance(history, list) or not isinstance(candidate, dict):
        raise ValueError("history must be an array and candidate an object")
    result = classify_retry(
        history,
        candidate_identity=candidate,
        failure_signature=args.failure_signature,
        input_hash=args.input_hash,
        external_prerequisite_hash=args.external_prerequisite_hash,
        projection_status=args.projection_status,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["allowed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
