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


if __name__ == "__main__":
    unittest.main()
