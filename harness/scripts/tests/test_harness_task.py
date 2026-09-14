#!/usr/bin/env python3
"""Regression tests for harness_task.py（批次 1 轻任务闭环）。

覆盖计划（cosmic-pulse-curie-chcqn1ba）测试矩阵 1-8；第 9 项（doc
contract 扫描 harness-task/ 目录）由 test_harness_doc_contract.py 覆盖，
此处只验证目录存在。

fixture 仿 test_harness_change.py:42-78：tmp git 项目 + build-profile
（仅 unitTestFull target——F6：node 探测 profile 的真实形态）。
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
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


ht = load_module("harness_task", "harness_task.py")

BUILD_PROFILE = {
    "schemaVersion": 3,
    "commands": {
        "unitTestFull": {
            "command": "python check.py",
            "argvTemplate": ["python", "check.py"],
            "scope": "full",
            "inputs": ["check.py"],
            "coverage": "unitTestFull",
            "source": "user",
        }
    },
    "verificationInputs": {"unitTestFull": ["check.py"]},
    "verificationGraph": {
        "schemaVersion": 1,
        "source": "user",
        "candidateTarget": "unitTestFull",
        "targets": {
            "unitTestFull": {
                "commandKey": "unitTestFull",
                "dependsOn": [],
                "requiredCoverage": "full",
                "candidate": True,
                "requiredCapabilities": [],
                "argvTemplate": ["python", "check.py"],
            }
        },
    },
}


class HarnessTaskFixture(unittest.TestCase):
    """tmp git 项目 + .harness 布局 + build-profile（仅 unitTestFull）。"""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-task-project-"))
        self._git("init")
        self._git("config", "user.email", "test@example.com")
        self._git("config", "user.name", "Test")
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        (self.project / "check.py").write_text("print('check ok')\n", encoding="utf-8")
        self._git("add", "-A")
        self._git("commit", "-m", "init")
        (self.project / ".harness" / "changes").mkdir(parents=True)
        (self.project / ".harness" / "config").mkdir(parents=True)
        (self.project / ".harness" / "config" / "build-profile.json").write_text(
            json.dumps(BUILD_PROFILE), encoding="utf-8"
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _git(self, *args: str) -> str:
        proc = subprocess.run(
            ["git", *args],
            cwd=self.project,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.stdout.strip()

    def _run(self, *argv: str) -> tuple[int, dict]:
        """进程内调用 ht.main，捕获 stdout JSON（emit 走 print）。"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ht.main(list(argv))
        return rc, json.loads(buf.getvalue())

    def _begin(self, change: str, goal: str = "测试目标") -> dict:
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", change,
            "--executor", "test", "--goal", goal,
            "--acceptance", "验收条件", "--json",
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_BEGUN", out)
        return out

    def _finish(self, change: str, *extra: str) -> tuple[int, dict]:
        return self._run(
            "finish", "--project", str(self.project), "--change", change,
            "--json", *extra,
        )

    def _change_dir(self, change: str) -> Path:
        return self.project / ".harness" / "changes" / change

    def _events(self, change: str) -> list[dict]:
        path = self._change_dir(change) / "events.ndjson"
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()
        ]

    def _ledger(self, archive_dir: Path) -> dict:
        return json.loads(
            (archive_dir / "evidence" / "verification-ledger.json").read_text(
                encoding="utf-8-sig"
            )
        )


class BeginTests(HarnessTaskFixture):
    def test_begin_creates_files_and_is_idempotent(self) -> None:
        """矩阵 1：begin 建全套文件；重跑幂等（无重复 phase.start）。"""
        first = self._begin("idem-change")
        change_dir = self._change_dir("idem-change")
        for rel in (
            "meta/change-context.json",
            "meta/state-snapshot.json",
            "meta/task.json",
            "events.ndjson",
        ):
            self.assertTrue((change_dir / rel).is_file(), rel)
        task = json.loads(
            (change_dir / "meta" / "task.json").read_text(encoding="utf-8-sig")
        )
        self.assertEqual(task["status"], "open")
        self.assertEqual(task["goal"], "测试目标")
        self.assertIn("dirtyBaseline", task)

        second = self._begin("idem-change")
        self.assertEqual(second["runId"], first["runId"])
        starts = [
            e for e in self._events("idem-change")
            if e["type"] == "phase.start" and e["phase"] == "task"
        ]
        self.assertEqual(len(starts), 1)

    def test_begin_rejects_terminal_task(self) -> None:
        self._begin("done-change")
        task_path = self._change_dir("done-change") / "meta" / "task.json"
        task = json.loads(task_path.read_text(encoding="utf-8-sig"))
        task["status"] = "completed"
        task_path.write_text(json.dumps(task), encoding="utf-8")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "done-change",
            "--executor", "test", "--goal", "x", "--acceptance", "y", "--json",
        )
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_ALREADY_FINISHED")


class FinishTierTests(HarnessTaskFixture):
    def test_finish_docs_only_diff_is_fast_tier(self) -> None:
        """矩阵 2：docs-only → fast 档、恰好 1 条 ledger（unitTest 回退）。"""
        self._begin("docs-only")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("docs-only")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "fast")
        ledger = self._ledger(Path(out["archiveDir"]))
        # profile 只有 unitTestFull target：unitTest 经回退链落到它。
        self.assertEqual(sorted(ledger["validations"]), ["unitTestFull"])

    def test_finish_code_diff_runs_standard_validations(self) -> None:
        """矩阵 3：代码 diff → standard 档 3 项验证（回退后全落 unitTestFull）。"""
        self._begin("code-change")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish("code-change")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "standard")
        ledger = self._ledger(Path(out["archiveDir"]))
        # compile/unitTest/unitTestFull 三项都经回退链解析到唯一 target，
        # ledger 按真实执行的验证名去重——1 条 unitTestFull 记录。
        self.assertEqual(sorted(ledger["validations"]), ["unitTestFull"])
        statuses = {
            key: value.get("status")
            for key, value in ledger["validations"].items()
        }
        self.assertEqual(statuses, {"unitTestFull": "OK"})

    def test_finish_auth_signal_is_rejected_without_side_effects(self) -> None:
        """矩阵 4：auth 路径 → TASK_TIER_UPGRADE_REQUIRED，无 ledger、无归档。"""
        (self.project / "auth.py").write_text("TOKEN='x'\n", encoding="utf-8")
        self._git("add", "-A")
        self._git("commit", "-m", "add auth")
        self._begin("auth-touch")
        (self.project / "auth.py").write_text("TOKEN='y'\n", encoding="utf-8")
        rc, out = self._finish("auth-touch")
        self.assertEqual(rc, 3)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED")
        self.assertEqual(out["signals"], ["auth"])
        self.assertTrue(out["changePreserved"])
        change_dir = self._change_dir("auth-touch")
        self.assertTrue(change_dir.is_dir())
        self.assertFalse((change_dir / "evidence").is_dir())
        self.assertFalse((self.project / ".harness" / "archive").exists())

    def test_finish_contract_file_change_is_rejected(self) -> None:
        """P12 验收（T4 复现）：契约文件变更 → full 拒绝。

        修复前：harness_change.py 不命中任何 full marker → 误判 standard，
        轻任务入口放行（批次 1 试点 T4 实录）。修复后：精确清单命中 →
        contract-schema 信号 → rc 3 转完整流程。
        """
        scripts_dir = self.project / "harness" / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "harness_change.py").write_text(
            "print('change v1')\n", encoding="utf-8"
        )
        self._git("add", "-A")
        self._git("commit", "-m", "add contract file")
        self._begin("contract-touch")
        (scripts_dir / "harness_change.py").write_text(
            "print('change v2')\n", encoding="utf-8"
        )
        rc, out = self._finish("contract-touch")
        self.assertEqual(rc, 3)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED")
        self.assertEqual(out["signals"], ["contract-schema"])
        self.assertTrue(out["changePreserved"])
        change_dir = self._change_dir("contract-touch")
        self.assertTrue(change_dir.is_dir())
        self.assertFalse((change_dir / "evidence").is_dir())
        self.assertFalse((self.project / ".harness" / "archive").exists())


