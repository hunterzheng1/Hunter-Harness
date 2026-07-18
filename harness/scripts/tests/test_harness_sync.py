"""变更簇 D / task 13 RED：harness_sync.py 受管 runtime 清理器合同。

场景来源 test-scenarios.md：UT-020（清理边界）、INT-008（成功清理）、
INT-009（失败清理）、INT-010（并发隔离）、COM-004（不调用 git check-ignore）。

harness_sync.py 是新增模块（design §5）：每次 sync 使用
`.harness/runtime/sync/<run-id>/deploy/<agent>/` 并写 owner.json；
正常/失败/异常退出均在 finally 清理本 run；启动时只回收 owner 进程已死亡
且超过 TTL 且 resolved path 位于精确 sync root 内的目录；ownerless legacy
目录默认只报告 UNVERIFIABLE，不删除。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))


def _load_sync():
    spec = importlib.util.spec_from_file_location(
        "harness_sync", SCRIPTS_DIR / "harness_sync.py"
    )
    module = importlib.util.module_from_spec(spec)
    # @dataclass 注解解析需要模块已注册进 sys.modules。
    sys.modules["harness_sync"] = module
    spec.loader.exec_module(module)
    return module


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


class SyncRuntimeTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.hs = _load_sync()
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-sync-test-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        self.sync_root = self.project / ".harness" / "runtime" / "sync"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_owner(
        self,
        run_dir: Path,
        *,
        run_id: str,
        pid: int,
        expired: bool,
        agent: str = "claude-code",
    ) -> Path:
        run_dir.mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=-3600 if expired else 3600)
        owner = {
            "schemaVersion": 1,
            "runId": run_id,
            "pid": pid,
            "processStart": "test-start",
            "startedAt": _iso(now - timedelta(seconds=10)),
            "agent": agent,
            "purpose": "test",
            "expiresAt": _iso(expires),
        }
        path = run_dir / "owner.json"
        path.write_text(json.dumps(owner), encoding="utf-8")
        return path


class BeginRunLayoutTests(SyncRuntimeTestBase):
    def test_begin_run_creates_deploy_dir_and_owner_json(self) -> None:
        run = self.hs.begin_run(
            self.project, run_id="run-1", agent="claude-code", purpose="sync"
        )
        run_dir = self.sync_root / "run-1"
        self.assertTrue((run_dir / "deploy" / "claude-code").is_dir())
        owner = json.loads((run_dir / "owner.json").read_text(encoding="utf-8"))
        self.assertEqual(owner["runId"], "run-1")
        self.assertEqual(owner["pid"], os.getpid())
        self.assertEqual(owner["agent"], "claude-code")
        self.assertEqual(owner["purpose"], "sync")
        self.assertIn("expiresAt", owner)
        self.assertIn("processStart", owner)
        self.hs.finalize_run(run)

    def test_begin_run_generates_run_id_when_omitted(self) -> None:
        run = self.hs.begin_run(self.project, agent="codex", purpose="sync")
        self.assertTrue(run.run_id)
        self.assertTrue((self.sync_root / run.run_id / "deploy" / "codex").is_dir())
        self.hs.finalize_run(run)

    def test_begin_run_rejects_path_escaping_run_id(self) -> None:
        with self.assertRaises(ValueError):
            self.hs.begin_run(
                self.project, run_id="..", agent="codex", purpose="sync"
            )
        with self.assertRaises(ValueError):
            self.hs.begin_run(
                self.project, run_id="a/b", agent="codex", purpose="sync"
            )


class FinalizeRunTests(SyncRuntimeTestBase):
    def test_finalize_removes_all_agent_workspaces_of_run(self) -> None:
        """INT-008：同一 run-id 四个 owner workspace，finally 后全部为零。"""
        run = self.hs.begin_run(
            self.project, run_id="run-ok", agent="claude-code", purpose="sync"
        )
        for agent in ("codex", "cursor", "codebuddy"):
            self.hs.register_agent_workspace(run, agent)
        run_dir = self.sync_root / "run-ok"
        for agent in ("claude-code", "codex", "cursor", "codebuddy"):
            marker = run_dir / "deploy" / agent / "marker.txt"
            marker.write_text("built", encoding="utf-8")
        self.hs.finalize_run(run)
        self.assertFalse(run_dir.exists(), "run dir must be fully removed")

    def test_finalize_on_exception_still_cleans(self) -> None:
        """INT-009：第二个 agent 中途失败，本 run 临时目录仍全部清理。"""
        run = self.hs.begin_run(
            self.project, run_id="run-fail", agent="claude-code", purpose="sync"
        )
        self.hs.register_agent_workspace(run, "codex")
        try:
            with run:
                raise RuntimeError("simulated agent build failure")
        except RuntimeError:
            pass
        self.assertFalse((self.sync_root / "run-fail").exists())

    def test_keep_temp_preserves_run_dir_for_diagnostics(self) -> None:
        run = self.hs.begin_run(
            self.project,
            run_id="run-keep",
            agent="claude-code",
            purpose="sync",
            keep_temp=True,
        )
        self.hs.finalize_run(run)
        self.assertTrue((self.sync_root / "run-keep").is_dir())


class ReapStaleRunsTests(SyncRuntimeTestBase):
    def test_reap_removes_dead_owner_past_ttl(self) -> None:
        """UT-020：owner 死亡 + 过 TTL → 回收。"""
        run_dir = self.sync_root / "old-run"
        self._write_owner(run_dir, run_id="old-run", pid=999999, expired=True)
        result = self.hs.reap_stale_runs(
            self.project, pid_alive=lambda pid, start: False
        )
        self.assertFalse(run_dir.exists())
        self.assertIn("old-run", result["reaped"])

    def test_reap_skips_live_owner_even_past_ttl(self) -> None:
        """UT-020：owner 存活 → 永不回收（即使 TTL 已过）。"""
        run_dir = self.sync_root / "live-run"
        self._write_owner(run_dir, run_id="live-run", pid=os.getpid(), expired=True)
        result = self.hs.reap_stale_runs(
            self.project, pid_alive=lambda pid, start: True
        )
        self.assertTrue(run_dir.exists())
        self.assertNotIn("live-run", result["reaped"])

    def test_reap_skips_dead_owner_within_ttl(self) -> None:
        """UT-020：owner 死亡但 TTL 未过 → 保留。"""
        run_dir = self.sync_root / "fresh-run"
        self._write_owner(run_dir, run_id="fresh-run", pid=999999, expired=False)
        result = self.hs.reap_stale_runs(
            self.project, pid_alive=lambda pid, start: False
        )
        self.assertTrue(run_dir.exists())
        self.assertNotIn("fresh-run", result["reaped"])

    def test_reap_never_deletes_outside_sync_root(self) -> None:
        """UT-020：删除目标必须先 resolved 验证位于精确 sync root 内。"""
        outside = self.project / ".harness" / "runtime" / "escape-run"
        self._write_owner(outside, run_id="escape-run", pid=999999, expired=True)
        result = self.hs.reap_stale_runs(
            self.project, pid_alive=lambda pid, start: False
        )
        self.assertTrue(outside.exists(), "outside-sync-root dir must survive")
        self.assertNotIn("escape-run", result["reaped"])

    def test_ownerless_legacy_dir_reported_unverifiable_not_deleted(self) -> None:
        """UT-020：owner 缺失的 legacy 目录只报告 UNVERIFIABLE。"""
        legacy = self.sync_root / "legacy-run"
        legacy.mkdir(parents=True)
        (legacy / "junk.txt").write_text("old", encoding="utf-8")
        result = self.hs.reap_stale_runs(
            self.project, pid_alive=lambda pid, start: False
        )
        self.assertTrue(legacy.exists())
        self.assertIn("legacy-run", result["unverifiable"])
        self.assertNotIn("legacy-run", result["reaped"])

    def test_concurrent_runs_are_isolated(self) -> None:
        """INT-010：失败 run 的清理不删除存活 run 的目录。"""
        run_a = self.hs.begin_run(
            self.project, run_id="run-a", agent="codex", purpose="sync"
        )
        run_b = self.hs.begin_run(
            self.project, run_id="run-b", agent="cursor", purpose="sync"
        )
        self.hs.finalize_run(run_a)
        self.assertFalse((self.sync_root / "run-a").exists())
        self.assertTrue((self.sync_root / "run-b" / "deploy" / "cursor").is_dir())
        # reap 不得触碰 owner 存活的 run-b（本进程即 owner）。
        result = self.hs.reap_stale_runs(
            self.project, pid_alive=lambda pid, start: True
        )
        self.assertTrue((self.sync_root / "run-b").exists())
        self.assertNotIn("run-b", result["reaped"])
        self.hs.finalize_run(run_b)


class NoGitPolicyTests(SyncRuntimeTestBase):
    def test_module_has_no_gitignore_or_git_check_ignore(self) -> None:
        """COM-004/RET-34：sync 不做任何 .gitignore/git check-ignore 判断。

        最强保证：模块不产生任何子进程调用（无 subprocess/os.system/Popen），
        因此不可能调用 git；且除文档字符串外不出现 git 命令字符串。
        """
        import ast

        source = (SCRIPTS_DIR / "harness_sync.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertNotIn("subprocess", imported)
        # 收集所有 docstring 常量，其余字符串不得出现 git check-ignore 命令。
        docstring_ids: set[int] = set()
        for node in ast.walk(tree):
            body = getattr(node, "body", None)
            if (
                isinstance(body, list)
                and body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                docstring_ids.add(id(body[0].value))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in docstring_ids:
                continue
            self.assertNotIn("check-ignore", node.value)
            self.assertNotIn(".gitignore", node.value)


class SyncCliTests(SyncRuntimeTestBase):
    def test_reap_cli_emits_json_payload(self) -> None:
        run_dir = self.sync_root / "cli-run"
        self._write_owner(run_dir, run_id="cli-run", pid=999999, expired=True)
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "harness_sync.py"),
                "reap",
                "--project",
                str(self.project),
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["action"], "reap")
        self.assertIn("reaped", payload)
        self.assertIn("unverifiable", payload)


if __name__ == "__main__":
    unittest.main()
