#!/usr/bin/env python3
"""Unittests for harness_profile.py (Profile v2 — change cluster 1).

覆盖 test-scenarios UT-001~UT-009：
  detect 单/多模块、worktree/build 目录排除、user override 保留、basis 变化重建、
  glob 逃逸拒绝、连续 detect/migrate 幂等、v1→v2 迁移（dry-run/apply/备份）。
"""

from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = SCRIPTS_DIR / "harness_profile.py"


def load_module():
    spec = importlib.util.spec_from_file_location("harness_profile", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["harness_profile"] = mod
    spec.loader.exec_module(mod)
    return mod


hp = load_module()


def _write(path: Path, text: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _make_java_project(tmp: Path, modules: list[str] | None = None) -> None:
    """Java Maven fixture：root pom + 可选 reactor 子模块。"""
    modules = modules or []
    _write(tmp / "pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n")
    if modules:
        for m in modules:
            _write(tmp / m / "pom.xml", "<project/>\n")
            _write(tmp / m / "src" / "main" / "java" / "App.java", "class App {}\n")
            _write(tmp / m / "src" / "test" / "java" / "AppTest.java", "class AppTest {}\n")
    else:
        _write(tmp / "src" / "main" / "java" / "App.java", "class App {}\n")
        _write(tmp / "src" / "test" / "java" / "AppTest.java", "class AppTest {}\n")


class DetectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-detect-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detect_single_module_java_v2_schema(self) -> None:
        # UT-001：单模块 Java detect → 完整 compile/unit/full/package profile
        _make_java_project(self.tmp)
        r = hp.detect(self.tmp)
        self.assertTrue(r["ok"], msg=str(r))
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile["schemaVersion"], 2)
        cmds = profile["commands"]
        for key in ("compile", "unitTest", "unitTestFull", "install", "package"):
            self.assertIn(key, cmds, msg=f"missing command {key}")
            self.assertTrue(cmds[key]["command"], msg=f"empty command {key}")
            self.assertEqual(cmds[key]["source"], "detected")
            self.assertIn("inputs", cmds[key])
            self.assertIn("coverage", cmds[key])
            self.assertIn("basis", cmds[key])
            self.assertIsInstance(cmds[key]["argvTemplate"], list)
        self.assertIn("clean package", cmds["package"]["command"])
        self.assertEqual(cmds["package"]["argvTemplate"][3:5], ["clean", "package"])

    def test_detect_multi_module_reactor_inputs_cover_all_modules(self) -> None:
        # UT-002：多模块 reactor detect → inputs 覆盖真实 reactor，排序去重
        _make_java_project(self.tmp, modules=["module-a", "module-b"])
        r = hp.detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        full = profile["commands"]["unitTestFull"]
        self.assertIn("module-a", full["basis"]["reactorModules"])
        self.assertIn("module-b", full["basis"]["reactorModules"])
        self.assertIn("module-a/pom.xml", full["inputs"])
        self.assertIn("module-a/src/main/**", full["inputs"])
        self.assertIn("module-a/src/test/**", full["inputs"])
        self.assertIn("module-b/pom.xml", full["inputs"])
        self.assertIn("module-b/src/test/**", full["inputs"])
        # 排序 + 去重
        self.assertEqual(full["inputs"], sorted(set(full["inputs"])))
        # reactorModules 也排序去重
        self.assertEqual(full["basis"]["reactorModules"],
                         sorted(set(full["basis"]["reactorModules"])))

    def test_detect_excludes_sibling_worktree_poms(self) -> None:
        # UT-003：含旧 Claude/Cursor worktree → worktree 内 POM 被排除
        _make_java_project(self.tmp)
        _write(self.tmp / ".claude" / "worktrees" / "x" / "pom.xml", "<project/>\n")
        _write(self.tmp / ".cursor" / "worktrees" / "y" / "pom.xml", "<project/>\n")
        r = hp.detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        full = profile["commands"]["unitTestFull"]
        self.assertFalse(any(".claude/worktrees" in p for p in full["inputs"]),
                         msg=f"worktree pom leaked: {full['inputs']}")
        self.assertFalse(any(".cursor/worktrees" in p for p in full["inputs"]))
        self.assertFalse(any(".claude/worktrees" in m for m in full["basis"]["reactorModules"]))

    def test_detect_excludes_build_target_node_modules(self) -> None:
        # UT-004：target/build/dist/node_modules/cache 内伪 POM/source 不进入 inputs
        _make_java_project(self.tmp)
        for excluded in ("target", "build", "dist", "node_modules", ".gradle"):
            _write(self.tmp / excluded / "pom.xml", "<project/>\n")
            _write(self.tmp / excluded / "src" / "main" / "java" / "Fake.java", "class Fake {}\n")
        r = hp.detect(self.tmp)
        self.assertTrue(r["ok"])
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        full = profile["commands"]["unitTestFull"]
        for ex in ("target", "build", "dist", "node_modules", ".gradle"):
            self.assertFalse(any(p == f"{ex}/pom.xml" or p.startswith(f"{ex}/") for p in full["inputs"]),
                             msg=f"{ex} leaked into inputs: {full['inputs']}")
            self.assertNotIn(ex, full["basis"]["reactorModules"])

    def test_detect_perserves_user_override(self) -> None:
        # UT-006：source=user override → detect 保留覆写
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        profile["commands"]["compile"]["command"] = "mvn -f pom.xml compile -o -q -DskipTests"
        profile["commands"]["compile"]["source"] = "user"
        profile["commands"]["compile"]["argvTemplate"] = [
            "mvn", "-f", "pom.xml", "compile", "-o", "-q", "-DskipTests"
        ]
        (self.tmp / ".harness" / "config" / "build-profile.json").write_text(
            json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        hp.detect(self.tmp)
        profile2 = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile2["commands"]["compile"]["source"], "user")
        self.assertEqual(profile2["commands"]["compile"]["command"],
                         "mvn -f pom.xml compile -o -q -DskipTests")

    def test_detect_rebuilds_when_detected_basis_changes(self) -> None:
        # UT-007：detected basis 变化（加模块）→ 旧 detected 字段失效并重建
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        profile1 = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile1["commands"]["unitTestFull"]["basis"]["reactorModules"], ["."])
        _write(self.tmp / "module-new" / "pom.xml", "<project/>\n")
        _write(self.tmp / "module-new" / "src" / "test" / "java" / "T.java", "class T {}\n")
        hp.detect(self.tmp)
        profile2 = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertIn("module-new", profile2["commands"]["unitTestFull"]["basis"]["reactorModules"])
        self.assertIn("module-new/pom.xml", profile2["commands"]["unitTestFull"]["inputs"])

    def test_detect_idempotent(self) -> None:
        # UT-009：连续两次 detect → 结构字段稳定（忽略 detectedAt）
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        hp.detect(self.tmp)
        hp.detect(self.tmp)
        p1_text = (self.tmp / ".harness" / "config" / "build-profile.json").read_text(encoding="utf-8")
        hp.detect(self.tmp)
        p2_text = (self.tmp / ".harness" / "config" / "build-profile.json").read_text(encoding="utf-8")
        d1 = json.loads(p1_text)
        d2 = json.loads(p2_text)
        for k in ("schemaVersion", "projectType", "excludedRoots", "commands", "identifier"):
            self.assertEqual(d1[k], d2[k], msg=f"field {k} drifted across detect")

    def test_detect_java_generates_test_tracking(self) -> None:
        _make_java_project(self.tmp, modules=["module-a", "module-b"])
        profile = hp.detect(self.tmp)["profile"]
        tracking = profile["testTracking"]
        self.assertEqual(tracking["mode"], "force-track-touched")
        self.assertEqual(
            tracking["paths"],
            ["module-a/src/test/**", "module-b/src/test/**", "src/test/**"],
        )
        self.assertEqual(tracking["staleTestPolicy"], "safe-repair")
        self.assertTrue(tracking["forbidTemporaryExclusion"])

    def test_detect_preserves_user_test_tracking_override(self) -> None:
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        profile["testTracking"] = {
            "source": "user",
            "mode": "force-track-touched",
            "paths": ["custom-tests/**"],
            "staleTestPolicy": "safe-repair",
            "forbidTemporaryExclusion": True,
        }
        _write(
            self.tmp / ".harness" / "config" / "build-profile.json",
            json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
        )
        tracking = hp.detect(self.tmp)["profile"]["testTracking"]
        self.assertEqual(tracking["source"], "user")
        self.assertEqual(tracking["paths"], ["custom-tests/**"])

    def test_detect_ambiguous_polyglot_preserves_existing_profile(self) -> None:
        profile_path = self.tmp / ".harness" / "config" / "build-profile.json"
        existing = hp.empty_profile_skeleton(hp.DEFAULT_EXCLUDED_ROOTS)
        existing["projectType"] = "python-node-polyglot"
        existing["commands"] = {
            "unitTestFull": {
                "command": "run-all-tests",
                "argvTemplate": ["run-all-tests"],
                "scope": "full",
                "inputs": ["backend/**/*.py", "frontend/**/*.ts"],
                "coverage": "unitTestFull",
                "source": "detected",
                "basis": {"manualDetection": True},
            }
        }
        _write(profile_path, json.dumps(existing, ensure_ascii=False, indent=2) + "\n")
        before = profile_path.read_bytes()
        _write(self.tmp / "backend" / "pyproject.toml", "[project]\nname='backend'\n")
        _write(
            self.tmp / "frontend" / "package.json",
            json.dumps({"scripts": {"test": "vitest run"}}),
        )

        result = hp.detect(self.tmp)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "DETECTION_AMBIGUOUS")
        self.assertFalse(result["applied"])
        self.assertEqual(profile_path.read_bytes(), before)
        self.assertEqual(
            result["detectedComponents"],
            ["python:backend", "node:frontend"],
        )

    def test_detect_root_node_plus_nested_python_is_ambiguous(self) -> None:
        profile_path = self.tmp / ".harness" / "config" / "build-profile.json"
        existing = hp.empty_profile_skeleton(hp.DEFAULT_EXCLUDED_ROOTS)
        existing["projectType"] = "node-python-polyglot"
        _write(profile_path, json.dumps(existing, ensure_ascii=False, indent=2) + "\n")
        before = profile_path.read_bytes()
        _write(
            self.tmp / "package.json",
            json.dumps({"scripts": {"test": "vitest run"}}),
        )
        _write(self.tmp / "backend" / "pyproject.toml", "[project]\nname='backend'\n")

        result = hp.detect(self.tmp)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "DETECTION_AMBIGUOUS")
        self.assertEqual(profile_path.read_bytes(), before)
        self.assertEqual(result["detectedComponents"], ["python:backend"])


class CheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-check-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_check_missing_profile_is_stale(self) -> None:
        r = hp.check(self.tmp)
        self.assertTrue(r["stale"])
        self.assertEqual(r["status"], "missing")
        self.assertFalse(r["ok"])

    def test_check_ready_after_detect(self) -> None:
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        r = hp.check(self.tmp)
        self.assertFalse(r["stale"], msg=r.get("issues"))
        self.assertEqual(r["status"], "ready")

    def test_check_stale_when_pom_changes(self) -> None:
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        _write(self.tmp / "pom.xml",
               "<project><modelVersion>4.0.0</modelVersion><changed/></project>\n")
        r = hp.check(self.tmp)
        self.assertTrue(r["stale"])
        self.assertEqual(r["status"], "stale")

    def test_check_cli_exit_code_matches_readiness(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hp.main(["check", "--project", str(self.tmp), "--json"]), 1)
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hp.main(["check", "--project", str(self.tmp), "--json"]), 0)
        _write(self.tmp / "pom.xml", "<project><changed/></project>\n")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hp.main(["check", "--project", str(self.tmp), "--json"]), 1)
        _write(self.tmp / ".harness" / "config" / "build-profile.json", "{invalid")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hp.main(["check", "--project", str(self.tmp), "--json"]), 1)


class ValidateContainmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-contain-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_glob_escape_rejected(self) -> None:
        # UT-008：glob/symlink 逃出 project → validator 拒绝并给结构化错误
        _make_java_project(self.tmp)
        profile = hp.detect(self.tmp)["profile"]
        profile["commands"]["unitTestFull"]["inputs"].append("../outside/**")
        issues = hp.validate_profile(profile, self.tmp)
        self.assertTrue(
            any("outside" in i or "escape" in i.lower() or "containment" in i.lower() for i in issues),
            msg=f"expected escape rejection, got: {issues}",
        )

    def test_validate_rejects_excluded_root_in_inputs(self) -> None:
        # 排除目录的路径不得作为 verification input
        _make_java_project(self.tmp)
        profile = hp.detect(self.tmp)["profile"]
        profile["commands"]["compile"]["inputs"].append("target/src/**")
        issues = hp.validate_profile(profile, self.tmp)
        self.assertTrue(any("target" in i for i in issues),
                        msg=f"expected excluded-root rejection, got: {issues}")


class MigrateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-migrate-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_v1_profile(self) -> None:
        _write(self.tmp / "pom.xml", "<project/>\n")
        v1 = {
            "schemaVersion": 1,
            "detectedAt": "2026-01-01T00:00:00+08:00",
            "toolPaths": {"node": "C:\\node.exe", "mvn": "C:\\mvn.cmd"},
            "buildCommands": {
                "compile": "mvn compile",
                "unitTest": "mvn test",
                "unitTestFull": "mvn test",
                "install": "mvn install",
                "package": "mvn package",
            },
            "verificationInputs": {"unitTestFull": ["pom.xml", "src/**"]},
            "serviceStart": {
                "command": "java -jar app.jar",
                "healthUrl": "http://localhost:8080/health",
                "startTimeoutSec": 120,
                "inputFiles": ["src/main/java/App.java"],
                "profile": ".claude/worktrees/old-change",
                "overlayPath": ".claude/worktrees/old-change/overlay",
            },
            "knownPreexistingErrors": [],
            "shellQuirks": [],
            "fingerprint": {"mvnVersion": "3.9.0", "nodeVersion": "24.0", "pomHash": "deadbeef"},
        }
        _write(self.tmp / ".harness" / "config" / "build-profile.json",
               json.dumps(v1, ensure_ascii=False, indent=2) + "\n")

    def test_migrate_dry_run_no_write(self) -> None:
        # UT-005：dry-run 报 stale，不写
        self._write_v1_profile()
        before = (self.tmp / ".harness" / "config" / "build-profile.json").read_text(encoding="utf-8")
        r = hp.migrate(self.tmp, dry_run=True)
        self.assertTrue(r["ok"])
        self.assertTrue(r["dry_run"])
        after = (self.tmp / ".harness" / "config" / "build-profile.json").read_text(encoding="utf-8")
        self.assertEqual(before, after, msg="dry-run must not modify the file")
        self.assertTrue(r.get("needsMigration"), msg="dry-run should report needsMigration")

    def test_migrate_apply_creates_backup_and_removes_stale_paths(self) -> None:
        # UT-005：apply → 有备份，v2 无旧 worktree/change 路径
        self._write_v1_profile()
        r = hp.migrate(self.tmp, dry_run=False)
        self.assertTrue(r["ok"])
        self.assertTrue(r.get("backupPath"))
        self.assertTrue(Path(r["backupPath"]).is_file())
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        self.assertEqual(profile["schemaVersion"], 2)
        svc = profile.get("serviceStart", {})
        for field in ("profile", "overlayPath"):
            val = svc.get(field, "")
            self.assertFalse(
                str(val).startswith(".claude/worktrees") or "old-change" in str(val),
                msg=f"stale path leaked in serviceStart.{field}: {val}",
            )

    def test_migrate_idempotent(self) -> None:
        # UT-009：连续 migrate → 第二次 no-op
        self._write_v1_profile()
        r1 = hp.migrate(self.tmp, dry_run=False)
        self.assertTrue(r1["ok"])
        r2 = hp.migrate(self.tmp, dry_run=False)
        self.assertTrue(r2["ok"])
        self.assertFalse(r2.get("needsMigration"),
                        msg=f"second migrate on v2 should be no-op: {r2}")


class ResolveCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-resolve-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_resolve_substitutes_placeholders(self) -> None:
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        resolved = hp.resolve_command(profile, "unitTest", test_classes=["AppTest", "OtherTest"])
        self.assertIn("AppTest", resolved["command"])
        self.assertIn("OtherTest", resolved["command"])
        self.assertNotIn("{testClasses}", resolved["command"])
        # argv 是 list（非简单字符串 split）
        self.assertIsInstance(resolved.get("argv"), list)
        self.assertTrue(any("AppTest" in str(t) for t in resolved["argv"]))

    def test_resolve_cli_subcommand(self) -> None:
        """API-004/RET-14：文档（submit/test SKILL+checklist、java overlay）承诺
        `harness_profile.py resolve --project . --key <k> --json`，CLI 必须真实暴露
        该子命令并复用 resolve_command 语义。"""
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hp.main([
                "resolve", "--project", str(self.tmp), "--key", "unitTest",
                "--test-classes", "AppTest,OtherTest", "--json",
            ])
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertIn("AppTest", payload["command"])
        self.assertIn("OtherTest", payload["command"])
        self.assertNotIn("{testClasses}", payload["command"])
        self.assertIsInstance(payload.get("argv"), list)

    def test_resolve_cli_without_placeholders(self) -> None:
        """文档主路径：`resolve --project . --key unitTestFull --json` 无占位参数。"""
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hp.main([
                "resolve", "--project", str(self.tmp), "--key", "unitTestFull", "--json",
            ])
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertIn("command", payload)
        self.assertIn("scope", payload)

    def test_resolve_cli_unknown_key_nonzero(self) -> None:
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hp.main(["resolve", "--project", str(self.tmp), "--key", "nope", "--json"])
        self.assertNotEqual(rc, 0)

    def test_persistent_profile_has_no_concrete_worktree(self) -> None:
        # spec §3.1：持久 profile 只保存模板，不含具体 change-name/worktree 路径。
        # excludedRoots 含 ".claude/worktrees" 是排除规则模式（模板），不是具体路径。
        # 具体 worktree 路径应出现在 serviceStart.profile/overlayPath（runtime overlay），
        # detect 必须留空，由 resolve 阶段填充到 change runtime/session。
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        svc = profile["serviceStart"]
        self.assertEqual(svc["profile"], "",
                         msg="serviceStart.profile must be empty in persistent profile")
        self.assertEqual(svc["overlayPath"], "",
                         msg="serviceStart.overlayPath must be empty in persistent profile")
        self.assertIn(".claude/worktrees", profile["excludedRoots"])


class ExcludedRootsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-excl-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_excluded_roots_present(self) -> None:
        _make_java_project(self.tmp)
        hp.detect(self.tmp)
        profile = _read_json(self.tmp / ".harness" / "config" / "build-profile.json")
        excluded = set(profile["excludedRoots"])
        for required in (
            ".git",
            ".harness",
            ".worktrees",
            ".claude/worktrees",
            ".codex/worktrees",
            ".cursor/worktrees",
            ".codebuddy/worktrees",
            "target",
            "build",
            "dist",
            "node_modules",
            ".gradle",
        ):
            self.assertIn(required, excluded, msg=f"missing excluded root {required}")

    def test_is_path_excluded(self) -> None:
        excluded = (".git", ".harness", ".worktrees", ".claude/worktrees", "target", "node_modules")
        self.assertTrue(hp.is_path_excluded("target/pom.xml", excluded))
        self.assertTrue(hp.is_path_excluded(".worktrees/x/pom.xml", excluded))
        self.assertTrue(hp.is_path_excluded(".claude/worktrees/x/pom.xml", excluded))
        self.assertTrue(hp.is_path_excluded("node_modules/foo.js", excluded))
        self.assertFalse(hp.is_path_excluded("pom.xml", excluded))
        self.assertFalse(hp.is_path_excluded("src/main/App.java", excluded))
        self.assertFalse(hp.is_path_excluded(".worktrees-other/x.py", excluded))


