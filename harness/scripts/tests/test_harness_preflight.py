#!/usr/bin/env python3
"""Unittests for harness_preflight.py.

变更簇 4：preflight detect/check 委托 harness_profile (v2)，record-quirk 适配 v2
commands。测试断言 v2 schema (commands 而非 buildCommands)、delegation (status
字段)、source=user override 跨 detect 保留。
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_preflight as hp  # noqa: E402
import harness_profile as hprof  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


class DetectDelegationTests(unittest.TestCase):
    """簇 4：cmd_detect 委托 harness_profile.detect，产出 v2 profile。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-detect-"))
        _write(self.tmp / "pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detect_produces_v2_profile_delegated_to_harness_profile(self) -> None:
        r1 = hp.cmd_detect(self.tmp)
        self.assertTrue(r1["ok"])
        self.assertEqual(r1["action"], "detect")
        profile_path = self.tmp / ".harness" / "config" / "build-profile.json"
        self.assertTrue(profile_path.is_file())
        p1 = _read_json(profile_path)
        # v2 schema
        self.assertEqual(p1["schemaVersion"], hprof.SCHEMA_VERSION)
        self.assertEqual(p1["schemaVersion"], 2)
        self.assertIn("toolPaths", p1)
        self.assertIn("fingerprint", p1)
        self.assertTrue(p1["fingerprint"]["pomHash"])
        # v2: commands 而非 buildCommands
        self.assertIn("commands", p1)
        self.assertNotIn("buildCommands", p1)
        self.assertIn("mvn", p1["commands"]["compile"]["command"])
        # v2: 排除策略 + identifier 显式声明
        self.assertEqual(set(p1["excludedRoots"]), set(hprof.DEFAULT_EXCLUDED_ROOTS))
        self.assertIn("identifier", p1)
        self.assertIn("pattern", p1["identifier"])
        # v2: verificationInputs 由 commands 派生（兼容 ledger v1 消费）
        self.assertEqual(
            p1["verificationInputs"]["unitTestFull"],
            p1["commands"]["unitTestFull"]["inputs"],
        )

        r2 = hp.cmd_detect(self.tmp)
        self.assertTrue(r2["ok"])
        p2 = _read_json(profile_path)
        # 幂等：结构字段稳定（忽略 detectedAt）
        for key in ("schemaVersion", "toolPaths", "fingerprint", "commands", "excludedRoots"):
            self.assertEqual(p1[key], p2[key], msg=f"field {key} drifted across detect")
        self.assertEqual(p1["knownPreexistingErrors"], p2["knownPreexistingErrors"])
        self.assertEqual(p1["shellQuirks"], p2["shellQuirks"])

    def test_detect_preserves_recorded_quirks(self) -> None:
        hp.cmd_detect(self.tmp)
        hp.cmd_record_quirk(
            self.tmp,
            pattern="BudgetStatusEnum",
            reason="预存编译错误",
            action="skip-not-block",
        )
        hp.cmd_detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        patterns = [e["pattern"] for e in profile["knownPreexistingErrors"]]
        self.assertIn("BudgetStatusEnum", patterns)

    def test_detect_includes_service_start_input_files(self) -> None:
        # serviceStart 必须含 inputFiles/profile/overlayPath 字段（v2 skeleton 保留）。
        r = hp.cmd_detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        svc = profile["serviceStart"]
        self.assertIsInstance(svc.get("inputFiles"), list)
        self.assertIn("profile", svc)
        self.assertIn("overlayPath", svc)

    def test_detect_derives_verification_inputs_for_java(self) -> None:
        # v2: verificationInputs.<key> 由 commands.<key>.inputs 派生，供 ledger 展开。
        r = hp.cmd_detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertIn("verificationInputs", profile)
        vi = profile["verificationInputs"]
        self.assertIsInstance(vi, dict)
        self.assertIn("unitTestFull", vi)
        self.assertIsInstance(vi["unitTestFull"], list)
        self.assertTrue(vi["unitTestFull"], msg="unitTestFull inputs must be non-empty")
        self.assertEqual(vi["unitTestFull"], profile["commands"]["unitTestFull"]["inputs"])
        # 再 detect 幂等：verificationInputs 稳定
        hp.cmd_detect(self.tmp)
        profile2 = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile["verificationInputs"], profile2["verificationInputs"])

    def test_detect_covers_all_maven_reactor_modules(self) -> None:
        _write(self.tmp / "module-a" / "pom.xml", "<project/>\n")
        _write(self.tmp / "module-b" / "pom.xml", "<project/>\n")
        profile = hp.cmd_detect(self.tmp)["profile"]
        inputs = profile["commands"]["unitTestFull"]["inputs"]
        self.assertIn("module-a/pom.xml", inputs)
        self.assertIn("module-a/src/main/**", inputs)
        self.assertIn("module-b/pom.xml", inputs)
        self.assertIn("module-b/src/test/**", inputs)

    def test_detect_excludes_sibling_worktree_and_build_dirs(self) -> None:
        # UT-003/UT-004：兄弟 worktree / target / node_modules 内 POM 不进 inputs。
        _write(self.tmp / "module-a" / "pom.xml", "<project/>\n")
        _write(self.tmp / ".claude" / "worktrees" / "sibling" / "pom.xml", "<project/>\n")
        _write(self.tmp / "target" / "nested" / "pom.xml", "<project/>\n")
        _write(self.tmp / "node_modules" / "lib" / "pom.xml", "<project/>\n")
        profile = hp.cmd_detect(self.tmp)["profile"]
        inputs = profile["commands"]["unitTestFull"]["inputs"]
        self.assertNotIn(".claude/worktrees/sibling/pom.xml", inputs)
        self.assertNotIn("target/nested/pom.xml", inputs)
        self.assertNotIn("node_modules/lib/pom.xml", inputs)
        self.assertIn("module-a/pom.xml", inputs)


