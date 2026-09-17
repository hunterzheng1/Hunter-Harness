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
from typing import Any
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
        "| UT-001 | P0 | approved behavior | unit test | execute |\n",
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


def publish_legacy_fixture(
    change_dir: Path, staging: Path, change: str,
    *, run_id: str = "plan-run", attempt: int = 1,
    events_path: Path | None = None,
) -> dict:
    """手工搭一份 legacy finalize 已发布的 change 目录（测试 fixture）。

    legacy finalize/republish 写侧已删除（roadmap 14）；verify 的 legacy-receipt
    读路径仍需覆盖，fixture 直接摆出发布终态：六项标准产物、两份派生清单、
    收据与 plan phase.start/end。
    """
    design = staging / "spec" / f"{change}-design.md"
    for rel in (
        f"spec/{change}-design.md",
        f"plans/{change}-plan.md",
        f"plans/{change}-implementation-detail.md",
        f"plans/{change}-test-scenarios.md",
        "meta/gate-policy.json",
        "meta/worktree.json",
    ):
        source = design if rel.startswith("spec/") else staging / rel
        write(change_dir / rel, source.read_text(encoding="utf-8"))

    tasks = finalizer.parse_plan_tasks(change_dir / "plans" / f"{change}-plan.md")
    (change_dir / "meta").mkdir(parents=True, exist_ok=True)
    (change_dir / "meta" / "implementation-checkpoints.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "changeName": change,
            "tasks": tasks,
            "foundationGate": "approved",
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    scenarios = finalizer.parse_test_scenarios(
        change_dir / "plans" / f"{change}-test-scenarios.md"
    )
    (change_dir / "meta" / "scenario-manifest.json").write_text(
        json.dumps({
            "schemaVersion": finalizer.scenario_manifest_schema_version(scenarios),
            "changeName": change,
            "scenarios": [
                {key: value for key, value in scenario.items()
                 if key != "executableMappingDeclared"}
                for scenario in scenarios
            ],
        }, indent=2) + "\n",
        encoding="utf-8",
    )

    files = sorted(finalizer._required_artifact_names(change))
    digest = hashlib.sha256()
    for rel in files:
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update((change_dir / rel).read_bytes())
        digest.update(b"\0")
    receipt = {
        "schemaVersion": 1,
        "changeName": change,
        "runId": run_id,
        "attempt": attempt,
        "status": "finalized",
        "files": files,
        "artifactsHash": "sha256:" + digest.hexdigest(),
    }
    (change_dir / "meta" / "plan-finalization.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    target_events = events_path or (change_dir / "events.ndjson")
    target_events.parent.mkdir(parents=True, exist_ok=True)
    with target_events.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({
            "schema_version": 3,
            "id": "evt-plan-end",
            "timestamp": "2026-07-28T20:05:00+08:00",
            "phase": "plan",
            "type": "phase.end",
            "run_id": run_id,
            "attempt": attempt,
            "status": "OK",
        }) + "\n")
    return {"ok": True, "artifactsHash": receipt["artifactsHash"], "files": files}






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
                    "| 1 | C1 | task one | execute | code done | execute |",
                    "| 2 | C2 | task two | execute | tests pass | execute |",
                ]),
            )

            tasks = finalizer.parse_plan_tasks(staging / "plans" / f"{change}-plan.md")
            self.assertEqual(len(tasks), 2)
            self.assertEqual(tasks[0]["ownerPhase"], "execute")
            self.assertEqual(tasks[0]["implementationDoneWhen"], "code done")
            self.assertEqual(tasks[0]["verificationPhase"], "execute")
            self.assertEqual(tasks[1]["ownerPhase"], "execute")

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





class ScenarioManifestTests(unittest.TestCase):
    """C9: parse_test_scenarios 场景表解析（读侧）。"""




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
            self.assertEqual(scenarios[0]["ownerPhase"], "execute")
            self.assertEqual(scenarios[0]["executionTier"], "affected")
            self.assertNotIn("executionTier", scenarios[2])





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
        finalize_result = publish_legacy_fixture(change_dir, staging, change)
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
            publish_legacy_fixture(change_dir, staging, change, events_path=routed_events)
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


