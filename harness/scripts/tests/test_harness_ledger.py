#!/usr/bin/env python3
"""Unittests for harness_ledger.py (P0-5)."""

from __future__ import annotations

import json
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_ledger  # noqa: E402


class InputsHashTests(unittest.TestCase):
    def test_hash_stable_and_order_independent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = root / "a.java"
            b = root / "b.java"
            a.write_text("class A {}", encoding="utf-8")
            b.write_text("class B {}", encoding="utf-8")

            h1, files1 = harness_ledger.compute_inputs_hash([str(a), str(b)])
            h2, files2 = harness_ledger.compute_inputs_hash([str(b), str(a)])

            self.assertTrue(h1.startswith("sha256:"))
            self.assertEqual(h1, h2)
            self.assertEqual(files1, files2)
            self.assertEqual(files1, sorted(files1))

    def test_hash_cli_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            f1 = root / "one.txt"
            f2 = root / "two.txt"
            f1.write_text("alpha", encoding="utf-8")
            f2.write_text("beta", encoding="utf-8")

            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "hash",
                        "--files",
                        f"{f2},{f1}",
                    ]
                )
            self.assertEqual(code, 0)
            payload = json.loads(buf.getvalue())
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["inputsHash"].startswith("sha256:"))
            self.assertEqual(payload["fileCount"], 2)


