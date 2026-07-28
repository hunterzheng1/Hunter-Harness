#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
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
    write(
        root / "plans" / f"{change}-plan.md",
        valid_markdown(change, "Plan")
        + "\n| # | 任务 |\n"
        "|---|---|\n"
        "| 1 | implement the approved change |\n",
    )
    write(
        root / "plans" / f"{change}-implementation-detail.md",
        valid_markdown(change, "Implementation"),
    )
    write(
        root / "plans" / f"{change}-test-scenarios.md",
        valid_markdown(change, "Scenarios")
        + "\n| ID | 优先级 | 场景 | 验证方式 | owner phase |\n"
        "|---|---|---|---|---|\n"
        "| UT-001 | P0 | approved behavior | unit test | test |\n",
    )
    write(root / "meta" / "gate-policy.json", json.dumps({"schemaVersion": 1}))
    write(
        root / "meta" / "worktree.json",
        json.dumps({"requested": False, "agent": "codex"}),
    )


def seed_plan_start(
    change_dir: Path,
    *,
    run_id: str = "plan-run",
    attempt: int = 1,
) -> None:
    write(
        change_dir / "events.ndjson",
        json.dumps(
            {
                "schema_version": 3,
                "id": "evt-plan-start",
                "timestamp": "2026-07-28T20:00:00+08:00",
                "phase": "plan",
                "type": "phase.start",
                "run_id": run_id,
                "attempt": attempt,
                "note": "",
            }
        )
        + "\n",
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
            seed_plan_start(change_dir)
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
            seed_plan_start(change_dir)

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
            seed_plan_start(change_dir)
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
            events = [
                json.loads(line)
                for line in (change_dir / "events.ndjson").read_text(
                    encoding="utf-8"
                ).splitlines()
                if line.strip()
            ]
            self.assertEqual([event["type"] for event in events], ["phase.start"])

    def test_final_receipt_failure_preserves_recoverable_terminal_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            seed_plan_start(change_dir)
            real_write = finalizer._atomic_write_json

            def fail_final_receipt(path: Path, payload: dict[str, object]) -> None:
                if (
                    path.name == "plan-finalization.json"
                    and payload.get("status") == "finalized"
                ):
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

    def test_finalize_requires_matching_phase_start_before_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            seed_plan_start(change_dir, run_id="other-run", attempt=1)

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PHASE_START_MISSING")
            self.assertFalse((change_dir / "spec").exists())
            self.assertFalse(
                (change_dir / "meta" / "plan-finalization.json").exists()
            )

    def test_finalize_rejects_duplicate_matching_phase_starts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            seed_plan_start(change_dir)
            events_path = change_dir / "events.ndjson"
            first = json.loads(events_path.read_text(encoding="utf-8"))
            first["id"] = "evt-plan-start-duplicate"
            with events_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(first) + "\n")

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PHASE_START_DUPLICATE")
            self.assertFalse((change_dir / "spec").exists())


