#!/usr/bin/env python3
"""10-M3 需求歧义 Clarify 前置步测试。

覆盖阶段 10 文档锁定的测试矩阵：
- 空 objective 拒绝（intent.goal / task.objective）；
- scenario/task 悬空引用拒绝（task_refs / depends_on / scenario_refs / requirement_refs）；
- 不可测验收条件拒绝（acceptance 判据为空 / evidence_requirements 观察点为空）；
- 确认清单未闭环阻断 finalize（plan 关门 fail-closed）、确认完成后放行；
- 每次 plan 至多一次扫描（幂等重放 / 预算 ≤5 条）、答案闭包；
- fast 档跳过语义；off 回滚；存量无报告兼容放行（not_required）。
"""

from __future__ import annotations

import contextlib
import io
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
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_clarify as hcl  # noqa: E402
import harness_gate as gate  # noqa: E402
import harness_plan_finalize as hpf  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent.parent
CLARIFY_ENV = "HUNTER_HARNESS_CLARIFY_GATE_MODE"
KNOWLEDGE_ENV = "HUNTER_HARNESS_KNOWLEDGE_GATE_MODE"


def _pei(**overrides: object) -> dict:
    """一份静态干净的 standard 档 plan-evidence-input 草稿。"""
    document: dict = {
        "change_key": "demo",
        "structured_input": {
            "tasks": [
                {
                    "task_id": "t1",
                    "objective": "实现需求澄清门禁",
                    "affected_paths": ["harness/scripts/harness_clarify.py"],
                    "owner_phase": "execute",
                }
            ],
            "scenarios": [
                {
                    "scenario_id": "s1",
                    "title": "澄清闭环后放行",
                    "acceptance": "答案闭包后 plan 关门放行",
                    "coverage_dimension": "functional",
                    "execution_level": "L0",
                    "evidence_requirements": ["python 测试全绿"],
                    "risk_level": "P1",
                    "priority": 1,
                    "owner_phase": "verify",
                    "task_refs": ["t1"],
                    "requirement_refs": ["r1"],
                }
            ],
            "requirements": [
                {"requirement_id": "r1", "kind": "functional", "text": "澄清闭环"}
            ],
        },
        "intent": {"goal": "让需求有唯一可执行解释", "source_input": "用户要做澄清门禁"},
    }
    for key, value in overrides.items():
        document[key] = value
    return document


class ClarifyCase(unittest.TestCase):
    """带 .harness/changes/demo 布局 + standard 档写入能力的基座。"""

    def setUp(self) -> None:
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        os.environ.pop(CLARIFY_ENV, None)
        os.environ.pop(KNOWLEDGE_ENV, None)
        self.project = Path(tempfile.mkdtemp(prefix="harness-clarify-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)

    def _set_policy(self, **fields: object) -> None:
        policy = {"schemaVersion": 1, **fields}
        meta = self.change_dir / "meta"
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "gate-policy.json").write_text(
            json.dumps(policy, indent=2) + "\n", encoding="utf-8"
        )

    def _write_pei(self, document: dict | None = None) -> Path:
        path = self.change_dir / "meta" / "plan-evidence-input.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(document if document is not None else _pei(), indent=2) + "\n",
            encoding="utf-8",
        )
        return path

    def _check(self) -> dict:
        return hcl.run_check(self.change_dir)

    def _scan(self, questions: list) -> dict:
        return hcl.record_scan(
            self.change_dir, {"schema_version": 1, "questions": questions}
        )

    def _confirm(self, answers: list[dict]) -> dict:
        return hcl.record_confirmations(
            self.change_dir, {"schema_version": 1, "answers": answers}
        )

    def _validate(self) -> dict:
        return hcl.validate_clarify_gate(self.project, self.change_dir)

    def _report(self) -> dict:
        return json.loads(
            (self.change_dir / "meta" / "clarify-report.json").read_text(
                encoding="utf-8"
            )
        )