class DeclaredTierTests(HarnessTaskFixture):
    """P12 修复：begin --tier 声明档位（下限语义）+ 冲突守卫。"""

    def test_begin_declared_full_is_rejected_before_dir_creation(self) -> None:
        """--tier full：立即拒绝 rc 3，不建 change 目录（无孤儿目录）。"""
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "full-decl",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "full", "--json",
        )
        self.assertEqual(rc, 3)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED")
        self.assertEqual(out["field_path"], "args.tier")
        self.assertFalse(self._change_dir("full-decl").exists())

    def test_begin_declared_tier_recorded_and_status_exposes_it(self) -> None:
        """--tier standard：task.json 记 declaredTier；status 输出含之；
        无 flag begin → declaredTier None。"""
        self._begin("declared-standard")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change",
            "declared-standard", "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "standard", "--json",
        )
        self.assertEqual(rc, 0, out)
        task = json.loads(
            (self._change_dir("declared-standard") / "meta" / "task.json")
            .read_text(encoding="utf-8-sig")
        )
        self.assertEqual(task["declaredTier"], "standard")
        self.assertEqual(out["declaredTier"], "standard")

        rc, status = self._run(
            "status", "--project", str(self.project), "--change",
            "declared-standard", "--json",
        )
        self.assertEqual(rc, 0)
        self.assertEqual(status["declaredTier"], "standard")

        # 对照：无 flag begin → declaredTier None。
        self._begin("undeclared")
        task = json.loads(
            (self._change_dir("undeclared") / "meta" / "task.json")
            .read_text(encoding="utf-8-sig")
        )
        self.assertIsNone(task["declaredTier"])

    def test_begin_conflicting_tier_redeclaration_rejected(self) -> None:
        """改口声明（fast → standard）→ rc 2；同值重声明幂等 rc 0。"""
        self._begin("tier-conflict")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "tier-conflict",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "fast", "--json",
        )
        self.assertEqual(rc, 0, out)
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "tier-conflict",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "standard", "--json",
        )
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_INPUT_INVALID")
        self.assertEqual(out["field_path"], "args.tier")
        # 同值重声明幂等。
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "tier-conflict",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "fast", "--json",
        )
        self.assertEqual(rc, 0, out)

    def test_finish_declared_standard_floor_blocks_docs_only_downgrade(self) -> None:
        """声明 standard + docs-only diff → standard 胜（floor 挡降级）。"""
        self._begin("floor-standard")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "floor-standard",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "standard", "--json",
        )
        self.assertEqual(rc, 0, out)
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("floor-standard")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "standard")
        ledger = self._ledger(Path(out["archiveDir"]))
        self.assertIn("unitTestFull", ledger["validations"])

    def test_gate_policy_tier_carries_final_adjudicated_tier(self) -> None:
        """floor 抬升后 gate-policy.json 的 tier 用最终裁决值。

        归档的 P13 文案与 full-tier review 拦截都读 gate-policy.json 的
        tier——classify 原值（fast）不得泄漏进去。
        """
        self._begin("floor-policy")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "floor-policy",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "standard", "--json",
        )
        self.assertEqual(rc, 0, out)
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("floor-policy")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "standard")
        archive_dir = Path(out["archiveDir"])
        policy = json.loads(
            (archive_dir / "meta" / "gate-policy.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertEqual(policy.get("tier"), "standard")
        # 归档 decision 文案与 gate-policy 同源（P13）。
        events = [
            json.loads(line)
            for line in (archive_dir / "events.ndjson").read_text(
                encoding="utf-8-sig"
            ).splitlines()
            if line.strip()
        ]
        review_notes = [
            str(e.get("note") or "")
            for e in events
            if e.get("phase") == "archive"
            and e.get("type") == "decision"
            and "review missing" in str(e.get("note") or "")
        ]
        self.assertTrue(review_notes)
        self.assertIn("review missing on standard tier", review_notes[0])

    def test_finish_declared_fast_still_rejects_on_signals(self) -> None:
        """声明 fast + auth 信号 → 仍拒（floor 是下限非上限）。"""
        (self.project / "auth.py").write_text("TOKEN='x'\n", encoding="utf-8")
        self._git("add", "-A")
        self._git("commit", "-m", "add auth")
        self._begin("fast-declared")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "fast-declared",
            "--executor", "test", "--goal", "x",
            "--acceptance", "y", "--tier", "fast", "--json",
        )
        self.assertEqual(rc, 0, out)
        (self.project / "auth.py").write_text("TOKEN='y'\n", encoding="utf-8")
        rc, out = self._finish("fast-declared")
        self.assertEqual(rc, 3)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED")
        self.assertEqual(out["signals"], ["auth"])

    def test_finish_hand_edited_declared_full_is_rejected(self) -> None:
        """纵深防御：手改 task.json declaredTier=full → finish 拒绝 rc 3。"""
        self._begin("hand-edited")
        task_path = self._change_dir("hand-edited") / "meta" / "task.json"
        task = json.loads(task_path.read_text(encoding="utf-8-sig"))
        task["declaredTier"] = "full"
        task_path.write_text(json.dumps(task), encoding="utf-8")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("hand-edited")
        self.assertEqual(rc, 3)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED")
        self.assertEqual(out["field_path"], "meta/task.json.declaredTier")


class TierProjectionTests(HarnessTaskFixture):
    """WI-F2（O6）：task.json.tier 是 gate-policy 权威文档的投影。"""

    def test_finish_persists_policy_via_gate_single_writer(self) -> None:
        """finish 经 hg.persist_gate_policy 落盘，plannedPhases=[task, archive]。"""
        self._begin("proj-delegation")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        with mock.patch.object(
            ht.hg, "persist_gate_policy", wraps=ht.hg.persist_gate_policy
        ) as spy:
            rc, out = self._finish("proj-delegation")
        self.assertEqual(rc, 0, out)
        spy.assert_called_once()
        self.assertEqual(
            spy.call_args.kwargs.get("planned_phases"), ["task", "archive"]
        )

    def test_task_tier_projected_from_policy_document(self) -> None:
        """task.json.tier 的数据源是 persist 返回的权威文档，非局部变量。

        wiring 证明：注入「返回文档与裁决值分歧」的不可能场景——投影必须
        跟随权威文档（归档 P13 文案与 full-tier review 拦截读的是这份）。
        """
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "proj-tamper",
            "--executor", "test", "--goal", "投影 wiring 证明",
            "--acceptance", "验收条件", "--tier", "standard", "--json",
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_BEGUN", out)
        real_persist = ht.hg.persist_gate_policy

        def tampered(change_dir, payload, **kwargs):
            doc = real_persist(change_dir, payload, **kwargs)
            doc["tier"] = "fast"  # 只改返回的文档对象，盘上文件保持裁决值
            return doc

        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        with mock.patch.object(ht.hg, "persist_gate_policy", tampered):
            rc, out = self._finish("proj-tamper")
        self.assertEqual(rc, 0, out)
        archive_dir = Path(out["archiveDir"])
        task = json.loads(
            (archive_dir / "meta" / "task.json").read_text(encoding="utf-8-sig")
        )
        policy = json.loads(
            (archive_dir / "meta" / "gate-policy.json").read_text(encoding="utf-8-sig")
        )
        # 盘上权威文档保持裁决值；task.json.tier 跟随 persist 返回的文档。
        self.assertEqual(policy["tier"], "standard")
        self.assertEqual(task["tier"], "fast")


class FinishBoundaryTests(HarnessTaskFixture):
    def test_finish_rejects_preexisting_foreign_dirt(self) -> None:
        """矩阵 5：begin 前预存脏路径（任务未触碰）→ FOREIGN_PATHS_PRESENT。

        classify 首跑无 ownership 契约，非 .harness 路径全进 productPaths
        （harness_gate.py:1494-1497）——检测靠 begin 的 dirtyBaseline。
        """
        (self.project / "stray.txt").write_text("stray\n", encoding="utf-8")
        self._begin("foreign-dirt")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("foreign-dirt")
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "FOREIGN_PATHS_PRESENT")
        self.assertIn("stray.txt", out["problems"])

    def test_finish_accepts_files_created_during_task(self) -> None:
        """begin 后新出现的文件是任务自身工作，正常提交。"""
        self._begin("new-file")
        (self.project / "notes.md").write_text("task work\n", encoding="utf-8")
        rc, out = self._finish("new-file")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_FINISHED")

    def test_finish_abandoned_closure_archives_without_ledger(self) -> None:
        """矩阵 7：abandoned 闭包无 ledger 归档。"""
        self._begin("give-up")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish(
            "give-up", "--closure", "abandoned",
            "--closure-reason", "需求取消",
        )
        self.assertEqual(rc, 0, out)
        archive_dir = Path(out["archiveDir"])
        self.assertTrue(archive_dir.is_dir())
        self.assertFalse(
            (archive_dir / "evidence" / "verification-ledger.json").is_file()
        )


