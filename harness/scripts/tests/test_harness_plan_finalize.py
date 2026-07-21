#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


finalizer = load_module("harness_plan_finalize", "harness_plan_finalize.py")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def valid_markdown(change: str, title: str) -> str:
    return (
        "---\n"
        f"change-name: {change}\n"
        "status: approved\n"
        "---\n\n"
        f"# {title}\n"
    )


def seed_staging(root: Path, change: str = "demo") -> None:
    write(root / "spec" / f"{change}-design.md", valid_markdown(change, "Design"))
    write(root / "plans" / f"{change}-plan.md", valid_markdown(change, "Plan"))
    write(
        root / "plans" / f"{change}-implementation-detail.md",
        valid_markdown(change, "Implementation"),
    )
    write(
        root / "plans" / f"{change}-test-scenarios.md",
        valid_markdown(change, "Scenarios"),
    )
    write(root / "meta" / "gate-policy.json", json.dumps({"schemaVersion": 1}))
    write(
        root / "meta" / "worktree.json",
        json.dumps({"requested": False, "agent": "codex"}),
    )


class PlanFinalizeTests(unittest.TestCase):
    def test_invalid_staging_publishes_nothing_and_writes_no_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            write(staging / "meta" / "gate-policy.json", "{invalid")

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_ARTIFACT_INVALID_JSON")
            self.assertFalse((change_dir / "spec").exists())
            self.assertFalse((change_dir / "events.ndjson").exists())
            self.assertFalse((change_dir / "logs" / "execution-log.md").exists())

            write(
                staging / "meta" / "gate-policy.json",
                json.dumps({"schemaVersion": 1}),
            )
            recovered = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(recovered["ok"])
            self.assertTrue((change_dir / "spec" / "demo-design.md").is_file())

    def test_success_is_idempotent_and_has_one_terminal_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)

            first = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )
            second = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertTrue(first["ok"])
            self.assertTrue(second["ok"])
            self.assertTrue(second["idempotent"])
            lines = (change_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()
            events = [json.loads(line) for line in lines if line.strip()]
            terminals = [event for event in events if event.get("type") == "phase.end"]
            self.assertEqual(len(terminals), 1)
            self.assertEqual(terminals[0]["status"], "OK")
            self.assertTrue((change_dir / "logs" / "execution-log.md").is_file())
            receipt = json.loads(
                (change_dir / "meta" / "plan-finalization.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt["status"], "finalized")
            self.assertEqual(receipt["artifactsHash"], first["artifactsHash"])

    def test_conflicting_existing_target_is_rejected_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            target = change_dir / "spec" / "demo-design.md"
            write(target, "user-owned\n")
            before = target.read_bytes()

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_TARGET_CONFLICT")
            self.assertEqual(target.read_bytes(), before)
            self.assertFalse((change_dir / "events.ndjson").exists())

    def test_final_receipt_failure_preserves_recoverable_terminal_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            real_write = finalizer._atomic_write_json
            writes = 0

            def fail_final_receipt(path: Path, payload: dict[str, object]) -> None:
                nonlocal writes
                writes += 1
                # Write order: scenario-manifest (1), receipt "publishing" (2),
                # receipt "finalized" (3). Fail on the final receipt write.
                if writes == 3:
                    raise OSError("injected finalized receipt failure")
                real_write(path, payload)

            with mock.patch.object(
                finalizer, "_atomic_write_json", side_effect=fail_final_receipt
            ):
                failed = finalizer.finalize_plan(
                    change_dir,
                    staging,
                    change_name="demo",
                    run_id="plan-run",
                    attempt=1,
                )

            self.assertFalse(failed["ok"])
            self.assertEqual(failed["code"], "PLAN_FINALIZATION_RECOVERY_REQUIRED")
            self.assertTrue((change_dir / "spec" / "demo-design.md").is_file())
            receipt_path = change_dir / "meta" / "plan-finalization.json"
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["status"], "publishing")
            lines = (change_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()
            terminals = [
                json.loads(line)
                for line in lines
                if line.strip() and json.loads(line).get("type") == "phase.end"
            ]
            self.assertEqual(len(terminals), 1)

            recovered = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertTrue(recovered["ok"])
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["status"], "finalized")
            lines = (change_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()
            self.assertEqual(
                sum(json.loads(line).get("type") == "phase.end" for line in lines),
                1,
            )


class CapabilityReclassifyTests(unittest.TestCase):
    """C2 (retro §5.4): approved design capability → reclassify gate policy."""

    def test_finalize_reclassifies_on_design_capabilities(self) -> None:
        """Design with capabilities=[database] → final gate-policy has database."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            # Write design with capabilities
            write(
                staging / "spec" / "demo-design.md",
                "---\n"
                "change-name: demo\n"
                "status: approved\n"
                "capabilities: database,api\n"
                "---\n\n"
                "# Design\n",
            )
            # gate-policy has empty capabilities (drift)
            write(
                staging / "meta" / "gate-policy.json",
                json.dumps({"schemaVersion": 1, "capabilities": []}),
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(result["ok"], msg=json.dumps(result, ensure_ascii=False))

            # Published gate-policy.json must have database,api capabilities
            published = json.loads(
                (change_dir / "meta" / "gate-policy.json").read_text(encoding="utf-8")
            )
            caps = set(published.get("capabilities") or [])
            self.assertIn("database", caps)
            self.assertIn("api", caps)

    def test_finalize_no_capabilities_no_drift(self) -> None:
        """Design without capabilities → no reclassify, no drift."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            # design has no capabilities
            # gate-policy has empty capabilities
            write(
                staging / "meta" / "gate-policy.json",
                json.dumps({"schemaVersion": 1, "capabilities": []}),
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(result["ok"])

            published = json.loads(
                (change_dir / "meta" / "gate-policy.json").read_text(encoding="utf-8")
            )
            self.assertEqual(published.get("capabilities") or [], [])


class OwnerPhaseParseTests(unittest.TestCase):
    """C8: plan.md 任务表 ownerPhase 列解析与校验。"""

    def _plan_with_owner_phase(self, change: str, rows: list[str]) -> str:
        header = "| # | 簇 | 任务 | ownerPhase | implementationDoneWhen | verificationPhase |\n"
        sep = "|---|---|---|---|---|---|\n"
        body = "\n".join(rows)
        return (
            "---\n"
            f"change-name: {change}\n"
            "status: approved\n"
            "---\n\n"
            "# Plan\n\n"
            "## 任务表\n\n"
            f"{header}{sep}{body}\n"
        )

    def test_parse_plan_extracts_owner_phase(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change = "demo-owner"
            seed_staging(staging, change)
            write(
                staging / "plans" / f"{change}-plan.md",
                self._plan_with_owner_phase(change, [
                    "| 1 | C1 | task one | run | code done | test |",
                    "| 2 | C2 | task two | test | tests pass | test |",
                ]),
            )

            tasks = finalizer.parse_plan_tasks(staging / "plans" / f"{change}-plan.md")
            self.assertEqual(len(tasks), 2)
            self.assertEqual(tasks[0]["ownerPhase"], "run")
            self.assertEqual(tasks[0]["implementationDoneWhen"], "code done")
            self.assertEqual(tasks[0]["verificationPhase"], "test")
            self.assertEqual(tasks[1]["ownerPhase"], "test")

    def test_parse_plan_owner_phase_optional(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change = "demo-noop"
            seed_staging(staging, change)
            # plan without ownerPhase column
            write(
                staging / "plans" / f"{change}-plan.md",
                "---\n"
                f"change-name: {change}\n"
                "status: approved\n"
                "---\n\n"
                "# Plan\n\n"
                "## 任务表\n\n"
                "| # | 簇 | 任务 |\n"
                "|---|---|---|\n"
                "| 1 | C1 | task one |\n",
            )

            tasks = finalizer.parse_plan_tasks(staging / "plans" / f"{change}-plan.md")
            self.assertEqual(len(tasks), 1)
            self.assertNotIn("ownerPhase", tasks[0])

    def test_finalize_validates_owner_phase_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo-bad"
            change = "demo-bad"
            seed_staging(staging, change)
            write(
                staging / "plans" / f"{change}-plan.md",
                self._plan_with_owner_phase(change, [
                    "| 1 | C1 | task one | invalid_phase | code done | test |",
                ]),
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name=change,
                run_id="plan-run",
                attempt=1,
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_OWNER_PHASE_INVALID")

    def test_finalize_accepts_valid_owner_phase(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo-ok"
            change = "demo-ok"
            seed_staging(staging, change)
            write(
                staging / "plans" / f"{change}-plan.md",
                self._plan_with_owner_phase(change, [
                    "| 1 | C1 | task one | run | code done | test |",
                    "| 2 | C2 | task two | test | tests pass | test |",
                ]),
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name=change,
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(result["ok"], msg=result)
            # implementation-checkpoints.json written with ownerPhase
            checkpoints_path = change_dir / "meta" / "implementation-checkpoints.json"
            self.assertTrue(checkpoints_path.is_file())
            data = json.loads(checkpoints_path.read_text(encoding="utf-8"))
            self.assertIn("tasks", data)
            self.assertEqual(len(data["tasks"]), 2)
            self.assertEqual(data["tasks"][0]["ownerPhase"], "run")
            self.assertEqual(data["tasks"][1]["ownerPhase"], "test")


class ScenarioManifestTests(unittest.TestCase):
    """C9: finalize 输出 scenario-manifest.json。"""

    def _scenarios_md(self, change: str) -> str:
        return (
            "---\n"
            f"change-name: {change}\n"
            "status: approved\n"
            "---\n\n"
            "# Test Scenarios\n\n"
            "## C5: CLI 默认 compact 输出\n\n"
            "| ID | 优先级 | 场景 | 验证方式 | owner phase |\n"
            "|---|---|---|---|---|\n"
            "| C5-S1 | P0 | knowledge query 默认返回 compact JSON | assert matches not in compact output | test |\n"
            "| C5-S2 | P1 | knowledge query --verbose 返回完整 matches | assert matches in verbose output | test |\n\n"
            "## C7: common profile\n\n"
            "| ID | 优先级 | 场景 | 验证方式 | owner phase |\n"
            "|---|---|---|---|---|\n"
            "| C7-S1 | P0 | common_root 从 git common dir 解析 | assert common_root(worktree) == main project root | test |\n"
        )

    def test_finalize_outputs_scenario_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo-manifest"
            change = "demo-manifest"
            seed_staging(staging, change)
            write(
                staging / "plans" / f"{change}-test-scenarios.md",
                self._scenarios_md(change),
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name=change,
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(result["ok"], msg=result)

            manifest_path = change_dir / "meta" / "scenario-manifest.json"
            self.assertTrue(manifest_path.is_file(), "scenario-manifest.json missing")
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertIn("scenarios", data)
            self.assertEqual(len(data["scenarios"]), 3)
            # Each scenario has id/priority/ownerPhase
            s1 = data["scenarios"][0]
            self.assertEqual(s1["id"], "C5-S1")
            self.assertEqual(s1["priority"], "P0")
            self.assertEqual(s1["ownerPhase"], "test")
            # P0 scenario has requiredEvidenceKind
            self.assertIn("requiredEvidenceKind", s1)

    def test_finalize_compatible_with_no_scenarios_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo-no-scen"
            change = "demo-no-scen"
            seed_staging(staging, change)
            # scenarios file has no tables
            write(
                staging / "plans" / f"{change}-test-scenarios.md",
                "---\n"
                f"change-name: {change}\n"
                "status: approved\n"
                "---\n\n"
                "# Test Scenarios\n\n"
                "No scenarios yet.\n",
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name=change,
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(result["ok"], msg=result)
            manifest_path = change_dir / "meta" / "scenario-manifest.json"
            self.assertTrue(manifest_path.is_file())
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(data["scenarios"], [])


if __name__ == "__main__":
    unittest.main()