class ClarifyGateModeTests(ClarifyCase):
    def test_default_is_strict(self) -> None:
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "strict")

    def test_change_policy_off(self) -> None:
        self._set_policy(clarifyGateMode="off")
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "off")

    def test_project_config_off(self) -> None:
        config = self.project / ".harness" / "config" / "gate-policy.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(
            '{"schemaVersion": 1, "clarifyGateMode": "off"}\n', encoding="utf-8"
        )
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "off")

    def test_change_beats_project(self) -> None:
        config = self.project / ".harness" / "config" / "gate-policy.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(
            '{"schemaVersion": 1, "clarifyGateMode": "off"}\n', encoding="utf-8"
        )
        self._set_policy(clarifyGateMode="strict")
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "strict")

    def test_env_beats_everything(self) -> None:
        self._set_policy(clarifyGateMode="off")
        os.environ[CLARIFY_ENV] = "strict"
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "strict")

    def test_invalid_values_are_ignored(self) -> None:
        self._set_policy(clarifyGateMode="warn")  # 没有 warn 档：回滚语义是关闭
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "strict")
        os.environ[CLARIFY_ENV] = "bogus"
        self.assertEqual(hcl.clarify_gate_mode(self.project, self.change_dir), "strict")


class ClarifyTierTests(ClarifyCase):
    def test_no_policy_defaults_to_fast(self) -> None:
        self.assertEqual(hcl.clarify_tier(self.change_dir), "fast")

    def test_working_copy_tier_and_case_insensitive(self) -> None:
        self._set_policy(tier="Standard")
        self.assertEqual(hcl.clarify_tier(self.change_dir), "standard")

    def test_unknown_tier_defaults_to_fast(self) -> None:
        self._set_policy(tier="enterprise")
        self.assertEqual(hcl.clarify_tier(self.change_dir), "fast")

    def test_v2_plan_profile_tier_wins(self) -> None:
        wrapper = {
            "artifact_type": "gate_policy",
            "content": {
                "mode": "change",
                "tier": "full",
                "planned_phases": ["plan", "execute"],
                "required_gate_dag": {},
                "required_validations_by_phase": {},
            },
        }
        (self.change_dir / "meta").mkdir(parents=True, exist_ok=True)
        (self.change_dir / "meta" / "plan-profile.json").write_text(
            json.dumps(wrapper, indent=2) + "\n", encoding="utf-8"
        )
        self._set_policy(tier="standard")
        self.assertEqual(hcl.clarify_tier(self.change_dir), "full")


