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

import argparse
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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

    def test_final_state_comes_from_latest_attempt(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-18T10:01:00.000+08:00",
                "phase.end",
                status="FAIL",
                attempt=1,
            ),
            ev("2026-07-18T11:00:00.000+08:00", "phase.start", attempt=2),
            ev(
                "2026-07-18T11:02:30.000+08:00",
                "phase.end",
                status="OK",
                attempt=2,
            ),
        ]
        self.assertEqual(
            events.phase_final_state(bucket),
            {
                "attempt": 2,
                "status": "OK",
                "durationMs": 150_000,
                "closed": True,
            },
        )

    def test_duplicate_phase_end_for_same_attempt_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            common = [
                "append",
                "--change-dir",
                str(change_dir),
                "--phase",
                "run",
                "--attempt",
                "1",
                "--json",
            ]
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(
                    events.main([*common, "--type", "phase.start"]),
                    0,
                )
                self.assertEqual(
                    events.main(
                        [*common, "--type", "phase.end", "--status", "OK"]
                    ),
                    0,
                )
                duplicate_code = events.main(
                    [*common, "--type", "phase.end", "--status", "OK"]
                )
            self.assertNotEqual(duplicate_code, 0)
            self.assertIn("PHASE_ALREADY_CLOSED", stderr.getvalue())
            written = events.load_events(events.events_path(change_dir))
            self.assertEqual(
                sum(item.get("type") == "phase.end" for item in written),
                1,
            )


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

    def test_active_time_sums_attempts_and_late_starts_after_final_end(self) -> None:
        bucket = [
            ev("2026-07-18T10:00:00.000+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-18T10:01:00.000+08:00",
                "phase.end",
                status="FAIL",
                attempt=1,
            ),
            ev("2026-07-18T11:00:00.000+08:00", "phase.start", attempt=2),
            ev(
                "2026-07-18T11:02:00.000+08:00",
                "phase.end",
                status="OK",
                attempt=2,
            ),
            ev("2026-07-18T11:03:00.000+08:00", "decision"),
        ]
        canon = events.canonical_phase_timing(bucket)
        self.assertEqual(canon["activeExecutionMs"], 180_000)
        self.assertEqual(canon["wallClockSpanMs"], 3_780_000)
        self.assertEqual(canon["lateEventCount"], 1)
        self.assertEqual(canon["lateEventSpanMs"], 60_000)


