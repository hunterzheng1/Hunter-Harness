#!/usr/bin/env python3
"""Fixback 证据契约必须在开批次时就说清楚，而不是等报错才逼人逆向。

背景（2026-08-18 fixback 执行日志，修一行 javadoc 花了约 570 行对话）：
launch-review 返回体里没有任何关于证据的说明，调用方先把代码改好，才在
resolve-issue 撞上 FIXBACK_EVIDENCE_MISSING；错误码只回显路径，于是又去
grep 错误码、连读三遍 harness_fixback.py、翻 harness_runtime.py、连打四次
--help，才拼出"证据是 run-start 产出的托管会话 JSON"这件事。

代价不止是绕路：等它弄明白 RED 必须是"修复前的失败会话"时，代码已经改完，
只能把两处 javadoc 改回去、跑一次 grep 当 RED、再改回来跑 GREEN——
为了满足证据形状而伪造 TDD 过程，还在中途留下过被回退的工作树。

根因是接口没有前置披露契约。这些测试把披露钉死在开批次的返回体里。
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fixback = load_module("harness_fixback_evidence_contract", "harness_fixback.py")


class EvidenceContractTests(unittest.TestCase):
    def test_contract_states_red_is_collected_before_the_fix(self) -> None:
        contract = fixback.evidence_contract()
        order = " ".join(str(step) for step in contract["order"])
        # 这一条是整个契约的重点：不写明"先 RED 后改"，调用方就会改完再回退伪造。
        self.assertIn("修复前", order)
        self.assertIn("修复后", order)
        self.assertLess(order.index("修复前"), order.index("修复后"))

    def test_contract_names_every_command_in_the_chain(self) -> None:
        contract = fixback.evidence_contract()
        rendered = repr(contract)
        for fragment in ("run-start", "register-evidence", "resolve-issue"):
            self.assertIn(fragment, rendered, fragment)

    def test_contract_describes_the_evidence_file_shape(self) -> None:
        shape = fixback.evidence_contract()["evidenceFile"]
        self.assertEqual(shape["schemaVersion"], 2)
        self.assertEqual(sorted(shape["kind"]), ["green", "red"])
        self.assertIn("managed-run-session", repr(shape["provenance"]))

    def test_contract_warns_against_manufacturing_red_by_reverting(self) -> None:
        contract = fixback.evidence_contract()
        self.assertIn("回退", contract["antiPattern"])


class ActionableEvidenceErrorTests(unittest.TestCase):
    def test_missing_evidence_error_says_what_the_path_should_point_at(self) -> None:
        message = fixback.evidence_error_message(
            "FIXBACK_EVIDENCE_MISSING", "runtime/evidence/red-f001.json"
        )
        self.assertIn("FIXBACK_EVIDENCE_MISSING", message)
        self.assertIn("runtime/evidence/red-f001.json", message)
        # 只回显路径等于没说；必须点明它要的是 run-start 产出的证据 JSON。
        self.assertIn("run-start", message)

    def test_unregistered_evidence_error_points_at_register_evidence(self) -> None:
        message = fixback.evidence_error_message(
            "FIXBACK_EVIDENCE_UNREGISTERED", "runtime/evidence/red-f001.json"
        )
        self.assertIn("register-evidence", message)


class LaunchPayloadTests(unittest.TestCase):
    def test_started_payload_carries_the_contract(self) -> None:
        # 契约必须随开批次一起返回——晚一步暴露，回退伪造就已经发生了。
        source = (SCRIPTS_DIR / "harness_fixback.py").read_text(encoding="utf-8")
        marker = source.index('"code": "FIXBACK_STARTED"')
        window = source[marker : marker + 900]
        self.assertIn("evidenceContract", window)


if __name__ == "__main__":
    unittest.main()