class StaticCheckTests(ClarifyCase):
    def setUp(self) -> None:
        super().setUp()
        self._set_policy(tier="standard")

    def test_clean_pei_passes_and_writes_snake_case_report(self) -> None:
        self._write_pei()
        result = self._check()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "passed")
        report = self._report()
        self.assertEqual(report["schema_version"], 1)
        self.assertEqual(report["change_key"], "demo")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["tier"], "standard")
        self.assertTrue(report["plan_evidence_input_hash"].startswith("sha256:"))
        self.assertIsNone(report["scan"])
        self.assertEqual(
            [check["check_id"] for check in report["checks"]],
            [
                "intent_goal_present",
                "task_objective_present",
                "scenario_task_refs_closed",
                "requirement_refs_closed",
                "acceptance_testable",
            ],
        )
        self.assertTrue(all(check["ok"] for check in report["checks"]))

    def test_empty_intent_goal_is_rejected(self) -> None:
        self._write_pei(_pei(intent={"goal": "  ", "source_input": "x"}))
        result = self._check()
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "failed")
        defect = result["defects"][0]
        self.assertEqual(defect["code"], "CLARIFY_OBJECTIVE_EMPTY")
        self.assertEqual(defect["field_path"], "intent.goal")

    def test_missing_intent_section_is_rejected(self) -> None:
        document = _pei()
        document.pop("intent")
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        self.assertEqual(result["defects"][0]["field_path"], "intent.goal")

    def test_empty_task_objective_is_rejected(self) -> None:
        document = _pei()
        document["structured_input"]["tasks"][0]["objective"] = ""
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        defect = result["defects"][0]
        self.assertEqual(defect["code"], "CLARIFY_OBJECTIVE_EMPTY")
        self.assertEqual(
            defect["field_path"], "structured_input.tasks[0].objective"
        )

    def test_dangling_scenario_task_ref_is_rejected(self) -> None:
        document = _pei()
        document["structured_input"]["scenarios"][0]["task_refs"] = ["t1", "t_ghost"]
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        defect = result["defects"][0]
        self.assertEqual(defect["code"], "CLARIFY_REF_DANGLING")
        self.assertEqual(
            defect["field_path"],
            "structured_input.scenarios[0].task_refs[1]",
        )

    def test_dangling_task_depends_on_is_rejected(self) -> None:
        document = _pei()
        document["structured_input"]["tasks"][0]["depends_on"] = ["t_ghost"]
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        self.assertIn("depends_on[0]", result["defects"][0]["field_path"])

    def test_dangling_requirement_ref_is_rejected(self) -> None:
        document = _pei()
        document["structured_input"]["scenarios"][0]["requirement_refs"] = ["r_ghost"]
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        defect = result["defects"][0]
        self.assertEqual(defect["code"], "CLARIFY_REF_DANGLING")
        self.assertIn("requirement_refs[0]", defect["field_path"])

    def test_requirement_refs_unresolvable_when_section_absent(self) -> None:
        document = _pei()
        document["structured_input"].pop("requirements")
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        self.assertEqual(result["defects"][0]["code"], "CLARIFY_REF_DANGLING")

    def test_empty_acceptance_is_rejected(self) -> None:
        document = _pei()
        document["structured_input"]["scenarios"][0]["acceptance"] = "  "
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        defect = result["defects"][0]
        self.assertEqual(defect["code"], "CLARIFY_ACCEPTANCE_UNTESTABLE")
        self.assertIn("acceptance", defect["field_path"])

    def test_empty_evidence_requirements_is_rejected(self) -> None:
        document = _pei()
        document["structured_input"]["scenarios"][0]["evidence_requirements"] = []
        self._write_pei(document)
        result = self._check()
        self.assertFalse(result["ok"])
        defect = result["defects"][0]
        self.assertEqual(defect["code"], "CLARIFY_ACCEPTANCE_UNTESTABLE")
        self.assertIn("evidence_requirements", defect["field_path"])

    def test_fast_tier_check_is_not_required(self) -> None:
        self._set_policy(tier="fast")
        self._write_pei()
        result = self._check()
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "not_required")

    def test_missing_pei_check_is_not_required(self) -> None:
        result = self._check()
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "not_required")

    def test_check_rebase_preserves_scan_and_answers(self) -> None:
        self._write_pei()
        self.assertTrue(self._check()["ok"])
        scan = self._scan(["缓存策略是 Write-Through 还是 Cache-Aside？"])
        self.assertTrue(scan["ok"], scan)
        confirmation_id = scan["confirmationIds"][0]
        confirmed = self._confirm(
            [{"confirmation_id": confirmation_id, "answer": "Cache-Aside"}]
        )
        self.assertEqual(confirmed["status"], "passed")
        # PEI 修订后重跑 check：哈希 rebase，扫描与答案保留。
        document = _pei()
        document["structured_input"]["tasks"][0]["objective"] = "修订后的目标"
        self._write_pei(document)
        rebased = self._check()
        self.assertTrue(rebased["ok"], rebased)
        report = self._report()
        self.assertEqual(report["status"], "passed")
        self.assertEqual(
            report["scan"]["confirmations"][0]["answer"], "Cache-Aside"
        )


