#!/usr/bin/env python3
"""WI-F2（O6）tier 单一权威 / gate-policy 单写入方——收敛契约测试。

设计文档 design-o6-responsibility-convergence-2026-09-14.md §3 F2：

1. meta/gate-policy.json 的「文档构建」写入收敛为
   harness_gate.persist_gate_policy 单一入口：cmd_classify 工作副本、
   harness_context bootstrap-plan、harness_task.finish 三处全量构建
   一律经它落盘；字段修补写点（change.allow_local_release 的
   candidateVerification 位、context configure-plan 的 phasePlan）
   与 TS 工作副本派生回写属不同写语义，登记保留。
2. tier 一处权威 + 投影：gate-policy.json 的 tier 是跨流程权威
   （归档 P13 文案 / full-tier review 拦截 / TS evidence-pack 消费方
   都读它）；task.json.tier 是投影——finish 终态写入的数据源必须是
   persist 返回的权威文档，而不是 finish 的局部裁决变量。
3. risk-classification.json 定位为分类证据快照（无生产读方）；
   task.json.declaredTier 是用户声明输入（begin --tier floor 语义）——
   两者都不是裁决 tier 的权威，文档登记，不改字段。

dependsOn 三义改名（决策点 6）不在本批：勘察复核发现 requiredGateDag
节点 dependsOn 是持久化契约（harness_phase.py 运行时消费 +
packages/cli plan-evidence-pack.ts 消费 + 历史文件只读兼容链），
profile 目标 dependsOn 是 build-profile-v3.schema.json 的 required
键——两处均非「纯内部重构」，改名须走契约窗口，待按新证据重裁决。
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
REPO_ROOT = TESTS_DIR.parents[2]


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


hs = load_module("harness_state", "harness_state.py")
hl = load_module("harness_ledger", "harness_ledger.py")
ha = load_module("harness_archive", "harness_archive.py")
hg = load_module("harness_gate", "harness_gate.py")
ht = load_module("harness_task", "harness_task.py")


class GatePolicySingleWriterTests(unittest.TestCase):
    """「文档构建」写点收敛为 hg.persist_gate_policy 单一入口。"""

    def test_gate_exposes_persist_gate_policy(self) -> None:
        self.assertTrue(callable(getattr(hg, "persist_gate_policy", None)))

    def test_task_module_has_no_direct_gate_policy_write(self) -> None:
        """task.finish 不再自行 hs.write_json gate-policy 工作副本。"""
        task_src = (SCRIPTS_DIR / "harness_task.py").read_text(encoding="utf-8")
        self.assertNotIn('"meta" / "gate-policy.json"', task_src)

    def test_context_module_has_no_direct_gate_policy_build(self) -> None:
        """bootstrap-plan 不再自行 _write_json_atomic 构建策略文档。"""
        ctx_src = (SCRIPTS_DIR / "harness_context.py").read_text(encoding="utf-8")
        self.assertNotIn('hg.gate_policy_document', ctx_src)

    def test_persist_gate_policy_writes_doc_with_planned_phases(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="harness-f2-persist-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        change_dir = tmp / "change-x"
        (change_dir / "meta").mkdir(parents=True)
        payload = {
            "tier": "standard",
            "source": "classify",
            "signals": ["production-code"],
            "defaultPhases": ["plan", "execute"],
            "requiredValidations": ["unitTest"],
            "classifiedAt": "2026-09-14T00:00:00Z",
        }
        doc = hg.persist_gate_policy(
            change_dir, payload, planned_phases=["task", "archive"]
        )
        on_disk = json.loads(
            (change_dir / "meta" / "gate-policy.json").read_text(encoding="utf-8")
        )
        self.assertEqual(doc, on_disk)
        self.assertEqual(on_disk["schemaVersion"], 1)
        self.assertEqual(on_disk["tier"], "standard")
        self.assertEqual(on_disk["plannedPhases"], ["task", "archive"])

    def test_persist_gate_policy_without_planned_phases_omits_key(self) -> None:
        """classify 路径不写 plannedPhases（由 configure-plan 流程后续补写）。"""
        tmp = Path(tempfile.mkdtemp(prefix="harness-f2-persist-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        change_dir = tmp / "change-y"
        (change_dir / "meta").mkdir(parents=True)
        payload = {
            "tier": "fast",
            "source": "classify",
            "signals": [],
            "defaultPhases": ["plan", "execute"],
            "requiredValidations": ["unitTest"],
            "classifiedAt": "2026-09-14T00:00:00Z",
        }
        doc = hg.persist_gate_policy(change_dir, payload)
        self.assertNotIn("plannedPhases", doc)
        on_disk = json.loads(
            (change_dir / "meta" / "gate-policy.json").read_text(encoding="utf-8")
        )
        self.assertNotIn("plannedPhases", on_disk)


class ClassifyDelegationTests(unittest.TestCase):
    """cmd_classify 经 persist_gate_policy 落盘（P1-1 守卫语义不变）。"""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-f2-classify-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)
        policy_target = self.project / "harness" / "contracts" / "workflow-policy.json"
        policy_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / "harness" / "contracts" / "workflow-policy.json", policy_target)
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)

    def test_classify_persists_via_persist_gate_policy(self) -> None:
        with mock.patch.object(hg.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(hg.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(
                 hg, "persist_gate_policy", wraps=hg.persist_gate_policy
             ) as spy:
            args = hg.build_parser().parse_args(
                ["classify", "--change", "demo", "--stage", "plan", "--json"]
            )
            self.assertEqual(hg.cmd_classify(args), 0)
        spy.assert_called_once()
        # classify 路径不传 planned_phases（由 configure-plan 后续补写）
        self.assertIsNone(spy.call_args.kwargs.get("planned_phases"))
        self.assertTrue((self.change_dir / "meta" / "gate-policy.json").is_file())


class BootstrapDelegationTests(unittest.TestCase):
    """harness_context bootstrap-plan 经 persist_gate_policy 落初始工作副本。

    引导主链需要完整 capture/doctor 环境，行为级委托测试成本过高；
    用源码守卫锁死：context 内凡构建策略文档处必须委托 hg.persist_gate_policy。
    """

    def test_bootstrap_plan_delegates_to_persist_gate_policy(self) -> None:
        ctx_src = (SCRIPTS_DIR / "harness_context.py").read_text(encoding="utf-8")
        self.assertIn("hg.persist_gate_policy(", ctx_src)


if __name__ == "__main__":
    unittest.main()