class ScenarioDependencyContractTest(unittest.TestCase):
    """16-M1：场景级 DAG 依赖（depends_on）契约与波次派生。"""

    def test_parse_test_scenarios_reads_depends_column(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test-scenarios.md"
            write(path, "\n".join([
                "| ID | 场景 | 优先级 | 依赖 |",
                "| --- | --- | --- | --- |",
                "| UT-001 | 正常路径 | P0 | — |",
                "| UT-002 | 错误码 | P1 | UT-001, UT-003 |",
                "| UT-003 | 并发 | P2 | UT-001 |",
                "",
            ]))
            scenarios = finalizer.parse_test_scenarios(path)
            by_id = {item["id"]: item for item in scenarios}
            self.assertNotIn("dependsOn", by_id["UT-001"])
            self.assertEqual(by_id["UT-002"]["dependsOn"], ["UT-001", "UT-003"])
            self.assertEqual(by_id["UT-003"]["dependsOn"], ["UT-001"])

    def test_unpack_v2_manifest_carries_depends_on(self) -> None:
        wrapper = {
            "artifact_type": "scenario_manifest",
            "content": {
                "scenarios": [
                    {"scenario_id": "UT-001", "priority": "P0", "owner_phase": "execute",
                     "required_evidence_kind": "automated_test"},
                    {"scenario_id": "UT-002", "priority": "P1", "owner_phase": "execute",
                     "required_evidence_kind": "automated_test",
                     "depends_on": ["UT-001", " "]},
                    {"scenario_id": "UT-003", "priority": "P1", "owner_phase": "execute",
                     "required_evidence_kind": "automated_test", "depends_on": []},
                ]
            },
        }
        result = finalizer.unpack_v2_scenario_manifest(wrapper)
        self.assertIsNotNone(result)
        self.assertTrue(result["ok"])
        by_id = {item["id"]: item for item in result["manifest"]["scenarios"]}
        self.assertNotIn("dependsOn", by_id["UT-001"])
        self.assertEqual(by_id["UT-002"]["dependsOn"], ["UT-001"])
        # 空数组归一为缺省（canonical absence）
        self.assertNotIn("dependsOn", by_id["UT-003"])

    def test_compute_scenario_waves_layers(self) -> None:
        chain = [
            {"id": "A"},
            {"id": "B", "dependsOn": ["A"]},
            {"id": "C", "dependsOn": ["B"]},
        ]
        waves = finalizer.compute_scenario_waves(chain)
        self.assertTrue(waves["available"])
        self.assertEqual(waves["waves"], [["A"], ["B"], ["C"]])
        self.assertEqual(waves["waveCount"], 3)
        self.assertFalse(waves["parallelizable"])
        self.assertEqual(waves["declared"], 2)

        diamond = [
            {"id": "A"},
            {"id": "B", "dependsOn": ["A"]},
            {"id": "C", "dependsOn": ["A"]},
            {"id": "D", "dependsOn": ["B", "C"]},
        ]
        self.assertEqual(
            finalizer.compute_scenario_waves(diamond)["waves"],
            [["A"], ["B", "C"], ["D"]],
        )
        # 输入顺序不影响输出（确定性）
        self.assertEqual(
            finalizer.compute_scenario_waves(list(reversed(diamond)))["waves"],
            finalizer.compute_scenario_waves(diamond)["waves"],
        )

        flat = [{"id": "A"}, {"id": "B"}]
        flat_waves = finalizer.compute_scenario_waves(flat)
        self.assertEqual(flat_waves["waves"], [["A", "B"]])
        self.assertTrue(flat_waves["parallelizable"])
        self.assertEqual(flat_waves["declared"], 0)

    def test_compute_scenario_waves_degrades_on_cycle_and_unknown(self) -> None:
        cyclic = [{"id": "A", "dependsOn": ["B"]}, {"id": "B", "dependsOn": ["A"]}]
        bad = finalizer.compute_scenario_waves(cyclic)
        self.assertFalse(bad["available"])
        self.assertEqual(bad["reason"], "scenario-dependency-cycle")
        self.assertEqual(bad["cycleNodes"], ["A", "B"])

        unresolved = finalizer.compute_scenario_waves([{"id": "A", "dependsOn": ["ghost"]}])
        self.assertFalse(unresolved["available"])
        self.assertEqual(unresolved["reason"], "scenario-dependency-unresolved")
        self.assertEqual(unresolved["unknownRefs"], ["ghost"])

        empty = finalizer.compute_scenario_waves([])
        self.assertFalse(empty["available"])
        self.assertEqual(empty["reason"], "scenario-manifest-empty")


class WaveDispatchTests(unittest.TestCase):
    """16-M2：compute_wave_dispatch 波次派发计划（纯派生，确定性输出）。"""

    @staticmethod
    def _chain() -> list[dict[str, Any]]:
        return [
            {
                "id": "UT-001",
                "priority": "P0",
                "ownerPhase": "execute",
                "requiredEvidenceKind": "ledger",
                "testFile": "tests/test_a.py",
                "executableTestId": "test_a",
            },
            {
                "id": "UT-002",
                "priority": "P1",
                "ownerPhase": "execute",
                "requiredEvidenceKind": "automated_test",
                "dependsOn": ["UT-001"],
            },
            {
                "id": "UT-003",
                "priority": "P1",
                "ownerPhase": "execute",
                "requiredEvidenceKind": "automated_test",
                "testFile": "tests/test_a.py",
            },
        ]

    def test_no_completed_dispatches_first_wave_with_conflict_groups(self) -> None:
        dispatch = finalizer.compute_wave_dispatch(self._chain(), set())
        self.assertTrue(dispatch["available"])
        self.assertEqual(dispatch["phase"], "execute")
        self.assertEqual(dispatch["total"], 3)
        self.assertEqual(
            [group["wave"] for group in dispatch["runnableNow"]], [0]
        )
        self.assertEqual(
            [s["id"] for s in dispatch["runnableNow"][0]["scenarios"]],
            ["UT-001", "UT-003"],
        )
        # 同一波共享同一 testFile → 冲突组（并行实现须串行）
        self.assertEqual(dispatch["conflictGroups"], [["UT-001", "UT-003"]])
        self.assertEqual(
            dispatch["blocked"],
            [{"id": "UT-002", "wave": 1, "pendingDeps": ["UT-001"]}],
        )
        self.assertEqual(dispatch["completed"], [])
        self.assertEqual(dispatch["deferred"], [])
        self.assertFalse(dispatch["complete"])

    def test_completion_advances_dispatch_across_waves(self) -> None:
        scenarios = self._chain()
        first = finalizer.compute_wave_dispatch(scenarios, {"UT-001"})
        # UT-003（wave 0）与 UT-002（wave 1）同时就绪，按波次升序分组
        self.assertEqual([group["wave"] for group in first["runnableNow"]], [0, 1])
        self.assertEqual(
            [s["id"] for g in first["runnableNow"] for s in g["scenarios"]],
            ["UT-003", "UT-002"],
        )
        self.assertEqual(first["blocked"], [])
        self.assertEqual(first["completed"], ["UT-001"])
        self.assertEqual(first["conflictGroups"], [])

        second = finalizer.compute_wave_dispatch(scenarios, {"UT-001", "UT-003"})
        self.assertEqual(
            [s["id"] for s in second["runnableNow"][0]["scenarios"]], ["UT-002"]
        )

        done = finalizer.compute_wave_dispatch(
            scenarios, {"UT-001", "UT-002", "UT-003"}
        )
        self.assertTrue(done["complete"])
        self.assertEqual(done["runnableNow"], [])
        self.assertEqual(done["blocked"], [])

    def test_owner_phase_after_dispatch_phase_is_deferred_and_blocks_dependents(
        self,
    ) -> None:
        scenarios = [
            {"id": "UT-001", "ownerPhase": "execute"},
            {"id": "RV-001", "ownerPhase": "review"},
            {"id": "UT-002", "ownerPhase": "execute", "dependsOn": ["RV-001"]},
        ]
        dispatch = finalizer.compute_wave_dispatch(scenarios, set())
        self.assertEqual(dispatch["deferred"], ["RV-001"])
        self.assertEqual(
            [s["id"] for s in dispatch["runnableNow"][0]["scenarios"]], ["UT-001"]
        )
        # 依赖 deferred 场景 → fail-safe blocked
        self.assertEqual(
            dispatch["blocked"],
            [{"id": "UT-002", "wave": 1, "pendingDeps": ["RV-001"]}],
        )
        # RV-001 未完成 → UT-002 保持 blocked，execute 视角未收尾
        pending = finalizer.compute_wave_dispatch(scenarios, {"UT-001"})
        self.assertFalse(pending["complete"])
        # deferred 场景完成（review 阶段做完）后 UT-002 解锁；全部完成后 complete
        unblocked = finalizer.compute_wave_dispatch(scenarios, {"UT-001", "RV-001"})
        self.assertEqual(
            [s["id"] for s in unblocked["runnableNow"][0]["scenarios"]],
            ["UT-002"],
        )
        self.assertFalse(unblocked["complete"])
        done = finalizer.compute_wave_dispatch(
            scenarios, {"UT-001", "RV-001", "UT-002"}
        )
        self.assertTrue(done["complete"])

    def test_run_and_test_aliases_dispatch_as_execute(self) -> None:
        scenarios = [
            {"id": "X", "owner_phase": "run"},
            {"id": "Y", "ownerPhase": "test"},
        ]
        dispatch = finalizer.compute_wave_dispatch(scenarios, set())
        self.assertEqual(dispatch["deferred"], [])
        self.assertEqual(
            [s["id"] for s in dispatch["runnableNow"][0]["scenarios"]], ["X", "Y"]
        )
        # 未知 ownerPhase 视为当期应做（镜像 gate 语义）
        unknown = finalizer.compute_wave_dispatch(
            [{"id": "Z", "ownerPhase": "bogus"}], set()
        )
        self.assertEqual(unknown["deferred"], [])

    def test_dependency_problems_degrade_like_waves(self) -> None:
        cycle = finalizer.compute_wave_dispatch(
            [{"id": "A", "dependsOn": ["B"]}, {"id": "B", "dependsOn": ["A"]}],
            set(),
        )
        self.assertFalse(cycle["available"])
        self.assertEqual(cycle["reason"], "scenario-dependency-cycle")
        self.assertEqual(cycle["runnableNow"], [])
        self.assertEqual(cycle["blocked"], [])
        self.assertFalse(cycle["complete"])

        unresolved = finalizer.compute_wave_dispatch(
            [{"id": "A", "dependsOn": ["ghost"]}], set()
        )
        self.assertFalse(unresolved["available"])
        self.assertEqual(unresolved["reason"], "scenario-dependency-unresolved")
        self.assertEqual(unresolved["total"], 1)

        empty = finalizer.compute_wave_dispatch([], set())
        self.assertFalse(empty["available"])
        self.assertEqual(empty["reason"], "scenario-manifest-empty")

    def test_unknown_completed_ids_ignored_and_output_deterministic(self) -> None:
        scenarios = self._chain()
        first = finalizer.compute_wave_dispatch(scenarios, {"ghost", "UT-001"})
        second = finalizer.compute_wave_dispatch(scenarios, ["UT-001", "ghost"])
        self.assertEqual(first["completed"], ["UT-001"])
        self.assertEqual(
            json.dumps(first, sort_keys=True),
            json.dumps(second, sort_keys=True),
        )
        # 重复调用输出逐字节一致（json sort_keys 归一）
        self.assertEqual(
            json.dumps(first, sort_keys=True),
            json.dumps(
                finalizer.compute_wave_dispatch(scenarios, {"UT-001"}),
                sort_keys=True,
            ),
        )
        # 非集合入参容错
        degraded = finalizer.compute_wave_dispatch(scenarios, "not-a-set")
        self.assertTrue(degraded["available"])
        self.assertEqual(degraded["completed"], [])


if __name__ == "__main__":
    unittest.main()


class PlanVerifyV2Tests(unittest.TestCase):
    """v2 finalizer（TS）证据路径：无 legacy receipt 时的结构验收。"""

    @staticmethod
    def _v2_payload(change: str, rel: str) -> bytes:
        """真实形状的 v2 产物字节。

        以前这里对每个 target 都写字面量 ``f"{change}:{rel}\\n"`` —— `meta/*.json`
        连合法 JSON 都不是，测试照样通过，因为 verify_plan 只比对 journal 哈希。
        于是 "v2 发布覆盖 Python 门禁文件" 这类问题在 Python 侧完全看不见。
        """
        if not rel.endswith(".json"):
            return (f"{change}:{rel}\n").encode("utf-8")
        artifact_type = Path(rel).stem.replace("-", "_")
        content: dict[str, Any] = {
            "plan_profile": {"mode": "standard", "capabilities": [],
                             "planned_phases": ["plan", "execute", "submit", "archive"],
                             "required_validations": ["deterministic_check"]},
            "worktree": {"policy": "project_default", "requested": False},
            "implementation_checkpoints": {"tasks": [], "foundation_gate": "approved"},
            "scenario_manifest": {"scenarios": [], "coverage": []},
        }.get(artifact_type, {})
        return (json.dumps({
            "schema_version": 2,
            "artifact_type": artifact_type,
            "artifact_id": f"plan_artifact:{artifact_type}:{'a' * 64}",
            "generator_version": "hunter-harness-plan-artifacts/3",
            "content_hash": "sha256:" + "a" * 64,
            "source_hashes": {},
            "content": content,
        }, sort_keys=True) + "\n").encode("utf-8")

    def _seed_v2_change(self, change: str = "v2-demo") -> tuple[Path, Path, dict]:
        root = Path(tempfile.mkdtemp(prefix="plan-verify-v2-"))
        change_dir = root / ".harness" / "changes" / change
        plans = change_dir / "plans"
        meta = change_dir / "meta"
        plans.mkdir(parents=True)
        meta.mkdir(parents=True)
        targets = [
            f"plans/{change}-design.md",
            f"plans/{change}-plan.md",
            f"plans/{change}-implementation-detail.md",
            f"plans/{change}-test-scenarios.md",
            # v2 发布的是派生视图 plan-profile，不占用 Python classify 写的
            # meta/gate-policy.json——后者是 run/test 门禁的权威输入。
            "meta/plan-profile.json",
            "meta/worktree.json",
            "meta/implementation-checkpoints.json",
            "meta/scenario-manifest.json",
        ]
        payload_hashes = {}
        for rel in targets:
            content = self._v2_payload(change, rel)
            (change_dir / rel).write_bytes(content)
            payload_hashes[rel] = "sha256:" + hashlib.sha256(content).hexdigest()
        operation_id = f"plan_finalize:{change}:abc123"
        journal = {
            "schema_version": 1,
            "operation_id": operation_id,
            "state": "committed",
            "readback": "verified",
            "binding": {
                "ownership_paths": targets,
                "expected_payload_hashes": payload_hashes,
            },
        }
        journal_dir = meta / "publication-journals"
        journal_dir.mkdir()
        (journal_dir / f"{operation_id.replace(':', '%3A')}.json").write_text(
            json.dumps(journal), encoding="utf-8"
        )
        transaction = {
            "schema_version": 1,
            "operation_id": operation_id,
            "change_key": change,
            "status": "publication_committed_event_complete",
            "run_id": "plan_runv2",
            "attempt": 1,
        }
        transactions_dir = meta / "plan-finalization-transactions"
        transactions_dir.mkdir()
        (transactions_dir / f"{operation_id.replace(':', '%3A')}.json").write_text(
            json.dumps(transaction), encoding="utf-8"
        )
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        return change_dir, meta, payload_hashes

    def test_v2_committed_journal_verifies(self) -> None:
        change_dir, _meta, _hashes = self._seed_v2_change()
        result = finalizer.verify_plan(change_dir)
        self.assertTrue(result["ok"], msg=result)
        self.assertEqual(result["code"], "PLAN_V2_VERIFIED")
        self.assertTrue(result["v2"])

    def test_v2_artifact_drift_fails_closed(self) -> None:
        change_dir, _meta, _hashes = self._seed_v2_change()
        target = change_dir / "meta" / "worktree.json"
        target.write_bytes(b"tampered")
        result = finalizer.verify_plan(change_dir)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ARTIFACT_HASH_DRIFT")

    def test_v2_uncommitted_transaction_rejected(self) -> None:
        change_dir, meta, _hashes = self._seed_v2_change()
        transactions_dir = meta / "plan-finalization-transactions"
        for path in transactions_dir.glob("*.json"):
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["status"] = "publication_staged"
            path.write_text(json.dumps(payload), encoding="utf-8")
        result = finalizer.verify_plan(change_dir)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_NOT_FINALIZED")

    def test_v2_missing_journal_rejected(self) -> None:
        change_dir, meta, _hashes = self._seed_v2_change()
        for path in (meta / "publication-journals").glob("*.json"):
            path.unlink()
        result = finalizer.verify_plan(change_dir)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PUBLICATION_JOURNAL_MISSING")


