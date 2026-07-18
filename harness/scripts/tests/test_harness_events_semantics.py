#!/usr/bin/env python3
"""Event time-semantics tests (cluster B, task 8).

Covers:
- UT-009/RET-21: closed phase duration uses the matching phase.end; late events
  are counted separately (lateEventCount/lateEventSpanMs), never rewriting the
  closed duration.
- UT-010/RET-22: two attempts in one phase yield two invocations with status
  and duration preserved.
- UT-008/RET-20: canonical transaction duration fields come from one reducer.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


events = load_module("harness_events", "harness_events.py")


def ev(ts: str, etype: str, **extra):
    payload = {"timestamp": ts, "type": etype, "phase": "run"}
    payload.update(extra)
    return payload


class ClosedPhaseDurationTests(unittest.TestCase):
    def test_closed_phase_uses_phase_end_not_late_event_ret21(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start"),
            ev("2026-07-18T10:01:00.000+08:00", "command"),
            ev("2026-07-18T10:02:00.000+08:00", "phase.end"),
            # Late decision appended AFTER the phase closed:
            ev("2026-07-18T10:05:00.000+08:00", "decision"),
        ]
        duration = events.phase_duration_ms(bucket)
        self.assertEqual(duration, 120_000, "duration must end at phase.end")

    def test_late_event_stats_ret21(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start"),
            ev("2026-07-18T10:02:00.000+08:00", "phase.end"),
            ev("2026-07-18T10:05:00.000+08:00", "decision"),
            ev("2026-07-18T10:06:30.000+08:00", "issue", severity="info"),
        ]
        stats = events.late_event_stats(bucket)
        self.assertEqual(stats["lateEventCount"], 2)
        self.assertEqual(stats["lateEventSpanMs"], 270_000)

    def test_no_late_events_when_phase_open(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start"),
            ev("2026-07-18T10:01:00.000+08:00", "command"),
        ]
        stats = events.late_event_stats(bucket)
        self.assertEqual(stats["lateEventCount"], 0)
        self.assertEqual(stats["lateEventSpanMs"], 0)


class AttemptInvocationTests(unittest.TestCase):
    def test_two_attempts_both_preserved_ret22(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start"),
            ev("2026-07-18T10:01:00.000+08:00", "phase.end", status="FAIL"),
            ev("2026-07-18T11:00:00.000+08:00", "phase.start"),
            ev("2026-07-18T11:02:30.000+08:00", "phase.end", status="OK"),
        ]
        invocations = events.attempt_invocations(bucket)
        self.assertEqual(len(invocations), 2)
        first, second = invocations
        self.assertEqual(first["attempt"], 1)
        self.assertEqual(first["status"], "FAIL")
        self.assertEqual(first["durationMs"], 60_000)
        self.assertEqual(second["attempt"], 2)
        self.assertEqual(second["status"], "OK")
        self.assertEqual(second["durationMs"], 150_000)

    def test_explicit_attempt_numbers_respected(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start", attempt=3),
            ev("2026-07-18T10:01:00.000+08:00", "phase.end", status="OK", attempt=3),
        ]
        invocations = events.attempt_invocations(bucket)
        self.assertEqual(len(invocations), 1)
        self.assertEqual(invocations[0]["attempt"], 3)


class CanonicalDurationTests(unittest.TestCase):
    def test_transaction_duration_fields_ret20(self) -> None:
        """One reducer produces wall-clock/active fields for all views."""
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start"),
            ev("2026-07-18T10:02:00.000+08:00", "phase.end"),
            ev("2026-07-18T10:03:00.000+08:00", "decision"),  # late
        ]
        canon = events.canonical_phase_timing(bucket)
        self.assertEqual(canon["activeExecutionMs"], 120_000)
        self.assertEqual(canon["wallClockSpanMs"], 180_000)
        self.assertEqual(canon["lateEventCount"], 1)
        self.assertEqual(canon["lateEventSpanMs"], 60_000)


if __name__ == "__main__":
    unittest.main()
