#!/usr/bin/env python3
"""WI-F1（O6）基础设施去重——收敛契约测试。

三类收敛：
1. 原子 JSON 写单一实现：harness_state.write_json 为权威；harness_task 的
   write_json_file 与 harness_gate 的 _write_json 删除；harness_context 不再
   跨模块调 hg._write_json 私有函数（改用自己的 _write_json_atomic）。
2. load_ledger 单一实现：harness_archive.load_ledger 委托
   harness_ledger.load_ledger，候选路径与优先级由后者统一裁决
   （state/evidence 优先，evidence/ 跨 root 优先于同 root 平铺）。
3. 委托后语义保持：缺失/损坏/空/非 dict → None（archive 侧既有契约）。

已知保留（backlog，见设计文档 §4）：harness_fixback/_environment/_change/
_context/_archive/_service/_profile 各自的 write_json 变体——harness_profile
处于 harness_state 依赖下游（state→ledger→profile），无法反向 import，
需后续批次引入叶模块 harness_jsonio 再收敛。
"""

from __future__ import annotations

import importlib.util
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
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


hs = load_module("harness_state", "harness_state.py")
hl = load_module("harness_ledger", "harness_ledger.py")
ha = load_module("harness_archive", "harness_archive.py")
hg = load_module("harness_gate", "harness_gate.py")
ht = load_module("harness_task", "harness_task.py")
hctx = load_module("harness_context", "harness_context.py")


def git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )


class AtomicWriteContractTests(unittest.TestCase):
    """harness_state.write_json 作为唯一权威的行为契约。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="f1-writejson-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_write_json_format_lf_utf8_no_bom(self) -> None:
        path = self.tmp / "sub" / "doc.json"
        hs.write_json(path, {"key": "值"})
        raw = path.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "must not write BOM")
        self.assertNotIn(b"\r", raw, "must be LF-only")
        self.assertTrue(raw.endswith(b"\n"))
        self.assertIn('"key": "值"'.encode("utf-8"), raw)  # ensure_ascii=False

    def test_write_json_atomic_overwrite(self) -> None:
        path = self.tmp / "doc.json"
        hs.write_json(path, {"v": 1})
        hs.write_json(path, {"v": 2})
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"v": 2})
        leftovers = [p for p in self.tmp.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_write_json_failure_leaves_no_tmp_and_raises(self) -> None:
        path = self.tmp / "doc.json"
        with mock.patch.object(os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                hs.write_json(path, {"v": 1})
        self.assertFalse(path.exists())
        leftovers = [p for p in self.tmp.iterdir() if ".tmp" in p.name]
        self.assertEqual(leftovers, [], "崩溃后不得留半写 tmp 文件")


class SingleImplementationTests(unittest.TestCase):
    """收敛契约：私有/重复实现不复存在，且无人再引用。"""

    def test_task_no_longer_defines_write_json_file(self) -> None:
        self.assertFalse(hasattr(ht, "write_json_file"))

    def test_gate_no_longer_defines_private_write_json(self) -> None:
        self.assertFalse(hasattr(hg, "_write_json"))

    def test_no_source_references_remain(self) -> None:
        task_src = (SCRIPTS_DIR / "harness_task.py").read_text(encoding="utf-8")
        gate_src = (SCRIPTS_DIR / "harness_gate.py").read_text(encoding="utf-8")
        context_src = (SCRIPTS_DIR / "harness_context.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("write_json_file", task_src)
        self.assertNotIn("_write_json", gate_src)
        self.assertNotIn("hg._write_json", context_src)

    def test_task_write_outcome_delegates_to_shared_impl(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="f1-outcome-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        change_dir = tmp / "change-x"
        change_dir.mkdir(parents=True)
        with mock.patch.object(hs, "write_json") as shared:
            err, warnings = ht.write_outcome(
                change_dir,
                task={"goal": "g"},
                closure="completed",
                closure_reason="",
                committed_hash=None,
                product_paths=[],
                verifications=[],
                finished_at="2026-09-14T00:00:00+00:00",
                outcome_input={"summary": "done"},
            )
        self.assertIsNone(err)
        self.assertEqual(warnings, [])
        shared.assert_called_once()
        called_path = shared.call_args.args[0]
        self.assertEqual(called_path, change_dir / "meta" / "outcome.json")


class ArchiveLoadLedgerDelegationTests(unittest.TestCase):
    """harness_archive.load_ledger 委托 harness_ledger 的语义契约。"""

    def test_delegates_to_harness_ledger(self) -> None:
        sentinel_path = Path("sentinel/verification-ledger.json")
        with mock.patch.object(
            hl, "load_ledger", return_value=({"records": []}, sentinel_path)
        ) as shared:
            result = ha.load_ledger(Path("any-change"))
        shared.assert_called_once_with(Path("any-change"))
        self.assertEqual(result, {"records": []})

    def test_missing_maps_to_none(self) -> None:
        with mock.patch.object(hl, "load_ledger", return_value=(None, None)):
            self.assertIsNone(ha.load_ledger(Path("any-change")))

    def test_empty_dict_passthrough(self) -> None:
        """空 dict 原样透传："{}" 账本在 record-only 归档 min-set 中计为存在。"""
        with mock.patch.object(
            hl, "load_ledger", return_value=({}, Path("p"))
        ):
            self.assertEqual(ha.load_ledger(Path("any-change")), {})

    def test_corrupt_maps_to_none(self) -> None:
        for exc in (
            json.JSONDecodeError("bad", "doc", 0),
            ValueError("ledger must be a JSON object"),
            OSError("io"),
        ):
            with mock.patch.object(hl, "load_ledger", side_effect=exc):
                self.assertIsNone(ha.load_ledger(Path("any-change")))


class UnifiedCandidateOrderTests(unittest.TestCase):
    """候选优先级统一为 harness_ledger 权威顺序：

    evidence/ 跨 root 优先于同 root 平铺——split 变更下
    contract/evidence/ledger 优先于 state/ledger（平铺）。
    这修正了旧 archive 实现按 root 优先的私有顺序。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="f1-ledger-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        git(self.project, "init")
        git(self.project, "config", "user.email", "test@example.com")
        git(self.project, "config", "user.name", "Test")
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        git(self.project, "add", "README.md")
        git(self.project, "commit", "-m", "init")

        self.change_id = "split-change"
        self.contract_dir = (
            self.project / ".harness" / "changes" / self.change_id
        )
        (self.contract_dir / "meta").mkdir(parents=True)
        (self.contract_dir / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": self.change_id,
                    "lifecycle": {"status": "active"},
                    "stateOwnership": {
                        "contractRoot": f".harness/changes/{self.change_id}",
                        "runtimeRoot": f".harness/state/changes/{self.change_id}",
                    },
                }
            ),
            encoding="utf-8",
        )
        self.state_dir = (
            self.project / ".harness" / "state" / "changes" / self.change_id
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_ledger(self, path: Path, marker: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"marker": marker}) + "\n", encoding="utf-8"
        )

    def test_contract_evidence_beats_state_plain(self) -> None:
        self._write_ledger(
            self.contract_dir / "evidence" / "verification-ledger.json",
            "contract-evidence",
        )
        self._write_ledger(
            self.state_dir / "verification-ledger.json", "state-plain"
        )
        result = ha.load_ledger(self.contract_dir)
        self.assertEqual(result, {"marker": "contract-evidence"})

    def test_state_evidence_still_first(self) -> None:
        self._write_ledger(
            self.state_dir / "evidence" / "verification-ledger.json",
            "state-evidence",
        )
        self._write_ledger(
            self.contract_dir / "evidence" / "verification-ledger.json",
            "contract-evidence",
        )
        result = ha.load_ledger(self.contract_dir)
        self.assertEqual(result, {"marker": "state-evidence"})

    def test_legacy_contract_evidence_readable(self) -> None:
        """无 state 残留时，contract/evidence 旧位置仍可读（只读兼容）。"""
        self._write_ledger(
            self.contract_dir / "evidence" / "verification-ledger.json",
            "contract-evidence",
        )
        result = ha.load_ledger(self.contract_dir)
        self.assertEqual(result, {"marker": "contract-evidence"})


if __name__ == "__main__":
    unittest.main()
