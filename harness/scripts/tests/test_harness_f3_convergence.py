#!/usr/bin/env python3
"""WI-F3（O6）验证事实治理——ledger 双解释者收敛契约测试。

设计文档 design-o6-responsibility-convergence-2026-09-14.md §3 F3：

1. 共享读取器：harness_ledger.load_validations 是盘上 ledger validations
   的唯一宽容读取器（缺文件/坏 JSON/非 dict 一律 {}）；harness_task 的
   _terminal_ledger_state 与 _ledger_verifications 两个生产解释者委托它，
   不再各自 find_ledger_path + read_json_file + try/except。
2. 共享判定器：
   - harness_ledger.all_validations_ok 承载「终态账本完整性」判定
     （非空、每条目 dict、status 全 OK）；
   - harness_ledger.find_reusable_evidence 承载 REUSE 身份匹配判定
     （evidenceId 精确 + targetId/verification 键回退 + productIdentity
     精确 + status=="OK"），harness_verification._target_decision 的
     REUSE 分支委托它——判定语义只此一份，防休眠协议机器未来接线时
     与生产解释者分叉。
3. 勘察修正（设计文档 §1.4 已更新）：harness_verification.py 全仓零生产
   调用方（CLI-only，REUSE 判定消费载荷内扁平收据列表，非盘上
   validations）——「同一证据两套解读」修正为「两种表示、一生一休眠」。

拷贝引用化（决策点 4，outcome schema v2）不在本批，已记 backlog。
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


hl = load_module("harness_ledger", "harness_ledger.py")
hv = load_module("harness_verification", "harness_verification.py")
ht = load_module("harness_task", "harness_task.py")


class LoadValidationsReaderTests(unittest.TestCase):
    """hl.load_validations：盘上 validations 的唯一宽容读取器。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="f3-ledger-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.change_dir = self.tmp / "change"
        (self.change_dir / "evidence").mkdir(parents=True)

    def _write_ledger(self, payload: object) -> Path:
        path = self.change_dir / "evidence" / "verification-ledger.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_missing_ledger_returns_empty(self) -> None:
        self.assertEqual(hl.load_validations(self.change_dir), {})

    def test_corrupt_json_returns_empty(self) -> None:
        path = self.change_dir / "evidence" / "verification-ledger.json"
        path.write_text("{not json", encoding="utf-8")
        self.assertEqual(hl.load_validations(self.change_dir), {})

    def test_non_dict_ledger_returns_empty(self) -> None:
        self._write_ledger(["not", "a", "dict"])
        self.assertEqual(hl.load_validations(self.change_dir), {})

    def test_non_dict_validations_returns_empty(self) -> None:
        self._write_ledger({"schemaVersion": 3, "validations": "oops"})
        self.assertEqual(hl.load_validations(self.change_dir), {})

    def test_validations_returned_verbatim(self) -> None:
        validations = {
            "compile": {"status": "OK", "durationMs": 12},
            "browserTest": {"status": "FAIL", "durationMs": 34},
        }
        self._write_ledger({"schemaVersion": 3, "validations": validations})
        self.assertEqual(hl.load_validations(self.change_dir), validations)


class AllValidationsOkTests(unittest.TestCase):
    """hl.all_validations_ok：终态账本完整性判定（唯一权威）。"""

    def test_empty_or_malformed_is_not_ok(self) -> None:
        self.assertFalse(hl.all_validations_ok({}))
        self.assertFalse(hl.all_validations_ok(None))
        self.assertFalse(hl.all_validations_ok("OK"))
        self.assertFalse(hl.all_validations_ok(["OK"]))

    def test_non_dict_entry_is_not_ok(self) -> None:
        self.assertFalse(hl.all_validations_ok({"compile": "OK"}))
        self.assertFalse(hl.all_validations_ok({"compile": None}))

    def test_any_non_ok_status_is_not_ok(self) -> None:
        self.assertFalse(
            hl.all_validations_ok(
                {"compile": {"status": "OK"}, "browser": {"status": "FAIL"}}
            )
        )
        self.assertFalse(hl.all_validations_ok({"compile": {}}))

    def test_all_ok(self) -> None:
        self.assertTrue(
            hl.all_validations_ok(
                {
                    "compile": {"status": "OK"},
                    "browser": {"status": "OK", "durationMs": 3},
                }
            )
        )