class FinishRoundTripTests(HarnessTaskFixture):
    def test_full_round_trip_contract(self) -> None:
        """矩阵 6：finish → 归档目录、businessGoal、知识候选、final-hash。"""
        self._begin("round-trip", goal="业务目标甲")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish("round-trip")
        self.assertEqual(rc, 0, out)
        archive_dir = Path(out["archiveDir"])
        self.assertTrue(archive_dir.is_dir())

        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertEqual(summary.get("businessGoal"), "业务目标甲")

        candidates = json.loads(
            (archive_dir / "candidates" / "knowledge.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertGreaterEqual(len(candidates), 1)

        # final-hash：execution-log 的 hash 即提交后 HEAD（无上游不 push）。
        head = self._git("rev-parse", "HEAD")
        self.assertEqual(out["commit"], head)

    def test_archive_review_missing_note_carries_actual_tier(self) -> None:
        """P13：归档 review-missing 文案带实际 tier，不再硬编码 full。

        轻任务固定传 allow_missing_review=True（流程无 review 阶段），
        standard 档归档的 decision 事件与 finalStatusReasons 必须写
        standard——修复前硬编码 "full tier" 误导审计。
        """
        self._begin("p13-standard")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish("p13-standard")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "standard")
        archive_dir = Path(out["archiveDir"])

        events = [
            json.loads(line)
            for line in (archive_dir / "events.ndjson").read_text(
                encoding="utf-8-sig"
            ).splitlines()
            if line.strip()
        ]
        notes = [
            str(e.get("note") or "")
            for e in events
            if e.get("phase") == "archive" and e.get("type") == "decision"
        ]
        review_notes = [n for n in notes if "review missing" in n]
        self.assertTrue(review_notes, notes)
        self.assertIn("review missing on standard tier", review_notes[0])
        self.assertNotIn("full tier", review_notes[0])

        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8-sig"
            )
        )
        reasons = [str(r) for r in (summary.get("finalStatusReasons") or [])]
        self.assertTrue(
            any("review missing on standard tier" in r for r in reasons),
            reasons,
        )
        self.assertFalse(any("full tier" in r for r in reasons), reasons)

    def test_archive_failure_reverts_task_and_rerun_succeeds(self) -> None:
        """归档失败 → task.json 回滚 open、phase.end 不重复 → 重跑成功。

        档位沿用首次裁决（standard）：重跑时产品树已提交，classify 只见
        no-code-diff，不得降级记成 fast。
        """
        self._begin("archive-fail")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        original = ht.ha.execute_archive
        try:
            ht.ha.execute_archive = lambda *a, **k: (
                1, {"ok": False, "error": "simulated", "issues": []}
            )
            rc, out = self._finish("archive-fail")
        finally:
            ht.ha.execute_archive = original
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "ARCHIVE_FAILED")

        task = json.loads(
            (self._change_dir("archive-fail") / "meta" / "task.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertEqual(task["status"], "open")

        ends = [
            e for e in self._events("archive-fail")
            if e["type"] == "phase.end" and e["phase"] == "task"
        ]
        self.assertEqual(len(ends), 1)

        rc2, out2 = self._finish("archive-fail")
        self.assertEqual(rc2, 0, out2)
        self.assertEqual(out2["code"], "TASK_FINISHED")
        self.assertEqual(out2["tier"], "standard")

    def test_verification_side_effect_file_survives_finish_retry(self) -> None:
        """P9：首次 finish 的验证副作用文件不得让重试被 FOREIGN 误拒。

        场景（试点 T3-r2 实录）：attempt 1 声明 ownership 后，验证链的
        副作用（npm pretest → sync:harness 改 bundle manifest）弄脏了
        契约外的产品树文件，随后验证失败退出；attempt 2 的 classify 按
        旧契约把它判 foreignPaths → FOREIGN_PATHS_PRESENT 死锁。
        修复语义：begin 后新出现的产品树路径 = 任务工作，并入 ownership
        重新声明，重试直接成功且副作用文件进任务提交。
        """
        self._begin("side-effect")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")

        original_run = ht._run_verification
        attempts = {"n": 0}

        def flaky_with_side_effect(project, change_dir, verification):
            attempts["n"] += 1
            if attempts["n"] == 1:
                # 模拟 npm pretest 副作用：验证过程中改写契约外文件
                # （attempt 1 的 classify/declare 已完成）。
                (project / "manifest.json").write_text(
                    '{"hash": "synced"}\n', encoding="utf-8"
                )
                return {}, ht.error_envelope(
                    "VERIFICATION_FAILED",
                    "模拟 flaky 测试失败",
                )
            return original_run(project, change_dir, verification)

        try:
            ht._run_verification = flaky_with_side_effect
            rc1, out1 = self._finish("side-effect")
        finally:
            ht._run_verification = original_run
        self.assertEqual(rc1, 2, out1)
        self.assertEqual(out1["code"], "VERIFICATION_FAILED")

        # attempt 2：修复前在此处 FOREIGN_PATHS_PRESENT（manifest.json）。
        rc2, out2 = self._finish("side-effect")
        self.assertEqual(rc2, 0, out2)
        self.assertEqual(out2["code"], "TASK_FINISHED")

        # 副作用文件进入任务提交（git add -A 范围与 ownership 声明一致）。
        committed = self._git("show", "--name-only", "--pretty=format:", "HEAD")
        self.assertIn("manifest.json", committed.splitlines())
        self.assertIn("check.py", committed.splitlines())

        # 归档的 ownership 投影把两个产品文件都判 owned；副作用文件
        # 不在 foreignPaths（fixture 无 .gitignore，.harness 自身路径
        # 出现在投影 foreignPaths 是既有 fixture 形态，与本修复无关）。
        archive_dir = Path(out2["archiveDir"])
        ownership_diff = json.loads(
            (archive_dir / "evidence" / "ownership-diff.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertEqual(
            sorted(ownership_diff.get("files") or []),
            ["check.py", "manifest.json"],
        )
        self.assertNotIn(
            "manifest.json", ownership_diff.get("foreignPaths") or []
        )

    def test_no_commit_escape_hatch(self) -> None:
        """--no-commit：不提交不归档，工作区保持脏树。"""
        self._begin("no-commit")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("no-commit", "--no-commit")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_FINISHED_NO_ARCHIVE")
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self.project, capture_output=True, text=True,
        ).stdout.strip()
        self.assertTrue(dirty)


class VerificationPlanTests(HarnessTaskFixture):
    """P1/P5/P6：变更感知验证计划（cosmic-pulse-curie 计划 §修复 1-3）。"""

    def test_p5_standard_tier_dedupes_same_argv(self) -> None:
        """P5：三项验证全解析到同一 argv → 只执行 1 次，摘要 3 名义项。"""
        self._begin("dedup-run")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        executed: list[list[str]] = []
        original = ht.htr.run_managed_command

        def counting_run(argv, **kwargs):
            executed.append(list(argv))
            return original(argv, **kwargs)

        try:
            ht.htr.run_managed_command = counting_run
            rc, out = self._finish("dedup-run")
        finally:
            ht.htr.run_managed_command = original
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "standard")
        # compile/unitTest/unitTestFull 全回退到唯一 target → 恰 1 次执行。
        self.assertEqual(len(executed), 1, executed)
        self.assertEqual(executed[0], ["python", "check.py"])
        # 摘要仍逐名义项输出：1 执行 + 2 deduped。
        by_name = {v["verification"]: v for v in out["verifications"]}
        self.assertEqual(
            sorted(by_name), ["compile", "unitTest", "unitTestFull"]
        )
        deduped = [v for v in out["verifications"] if v["status"] == "DEDUPED"]
        self.assertEqual(len(deduped), 2)
        self.assertTrue(all(v.get("dedupedFrom") for v in deduped))
        # ledger 只有一条真实执行记录。
        ledger = self._ledger(Path(out["archiveDir"]))
        self.assertEqual(sorted(ledger["validations"]), ["unitTestFull"])

    def test_p1_docs_only_in_contract_scope_uses_doc_contract_test(self) -> None:
        """P1：docs-only + harness skill md → doc contract 测试替代回退链。"""
        skill_md = self.project / "harness" / "harness-execute" / "SKILL.md"
        skill_md.parent.mkdir(parents=True, exist_ok=True)
        skill_md.write_text("# skill doc\n", encoding="utf-8")
        self._git("add", "-A")
        self._git("commit", "-m", "add skill doc")
        self._begin("doc-contract-run")
        skill_md.write_text("# skill doc v2\n", encoding="utf-8")
        executed: list[list[str]] = []
        original = ht.htr.run_managed_command

        def capturing_run(argv, **kwargs):
            executed.append(list(argv))
            if "test_harness_doc_contract" in argv:
                # fixture 项目没有真实测试目录——stub 成功结果。
                return ht.htr.CommandResult(
                    returncode=0, timed_out=False,
                    duration_seconds=0.01, process_tree_isolated=True,
                )
            return original(argv, **kwargs)

        try:
            ht.htr.run_managed_command = capturing_run
            rc, out = self._finish("doc-contract-run")
        finally:
            ht.htr.run_managed_command = original
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "fast")
        # unitTest 项的 argv 是 doc contract 测试，不是回退链的 check.py。
        self.assertEqual(len(executed), 1, executed)
        self.assertIn("test_harness_doc_contract", executed[0])
        self.assertNotIn("check.py", executed[0])
        summary = out["verifications"][0]
        self.assertEqual(summary["reason"], "doc-contract")
        # ledger 以 unitTest + 显式 files 记账（doc 路径本身）。
        ledger = self._ledger(Path(out["archiveDir"]))
        entry = ledger["validations"]["unitTest"]
        self.assertEqual(entry["status"], "OK")
        self.assertEqual(
            entry.get("inputsFiles"),
            ["harness/harness-execute/SKILL.md"],
        )

    def test_p1_docs_only_outside_scope_keeps_fallback(self) -> None:
        """P1 边界：docs-only 但根 README.md 不在 doc contract 扫描范围 → 回退。"""
        self._begin("root-readme")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("root-readme")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "fast")
        summary = out["verifications"][0]
        self.assertEqual(summary["reason"], "fallback")
        self.assertEqual(summary["resolvedAs"], "unitTestFull")
        ledger = self._ledger(Path(out["archiveDir"]))
        self.assertEqual(sorted(ledger["validations"]), ["unitTestFull"])

    def test_p6_python_source_change_uses_targeted_unittest(self) -> None:
        """P6：harness_preflight.py 变更 → unitTest 项是定向 unittest。

        compile/unitTestFull 仍走 npm 链（回退到唯一 target）且互相去重
        ——共 2 次执行（1× check.py + 1× 定向 python）。
        fixture 用 harness_preflight.py（约定派生、不在契约清单）；原
        harness_change.py fixture 自 P12 修复起命中 contract-schema →
        full 拒绝，语义等价迁移到本文件。
        """
        scripts_dir = self.project / "harness" / "scripts"
        tests_dir = scripts_dir / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "harness_preflight.py").write_text(
            "print('preflight v1')\n", encoding="utf-8"
        )
        (tests_dir / "test_harness_preflight.py").write_text(
            "import unittest\n"
            "class T(unittest.TestCase):\n"
            "    def test_ok(self):\n"
            "        self.assertTrue(True)\n",
            encoding="utf-8",
        )
        self._git("add", "-A")
        self._git("commit", "-m", "add harness python")
        self._begin("python-targeted")
        (scripts_dir / "harness_preflight.py").write_text(
            "print('preflight v2')\n", encoding="utf-8"
        )
        executed: list[list[str]] = []
        original = ht.htr.run_managed_command

        def capturing_run(argv, **kwargs):
            executed.append(list(argv))
            return original(argv, **kwargs)

        try:
            ht.htr.run_managed_command = capturing_run
            rc, out = self._finish("python-targeted")
        finally:
            ht.htr.run_managed_command = original
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["tier"], "standard")
        # 2 次执行：compile/unitTestFull 去重后 1 次 + 定向 python 1 次。
        self.assertEqual(len(executed), 2, executed)
        targeted = [a for a in executed if "-m" in a and "unittest" in a]
        self.assertEqual(len(targeted), 1)
        self.assertIn("test_harness_preflight", targeted[0])
        by_name = {v["verification"]: v for v in out["verifications"]}
        self.assertEqual(by_name["unitTest"]["reason"], "python-targeted")
        # ledger：unitTest（定向，显式 files）+ unitTestFull（回退链）。
        ledger = self._ledger(Path(out["archiveDir"]))
        self.assertEqual(
            sorted(ledger["validations"]), ["unitTest", "unitTestFull"]
        )
        entry = ledger["validations"]["unitTest"]
        self.assertEqual(entry["status"], "OK")
        self.assertIn(
            "harness/scripts/harness_preflight.py", entry.get("inputsFiles") or []
        )
        self.assertIn(
            "harness/scripts/tests/test_harness_preflight.py",
            entry.get("inputsFiles") or [],
        )

    def test_p6_unmapped_python_file_keeps_fallback(self) -> None:
        """P6 边界：无映射命中的 Python 文件 → 保持回退链（含 P5 去重）。"""
        scripts_dir = self.project / "harness" / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "harness_unknown.py").write_text("x = 1\n", encoding="utf-8")
        self._git("add", "-A")
        self._git("commit", "-m", "add unknown script")
        self._begin("unmapped-python")
        (scripts_dir / "harness_unknown.py").write_text("x = 2\n", encoding="utf-8")
        rc, out = self._finish("unmapped-python")
        self.assertEqual(rc, 0, out)
        by_name = {v["verification"]: v for v in out["verifications"]}
        # unitTest 无定向命中 → 回退解析到 unitTestFull，与 compile 同
        # argv → P5 去重（DEDUPED），不执行定向命令。
        self.assertEqual(by_name["unitTest"]["status"], "DEDUPED")
        self.assertEqual(by_name["unitTest"]["resolvedAs"], "unitTestFull")
        ledger = self._ledger(Path(out["archiveDir"]))
        self.assertEqual(sorted(ledger["validations"]), ["unitTestFull"])

    def test_p6_explicit_mapping_table_multi_modules(self) -> None:
        """P6 映射表：harness_archive.py → 4 个测试模块一次跑齐。"""
        modules = ht._python_test_modules_for_paths(
            ["harness/scripts/harness_archive.py"], self.project
        )
        self.assertEqual(
            modules,
            [
                "test_harness_archive",
                "test_harness_archive_c",
                "test_harness_archive_preflight",
                "test_harness_archive_remote",
            ],
        )
        # 约定派生：无显式表条目但测试文件存在 → test_harness_X。
        tests_dir = self.project / "harness" / "scripts" / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)
        (tests_dir / "test_harness_change.py").write_text("", encoding="utf-8")
        self.assertEqual(
            ht._python_test_modules_for_paths(
                ["harness/scripts/harness_change.py"], self.project
            ),
            ["test_harness_change"],
        )
        # 测试文件自身变更 → 直接映射到该模块。
        self.assertEqual(
            ht._python_test_modules_for_paths(
                ["harness/scripts/tests/test_harness_gate.py"], self.project
            ),
            ["test_harness_gate"],
        )