class CanReuseTests(unittest.TestCase):
    def _write_ledger(self, change_dir: Path, data: dict) -> Path:
        path = change_dir / "evidence" / "verification-ledger.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        return path

    def test_reuse_when_fingerprint_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-1"
            change.mkdir()
            src = change / "Foo.java"
            src.write_text("class Foo {}", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(src)])

            self._write_ledger(
                change,
                {
                    "changeName": "change-1",
                    "diffHash": "sha256:deadbeef",
                    "worktreeRoot": None,
                    "validations": {
                        "compile": {
                            "status": "OK",
                            "command": "mvn compile -pl m -o -q",
                            "scope": "module",
                            "evidence": "BUILD SUCCESS",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                            "algorithmVersion": "harness-ledger-2",
                            "coverage": "module",
                            "durationMs": 1200,
                            "exitCode": 0,
                        }
                    },
                },
            )

            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="compile",
                files=[str(src)],
            )
            self.assertTrue(result["reuse"])
            self.assertEqual(result["reason"], "reuse")
            self.assertEqual(result["marker"], "REUSED")
            self.assertIn("evidence_summary", result)

    def test_rerun_when_fingerprint_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-2"
            change.mkdir()
            src = change / "Foo.java"
            src.write_text("class Foo {}", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(src)])

            self._write_ledger(
                change,
                {
                    "changeName": "change-2",
                    "diffHash": "sha256:abc",
                    "validations": {
                        "unitTest": {
                            "status": "OK",
                            "command": "mvn test -pl m -Dtest=FooTest",
                            "scope": "FooTest",
                            "evidence": "Tests run: 1, Failures: 0",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                            "algorithmVersion": "harness-ledger-2",
                            "coverage": "incremental",
                        }
                    },
                },
            )

            src.write_text("class Foo { int x; }", encoding="utf-8")
            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTest",
                files=[str(src)],
                requested_scope="FooTest",
            )
            self.assertFalse(result["reuse"])
            self.assertEqual(result["reason"], "rerun")

    def test_insufficient_evidence_old_ledger_without_inputs_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-old"
            change.mkdir()
            src = change / "Bar.java"
            src.write_text("class Bar {}", encoding="utf-8")

            # Legacy root path, no inputsHash/inputsFiles.
            legacy = change / "verification-ledger.json"
            legacy.write_text(
                json.dumps(
                    {
                        "changeName": "change-old",
                        "diffHash": "sha256:legacy",
                        "validations": {
                            "compile": {
                                "status": "OK",
                                "command": "mvn compile",
                                "scope": "module",
                                "evidence": "BUILD SUCCESS",
                            }
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
                newline="\n",
            )

            # Must not crash; must refuse reuse.
            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="compile",
                files=[str(src)],
            )
            self.assertFalse(result["reuse"])
            self.assertEqual(result["reason"], "insufficient-evidence")

    def test_install_requires_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-install"
            change.mkdir()
            src = change / "Upstream.java"
            src.write_text("class Upstream {}", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(src)])

            self._write_ledger(
                change,
                {
                    "changeName": "change-install",
                    "diffHash": "sha256:x",
                    "worktreeRoot": None,
                    "validations": {
                        "install": {
                            "status": "OK",
                            "command": "mvn install -pl m -am -DskipTests",
                            "scope": "module-am",
                            "evidence": "BUILD SUCCESS",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                            "algorithmVersion": "harness-ledger-2",
                            "coverage": "module-am",
                        }
                    },
                },
            )
            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="install",
                files=[str(src)],
            )
            self.assertFalse(result["reuse"])
            self.assertEqual(result["reason"], "insufficient-evidence")

            # With worktree → reuse.
            ledger_path = change / "evidence" / "verification-ledger.json"
            data = json.loads(ledger_path.read_text(encoding="utf-8"))
            data["worktreeRoot"] = str(Path(tmp) / "wt")
            ledger_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            result2 = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="install",
                files=[str(src)],
            )
            self.assertTrue(result2["reuse"])
            self.assertEqual(result2["reason"], "reuse")

    # --- Task 1: unitTestFull final full-test gate (REMEDIATION-DESIGN §3) ---

    def test_unit_test_full_is_valid_cli_choice(self) -> None:
        self.assertIn("unitTestFull", harness_ledger.VERIFICATIONS)

    def test_inputs_hash_binds_paths_as_well_as_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = root / "first.java", root / "second.java"
            first.write_text("A", encoding="utf-8")
            second.write_text("B", encoding="utf-8")
            before, _ = harness_ledger.compute_inputs_hash([str(first), str(second)])
            first.write_text("B", encoding="utf-8")
            second.write_text("A", encoding="utf-8")
            after, _ = harness_ledger.compute_inputs_hash([str(first), str(second)])
            self.assertNotEqual(before, after)

    def test_incremental_unit_test_cannot_satisfy_full_gate(self) -> None:
        # Ledger 只有 validations.unitTest（增量，scope=FooTest）。
        # 请求 unitTestFull 必须不可复用：增量结果不能冒充全量门禁。
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-inc"
            change.mkdir()
            src = change / "Foo.java"
            src.write_text("class Foo {}", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(src)])
            self._write_ledger(
                change,
                {
                    "changeName": "change-inc",
                    "validations": {
                        "unitTest": {
                            "status": "OK",
                            "command": "mvn test -Dtest=FooTest",
                            "scope": "FooTest",
                            "evidence": "Tests run: 1, Failures: 0",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                        }
                    },
                },
            )
            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_scope="module",
            )
            self.assertFalse(result["reuse"])
            self.assertEqual(result["reason"], "insufficient-evidence")

    def test_full_gate_reuses_matching_module_evidence(self) -> None:
        # validations.unitTestFull status=OK scope=module，文件/命令一致 → reuse=True。
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-full"
            change.mkdir()
            src = change / "Foo.java"
            src.write_text("class Foo {}", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(src)])
            command = "mvn test -pl m -o"
            self._write_ledger(
                change,
                {
                    "changeName": "change-full",
                    "validations": {
                        "unitTestFull": {
                            "status": "OK",
                            "command": command,
                            "scope": "module",
                            "evidence": "Tests run: 5, Failures: 0",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                            "algorithmVersion": "harness-ledger-2",
                            "coverage": "module",
                        }
                    },
                },
            )
            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_command=command,
            )
            self.assertTrue(result["reuse"])
            self.assertEqual(result["reason"], "reuse")

    def test_full_gate_rejects_incremental_scope(self) -> None:
        # validations.unitTestFull scope=FooTest（增量范围）→ 必须 reuse=False。
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-scope"
            change.mkdir()
            src = change / "Foo.java"
            src.write_text("class Foo {}", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(src)])
            self._write_ledger(
                change,
                {
                    "changeName": "change-scope",
                    "validations": {
                        "unitTestFull": {
                            "status": "OK",
                            "command": "mvn test -pl m -o",
                            "scope": "FooTest",
                            "evidence": "Tests run: 1, Failures: 0",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                        }
                    },
                },
            )
            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
            )
            self.assertFalse(result["reuse"])
            self.assertEqual(result["reason"], "insufficient-evidence")

    def test_record_and_reuse_unit_test_full_via_profile_input(self) -> None:
        # 最终门禁用 --profile-input unitTestFull 从 build-profile 展开
        # verificationInputs.unitTestFull glob 计算依赖闭包文件集，
        # 禁止用仅含 staged 文件的 --files 快捷方式冒充全量闭包。
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / ".harness" / "config").mkdir(parents=True)
            (project / "pom.xml").write_text("<project/>", encoding="utf-8")
            main_dir = project / "module" / "src" / "main"
            main_dir.mkdir(parents=True)
            (main_dir / "A.java").write_text("class A {}", encoding="utf-8")
            (main_dir / "B.java").write_text("class B {}", encoding="utf-8")
            profile = {
                "schemaVersion": 1,
                "buildCommands": {"unitTestFull": "mvn test -pl module -o"},
                "verificationInputs": {
                    "unitTestFull": ["pom.xml", "module/src/main/**"]
                },
            }
            (project / ".harness" / "config" / "build-profile.json").write_text(
                json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            change = project / ".harness" / "changes" / "c1"
            change.mkdir(parents=True)
            command = "mvn test -pl module -o"

            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                rcode = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--status",
                        "ok",
                        "--command",
                        command,
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "1000",
                        "--evidence",
                        "Tests run: 2, Failures: 0",
                        "--scope",
                        "module",
                        "--project",
                        str(project),
                        "--profile-input",
                        "unitTestFull",
                    ]
                )
            self.assertEqual(rcode, 0, msg=buf.getvalue())

            buf2 = StringIO()
            with redirect_stdout(buf2):
                ccode = harness_ledger.main(
                    [
                        "--json",
                        "can-reuse",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--project",
                        str(project),
                        "--profile-input",
                        "unitTestFull",
                        "--command",
                        command,
                        "--verbose",
                    ]
                )
            self.assertEqual(ccode, 0, msg=buf2.getvalue())
            payload = json.loads(buf2.getvalue())
            self.assertTrue(payload["reuse"], msg=payload)
            self.assertEqual(payload["reason"], "reuse")