class RecordScanTests(ClarifyCase):
    def setUp(self) -> None:
        super().setUp()
        self._set_policy(tier="standard")
        self._write_pei()
        self.assertTrue(self._check()["ok"])

    def test_scan_records_pending_confirmations(self) -> None:
        result = self._scan(["缓存策略是 Write-Through 还是 Cache-Aside？"])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "CLARIFY_SCAN_RECORDED")
        self.assertEqual(result["status"], "confirmations_required")
        self.assertEqual(len(result["confirmationIds"]), 1)
        self.assertTrue(
            result["confirmationIds"][0].startswith("clarify_confirm:")
        )
        report = self._report()
        self.assertEqual(report["status"], "confirmations_required")
        self.assertTrue(report["scan"]["scan_id"].startswith("clarify_scan:"))
        self.assertEqual(report["scan"]["confirmations"][0]["status"], "pending")

    def test_zero_question_scan_is_passed_evidence(self) -> None:
        # 「扫过了，零歧义」也是留证：空清单直接 passed。
        result = self._scan([])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(self._report()["status"], "passed")

    def test_identical_scan_is_idempotent_replay(self) -> None:
        questions = ["问题一？"]
        first = self._scan(questions)
        self.assertTrue(first["ok"])
        again = self._scan(questions)
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["code"], "CLARIFY_SCAN_REPLAYED")
        self.assertTrue(again["replayed"])

    def test_different_scan_is_rejected_one_scan_per_plan(self) -> None:
        self.assertTrue(self._scan(["问题一？"])["ok"])
        rejected = self._scan(["另一个问题？"])
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["code"], "CLARIFY_SCAN_ALREADY_RECORDED")

    def test_budget_is_five_confirmations(self) -> None:
        result = self._scan([f"问题 {index}？" for index in range(6)])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_SCAN_BUDGET_EXCEEDED")
        ok = self._scan([f"问题 {index}？" for index in range(5)])
        self.assertTrue(ok["ok"], ok)

    def test_empty_question_is_rejected(self) -> None:
        result = self._scan(["  "])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_SCAN_INVALID")

    def test_scan_requires_report(self) -> None:
        (self.change_dir / "meta" / "clarify-report.json").unlink()
        result = self._scan(["问题？"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_REPORT_MISSING")

    def test_scan_requires_pei(self) -> None:
        (self.change_dir / "meta" / "plan-evidence-input.json").unlink()
        result = self._scan(["问题？"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_INPUT_MISSING")

    def test_scan_rejected_when_report_stale(self) -> None:
        self._write_pei(_pei(intent={"goal": "改过的目标", "source_input": "x"}))
        result = self._scan(["问题？"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_REPORT_STALE")
        # 重跑 check rebase 后扫描恢复可用。
        self.assertTrue(self._check()["ok"])
        self.assertTrue(self._scan(["问题？"])["ok"])


class ConfirmTests(ClarifyCase):
    def setUp(self) -> None:
        super().setUp()
        self._set_policy(tier="standard")
        self._write_pei()
        self.assertTrue(self._check()["ok"])
        scan = self._scan(["问题一？", "问题二？"])
        self.assertTrue(scan["ok"], scan)
        self.id_one, self.id_two = scan["confirmationIds"]

    def test_full_closure_turns_passed(self) -> None:
        result = self._confirm([
            {"confirmation_id": self.id_one, "answer": "答案一"},
            {"confirmation_id": self.id_two, "answer": "答案二"},
        ])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["answeredCount"], 2)
        self.assertEqual(result["pendingConfirmationIds"], [])
        report = self._report()
        self.assertEqual(report["status"], "passed")
        self.assertEqual(
            report["scan"]["confirmations"][0]["answer"], "答案一"
        )
        self.assertTrue(report["scan"]["confirmations"][0]["answered_at"])

    def test_partial_closure_stays_confirmations_required(self) -> None:
        result = self._confirm([{"confirmation_id": self.id_one, "answer": "答案一"}])
        self.assertEqual(result["status"], "confirmations_required")
        self.assertEqual(result["pendingConfirmationIds"], [self.id_two])

    def test_unknown_confirmation_id_is_rejected(self) -> None:
        forged = "clarify_confirm:" + ("f" * 64)
        result = self._confirm([{"confirmation_id": forged, "answer": "x"}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_CONFIRMATION_UNKNOWN")

    def test_empty_answer_is_rejected(self) -> None:
        result = self._confirm([{"confirmation_id": self.id_one, "answer": "  "}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_CONFIRM_INVALID")

    def test_answer_overwrite_is_allowed(self) -> None:
        self.assertTrue(
            self._confirm([{"confirmation_id": self.id_one, "answer": "旧答案"}])["ok"]
        )
        self.assertTrue(
            self._confirm([{"confirmation_id": self.id_one, "answer": "新答案"}])["ok"]
        )
        report = self._report()
        answers = {
            item["confirmation_id"]: item["answer"]
            for item in report["scan"]["confirmations"]
        }
        self.assertEqual(answers[self.id_one], "新答案")

    def test_confirm_requires_scan(self) -> None:
        other = self.project / ".harness" / "changes" / "other"
        # 干净 change：只有 PEI + check，无扫描。
        meta = other / "meta"
        meta.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            self.change_dir / "meta" / "gate-policy.json", meta / "gate-policy.json"
        )
        shutil.copy2(
            self.change_dir / "meta" / "plan-evidence-input.json",
            meta / "plan-evidence-input.json",
        )
        document = json.loads(
            (meta / "plan-evidence-input.json").read_text(encoding="utf-8")
        )
        document["change_key"] = "other"
        (meta / "plan-evidence-input.json").write_text(
            json.dumps(document, indent=2) + "\n", encoding="utf-8"
        )
        self.assertTrue(hcl.run_check(other)["ok"])
        result = hcl.record_confirmations(
            other,
            {"schema_version": 1, "answers": [{"confirmation_id": self.id_one, "answer": "x"}]},
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_SCAN_MISSING")


class ValidateClarifyGateTests(ClarifyCase):
    def setUp(self) -> None:
        super().setUp()
        self._set_policy(tier="standard")
        self._write_pei()

    def test_fast_tier_is_skipped(self) -> None:
        self._set_policy(tier="fast")
        result = self._validate()
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_SKIPPED")
        self.assertTrue(result["skipped"])

    def test_mode_off_disables_gate(self) -> None:
        self._set_policy(tier="standard", clarifyGateMode="off")
        result = self._validate()
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_DISABLED")

    def test_missing_pei_is_not_required(self) -> None:
        (self.change_dir / "meta" / "plan-evidence-input.json").unlink()
        result = self._validate()
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_NOT_REQUIRED")

    def test_compat_missing_report_passes_when_static_clean(self) -> None:
        # 存量 change：无报告、静态干净 → not_required 放行（10-M3 兼容读取）。
        result = self._validate()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "CLARIFY_GATE_NOT_REQUIRED")
        self.assertTrue(result["compat"])

    def test_static_defects_block_even_without_report(self) -> None:
        # fail-closed：报告缺席不是绕过静态检查的后门。
        document = _pei()
        document["structured_input"]["tasks"][0]["objective"] = ""
        self._write_pei(document)
        result = self._validate()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_STATIC_FAILED")
        self.assertEqual(result["defects"][0]["code"], "CLARIFY_OBJECTIVE_EMPTY")

    def test_invalid_report_shape_is_rejected(self) -> None:
        self.assertTrue(self._check()["ok"])
        report = self._report()
        report["status"] = "totally_fine"
        (self.change_dir / "meta" / "clarify-report.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
        result = self._validate()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_REPORT_INVALID")

    def test_cross_change_report_is_rejected(self) -> None:
        self.assertTrue(self._check()["ok"])
        report = self._report()
        report["change_key"] = "other"
        (self.change_dir / "meta" / "clarify-report.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
        result = self._validate()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_REPORT_INVALID")

    def test_stale_report_after_pei_edit_is_rejected(self) -> None:
        self.assertTrue(self._check()["ok"])
        document = _pei()
        document["structured_input"]["tasks"][0]["objective"] = "修订后的目标"
        self._write_pei(document)
        result = self._validate()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_REPORT_STALE")
        # rebase 后放行。
        self.assertTrue(self._check()["ok"])
        self.assertTrue(self._validate()["ok"])

    def test_pending_confirmations_block_with_ids(self) -> None:
        self.assertTrue(self._check()["ok"])
        scan = self._scan(["问题一？", "问题二？"])
        self.assertTrue(scan["ok"])
        result = self._validate()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_CONFIRMATIONS_OPEN")
        self.assertEqual(len(result["pendingConfirmationIds"]), 2)

    def test_full_closure_passes_gate(self) -> None:
        self.assertTrue(self._check()["ok"])
        scan = self._scan(["问题一？"])
        self.assertTrue(
            self._confirm(
                [{"confirmation_id": scan["confirmationIds"][0], "answer": "定了"}]
            )["ok"]
        )
        result = self._validate()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "CLARIFY_GATE_OK")
        self.assertEqual(result["reportStatus"], "passed")
        self.assertEqual(result["confirmationCount"], 1)
        self.assertEqual(result["answeredCount"], 1)

    def test_invalid_pei_json_is_fail_closed(self) -> None:
        (self.change_dir / "meta" / "plan-evidence-input.json").write_text(
            "{oops", encoding="utf-8"
        )
        result = self._validate()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CLARIFY_GATE_INPUT_INVALID")


class VerifyAttachTests(ClarifyCase):
    def setUp(self) -> None:
        super().setUp()
        self._set_policy(tier="standard")
        self._write_pei()

    def test_failed_result_is_not_decorated(self) -> None:
        failed = {"ok": False, "code": "RECEIPT_MISSING"}
        self.assertIs(hpf._with_clarify_verdict(self.change_dir, failed), failed)

    def test_clarify_verdict_attached_read_only(self) -> None:
        self.assertTrue(self._check()["ok"])
        scan = self._scan(["问题一？"])
        self.assertTrue(scan["ok"])
        result = hpf._with_clarify_verdict(
            self.change_dir, {"ok": True, "action": "verify"}, self.project
        )
        self.assertTrue(result["ok"])  # 未闭环也只读，不翻转 verify 的 ok
        self.assertFalse(result["clarifyGate"]["ok"])
        self.assertEqual(
            result["clarifyGate"]["code"], "CLARIFY_GATE_CONFIRMATIONS_OPEN"
        )


class PlanCloseClarifyGateTests(unittest.TestCase):
    """close --phase plan 端到端接线：strict 阻断、闭环放行、fast 豁免、off 回滚。

    knowledge gate 与 clarify gate 同挂 plan 关门且 knowledge 先跑；standard 档
    用例会先录知识收据，确保被测的是 clarify 门禁。
    """

    def setUp(self) -> None:
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        os.environ.pop(CLARIFY_ENV, None)
        os.environ.pop(KNOWLEDGE_ENV, None)
        self.project = Path(tempfile.mkdtemp(prefix="harness-clarify-close-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)
        (self.project / ".harness" / "project.yaml").write_text(
            "project:\n  project_id: prj_demo\n", encoding="utf-8"
        )
        self._write_checkpoints("approved")
        policy_target = self.project / "harness" / "contracts" / "workflow-policy.json"
        policy_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            REPO_ROOT / "harness" / "contracts" / "workflow-policy.json", policy_target
        )
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.project, check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=self.project, check=True, capture_output=True,
        )
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"], cwd=self.project, check=True, capture_output=True
        )

    def _write_checkpoints(self, status: str) -> None:
        payload = {
            "schemaVersion": 1,
            "changeName": "demo",
            "checkpoints": [
                {
                    "id": "foundation-gate",
                    "afterTasks": [1, 2, 3, 4],
                    "beforeTasks": [6, 7, 8, 9, 10],
                    "status": status,
                    "blocking": True,
                    "reviewerTool": "codex",
                    "requiredReport": "reports/review/foundation-gate-review.md",
                }
            ],
        }
        path = self.change_dir / "meta" / "implementation-checkpoints.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def _set_policy(self, **fields: object) -> None:
        policy = {"schemaVersion": 1, **fields}
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps(policy, indent=2) + "\n", encoding="utf-8"
        )

    def _write_pei(self, document: dict | None = None) -> None:
        (self.change_dir / "meta" / "plan-evidence-input.json").write_text(
            json.dumps(document if document is not None else _pei(), indent=2) + "\n",
            encoding="utf-8",
        )

    def _record_knowledge_receipt(self) -> None:
        # 载荷形状与 test_harness_knowledge_gate._payload 同口径；plan 关门时
        # knowledge gate 先跑，standard 档须先留知识收据才能测到 clarify 门禁。
        query_hex = "a" * 64
        result = hpf.record_knowledge_receipt(
            self.change_dir,
            {
                "schema_version": 1,
                "command": "knowledge query",
                "ok": True,
                "exit_code": 0,
                "source": "remote",
                "fallback": False,
                "project_id": "prj_demo",
                "query_id": "knowledge_query:" + query_hex,
                "receipt": {
                    "schema_version": 1,
                    "receipt_id": "knowledge_query_receipt:" + ("b" * 64),
                    "query_hash": "sha256:" + query_hex,
                    "project_id": "prj_demo",
                    "index_generation": "gen-1",
                    "result_ids": ["res_0"],
                    "source_versions": ["v1"],
                    "result_set_hash": "sha256:" + ("9" * 64),
                    "status": "succeeded",
                    "executed_at": "2026-09-17T00:00:00Z",
                    "reason_code": "initial_intent",
                },
                "query": "harness gate knowledge query",
                "count": 1,
                "items": [],
                "request_id": "req_1",
            },
        )
        self.assertTrue(result["ok"], result)

    def _close_args(self) -> object:
        return gate.build_parser().parse_args([
            "close", "--phase", "plan", "--change", "demo", "--run-id", "run-1",
            "--status", "OK", "--json",
        ])

    def _run_close(self, args: object) -> tuple[int, dict | None, str]:
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        out, err = io.StringIO(), io.StringIO()
        self.last_blocked: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "plan"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True, "code": "LEDGER_OK"}), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(
                 gate,
                 "record_gate_blocked",
                 side_effect=lambda *a, **k: (self.last_blocked.append(k) or {"ok": True}),
             ), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gate.cmd_close(args)
        payload = None
        if out.getvalue().strip():
            payload = json.loads(out.getvalue())
        return code, payload, err.getvalue()

    def test_pending_confirmations_block_plan_close(self) -> None:
        self._set_policy(tier="standard")
        self._write_pei()
        self.assertTrue(hcl.run_check(self.change_dir)["ok"])
        scan = hcl.record_scan(
            self.change_dir,
            {"schema_version": 1, "questions": ["缓存策略是 Write-Through 还是 Cache-Aside？"]},
        )
        self.assertTrue(scan["ok"], scan)
        self._record_knowledge_receipt()
        code, payload, err = self._run_close(self._close_args())
        self.assertEqual(code, 1)
        self.assertIsNone(payload)
        failure = json.loads(err.strip().splitlines()[-1])
        self.assertEqual(failure["code"], "CLARIFY_GATE_CONFIRMATIONS_OPEN")
        self.assertEqual(len(self.last_blocked), 1)
        self.assertEqual(
            self.last_blocked[0]["code"], "CLARIFY_GATE_CONFIRMATIONS_OPEN"
        )
        self.assertEqual(self.last_blocked[0]["phase"], "plan")
        self.assertEqual(len(failure["pendingConfirmationIds"]), 1)
        # 确认清单闭环后放行。
        confirmed = hcl.record_confirmations(
            self.change_dir,
            {
                "schema_version": 1,
                "answers": [
                    {
                        "confirmation_id": scan["confirmationIds"][0],
                        "answer": "Cache-Aside",
                    }
                ],
            },
        )
        self.assertTrue(confirmed["ok"], confirmed)
        self.assertEqual(confirmed["status"], "passed")
        code, payload, _ = self._run_close(self._close_args())
        self.assertEqual(code, 0, err)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["clarifyGate"]["code"], "CLARIFY_GATE_OK")

    def test_clean_pei_without_report_passes_close_as_compat(self) -> None:
        # 兼容读取：PEI 静态干净 + 无报告 → not_required 放行。
        self._set_policy(tier="standard")
        self._write_pei()
        self._record_knowledge_receipt()
        code, payload, err = self._run_close(self._close_args())
        self.assertEqual(code, 0, err)
        self.assertIsNotNone(payload)
        self.assertEqual(
            payload["clarifyGate"]["code"], "CLARIFY_GATE_NOT_REQUIRED"
        )
        self.assertTrue(payload["clarifyGate"]["compat"])

    def test_static_defects_block_plan_close(self) -> None:
        self._set_policy(tier="standard")
        document = _pei()
        document["structured_input"]["scenarios"][0]["acceptance"] = ""
        self._write_pei(document)
        self._record_knowledge_receipt()
        code, payload, err = self._run_close(self._close_args())
        self.assertEqual(code, 1)
        self.assertIsNone(payload)
        failure = json.loads(err.strip().splitlines()[-1])
        self.assertEqual(failure["code"], "CLARIFY_GATE_STATIC_FAILED")
        self.assertEqual(len(self.last_blocked), 1)

    def test_fast_tier_skips_clarify_gate(self) -> None:
        code, payload, err = self._run_close(self._close_args())
        self.assertEqual(code, 0, err)
        self.assertIsNotNone(payload)
        self.assertTrue(payload["clarifyGate"]["ok"])
        self.assertTrue(payload["clarifyGate"]["skipped"])
        self.assertTrue(payload["clarifyGate"]["skipReason"])

    def test_mode_off_passes_close(self) -> None:
        self._set_policy(tier="standard", clarifyGateMode="off")
        document = _pei()
        document["intent"]["goal"] = ""  # off 模式下静态缺陷也不阻断（回滚语义）
        self._write_pei(document)
        self._record_knowledge_receipt()
        code, payload, err = self._run_close(self._close_args())
        self.assertEqual(code, 0, err)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["clarifyGate"]["code"], "CLARIFY_GATE_DISABLED")


if __name__ == "__main__":
    unittest.main()