class FindReusableEvidenceTests(unittest.TestCase):
    """hl.find_reusable_evidence：REUSE 身份匹配判定（唯一权威）。"""

    ENTRY = {
        "evidenceId": "ledger:compile:42",
        "targetId": "compile",
        "productIdentity": "sha256:frozen",
        "status": "OK",
    }

    def _match(self, entries, **overrides):
        query = {
            "evidence_id": "ledger:compile:42",
            "target_id": "compile",
            "product_identity": "sha256:frozen",
        }
        query.update(overrides)
        return hl.find_reusable_evidence(entries, **query)

    def test_exact_match_returns_entry(self) -> None:
        self.assertIs(self._match([self.ENTRY]), self.ENTRY)

    def test_verification_key_fallback_when_target_id_absent(self) -> None:
        entry = {
            "evidenceId": "ledger:compile:42",
            "verification": "compile",
            "productIdentity": "sha256:frozen",
            "status": "OK",
        }
        self.assertIs(self._match([entry]), entry)

    def test_status_not_ok_never_matches(self) -> None:
        for status in ("FAIL", "NOT_RUN", "SKIP", ""):
            with self.subTest(status=status):
                entry = {**self.ENTRY, "status": status}
                self.assertIsNone(self._match([entry]))

    def test_identity_mismatch_never_matches(self) -> None:
        self.assertIsNone(self._match([self.ENTRY], evidence_id="ledger:other:1"))
        self.assertIsNone(self._match([self.ENTRY], target_id="browserTest"))
        self.assertIsNone(
            self._match([self.ENTRY], product_identity="sha256:drifted")
        )
        drifted = {**self.ENTRY, "productIdentity": "sha256:drifted"}
        self.assertIsNone(self._match([drifted]))

    def test_empty_entries_never_matches(self) -> None:
        self.assertIsNone(self._match([]))

    def test_first_match_wins_in_order(self) -> None:
        older = {**self.ENTRY, "durationMs": 1}
        newer = {**self.ENTRY, "durationMs": 2}
        self.assertIs(self._match([older, newer]), older)


class TaskInterpreterDelegationTests(unittest.TestCase):
    """harness_task 两个生产解释者委托共享读取器/判定器（篡改注入锁定）。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="f3-task-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.change_dir = self.tmp / "change"
        self.change_dir.mkdir(parents=True)

    def test_terminal_ledger_state_delegates_to_shared_judger(self) -> None:
        with mock.patch.object(
            hl, "load_validations", return_value={"compile": {"status": "OK"}}
        ) as loader, mock.patch.object(
            hl, "all_validations_ok", return_value=True
        ) as judger:
            self.assertTrue(ht._terminal_ledger_state(self.change_dir))
        loader.assert_called_once_with(self.change_dir)
        judger.assert_called_once_with({"compile": {"status": "OK"}})

    def test_terminal_ledger_state_follows_shared_judger(self) -> None:
        # 篡改注入：共享判定器说 False，解释者必须跟随而非自判
        with mock.patch.object(
            hl, "load_validations", return_value={"compile": {"status": "OK"}}
        ), mock.patch.object(hl, "all_validations_ok", return_value=False):
            self.assertFalse(ht._terminal_ledger_state(self.change_dir))

    def test_ledger_verifications_delegates_to_shared_reader(self) -> None:
        forged = {
            "b": {"status": "FAIL", "durationMs": 5},
            "a": {"status": "OK", "durationMs": 3},
            "bad": "not-a-dict",
        }
        with mock.patch.object(hl, "load_validations", return_value=forged):
            result = ht._ledger_verifications(self.change_dir)
        self.assertEqual(
            result,
            [
                {
                    "verification": "a",
                    "resolvedAs": "a",
                    "status": "OK",
                    "durationMs": 3,
                },
                {
                    "verification": "b",
                    "resolvedAs": "b",
                    "status": "FAIL",
                    "durationMs": 5,
                },
            ],
        )


class VerificationReuseDelegationTests(unittest.TestCase):
    """harness_verification REUSE 分支委托共享判定器（篡改注入锁定）。"""

    PAYLOAD = {
        "productIdentity": "sha256:frozen",
        "frozenIdentity": "sha256:frozen",
        "verificationLedger": [
            {
                "evidenceId": "ledger:compile:42",
                "targetId": "compile",
                "productIdentity": "sha256:frozen",
                "status": "OK",
            }
        ],
        "targets": [
            {
                "id": "compile",
                "dependsOn": [],
                "reusePolicy": "ledger-exact",
                "reuse": {
                    "eligible": True,
                    "reasonCode": "IDENTITY_MATCH",
                    "evidenceId": "ledger:compile:42",
                    "productIdentity": "sha256:frozen",
                },
            }
        ],
    }

    def _decision(self) -> dict:
        result = hv.schedule_verifications(self.PAYLOAD)
        return {item["id"]: item for item in result["plan"]}["compile"]

    def test_reuse_branch_delegates_to_shared_judger(self) -> None:
        sentinel = {"evidenceId": "ledger:compile:42"}
        with mock.patch.object(
            hl, "find_reusable_evidence", return_value=sentinel
        ) as judger:
            self.assertEqual(self._decision()["decision"], "REUSE")
        judger.assert_called_once()
        _, kwargs = judger.call_args
        self.assertEqual(kwargs["evidence_id"], "ledger:compile:42")
        self.assertEqual(kwargs["target_id"], "compile")
        self.assertEqual(kwargs["product_identity"], "sha256:frozen")

    def test_reuse_decision_follows_shared_judger(self) -> None:
        # 篡改注入：共享判定器返回 None，决策必须是 REUSE_EVIDENCE_INVALID
        with mock.patch.object(hl, "find_reusable_evidence", return_value=None):
            decision = self._decision()
        self.assertEqual(decision["decision"], "BLOCKED")
        self.assertIn("REUSE_EVIDENCE_INVALID", decision["reasonCodes"])


if __name__ == "__main__":
    unittest.main()