class CapabilityReclassifyTests(unittest.TestCase):
    """C2 (retro §5.4): approved design capability → reclassify gate policy."""

    def test_finalize_reclassifies_on_design_capabilities(self) -> None:
        """Design with capabilities=[database] → final gate-policy has database."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            seed_plan_start(change_dir)
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
            seed_plan_start(change_dir)
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

    def test_parse_plan_collects_all_task_tables(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp) / "multi-table-plan.md"
            write(
                plan,
                "---\n"
                "change-name: multi-table\n"
                "status: approved\n"
                "---\n\n"
                "# Plan\n\n"
                "## Batch 0\n\n"
                "| # | 任务 | 依赖 |\n"
                "|---|---|---|\n"
                "| 1 | trust cleanup | - |\n"
                "| 2 | navigation | 1 |\n\n"
                "## Batch 1\n\n"
                "| # | 任务 | 依赖 |\n"
                "|---|---|---|\n"
                "| 3 | lazy routes | 2 |\n"
                "| 4 | query keys | 2 |\n\n"
                "## Conditional\n\n"
                "| # | 任务 | 进入条件 |\n"
                "|---|---|---|\n"
                "| C1 | virtualization | measured bottleneck |\n",
            )

            tasks = finalizer.parse_plan_tasks(plan)

            self.assertEqual(
                [task["num"] for task in tasks],
                ["1", "2", "3", "4", "C1"],
            )
            self.assertEqual(tasks[-1]["task"], "virtualization")

    def test_validate_rejects_blank_task_row_in_mixed_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / "staging"
            seed_staging(staging)
            write(
                staging / "plans" / "demo-plan.md",
                valid_markdown("demo", "Plan")
                + "\n| # | 任务 |\n"
                "|---|---|\n"
                "| 1 | valid task |\n"
                "| 2 | |\n",
            )

            result = finalizer.validate_staging(staging, "demo")

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_TASK_ROW_INVALID")

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
            seed_plan_start(change_dir)
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
            seed_plan_start(change_dir)
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

    def test_parse_supports_hash_category_and_description_headers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            scenarios_path = Path(tmp) / "cbm-style-scenarios.md"
            write(
                scenarios_path,
                "---\n"
                "change-name: cbm-style\n"
                "status: approved\n"
                "---\n\n"
                "# Test Scenarios\n\n"
                "| # | 分类 | 场景描述 | 输入 | 预期 | 执行层级 | 可复用证据 |\n"
                "|---|---|---|---|---|---|---|\n"
                "| UT-001 | 正常 | no placeholder metrics | render page | dashes | affected | ledger identity |\n"
                "| INT-001 | 端到端 | lazy login flow | browser | page loads | candidate | verification identity |\n"
                "| COM-001 | 兼容 | short legacy row | old value | expected value | module |\n",
            )

            scenarios = finalizer.parse_test_scenarios(scenarios_path)

            self.assertEqual(
                [item["id"] for item in scenarios],
                ["UT-001", "INT-001", "COM-001"],
            )
            self.assertEqual(scenarios[0]["category"], "正常")
            self.assertEqual(scenarios[0]["scenario"], "no placeholder metrics")
            self.assertEqual(scenarios[0]["priority"], "P1")
            self.assertEqual(scenarios[0]["requiredEvidenceKind"], "ledger")
            self.assertEqual(scenarios[0]["ownerPhase"], "test")
            self.assertEqual(scenarios[0]["executionTier"], "affected")
            self.assertNotIn("executionTier", scenarios[2])

    def test_validate_rejects_empty_scenario_description_in_mixed_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / "staging"
            seed_staging(staging)
            write(
                staging / "plans" / "demo-test-scenarios.md",
                valid_markdown("demo", "Scenarios")
                + "\n| ID | 优先级 | 场景 |\n"
                "|---|---|---|\n"
                "| UT-001 | P0 | valid scenario |\n"
                "| UT-002 | P1 | |\n",
            )

            result = finalizer.validate_staging(staging, "demo")

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_SCENARIO_ROW_INVALID")

    def test_finalize_rejects_no_scenarios_table(self) -> None:
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
            self.assertFalse(result["ok"], msg=result)
            self.assertEqual(result["code"], "PLAN_SCENARIOS_EMPTY")
            self.assertFalse((change_dir / "meta" / "scenario-manifest.json").exists())

    def test_finalize_rejects_duplicate_scenario_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change = "demo-duplicate-scenarios"
            change_dir = root / ".harness" / "changes" / change
            seed_staging(staging, change)
            write(
                staging / "plans" / f"{change}-test-scenarios.md",
                valid_markdown(change, "Scenarios")
                + "\n| ID | 优先级 | 场景 |\n"
                "|---|---|---|\n"
                "| UT-001 | P0 | first |\n"
                "| UT-001 | P0 | duplicate |\n",
            )

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name=change,
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"], msg=result)
            self.assertEqual(result["code"], "PLAN_SCENARIO_ID_DUPLICATE")


class PlanVerifyTests(unittest.TestCase):
    """Tests for the `verify` subcommand (retro §5.8)."""

    def _finalize_and_verify(self, change: str = "verify-demo") -> tuple[Path, dict]:
        # Use a persistent temp dir that survives until the test method returns;
        # TemporaryDirectory context manager would delete the change_dir before
        # verify_plan runs.
        root = Path(tempfile.mkdtemp(prefix="plan-verify-"))
        staging = root / "staging"
        change_dir = root / ".harness" / "changes" / change
        seed_staging(staging, change)
        seed_plan_start(change_dir)
        finalize_result = finalizer.finalize_plan(
            change_dir,
            staging,
            change_name=change,
            run_id="plan-run",
            attempt=1,
        )
        assert finalize_result["ok"], finalize_result
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        return change_dir, finalize_result

    def _rewrite_receipt_files(
        self,
        change_dir: Path,
        files: list[str],
    ) -> None:
        receipt_path = change_dir / "meta" / "plan-finalization.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        digest = hashlib.sha256()
        for rel in files:
            digest.update(rel.encode("utf-8"))
            digest.update(b"\0")
            digest.update((change_dir / rel).read_bytes())
            digest.update(b"\0")
        receipt["files"] = files
        receipt["artifactsHash"] = "sha256:" + digest.hexdigest()
        receipt_path.write_text(json.dumps(receipt) + "\n", encoding="utf-8")

    def test_verify_succeeds_after_finalize(self) -> None:
        change_dir, finalize_result = self._finalize_and_verify()
        result = finalizer.verify_plan(change_dir)
        self.assertTrue(result["ok"], msg=result)
        self.assertEqual(result["action"], "verify")
        self.assertEqual(result["artifactsHash"], finalize_result["artifactsHash"])
        self.assertEqual(result["phaseEndCount"], 1)
        self.assertEqual(result["phaseEndStatus"], "OK")
        self.assertTrue(result["receiptConsistent"])
        self.assertTrue(result["gatePolicyConsistent"])

    def test_verify_works_without_staging(self) -> None:
        change_dir, _ = self._finalize_and_verify()
        # staging dir is external to change_dir; verify must not require it.
        result = finalizer.verify_plan(change_dir)
        self.assertTrue(result["ok"], msg=result)
        self.assertNotIn("stagingDir", result)

    def test_verify_handles_chinese_ndjson(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-chinese")
        # Append an event with Chinese note to events.ndjson
        events_path = change_dir / "events.ndjson"
        original = events_path.read_text(encoding="utf-8")
        # Append a decision event with Chinese text
        chinese_event = (
            '{"schema_version":3,"id":"evt-test","timestamp":"2026-07-21T16:00:00+08:00",'
            '"phase":"plan","type":"decision","note":"用户确认设计审批包：范围覆盖 6 个 P2 项"}\n'
        )
        events_path.write_text(original + chinese_event, encoding="utf-8")
        result = finalizer.verify_plan(change_dir)
        self.assertTrue(result["ok"], msg=result)
        self.assertEqual(result["phaseEndCount"], 1)

    def test_verify_uses_routed_events_path(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="plan-verify-routed-"))
        staging = root / "staging"
        change = "verify-routed"
        change_dir = root / ".harness" / "changes" / change
        routed_events = root / ".harness" / "state" / "changes" / change / "events.ndjson"
        seed_staging(staging, change)
        write(
            routed_events,
            json.dumps(
                {
                    "schema_version": 3,
                    "id": "evt-plan-start",
                    "timestamp": "2026-07-28T20:00:00+08:00",
                    "phase": "plan",
                    "type": "phase.start",
                    "run_id": "plan-run",
                    "attempt": 1,
                    "note": "",
                }
            )
            + "\n",
        )
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))

        with mock.patch.object(
            finalizer.harness_events,
            "events_path",
            return_value=routed_events,
        ):
            finalized = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name=change,
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(finalized["ok"], finalized)
            result = finalizer.verify_plan(change_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["phaseStartCount"], 1)
        self.assertEqual(result["phaseEndCount"], 1)

    def test_verify_fails_when_phase_end_missing(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-no-end")
        # Remove the phase.end event by rewriting events.ndjson with only phase.start
        events_path = change_dir / "events.ndjson"
        lines = events_path.read_text(encoding="utf-8").splitlines()
        kept = [
            line for line in lines
            if line.strip() and json.loads(line).get("type") != "phase.end"
        ]
        events_path.write_text("\n".join(kept) + "\n", encoding="utf-8")
        result = finalizer.verify_plan(change_dir)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PHASE_END_MISSING")

    def test_verify_fails_when_receipt_missing(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-no-receipt")
        (change_dir / "meta" / "plan-finalization.json").unlink()
        result = finalizer.verify_plan(change_dir)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_MISSING")

    def test_verify_fails_on_artifact_hash_drift(self) -> None:
        change_dir, finalize_result = self._finalize_and_verify("verify-drift")
        # Modify a published artifact to invalidate the hash
        design_path = change_dir / "spec" / "verify-drift-design.md"
        original = design_path.read_text(encoding="utf-8")
        design_path.write_text(original + "\n<!-- drift -->\n", encoding="utf-8")
        result = finalizer.verify_plan(change_dir)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ARTIFACT_HASH_DRIFT")

    def test_verify_rejects_receipt_path_outside_change_root(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-unsafe-receipt")
        receipt_path = change_dir / "meta" / "plan-finalization.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["files"] = ["../../outside.txt"]
        receipt_path.write_text(json.dumps(receipt) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_FILE_PATH_INVALID")

    def test_verify_rejects_receipt_that_omits_required_artifact(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-incomplete-receipt")
        receipt_path = change_dir / "meta" / "plan-finalization.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        files = [
            rel
            for rel in receipt["files"]
            if rel != "spec/verify-incomplete-receipt-design.md"
        ]
        self._rewrite_receipt_files(change_dir, files)
        (change_dir / "spec" / "verify-incomplete-receipt-design.md").unlink()

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_FILES_INCOMPLETE")

    def test_verify_returns_structured_error_when_plan_is_omitted_and_missing(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-missing-plan")
        receipt_path = change_dir / "meta" / "plan-finalization.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        plan_rel = "plans/verify-missing-plan-plan.md"
        files = [rel for rel in receipt["files"] if rel != plan_rel]
        self._rewrite_receipt_files(change_dir, files)
        (change_dir / plan_rel).unlink()

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_FILES_INCOMPLETE")

    def test_link_detector_recognizes_windows_reparse_points_without_is_junction(
        self,
    ) -> None:
        fake_stat = mock.Mock(st_file_attributes=0x400)
        with (
            mock.patch.object(Path, "is_symlink", return_value=False),
            mock.patch.object(finalizer.os, "lstat", return_value=fake_stat),
        ):
            self.assertTrue(finalizer._is_link_or_reparse(Path("junction")))

    @unittest.skipUnless(os.name == "nt", "Windows junction regression")
    def test_verify_rejects_windows_junction_escape(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-junction")
        outside_spec = change_dir.parent / "outside-spec"
        shutil.move(str(change_dir / "spec"), str(outside_spec))
        junction = change_dir / "spec"
        created = subprocess.run(
            ["cmd.exe", "/c", "mklink", "/J", str(junction), str(outside_spec)],
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            self.skipTest(f"junction unavailable: {created.stderr or created.stdout}")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_FILE_PATH_INVALID")

    def test_verify_rejects_receipt_change_name_mismatch(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-name-mismatch")
        receipt_path = change_dir / "meta" / "plan-finalization.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["changeName"] = "../other"
        receipt_path.write_text(json.dumps(receipt) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_CHANGE_NAME_INVALID")

    def test_verify_fails_when_phase_start_missing(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-no-start")
        events_path = change_dir / "events.ndjson"
        kept = [
            line
            for line in events_path.read_text(encoding="utf-8").splitlines()
            if line.strip() and json.loads(line).get("type") != "phase.start"
        ]
        events_path.write_text("\n".join(kept) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PHASE_START_MISSING")

    def test_verify_fails_when_scenario_manifest_is_empty(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-empty-scenarios")
        manifest_path = change_dir / "meta" / "scenario-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["scenarios"] = []
        manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "SCENARIO_MANIFEST_EMPTY")

    def test_verify_fails_when_implementation_checkpoints_drop_tasks(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-task-drift")
        checkpoints_path = change_dir / "meta" / "implementation-checkpoints.json"
        checkpoints = json.loads(checkpoints_path.read_text(encoding="utf-8"))
        checkpoints["tasks"] = []
        checkpoints_path.write_text(json.dumps(checkpoints) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "IMPLEMENTATION_CHECKPOINTS_DRIFT")

    def test_verify_fails_when_checkpoint_task_content_drifts(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-task-content-drift")
        checkpoints_path = change_dir / "meta" / "implementation-checkpoints.json"
        checkpoints = json.loads(checkpoints_path.read_text(encoding="utf-8"))
        checkpoints["tasks"][0]["task"] = "tampered task"
        checkpoints_path.write_text(json.dumps(checkpoints) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "IMPLEMENTATION_CHECKPOINTS_DRIFT")

    def test_verify_fails_when_scenario_content_drifts(self) -> None:
        change_dir, _ = self._finalize_and_verify("verify-scenario-content-drift")
        manifest_path = change_dir / "meta" / "scenario-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["scenarios"][0]["scenario"] = "tampered scenario"
        manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")

        result = finalizer.verify_plan(change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "SCENARIO_MANIFEST_DRIFT")


if __name__ == "__main__":
    unittest.main()
