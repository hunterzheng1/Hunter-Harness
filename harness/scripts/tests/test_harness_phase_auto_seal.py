#!/usr/bin/env python3
"""HH-WF-20260730-001: write-path auto-seal for ``phase.start`` (P0).

Problem: ``phase.start`` could be appended while a prior attempt for the same
phase was still open (no ``phase.end``), leaving two open attempts and
polluting timing. Report-side sealing already existed
(``_seal_timestamp_for_attempt`` / ``attempt_invocations``), but the write
path did not auto-seal.

Covers:
- WF-ATTEMPT-01: a second ``phase.start`` auto-seals the still-open prior
  attempt (``phase.auto_sealed``) so only the newest attempt stays open.
- Interrupt/recovery markers recorded while an attempt was open let the
  auto-seal infer a better reason than the ``superseded`` default.
- ``split_phase_attempts`` / ``attempt_invocations``: an auto-sealed attempt
  is closed but never ``activeEligible`` (recovered time must not count as
  active execution).
- ``canonical_phase_timing``: ``recoveredMs`` stays disjoint from
  ``activeExecutionMs``.
- ``harness_gate.append_phase_event`` shares the same guarantee as the CLI.
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


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = events.main(argv)
    return code, out.getvalue(), err.getvalue()


class EventTypeRegistrationTests(unittest.TestCase):
    def test_phase_auto_sealed_is_a_registered_terminal_event_type(self) -> None:
        self.assertIn("phase.auto_sealed", events.EVENT_TYPES)
        self.assertIn("phase.auto_sealed", events.TERMINAL_PHASE_EVENT_TYPES)

    def test_reason_enum_enforced_for_auto_sealed(self) -> None:
        bad = argparse.Namespace(type="phase.auto_sealed", reason="not-a-real-reason")
        result = events.validate_append_event(bad)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "EVENT_REASON_INVALID")

        for reason in sorted(events._AUTO_SEAL_REASONS):
            good = argparse.Namespace(type="phase.auto_sealed", reason=reason)
            self.assertIsNone(events.validate_append_event(good), msg=reason)

    def test_auto_sealed_requires_reason(self) -> None:
        missing = argparse.Namespace(type="phase.auto_sealed", reason=None)
        result = events.validate_append_event(missing)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "EVENT_REQUIRED_FIELD")

    def test_auto_sealed_rejects_disallowed_fields_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            code, out, err = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.auto_sealed",
                "--reason", "superseded", "--command", "should-not-be-allowed",
            ])
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
            self.assertIn("EVENT_FIELD_NOT_ALLOWED", err)


class WriteAppendAutoSealTests(unittest.TestCase):
    """WF-ATTEMPT-01: cmd_append auto-seals an open attempt on a new phase.start."""

    def test_second_phase_start_auto_seals_first_open_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)

            code1, out1, err1 = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "1",
            ])
            self.assertEqual(code1, 0, err1)
            self.assertEqual(json.loads(out1).get("autoSealed"), [])

            code2, out2, err2 = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "2",
            ])
            self.assertEqual(code2, 0, err2)
            payload2 = json.loads(out2)
            sealed = payload2.get("autoSealed")
            self.assertEqual(len(sealed), 1)
            self.assertEqual(sealed[0]["type"], "phase.auto_sealed")
            self.assertEqual(sealed[0]["phase"], "run")
            self.assertEqual(sealed[0]["attempt"], 1)
            self.assertEqual(sealed[0]["reason"], "superseded")
            self.assertEqual(sealed[0]["status"], "RECOVERED")
            self.assertTrue(payload2.get("rendered"))

            written = events.load_events(events.events_path(change_dir))
            self.assertEqual(
                [(e.get("attempt"), e.get("type")) for e in written],
                [(1, "phase.start"), (1, "phase.auto_sealed"), (2, "phase.start")],
            )

            attempts = events.split_phase_attempts(
                [e for e in written if e.get("phase") == "run"]
            )
            self.assertEqual(len(attempts), 2)
            self.assertEqual(attempts[0]["events"][-1]["type"], "phase.auto_sealed")
            self.assertEqual(attempts[0]["warnings"], [])

            # Only the newest attempt remains open after the auto-seal.
            open_attempts = events.open_attempts_for_phase(written, "run")
            self.assertEqual(len(open_attempts), 1)
            self.assertEqual(open_attempts[0]["attempt"], 2)

    def test_open_attempt_with_recovery_marker_infers_executor_lost_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            code0, _, err0 = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "1",
            ])
            self.assertEqual(code0, 0, err0)

            # Simulate a recovery marker recorded while attempt 1 was still open
            # (a foreign/legacy event type, appended directly like other
            # report-side sealing fixtures do for _seal_timestamp_for_attempt).
            recovery_event = {
                "schema_version": 3,
                "id": "evt-recovery-1",
                "timestamp": events.now_iso(),
                "phase": "run",
                "type": "attempt.recovery",
                "attempt": 1,
                "note": "",
            }
            events.atomic_append_line(
                events.events_path(change_dir),
                json.dumps(recovery_event, ensure_ascii=False),
            )

            code2, out2, err2 = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "2",
            ])
            self.assertEqual(code2, 0, err2)
            sealed = json.loads(out2)["autoSealed"]
            self.assertEqual(len(sealed), 1)
            self.assertEqual(sealed[0]["reason"], "executor_lost")

    def test_open_attempt_with_external_wait_infers_external_wait_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "1",
            ])
            wait_event = {
                "schema_version": 3,
                "id": "evt-wait-1",
                "timestamp": events.now_iso(),
                "phase": "run",
                "type": "external.wait",
                "attempt": 1,
                "note": "",
            }
            events.atomic_append_line(
                events.events_path(change_dir),
                json.dumps(wait_event, ensure_ascii=False),
            )
            code, out, err = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "2",
            ])
            self.assertEqual(code, 0, err)
            sealed = json.loads(out)["autoSealed"]
            self.assertEqual(sealed[0]["reason"], "external_wait")

    def test_stale_phase_end_for_already_auto_sealed_attempt_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "1",
            ])
            run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "2",
            ])
            code, out, err = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.end", "--attempt", "1",
                "--status", "OK",
            ])
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
            self.assertIn("PHASE_ALREADY_CLOSED", err)

    def test_unrelated_phase_is_not_affected_by_open_attempt_elsewhere(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start",
            ])
            code, out, err = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "test", "--type", "phase.start",
            ])
            self.assertEqual(code, 0, err)
            self.assertEqual(json.loads(out).get("autoSealed"), [])
            written = events.load_events(events.events_path(change_dir))
            self.assertEqual(
                [e.get("type") for e in written], ["phase.start", "phase.start"]
            )

    def test_closed_attempt_is_not_resealed_by_next_start(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "1",
            ])
            run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.end", "--attempt", "1",
                "--status", "OK",
            ])
            code, out, err = run_cli([
                "append", "--change-dir", str(change_dir), "--json",
                "--phase", "run", "--type", "phase.start", "--attempt", "2",
            ])
            self.assertEqual(code, 0, err)
            self.assertEqual(json.loads(out).get("autoSealed"), [])


class TimingReducerTests(unittest.TestCase):
    """split_phase_attempts / attempt_invocations / canonical_phase_timing."""

    def test_split_phase_attempts_closes_on_auto_sealed(self) -> None:
        bucket = [
            ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-30T10:05:00+08:00",
                "phase.auto_sealed",
                attempt=1,
                status="RECOVERED",
                reason="superseded",
            ),
            ev("2026-07-30T10:05:00+08:00", "phase.start", attempt=2),
            ev("2026-07-30T10:10:00+08:00", "phase.end", attempt=2, status="OK"),
        ]
        attempts = events.split_phase_attempts(bucket)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["events"][-1]["type"], "phase.auto_sealed")
        self.assertEqual(attempts[0]["warnings"], [])
        self.assertEqual(attempts[1]["events"][-1]["type"], "phase.end")

    def test_late_event_after_auto_seal_is_flagged_like_after_phase_end(self) -> None:
        bucket = [
            ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-30T10:05:00+08:00",
                "phase.auto_sealed",
                attempt=1,
                status="RECOVERED",
                reason="superseded",
            ),
            ev("2026-07-30T10:06:00+08:00", "decision", attempt=1),
        ]
        attempts = events.split_phase_attempts(bucket)
        self.assertEqual(len(attempts), 1)
        self.assertIn("event recorded after phase.end", attempts[0]["warnings"])

    def test_attempt_invocations_recovered_is_closed_but_not_active_eligible(self) -> None:
        bucket = [
            ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-30T10:05:00+08:00",
                "phase.auto_sealed",
                attempt=1,
                status="RECOVERED",
                reason="superseded",
            ),
            ev("2026-07-30T10:05:00+08:00", "phase.start", attempt=2),
            ev("2026-07-30T10:08:00+08:00", "phase.end", attempt=2, status="OK"),
        ]
        invocations = events.attempt_invocations(bucket)
        self.assertEqual(len(invocations), 2)
        first, second = invocations
        self.assertEqual(first["terminalStatus"], "RECOVERED")
        self.assertEqual(first["durationMs"], 300_000)
        self.assertFalse(first["activeEligible"])
        self.assertTrue(first["closedByAutoSeal"])
        self.assertFalse(first["sealedIncomplete"])
        self.assertTrue(second["activeEligible"])
        self.assertFalse(second["closedByAutoSeal"])

    def test_canonical_timing_separates_recovered_from_active(self) -> None:
        bucket = [
            ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-30T10:05:00+08:00",
                "phase.auto_sealed",
                attempt=1,
                status="RECOVERED",
                reason="superseded",
            ),
            ev("2026-07-30T10:05:00+08:00", "phase.start", attempt=2),
            ev("2026-07-30T10:08:00+08:00", "phase.end", attempt=2, status="OK"),
        ]
        timing = events.canonical_phase_timing(bucket)
        self.assertEqual(timing["activeExecutionMs"], 180_000)
        self.assertEqual(timing["recoveredMs"], 300_000)
        self.assertEqual(timing["unclosedAttemptCount"], 0)

    def test_canonical_timing_recovered_ms_zero_when_nothing_recovered(self) -> None:
        bucket = [
            ev("2026-07-30T10:00:00+08:00", "phase.start"),
            ev("2026-07-30T10:02:00+08:00", "phase.end", status="OK"),
        ]
        timing = events.canonical_phase_timing(bucket)
        self.assertEqual(timing["activeExecutionMs"], 120_000)
        self.assertEqual(timing["recoveredMs"], 0)

    def test_phase_end_already_recorded_treats_auto_sealed_as_terminal(self) -> None:
        existing = [
            ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1),
            ev(
                "2026-07-30T10:05:00+08:00",
                "phase.auto_sealed",
                attempt=1,
                status="RECOVERED",
                reason="superseded",
            ),
        ]
        candidate = {"phase": "run", "attempt": 1, "type": "phase.end"}
        self.assertTrue(events.phase_end_already_recorded(existing, candidate))


class SealHelperUnitTests(unittest.TestCase):
    """seal_open_phase_attempts / open_attempts_for_phase / infer_auto_seal_reason."""

    def test_seal_open_phase_attempts_builds_expected_event_with_provenance(self) -> None:
        existing = [
            ev(
                "2026-07-30T10:00:00+08:00",
                "phase.start",
                attempt=1,
                run_id="run-x",
                executor_tool="codex",
            ),
        ]
        sealed = events.seal_open_phase_attempts(
            existing, phase="run", seal_reason="user_wait"
        )
        self.assertEqual(len(sealed), 1)
        event = sealed[0]
        self.assertEqual(event["type"], "phase.auto_sealed")
        self.assertEqual(event["phase"], "run")
        self.assertEqual(event["attempt"], 1)
        self.assertEqual(event["reason"], "user_wait")
        self.assertEqual(event["status"], "RECOVERED")
        self.assertEqual(event["run_id"], "run-x")
        self.assertEqual(event["executor_tool"], "codex")
        self.assertEqual(event["schema_version"], events.SCHEMA_VERSION)

    def test_seal_open_phase_attempts_noop_when_nothing_open(self) -> None:
        existing = [
            ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1),
            ev("2026-07-30T10:05:00+08:00", "phase.end", attempt=1, status="OK"),
        ]
        self.assertEqual(events.seal_open_phase_attempts(existing, phase="run"), [])

    def test_seal_open_phase_attempts_noop_for_unstarted_phase(self) -> None:
        self.assertEqual(events.seal_open_phase_attempts([], phase="run"), [])

    def test_seal_open_phase_attempts_clamps_unknown_reason(self) -> None:
        existing = [ev("2026-07-30T10:00:00+08:00", "phase.start", attempt=1)]
        sealed = events.seal_open_phase_attempts(
            existing, phase="run", seal_reason="totally-bogus"
        )
        self.assertEqual(sealed[0]["reason"], "unknown")

    def test_infer_auto_seal_reason_prefers_wait_over_recovery(self) -> None:
        attempt_events = [
            {"type": "phase.start"},
            {"type": "user.wait"},
            {"type": "attempt.recovery"},
        ]
        self.assertEqual(events.infer_auto_seal_reason(attempt_events), "user_wait")

    def test_infer_auto_seal_reason_defaults_to_superseded(self) -> None:
        attempt_events = [{"type": "phase.start"}, {"type": "command"}]
        self.assertEqual(events.infer_auto_seal_reason(attempt_events), "superseded")


class GateAutoSealTests(unittest.TestCase):
    """harness_gate.append_phase_event shares the write-path auto-seal guarantee."""

    def test_append_phase_event_auto_seals_on_new_start(self) -> None:
        gate = load_module("harness_gate", "harness_gate.py")
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            first = gate.append_phase_event(
                change_dir, phase="review", type_="phase.start", run_id="run-a"
            )
            self.assertEqual(first.get("autoSealed"), [])

            second = gate.append_phase_event(
                change_dir, phase="review", type_="phase.start", run_id="run-b"
            )
            sealed = second.get("autoSealed")
            self.assertEqual(len(sealed), 1)
            self.assertEqual(sealed[0]["type"], "phase.auto_sealed")
            self.assertEqual(sealed[0]["reason"], "superseded")
            self.assertTrue(second.get("rendered"))

            written = events.load_events(events.events_path(change_dir))
            self.assertEqual(
                [e.get("type") for e in written],
                ["phase.start", "phase.auto_sealed", "phase.start"],
            )


if __name__ == "__main__":
    unittest.main()
