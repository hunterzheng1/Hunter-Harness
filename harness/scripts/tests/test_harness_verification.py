import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_verification.py"
SPEC = importlib.util.spec_from_file_location("harness_verification_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
VERIFICATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFICATION)


class VerificationSelectionTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
