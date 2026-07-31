import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "harness_verification.py"
SPEC = importlib.util.spec_from_file_location("harness_verification_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
VERIFICATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFICATION)


class VerificationSelectionTest(unittest.TestCase):
    def test_authoritative_target_map_is_normalized_and_never_fails_open(self) -> None:
        result = VERIFICATION.schedule_verifications(
            {
                "productIdentity": "sha256:frozen",
                "frozenIdentity": "sha256:frozen",
                "availableCapabilities": ["node", "npm"],
                "targets": {
                    "unitTestFull": {
                        "commandKey": "unitTestFull",
                        "argvTemplate": ["npm", "run", "check"],
                        "dependsOn": [],
                        "requiredCapabilities": ["node", "npm"],
                        "requiredCoverage": "module",
                        "coverageLevel": "full",
                        "candidate": True,
                        "requiresFrozenIdentity": True,
                        "reusePolicy": "never",
                    }
                },
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["plan"][0]["id"], "unitTestFull")
        self.assertEqual(result["plan"][0]["decision"], "EXECUTE")

        empty = VERIFICATION.schedule_verifications(
            {"productIdentity": "sha256:frozen", "targets": {}}
        )
        self.assertFalse(empty["ok"])
        self.assertEqual(empty["code"], "VERIFICATION_TARGETS_REQUIRED")

    def test_missing_capability_or_insufficient_coverage_blocks(self) -> None:
        result = VERIFICATION.schedule_verifications(
            {
                "productIdentity": "sha256:product",
                "availableCapabilities": ["node"],
                "targets": {
                    "full": {
                        "requiredCapabilities": ["node", "npm"],
                        "requiredCoverage": "full",
                        "coverageLevel": "module",
                    }
                },
            }
        )
        self.assertFalse(result["ok"])
        reasons = result["plan"][0]["reasonCodes"]
        self.assertIn("CAPABILITY_MISSING:npm", reasons)
        self.assertIn("COVERAGE_INSUFFICIENT:module<full", reasons)

    def test_leaf_change_selects_affected_target_and_consumer_closure(self) -> None:
        result = VERIFICATION.select_verifications(
            {
                "changedFiles": ["packages/ui/src/button.tsx"],
                "targets": [
                    {
                        "id": "ui-unit",
                        "level": "affected",
                        "inputs": ["packages/ui/src/**"],
                        "dependsOn": [],
                    },
                    {
                        "id": "web-module",
                        "level": "module",
                        "inputs": ["apps/web/**"],
                        "dependsOn": ["ui-unit"],
                    },
                    {
                        "id": "server-module",
                        "level": "module",
                        "inputs": ["apps/server/**"],
                        "dependsOn": [],
                    },
                ],
            }
        )
        self.assertEqual(
            [item["id"] for item in result["selected"]],
            ["ui-unit", "web-module"],
        )
        self.assertEqual([item["id"] for item in result["omitted"]], ["server-module"])
        self.assertFalse(result["candidateRequired"])

    def test_lockfile_or_public_schema_escalates_candidate(self) -> None:
        result = VERIFICATION.select_verifications(
            {
                "changedFiles": ["package-lock.json", "packages/contracts/src/report.ts"],
                "targets": [],
            }
        )
        self.assertTrue(result["candidateRequired"])
        self.assertIn("lockfile-changed", result["escalationReasons"])
        self.assertIn("public-contract-changed", result["escalationReasons"])

    def test_resource_plan_serializes_shared_database_and_parallelizes_isolated_package(
        self,
    ) -> None:
        schedule = getattr(VERIFICATION, "schedule_verifications", None)
        self.assertTrue(callable(schedule), "schedule_verifications must be implemented")
        result = schedule(
            {
                "productIdentity": "sha256:frozen",
                "frozenIdentity": "sha256:frozen",
                "targets": [
                    {
                        "id": "browser",
                        "dependsOn": [],
                        "resourceLocks": ["database:session:write", "browser:host:slot"],
                        "estimatedDurationSeconds": 120,
                    },
                    {
                        "id": "performance",
                        "dependsOn": [],
                        "resourceLocks": ["database:session:write", "cpu:heavy"],
                        "estimatedDurationSeconds": 300,
                    },
                    {
                        "id": "package",
                        "dependsOn": [],
                        "resourceLocks": ["frontend-dist:isolated:write"],
                        "estimatedDurationSeconds": 30,
                    },
                ],
            }
        )
        by_id = {item["id"]: item for item in result["plan"]}
        self.assertNotEqual(by_id["browser"]["wave"], by_id["performance"]["wave"])
        self.assertIn(
            by_id["package"]["wave"],
            {by_id["browser"]["wave"], by_id["performance"]["wave"]},
        )
        self.assertIn("database:session:write", by_id["performance"]["resourceLocks"])

    def test_unclassified_heavy_nodes_default_to_serial_and_identity_drift_blocks(
        self,
    ) -> None:
        schedule = getattr(VERIFICATION, "schedule_verifications", None)
        self.assertTrue(callable(schedule), "schedule_verifications must be implemented")
        result = schedule(
            {
                "productIdentity": "sha256:changed",
                "frozenIdentity": "sha256:frozen",
                "targets": [
                    {
                        "id": "full",
                        "dependsOn": [],
                        "requiresFrozenIdentity": True,
                        "estimatedDurationSeconds": 400,
                    },
                    {
                        "id": "static-a",
                        "dependsOn": [],
                        "estimatedDurationSeconds": 90,
                    },
                    {
                        "id": "static-b",
                        "dependsOn": [],
                        "estimatedDurationSeconds": 90,
                    },
                ],
            }
        )
        by_id = {item["id"]: item for item in result["plan"]}
        self.assertEqual(by_id["full"]["decision"], "BLOCKED")
        self.assertIn("FROZEN_IDENTITY_DRIFT", by_id["full"]["reasonCodes"])
        self.assertNotEqual(by_id["static-a"]["wave"], by_id["static-b"]["wave"])
        self.assertIn(
            "harness:unclassified-heavy",
            by_id["static-a"]["resourceLocks"],
        )

    def test_plan_explains_reuse_skip_and_dependency_wait(self) -> None:
        schedule = getattr(VERIFICATION, "schedule_verifications", None)
        self.assertTrue(callable(schedule), "schedule_verifications must be implemented")
        result = schedule(
            {
                "productIdentity": "sha256:frozen",
                "frozenIdentity": "sha256:frozen",
                "verificationLedger": [
                    {
                        "evidenceId": "ledger:compile:42",
                        "targetId": "compile",
                        "productIdentity": "sha256:frozen",
                        "status": "OK",
                    }
                ],
                "targets": [
                    {
                        "id": "compile",
                        "dependsOn": [],
                        "reusePolicy": "ledger-exact",
                        "reuse": {
                            "eligible": True,
                            "reasonCode": "IDENTITY_MATCH",
                            "evidenceId": "ledger:compile:42",
                            "productIdentity": "sha256:frozen",
                        },
                    },
                    {
                        "id": "browser",
                        "dependsOn": ["compile"],
                        "applicability": {
                            "applicable": False,
                            "reasonCode": "NO_UI_CHANGE",
                        },
                    },
                    {
                        "id": "package",
                        "dependsOn": ["compile"],
                        "resourceLocks": ["frontend-dist:isolated:write"],
                    },
                ],
            }
        )
        by_id = {item["id"]: item for item in result["plan"]}
        self.assertEqual(by_id["compile"]["decision"], "REUSE")
        self.assertEqual(by_id["browser"]["decision"], "SKIP")
        self.assertEqual(by_id["package"]["decision"], "EXECUTE")
        self.assertIn("depends-on:compile", by_id["package"]["reasonCodes"])

    def test_executor_consumes_waves_and_propagates_resource_locks(self) -> None:
        starts: list[dict] = []
        receipts: dict[str, dict] = {}

        def start_run_session(**kwargs):
            starts.append(kwargs)
            session_id = f"session-{len(starts)}"
            receipt = {"sessionId": session_id, "status": "STARTING"}
            receipts[session_id] = {
                **receipt,
                "status": "OK",
                "reasonCode": "CHILD_EXIT_ZERO",
            }
            return receipt

        fake_runtime = mock.Mock()
        fake_runtime.RUN_TERMINAL_STATUSES = {
            "OK",
            "FAIL",
            "INCOMPLETE",
            "CANCELLED",
        }
        fake_runtime.start_run_session.side_effect = start_run_session
        fake_runtime.run_session_status.side_effect = (
            lambda _state_root, session_id: receipts[session_id]
        )
        with mock.patch.dict(sys.modules, {"harness_runtime": fake_runtime}):
            result = VERIFICATION.execute_verifications(
                {
                    "productIdentity": "sha256:product",
                    "stateRoot": str(Path.cwd() / ".harness"),
                    "workingDirectory": str(Path.cwd()),
                    "targets": {
                        "database": {
                            "argvTemplate": [sys.executable, "-c", "print('ok')"],
                            "dependsOn": [],
                            "resourceLocks": ["database:shared:write"],
                        }
                    },
                }
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(starts[0]["resource_locks"], ["database:shared:write"])
        self.assertEqual(result["execution"][0]["status"], "OK")

    def test_missing_frozen_identity_invalid_reuse_and_blocked_dependency_fail_closed(
        self,
    ) -> None:
        result = VERIFICATION.schedule_verifications(
            {
                "productIdentity": "sha256:product",
                "targets": [
                    {
                        "id": "full",
                        "dependsOn": [],
                        "requiresFrozenIdentity": True,
                    },
                    {
                        "id": "compile",
                        "dependsOn": [],
                        "reuse": {
                            "eligible": True,
                            "reasonCode": "IDENTITY_MATCH",
                        },
                    },
                    {
                        "id": "candidate",
                        "dependsOn": ["full", "compile"],
                    },
                ],
            }
        )
        by_id = {item["id"]: item for item in result["plan"]}

        self.assertFalse(result["ok"])
        self.assertEqual(by_id["full"]["decision"], "BLOCKED")
        self.assertIn("FROZEN_IDENTITY_REQUIRED", by_id["full"]["reasonCodes"])
        self.assertEqual(by_id["compile"]["decision"], "BLOCKED")
        self.assertIn("REUSE_EVIDENCE_INVALID", by_id["compile"]["reasonCodes"])
        self.assertEqual(by_id["candidate"]["decision"], "BLOCKED")
        self.assertTrue(
            any(
                reason.startswith("DEPENDENCY_BLOCKED:")
                for reason in by_id["candidate"]["reasonCodes"]
            )
        )


if __name__ == "__main__":
    unittest.main()