class RecordTests(unittest.TestCase):
    def test_record_preserves_diff_hash_and_adds_inputs_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-record"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            legacy = change / "verification-ledger.json"
            legacy.write_text(
                json.dumps(
                    {
                        "changeName": "change-record",
                        "diffHash": "sha256:keep-me",
                        "module": "demo",
                        "profile": "local-dev",
                        "validations": {
                            "apiTest": {
                                "status": "OK",
                                "evidence": "old api",
                                "command": "playwright",
                            }
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
                newline="\n",
            )

            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "compile",
                        "--status",
                        "ok",
                        "--command",
                        "mvn compile -pl demo -o -q",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "900",
                        "--files",
                        str(src),
                        "--evidence",
                        "BUILD SUCCESS",
                        "--scope",
                        "module",
                    ]
                )
            self.assertEqual(code, 0)

            out = change / "evidence" / "verification-ledger.json"
            self.assertTrue(out.is_file())
            # UTF-8 without BOM
            raw = out.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))

            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["diffHash"], "sha256:keep-me")
            self.assertEqual(data["module"], "demo")
            self.assertIn("apiTest", data["validations"])
            compile_entry = data["validations"]["compile"]
            self.assertEqual(compile_entry["status"], "OK")
            self.assertTrue(compile_entry["inputsHash"].startswith("sha256:"))
            self.assertIsInstance(compile_entry["inputsFiles"], list)
            self.assertEqual(compile_entry["durationMs"], 900)
            self.assertEqual(compile_entry["exitCode"], 0)

    def test_record_then_can_reuse_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-rt"
            change.mkdir()
            src = change / "X.java"
            src.write_text("class X {}", encoding="utf-8")

            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTest",
                        "--status",
                        "ok",
                        "--command",
                        "mvn test -Dtest=XTest",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "1500",
                        "--files",
                        str(src),
                        "--evidence",
                        "Tests run: 2, Failures: 0",
                        "--scope",
                        "XTest",
                    ]
                )
            self.assertEqual(code, 0)

            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTest",
                files=[str(src)],
                requested_scope="XTest",
            )
            self.assertTrue(result["reuse"])
            self.assertEqual(result["reason"], "reuse")


class CliSmokeTests(unittest.TestCase):
    def test_can_reuse_json_flag_after_subcommand(self) -> None:
        # Gate 1 格式（设计 §3.5 与 skill 文档一致）：--json 位于子命令之后。
        # argparse 子命令切换后必须仍能识别全局 --json，否则 skill 实际命令
        # `harness_ledger.py can-reuse ... --json` 会以 exit 2 失败。
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-cli"
            change.mkdir()
            src = change / "Foo.java"
            src.write_text("class Foo {}", encoding="utf-8")

            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "can-reuse",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--files",
                        str(src),
                        "--json",
                        "--verbose",
                    ]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            payload = json.loads(buf.getvalue())
            self.assertFalse(payload["reuse"])
            self.assertEqual(payload["reason"], "insufficient-evidence")


def _init_repo(root: Path, files: dict, *, commit: bool = True) -> str:
    """Init a git repo, write files, optionally commit as base. Returns base commit."""
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "tester"], cwd=root, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=root, check=True)
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    if commit and files:
        subprocess.run(["git", "add", "-A"], cwd=root, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=root, check=True)
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()


def _head(root: Path) -> str:
    import subprocess

    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()