def _make_node_project(tmp: Path, check_script: str | None = "npm run lint") -> None:
    """Node fixture: package.json with a check script (+ optional harness/ dir)."""
    scripts = {"lint": "eslint ."}
    if check_script is not None:
        scripts["check"] = check_script
    _write(tmp / "package.json", json.dumps({"name": "demo", "scripts": scripts}))
    _write(tmp / "vitest.config.ts", "export default {}\n")


class NodeCommandsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-node-"))

    def test_detect_node_has_unittestfull_command(self) -> None:
        _make_node_project(self.tmp, check_script="npm run lint && npm test")
        profile = hp.detect(self.tmp)["profile"]
        cmds = profile["commands"]
        self.assertIn("unitTestFull", cmds)
        self.assertEqual(cmds["unitTestFull"]["scope"], "full")
        self.assertEqual(cmds["unitTestFull"]["coverage"], "unitTestFull")
        self.assertEqual(cmds["unitTestFull"]["command"], "npm run lint && npm test")
        self.assertEqual(cmds["unitTestFull"]["source"], "detected")
        self.assertIn("unitTestFull", profile["verificationInputs"])

    def test_detect_node_inputs_closure_covers_ts_sources_and_config(self) -> None:
        _make_node_project(self.tmp)
        profile = hp.detect(self.tmp)["profile"]
        inputs = profile["commands"]["unitTestFull"]["inputs"]
        for pat in ["package.json", "vitest.config.*", "src/**/*.ts", "test/**/*.ts"]:
            self.assertIn(pat, inputs)
        self.assertFalse(any(p.startswith("node_modules") for p in inputs))

    def test_detect_node_harness_dogfood_extends_inputs(self) -> None:
        _make_node_project(self.tmp)
        _write(self.tmp / "harness" / "scripts" / "harness_profile.py", "# py\n")
        profile = hp.detect(self.tmp)["profile"]
        inputs = profile["commands"]["unitTestFull"]["inputs"]
        self.assertIn("harness/scripts/*.py", inputs)
        self.assertIn("harness/harness-test/scripts/*.mjs", inputs)

    def test_detect_node_without_check_or_test_has_no_commands(self) -> None:
        _write(self.tmp / "package.json", json.dumps({"name": "x", "scripts": {"lint": "eslint ."}}))
        profile = hp.detect(self.tmp)["profile"]
        self.assertEqual(profile["commands"], {})

    def test_detect_node_prefers_check_over_test(self) -> None:
        _write(
            self.tmp / "package.json",
            json.dumps({"name": "x", "scripts": {"check": "npm run lint", "test": "vitest"}}),
        )
        profile = hp.detect(self.tmp)["profile"]
        self.assertEqual(profile["commands"]["unitTestFull"]["command"], "npm run lint")
        self.assertEqual(profile["commands"]["unitTestFull"]["basis"]["packageScript"], "check")

    def test_detect_node_generates_test_tracking_paths(self) -> None:
        _make_node_project(self.tmp)
        tracking = hp.detect(self.tmp)["profile"]["testTracking"]
        for pattern in (
            "test/**/*.ts",
            "test/**/*.tsx",
            "packages/*/test/**/*.ts",
            "apps/*/test/**/*.tsx",
            "tests/**/*.js",
            "test/**/*.jsx",
            "test/**/*.mjs",
            "test/**/*.cjs",
            "**/*.test.js",
            "**/*.spec.tsx",
        ):
            self.assertIn(pattern, tracking["paths"])


