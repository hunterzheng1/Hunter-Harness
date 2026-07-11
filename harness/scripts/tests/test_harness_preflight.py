#!/usr/bin/env python3
"""Unittests for harness_preflight.py (P0-4)."""

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


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class DetectIdempotentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-detect-"))
        _write(self.tmp / "pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detect_writes_profile_and_is_idempotent(self) -> None:
        r1 = hp.cmd_detect(self.tmp)
        self.assertTrue(r1["ok"])
        profile_path = self.tmp / ".harness" / "config" / "build-profile.json"
        self.assertTrue(profile_path.is_file())
        p1 = _read_json(profile_path)
        self.assertEqual(p1["schemaVersion"], 1)
        self.assertIn("toolPaths", p1)
        self.assertIn("fingerprint", p1)
        self.assertIn("pomHash", p1["fingerprint"])
        self.assertTrue(p1["fingerprint"]["pomHash"])
        self.assertIn("buildCommands", p1)
        # Java placeholders when pom present
        self.assertIn("mvn", p1["buildCommands"]["compile"])

        r2 = hp.cmd_detect(self.tmp)
        self.assertTrue(r2["ok"])
        p2 = _read_json(profile_path)

        # Idempotent: structural fields stable (ignore detectedAt)
        for key in ("schemaVersion", "toolPaths", "fingerprint", "buildCommands"):
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
        # Task 3 §5.1: serviceStart 必须含 inputFiles/profile/overlayPath 字段
        # （detect 无法猜 module 源，默认空数组；空输入由 resolve_service_input_files
        # 拒绝，不得生成可复用的空指纹）。
        r = hp.cmd_detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        svc = profile["serviceStart"]
        self.assertIsInstance(svc.get("inputFiles"), list)
        self.assertIn("profile", svc)
        self.assertIn("overlayPath", svc)

    def test_detect_includes_verification_inputs_for_java(self) -> None:
        # Task 1: build-profile 必须含 verificationInputs.unitTestFull，
        # 供 harness_ledger.py can-reuse --profile-input unitTestFull 展开依赖闭包。
        r = hp.cmd_detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertIn("verificationInputs", profile)
        vi = profile["verificationInputs"]
        self.assertIsInstance(vi, dict)
        self.assertIn("unitTestFull", vi)
        self.assertIsInstance(vi["unitTestFull"], list)
        self.assertTrue(vi["unitTestFull"], msg="unitTestFull inputs must be non-empty")
        # 再 detect 幂等：verificationInputs 稳定（用户可改 module 路径，不被覆盖）
        hp.cmd_detect(self.tmp)
        profile2 = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile["verificationInputs"], profile2["verificationInputs"])

    def test_detect_covers_all_maven_reactor_modules(self) -> None:
        _write(self.tmp / "module-a" / "pom.xml", "<project/>\n")
        _write(self.tmp / "module-b" / "pom.xml", "<project/>\n")
        profile = hp.cmd_detect(self.tmp)["profile"]
        inputs = profile["verificationInputs"]["unitTestFull"]
        self.assertIn("module-a/pom.xml", inputs)
        self.assertIn("module-a/src/main/**", inputs)
        self.assertIn("module-b/pom.xml", inputs)
        self.assertIn("module-b/src/test/**", inputs)


class CheckStaleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="preflight-check-"))
        _write(self.tmp / "pom.xml", "<project><modelVersion>4.0.0</modelVersion><n>a</n></project>\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_check_fresh_profile_not_stale_and_fast(self) -> None:
        hp.cmd_detect(self.tmp)
        t0 = time.perf_counter()
        result = hp.cmd_check(self.tmp)
        elapsed = time.perf_counter() - t0
        self.assertFalse(result["stale"], msg=result.get("issues"))
        self.assertEqual(result["issues"], [])
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
        self.assertTrue(any("pomHash" in i for i in stale["issues"]))
        self.assertIn("hint", stale)

    def test_check_missing_profile_is_stale(self) -> None:
        result = hp.cmd_check(self.tmp)
        self.assertTrue(result["stale"])
        self.assertFalse(result["ok"])

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
        # Duplicate record still appends a human-readable line
        self.assertGreaterEqual(pitfalls.count("BudgetStatusEnum"), 2)

    def test_fix_command_updates_build_commands_and_shell_quirks(self) -> None:
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
        self.assertEqual(profile["buildCommands"]["compile"], "mvn -f pom.xml compile -o -q")
        pitfalls = (self.tmp / ".harness" / "pitfalls.md").read_text(encoding="utf-8")
        self.assertIn("fixed-command", pitfalls)


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


if __name__ == "__main__":
    unittest.main()