class DiffHashTests(unittest.TestCase):
    """Cluster 2: byte-level, commit-invariant diff-hash (UT-010..013, API-003)."""

    def test_diff_hash_has_algorithm_version_on_dirty_tree(self) -> None:  # UT-010
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {"a.txt": "hello\n"})
            (root / "a.txt").write_text("hello world\n", encoding="utf-8")  # dirty tracked
            h, meta = harness_ledger.compute_diff_hash(root, base=base)
            self.assertTrue(h.startswith("sha256:"))
            self.assertIn("algorithmVersion", meta)
            self.assertTrue(str(meta["algorithmVersion"]).strip())
            self.assertGreater(meta["fileCount"], 0)
            self.assertEqual(meta["base"], base)

    def test_diff_hash_stable_across_checkpoint_commit(self) -> None:  # UT-011
        # Same content, first uncommitted then committed -> hash identical.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {"tracked.txt": "v1\n"})
            (root / "tracked.txt").write_text("v2\n", encoding="utf-8")  # tracked mod
            (root / "new.txt").write_bytes(b"new file content\n")  # untracked add
            h1, m1 = harness_ledger.compute_diff_hash(root, base=base)

            import subprocess

            subprocess.run(["git", "add", "-A"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "checkpoint"], cwd=root, check=True)
            h2, m2 = harness_ledger.compute_diff_hash(root, base=base)
            self.assertEqual(h1, h2)  # commit-invariant
            self.assertEqual(m1["fileCount"], m2["fileCount"])

    def test_diff_hash_chinese_path_crlf_encoding_independent(self) -> None:  # UT-012
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {"a.txt": "x\n"})
            chinese = "中文目录/文件.txt"
            (root / chinese).parent.mkdir(parents=True, exist_ok=True)
            (root / chinese).write_bytes("内容\r\nCRLF".encode("utf-8"))
            (root / "a.txt").write_text("xx\n", encoding="utf-8")
            h1, _ = harness_ledger.compute_diff_hash(root, base=base)
            h2, _ = harness_ledger.compute_diff_hash(root, base=base)  # deterministic
            self.assertEqual(h1, h2)
            # CRLF -> LF changes content bytes -> hash changes
            (root / chinese).write_bytes("内容\nCRLF".encode("utf-8"))
            h3, _ = harness_ledger.compute_diff_hash(root, base=base)
            self.assertNotEqual(h1, h3)

    def test_diff_hash_untracked_binary_sorted_no_collision(self) -> None:  # UT-013
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {"base.txt": "b\n"})
            (root / "u1.txt").write_bytes(b"alpha")
            (root / "u2.bin").write_bytes(b"\x00\x01\x02\xff binary")
            h, meta = harness_ledger.compute_diff_hash(root, base=base)
            self.assertTrue(h.startswith("sha256:"))
            # Stable (discovery order independent via sort)
            h_again, _ = harness_ledger.compute_diff_hash(root, base=base)
            self.assertEqual(h, h_again)
            # No collision: different binary content -> different hash
            (root / "u2.bin").write_bytes(b"\x00\x01\x02\xfe different")
            h2, _ = harness_ledger.compute_diff_hash(root, base=base)
            self.assertNotEqual(h, h2)

    def test_diff_hash_cli_json(self) -> None:  # API-003
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {"a.txt": "hi\n"})
            (root / "a.txt").write_text("hi there\n", encoding="utf-8")
            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    ["--json", "diff-hash", "--repo", str(root), "--base", base]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            payload = json.loads(buf.getvalue())
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["diffHash"].startswith("sha256:"))
            self.assertIn("algorithmVersion", payload)
            self.assertGreater(payload["fileCount"], 0)

    def _write_test_tracking(self, root: Path, change_dir: Path, rel: str) -> None:
        target = root / rel
        digest = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
        manifest = {
            "schemaVersion": 1,
            "mode": "force-track-touched",
            "projectRoot": str(root.resolve()),
            "files": [
                {
                    "path": rel,
                    "sha256": digest,
                    "reason": "test-updated",
                    "ignored": True,
                    "trackedBefore": False,
                }
            ],
        }
        path = change_dir / "evidence" / "test-tracking.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_diff_hash_includes_ignored_test_from_tracking_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {".gitignore": "src/test/\n", "a.txt": "hi\n"})
            rel = "src/test/java/StaleTest.java"
            target = root / rel
            target.parent.mkdir(parents=True)
            target.write_text("class StaleTest {}\n", encoding="utf-8")
            change_dir = root / ".harness" / "changes" / "fix"
            self._write_test_tracking(root, change_dir, rel)

            without_manifest, _ = harness_ledger.compute_diff_hash(root, base=base)
            with_manifest, meta = harness_ledger.compute_diff_hash(
                root, base=base, change_dir=change_dir
            )

            self.assertNotEqual(without_manifest, with_manifest)
            self.assertEqual(meta["trackedTestFileCount"], 1)

    def test_diff_hash_rejects_tracking_manifest_hash_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {".gitignore": "src/test/\n", "a.txt": "hi\n"})
            rel = "src/test/java/StaleTest.java"
            target = root / rel
            target.parent.mkdir(parents=True)
            target.write_text("class StaleTest {}\n", encoding="utf-8")
            change_dir = root / ".harness" / "changes" / "fix"
            self._write_test_tracking(root, change_dir, rel)
            target.write_text("class ChangedAfterRecord {}\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "HASH_DRIFT"):
                harness_ledger.compute_diff_hash(root, base=base, change_dir=change_dir)

    def test_diff_hash_rejects_tracking_manifest_symlink_outside_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            outside = Path(outside_tmp)
            base = _init_repo(root, {"a.txt": "hi\n"})
            change_dir = root / ".harness" / "changes" / "fix"
            change_dir.mkdir(parents=True)
            try:
                os.symlink(outside, change_dir / "evidence", target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlink unavailable: {exc}")
            (outside / "test-tracking.json").write_text("{}", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "MANIFEST_OUTSIDE_CHANGE"):
                harness_ledger.compute_diff_hash(root, base=base, change_dir=change_dir)

    def test_diff_hash_rejects_tracking_manifest_symlink_to_another_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {".gitignore": "src/test/\n", "a.txt": "hi\n"})
            rel = "src/test/java/StaleTest.java"
            target = root / rel
            target.parent.mkdir(parents=True)
            target.write_text("class StaleTest {}\n", encoding="utf-8")
            change_b = root / ".harness" / "changes" / "b"
            self._write_test_tracking(root, change_b, rel)
            change_a = root / ".harness" / "changes" / "a"
            change_a.mkdir(parents=True)
            try:
                os.symlink(change_b / "evidence", change_a / "evidence", target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlink unavailable: {exc}")

            with self.assertRaisesRegex(ValueError, "MANIFEST_OUTSIDE_CHANGE"):
                harness_ledger.compute_diff_hash(root, base=base, change_dir=change_a)

    def test_diff_hash_rejects_test_content_change_after_manifest_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {".gitignore": "src/test/\n", "a.txt": "hi\n"})
            rel = "src/test/java/StaleTest.java"
            target = root / rel
            target.parent.mkdir(parents=True)
            target.write_text("class StaleTest {}\n", encoding="utf-8")
            change_dir = root / ".harness" / "changes" / "fix"
            self._write_test_tracking(root, change_dir, rel)
            original_read_bytes = Path.read_bytes
            target_resolved = target.resolve()
            target_reads = 0

            def racing_read_bytes(path: Path) -> bytes:
                nonlocal target_reads
                content = original_read_bytes(path)
                if path.resolve() == target_resolved and target_reads == 0:
                    target_reads += 1
                    target.write_text("class ChangedAfterValidation {}\n", encoding="utf-8")
                return content

            with mock.patch.object(Path, "read_bytes", autospec=True, side_effect=racing_read_bytes):
                with self.assertRaisesRegex(ValueError, "HASH_DRIFT"):
                    harness_ledger.compute_diff_hash(root, base=base, change_dir=change_dir)

    def test_diff_hash_manifest_is_commit_invariant_after_force_add(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {".gitignore": "src/test/\n", "a.txt": "hi\n"})
            rel = "src/test/java/StaleTest.java"
            target = root / rel
            target.parent.mkdir(parents=True)
            target.write_text("class StaleTest {}\n", encoding="utf-8")
            change_dir = root / ".harness" / "changes" / "fix"
            self._write_test_tracking(root, change_dir, rel)

            before, _ = harness_ledger.compute_diff_hash(
                root, base=base, change_dir=change_dir
            )
            import subprocess

            subprocess.run(["git", "add", "-f", "--", rel], cwd=root, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "track test"], cwd=root, check=True)
            after, _ = harness_ledger.compute_diff_hash(
                root, base=base, change_dir=change_dir
            )
            self.assertEqual(before, after)

    def test_diff_hash_cli_accepts_change_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = _init_repo(root, {".gitignore": "src/test/\n", "a.txt": "hi\n"})
            rel = "src/test/java/StaleTest.java"
            target = root / rel
            target.parent.mkdir(parents=True)
            target.write_text("class StaleTest {}\n", encoding="utf-8")
            change_dir = root / ".harness" / "changes" / "fix"
            self._write_test_tracking(root, change_dir, rel)
            from contextlib import redirect_stdout
            from io import StringIO

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "diff-hash",
                        "--repo",
                        str(root),
                        "--base",
                        base,
                        "--change-dir",
                        str(change_dir),
                    ]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            self.assertEqual(json.loads(buf.getvalue())["trackedTestFileCount"], 1)