class LoadProfileLayeredTests(unittest.TestCase):
    """C7: load_profile 先读 common 再叠加 execution override。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-layered-"))
        self.common = self.tmp / "common"
        self.common.mkdir()
        self.execution = self.tmp / "execution"
        self.execution.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_profile(self, root: Path, data: dict) -> None:
        path = root / ".harness" / "config" / "build-profile.json"
        _write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def test_load_profile_reads_common_then_overlays_execution(self) -> None:
        # common profile has unitTest + compile
        self._write_profile(self.common, {
            "schemaVersion": 1,
            "buildCommands": {
                "unitTest": "mvn test",
                "compile": "mvn compile",
            },
        })
        # execution profile overrides unitTest only
        self._write_profile(self.execution, {
            "schemaVersion": 1,
            "buildCommands": {
                "unitTest": "mvn test -pl module",
            },
        })

        # Mock common_root to return self.common for self.execution
        from unittest import mock
        with mock.patch.object(hp.harness_paths, "common_root", return_value=self.common.resolve()):
            profile = hp.load_profile(self.execution)
        self.assertIsNotNone(profile)
        cmds = profile["buildCommands"]
        # unitTest overridden by execution
        self.assertEqual(cmds["unitTest"], "mvn test -pl module")
        # compile preserved from common
        self.assertEqual(cmds["compile"], "mvn compile")

    def test_load_profile_falls_back_to_common_when_execution_missing(self) -> None:
        self._write_profile(self.common, {
            "schemaVersion": 1,
            "buildCommands": {"unitTest": "mvn test"},
        })
        # execution has no build-profile.json
        from unittest import mock
        with mock.patch.object(hp.harness_paths, "common_root", return_value=self.common.resolve()):
            profile = hp.load_profile(self.execution)
        self.assertIsNotNone(profile)
        self.assertEqual(profile["buildCommands"]["unitTest"], "mvn test")

    def test_load_profile_returns_none_when_both_missing(self) -> None:
        from unittest import mock
        with mock.patch.object(hp.harness_paths, "common_root", return_value=self.common.resolve()):
            profile = hp.load_profile(self.execution)
        self.assertIsNone(profile)


class ResolveCommandPlaceholderTests(unittest.TestCase):
    """C7: resolve_command 支持 {commonRoot}/{executionRoot} 占位符。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="profile-placeholder-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_resolve_command_substitutes_common_root(self) -> None:
        profile = {
            "commands": {
                "buildIndex": {
                    "command": "python {commonRoot}/scripts/build.py",
                    "scope": "module",
                }
            }
        }
        resolved = hp.resolve_command(
            profile, "buildIndex",
            common_root=self.tmp,
        )
        self.assertNotIn("{commonRoot}", resolved["command"])
        self.assertIn(str(self.tmp), resolved["command"])

    def test_resolve_command_substitutes_execution_root(self) -> None:
        exec_root = self.tmp / "worktree"
        exec_root.mkdir()
        profile = {
            "commands": {
                "localTest": {
                    "command": "mvn test -pl {executionRoot}",
                    "scope": "module",
                }
            }
        }
        resolved = hp.resolve_command(
            profile, "localTest",
            execution_root=exec_root,
        )
        self.assertNotIn("{executionRoot}", resolved["command"])
        self.assertIn(str(exec_root), resolved["command"])


if __name__ == "__main__":
    unittest.main()
