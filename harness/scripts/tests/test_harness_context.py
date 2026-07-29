import datetime as dt
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_context.py"
SPEC = importlib.util.spec_from_file_location("harness_context_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CONTEXT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTEXT)


def make_change(project: Path, name: str, status: str = "active") -> Path:
    change = project / ".harness/changes" / name
    (change / "meta").mkdir(parents=True)
    (change / "meta/change-context.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "changeName": name,
                "lifecycle": {"status": status},
                "stateOwnership": {
                    "runtimeRoot": f".harness/state/changes/{name}"
                },
            }
        ),
        encoding="utf-8",
    )
    return change


class HarnessContextTest(unittest.TestCase):
    def test_json_flag_is_accepted_after_every_subcommand(self) -> None:
        parser = CONTEXT.build_parser()
        command_lines = [
            ["prepare", "--project", ".", "--phase", "run", "--executor", "codex", "--json"],
            [
                "close",
                "--project",
                ".",
                "--change",
                "demo",
                "--from-phase",
                "run",
                "--to-phase",
                "test",
                "--executor",
                "codex",
                "--json",
            ],
            [
                "begin",
                "--project",
                ".",
                "--change",
                "demo",
                "--phase",
                "test",
                "--executor",
                "codex",
                "--json",
            ],
            ["view", "--project", ".", "--change", "demo", "--json"],
        ]
        for argv in command_lines:
            with self.subTest(argv=argv):
                self.assertTrue(parser.parse_args(argv).json)

    def test_prepare_bootstraps_unique_active_change_and_execution_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "active")
            make_change(project, "archived", "archived")
            result = CONTEXT.prepare_context(
                project, phase="run", executor="codex", ttl_seconds=60
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["changeName"], "active")
            self.assertTrue(result["legacyBootstrap"])
            self.assertEqual(result["nextPhases"], ["plan", "run"])
            self.assertEqual(result["executionRoot"], str(project.resolve()))

    def test_prepare_resolves_relative_worktree_path_from_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "active")
            worktree = project / ".worktrees" / "active"
            worktree.mkdir(parents=True)
            (change / "meta/worktree.json").write_text(
                json.dumps(
                    {
                        "created": False,
                        "path": ".worktrees/active",
                        "worktreeRoot": ".worktrees",
                    }
                ),
                encoding="utf-8",
            )

            result = CONTEXT.prepare_context(
                project,
                change="active",
                phase="run",
                executor="codex",
                ttl_seconds=60,
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["executionRoot"], str(worktree.resolve()))

    def test_prepare_fails_closed_for_ambiguous_active_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "one")
            make_change(project, "two")
            result = CONTEXT.prepare_context(
                project, phase="run", executor="codex"
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "ACTIVE_CHANGE_AMBIGUOUS")
            self.assertEqual(result["candidates"], ["one", "two"])

    def test_executor_change_without_receipt_requires_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            first = CONTEXT.prepare_context(
                project,
                change="change",
                phase="plan",
                executor="codebuddy",
                ttl_seconds=60,
            )
            self.assertTrue(first["ok"])
            state = project / ".harness/state/changes/change/runtime"
            (state / "context-lease.json").unlink()
            second = CONTEXT.prepare_context(
                project, change="change", phase="run", executor="codex"
            )
            self.assertFalse(second["ok"])
            self.assertEqual(second["code"], "HANDOFF_REQUIRED")

    def test_close_and_begin_cross_tool_receipt_with_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "change")
            artifact = change / "plans/plan.md"
            artifact.parent.mkdir()
            artifact.write_text("approved plan", encoding="utf-8")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="codebuddy"
            )
            closed = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="run",
                executor="codebuddy",
                artifacts=[str(artifact)],
            )
            self.assertTrue(closed["ok"])
            begun = CONTEXT.begin_transition(
                project, "change", phase="run", executor="codex"
            )
            self.assertTrue(begun["ok"])
            self.assertEqual(begun["receipt"]["fromPhase"], "plan")
            self.assertEqual(begun["receipt"]["toPhase"], "run")

    def test_begin_rejects_artifact_hash_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "change")
            artifact = change / "plans/plan.md"
            artifact.parent.mkdir()
            artifact.write_text("approved", encoding="utf-8")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="codebuddy"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="run",
                executor="codebuddy",
                artifacts=[str(artifact)],
            )
            artifact.write_text("tampered", encoding="utf-8")
            result = CONTEXT.begin_transition(
                project, "change", phase="run", executor="codex"
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "HANDOFF_IDENTITY_MISMATCH")

    def test_lease_active_blocks_and_expired_lease_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            first = CONTEXT.prepare_context(
                project,
                change="change",
                phase="run",
                executor="agent-a",
                ttl_seconds=60,
            )
            self.assertTrue(first["ok"])
            blocked = CONTEXT.prepare_context(
                project, change="change", phase="run", executor="agent-b"
            )
            self.assertEqual(blocked["code"], "CONTEXT_LEASE_HELD")
            lease_path = project / ".harness/state/changes/change/runtime/context-lease.json"
            lease = json.loads(lease_path.read_text(encoding="utf-8"))
            lease["expiresAt"] = (
                dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
            ).isoformat()
            lease_path.write_text(json.dumps(lease), encoding="utf-8")
            recovered = CONTEXT.prepare_context(
                project, change="change", phase="run", executor="agent-b"
            )
            self.assertTrue(recovered["ok"])
            self.assertEqual(recovered["recovery"]["code"], "LEASE_EXPIRED_RECOVERED")

    def test_fixback_transition_invalidates_targets_without_deleting_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            state = project / ".harness/state/changes/change"
            (state / "evidence").mkdir(parents=True)
            ledger_path = state / "evidence/verification-ledger.json"
            ledger_path.write_text(
                json.dumps(
                    {
                        "verificationTargets": {
                            "unit": {
                                "id": "unit",
                                "verification": "unitTestFull",
                                "status": "OK",
                            },
                            "api": {
                                "id": "api",
                                "verification": "apiTest",
                                "status": "OK",
                            },
                        },
                        "validations": {},
                    }
                ),
                encoding="utf-8",
            )
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="reviewer"
            )
            result = CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="run",
                executor="reviewer",
            )
            self.assertTrue(result["ok"])
            updated = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual(len(updated["verificationTargets"]), 2)
            self.assertFalse(updated["verificationTargets"]["unit"]["reusable"])
            self.assertIn("invalidation", result)

    def test_view_reconstructs_append_only_transition_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="planner"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="run",
                executor="planner",
            )
            view = CONTEXT.context_view(project, "change")
            self.assertEqual(len(view["transitions"]), 1)
            self.assertEqual(view["currentPhase"], "run")
            self.assertIn("attemptHistory", view)


if __name__ == "__main__":
    unittest.main()
