import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_plan_aggregate.py"
SPEC = importlib.util.spec_from_file_location("harness_plan_aggregate_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
AGGREGATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AGGREGATE)


class AggregatePlanTest(unittest.TestCase):
    def test_scale_recommends_aggregate_for_large_cross_module_change(self) -> None:
        result = AGGREGATE.analyze_scale(
            {"fileCount": 40, "taskCount": 25, "modules": ["api", "core", "web", "cli"]}
        )
        self.assertEqual(result["mode"], "aggregate")
        self.assertIn("file-count", result["reasons"])
        self.assertIn("task-count", result["reasons"])
        self.assertIn("module-count", result["reasons"])

    def test_owned_path_overlap_rejects_parallel_children(self) -> None:
        result = AGGREGATE.validate_aggregate(
            {
                "children": [
                    {"id": "api", "ownedPaths": ["apps/api/**"], "dependsOn": []},
                    {"id": "api-tests", "ownedPaths": ["apps/api/test/**"], "dependsOn": []},
                ]
            }
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "AGGREGATE_OWNERSHIP_OVERLAP")
        self.assertFalse(result["parallelEligible"])

    def test_integration_depends_on_every_child_and_receipts_cover_commits(self) -> None:
        plan = {
            "children": [
                {"id": "backend", "ownedPaths": ["apps/api/**"], "dependsOn": []},
                {"id": "frontend", "ownedPaths": ["apps/web/**"], "dependsOn": []},
                {
                    "id": "integration",
                    "kind": "integration",
                    "ownedPaths": ["tests/e2e/**"],
                    "dependsOn": ["backend", "frontend"],
                },
            ],
            "receipts": [
                {"childId": "backend", "productCommit": "a" * 40},
                {"childId": "frontend", "productCommit": "b" * 40},
                {
                    "childId": "integration",
                    "productCommit": "c" * 40,
                    "coversProductCommits": ["a" * 40, "b" * 40],
                },
            ],
        }
        result = AGGREGATE.validate_aggregate(plan)
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "AGGREGATE_PLAN_VALID")


if __name__ == "__main__":
    unittest.main()
