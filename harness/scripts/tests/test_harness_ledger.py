#!/usr/bin/env python3
"""Unittests for harness_ledger.py (P0-5)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