class LedgerV2Tests(unittest.TestCase):
    """Cluster 2: v2 schema, coverage lattice, package, structured codes (UT-014..018, COM-002, API-004/005)."""

    def _write_ledger(self, change_dir: Path, data: dict) -> Path:
        path = change_dir / "evidence" / "verification-ledger.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        return path

    def _v2_entry(self, inputs_hash: str, inputs_files: list[str], **over) -> dict:
        entry = {
            "status": "OK",
            "command": "mvn test -pl m -o",
            "evidence": "Tests run: 5, Failures: 0",
            "inputsHash": inputs_hash,
            "inputsFiles": inputs_files,
            "algorithmVersion": "harness-ledger-2",
            "coverage": "module",
        }
        entry.update(over)
        return entry

    def test_v1_entry_without_v2_fields_is_insufficient_evidence(self) -> None:  # UT-014
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            ih, ifiles = harness_ledger.compute_inputs_hash([str(src)])
            # v1 entry: no algorithmVersion, no coverage
            self._write_ledger(
                change,
                {
                    "changeName": "c",
                    "validations": {
                        "unitTest": {
                            "status": "OK",
                            "command": "mvn test -Dtest=FooTest",
                            "scope": "FooTest",
                            "evidence": "Tests run: 1, Failures: 0",
                            "inputsHash": ih,
                            "inputsFiles": ifiles,
                        }
                    },
                },
            )
            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTest",
                files=[str(src)],
                requested_scope="FooTest",
            )
            self.assertFalse(r["reuse"])
            self.assertEqual(r["reason"], "insufficient-evidence")
            self.assertEqual(r.get("code"), "MISSING_V2_FIELDS")

    def test_record_unit_test_does_not_create_unit_test_full(self) -> None:  # UT-015
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTest",
                        "--status",
                        "ok",
                        "--command",
                        "mvn test -Dtest=FooTest",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "100",
                        "--files",
                        str(src),
                        "--evidence",
                        "Tests run: 1, Failures: 0",
                        "--scope",
                        "FooTest",
                    ]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            data = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(encoding="utf-8")
            )
            self.assertIn("unitTest", data["validations"])
            self.assertNotIn("unitTestFull", data["validations"])  # no silent promotion
            self.assertEqual(data["validations"]["unitTest"]["coverage"], "incremental")
            self.assertEqual(
                data["validations"]["unitTest"]["algorithmVersion"],
                harness_ledger.LEDGER_VERSION,
            )

    def test_record_unit_test_full_reusable_for_submit(self) -> None:  # UT-016 / API-004
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--status",
                        "ok",
                        "--command",
                        "mvn test -pl m -o",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "1000",
                        "--files",
                        str(src),
                        "--evidence",
                        "Tests run: 5, Failures: 0",
                        "--scope",
                        "module",
                    ]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            # submit reuses unitTestFull without a second full test
            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_command="mvn test -pl m -o",
            )
            self.assertTrue(r["reuse"], msg=r)
            self.assertEqual(r["reason"], "reuse")

    def test_incremental_unit_test_cannot_be_reused_as_full(self) -> None:  # API-005
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            ih, ifiles = harness_ledger.compute_inputs_hash([str(src)])
            # unitTest entry (incremental) recorded with v2 fields
            self._write_ledger(
                change,
                {
                    "changeName": "c",
                    "validations": {
                        "unitTest": self._v2_entry(
                            ih, ifiles,
                            command="mvn test -Dtest=FooTest",
                            scope="FooTest",
                            coverage="incremental",
                            evidence="Tests run: 1, Failures: 0",
                        )
                    },
                },
            )
            # submit asks for unitTestFull -> must NOT reuse incremental evidence
            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_scope="module",
            )
            self.assertFalse(r["reuse"])
            self.assertEqual(r["reason"], "insufficient-evidence")

    def test_command_change_returns_rerun(self) -> None:  # UT-017 command
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            ih, ifiles = harness_ledger.compute_inputs_hash([str(src)])
            self._write_ledger(
                change,
                {
                    "changeName": "c",
                    "validations": {
                        "unitTestFull": self._v2_entry(
                            ih, ifiles, command="mvn test -pl m -o", scope="module"
                        ),
                    },
                },
            )
            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_command="mvn test -pl m -o -DfailIfNoTests=false",
            )
            self.assertFalse(r["reuse"])
            self.assertEqual(r["reason"], "rerun")
            self.assertEqual(r.get("code"), "COMMAND_CHANGED")

    def test_toolchain_change_returns_rerun(self) -> None:  # UT-017 toolchain
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            ih, ifiles = harness_ledger.compute_inputs_hash([str(src)])
            self._write_ledger(
                change,
                {
                    "changeName": "c",
                    "validations": {
                        "compile": self._v2_entry(
                            ih, ifiles, command="mvn compile -pl m -o", toolchainHash="sha256:tc-v1"
                        )
                    },
                },
            )
            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="compile",
                files=[str(src)],
                requested_toolchain_hash="sha256:tc-v2",
            )
            self.assertFalse(r["reuse"])
            self.assertEqual(r["reason"], "rerun")
            self.assertEqual(r.get("code"), "TOOLCHAIN_CHANGED")

    def test_profile_change_returns_rerun(self) -> None:  # UT-017 profile
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            ih, ifiles = harness_ledger.compute_inputs_hash([str(src)])
            self._write_ledger(
                change,
                {
                    "changeName": "c",
                    "validations": {
                        "unitTest": self._v2_entry(
                            ih,
                            ifiles,
                            command="mvn test -Dtest=FooTest",
                            scope="FooTest",
                            coverage="incremental",
                            profileHash="sha256:prof-a",
                        )
                    },
                },
            )
            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTest",
                files=[str(src)],
                requested_scope="FooTest",
                requested_profile_hash="sha256:prof-b",
            )
            self.assertFalse(r["reuse"])
            self.assertEqual(r["reason"], "rerun")
            self.assertEqual(r.get("code"), "PROFILE_CHANGED")

    def test_package_record_and_reuse(self) -> None:  # UT-018
        self.assertIn("package", harness_ledger.VERIFICATIONS)
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "package",
                        "--status",
                        "ok",
                        "--command",
                        "mvn package -pl m -am -DskipTests",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "30000",
                        "--files",
                        str(src),
                        "--evidence",
                        "BUILD SUCCESS (skip-tests)",
                        "--scope",
                        "module-am",
                        "--deploy-artifact",
                        "m/target/m.jar",
                        "--artifact-hash",
                        "sha256:art-1",
                        "--tests-executed",
                        "false",
                    ]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            data = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(encoding="utf-8")
            )
            pkg = data["validations"]["package"]
            self.assertEqual(pkg["status"], "OK")
            self.assertEqual(pkg["deployArtifact"], "m/target/m.jar")
            self.assertEqual(pkg["sha256"], "sha256:art-1")
            self.assertEqual(pkg["testsExecuted"], False)
            self.assertEqual(pkg["coverage"], "module-am")

            r = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="package",
                files=[str(src)],
                requested_command="mvn package -pl m -am -DskipTests",
            )
            self.assertTrue(r["reuse"], msg=r)
            self.assertEqual(r["reason"], "reuse")

    def test_v1_to_v2_one_time_conservative_invalidation(self) -> None:  # COM-002
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "c"
            change.mkdir()
            src = change / "F.java"
            src.write_text("class F {}", encoding="utf-8")
            ih, ifiles = harness_ledger.compute_inputs_hash([str(src)])
            # v1 entry -> insufficient (one-time invalidation)
            self._write_ledger(
                change,
                {
                    "changeName": "c",
                    "validations": {
                        "unitTestFull": {
                            "status": "OK",
                            "command": "mvn test -pl m -o",
                            "scope": "module",
                            "evidence": "Tests run: 5, Failures: 0",
                            "inputsHash": ih,
                            "inputsFiles": ifiles,
                        }
                    },
                },
            )
            r1 = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_command="mvn test -pl m -o",
            )
            self.assertFalse(r1["reuse"])
            self.assertEqual(r1["reason"], "insufficient-evidence")
            # re-record with v2 fields -> subsequent reuse works
            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--status",
                        "ok",
                        "--command",
                        "mvn test -pl m -o",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "1000",
                        "--files",
                        str(src),
                        "--evidence",
                        "Tests run: 5, Failures: 0",
                        "--scope",
                        "module",
                    ]
                )
            self.assertEqual(code, 0, msg=buf.getvalue())
            r2 = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_command="mvn test -pl m -o",
            )
            self.assertTrue(r2["reuse"], msg=r2)
            self.assertEqual(r2["reason"], "reuse")