class StatusTests(HarnessTaskFixture):
    def test_status_reports_open_task(self) -> None:
        self._begin("status-check")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._run(
            "status", "--project", str(self.project), "--change", "status-check",
            "--json",
        )
        self.assertEqual(rc, 0)
        self.assertEqual(out["code"], "TASK_STATUS")
        self.assertEqual(out["status"], "open")
        self.assertIn("README.md", out["uncommittedPaths"])
        self.assertIn("finish", out["nextAction"])


class ExploratorySchemaTests(HarnessTaskFixture):
    def test_unknown_task_phase_events_survive_archive_package(self) -> None:
        """矩阵 8（探索性）：phase=task 事件不被归档 schema 拒绝。

        风险点 harness_archive.py:4489 默认放行未知 phase——实证而非假设。
        """
        self._begin("schema-probe")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("schema-probe")
        self.assertEqual(rc, 0, out)
        archive_dir = Path(out["archiveDir"])
        # 归档成功本身即 schema 未拒：finalize 的 validators 全过才发布。
        self.assertTrue((archive_dir / "reports" / "final" / "summary-data.json").is_file())
        events = [
            json.loads(line)
            for line in (archive_dir / "events.ndjson").read_text(
                encoding="utf-8-sig"
            ).splitlines()
            if line.strip()
        ]
        task_events = [e for e in events if e.get("phase") == "task"]
        self.assertTrue(task_events)
        types = {e["type"] for e in task_events}
        self.assertIn("phase.start", types)
        self.assertIn("phase.end", types)


