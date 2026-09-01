#!/usr/bin/env python3
"""端到端生命周期测试：plan → execute → review → submit 整条链真实走一遍。

2026-09 dogfood 时发现各环节单元测试覆盖不错（gate 119 例、phase 26 例、
plan_finalize 26 例、review 31 例），但没有一个测试把连续 phase 的
begin/handoff/close 串联走完——handoff 派生的 to-phase、attempt 连续性、
review 输出绑定 run_id 这些跨阶段行为没有集成回归保护。本测试用 subprocess
真实调用 harness_gate/harness_context/harness_ledger/harness_review，
逐阶段走完整链并断言事件序列与门禁转移。
"""

from __future__ import annotations

import json
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS_DIR.parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


gate = load_module("harness_gate_for_lifecycle_e2e", "harness_gate.py")


def run_script(script: str, args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script), *args],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", check=False,
    )


class HarnessPhaseLifecycleE2ETests(unittest.TestCase):
    """plan → execute → review → submit 连续真实调用，无 mock。"""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-lifecycle-e2e-"))
        self.change_dir = self.project / ".harness" / "changes" / "lifecycle"
        self.change_dir.mkdir(parents=True)
        self._write_checkpoints("approved")
        # gate 读 workflow-policy（同 test_harness_gate 的引导）。
        policy_target = self.project / "harness" / "contracts" / "workflow-policy.json"
        policy_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / "harness" / "contracts" / "workflow-policy.json", policy_target)
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "e2e@example.com"],
                       cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "E2E"],
                       cwd=self.project, check=True, capture_output=True)
        (self.project / "README.md").write_text("e2e\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.project,
                       check=True, capture_output=True)
        # ledger record 校验输入文件存在
        src_dir = self.project / "src"
        src_dir.mkdir(exist_ok=True)
        (src_dir / "App.java").write_text("class App {}\n", encoding="utf-8")
        test_dir = self.project / "test"
        test_dir.mkdir(exist_ok=True)
        (test_dir / "AppTest.java").write_text("class AppTest {}\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "sources"], cwd=self.project,
                       check=True, capture_output=True)
        # phase begin 需要 adapter 上下文（skills root + context-index + installed）。
        self.skills_root = self.project / ".agents" / "skills"
        self.skills_root.mkdir(parents=True)
        (self.skills_root / ".harness-build.json").write_text(
            json.dumps({"schemaVersion": 1, "agent": "codex", "overlay": "none",
                        "coreHash": "a" * 16}) + "\n", encoding="utf-8")
        self._write_project_state("codex")

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _write_checkpoints(self, status: str) -> None:
        payload = {
            "schemaVersion": 1,
            "changeName": "lifecycle",
            "checkpoints": [{
                "id": "foundation-gate",
                "afterTasks": [1, 2, 3, 4],
                "beforeTasks": [6, 7, 8, 9, 10],
                "status": status,
                "blocking": True,
                "reviewerTool": "codex",
                "requiredReport": "reports/review/foundation-gate-review.md",
            }],
        }
        path = self.change_dir / "meta" / "implementation-checkpoints.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def _write_project_state(self, agent: str) -> None:
        context = {
            "schema_version": 2,
            "project": {"adapters": {agent: {"skills_root": ".agents/skills"}}},
            "skill_bundles": {
                agent: {"registry_version": "0.2.6", "bundle_hash": "sha256:" + "b" * 64}
            },
        }
        (self.project / ".harness" / "context-index.json").write_text(
            json.dumps(context) + "\n", encoding="utf-8")
        marker = self.skills_root / ".harness-build.json"
        build_hash = gate._sha256_file(marker)
        installed = {
            "schema_version": 4,
            "profiles": {agent: "general"},
            "manifests": [{
                "adapter": agent, "profile": "general", "bundle_version": "0.2.6",
                "bundle_manifest_hash": "sha256:" + "b" * 64,
            }],
            "files": [{
                "owner": agent, "target_path": ".agents/skills/.harness-build.json",
                "sha256": build_hash,
            }],
        }
        state = self.project / ".harness" / "state" / "local" / "installed-harness-bundle.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps(installed) + "\n", encoding="utf-8")

    def _gate(self, *args: str) -> subprocess.CompletedProcess:
        command: list[str] = [*args, "--change", "lifecycle", "--json"]
        if args[0] == "begin":
            # begin 才需要 adapter 上下文（skills-root / executor-tool）
            command += ["--skills-root", str(self.skills_root), "--executor-tool", "codex"]
        return run_script("harness_gate.py", command, self.project)

    def _events(self) -> list[dict]:
        path = self.change_dir / "events.ndjson"
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def _phase_sequence(self) -> list[tuple[str, str]]:
        return [
            (e["phase"], e["type"])
            for e in self._events()
            if e.get("type") in {"phase.start", "phase.end"}
        ]

    def _assert_run(self, result: subprocess.CompletedProcess) -> dict:
        self.assertEqual(result.returncode, 0, f"exit {result.returncode}: {result.stderr}")
        return json.loads(result.stdout)

    def test_full_lifecycle_plan_execute_review_submit(self) -> None:
        # 1) plan: begin → close
        self._assert_run(self._gate("begin", "--phase", "plan", "--task", "1",
                                    "--note", "plan e2e"))
        self._assert_run(self._gate("close", "--phase", "plan", "--status", "OK"))

        # 2) execute: handoff + begin/close with ledger evidence
        handoff = run_script("harness_context.py", [
            "handoff", "--project", str(self.project), "--change", "lifecycle",
            "--from-phase", "plan", "--to-phase", "execute", "--executor", "codex", "--json",
        ], self.project)
        self.assertEqual(handoff.returncode, 0, handoff.stderr)
        self._assert_run(self._gate("begin", "--phase", "execute", "--task", "1",
                                    "--note", "execute e2e"))
        for name, files, status in (
            ("compile", ["src/App.java"], "not_run"),
            ("unitTest", ["src/App.java", "test/AppTest.java"], "ok"),
            ("unitTestFull", ["src/App.java", "test/AppTest.java"], "ok"),
        ):
            evidence = "DEGRADED: 无编译步骤（ESM 直跑）" if status == "not_run" else "tests pass"
            record = run_script("harness_ledger.py", [
                "record", "--change-dir", str(self.change_dir),
                "--verification", name, "--status", status,
                "--command", "echo ok", "--exit-code", "0", "--duration-ms", "10",
                "--files", ",".join(files), "--evidence", evidence,
                "--scope", "lifecycle", "--coverage", "full",
                "--project", str(self.project),
            ], self.project)
            self.assertEqual(record.returncode, 0, record.stderr)
        self._assert_run(self._gate("close", "--phase", "execute", "--status", "OK"))

        # 3) review: handoff + findings/dispositions bound to run_id + close
        handoff = run_script("harness_context.py", [
            "handoff", "--project", str(self.project), "--change", "lifecycle",
            "--from-phase", "execute", "--to-phase", "review", "--executor", "codex", "--json",
        ], self.project)
        self.assertEqual(handoff.returncode, 0, handoff.stderr)
        self._assert_run(self._gate("begin", "--phase", "review", "--task", "1",
                                    "--note", "review e2e"))
        scaffold = run_script("harness_review.py", [
            "scaffold", "--change-dir", str(self.change_dir),
        ], self.project)
        self.assertEqual(scaffold.returncode, 0, scaffold.stderr)
        skeleton = json.loads(scaffold.stdout)
        run_id = skeleton["runId"]
        findings = skeleton["findingsInput"]
        findings_path = self.change_dir / "reports" / "review" / "review-findings.json"
        findings_path.parent.mkdir(parents=True, exist_ok=True)
        findings_path.write_text(json.dumps(findings, ensure_ascii=False) + "\n", encoding="utf-8")
        self._assert_run(run_script("harness_review.py", [
            "write-findings", "--change-dir", str(self.change_dir), "--input", str(findings_path),
        ], self.project))
        # findings 落地后再 scaffold 一次，拿到 dispositions 骨架（两次之间
        # findings 存在与否决定骨架形态——这是 review 子流程的真实契约）
        scaffold2 = run_script("harness_review.py", [
            "scaffold", "--change-dir", str(self.change_dir),
        ], self.project)
        self.assertEqual(scaffold2.returncode, 0, scaffold2.stderr)
        dispositions = json.loads(scaffold2.stdout)["dispositionsInput"]
        disp_path = self.change_dir / "reports" / "review" / "fixback-dispositions.json"
        disp_path.write_text(json.dumps(dispositions, ensure_ascii=False) + "\n", encoding="utf-8")
        self._assert_run(run_script("harness_review.py", [
            "write-dispositions", "--change-dir", str(self.change_dir), "--input", str(disp_path),
        ], self.project))
        self.assertGreater(len(run_id), 0)
        self._assert_run(self._gate("close", "--phase", "review", "--status", "OK"))

        # 4) submit: begin/close
        handoff = run_script("harness_context.py", [
            "handoff", "--project", str(self.project), "--change", "lifecycle",
            "--from-phase", "review", "--to-phase", "submit", "--executor", "codex", "--json",
        ], self.project)
        self.assertEqual(handoff.returncode, 0, handoff.stderr)
        self._assert_run(self._gate("begin", "--phase", "submit", "--task", "1",
                                    "--note", "submit e2e"))
        self._assert_run(self._gate("close", "--phase", "submit", "--status", "OK"))

        # 断言：四个阶段各一次 start+end，顺序严格 plan→execute→review→submit
        sequence = self._phase_sequence()
        expected = [
            ("plan", "phase.start"), ("plan", "phase.end"),
            ("execute", "phase.start"), ("execute", "phase.end"),
            ("review", "phase.start"), ("review", "phase.end"),
            ("submit", "phase.start"), ("submit", "phase.end"),
        ]
        self.assertEqual(sequence, expected, self._events())

        # 断言：review 的 findings 绑定的是 begin 返回的 run_id（跨命令一致性）
        written = json.loads(findings_path.read_text(encoding="utf-8"))
        self.assertEqual(written.get("runId"), run_id)

        # 断言：execute 阶段有 phase.end 且其 run_id 与 begin 一致（attempt 连续性）
        execute_events = [e for e in self._events() if e.get("phase") == "execute"]
        begin_run = next(e["run_id"] for e in execute_events if e["type"] == "phase.start")
        end_events = [e for e in execute_events if e["type"] == "phase.end"]
        self.assertTrue(end_events, "execute phase.end 必须存在")
        self.assertEqual(end_events[-1].get("run_id"), begin_run)

    def test_handoff_blocks_without_prior_phase_close(self) -> None:
        """未关闭前一阶段时 handoff 必须失败（跨阶段卫生）。"""
        result = run_script("harness_context.py", [
            "handoff", "--project", str(self.project), "--change", "lifecycle",
            "--from-phase", "plan", "--to-phase", "execute", "--executor", "codex", "--json",
        ], self.project)
        self.assertNotEqual(result.returncode, 0)
        # 无前一阶段时 handoff 必须 fail-closed（HANDOFF_SOURCE_UNKNOWN 或 recovery 指引）
        combined = result.stderr + result.stdout
        self.assertTrue(
            "HANDOFF_SOURCE_UNKNOWN" in combined or "recovery" in combined.lower(),
            combined,
        )


if __name__ == "__main__":
    unittest.main()