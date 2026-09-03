#!/usr/bin/env python3
"""Summarize execution efficiency without assigning blame."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path
from statistics import median
from typing import Any, Iterable

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from harness_paths import resolve_state_dir_for_contract


SCHEMA_VERSION = 1
FAILURE_CLASSES = ("launcher", "environment", "test", "external", "unknown")


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


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


def _now_timestamp(value: Any = None) -> dt.datetime:
    return _timestamp(value) or dt.datetime.now(dt.timezone.utc)


def _seconds(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def classify_progress(
    session: dict[str, Any],
    *,
    now: Any = None,
    historical_durations: list[int | float] | None = None,
) -> dict[str, Any]:
    """Classify observable run state without changing execution policy.

    The classifier is intentionally conservative: incomplete clock/heartbeat
    data produces explicit ``INCOMPLETE``/``NO_BUDGET`` facts instead of an
    invented ETA or a guessed failure cause.
    """
    status = str(session.get("status") or "RUNNING").upper()
    terminal = {
        "OK": "COMPLETED",
        "PASS": "COMPLETED",
        "COMPLETED": "COMPLETED",
        "FAIL": "FAILED",
        "FAILED": "FAILED",
        "CANCELLED": "CANCELLED",
        "CANCELED": "CANCELLED",
        "INCOMPLETE": "INCOMPLETE",
    }
    started = _timestamp(session.get("startedAt") or session.get("createdAt"))
    current = _now_timestamp(now)
    elapsed_seconds: float | None = None
    if started is not None:
        elapsed_seconds = max(0.0, (current - started).total_seconds())

    timeout_seconds = _seconds(session.get("timeoutSeconds"))
    expected_seconds = _seconds(
        session.get("expectedDurationSeconds")
        or session.get("estimatedDurationSeconds")
    )
    budget_seconds = _seconds(
        session.get("budgetSeconds")
        or session.get("maxDurationSeconds")
        or expected_seconds
        or timeout_seconds
    )
    if elapsed_seconds is None or budget_seconds is None:
        budget_state = "NO_BUDGET"
    elif elapsed_seconds >= budget_seconds:
        budget_state = "OVER_BUDGET"
    else:
        budget_state = "WITHIN_BUDGET"

    progress_state = terminal.get(status)
    diagnostic_required = False
    heartbeat_grace = _seconds(
        session.get("heartbeatGraceSeconds")
        or session.get("heartbeatTimeoutSeconds")
        or 60
    ) or 60
    heartbeat = _timestamp(session.get("lastHeartbeatAt"))
    output = _timestamp(
        session.get("lastOutputAt") or session.get("lastLogAt")
    )
    heartbeat_gap = (
        max(0.0, (current - heartbeat).total_seconds())
        if heartbeat is not None
        else None
    )
    output_gap = (
        max(0.0, (current - output).total_seconds()) if output is not None else None
    )

    if progress_state is None:
        progress_state = "RUNNING"
        if timeout_seconds is not None and elapsed_seconds is not None and elapsed_seconds >= timeout_seconds:
            progress_state = "TIMEOUT"
        elif output_gap is not None and output_gap > heartbeat_grace:
            progress_state = "NO_OUTPUT_PROCESS_ACTIVE"
        elif heartbeat_gap is None or heartbeat_gap > heartbeat_grace:
            progress_state = "HEARTBEAT_LOST"
        elif _integer(session.get("resourceWaitMs")) > 0 or session.get("resourceWaitActive") is True:
            progress_state = "RESOURCE_WAIT"
        elif expected_seconds is not None and elapsed_seconds is not None and elapsed_seconds > expected_seconds:
            progress_state = "SLOW_PROGRESSING"
        diagnostic_required = progress_state in {
            "TIMEOUT",
            "HEARTBEAT_LOST",
            "NO_OUTPUT_PROCESS_ACTIVE",
        } or budget_state == "OVER_BUDGET"
    elif progress_state not in {"COMPLETED", "FAILED", "CANCELLED"}:
        diagnostic_required = True

    return {
        "progressState": progress_state,
        "budgetState": budget_state,
        "diagnosticRequired": diagnostic_required,
        "elapsedSeconds": int(elapsed_seconds) if elapsed_seconds is not None else None,
        "budgetSeconds": budget_seconds,
        "heartbeatGapSeconds": int(heartbeat_gap) if heartbeat_gap is not None else None,
        "outputGapSeconds": int(output_gap) if output_gap is not None else None,
    }


def _failure_class(session: dict[str, Any]) -> str | None:
    status = str(session.get("status") or "").upper()
    reason = str(session.get("reasonCode") or "").upper()
    if status == "OK":
        return None
    if reason.startswith(("LAUNCHER_", "WORKER_", "LAUNCH_SPEC_")):
        return "launcher"
    if any(
        token in reason
        for token in ("ENVIRONMENT", "DOCKER", "PREFLIGHT", "RESOURCE_WAIT")
    ):
        return "environment"
    if reason in {"EXTERNAL_WINDOW_ABORT", "CLIENT_DISCONNECTED"}:
        return "external"
    if status == "FAIL" or reason == "CHILD_EXIT_NONZERO":
        return "test"
    return "unknown"


def _counts(values: Iterable[str]) -> dict[str, int]:
    return dict(sorted(Counter(values).items()))


def _wall_clock_ms(run_sessions: list[dict[str, Any]]) -> int:
    intervals: list[tuple[dt.datetime, dt.datetime]] = []
    fallback = 0
    for session in run_sessions:
        start_raw = session.get("createdAt") or session.get("startedAt")
        end_raw = session.get("endedAt")
        try:
            start = dt.datetime.fromisoformat(
                str(start_raw).replace("Z", "+00:00")
            )
            end = dt.datetime.fromisoformat(str(end_raw).replace("Z", "+00:00"))
            if start.tzinfo is None:
                start = start.astimezone()
            if end.tzinfo is None:
                end = end.astimezone()
            if end < start:
                raise ValueError("negative interval")
            intervals.append((start.astimezone(dt.timezone.utc), end.astimezone(dt.timezone.utc)))
        except (TypeError, ValueError):
            fallback += _integer(session.get("wallClockMs"))
    merged_ms = 0
    current_start: dt.datetime | None = None
    current_end: dt.datetime | None = None
    for start, end in sorted(intervals):
        if current_start is None or current_end is None:
            current_start, current_end = start, end
            continue
        if start <= current_end:
            current_end = max(current_end, end)
        else:
            merged_ms += int((current_end - current_start).total_seconds() * 1000)
            current_start, current_end = start, end
    if current_start is not None and current_end is not None:
        merged_ms += int((current_end - current_start).total_seconds() * 1000)
    return merged_ms + fallback


def _timing_by_stage(
    run_sessions: list[dict[str, Any]],
) -> dict[str, dict[str, int]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for session in run_sessions:
        stage_timings = session.get("stageTimings")
        if isinstance(stage_timings, list) and stage_timings:
            for item in stage_timings:
                if isinstance(item, dict):
                    stage = str(item.get("stage") or "unknown")
                    grouped.setdefault(stage, []).append(item)
            continue
        stage = str(
            session.get("stage")
            or session.get("verification")
            or "unknown"
        )
        grouped.setdefault(stage, []).append(session)
    return {
        stage: {
            "wallClockMs": _wall_clock_ms(items),
            "activeTimeMs": sum(_integer(item.get("activeTimeMs")) for item in items),
            "resourceWaitMs": sum(
                _integer(item.get("resourceWaitMs")) for item in items
            ),
            "attempts": len(items),
        }
        for stage, items in sorted(grouped.items())
    }


def build_efficiency_summary(
    *,
    run_sessions: list[dict[str, Any]],
    environment_receipts: list[dict[str, Any]],
    invalidations: list[dict[str, Any]],
) -> dict[str, Any]:
    failure_counts = {key: 0 for key in FAILURE_CLASSES}
    progress_states: Counter[str] = Counter()
    budget_states: Counter[str] = Counter()
    slow_stages: Counter[str] = Counter()
    for session in run_sessions:
        classification = _failure_class(session)
        if classification is not None:
            failure_counts[classification] += 1
        progress = str(
            session.get("progressState")
            or classify_progress(session).get("progressState")
            or "INCOMPLETE"
        ).upper()
        budget = str(
            session.get("budgetState")
            or classify_progress(session).get("budgetState")
            or "NO_BUDGET"
        ).upper()
        progress_states[progress] += 1
        budget_states[budget] += 1
        if progress == "SLOW_PROGRESSING":
            slow_stages[str(session.get("stage") or session.get("verification") or "unknown")] += 1
    environment_actions: Counter[str] = Counter()
    for item in environment_receipts:
        action = str(item.get("action") or "").lower()
        if action not in {"prepare", "reuse", "reset", "cleanup"}:
            continue
        if action in {"reset", "cleanup"}:
            evidence = item.get("operationEvidence")
            if not isinstance(evidence, dict) or evidence.get("status") != "OK":
                continue
        environment_actions[action] += 1
    evidence_counts = Counter(
        (
            str(item.get("commandHash")),
            str(item.get("productIdentity")),
            str(item.get("resultDigest")),
        )
        for item in run_sessions
        if str(item.get("commandHash") or "").strip()
        and str(item.get("productIdentity") or "").strip()
        and str(item.get("resultDigest") or "").strip()
        and item.get("testProcessStarted") is True
    )
    product_identities = {
        str(item.get("productIdentity"))
        for item in run_sessions
        if str(item.get("productIdentity") or "").strip()
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "timing": {
            "wallClockMs": _wall_clock_ms(run_sessions),
            "activeTimeMs": sum(
                _integer(item.get("activeTimeMs")) for item in run_sessions
            ),
            "resourceWaitMs": sum(
                _integer(item.get("resourceWaitMs")) for item in run_sessions
            ),
        },
        "timingByStage": _timing_by_stage(run_sessions),
        "executionAttempts": len(run_sessions),
        "verificationAttempts": sum(
            1 for item in run_sessions if item.get("testProcessStarted") is True
        ),
        "launcherAttempts": sum(
            1 for item in run_sessions if item.get("testProcessStarted") is not True
        ),
        "statusCounts": _counts(
            str(item.get("status") or "UNKNOWN").upper()
            for item in run_sessions
        ),
        "failureClasses": failure_counts,
        "progressStates": dict(sorted(progress_states.items())),
        "budgetStates": dict(sorted(budget_states.items())),
        "slowStages": dict(sorted(slow_stages.items())),
        "invalidationReasons": _counts(
            str(item.get("reasonCode") or "UNKNOWN")
            for item in invalidations
        ),
        "environment": {
            key: environment_actions.get(key, 0)
            for key in ("prepare", "reuse", "reset", "cleanup")
        },
        "productIdentityCount": len(product_identities),
        "repeatedCommandsWithoutNewEvidence": sum(
            max(count - 1, 0) for count in evidence_counts.values()
        ),
        "manualWrapperCount": sum(
            1
            for item in run_sessions
            if item.get("managedByHarness") is False
        ),
        "notes": [
            "Metrics separate launcher, environment, test, and external failures.",
            "This summary reports facts and does not assign responsibility.",
        ],
    }


def compact_progress_view(
    session: dict[str, Any],
    *,
    historical_durations: list[int | float],
) -> dict[str, Any]:
    completed = _integer(session.get("completedItems"))
    planned = _integer(session.get("plannedItems"))
    durations = sorted(
        _integer(value) for value in historical_durations if _integer(value) > 0
    )
    eta: str | dict[str, int]
    if len(durations) < 3:
        eta = "INSUFFICIENT_HISTORY"
    else:
        eta = {
            "lowSeconds": durations[0],
            "typicalSeconds": int(median(durations)),
            "highSeconds": durations[-1],
        }
    classification = classify_progress(
        session,
        historical_durations=historical_durations,
    )
    return {
        "verification": session.get("verification"),
        "stage": session.get("stage"),
        "progress": f"{completed}/{planned}" if planned else str(completed),
        "lastHeartbeatAt": session.get("lastHeartbeatAt"),
        "expectedDurationSeconds": session.get("expectedDurationSeconds"),
        "eta": eta,
        "resourceWait": list(session.get("resourceLocks") or []),
        "status": session.get("status", "RUNNING"),
        "progressState": classification["progressState"],
        "budgetState": classification["budgetState"],
        "diagnosticRequired": classification["diagnosticRequired"],
        "elapsedSeconds": classification["elapsedSeconds"],
    }


def _read_objects(paths: list[Path]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for path in paths:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            values.append(value)
        elif isinstance(value, list):
            values.extend(item for item in value if isinstance(item, dict))
    return values


def collect_efficiency_summary(change_dir: Path) -> dict[str, Any]:
    state_root = Path(resolve_state_dir_for_contract(change_dir)).resolve()
    run_sessions = _read_objects(
        sorted((state_root / "runtime" / "run-sessions").glob("*/session.json"))
    )
    environment_receipts = _read_objects(
        sorted((state_root / "runtime" / "environment-receipts").glob("*.json"))
    )
    invalidations = _read_objects(
        sorted((state_root / "runtime" / "invalidations").glob("*.json"))
    )
    return build_efficiency_summary(
        run_sessions=run_sessions,
        environment_receipts=environment_receipts,
        invalidations=invalidations,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="harness_efficiency.py")
    parser.add_argument("summary", nargs="?")
    parser.add_argument("--change-dir", required=True)
    args = parser.parse_args(argv)
    result = collect_efficiency_summary(Path(args.change_dir))
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