class CheckDelegationTests(unittest.TestCase):
    """簇 4：cmd_check 委托 harness_profile.check，返回 status 字段。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-check-"))
        _write(self.tmp / "pom.xml", "<project><modelVersion>4.0.0</modelVersion><n>a</n></project>\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_check_fresh_profile_ready_and_fast(self) -> None:
        hp.cmd_detect(self.tmp)
        t0 = time.perf_counter()
        result = hp.cmd_check(self.tmp)
        elapsed = time.perf_counter() - t0
        self.assertFalse(result["stale"], msg=result.get("issues"))
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["status"], "ready")
        self.assertLess(elapsed, 5.0, msg=f"check took {elapsed:.3f}s (>5s)")

    def test_check_detects_pom_change(self) -> None:
        hp.cmd_detect(self.tmp)
        fresh = hp.cmd_check(self.tmp)
        self.assertFalse(fresh["stale"])

        _write(
            self.tmp / "pom.xml",
            "<project><modelVersion>4.0.0</modelVersion><n>changed</n></project>\n",
        )
        stale = hp.cmd_check(self.tmp)
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["status"], "stale")
        self.assertTrue(any("pomHash" in i for i in stale["issues"]))
        self.assertIn("hint", stale)

    def test_check_missing_profile_is_missing(self) -> None:
        result = hp.cmd_check(self.tmp)
        self.assertTrue(result["stale"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "missing")

    def test_check_missing_tool_path_is_stale(self) -> None:
        hp.cmd_detect(self.tmp)
        profile_path = self.tmp / ".harness" / "config" / "build-profile.json"
        profile = _read_json(profile_path)
        profile["toolPaths"]["node"] = str(self.tmp / "does-not-exist-node.exe")
        profile_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result = hp.cmd_check(self.tmp)
        self.assertTrue(result["stale"])
        self.assertTrue(any("node" in i for i in result["issues"]))


class RecordQuirkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-quirk-"))
        _write(self.tmp / "pom.xml", "<project/>\n")
        hp.cmd_detect(self.tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_record_quirk_appends_without_overwrite(self) -> None:
        r1 = hp.cmd_record_quirk(
            self.tmp,
            pattern="BudgetStatusEnum",
            reason="预存编译错误，非变更引入",
            action="skip-not-block",
        )
        self.assertTrue(r1["ok"])
        r2 = hp.cmd_record_quirk(
            self.tmp,
            pattern="OtherError",
            reason="另一个预存错误",
            action="skip-not-block",
        )
        self.assertTrue(r2["ok"])

        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        patterns = [e["pattern"] for e in profile["knownPreexistingErrors"]]
        self.assertEqual(patterns, ["BudgetStatusEnum", "OtherError"])

        # Re-record same pattern must not overwrite / duplicate
        hp.cmd_record_quirk(
            self.tmp,
            pattern="BudgetStatusEnum",
            reason="should-not-replace",
            action="skip-not-block",
        )
        profile2 = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        budget_entries = [
            e for e in profile2["knownPreexistingErrors"] if e["pattern"] == "BudgetStatusEnum"
        ]
        self.assertEqual(len(budget_entries), 1)
        self.assertEqual(budget_entries[0]["reason"], "预存编译错误，非变更引入")

        pitfalls = (self.tmp / ".harness" / "pitfalls.md").read_text(encoding="utf-8")
        self.assertIn(hp.PITFALLS_APPENDIX_HEADER, pitfalls)
        self.assertIn("BudgetStatusEnum", pitfalls)
        self.assertIn("OtherError", pitfalls)
        self.assertGreaterEqual(pitfalls.count("BudgetStatusEnum"), 2)

    def test_fix_command_writes_user_override_to_commands(self) -> None:
        # 簇 4：fix-command 写 commands.<key> 为 source=user override（v2），
        # 不再写 v1 buildCommands 扁平字符串。
        r = hp.cmd_record_quirk(
            self.tmp,
            pattern="compile",
            reason="ps51-dot-arg-needs-single-quote",
            action="fix-command",
            fixed_command="mvn -f pom.xml compile -o -q",
        )
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertIn("compile", profile["shellQuirks"])
        self.assertEqual(
            profile["commands"]["compile"]["command"],
            "mvn -f pom.xml compile -o -q",
        )
        self.assertEqual(profile["commands"]["compile"]["source"], "user")
        self.assertNotIn("buildCommands", profile)
        pitfalls = (self.tmp / ".harness" / "pitfalls.md").read_text(encoding="utf-8")
        self.assertIn("fixed-command", pitfalls)

    def test_fix_command_user_override_preserved_across_detect(self) -> None:
        # spec §3.1：source=user override 显式保留；detected basis 过期自动重探测。
        hp.cmd_record_quirk(
            self.tmp,
            pattern="compile",
            reason="user-tuned-command",
            action="fix-command",
            fixed_command="mvn -f pom.xml compile -o -q -DskipITs",
        )
        hp.cmd_detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile["commands"]["compile"]["source"], "user")
        self.assertEqual(
            profile["commands"]["compile"]["command"],
            "mvn -f pom.xml compile -o -q -DskipITs",
        )

    def test_record_quirk_does_not_add_v1_buildcommands_field(self) -> None:
        # 回归：record-quirk 不得向 v2 profile 注入 v1 buildCommands 字段。
        hp.cmd_record_quirk(
            self.tmp,
            pattern="SomeError",
            reason="x",
            action="skip-not-block",
        )
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertNotIn("buildCommands", profile)
        self.assertIn("commands", profile)


class CheckAgentsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-agents-"))
        self.agents = self.tmp / "agents"
        self.agents.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_usable_agent_with_tools(self) -> None:
        _write(
            self.agents / "harness-reviewer.md",
            "---\n"
            "name: harness-reviewer\n"
            'description: "reviewer"\n'
            "tools: [Read, Glob, Grep, Bash(powershell.exe:*)]\n"
            "disallowedTools:\n"
            "  - Bash(git *)\n"
            "---\n\n"
            "# body\n",
        )
        result = hp.cmd_check_agents(self.tmp, "harness-reviewer")
        self.assertTrue(result["usable"])
        self.assertTrue(result["ok"])
        self.assertIn("Read", result["tools"])
        self.assertTrue(any("Bash" in str(t) for t in result["tools"]))

    def test_missing_agent_file(self) -> None:
        result = hp.cmd_check_agents(self.tmp, "no-such-agent")
        self.assertFalse(result["usable"])
        self.assertIn("not found", result["reason"])

    def test_bad_frontmatter(self) -> None:
        _write(self.agents / "broken.md", "# no frontmatter\n")
        result = hp.cmd_check_agents(self.tmp, "broken")
        self.assertFalse(result["usable"])
        self.assertIn("frontmatter", result["reason"])

    def test_missing_tools(self) -> None:
        _write(
            self.agents / "no-tools.md",
            "---\n"
            "name: no-tools\n"
            'description: "x"\n'
            "---\n\n"
            "# body\n",
        )
        result = hp.cmd_check_agents(self.tmp, "no-tools")
        self.assertFalse(result["usable"])
        self.assertIn("tools", result["reason"])

    def test_empty_tools(self) -> None:
        _write(
            self.agents / "empty-tools.md",
            "---\n"
            "name: empty-tools\n"
            "tools: []\n"
            "---\n\n"
            "# body\n",
        )
        result = hp.cmd_check_agents(self.tmp, "empty-tools")
        self.assertFalse(result["usable"])
        self.assertIn("tools", result["reason"])

    def test_real_reviewer_agent_if_present(self) -> None:
        skills_root = Path(__file__).resolve().parents[2]
        reviewer = skills_root / "agents" / "harness-reviewer.md"
        if not reviewer.is_file():
            self.skipTest("harness-reviewer.md not in skills tree")
        result = hp.cmd_check_agents(skills_root, "harness-reviewer")
        self.assertTrue(result["usable"], msg=result.get("reason"))
        self.assertEqual(result["name"], "harness-reviewer")

    def test_infers_sibling_agents_root_from_installed_claude_skills(self) -> None:
        skills = self.tmp / ".claude" / "skills"
        agent = self.tmp / ".claude" / "agents" / "harness-explorer.md"
        _write(
            agent,
            "---\nname: harness-explorer\ntools: [Read, Glob, Grep]\n---\n# body\n",
        )
        result = hp.cmd_check_agents(skills, "harness-explorer")
        self.assertTrue(result["usable"], msg=result.get("reason"))
        self.assertEqual(Path(result["agentsRoot"]), agent.parent.resolve())

    def test_agents_root_can_be_supplied_explicitly(self) -> None:
        skills = self.tmp / "custom" / "skills"
        agents = self.tmp / "definitions"
        _write(
            agents / "harness-reviewer.md",
            "---\nname: harness-reviewer\ntools: [Read, Grep]\n---\n# body\n",
        )
        result = hp.cmd_check_agents(skills, "harness-reviewer", agents_root=agents)
        self.assertTrue(result["usable"], msg=result.get("reason"))
        self.assertEqual(Path(result["agentsRoot"]), agents.resolve())

    def test_codex_without_capability_manifest_selects_inline(self) -> None:
        skills = self.tmp / ".agents" / "skills"
        result = hp.cmd_check_agents(skills, "harness-explorer")
        self.assertFalse(result["usable"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["executionMode"], "inline")
        self.assertEqual(result["fallbackPolicy"], "inline-no-retry")
        self.assertEqual(result["reasonCode"], "INLINE_BY_ADAPTER")
        self.assertNotIn("unavailable", result["reason"])

    def test_host_callable_without_definition(self) -> None:
        """C1 (retro §5.3): host declares agent role via runtime.json
        agentCapabilities, even without local .md definition."""
        skills = self.tmp / ".agents" / "skills"
        skills.mkdir(parents=True)
        runtime = self.tmp / ".agents" / "runtime.json"
        _write(
            runtime,
            json.dumps({"agentCapabilities": ["harness-explorer"]}) + "\n",
        )
        result = hp.cmd_check_agents(skills, "harness-explorer")
        self.assertTrue(result["hostCallable"])
        self.assertFalse(result["definitionPresent"])
        self.assertTrue(result["usable"])
        self.assertEqual(result["executionMode"], "delegated")
        self.assertEqual(result["reasonCode"], "DEFINITION_NOT_FOUND_HOST_CAPABLE")

    def test_cursor_without_capability_manifest_selects_inline(self) -> None:
        skills = self.tmp / ".cursor" / "skills"
        skills.mkdir(parents=True)
        result = hp.cmd_check_agents(skills, "harness-explorer")
        self.assertFalse(result["usable"])
        self.assertEqual(result["executionMode"], "inline")
        self.assertEqual(result["reasonCode"], "INLINE_BY_ADAPTER")

    def test_manifest_without_role_selects_inline_without_retry(self) -> None:
        skills = self.tmp / ".agents" / "skills"
        skills.mkdir(parents=True)
        _write(
            self.tmp / ".agents" / "runtime.json",
            json.dumps({"agentCapabilities": ["other-agent"]}) + "\n",
        )
        result = hp.cmd_check_agents(skills, "harness-reviewer")
        self.assertFalse(result["usable"])
        self.assertEqual(result["executionMode"], "inline")
        self.assertTrue(result["capabilityManifestPresent"])
        self.assertEqual(result["reasonCode"], "HOST_CAPABILITY_NOT_DECLARED")
        self.assertEqual(result["fallbackPolicy"], "inline-no-retry")

    def test_invalid_tool_contract_is_unavailable_not_missing(self) -> None:
        _write(
            self.agents / "no-tools.md",
            "---\nname: no-tools\ndescription: x\n---\n# body\n",
        )
        result = hp.cmd_check_agents(self.tmp, "no-tools")
        self.assertFalse(result["usable"])
        self.assertEqual(result["executionMode"], "unavailable")
        self.assertEqual(result["reasonCode"], "TOOL_CONTRACT_INVALID")

    def test_three_fields_present_in_output(self) -> None:
        """C1: check-agents output must include definitionPresent/hostCallable/toolContractValid."""
        _write(
            self.agents / "harness-reviewer.md",
            "---\n"
            "name: harness-reviewer\n"
            'description: "reviewer"\n'
            "tools: [Read, Glob, Grep, Bash(powershell.exe:*)]\n"
            "---\n\n"
            "# body\n",
        )
        result = hp.cmd_check_agents(self.tmp, "harness-reviewer")
        self.assertIn("definitionPresent", result)
        self.assertIn("hostCallable", result)
        self.assertIn("toolContractValid", result)
        self.assertTrue(result["definitionPresent"])
        self.assertTrue(result["toolContractValid"])


class CliSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-cli-"))
        _write(self.tmp / "pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_main_detect_check_json(self) -> None:
        code = hp.main(["detect", "--project", str(self.tmp), "--json"])
        self.assertEqual(code, 0)
        code = hp.main(["check", "--project", str(self.tmp), "--json"])
        self.assertEqual(code, 0)

    def test_main_check_agents_accepts_explicit_agents_root(self) -> None:
        skills = self.tmp / ".claude" / "skills"
        agents = self.tmp / ".claude" / "agents"
        _write(
            agents / "harness-reviewer.md",
            "---\nname: harness-reviewer\ntools: [Read, Grep]\n---\n# body\n",
        )
        code = hp.main([
            "check-agents", "--skills-root", str(skills),
            "--agents-root", str(agents), "--agent", "harness-reviewer", "--json",
        ])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