class AppendOnlyProjectionTests(unittest.TestCase):
    def test_append_correction_validates_target_before_mutating_stream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(
                    events.main(
                        [
                            "append",
                            "--change-dir",
                            str(change_dir),
                            "--phase",
                            "run",
                            "--type",
                            "verification",
                            "--name",
                            "unit",
                            "--status",
                            "FAIL",
                            "--json",
                        ]
                    ),
                    0,
                )
            source_id = json.loads(stdout.getvalue())["event"]["id"]
            correction_args = [
                "append",
                "--change-dir",
                str(change_dir),
                "--phase",
                "run",
                "--type",
                "correction",
                "--target-event-id",
                source_id,
                "--target-field",
                "status",
                "--old-value-hash",
                events.canonical_value_hash("FAIL"),
                "--new-value-json",
                '"OK"',
                "--reason",
                "rerun passed",
                "--json",
            ]
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(events.main(correction_args), 0)

            path = events.events_path(change_dir)
            before_invalid = path.read_bytes()
            invalid_args = correction_args.copy()
            invalid_args[invalid_args.index(source_id)] = "evt-missing"
            invalid_stderr = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(invalid_stderr):
                invalid_code = events.main(invalid_args)

            self.assertNotEqual(invalid_code, 0)
            self.assertIn("CORRECTION_TARGET_NOT_FOUND", invalid_stderr.getvalue())
            self.assertEqual(path.read_bytes(), before_invalid)

    def test_correction_projects_new_value_without_mutating_history(self) -> None:
        source = ev(
            "2026-07-18T10:00:00.000+08:00",
            "verification",
            id="evt-source",
            name="unit",
            status="FAIL",
        )
        correction = ev(
            "2026-07-18T10:01:00.000+08:00",
            "correction",
            id="evt-correction",
            target_event_id="evt-source",
            target_field="status",
            old_value_hash=events.canonical_value_hash("FAIL"),
            new_value="OK",
            reason="rerun passed",
        )

        projected = events.apply_event_corrections([source, correction])

        self.assertEqual(source["status"], "FAIL")
        self.assertEqual(len(projected), 1)
        self.assertEqual(projected[0]["status"], "OK")
        rendered = events.render_execution_log([source, correction])
        self.assertIn("verification: unit", rendered)
        self.assertIn("correction: evt-source.status", rendered)

    def test_correction_rejects_stale_old_value_hash(self) -> None:
        source = ev(
            "2026-07-18T10:00:00.000+08:00",
            "verification",
            id="evt-source",
            name="unit",
            status="FAIL",
        )
        correction = ev(
            "2026-07-18T10:01:00.000+08:00",
            "correction",
            id="evt-correction",
            target_event_id="evt-source",
            target_field="status",
            old_value_hash=events.canonical_value_hash("UNKNOWN"),
            new_value="OK",
            reason="stale writer",
        )

        with self.assertRaisesRegex(ValueError, "CORRECTION_OLD_VALUE_MISMATCH"):
            events.apply_event_corrections([source, correction])

    def test_issue_resolution_removes_only_the_target_from_current_risks(self) -> None:
        issue_a = ev(
            "2026-07-18T10:00:00.000+08:00",
            "issue",
            id="evt-issue-a",
            issue_id="risk-a",
            code="A",
            severity="warning",
            message="first risk",
        )
        issue_b = ev(
            "2026-07-18T10:01:00.000+08:00",
            "issue",
            id="evt-issue-b",
            issue_id="risk-b",
            code="B",
            severity="error",
            message="second risk",
        )
        resolved = ev(
            "2026-07-18T10:02:00.000+08:00",
            "issue.resolve",
            id="evt-resolve-a",
            issue_id="risk-a",
            reason="fixed by rerun",
        )

        current = events.current_issues([issue_a, issue_b, resolved])

        self.assertEqual([item["issue_id"] for item in current], ["risk-b"])

    def test_later_successful_attempt_closes_matching_attempt_issues(self) -> None:
        stream = [
            ev(
                "2026-07-18T10:00:00.000+08:00",
                "phase.start",
                id="evt-start-1",
                attempt=1,
            ),
            ev(
                "2026-07-18T10:01:00.000+08:00",
                "issue",
                id="evt-issue-1",
                issue_id="risk-attempt",
                code="TEST_FAIL",
                severity="error",
                message="first attempt failed",
                attempt=1,
            ),
            ev(
                "2026-07-18T10:02:00.000+08:00",
                "phase.end",
                id="evt-end-1",
                status="FAIL",
                attempt=1,
            ),
            ev(
                "2026-07-18T11:00:00.000+08:00",
                "phase.start",
                id="evt-start-2",
                attempt=2,
            ),
            ev(
                "2026-07-18T11:02:00.000+08:00",
                "phase.end",
                id="evt-end-2",
                status="OK",
                attempt=2,
                issue_id="risk-attempt",
            ),
        ]

        self.assertEqual(events.current_issues(stream), [])

    def test_later_successful_attempt_preserves_unrelated_issues(self) -> None:
        stream = [
            ev(
                "2026-07-18T10:00:00.000+08:00",
                "issue",
                id="evt-issue-a",
                issue_id="risk-a",
                code="A",
                severity="error",
                message="first risk",
                attempt=1,
            ),
            ev(
                "2026-07-18T10:01:00.000+08:00",
                "issue",
                id="evt-issue-b",
                issue_id="risk-b",
                code="B",
                severity="warning",
                message="unrelated risk",
                attempt=1,
            ),
            ev(
                "2026-07-18T11:00:00.000+08:00",
                "phase.end",
                id="evt-end-2",
                status="OK",
                attempt=2,
                issue_id="risk-a",
            ),
        ]

        current = events.current_issues(stream)

        self.assertEqual([item["issue_id"] for item in current], ["risk-b"])

    def test_issue_identity_falls_back_to_code_and_scope_before_event_id(self) -> None:
        issue = ev(
            "2026-07-18T10:00:00.000+08:00",
            "issue",
            id="evt-random",
            code="BUILD_FAIL",
            scope="packages/core",
            severity="error",
            message="compile failed",
        )
        resolved = ev(
            "2026-07-18T10:01:00.000+08:00",
            "issue.resolve",
            id="evt-resolve",
            issue_id="code:BUILD_FAIL|scope:packages/core",
            reason="fixed",
        )

        self.assertEqual(events.current_issues([issue, resolved]), [])

    def test_successful_phase_end_accepts_explicit_issue_identity(self) -> None:
        args = argparse.Namespace(type="phase.end", status="OK", issue_id="risk-a")

        self.assertIsNone(events.validate_append_event(args))


if __name__ == "__main__":
    unittest.main()