class MetricsJsonRecordTests(unittest.TestCase):
    """UT-101..103: optional --metrics-json on record."""

    def _record(self, change: Path, src: Path, extra: list[str]) -> tuple[int, dict]:
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        out = StringIO()
        err = StringIO()
        argv = [
            "--json",
            "record",
            "--change-dir",
            str(change),
            "--verification",
            "unitTest",
            "--status",
            "ok",
            "--command",
            "python -m unittest",
            "--exit-code",
            "0",
            "--duration-ms",
            "100",
            "--files",
            str(src),
            "--evidence",
            "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0",
            *extra,
        ]
        with redirect_stdout(out), redirect_stderr(err):
            code = harness_ledger.main(argv)
        text = out.getvalue().strip() or err.getvalue().strip()
        payload = json.loads(text) if text else {}
        return code, payload

    def test_ut101_record_with_valid_metrics_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "m-ok"
            change.mkdir()
            src = change / "A.java"
            src.write_text("class A {}", encoding="utf-8")
            metrics = '{"run":155,"failures":0,"errors":0,"skipped":0}'
            code, payload = self._record(change, src, ["--metrics-json", metrics])
            self.assertEqual(code, 0, msg=payload)
            self.assertTrue(payload.get("ok"))
            data = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            entry = data["validations"]["unitTest"]
            self.assertEqual(
                entry["metrics"],
                {"run": 155, "failures": 0, "errors": 0, "skipped": 0},
            )

    def test_ut102_record_rejects_invalid_metrics_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "m-bad"
            change.mkdir()
            src = change / "A.java"
            src.write_text("class A {}", encoding="utf-8")
            for bad in ("not-json", "[1]"):
                code, payload = self._record(change, src, ["--metrics-json", bad])
                self.assertEqual(code, 1, msg=f"bad={bad} payload={payload}")
                self.assertFalse(payload.get("ok", True))
                err = str(payload.get("error") or "")
                self.assertIn("metrics-json", err.lower())
                self.assertFalse(
                    (change / "evidence" / "verification-ledger.json").exists(),
                    f"ledger must not be written for invalid metrics ({bad})",
                )

    def test_ut103_record_without_metrics_json_omits_field(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "m-none"
            change.mkdir()
            src = change / "A.java"
            src.write_text("class A {}", encoding="utf-8")
            code, payload = self._record(change, src, [])
            self.assertEqual(code, 0, msg=payload)
            data = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertNotIn("metrics", data["validations"]["unitTest"])


class CompactOutputTests(unittest.TestCase):
    """C5: record/can-reuse 默认 compact 输出，--verbose 展开全量。"""

    def _record(self, change_dir: Path, src: Path, extra: list[str]) -> tuple[int, dict]:
        from io import StringIO
        from contextlib import redirect_stdout

        buf = StringIO()
        with redirect_stdout(buf):
            code = harness_ledger.main(
                [
                    "--json",
                    "record",
                    "--change-dir",
                    str(change_dir),
                    "--verification",
                    "unitTest",
                    "--status",
                    "ok",
                    "--command",
                    "pytest",
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "100",
                    "--files",
                    str(src),
                    "--evidence",
                    "pass",
                    "--scope",
                    "module",
                    *extra,
                ]
            )
        return code, json.loads(buf.getvalue())

    def _can_reuse(self, change_dir: Path, src: Path, extra: list[str]) -> tuple[int, dict]:
        from io import StringIO
        from contextlib import redirect_stdout

        buf = StringIO()
        with redirect_stdout(buf):
            code = harness_ledger.main(
                [
                    "--json",
                    "can-reuse",
                    "--change-dir",
                    str(change_dir),
                    "--verification",
                    "unitTest",
                    "--files",
                    str(src),
                    *extra,
                ]
            )
        return code, json.loads(buf.getvalue())

    def test_record_default_compact_has_only_required_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-compact-rec"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            code, payload = self._record(change, src, [])
            self.assertEqual(code, 0, msg=payload)
            # compact: only ok/action/verification/status (no inputsHash/inputsFiles/ledger_path)
            self.assertEqual(payload["ok"], True)
            self.assertEqual(payload["action"], "record")
            self.assertEqual(payload["verification"], "unitTest")
            self.assertEqual(payload["status"], "OK")
            self.assertNotIn("inputsHash", payload)
            self.assertNotIn("inputsFiles", payload)
            self.assertNotIn("ledger_path", payload)

    def test_record_verbose_returns_full_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-verbose-rec"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            code, payload = self._record(change, src, ["--verbose"])
            self.assertEqual(code, 0, msg=payload)
            self.assertEqual(payload["ok"], True)
            self.assertIn("inputsHash", payload)
            self.assertIn("inputsFiles", payload)
            self.assertIn("ledger_path", payload)

    def test_can_reuse_default_compact_has_only_required_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-compact-reuse"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            code, payload = self._can_reuse(change, src, [])
            self.assertEqual(code, 0, msg=payload)
            # compact: only ok/reuse/code (no reason/verification/detail/ledger_path)
            self.assertEqual(payload["ok"], True)
            self.assertIn("reuse", payload)
            self.assertIn("code", payload)
            self.assertNotIn("reason", payload)
            self.assertNotIn("verification", payload)
            self.assertNotIn("ledger_path", payload)
            self.assertNotIn("inputsHash", payload)

    def test_can_reuse_verbose_returns_full_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-verbose-reuse"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            code, payload = self._can_reuse(change, src, ["--verbose"])
            self.assertEqual(code, 0, msg=payload)
            self.assertEqual(payload["ok"], True)
            self.assertIn("reason", payload)
            self.assertIn("verification", payload)
            self.assertIn("detail", payload)


class ScenarioIdsTests(unittest.TestCase):
    """C9: ledger record --scenario-ids 绑定场景 ID 到 ledger entry。"""

    def _record_with_scenarios(self, change_dir: Path, src: Path, scenario_ids: str) -> tuple[int, dict]:
        from io import StringIO
        from contextlib import redirect_stdout

        buf = StringIO()
        with redirect_stdout(buf):
            code = harness_ledger.main(
                [
                    "--json",
                    "record",
                    "--change-dir",
                    str(change_dir),
                    "--verification",
                    "unitTest",
                    "--status",
                    "ok",
                    "--command",
                    "pytest",
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "100",
                    "--files",
                    str(src),
                    "--evidence",
                    "pass",
                    "--scope",
                    "module",
                    "--scenario-ids",
                    scenario_ids,
                    "--verbose",
                ]
            )
        return code, json.loads(buf.getvalue())

    def test_record_writes_scenario_ids_to_ledger_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-scen"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            code, payload = self._record_with_scenarios(change, src, "C5-S1,C5-S2")
            self.assertEqual(code, 0, msg=payload)

            ledger = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            entry = ledger["validations"]["unitTest"]
            self.assertIn("scenarioIds", entry)
            self.assertEqual(entry["scenarioIds"], ["C5-S1", "C5-S2"])

    def test_record_without_scenario_ids_has_no_field(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-no-scen"
            change.mkdir()
            src = change / "Svc.java"
            src.write_text("class Svc {}", encoding="utf-8")

            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTest",
                        "--status",
                        "ok",
                        "--command",
                        "pytest",
                        "--exit-code",
                        "0",
                        "--duration-ms",
                        "100",
                        "--files",
                        str(src),
                        "--evidence",
                        "pass",
                        "--scope",
                        "module",
                        "--verbose",
                    ]
                )
            self.assertEqual(code, 0)

            ledger = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            entry = ledger["validations"]["unitTest"]
            self.assertNotIn("scenarioIds", entry)


