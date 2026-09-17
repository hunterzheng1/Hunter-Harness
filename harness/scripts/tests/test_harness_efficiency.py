import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_efficiency.py"


def load_module():
    spec = importlib.util.spec_from_file_location("harness_efficiency_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EfficiencySummaryTests(unittest.TestCase):
    def test_summary_separates_active_wait_and_wall_time_and_failure_classes(self) -> None:
        self.assertTrue(SCRIPT.is_file(), "harness_efficiency.py must be implemented")
        module = load_module()
        summary = module.build_efficiency_summary(
            run_sessions=[
                {
                    "sessionId": "run-1",
                    "status": "INCOMPLETE",
                    "reasonCode": "LAUNCHER_FAILED",
                    "stage": "prepare",
                    "createdAt": "2026-07-31T10:00:00.000+08:00",
                    "endedAt": "2026-07-31T10:00:00.120+08:00",
                    "wallClockMs": 120,
                    "activeTimeMs": 0,
                    "resourceWaitMs": 20,
                    "commandHash": "sha256:a",
                    "productIdentity": "sha256:p1",
                    "testProcessStarted": False,
                },
                {
                    "sessionId": "run-2",
                    "status": "OK",
                    "reasonCode": "CHILD_EXIT_ZERO",
                    "stage": "execute",
                    "createdAt": "2026-07-31T10:00:00.120+08:00",
                    "endedAt": "2026-07-31T10:00:00.720+08:00",
                    "wallClockMs": 600,
                    "activeTimeMs": 500,
                    "resourceWaitMs": 50,
                    "commandHash": "sha256:a",
                    "productIdentity": "sha256:p1",
                    "resultDigest": "sha256:r1",
                    "testProcessStarted": True,
                },
            ],
            environment_receipts=[
                {"action": "prepare"},
                {"action": "reuse"},
                {"action": "reset", "operationEvidence": {"status": "OK"}},
                {"action": "cleanup", "operationEvidence": {"status": "OK"}},
            ],
            invalidations=[{"reasonCode": "PRODUCT_INPUT_CHANGED"}],
        )
        self.assertEqual(summary["timing"]["wallClockMs"], 720)
        self.assertEqual(summary["timing"]["activeTimeMs"], 500)
        self.assertEqual(summary["timing"]["resourceWaitMs"], 70)
        self.assertEqual(
            summary["timingByStage"]["prepare"],
            {
                "wallClockMs": 120,
                "activeTimeMs": 0,
                "resourceWaitMs": 20,
                "attempts": 1,
            },
        )
        self.assertEqual(summary["timingByStage"]["execute"]["wallClockMs"], 600)
        self.assertEqual(summary["failureClasses"]["launcher"], 1)
        self.assertEqual(summary["failureClasses"]["test"], 0)
        self.assertEqual(summary["executionAttempts"], 2)
        self.assertEqual(summary["verificationAttempts"], 1)
        self.assertEqual(summary["launcherAttempts"], 1)
        self.assertEqual(summary["productIdentityCount"], 1)
        self.assertEqual(
            summary["environment"],
            {"prepare": 1, "reuse": 1, "reset": 1, "cleanup": 1},
        )
        self.assertEqual(summary["invalidationReasons"]["PRODUCT_INPUT_CHANGED"], 1)
        self.assertEqual(summary["repeatedCommandsWithoutNewEvidence"], 0)

    def test_review_carryover_counts_are_summed_from_invalidation_receipts(self) -> None:
        """WI-3.1 步骤⑤：fixback 回执的 reviewFindings 计数进 efficiency 汇总。"""
        module = load_module()
        summary = module.build_efficiency_summary(
            run_sessions=[],
            environment_receipts=[],
            invalidations=[
                {
                    "reasonCode": "FIXBACK_AFFECTED_INPUT_CHANGED",
                    "reviewFindings": {
                        "carriedOver": 3,
                        "invalidated": 2,
                        "expandedSignals": ["shared-state"],
                    },
                },
                {
                    "reasonCode": "FIXBACK_AFFECTED_INPUT_CHANGED",
                    "reviewFindings": {"carriedOver": 1, "invalidated": 0},
                },
                {"reasonCode": "PRODUCT_INPUT_CHANGED"},
            ],
        )
        self.assertEqual(summary["reviewFindings"]["carriedOver"], 4)
        self.assertEqual(summary["reviewFindings"]["invalidated"], 2)

    def test_wall_clock_unions_overlapping_sessions_instead_of_summing(self) -> None:
        module = load_module()
        summary = module.build_efficiency_summary(
            run_sessions=[
                {
                    "createdAt": "2026-07-31T10:00:00Z",
                    "endedAt": "2026-07-31T10:00:10Z",
                    "wallClockMs": 10000,
                },
                {
                    "createdAt": "2026-07-31T10:00:05Z",
                    "endedAt": "2026-07-31T10:00:15Z",
                    "wallClockMs": 10000,
                },
            ],
            environment_receipts=[],
            invalidations=[],
        )

        self.assertEqual(summary["timing"]["wallClockMs"], 15000)

    def test_progress_view_never_invents_eta_without_history(self) -> None:
        self.assertTrue(SCRIPT.is_file(), "harness_efficiency.py must be implemented")
        module = load_module()
        view = module.compact_progress_view(
            {
                "verification": "performance",
                "stage": "execute",
                "completedItems": 1,
                "plannedItems": 2,
                "lastHeartbeatAt": "2026-07-31T10:00:00+08:00",
                "expectedDurationSeconds": 900,
                "resourceLocks": ["database:test-stack:write"],
            },
            historical_durations=[],
        )
        self.assertEqual(view["eta"], "INSUFFICIENT_HISTORY")
        self.assertEqual(view["progress"], "1/2")
        self.assertEqual(view["resourceWait"], ["database:test-stack:write"])

    def test_summary_contains_progress_and_budget_counts(self) -> None:
        module = load_module()
        summary = module.build_efficiency_summary(
            run_sessions=[
                {
                    "status": "RUNNING",
                    "progressState": "SLOW_PROGRESSING",
                    "budgetState": "OVER_BUDGET",
                },
                {
                    "status": "INCOMPLETE",
                    "progressState": "HEARTBEAT_LOST",
                    "budgetState": "OVER_BUDGET",
                },
            ],
            environment_receipts=[],
            invalidations=[],
        )
        self.assertEqual(summary["progressStates"]["SLOW_PROGRESSING"], 1)
        self.assertEqual(summary["progressStates"]["HEARTBEAT_LOST"], 1)
        self.assertEqual(summary["budgetStates"]["OVER_BUDGET"], 2)


class ProgressClassificationTests(unittest.TestCase):
    def test_resource_wait_state(self) -> None:
        module = load_module()
        result = module.classify_progress(
            {
                "status": "RUNNING",
                "resourceLocks": ["database:test-stack:write"],
                "resourceWaitMs": 20,
                "startedAt": "2026-07-31T10:00:00+00:00",
                "lastHeartbeatAt": "2026-07-31T10:00:01+00:00",
                "expectedDurationSeconds": 60,
            },
            now="2026-07-31T10:00:02+00:00",
        )
        self.assertEqual(result["progressState"], "RESOURCE_WAIT")

    def test_slow_progressing_state(self) -> None:
        module = load_module()
        result = module.classify_progress(
            {
                "status": "RUNNING",
                "startedAt": "2026-07-31T10:00:00+00:00",
                "lastHeartbeatAt": "2026-07-31T10:02:00+00:00",
                "lastOutputAt": "2026-07-31T10:02:00+00:00",
                "expectedDurationSeconds": 60,
                "timeoutSeconds": 300,
                "completedItems": 1,
                "plannedItems": 2,
            },
            now="2026-07-31T10:02:00+00:00",
        )
        self.assertEqual(result["progressState"], "SLOW_PROGRESSING")
        self.assertEqual(result["budgetState"], "OVER_BUDGET")

    def test_no_output_heartbeat_loss_and_timeout(self) -> None:
        module = load_module()
        no_output = module.classify_progress(
            {
                "status": "RUNNING",
                "startedAt": "2026-07-31T10:00:00+00:00",
                "lastHeartbeatAt": "2026-07-31T10:00:59+00:00",
                "lastOutputAt": "2026-07-31T10:00:59+00:00",
                "heartbeatGraceSeconds": 30,
                "timeoutSeconds": 300,
            },
            now="2026-07-31T10:02:00+00:00",
        )
        self.assertEqual(no_output["progressState"], "NO_OUTPUT_PROCESS_ACTIVE")
        heartbeat_lost = module.classify_progress(
            {
                "status": "RUNNING",
                "startedAt": "2026-07-31T10:00:00+00:00",
                "lastHeartbeatAt": "2026-07-31T10:00:00+00:00",
                "heartbeatGraceSeconds": 30,
                "timeoutSeconds": 300,
            },
            now="2026-07-31T10:02:00+00:00",
        )
        self.assertEqual(heartbeat_lost["progressState"], "HEARTBEAT_LOST")
        timeout = module.classify_progress(
            {
                "status": "RUNNING",
                "startedAt": "2026-07-31T10:00:00+00:00",
                "lastHeartbeatAt": "2026-07-31T10:04:59+00:00",
                "lastOutputAt": "2026-07-31T10:04:59+00:00",
                "heartbeatGraceSeconds": 30,
                "timeoutSeconds": 300,
            },
            now="2026-07-31T10:05:00+00:00",
        )
        self.assertEqual(timeout["progressState"], "TIMEOUT")


class EfficiencyPanelTests(unittest.TestCase):
    """17-M1：跨 change 决策级度量面板（collect_efficiency_panel）。"""

    def setUp(self) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.changes_root = Path(self._tmp.name) / "changes"
        self.changes_root.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_session(self, change: str, session_id: str, doc: dict) -> None:
        import json

        session_dir = (
            self.changes_root / change / "runtime" / "run-sessions" / session_id
        )
        session_dir.mkdir(parents=True)
        (session_dir / "session.json").write_text(
            json.dumps(doc), encoding="utf-8"
        )

    def _write_findings(self, change: str, findings: list) -> None:
        import json

        review_dir = self.changes_root / change / "reports" / "review"
        review_dir.mkdir(parents=True)
        (review_dir / "review-findings.json").write_text(
            json.dumps({"schemaVersion": 3, "runId": "r1", "findings": findings}),
            encoding="utf-8",
        )

    def _seed_two_changes(self) -> None:
        self._write_session(
            "alpha",
            "run-1",
            {
                "sessionId": "run-1",
                "stage": "verify",
                "status": "OK",
                "createdAt": "2026-09-01T10:00:00Z",
                "endedAt": "2026-09-01T10:00:30Z",
                "managedByHarness": True,
            },
        )
        self._write_findings(
            "alpha",
            [
                {"id": "F-1", "severity": "RED"},
                {"id": "F-2", "severity": "YELLOW"},
            ],
        )
        self._write_session(
            "beta",
            "run-1",
            {
                "sessionId": "run-1",
                "stage": "verify",
                "status": "FAIL",
                "createdAt": "2026-09-01T11:00:00Z",
                "endedAt": "2026-09-01T11:01:00Z",
                "managedByHarness": False,
            },
        )
        self._write_session(
            "beta",
            "run-2",
            {
                "sessionId": "run-2",
                "stage": "verify",
                "status": "OK",
                "createdAt": "2026-09-01T11:02:00Z",
                "endedAt": "2026-09-01T11:03:00Z",
                "managedByHarness": True,
            },
        )

    def test_panel_aggregates_cycle_first_pass_findings_and_automation(self) -> None:
        module = load_module()
        self._seed_two_changes()
        panel = module.collect_efficiency_panel(
            self.changes_root, now_iso="2026-09-18T00:00:00Z"
        )
        self.assertEqual(panel["schemaVersion"], module.PANEL_SCHEMA_VERSION)
        self.assertEqual(panel["generatedAt"], "2026-09-18T00:00:00Z")
        self.assertEqual(
            panel["changes"],
            {"discovered": 2, "withSessions": 2, "withReviewFindings": 1},
        )
        cycle = panel["cycleTime"]
        self.assertTrue(cycle["available"])
        self.assertEqual(cycle["changeCount"], 2)
        self.assertEqual(cycle["minMs"], 30_000)
        self.assertEqual(cycle["maxMs"], 180_000)
        self.assertEqual(cycle["medianMs"], 105_000)
        first_pass = panel["gateFirstPass"]
        self.assertTrue(first_pass["available"])
        self.assertEqual(first_pass["stages"], 2)
        self.assertEqual(first_pass["firstPass"], 1)
        self.assertEqual(first_pass["rate"], 0.5)
        findings = panel["reviewFindings"]
        self.assertTrue(findings["available"])
        self.assertEqual(findings["total"], 2)
        self.assertEqual(findings["perReviewedChange"], 2.0)
        self.assertEqual(findings["bySeverity"], {"RED": 1, "YELLOW": 1})
        automation = panel["automation"]
        self.assertTrue(automation["available"])
        self.assertEqual(automation["executionAttempts"], 3)
        self.assertEqual(automation["managedByHarness"], 2)
        self.assertEqual(automation["manualWrappers"], 1)
        self.assertEqual(automation["managedRatio"], round(2 / 3, 4))

    def test_panel_empty_root_degrades_without_blocking(self) -> None:
        module = load_module()
        panel = module.collect_efficiency_panel(
            self.changes_root, now_iso="2026-09-18T00:00:00Z"
        )
        self.assertEqual(panel["changes"]["discovered"], 0)
        for key in ("cycleTime", "gateFirstPass", "reviewFindings", "automation"):
            self.assertFalse(panel[key]["available"], key)
            self.assertIn("reason", panel[key], key)

    def test_panel_skips_hidden_dirs_and_malformed_findings(self) -> None:
        import json

        module = load_module()
        (self.changes_root / ".archive").mkdir()
        self._write_session(
            "gamma",
            "run-1",
            {
                "sessionId": "run-1",
                "stage": "verify",
                "status": "OK",
                "createdAt": "2026-09-01T09:00:00Z",
                "endedAt": "2026-09-01T09:00:10Z",
                "managedByHarness": True,
            },
        )
        review_dir = self.changes_root / "gamma" / "reports" / "review"
        review_dir.mkdir(parents=True)
        (review_dir / "review-findings.json").write_text("{ not json", encoding="utf-8")
        panel = module.collect_efficiency_panel(
            self.changes_root, now_iso="2026-09-18T00:00:00Z"
        )
        self.assertEqual(panel["changes"]["discovered"], 1)
        self.assertEqual(panel["gateFirstPass"]["rate"], 1.0)
        self.assertFalse(panel["reviewFindings"]["available"])
        self.assertEqual(panel["cycleTime"]["maxMs"], 10_000)

    def test_cli_panel_mode_and_mutual_exclusion(self) -> None:
        import contextlib
        import io

        module = load_module()
        self._seed_two_changes()
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            exit_code = module.main(
                [
                    "--changes-root",
                    str(self.changes_root),
                    "--now",
                    "2026-09-18T00:00:00Z",
                ]
            )
        self.assertEqual(exit_code, 0)
        import json

        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload["schemaVersion"], module.PANEL_SCHEMA_VERSION)
        self.assertEqual(payload["changes"]["discovered"], 2)
        with self.assertRaises(SystemExit):
            module.main([])
        with self.assertRaises(SystemExit):
            module.main(
                [
                    "--change-dir",
                    str(self.changes_root / "alpha"),
                    "--changes-root",
                    str(self.changes_root),
                ]
            )


if __name__ == "__main__":
    unittest.main()