class SkillDirectoryTests(unittest.TestCase):
    def test_harness_task_skill_directory_exists(self) -> None:
        """矩阵 9 前置：doc contract 扫描目标目录存在（SKILL.md/reference.md）。"""
        skill_dir = SCRIPTS_DIR.parent / "harness-task"
        self.assertTrue(skill_dir.is_dir(), skill_dir)
        self.assertTrue((skill_dir / "SKILL.md").is_file())
        self.assertTrue((skill_dir / "reference.md").is_file())


class FinishRetryReclassifyTests(HarnessTaskFixture):
    """R1：验证失败重试时，新增产品文件必须重新分类，不得沿用首次档位。"""

    def _make_check_fail(self) -> None:
        (self.project / "check.py").write_text(
            "raise SystemExit(1)\n", encoding="utf-8"
        )
        self._git("add", "-A")
        self._git("commit", "-m", "make check fail")

    def test_retry_after_verification_failure_reclassifies_new_auth_file(
        self,
    ) -> None:
        """首跑 docs-only 验证失败 → 新增 auth.py → 重试必须升级拒绝。

        缺陷复现：首跑 finish 已声明 ownership(productPaths=[README.md])；
        重试时 auth.py 被判 foreign 后未经重分类直接吸纳进提交范围，
        full 信号（auth）不生效，最终以 fast 档把 auth.py 提交。
        """
        self._make_check_fail()
        self._begin("retry-escalation")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("retry-escalation")
        self.assertEqual(rc, 2, out)
        self.assertEqual(out["code"], "VERIFICATION_FAILED", out)

        # 修复 check.py，但新增 auth.py（full 信号路径）。
        (self.project / "check.py").write_text(
            "print('check ok')\n", encoding="utf-8"
        )
        (self.project / "auth.py").write_text("TOKEN = 'x'\n", encoding="utf-8")
        rc, out = self._finish("retry-escalation")
        self.assertEqual(rc, 3, out)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED", out)
        self.assertIn("auth", out["signals"], out)
        # 拒绝后不得提交 auth.py。
        committed = self._git("show", "--name-only", "--format=", "HEAD")
        self.assertNotIn("auth.py", committed)

    def test_retry_full_signal_still_rejected_when_task_dir_globally_ignored(
        self,
    ) -> None:
        """.gitignore 全局忽略场景下重试仍须识别新增敏感文件。"""
        self._make_check_fail()
        self._begin("retry-ignored")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("retry-ignored")
        self.assertEqual(rc, 2, out)
        (self.project / "check.py").write_text(
            "print('check ok')\n", encoding="utf-8"
        )
        (self.project / "schema.prisma").write_text(
            "model User { id Int }\n", encoding="utf-8"
        )
        rc, out = self._finish("retry-ignored")
        self.assertEqual(rc, 3, out)
        self.assertEqual(out["code"], "TASK_TIER_UPGRADE_REQUIRED", out)
        self.assertIn("migration", out["signals"], out)