class ExpandProfileInputLayeredTests(unittest.TestCase):
    """Submit friction: expand_profile_input_files must use load_profile/common_root."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ledger-profile-layered-"))
        self.common = self.tmp / "common"
        self.execution = self.tmp / "execution"
        self.common.mkdir()
        self.execution.mkdir()

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_profile(self, root: Path, data: dict) -> None:
        path = root / ".harness" / "config" / "build-profile.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    def _seed_exec_sources(self) -> Path:
        src = self.execution / "module" / "src" / "main" / "A.java"
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_text("class A {}", encoding="utf-8")
        (self.execution / "pom.xml").write_text("<project/>", encoding="utf-8")
        return src

    def test_expand_reads_common_profile_when_execution_missing(self) -> None:
        # UT-001: common-only profile; --project=execution/WT
        self._seed_exec_sources()
        self._write_profile(
            self.common,
            {
                "schemaVersion": 2,
                "verificationInputs": {
                    "unitTestFull": ["pom.xml", "module/src/main/*.java"]
                },
            },
        )
        with mock.patch.object(
            harness_ledger.harness_paths,
            "common_root",
            return_value=self.common.resolve(),
        ):
            files, err = harness_ledger.expand_profile_input_files(
                self.execution, "unitTestFull"
            )
        self.assertIsNone(err, msg=err)
        self.assertGreaterEqual(len(files), 2)
        self.assertTrue(any(f.endswith("pom.xml") for f in files))
        self.assertTrue(any(f.endswith("A.java") for f in files))

    def test_expand_missing_both_profiles(self) -> None:
        # UT-002
        with mock.patch.object(
            harness_ledger.harness_paths,
            "common_root",
            return_value=self.common.resolve(),
        ):
            files, err = harness_ledger.expand_profile_input_files(
                self.execution, "unitTestFull"
            )
        self.assertEqual(files, [])
        self.assertIsNotNone(err)
        self.assertIn("missing", err.lower())

    def test_expand_local_profile_still_works(self) -> None:
        # UT-003 regression: profile on execution root
        self._seed_exec_sources()
        self._write_profile(
            self.execution,
            {
                "schemaVersion": 2,
                "verificationInputs": {
                    "unitTestFull": ["pom.xml", "module/src/main/*.java"]
                },
            },
        )
        with mock.patch.object(
            harness_ledger.harness_paths,
            "common_root",
            return_value=self.common.resolve(),
        ):
            files, err = harness_ledger.expand_profile_input_files(
                self.execution, "unitTestFull"
            )
        self.assertIsNone(err, msg=err)
        self.assertGreaterEqual(len(files), 2)

    def test_expand_missing_verification_key(self) -> None:
        # UT-004
        self._seed_exec_sources()
        self._write_profile(
            self.common,
            {
                "schemaVersion": 2,
                "verificationInputs": {"unitTest": ["pom.xml"]},
            },
        )
        with mock.patch.object(
            harness_ledger.harness_paths,
            "common_root",
            return_value=self.common.resolve(),
        ):
            files, err = harness_ledger.expand_profile_input_files(
                self.execution, "unitTestFull"
            )
        self.assertEqual(files, [])
        self.assertIsNotNone(err)
        self.assertIn("verificationInputs.unitTestFull", err)

    def test_expand_unreadable_common_profile(self) -> None:
        # review fixback YELLOW-1: corrupt JSON must stay "unreadable", not "missing"
        path = self.common / ".harness" / "config" / "build-profile.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not-json", encoding="utf-8", newline="\n")
        with mock.patch.object(
            harness_ledger.harness_paths,
            "common_root",
            return_value=self.common.resolve(),
        ):
            files, err = harness_ledger.expand_profile_input_files(
                self.execution, "unitTestFull"
            )
        self.assertEqual(files, [])
        self.assertIsNotNone(err)
        self.assertIn("unreadable", err.lower())


if __name__ == "__main__":
    unittest.main()
