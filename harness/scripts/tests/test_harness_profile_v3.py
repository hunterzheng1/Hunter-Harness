import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_profile.py"
SPEC = importlib.util.spec_from_file_location("harness_profile_v3_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


class ProfileV3Test(unittest.TestCase):
    def test_java_reactor_recommendation_is_review_only_and_module_aware(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / "pom.xml").write_text(
                "<project><modules><module>api</module><module>web</module></modules></project>",
                encoding="utf-8",
            )
            for module in ("api", "web"):
                path = project / module
                path.mkdir()
                (path / "pom.xml").write_text("<project/>", encoding="utf-8")
            result = PROFILE.recommend(project)
            self.assertEqual(result["code"], "PROFILE_RECOMMENDED")
            self.assertFalse((project / ".harness/config/build-profile.json").exists())
            self.assertEqual([m["id"] for m in result["modules"]], ["api", "web"])
            module_target = next(t for t in result["targets"] if t["level"] == "module")
            self.assertIn("-pl {modules}", module_target["command"])

    def test_node_workspaces_become_modules_and_shared_consumers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / "package.json").write_text(
                json.dumps(
                    {
                        "scripts": {"check": "npm run lint && npm test"},
                        "workspaces": ["packages/*", "apps/*"],
                    }
                ),
                encoding="utf-8",
            )
            for rel in ("packages/core", "apps/web"):
                path = project / rel
                path.mkdir(parents=True)
                (path / "package.json").write_text("{}", encoding="utf-8")
            result = PROFILE.recommend(project)
            self.assertEqual(
                [m["path"] for m in result["modules"]],
                ["apps/web", "packages/core"],
            )
            self.assertTrue(any(t.get("sharedConsumer") for t in result["targets"]))

    def test_v2_projection_preserves_user_command_and_marks_review(self) -> None:
        command = {
            "command": "npm run custom-check -- --frozen",
            "argvTemplate": ["npm", "run", "custom-check", "--", "--frozen"],
            "scope": "full",
            "inputs": ["src/**"],
            "coverage": "unitTestFull",
            "source": "user",
            "basis": {"ticket": "OPS-42"},
        }
        projected = PROFILE.project_profile_v3(
            {"schemaVersion": 2, "commands": {"unitTestFull": command}}
        )
        self.assertEqual(projected["schemaVersion"], 3)
        self.assertEqual(projected["commands"]["unitTestFull"], command)
        self.assertTrue(projected["migration"]["needsReview"])
        self.assertIn("commandGraph", projected)

    def test_audit_fails_closed_when_module_boundary_is_unproven(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            path = project / ".harness/config/build-profile.json"
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 3,
                        "commands": {},
                        "moduleGraph": {"modules": [], "boundariesProven": False},
                    }
                ),
                encoding="utf-8",
            )
            result = PROFILE.audit_profile(project)
            self.assertTrue(result["needsReview"])
            self.assertEqual(result["code"], "PROFILE_REVIEW_REQUIRED")

    def test_v2_migration_apply_preserves_protected_user_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            path = project / ".harness/config/build-profile.json"
            path.parent.mkdir(parents=True)
            command = {
                "command": "npm run protected",
                "argvTemplate": ["npm", "run", "protected"],
                "scope": "full",
                "inputs": ["src/**"],
                "coverage": "unitTestFull",
                "source": "user",
                "basis": {"owner": "platform"},
            }
            path.write_text(
                json.dumps(
                    {"schemaVersion": 2, "commands": {"unitTestFull": command}}
                ),
                encoding="utf-8",
            )

            planned = PROFILE.migrate(project, dry_run=True)
            self.assertEqual(planned["code"], "PROFILE_MIGRATION_PLANNED")
            self.assertEqual(planned["protectedUserCommands"], ["unitTestFull"])
            applied = PROFILE.migrate(project, dry_run=False)

            self.assertEqual(applied["code"], "PROFILE_MIGRATED")
            migrated = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(migrated["schemaVersion"], 3)
            self.assertEqual(migrated["commands"]["unitTestFull"], command)
            self.assertTrue(
                path.with_suffix(path.suffix + ".v2.bak").is_file()
            )


if __name__ == "__main__":
    unittest.main()