class FinishClosureCommitTests(HarnessTaskFixture):
    """R2：abandoned/superseded 闭包不得产生提交，工作区改动保留给用户。"""

    def test_abandoned_closure_does_not_commit(self) -> None:
        self._begin("abandon-no-commit")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        head_before = self._git("rev-parse", "HEAD")
        rc, out = self._finish(
            "abandon-no-commit", "--closure", "abandoned",
            "--closure-reason", "需求取消",
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["closure"], "abandoned")
        # 无提交：HEAD 不变，响应显式报告未提交。
        self.assertEqual(self._git("rev-parse", "HEAD"), head_before)
        self.assertIsNone(out["commit"], out)
        # 工作区改动保留（用户处置），而非被收进提交。
        self.assertIn("README.md", self._git("status", "--porcelain"))
        # 归档仍然发生（闭包证据不丢）。
        self.assertTrue(Path(out["archiveDir"]).is_dir())

    def test_superseded_closure_does_not_commit(self) -> None:
        self._begin("supersede-no-commit")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        head_before = self._git("rev-parse", "HEAD")
        rc, out = self._finish(
            "supersede-no-commit", "--closure", "superseded",
            "--closure-reason", "被新方案取代",
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(self._git("rev-parse", "HEAD"), head_before)
        self.assertIsNone(out["commit"], out)
        self.assertIn("README.md", self._git("status", "--porcelain"))

    def test_completed_closure_still_commits(self) -> None:
        """对照：completed 闭包保持自动提交行为不变。"""
        self._begin("completed-commits")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        head_before = self._git("rev-parse", "HEAD")
        rc, out = self._finish("completed-commits")
        self.assertEqual(rc, 0, out)
        self.assertIsNotNone(out["commit"], out)
        self.assertNotEqual(self._git("rev-parse", "HEAD"), head_before)


class FinishResumeTests(HarnessTaskFixture):
    """R3/O1：终态已写但归档缺失时，finish 必须可恢复而非卡死。"""

    def _simulate_crash_after_terminal_write(self, change: str) -> None:
        """模拟「状态已写终态、归档未做」的崩溃现场。"""
        task_path = self._change_dir(change) / "meta" / "task.json"
        task = json.loads(task_path.read_text(encoding="utf-8-sig"))
        task["status"] = "completed"
        task["finishedAt"] = "2026-09-12T00:00:00+00:00"
        task_path.write_text(
            json.dumps(task, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def test_finish_resumes_when_terminal_but_archive_missing(self) -> None:
        """崩溃后恢复：补做缺失动作（归档），不重复验证/提交。"""
        self._begin("crash-before-archive")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        self._simulate_crash_after_terminal_write("crash-before-archive")
        rc, out = self._finish("crash-before-archive")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_RESUMED", out)
        self.assertTrue(Path(out["archiveDir"]).is_dir())
        # 摘要等归档产物补齐。
        archive_dir = Path(out["archiveDir"])
        self.assertTrue(
            (archive_dir / "reports" / "final" / "summary-data.json").is_file()
        )

    def test_finish_resume_does_not_duplicate_commit(self) -> None:
        """恢复路径不得重复提交：task.commit 已记录时 HEAD 不变。"""
        self._begin("crash-after-commit")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        # 先完整跑一遍拿到真实 commit，再把 change 搬回 changes 模拟崩溃。
        rc, out = self._finish("crash-after-commit")
        self.assertEqual(rc, 0, out)
        commit = out["commit"]
        archive_dir = Path(out["archiveDir"])
        change_dir = self._change_dir("crash-after-commit")
        shutil.move(str(archive_dir), str(change_dir))
        head_before = self._git("rev-parse", "HEAD")
        rc, out = self._finish("crash-after-commit")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_RESUMED", out)
        self.assertEqual(self._git("rev-parse", "HEAD"), head_before)
        self.assertEqual(out["commit"], commit)

    def test_status_reports_pending_recovery_actions(self) -> None:
        """status 对「终态未归档」输出恢复指引而不是误导性文案。"""
        self._begin("crash-status")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        self._simulate_crash_after_terminal_write("crash-status")
        rc, out = self._run(
            "status", "--project", str(self.project), "--change",
            "crash-status", "--json",
        )
        self.assertEqual(rc, 0)
        self.assertTrue(out.get("recoveryPending"), out)
        self.assertIn("finish", out["nextAction"])

    def test_fully_finished_task_still_returns_already_finished(self) -> None:
        """对照：归档齐全的终态任务重复 finish 不重复动作（幂等）。"""
        self._begin("fully-done")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        rc, out = self._finish("fully-done")
        self.assertEqual(rc, 0, out)
        head_before = self._git("rev-parse", "HEAD")
        rc, out = self._finish("fully-done")
        self.assertNotEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertIn(
            out["code"], {"TASK_ALREADY_FINISHED", "CHANGE_NOT_FOUND"}, out
        )
        self.assertEqual(self._git("rev-parse", "HEAD"), head_before)


class FinishCommitScopeTests(HarnessTaskFixture):
    """R1 伴随约束：提交范围精确，不吞并验证后窗口落入的外来改动。"""

    def test_finish_commit_scope_excludes_late_arriving_foreign_file(self) -> None:
        """范围裁决落定后、提交前出现的文件不得被提交（git add -A 误吞）。

        通过包装 _record_ledger_entry 在其内部写入外来文件，确定性模拟
        「检测之后、提交之前」的并发落盘窗口。
        """
        self._begin("scoped-commit")
        (self.project / "README.md").write_text("v2\n", encoding="utf-8")
        original = ht._record_ledger_entry

        def _inject_stray(*a: object, **kw: object) -> None:
            (self.project / "late-stray.txt").write_text(
                "concurrent user save\n", encoding="utf-8"
            )
            original(*a, **kw)

        ht._record_ledger_entry = _inject_stray
        try:
            rc, out = self._finish("scoped-commit")
        finally:
            ht._record_ledger_entry = original
        self.assertEqual(rc, 0, out)
        committed = self._git("show", "--name-only", "--format=", "HEAD")
        self.assertIn("README.md", committed)
        self.assertNotIn("late-stray.txt", committed)
        # 外来文件保留在工作区由用户处置，不丢不吞。
        self.assertIn("late-stray.txt", self._git("status", "--porcelain"))


class ScopedTaskFixture(HarnessTaskFixture):
    """WI-3.3 公共辅助：带 --write-scope / --depends-on 的 begin。"""

    def _begin_scoped(
        self,
        change: str,
        scope: list[str] | None = None,
        depends: list[str] | None = None,
        goal: str = "测试目标",
    ) -> tuple[int, dict]:
        argv = [
            "begin", "--project", str(self.project), "--change", change,
            "--executor", "test", "--goal", goal,
            "--acceptance", "验收条件", "--json",
        ]
        for path in scope or []:
            argv += ["--write-scope", path]
        for dep in depends or []:
            argv += ["--depends-on", dep]
        return self._run(*argv)

    def _task_doc(self, change: str) -> dict:
        return json.loads(
            (self._change_dir(change) / "meta" / "task.json").read_text(
                encoding="utf-8-sig"
            )
        )

    def _write_task_status(self, change: str, status: str) -> None:
        doc = self._task_doc(change)
        doc["status"] = status
        (self._change_dir(change) / "meta" / "task.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


class ScopeConflictTests(ScopedTaskFixture):
    """WI-3.3：begin 前写入范围冲突检测（任务书 9.1 必测：独立可并行、
    相交被阻止、父子路径冲突、无声明不阻塞、重启不重复分派）。"""

    def test_disjoint_scopes_both_begin(self) -> None:
        rc, out_a = self._begin_scoped("work-a", scope=["src/a"])
        self.assertEqual(rc, 0, out_a)
        rc, out_b = self._begin_scoped("work-b", scope=["src/b"])
        self.assertEqual(rc, 0, out_b)
        self.assertEqual(out_b["code"], "TASK_BEGUN", out_b)

    def test_identical_scope_conflicts(self) -> None:
        rc, _ = self._begin_scoped("work-a", scope=["src/a.py"])
        self.assertEqual(rc, 0)
        rc, out = self._begin_scoped("work-b", scope=["src/a.py"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_CONFLICT", out)
        self.assertIn("work-a", json.dumps(out, ensure_ascii=False))
        # 拒绝不建孤儿 change 目录（对齐 --tier full 先例）。
        self.assertFalse(self._change_dir("work-b").exists())

    def test_parent_child_scope_conflicts_both_directions(self) -> None:
        # 父目录先声明，子路径 begin → 冲突。
        rc, _ = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0)
        rc, out = self._begin_scoped("work-b", scope=["src/deep/x.py"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_CONFLICT", out)
        # 反向：文件先声明，父目录 begin → 同样冲突。
        rc, _ = self._begin_scoped("work-c", scope=["lib/y.py"])
        self.assertEqual(rc, 0)
        rc, out = self._begin_scoped("work-d", scope=["lib"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_CONFLICT", out)

    def test_trailing_slash_normalized(self) -> None:
        rc, out = self._begin_scoped("work-a", scope=["src/"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(self._task_doc("work-a").get("writeScope"), ["src"])

    def test_scope_rejects_absolute_and_parent_ref(self) -> None:
        rc, out = self._begin_scoped("work-a", scope=["../outside"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_INVALID", out)
        rc, out = self._begin_scoped("work-a", scope=["/abs/path"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_INVALID", out)

    def test_unscoped_open_task_does_not_block_but_is_surfaced(self) -> None:
        # 存量无声明 open 任务（旧 schema）不阻塞，但提示字段列出。
        self._begin("legacy-open")
        rc, out = self._begin_scoped("work-b", scope=["src"])
        self.assertEqual(rc, 0, out)
        self.assertIn("legacy-open", out.get("unscopedOpenChanges") or [])

    def test_conflict_clears_after_peer_terminal(self) -> None:
        rc, _ = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0)
        self._write_task_status("work-a", "completed")
        rc, out = self._begin_scoped("work-b", scope=["src"])
        self.assertEqual(rc, 0, out)

    def test_redeclare_scope_on_open_task_rejected(self) -> None:
        rc, _ = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0)
        rc, out = self._begin_scoped("work-a", scope=["lib"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_REDECLARED", out)
        # 原声明不被覆盖。
        self.assertEqual(self._task_doc("work-a").get("writeScope"), ["src"])

    def test_idempotent_begin_same_scope_reuses_run(self) -> None:
        """重启不重复分派：同 change 同声明重复 begin 复用原 run。"""
        rc, first = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0, first)
        rc, second = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0, second)
        self.assertEqual(second["code"], "TASK_BEGUN", second)
        self.assertEqual(first["runId"], second["runId"])
        starts = [
            e for e in self._events("work-a")
            if e.get("type") == "phase.start" and e.get("phase") == "task"
        ]
        self.assertEqual(len(starts), 1)


class TaskDependencyTests(ScopedTaskFixture):
    """WI-3.3：依赖缺失/阻塞/失败传播/成环（任务书 9.1 必测）。"""

    def test_dependency_missing(self) -> None:
        rc, out = self._begin_scoped("work-a", depends=["ghost"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_DEPENDENCY_MISSING", out)
        self.assertIn("ghost", json.dumps(out, ensure_ascii=False))
        self.assertFalse(self._change_dir("work-a").exists())

    def test_dependency_unmet_while_open(self) -> None:
        rc, _ = self._begin_scoped("work-b", scope=["src/b"])
        self.assertEqual(rc, 0)
        rc, out = self._begin_scoped("work-a", depends=["work-b"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_DEPENDENCY_UNMET", out)

    def test_dependency_completed_allows_begin(self) -> None:
        rc, _ = self._begin_scoped("work-b", scope=["src/b"])
        self.assertEqual(rc, 0)
        self._write_task_status("work-b", "completed")
        rc, out = self._begin_scoped("work-a", depends=["work-b"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(self._task_doc("work-a").get("dependsOn"), ["work-b"])

    def test_dependency_abandoned_blocks(self) -> None:
        """失败传播：依赖目标 abandoned 同样阻塞，且不可强行 begin。"""
        rc, _ = self._begin_scoped("work-b", scope=["src/b"])
        self.assertEqual(rc, 0)
        self._write_task_status("work-b", "abandoned")
        rc, out = self._begin_scoped("work-a", depends=["work-b"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_DEPENDENCY_UNMET", out)
        self.assertIn("abandoned", json.dumps(out, ensure_ascii=False))

    def test_dependency_self_cycle(self) -> None:
        rc, out = self._begin_scoped("work-a", depends=["work-a"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_DEPENDENCY_CYCLE", out)

    def test_dependency_indirect_cycle(self) -> None:
        """A 依赖 B、B（open）声明依赖 A → 环先于 UNMET 报出。"""
        rc, _ = self._begin_scoped("work-a", scope=["src/a"])
        self.assertEqual(rc, 0)
        # 手工给 open 的 A 补一条 dependsOn=[work-b]（模拟并行声明窗口）。
        doc = self._task_doc("work-a")
        doc["dependsOn"] = ["work-b"]
        (self._change_dir("work-a") / "meta" / "task.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        rc, out = self._begin_scoped("work-b", depends=["work-a"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_DEPENDENCY_CYCLE", out)

    def test_redeclare_depends_on_open_task_rejected(self) -> None:
        rc, _ = self._begin_scoped("work-b", scope=["src/b"])
        self.assertEqual(rc, 0)
        self._write_task_status("work-b", "completed")
        rc, _ = self._begin_scoped("work-a", depends=["work-b"])
        self.assertEqual(rc, 0)
        rc, out = self._begin_scoped("work-a", depends=["work-c"])
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_REDECLARED", out)


class ScopeViolationFinishTests(ScopedTaskFixture):
    """WI-3.3：finish 越界停止——声明 writeScope 后实际 diff 越界即拒绝，
    不吸纳、不提交（任务书 9.1「越过声明边界时停止相关写入」）。"""

    def test_finish_within_scope_ok(self) -> None:
        rc, _ = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0)
        (self.project / "src").mkdir()
        (self.project / "src" / "x.py").write_text("x = 1\n", encoding="utf-8")
        rc, out = self._finish("work-a")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_FINISHED", out)

    def test_finish_out_of_scope_rejected_without_commit(self) -> None:
        rc, _ = self._begin_scoped("work-a", scope=["src"])
        self.assertEqual(rc, 0)
        (self.project / "src").mkdir()
        (self.project / "src" / "x.py").write_text("x = 1\n", encoding="utf-8")
        (self.project / "other.py").write_text("y = 2\n", encoding="utf-8")
        head_before = self._git("rev-parse", "HEAD")
        rc, out = self._finish("work-a")
        self.assertEqual(rc, 2)
        self.assertEqual(out["code"], "TASK_SCOPE_VIOLATION", out)
        self.assertIn("other.py", json.dumps(out, ensure_ascii=False))
        # 停止相关写入：无提交，改动保留在工作区。
        self.assertEqual(self._git("rev-parse", "HEAD"), head_before)
        self.assertIn("other.py", self._git("status", "--porcelain"))

    def test_finish_without_scope_keeps_absorb_behavior(self) -> None:
        """对照：未声明 scope 的任务保持现状（外来路径吸纳进 ownership）。"""
        self._begin("plain-task")
        (self.project / "src").mkdir(exist_ok=True)
        (self.project / "src" / "x.py").write_text("x = 1\n", encoding="utf-8")
        rc, out = self._finish("plain-task")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["code"], "TASK_FINISHED", out)


class OutcomeTests(HarnessTaskFixture):
    """WI-E1（O3）：finish 成果摘要落盘 meta/outcome.json——goal 与
    outcome 分字段，facts 派生模型不可写，空白不回填。"""

    def _archived_outcome(self, out: dict) -> dict:
        path = Path(out["archiveDir"]) / "meta" / "outcome.json"
        self.assertTrue(path.is_file(), f"outcome.json 缺失: {path}")
        return json.loads(path.read_text(encoding="utf-8-sig"))

    def _change_outcome(self, change: str) -> dict:
        path = (
            self.project / ".harness" / "changes" / change / "meta" / "outcome.json"
        )
        self.assertTrue(path.is_file(), f"outcome.json 缺失: {path}")
        return json.loads(path.read_text(encoding="utf-8-sig"))

    def test_completed_full_params_writes_outcome(self) -> None:
        self._begin("out-full", goal="实现 X")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish(
            "out-full",
            "--outcome-summary", "实现了 X 的前半",
            "--outcome-motivation", "先交付核心路径，后半依赖未就绪",
            "--outcome-risk", "后半未做",
            "--outcome-risk", "兼容性未测",
            "--outcome-next", "补后半实现",
            "--outcome-unverified", "性能未验证",
        )
        self.assertEqual(rc, 0, out)
        doc = self._archived_outcome(out)
        self.assertEqual(doc["schemaVersion"], 1)
        self.assertEqual(doc["changeId"], "out-full")
        self.assertEqual(doc["closure"], "completed")
        # goal 原样引用，与 outcome.summary 分字段（目标≠结果可表达）。
        self.assertEqual(doc["goal"], "实现 X")
        self.assertEqual(doc["outcome"]["summary"], "实现了 X 的前半")
        self.assertEqual(doc["outcome"]["motivation"], "先交付核心路径，后半依赖未就绪")
        self.assertEqual(doc["outcome"]["residualRisks"], ["后半未做", "兼容性未测"])
        self.assertEqual(doc["outcome"]["nextSteps"], ["补后半实现"])
        self.assertEqual(doc["outcome"]["unverifiedItems"], ["性能未验证"])
        facts = doc["facts"]
        self.assertEqual(facts["commit"], out["commit"])
        self.assertIn("check.py", facts["changedFiles"])
        self.assertTrue(facts["verifications"])
        self.assertTrue(facts["finishedAt"])
        self.assertIsNone(facts["closureReason"])

    def test_completed_without_summary_warns_not_backfill(self) -> None:
        """completed 缺 --outcome-summary → warning；summary 为 null 不回填 goal。"""
        self._begin("out-blank", goal="不应被复制成成果的目标")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish("out-blank")
        self.assertEqual(rc, 0, out)
        warnings = out.get("warnings") or []
        self.assertIn("OUTCOME_SUMMARY_MISSING", warnings, out)
        doc = self._archived_outcome(out)
        self.assertIsNone(doc["outcome"]["summary"])
        self.assertNotEqual(doc["outcome"]["summary"], doc["goal"])

    def test_abandoned_outcome_keeps_goal_and_reason(self) -> None:
        self._begin("out-abandon", goal="原计划")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish(
            "out-abandon",
            "--closure", "abandoned",
            "--closure-reason", "方向取消",
            "--outcome-summary", "完成 30% 草稿后中止",
        )
        self.assertEqual(rc, 0, out)
        doc = self._archived_outcome(out)
        self.assertEqual(doc["closure"], "abandoned")
        self.assertEqual(doc["goal"], "原计划")
        self.assertEqual(doc["outcome"]["summary"], "完成 30% 草稿后中止")
        self.assertIsNone(doc["facts"]["commit"])
        self.assertEqual(doc["facts"]["closureReason"], "方向取消")

    def test_no_commit_outcome_written_in_place(self) -> None:
        """工作区交付（--no-commit）：outcome.json 落盘且 facts.commit 为 null。"""
        self._begin("out-nocommit")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish(
            "out-nocommit", "--no-commit",
            "--outcome-summary", "工作区交付待用户处置",
        )
        self.assertEqual(rc, 0, out)
        doc = self._change_outcome("out-nocommit")
        self.assertEqual(doc["closure"], "completed")
        self.assertIsNone(doc["facts"]["commit"])
        self.assertIn("check.py", doc["facts"]["changedFiles"])

    def test_stdout_summary_derives_from_outcome(self) -> None:
        """反模式消除：stdout「完成内容」来自 outcome.summary，不再是 goal。"""
        self._begin("out-derive", goal="目标原文不应出现在完成内容")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish(
            "out-derive",
            "--outcome-summary", "真实成果叙述",
            "--outcome-risk", "遗留风险甲",
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["summary"]["完成内容"], "真实成果叙述")
        self.assertIn("遗留风险甲", out["summary"]["残余风险"])

    def test_stdout_summary_placeholder_when_missing(self) -> None:
        """未填成果摘要：stdout 占位文案，绝不回退成 goal 文本。"""
        self._begin("out-placeholder", goal="绝不出现的 goal 文本")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish("out-placeholder")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("绝不出现的 goal 文本", out["summary"]["完成内容"])

    def test_write_outcome_idempotent(self) -> None:
        """同参重写内容一致（capturedAt 除外）——归档失败重跑不产生漂移。"""
        self._begin("out-idem")
        change_dir = self.project / ".harness" / "changes" / "out-idem"
        task = json.loads(
            (change_dir / "meta" / "task.json").read_text(encoding="utf-8-sig")
        )
        outcome_input = {
            "summary": "S", "motivation": "M",
            "residualRisks": ["R"], "nextSteps": ["N"], "unverifiedItems": ["U"],
        }
        kwargs = dict(
            task=task, closure="completed", closure_reason="",
            committed_hash="abc123", product_paths=["check.py"],
            verifications=[{"verification": "unitTestFull", "status": "pass",
                            "exitCode": 0, "durationMs": 5}],
            finished_at="2026-09-14T00:00:00+08:00",
            outcome_input=outcome_input,
        )
        err1, _w1 = ht.write_outcome(change_dir, **kwargs)
        err2, _w2 = ht.write_outcome(change_dir, **kwargs)
        self.assertIsNone(err1)
        self.assertIsNone(err2)
        text = (change_dir / "meta" / "outcome.json").read_text(encoding="utf-8-sig")
        doc = json.loads(text)
        doc.pop("capturedAt")
        first = json.dumps(doc, sort_keys=True)
        err3, _w3 = ht.write_outcome(change_dir, **kwargs)
        self.assertIsNone(err3)
        doc2 = json.loads(
            (change_dir / "meta" / "outcome.json").read_text(encoding="utf-8-sig")
        )
        doc2.pop("capturedAt")
        self.assertEqual(first, json.dumps(doc2, sort_keys=True))

    def test_outcome_write_failure_blocks_finish(self) -> None:
        """磁盘写失败显示未保存、不静默：finish 报错且任务保持 open。"""
        self._begin("out-ioerr")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        blocker = (
            self.project / ".harness" / "changes" / "out-ioerr" / "meta" / "outcome.json"
        )
        blocker.mkdir(parents=True)  # 同名目录 → 写入必失败
        rc, out = self._finish("out-ioerr")
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(out["code"], "OUTCOME_WRITE_FAILED", out)
        task = json.loads(
            (self.project / ".harness" / "changes" / "out-ioerr" / "meta" / "task.json")
            .read_text(encoding="utf-8-sig")
        )
        self.assertEqual(task["status"], "open", task)

    def test_facts_derived_not_model_controllable(self) -> None:
        """facts 派生真实性：commit 与 git HEAD 一致，模型参数无法伪造。"""
        self._begin("out-facts")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish(
            "out-facts", "--outcome-summary", "声称完成了一切",
        )
        self.assertEqual(rc, 0, out)
        doc = self._archived_outcome(out)
        self.assertEqual(doc["facts"]["commit"], self._git("rev-parse", "HEAD"))
        for item in doc["facts"]["verifications"]:
            self.assertIn("name", item)
            self.assertIn("status", item)
            self.assertIn("exitCode", item)


class AssetOutboxWiringTests(HarnessTaskFixture):
    """WI-E3（O4）：finish 同进程原子入队 outcome 资产；begin 续跑钩子。"""

    def _outbox_records(self) -> list[dict]:
        records_dir = (
            self.project / ".harness" / "state" / "local"
            / "asset-outbox" / "records"
        )
        if not records_dir.is_dir():
            return []
        return [
            json.loads(p.read_text(encoding="utf-8-sig"))
            for p in sorted(records_dir.glob("*.json"))
        ]

    def test_finish_enqueues_outcome_asset_atomically(self) -> None:
        """finish 完成 ⇒ outbox 恰有一条 outcome 资产，payload 与归档
        outcome.json 逐字节一致（payload 自包含，不引用被移走的路径）。"""
        self._begin("e3-enqueue", goal="资产入队")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish(
            "e3-enqueue", "--outcome-summary", "完成了入队接线",
        )
        self.assertEqual(rc, 0, out)
        records = self._outbox_records()
        self.assertEqual(len(records), 1, records)
        record = records[0]
        self.assertEqual(record["kind"], "outcome")
        self.assertEqual(record["state"], "pending")
        self.assertEqual(record["payload"]["change_id"], "e3-enqueue")
        archived = json.loads(
            (Path(out["archiveDir"]) / "meta" / "outcome.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertEqual(record["payload"]["outcome"], archived)

    def test_finish_enqueue_failure_keeps_task_open(self) -> None:
        """入队失败显示不静默（E1 语义）：finish 报错、任务保持 open。"""
        self._begin("e3-enqueue-fail")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        original = ht.harness_asset_outbox.enqueue_outcome

        def boom(*args, **kwargs):
            raise ht.harness_asset_outbox.AssetOutboxError(
                "ASSET_OUTBOX_CAPACITY_EXCEEDED", "测试注入：队列满"
            )

        ht.harness_asset_outbox.enqueue_outcome = boom
        try:
            rc, out = self._finish(
                "e3-enqueue-fail", "--outcome-summary", "入队会失败",
            )
        finally:
            ht.harness_asset_outbox.enqueue_outcome = original
        self.assertEqual(rc, 2, out)
        self.assertEqual(out["code"], "ASSET_OUTBOX_ENQUEUE_FAILED", out)
        task = json.loads(
            (self._change_dir("e3-enqueue-fail") / "meta" / "task.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertEqual(task["status"], "open", task)
        # 恢复后重跑 finish 应成功且幂等键去重（最终只有一条资产）
        rc, out = self._finish(
            "e3-enqueue-fail", "--outcome-summary", "入队会失败",
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(self._outbox_records()), 1)

    def test_begin_reports_outbox_summary_and_survives_corruption(self) -> None:
        """begin 续跑钩子：输出带 assetOutbox 摘要；队列损坏只 warning。"""
        self._begin("e3-hook", goal="钩子")
        (self.project / "check.py").write_text("print('v2')\n", encoding="utf-8")
        rc, out = self._finish("e3-hook", "--outcome-summary", "留一条待交付")
        self.assertEqual(rc, 0, out)

        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "e3-hook-2",
            "--executor", "test", "--goal", "下个任务", "--acceptance", "x",
            "--json",
        )
        self.assertEqual(rc, 0, out)
        summary = out.get("assetOutbox") or {}
        self.assertEqual((summary.get("counts") or {}).get("pending"), 1, out)
        self.assertEqual(summary.get("remote"), "unconfigured")

        # 队列损坏（垃圾记录）不阻塞 begin，显式 warning
        broken = (
            self.project / ".harness" / "state" / "local"
            / "asset-outbox" / "records" / "asset_outbox_broken.json"
        )
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("{not json", encoding="utf-8")
        rc, out = self._run(
            "begin", "--project", str(self.project), "--change", "e3-hook-3",
            "--executor", "test", "--goal", "再下个任务", "--acceptance", "x",
            "--json",
        )
        self.assertEqual(rc, 0, out)
        summary = out.get("assetOutbox") or {}
        self.assertEqual(summary.get("warning"), "ASSET_OUTBOX_MAINTENANCE_FAILED", out)


if __name__ == "__main__":
    unittest.main()
