#!/usr/bin/env python3
"""Unittests for harness_ledger.py (P0-5)."""

from __future__ import annotations

import json
import hashlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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

    def test_hash_is_stable_across_equivalent_worktree_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            roots = [base / "feature", base / "integration"]
            hashes: list[str] = []
            files: list[list[str]] = []
            for root in roots:
                source = root / "src" / "app.ts"
                test = root / "tests" / "app.test.ts"
                source.parent.mkdir(parents=True)
                test.parent.mkdir(parents=True)
                source.write_text("export const value = 1;\n", encoding="utf-8")
                test.write_text("test('value', () => value);\n", encoding="utf-8")
                digest, logical_files = harness_ledger.compute_inputs_hash(
                    [str(source), str(test)],
                    project_root=root,
                )
                hashes.append(digest)
                files.append(logical_files)

            self.assertEqual(hashes[0], hashes[1])
            self.assertEqual(files[0], ["src/app.ts", "tests/app.test.ts"])
            self.assertEqual(files[0], files[1])

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

    def test_equivalent_runner_wrappers_do_not_change_the_canonical_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-wrapper"
            change.mkdir()
            src = change / "engine.test.ts"
            src.write_text("export {}\n", encoding="utf-8")
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([src])
            self._write_ledger(
                change,
                {
                    "validations": {
                        "unitTestFull": {
                            "status": "OK",
                            "command": "npx vitest run",
                            "runnerCommand": "npx vitest run",
                            "scope": "full",
                            "evidence": "13 tests passed",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                            "algorithmVersion": "harness-ledger-2",
                            "coverage": "full",
                        }
                    }
                },
            )

            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(src)],
                requested_command="vitest run (safe runner)",
            )

            self.assertTrue(result["reuse"], result)
            self.assertEqual(
                harness_ledger.command_set_hash("npx vitest run"),
                harness_ledger.command_set_hash("vitest run (safe runner)"),
            )

    def test_missing_target_is_labeled_first_run_not_rerun(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-first-run"
            change.mkdir()
            source = change / "source.ts"
            source.write_text("export {};\n", encoding="utf-8")

            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(source)],
            )

            self.assertFalse(result["reuse"])
            self.assertEqual(result["code"], "LEDGER_MISSING")
            self.assertEqual(result["executionNeed"], "first-run")

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

    def test_greenfield_profile_input_is_detected_and_records_full_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / "src").mkdir()
            (project / "src" / "timer.js").write_text(
                "export const tick = () => 1;\n",
                encoding="utf-8",
            )
            (project / "package.json").write_text(
                json.dumps(
                    {
                        "name": "greenfield-ledger",
                        "scripts": {"test": "node --test"},
                    }
                ),
                encoding="utf-8",
            )
            change = project / ".harness" / "changes" / "greenfield"
            change.mkdir(parents=True)
            command = "npm test"

            out = io.StringIO()
            with redirect_stdout(out):
                record_code = harness_ledger.main(
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
                        "100",
                        "--evidence",
                        "全部测试通过",
                        "--project",
                        str(project),
                        "--profile-input",
                        "unitTestFull",
                    ]
                )
            self.assertEqual(record_code, 0, out.getvalue())
            self.assertTrue(
                (project / ".harness" / "config" / "build-profile.json").is_file()
            )
            written = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                written["validations"]["unitTestFull"]["scope"],
                "full",
            )

            reuse_out = io.StringIO()
            with redirect_stdout(reuse_out):
                reuse_code = harness_ledger.main(
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
            self.assertEqual(reuse_code, 0, reuse_out.getvalue())
            self.assertTrue(json.loads(reuse_out.getvalue())["reuse"])


class RecordTests(unittest.TestCase):
    def test_active_run_freezes_ownership_before_evidence_is_recorded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            subprocess.run(["git", "init"], cwd=project, check=True, capture_output=True)
            change = project / ".harness" / "changes" / "freeze"
            state = project / ".harness" / "state" / "changes" / "freeze"
            change.joinpath("meta").mkdir(parents=True)
            contract = {
                "schemaVersion": 2,
                "changeId": "freeze",
                "lifecycle": {"status": "active"},
                "ownership": {
                    "productPaths": ["src/"],
                    "staticEvidencePaths": [".harness/changes/freeze/"],
                    "excludedPaths": [".harness/state/"],
                },
                "stateOwnership": {
                    "contractRoot": ".harness/changes/freeze",
                    "runtimeRoot": ".harness/state/changes/freeze",
                },
            }
            change.joinpath("meta/change-context.json").write_text(
                json.dumps(contract), encoding="utf-8"
            )
            capsule = {
                "schemaVersion": 1,
                "phase": "execute",
                "runId": "run-1",
                "ownershipHash": harness_ledger.ownership_hash(contract),
                "createdAt": "2026-08-09T10:00:00+00:00",
            }
            capsule_path = state / "runtime" / "phase-context" / "run-1.json"
            capsule_path.parent.mkdir(parents=True)
            capsule_path.write_text(json.dumps(capsule), encoding="utf-8")
            contract["ownership"]["productPaths"].append("tests/")
            change.joinpath("meta/change-context.json").write_text(
                json.dumps(contract), encoding="utf-8"
            )

            result = harness_ledger.frozen_ownership_check(change)

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "OWNERSHIP_CHANGED_BEFORE_VERIFICATION")

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
    @staticmethod
    def _linked_worktree(project: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(target), "HEAD"],
            cwd=project,
            check=True,
            capture_output=True,
        )

    def test_infers_worktree_project_from_change_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root, {"tracked.txt": "base\n"})
            change = root / ".harness" / "changes" / "demo"
            worktree = root / ".worktrees" / "demo"
            (change / "meta").mkdir(parents=True)
            self._linked_worktree(root, worktree)
            (change / "meta" / "change-context.json").write_text(
                json.dumps({"worktreeRoot": str(worktree)}) + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                harness_ledger.infer_execution_project_root(change),
                worktree.resolve(),
            )

    def test_infers_relative_worktree_metadata_from_main_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            _init_repo(root, {"tracked.txt": "base\n"})
            outside = Path(tmp) / "outside"
            outside.mkdir(parents=True)
            original_cwd = Path.cwd()
            cases = (
                ("change-context.json", "worktreeRoot", ".worktrees/direct-context"),
                ("worktree.json", "path", ".worktrees/direct-path"),
                ("worktree.json", "worktreePath", ".worktrees/direct-worktree-path"),
                ("worktree.json", "worktreeRoot", ".worktrees"),
            )
            try:
                os.chdir(outside)
                for metadata_name, field, value in cases:
                    change_name = (
                        "container-root"
                        if field == "worktreeRoot" and value == ".worktrees"
                        else value.rsplit("/", 1)[-1]
                    )
                    change = root / ".harness" / "changes" / change_name
                    worktree = root / ".worktrees" / change_name
                    (change / "meta").mkdir(parents=True)
                    self._linked_worktree(root, worktree)
                    (change / "meta" / metadata_name).write_text(
                        json.dumps({field: value}) + "\n",
                        encoding="utf-8",
                    )

                    with self.subTest(field=field, value=value):
                        self.assertEqual(
                            harness_ledger.infer_execution_project_root(change),
                            worktree.resolve(),
                        )
            finally:
                os.chdir(original_cwd)

    def test_can_reuse_uses_inferred_worktree_for_relative_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root, {"tracked.txt": "base\n"})
            change = root / ".harness" / "changes" / "demo"
            worktree = root / ".worktrees" / "demo"
            source = worktree / "src" / "app.ts"
            (change / "meta").mkdir(parents=True)
            self._linked_worktree(root, worktree)
            source.parent.mkdir(parents=True)
            source.write_text("export const ready = true;\n", encoding="utf-8")
            (change / "meta" / "change-context.json").write_text(
                json.dumps({"worktreeRoot": str(worktree)}) + "\n",
                encoding="utf-8",
            )

            output = io.StringIO()
            with redirect_stdout(output):
                code = harness_ledger.main(
                    [
                        "can-reuse",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--files",
                        "src/app.ts",
                        "--json",
                        "--verbose",
                    ]
                )

            self.assertEqual(code, 0, msg=output.getvalue())
            payload = json.loads(output.getvalue())
            self.assertEqual(payload["resolvedProjectRoot"], str(worktree.resolve()))

    def test_install_reuse_accepts_valid_worktree_path_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            _init_repo(root, {"tracked.txt": "base\n"})
            change = root / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)
            worktree = root / ".worktrees" / "demo"
            self._linked_worktree(root, worktree)
            source = worktree / "tracked.txt"
            inputs_hash, inputs_files = harness_ledger.compute_inputs_hash([str(source)])
            (change / "evidence").mkdir()
            (change / "evidence" / "verification-ledger.json").write_text(
                json.dumps({
                    "changeName": "demo",
                    "diffHash": "sha256:x",
                    "validations": {
                        "install": {
                            "status": "OK",
                            "command": "npm install",
                            "scope": "module-am",
                            "evidence": "install completed",
                            "inputsHash": inputs_hash,
                            "inputsFiles": inputs_files,
                            "algorithmVersion": "harness-ledger-2",
                            "coverage": "module-am",
                        }
                    },
                }) + "\n",
                encoding="utf-8",
            )
            (change / "meta" / "worktree.json").write_text(
                json.dumps({"worktreePath": ".worktrees/demo"}) + "\n",
                encoding="utf-8",
            )

            result = harness_ledger.decide_can_reuse(
                change_dir=change,
                verification="install",
                files=[str(source)],
            )

            self.assertTrue(result["reuse"], result)
            self.assertEqual(result["reason"], "reuse")

    def test_rejects_non_git_and_foreign_repository_worktree_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "project"
            root.mkdir()
            _init_repo(root, {"tracked.txt": "base\n"})
            change = root / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)

            plain = base / "plain"
            plain.mkdir()
            (change / "meta" / "worktree.json").write_text(
                json.dumps({"worktreePath": str(plain)}) + "\n",
                encoding="utf-8",
            )
            self.assertIsNone(harness_ledger.infer_execution_project_root(change))

            foreign = base / "foreign"
            foreign.mkdir()
            _init_repo(foreign, {"tracked.txt": "foreign\n"})
            (change / "meta" / "worktree.json").write_text(
                json.dumps({"worktreePath": str(foreign)}) + "\n",
                encoding="utf-8",
            )
            self.assertIsNone(harness_ledger.infer_execution_project_root(change))

            output = io.StringIO()
            with mock.patch.object(harness_ledger, "compute_diff_hash") as compute, redirect_stderr(output):
                code = harness_ledger.main([
                    "--json", "diff-hash", "--repo", ".", "--change-dir", str(change)
                ])
            self.assertNotEqual(code, 0)
            self.assertEqual(json.loads(output.getvalue())["code"], "EXECUTION_WORKTREE_INVALID")
            compute.assert_not_called()

    def test_rejects_independent_clone_with_same_origin_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "project"
            root.mkdir()
            _init_repo(root, {"tracked.txt": "base\n"})
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.test/shared/repo.git"],
                cwd=root,
                check=True,
            )
            clone = base / "clone"
            subprocess.run(
                ["git", "clone", "-q", str(root), str(clone)],
                check=True,
            )
            subprocess.run(
                ["git", "remote", "set-url", "origin", "https://example.test/shared/repo.git"],
                cwd=clone,
                check=True,
            )
            change = root / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)
            (change / "meta" / "worktree.json").write_text(
                json.dumps({"worktreePath": str(clone)}) + "\n",
                encoding="utf-8",
            )

            self.assertIsNone(harness_ledger.infer_execution_project_root(change))

    def test_can_reuse_rejects_relative_files_without_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change-cli"
            change.mkdir()

            from contextlib import redirect_stderr
            from io import StringIO

            error = StringIO()
            with redirect_stderr(error):
                code = harness_ledger.main(
                    [
                        "can-reuse",
                        "--change-dir",
                        str(change),
                        "--verification",
                        "unitTestFull",
                        "--files",
                        "src/app.ts",
                        "--json",
                    ]
                )

            self.assertNotEqual(code, 0)
            payload = json.loads(error.getvalue())
            self.assertEqual(payload["code"], "PROJECT_ROOT_REQUIRED")
            self.assertIn("--project", payload["error"])

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


def _receipt_hash(receipt: dict) -> str:
    """与 harness_ledger._ci_receipt_hash 同口径：除 receiptHash 外全字段。"""
    body = {k: v for k, v in receipt.items() if k != "receiptHash"}
    canonical = json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def _ci_receipt(*, base: str, tree: str | None = None) -> dict:
    """构造合法 CI 证据收据（tree 缺省取 base commit 的 tree）。"""
    import subprocess

    root_hint = None
    if tree is None:
        root_hint = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{tree}"], cwd=_receipt_repo_hint[0],
            text=True,
        ).strip()
        tree = "sha256:" + root_hint
    receipt = {
        "schemaVersion": 1,
        "repository": _receipt_repo_hint[1],
        "runId": 1234567890,
        "runAttempt": 1,
        "workflow": "check",
        "runUrl": "https://ci.example.com/runs/1234567890",
        "headSha": base,
        "headTree": tree,
        # R4: productTree = 排除 .harness 的产品内容树。本 fixture 中
        # .harness 未入库，产品树与 HEAD 树同值。
        "productTree": tree,
        "toolchain": {"node": "24.9.0"},
        "conclusion": "success",
        "jobs": [
            {
                "name": "test-windows-unit",
                "conclusion": "success",
                "steps": [
                    {"name": "Run unit tests", "conclusion": "success",
                     "command": "npm test"}
                ],
            }
        ],
        "concludedAt": "2026-09-12T00:00:00Z",
    }
    receipt["receiptHash"] = _receipt_hash(receipt)
    return receipt


_receipt_repo_hint: list = []


class CiEvidenceImportTests(unittest.TestCase):
    """WI-3.2：CI 证据收据校验与导入落账（fail-closed）。"""

    def _make_repo(self, tmp: Path) -> tuple[Path, Path]:
        root = tmp / "project"
        root.mkdir()
        base = _init_repo(root, {"tracked.txt": "base\n"})
        import subprocess

        subprocess.run(
            ["git", "remote", "add", "origin",
             "https://github.com/owner/repo.git"],
            cwd=root, check=True,
        )
        tree = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{tree}"], cwd=root, text=True
        ).strip()
        _receipt_repo_hint.clear()
        _receipt_repo_hint.extend([
            root,
            harness_ledger.harness_paths._normalize_remote(
                harness_ledger.harness_paths._primary_remote_url(root)
            ),
        ])
        change = root / ".harness" / "changes" / "demo"
        (change / "meta").mkdir(parents=True)
        (change / "meta" / "change-context.json").write_text(
            json.dumps({
                "schemaVersion": 2,
                "changeId": "demo",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo",
                    "runtimeRoot": ".harness/state/changes/demo",
                },
                "ownership": {
                    "productPaths": ["tracked.txt"],
                    "staticEvidencePaths": [".harness/changes/demo/"],
                },
            }) + "\n",
            encoding="utf-8",
        )
        return change, _ci_receipt(base=base, tree="sha256:" + tree)

    def _import(
        self,
        change: Path,
        receipt: dict,
        extra: list[str] | None = None,
    ) -> tuple[int, str, str]:
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        with tempfile.TemporaryDirectory() as tmp2:
            receipt_path = Path(tmp2) / "ci-evidence-receipt.json"
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            out, err = StringIO(), StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = harness_ledger.main(
                    ["import-ci-evidence", "--change-dir", str(change),
                     "--receipt", str(receipt_path), "--verification", "unitTestFull",
                     "--job", "test-windows-unit", "--step", "Run unit tests",
                     "--json", *(extra or [])]
                )
        return code, out.getvalue(), err.getvalue()

    def test_import_success_writes_v2_imported_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            code, out, err = self._import(change, receipt)
            self.assertEqual(code, 0, msg=out + err)
            payload = json.loads(out)
            self.assertEqual(payload["action"], "import-ci-evidence")
            ledger, _ = harness_ledger.load_ledger(change)
            entry = ledger["validations"]["unitTestFull"]
            self.assertEqual(entry["status"], "OK")
            self.assertTrue(entry["imported"])
            self.assertEqual(entry["coverage"], "full")
            self.assertEqual(entry["inputsHash"], receipt["headTree"])
            self.assertEqual(entry["inputsFiles"], [])
            self.assertEqual(entry["importedFrom"]["runId"], receipt["runId"])
            self.assertEqual(
                entry["importedFrom"]["headTree"], receipt["headTree"])

    def test_import_rejects_tampered_receipt_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            receipt["jobs"][0]["conclusion"] = "failure"  # 篡改后不改 receiptHash
            code, out, err = self._import(change, receipt)
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_HASH_MISMATCH", err)

    def test_import_rejects_failed_conclusion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            receipt["conclusion"] = "failure"
            receipt["jobs"][0]["conclusion"] = "failure"
            receipt["receiptHash"] = _receipt_hash(receipt)
            code, out, err = self._import(change, receipt)
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_CONCLUSION_NOT_SUCCESS", err)

    def test_import_rejects_tree_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            receipt["headTree"] = "sha256:" + "f" * 64
            receipt["productTree"] = "sha256:" + "f" * 64
            receipt["receiptHash"] = _receipt_hash(receipt)
            code, out, err = self._import(change, receipt)
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_TREE_MISMATCH", err)

    def test_import_rejects_repository_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            receipt["repository"] = "other-owner/other-repo"
            receipt["receiptHash"] = _receipt_hash(receipt)
            code, out, err = self._import(change, receipt)
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_REPOSITORY_MISMATCH", err)

    def test_import_rejects_incremental_verification(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            code, out, err = self._import(
                change, receipt, extra=["--verification", "unitTest"]
            )
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_VERIFICATION_NOT_IMPORTABLE", err)

    def test_import_rejects_uncommitted_worktree_drift(self) -> None:
        """R4：收据必须绑定候选实际内容，未提交的工作区漂移即拒绝。

        缺陷复现：CI 在已推送提交上运行后，本地再改动候选文件（不提交），
        旧实现只比对 HEAD^{tree} → 漂移不可见 → 证据错误绑定。
        """
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            root = change.parents[2]
            (root / "tracked.txt").write_text("drifted after CI\n", encoding="utf-8")
            code, out, err = self._import(change, receipt)
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_TREE_MISMATCH", err)

    def test_import_rejects_untracked_product_file(self) -> None:
        """R4：未跟踪的新产品文件同样使候选内容与收据不一致。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            root = change.parents[2]
            (root / "new-module.py").write_text("print('new')\n", encoding="utf-8")
            code, out, err = self._import(change, receipt)
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_TREE_MISMATCH", err)

    def test_import_ignores_harness_state_drift(self) -> None:
        """R4：.harness 状态漂移不影响产品内容绑定（不产生误拒）。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            root = change.parents[2]
            note = change / "meta" / "local-note.md"
            note.write_text("local only\n", encoding="utf-8")
            code, out, err = self._import(change, receipt)
            self.assertEqual(code, 0, msg=out + err)

    def test_import_accepts_same_content_different_commit(self) -> None:
        """R4：同内容不同 commit（空提交挪动 HEAD）不得误拒。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            root = change.parents[2]
            import subprocess

            subprocess.run(
                ["git", "commit", "--allow-empty", "-q", "-m", "empty"],
                cwd=root, check=True,
            )
            code, out, err = self._import(change, receipt)
            self.assertEqual(code, 0, msg=out + err)


class CiEvidenceShardTests(unittest.TestCase):
    """R5：分片 CI 证据不得按 full 记录；完整能力需全部分片聚合。"""

    def _make_repo(self, tmp: Path) -> tuple[Path, dict]:
        root = tmp / "project"
        root.mkdir()
        base = _init_repo(root, {"tracked.txt": "base\n"})
        import subprocess

        subprocess.run(
            ["git", "remote", "add", "origin",
             "https://github.com/owner/repo.git"],
            cwd=root, check=True,
        )
        _receipt_repo_hint.clear()
        _receipt_repo_hint.extend([
            root,
            harness_ledger.harness_paths._normalize_remote(
                harness_ledger.harness_paths._primary_remote_url(root)
            ),
        ])
        change = root / ".harness" / "changes" / "demo"
        (change / "meta").mkdir(parents=True)
        (change / "meta" / "change-context.json").write_text(
            json.dumps({
                "schemaVersion": 2,
                "changeId": "demo",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo",
                    "runtimeRoot": ".harness/state/changes/demo",
                },
                "ownership": {
                    "productPaths": ["tracked.txt"],
                    "staticEvidencePaths": [".harness/changes/demo/"],
                },
            }) + "\n",
            encoding="utf-8",
        )
        receipt = _ci_receipt(base=base)
        receipt["jobs"][0]["steps"][0]["command"] = "npm test -- --shard=1/2"
        receipt["receiptHash"] = _receipt_hash(receipt)
        return change, receipt

    def _import_shard(
        self, change: Path, receipt: dict, shard: str
    ) -> tuple[int, str, str]:
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        with tempfile.TemporaryDirectory() as tmp2:
            receipt_path = Path(tmp2) / "ci-evidence-receipt.json"
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            out, err = StringIO(), StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = harness_ledger.main([
                    "import-ci-evidence", "--change-dir", str(change),
                    "--receipt", str(receipt_path),
                    "--verification", "unitTestFull",
                    "--job", "test-windows-unit", "--step", "Run unit tests",
                    "--shard", shard, "--json",
                ])
        return code, out.getvalue(), err.getvalue()

    def test_single_shard_records_partial_not_full(self) -> None:
        """shard=1/2 导入后 coverage 为部分档，不得记为 full。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            code, out, err = self._import_shard(change, receipt, "1/2")
            self.assertEqual(code, 0, msg=out + err)
            ledger, _ = harness_ledger.load_ledger(change)
            entry = ledger["validations"]["unitTestFull"]
            self.assertTrue(entry["imported"])
            self.assertNotEqual(entry["coverage"], "full", entry)
            self.assertIn("1/2", entry.get("shards") or {}, entry)

    def test_all_shards_aggregate_to_full(self) -> None:
        """两分片各自绑定且齐全后聚合为完整能力。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            code, out, err = self._import_shard(change, receipt, "1/2")
            self.assertEqual(code, 0, msg=out + err)
            receipt2 = dict(receipt)
            receipt2["runId"] = receipt["runId"]  # 同一 CI run 的另一分片
            code, out, err = self._import_shard(change, receipt2, "2/2")
            self.assertEqual(code, 0, msg=out + err)
            ledger, _ = harness_ledger.load_ledger(change)
            entry = ledger["validations"]["unitTestFull"]
            self.assertEqual(entry["coverage"], "full", entry)
            self.assertEqual(
                sorted((entry.get("shards") or {}).keys()), ["1/2", "2/2"], entry
            )

    def test_diverged_tree_shard_does_not_aggregate(self) -> None:
        """不同内容树上的分片不得拼成 full（旧分片被取代并留痕）。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            code, out, err = self._import_shard(change, receipt, "1/2")
            self.assertEqual(code, 0, msg=out + err)
            root = change.parents[2]
            import subprocess

            (root / "tracked.txt").write_text("v2\n", encoding="utf-8")
            subprocess.run(["git", "add", "-A"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "v2"], cwd=root, check=True
            )
            base2 = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip()
            receipt2 = _ci_receipt(base=base2)
            receipt2["jobs"][0]["steps"][0]["command"] = "npm test -- --shard=2/2"
            receipt2["receiptHash"] = _receipt_hash(receipt2)
            code, out, err = self._import_shard(change, receipt2, "2/2")
            self.assertEqual(code, 0, msg=out + err)
            ledger, _ = harness_ledger.load_ledger(change)
            entry = ledger["validations"]["unitTestFull"]
            self.assertNotEqual(entry["coverage"], "full", entry)
            self.assertEqual(sorted((entry.get("shards") or {}).keys()), ["2/2"])
            self.assertTrue(entry.get("supersededShards"), entry)

    def test_shard_flag_must_match_receipt_shard(self) -> None:
        """收据携带分片身份时，CLI 声明不一致即拒绝。"""
        with tempfile.TemporaryDirectory() as tmp:
            change, receipt = self._make_repo(Path(tmp))
            receipt["shard"] = {"index": 2, "total": 2}
            receipt["receiptHash"] = _receipt_hash(receipt)
            code, out, err = self._import_shard(change, receipt, "1/2")
            self.assertNotEqual(code, 0)
            self.assertIn("RECEIPT_SHARD_MISMATCH", err)


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

    def test_diff_hash_dot_repo_uses_change_worktree_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root, {"tracked.txt": "base\n"})
            execution_root = root / "feature-worktree"
            subprocess.run(
                ["git", "worktree", "add", "--detach", str(execution_root), "HEAD"],
                cwd=root,
                check=True,
                capture_output=True,
            )
            change_dir = root / ".harness" / "changes" / "fix"
            meta = change_dir / "meta"
            meta.mkdir(parents=True)
            (meta / "change-context.json").write_text(
                json.dumps({"worktreeRoot": str(execution_root)}),
                encoding="utf-8",
            )
            from contextlib import redirect_stdout
            from io import StringIO

            buf = StringIO()
            with mock.patch.object(
                harness_ledger,
                "compute_diff_hash",
                return_value=("sha256:" + "a" * 64, {"fileCount": 0}),
            ) as compute, redirect_stdout(buf):
                code = harness_ledger.main([
                    "--json", "diff-hash", "--repo", ".",
                    "--change-dir", str(change_dir),
                ])

            self.assertEqual(code, 0, msg=buf.getvalue())
            self.assertEqual(compute.call_args.args[0], execution_root.resolve())


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
            # compact 仍不倾倒完整 payload：不带 verification/ledger_path/inputsHash。
            # 但拒绝复用时必须给出可行动的短原因——只回 ok/reuse/code 会逼调用方
            # 再跑一次 --verbose 才知道该怎么办（profile 未配好时 code 甚至为空）。
            self.assertEqual(payload["ok"], True)
            self.assertIn("reuse", payload)
            self.assertIn("code", payload)
            self.assertNotIn("verification", payload)
            self.assertNotIn("ledger_path", payload)
            self.assertNotIn("inputsHash", payload)
            if payload["reuse"] is not True:
                self.assertIn("reason", payload)

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


class ScenarioReceiptPathTests(unittest.TestCase):
    """--scenario-receipt-file must resolve against CWD *and* --change-dir."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.change_dir = Path(self._tmp.name) / ".harness" / "changes" / "demo"
        (self.change_dir / "runtime").mkdir(parents=True, exist_ok=True)

    def test_change_dir_relative_path_resolves(self) -> None:
        target = self.change_dir / "runtime" / "receipt.json"
        target.write_text("{}", encoding="utf-8")

        resolved, tried = harness_ledger._resolve_receipt_path(
            "runtime/receipt.json", self.change_dir
        )

        self.assertEqual(resolved, target.resolve())
        self.assertIn(target.resolve(), tried)

    def test_absolute_path_resolves(self) -> None:
        target = self.change_dir / "runtime" / "receipt.json"
        target.write_text("{}", encoding="utf-8")

        resolved, _ = harness_ledger._resolve_receipt_path(
            str(target), self.change_dir
        )

        self.assertEqual(resolved, target.resolve())

    def test_missing_path_reports_every_candidate(self) -> None:
        resolved, tried = harness_ledger._resolve_receipt_path(
            "runtime/nope.json", self.change_dir
        )

        self.assertIsNone(resolved)
        self.assertIn(
            (self.change_dir / "runtime" / "nope.json").resolve(), tried
        )
        self.assertIn((Path.cwd() / "runtime" / "nope.json").resolve(), tried)


class ScenarioReceiptTemplateTests(unittest.TestCase):
    """The template must produce a receipt `record` already accepts."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.change_dir = Path(self._tmp.name) / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True, exist_ok=True)
        (self.change_dir / "meta" / "scenario-manifest.json").write_text(
            json.dumps({
                "schemaVersion": 2,
                "changeName": "demo",
                "scenarios": [
                    {
                        "id": "UT-001",
                        "priority": "P1",
                        "ownerPhase": "execute",
                        "requiredEvidenceKind": "ledger",
                        "executableTestId": "unit::ut1",
                        "testFile": "tests/unit.spec.ts",
                        "testTitle": "ut1",
                    }
                ],
            }),
            encoding="utf-8",
        )

    def _run(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = harness_ledger.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_template_output_passes_receipt_validation(self) -> None:
        code, out, _ = self._run(
            "scenario-receipt-template",
            "--change-dir", str(self.change_dir),
            "--scenario-ids", "UT-001",
            "--runner", "vitest",
        )
        self.assertEqual(code, 0)
        receipt = json.loads(out)

        result = harness_ledger.validate_scenario_execution_receipt(
            change_dir=self.change_dir,
            scenario_ids=["UT-001"],
            receipt=receipt,
        )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["coverage"]["passed"], ["UT-001"])

    def test_out_path_is_change_dir_relative(self) -> None:
        code, _, _ = self._run(
            "scenario-receipt-template",
            "--change-dir", str(self.change_dir),
            "--scenario-ids", "UT-001",
            "--runner", "vitest",
            "--out", "runtime/receipt.json",
            "--json",
        )
        self.assertEqual(code, 0)
        self.assertTrue((self.change_dir / "runtime" / "receipt.json").is_file())

    def test_out_path_with_change_dir_prefix_is_not_double_joined(self) -> None:
        """E-1：cwd 相对路径已含 change-dir 前缀时不得拼出嵌套幽灵目录。"""
        import os
        project = self.change_dir.parents[2]  # <tmp>
        old_cwd = os.getcwd()
        os.chdir(project)
        try:
            code, out, _ = self._run(
                "scenario-receipt-template",
                "--change-dir", ".harness/changes/demo",
                "--scenario-ids", "UT-001",
                "--runner", "vitest",
                "--out", ".harness/changes/demo/evidence/receipt.json",
                "--json",
            )
        finally:
            os.chdir(old_cwd)
        self.assertEqual(code, 0, out)
        expected = self.change_dir / "evidence" / "receipt.json"
        self.assertTrue(expected.is_file(), expected)
        nested = self.change_dir / ".harness"
        self.assertFalse(nested.exists(), nested)

    def test_profile_input_missing_warns(self) -> None:
        """S-4：target 存在但未带 --profile-input → 提前预警可复用性缺口。"""
        warn = harness_ledger._profile_input_missing_warning(
            "unitTestFull", {"id": "unitTestFull"}, None
        )
        self.assertIsNotNone(warn)
        self.assertIn("PROFILE_INPUT_MISSING", warn)
        # 带了 profile-input 不预警
        self.assertIsNone(
            harness_ledger._profile_input_missing_warning(
                "unitTestFull", {"id": "unitTestFull"}, "unit-full"
            )
        )
        # 未声明 target 的场景不预警（那是另一类报错路径）
        self.assertIsNone(
            harness_ledger._profile_input_missing_warning("custom", None, None)
        )

    def test_zero_tests_with_selector_warns(self) -> None:
        """E-2：选择器存在但 Tests run=0 → WARN（exit 0 的假阳性防护）。"""
        evidence = self.change_dir / "runtime" / "it.log"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(
            "[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0\n",
            encoding="utf-8",
        )
        warn = harness_ledger._zero_tests_with_selector_warning(
            "mvn -f backend test -Dgroups=mysql -DexcludedGroups=",
            str(evidence),
            self.change_dir,
        )
        self.assertIsNotNone(warn)
        self.assertIn("ZERO_TESTS_WITH_SELECTOR", warn)
        # 无选择器不告警（全量跑 0 个是另一回事）
        self.assertIsNone(
            harness_ledger._zero_tests_with_selector_warning(
                "mvn test", str(evidence), self.change_dir
            )
        )
        # 有真实命中不告警
        evidence.write_text(
            "[INFO] Tests run: 10, Failures: 0, Errors: 0, Skipped: 0\n",
            encoding="utf-8",
        )
        self.assertIsNone(
            harness_ledger._zero_tests_with_selector_warning(
                "mvn test -Dgroups=mysql", str(evidence), self.change_dir
            )
        )

    def test_unknown_scenario_id_is_rejected(self) -> None:
        code, _, err = self._run(
            "scenario-receipt-template",
            "--change-dir", str(self.change_dir),
            "--scenario-ids", "NOPE-1",
            "--runner", "vitest",
            "--json",
        )
        self.assertEqual(code, 1)
        self.assertIn("SCENARIO_ID_UNKNOWN", err)


class V2ScenarioManifestFailsClosedTests(unittest.TestCase):
    """字段不齐的 v2 包装体在 ledger 侧必须与门禁侧同样 fail-closed。

    这里用的是**补字段之前**发布的 v2 产物形状（没有 priority/owner_phase）。
    它经历过两个 bug：cmd_record 的版本探测初值是 0，而包装体没有顶层
    schemaVersion，探测停在 0 → `manifest_schema >= 2` 判假 →
    --scenario-receipt-file 的强制要求被跳过，同一份 manifest 门禁拒绝、
    ledger 放行；补上判定后又一度一律拒绝。现在是解包：能解就消费，
    解不动才报 SCENARIO_MANIFEST_V2_UNSUPPORTED。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.change_dir = Path(self._tmp.name) / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True, exist_ok=True)
        (self.change_dir / "meta" / "scenario-manifest.json").write_text(
            json.dumps({
                "schema_version": 2,
                "artifact_id": "plan_artifact:scenario_manifest:abc123",
                "artifact_type": "scenario_manifest",
                "generator_version": "0.2.0",
                "content_hash": "sha256:" + "c" * 64,
                "content": {
                    "scenarios": [
                        {
                            "scenario_id": "UT-001",
                            "coverage_dimension": "happy_path",
                            "execution_level": "unit",
                            "evidence_requirements": ["focused_test"],
                            "risk_level": "low",
                            "task_refs": [],
                            "requirement_refs": [],
                        }
                    ],
                    "coverage": [],
                },
            }),
            encoding="utf-8",
        )

    def _run(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = harness_ledger.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_incomplete_wrapper_is_refused(self) -> None:
        manifest = json.loads(
            (self.change_dir / "meta" / "scenario-manifest.json").read_text(
                encoding="utf-8"
            )
        )

        resolved = harness_ledger.resolve_scenario_manifest(manifest)

        self.assertFalse(resolved["ok"], resolved)
        self.assertEqual(resolved["code"], "SCENARIO_MANIFEST_V2_UNSUPPORTED")

    def test_legacy_manifests_pass_through_untouched(self) -> None:
        legacy = {"schemaVersion": 2, "changeName": "demo", "scenarios": []}

        resolved = harness_ledger.resolve_scenario_manifest(legacy)

        self.assertTrue(resolved["ok"], resolved)
        self.assertIs(resolved["manifest"], legacy)

    def test_complete_wrapper_is_unpacked_to_the_legacy_shape(self) -> None:
        """ledger 与门禁必须解出同一份东西，否则两边对"必需场景"的认定会分叉。"""
        wrapper = {
            "artifact_type": "scenario_manifest",
            "content": {"scenarios": [{
                "scenario_id": "UT-001",
                "coverage_dimension": "normal_path",
                "execution_level": "unit",
                "evidence_requirements": ["focused_test"],
                "risk_level": "medium",
                "priority": "P0",
                "owner_phase": "execute",
                "required_evidence_kind": "ledger",
                "executable_test_id": "unit::ut1",
                "test_file": "tests/unit.spec.ts",
                "test_title": "ut1",
                "task_refs": ["T1"],
                "requirement_refs": ["requirement:x"],
            }], "coverage": []},
        }

        resolved = harness_ledger.resolve_scenario_manifest(wrapper)

        self.assertTrue(resolved["ok"], resolved)
        self.assertEqual(resolved["manifest"]["schemaVersion"], 2)
        entry = resolved["manifest"]["scenarios"][0]
        self.assertEqual(entry["id"], "UT-001")
        self.assertEqual(entry["requiredEvidenceKind"], "ledger")
        self.assertEqual(entry["ownerPhase"], "execute")
        # 与门禁走的是同一个解包器，不是两份各自实现。
        self.assertEqual(
            resolved["manifest"],
            harness_ledger.hpf.unpack_v2_scenario_manifest(wrapper)["manifest"],
        )

    def test_receipt_template_names_the_v2_gap(self) -> None:
        code, _, err = self._run(
            "scenario-receipt-template",
            "--change-dir", str(self.change_dir),
            "--scenario-ids", "UT-001",
            "--runner", "vitest",
            "--json",
        )

        self.assertEqual(code, 1)
        self.assertIn("SCENARIO_MANIFEST_V2_UNSUPPORTED", err)

    def test_record_refuses_to_bind_scenarios_against_a_v2_manifest(self) -> None:
        """这条是漏洞本身：v2 包装体下 record 曾经不再要求 receipt 就放行。"""
        src = self.change_dir / "Svc.java"
        src.write_text("class Svc {}", encoding="utf-8")

        code, _, err = self._run(
            "--json",
            "record",
            "--change-dir", str(self.change_dir),
            "--verification", "unitTest",
            "--status", "ok",
            "--command", "pytest",
            "--exit-code", "0",
            "--duration-ms", "100",
            "--files", str(src),
            "--evidence", "pass",
            "--scope", "module",
            # 注意：没有给 --scenario-receipt-file，以前这里会被静默放行。
            "--scenario-ids", "UT-001",
        )

        self.assertEqual(code, 1)
        self.assertIn("SCENARIO_MANIFEST_V2_UNSUPPORTED", err)
        # 证据没有被写进 ledger。
        self.assertFalse(
            (self.change_dir / "evidence" / "verification-ledger.json").is_file()
        )

    def test_receipt_validation_names_the_v2_gap(self) -> None:
        result = harness_ledger.validate_scenario_execution_receipt(
            change_dir=self.change_dir,
            scenario_ids=["UT-001"],
            receipt={"schemaVersion": 1},
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "SCENARIO_MANIFEST_V2_UNSUPPORTED")


class RecordFromReceiptTests(unittest.TestCase):
    """批次 2 WI-1b：record-from-receipt（证据直接采集）。"""

    @staticmethod
    def _receipt_payload(
        *,
        exit_code: int = 0,
        timed_out: bool = False,
        duration_ms: int = 250,
        output_tail: str = "Tests run: 3, Failures: 0\n",
        argv: list[str] | None = None,
    ) -> dict:
        return {
            "schemaVersion": 1,
            "action": "exec-result",
            "completedAtEpochSeconds": 1788869139,
            "argv": argv or ["npm", "test", "--", "unit"],
            "profile": "safe",
            "exitCode": exit_code,
            "timedOut": timed_out,
            "durationMs": duration_ms,
            "outputTail": output_tail,
            "outputTailTruncated": False,
            "processTreeIsolated": True,
        }

    def _setup_change(self, tmp: str) -> tuple[Path, Path, Path]:
        project = Path(tmp)
        change = project / ".harness" / "changes" / "rfr-task"
        receipts = change / "evidence" / "receipts"
        receipts.mkdir(parents=True)
        src = project / "src" / "app.py"
        src.parent.mkdir(parents=True)
        src.write_text("x = 1\n", encoding="utf-8")
        return project, change, src

    def _record_from_receipt(
        self,
        change: Path,
        receipt_path: Path,
        verification: str = "unitTest",
        *,
        files: str | None = None,
        project: Path | None = None,
        scenario_ids: str | None = None,
        scenario_receipt_file: Path | None = None,
    ) -> tuple[int, dict | None, str]:
        from io import StringIO

        argv = [
            "--json",
            "record-from-receipt",
            "--change-dir",
            str(change),
            "--receipt",
            str(receipt_path),
            "--verification",
            verification,
        ]
        if files:
            argv += ["--files", files]
        if project:
            argv += ["--project", str(project)]
        if scenario_ids:
            argv += ["--scenario-ids", scenario_ids]
        if scenario_receipt_file:
            argv += ["--scenario-receipt-file", str(scenario_receipt_file)]
        buf = StringIO()
        err = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            code = harness_ledger.main(argv)
        raw = buf.getvalue().strip()
        payload = json.loads(raw) if raw else None
        return code, payload, err.getvalue()

    def _load_entry(self, change: Path, verification: str) -> dict:
        ledger_path = change / "evidence" / "verification-ledger.json"
        data = json.loads(ledger_path.read_text(encoding="utf-8"))
        return data["validations"][verification]

    def test_ok_receipt_records_matching_ledger_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.write_text(
                json.dumps(self._receipt_payload()), encoding="utf-8"
            )

            code, payload, _ = self._record_from_receipt(
                change, receipt_path, files=str(src), project=project
            )
            self.assertEqual(code, 0, msg=payload)
            self.assertEqual(payload["action"], "record-from-receipt")
            self.assertEqual(payload["status"], "OK")
            self.assertEqual(payload["derivedFrom"]["exitCode"], 0)
            self.assertFalse(payload["derivedFrom"]["timedOut"])

            entry = self._load_entry(change, "unitTest")
            # ledger 条目与收据逐项对账
            self.assertEqual(entry["status"], "OK")
            self.assertEqual(entry["exitCode"], 0)
            self.assertEqual(entry["durationMs"], 250)
            self.assertEqual(entry["command"], "npm test -- unit")
            self.assertEqual(entry["evidence"], "Tests run: 3, Failures: 0")
            # --project 给定时 inputsFiles 是项目相对路径（既有语义）
            self.assertEqual(entry["inputsFiles"], ["src/app.py"])

    def test_status_derivation_exit_code_and_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            # exitCode != 0 → FAIL
            fail_receipt = change / "evidence" / "receipts" / "fail.json"
            fail_receipt.write_text(
                json.dumps(
                    self._receipt_payload(
                        exit_code=1, output_tail="Tests run: 2, Failures: 1\n"
                    )
                ),
                encoding="utf-8",
            )
            code, payload, _ = self._record_from_receipt(
                change, fail_receipt, files=str(src), project=project
            )
            self.assertEqual(code, 0, msg=payload)
            self.assertEqual(self._load_entry(change, "unitTest")["status"], "FAIL")

            # timedOut=True → FAIL（即使 exitCode 语义上是超时码）
            timeout_receipt = change / "evidence" / "receipts" / "timeout.json"
            timeout_receipt.write_text(
                json.dumps(
                    self._receipt_payload(exit_code=124, timed_out=True, output_tail="")
                ),
                encoding="utf-8",
            )
            code, payload, _ = self._record_from_receipt(
                change, timeout_receipt, files=str(src), project=project
            )
            self.assertEqual(code, 0, msg=payload)
            entry = self._load_entry(change, "unitTest")
            self.assertEqual(entry["status"], "FAIL")
            # 空输出 → 占位说明（evidence 必填非空）
            self.assertEqual(entry["evidence"], "(no captured output; see runner logs)")

    def test_invalid_receipt_fails_with_field_path_and_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change, _ = self._setup_change(tmp)
            cases = [
                # (payload, expected fieldPath)
                ("{not json", "receipt"),
                (
                    json.dumps({"schemaVersion": 2, "action": "exec-result"}),
                    "schemaVersion",
                ),
                (
                    json.dumps({"schemaVersion": 1, "action": "managed-exec"}),
                    "action",
                ),
                (
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "action": "exec-result",
                            "exitCode": 0,
                            "timedOut": False,
                            "durationMs": 1,
                            "outputTail": "",
                        }
                    ),
                    "argv",
                ),
                (
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "action": "exec-result",
                            "argv": ["x"],
                            "exitCode": "0",
                            "timedOut": False,
                            "durationMs": 1,
                            "outputTail": "",
                        }
                    ),
                    "exitCode",
                ),
            ]
            for index, (raw, expected_field) in enumerate(cases):
                bad = change / "evidence" / "receipts" / f"bad-{index}.json"
                bad.write_text(raw, encoding="utf-8")
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    code = harness_ledger.main(
                        [
                            "--json",
                            "record-from-receipt",
                            "--change-dir",
                            str(change),
                            "--receipt",
                            str(bad),
                            "--verification",
                            "unitTest",
                        ]
                    )
                self.assertEqual(code, 1, msg=f"case {index}: {raw[:60]}")
                envelope = json.loads(stderr.getvalue())
                self.assertEqual(envelope["code"], "RECEIPT_INVALID")
                self.assertEqual(envelope["fieldPath"], expected_field)
                self.assertIn("recoveryAction", envelope)
                # 旧路保留为故障出口：recoveryAction 提到手工 record
                self.assertIn("record", envelope["recoveryAction"])
            # 坏收据一律不写 ledger
            self.assertFalse(
                (change / "evidence" / "verification-ledger.json").is_file()
            )

    def test_targeted_files_record_incremental_identity(self) -> None:
        """定向路径：--files 显式（不经 profile-input）→ inputsFiles 从显式文件算。

        对照 harness_task.py 定向记账语义：不用 unitTestFull 的 profile
        输入集给定向项记账——输入集声称覆盖全部而实际只测了部分是假证据。
        """
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            test_file = project / "src" / "test_app.py"
            test_file.write_text("def test_x():\n    pass\n", encoding="utf-8")
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.write_text(
                json.dumps(
                    self._receipt_payload(
                        argv=["python", "-m", "unittest", "test_app"]
                    )
                ),
                encoding="utf-8",
            )

            code, payload, _ = self._record_from_receipt(
                change,
                receipt_path,
                files=f"{src},{test_file}",
                project=project,
            )
            self.assertEqual(code, 0, msg=payload)
            entry = self._load_entry(change, "unitTest")
            # --project 给定时 inputsFiles 是项目相对路径（既有语义）
            self.assertEqual(
                entry["inputsFiles"], ["src/app.py", "src/test_app.py"]
            )
            # 定向（无 profile-input/scope）→ coverage 推导为 incremental
            self.assertEqual(entry["coverage"], "incremental")
            self.assertEqual(entry["command"], "python -m unittest test_app")

    def test_ownership_check_inherited_from_record(self) -> None:
        """frozen_ownership_check 拒绝时错误信封与手工 record 一致。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            subprocess.run(["git", "init"], cwd=project, check=True, capture_output=True)
            change = project / ".harness" / "changes" / "freeze-rfr"
            state = project / ".harness" / "state" / "changes" / "freeze-rfr"
            change.joinpath("meta").mkdir(parents=True)
            contract = {
                "schemaVersion": 2,
                "changeId": "freeze-rfr",
                "lifecycle": {"status": "active"},
                "ownership": {
                    "productPaths": ["src/"],
                    "staticEvidencePaths": [".harness/changes/freeze-rfr/"],
                    "excludedPaths": [".harness/state/"],
                },
                "stateOwnership": {
                    "contractRoot": ".harness/changes/freeze-rfr",
                    "runtimeRoot": ".harness/state/changes/freeze-rfr",
                },
            }
            change.joinpath("meta/change-context.json").write_text(
                json.dumps(contract), encoding="utf-8"
            )
            capsule = {
                "schemaVersion": 1,
                "phase": "execute",
                "runId": "run-1",
                "ownershipHash": harness_ledger.ownership_hash(contract),
                "createdAt": "2026-08-09T10:00:00+00:00",
            }
            capsule_path = state / "runtime" / "phase-context" / "run-1.json"
            capsule_path.parent.mkdir(parents=True)
            capsule_path.write_text(json.dumps(capsule), encoding="utf-8")
            # 冻结后改契约 → ownership 漂移
            contract["ownership"]["productPaths"].append("tests/")
            change.joinpath("meta/change-context.json").write_text(
                json.dumps(contract), encoding="utf-8"
            )
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.parent.mkdir(parents=True)
            receipt_path.write_text(
                json.dumps(self._receipt_payload()), encoding="utf-8"
            )

            stderr = io.StringIO()
            with redirect_stderr(stderr):
                code = harness_ledger.main(
                    [
                        "--json",
                        "record-from-receipt",
                        "--change-dir",
                        str(change),
                        "--receipt",
                        str(receipt_path),
                        "--verification",
                        "unitTest",
                    ]
                )
            self.assertEqual(code, 1)
            envelope = json.loads(stderr.getvalue())
            self.assertEqual(
                envelope["code"], "OWNERSHIP_CHANGED_BEFORE_VERIFICATION"
            )
            self.assertFalse(
                (change / "evidence" / "verification-ledger.json").is_file()
            )

    def test_rerun_same_receipt_overwrites_without_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.write_text(
                json.dumps(self._receipt_payload()), encoding="utf-8"
            )

            for _ in range(2):
                code, payload, _ = self._record_from_receipt(
                    change, receipt_path, files=str(src), project=project
                )
                self.assertEqual(code, 0, msg=payload)

            data = json.loads(
                (change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            # 幂等：同 verification 只有一个条目，无重复
            self.assertIn("unitTest", data["validations"])
            self.assertEqual(len(data["validations"]), 1)
            targets = data.get("verificationTargets", {})
            unit_targets = [
                key for key, value in targets.items() if value.get("verification") == "unitTest"
            ]
            self.assertEqual(len(unit_targets), 1)

    def test_scenario_ids_passthrough_binds_in_one_command(self) -> None:
        """B2-1：收据路径 + 场景绑定一次完成（不再被迫二次 record）。

        schemaVersion 1 manifest（试点 T4' 的实际形态）：--scenario-ids
        透传进 cmd_record 的 C9 绑定路径，scenarioIds 落入 ledger 条目。
        """
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            (change / "meta").mkdir()
            (change / "meta" / "scenario-manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "scenarios": [
                            {"id": "UT-001"},
                            {"id": "UT-002"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.write_text(
                json.dumps(self._receipt_payload()), encoding="utf-8"
            )

            code, payload, _ = self._record_from_receipt(
                change,
                receipt_path,
                files=str(src),
                project=project,
                scenario_ids="UT-001,UT-002",
            )
            self.assertEqual(code, 0, msg=payload)
            entry = self._load_entry(change, "unitTest")
            self.assertEqual(entry["scenarioIds"], ["UT-001", "UT-002"])
            # v1 manifest 不要求 scenario receipt → 不写 scenarioReceipt
            self.assertNotIn("scenarioReceipt", entry)

    def test_scenario_receipt_file_passthrough_v2_manifest(self) -> None:
        """B2-1：schemaVersion 2 manifest 时 receipt 强制校验语义不变。

        --scenario-receipt-file 透传后走 validate_scenario_execution_receipt
        全量校验（declared/selected/collected/executed 对账 + 覆盖推导），
        与手工 record 完全同一份代码路径。
        """
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            (change / "meta").mkdir()
            (change / "meta" / "scenario-manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "scenarios": [
                            {
                                "id": "UT-001",
                                "priority": "P1",
                                "ownerPhase": "execute",
                                "requiredEvidenceKind": "ledger",
                                "executableTestId": "unit::ut1",
                                "testFile": "tests/unit.spec.ts",
                                "testTitle": "ut1",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            scenario_receipt = change / "runtime" / "scenario-receipt.json"
            scenario_receipt.parent.mkdir(parents=True)
            scenario_receipt.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "runner": {"name": "vitest"},
                        "attempt": 1,
                        "declared": ["unit::ut1"],
                        "selected": ["unit::ut1"],
                        "collected": [
                            {
                                "testId": "unit::ut1",
                                "file": "tests/unit.spec.ts",
                                "title": "ut1",
                            }
                        ],
                        "executed": [
                            {
                                "testId": "unit::ut1",
                                "file": "tests/unit.spec.ts",
                                "title": "ut1",
                                "attempt": 1,
                                "status": "PASSED",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.write_text(
                json.dumps(self._receipt_payload()), encoding="utf-8"
            )

            code, payload, _ = self._record_from_receipt(
                change,
                receipt_path,
                files=str(src),
                project=project,
                scenario_ids="UT-001",
                scenario_receipt_file=scenario_receipt,
            )
            self.assertEqual(code, 0, msg=payload)
            entry = self._load_entry(change, "unitTest")
            self.assertEqual(entry["scenarioIds"], ["UT-001"])
            self.assertEqual(entry["scenarioReceipt"]["runner"]["name"], "vitest")
            self.assertEqual(entry["scenarioCoverage"]["passed"], ["UT-001"])

    def test_v2_manifest_without_scenario_receipt_still_fails_closed(self) -> None:
        """B2-1 透传不放松 fail-closed：v2 manifest + --scenario-ids 但缺
        --scenario-receipt-file → SCENARIO_RECEIPT_REQUIRED，且不写 ledger。
        """
        with tempfile.TemporaryDirectory() as tmp:
            project, change, src = self._setup_change(tmp)
            (change / "meta").mkdir()
            (change / "meta" / "scenario-manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "scenarios": [
                            {
                                "id": "UT-001",
                                "priority": "P1",
                                "ownerPhase": "execute",
                                "requiredEvidenceKind": "ledger",
                                "executableTestId": "unit::ut1",
                                "testFile": "tests/unit.spec.ts",
                                "testTitle": "ut1",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            receipt_path = change / "evidence" / "receipts" / "unitTest.json"
            receipt_path.write_text(
                json.dumps(self._receipt_payload()), encoding="utf-8"
            )

            code, payload, err = self._record_from_receipt(
                change,
                receipt_path,
                files=str(src),
                project=project,
                scenario_ids="UT-001",
            )
            self.assertEqual(code, 1)
            # cmd_record 的错误信封经 stderr 透传（record-from-receipt 契约）
            envelope = json.loads(err)
            self.assertEqual(envelope["code"], "SCENARIO_RECEIPT_REQUIRED")
            self.assertFalse(
                (change / "evidence" / "verification-ledger.json").is_file()
            )


class RenderReportTests(unittest.TestCase):
    """批次 2 WI-4a：render-report（测试报告派生，消不对称 E）。"""

    def _setup_change(self, tmp: str) -> tuple[Path, Path]:
        project = Path(tmp)
        # git init：变更文件表与 base/head 推导需要仓库
        subprocess.run(
            ["git", "init", "-q"], cwd=str(project), check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "t@example.com"],
            cwd=str(project), check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "t"],
            cwd=str(project), check=True, capture_output=True,
        )
        # 种子文件：空仓库 git commit 会失败
        (project / "README.md").write_text("seed\n", encoding="utf-8")
        change = project / ".harness" / "changes" / "rr-task"
        (change / "evidence").mkdir(parents=True)
        return project, change

    def _commit(self, project: Path, message: str) -> str:
        subprocess.run(
            ["git", "add", "-A"], cwd=str(project), check=True,
            capture_output=True,
        )
        proc = subprocess.run(
            ["git", "commit", "-q", "-m", message],
            cwd=str(project), check=True, capture_output=True, text=True,
        )
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(project), check=True, capture_output=True, text=True,
        ).stdout.strip()

    def _write_ledger(
        self, change: Path, validations: dict, *, base_commit: str | None = None
    ) -> None:
        path = change / "evidence" / "verification-ledger.json"
        data: dict = {"schemaVersion": 3, "validations": validations}
        if base_commit:
            data["baseCommit"] = base_commit
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _render(
        self, change: Path, *, out: str | None = None
    ) -> tuple[int, dict | None, str]:
        from io import StringIO

        argv = ["--json", "render-report", "--change-dir", str(change)]
        if out:
            argv += ["--out", out]
        buf = StringIO()
        err = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            code = harness_ledger.main(argv)
        raw = buf.getvalue().strip()
        payload = json.loads(raw) if raw else None
        return code, payload, err.getvalue()

    def test_renders_all_sections_from_ledger_and_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            base = self._commit(project, "base")
            src = project / "src" / "app.py"
            src.parent.mkdir(parents=True)
            src.write_text("x = 1\n", encoding="utf-8")
            head = self._commit(project, "add app")
            self._write_ledger(
                change,
                {
                    "unitTest": {
                        "status": "OK",
                        "command": "npm test",
                        "exitCode": 0,
                        "durationMs": 4200,
                        "evidence": "Tests run: 31, Failures: 0, Errors: 0",
                        "scope": "module",
                        "coverage": "module",
                        "metrics": {"total": 31, "passed": 31, "failed": 0},
                        "finishedAt": "2026-09-09T10:00:00+08:00",
                    },
                    "compile": {
                        "status": "FAIL",
                        "command": "tsc --noEmit",
                        "exitCode": 2,
                        "durationMs": 800,
                        "evidence": "error TS1: bad",
                    },
                },
                base_commit=base,
            )
            (change / "events.ndjson").write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "phase.start",
                                "phase": "execute",
                                "timestamp": "2026-09-09T09:00:00+08:00",
                            }
                        ),
                        json.dumps(
                            {
                                "type": "phase.end",
                                "phase": "execute",
                                "status": "PASS",
                                "timestamp": "2026-09-09T10:00:00+08:00",
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            code, payload, err = self._render(change)
            self.assertEqual(code, 0, msg=err or payload)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["action"], "render-report")
            self.assertEqual(payload["changeName"], "rr-task")
            self.assertEqual(payload["changedFileCount"], 1)
            self.assertEqual(payload["verificationCount"], 2)

            report = Path(payload["path"])
            self.assertTrue(report.is_file())
            # 默认落 reports/test/test-report-*.md（find_test_reports 兼容）
            self.assertEqual(report.parent, change / "reports" / "test")
            self.assertTrue(report.name.startswith("test-report-"))
            text = report.read_text(encoding="utf-8")
            # frontmatter 生成标记
            self.assertIn("generated: true", text)
            self.assertIn("generator: harness-render-report-1", text)
            # 变更文件表
            self.assertIn("## 变更文件", text)
            self.assertIn("src/app.py", text)
            self.assertIn(f"`{base[:12]}..{head[:12]}`", text)
            # 验证证据
            self.assertIn("## 验证证据", text)
            self.assertIn("unitTest", text)
            self.assertIn("compile", text)
            self.assertIn("npm test", text)
            self.assertIn("Tests run: 31", text)
            self.assertIn("total=31", text)
            # 五态
            self.assertIn("## 五态状态总览", text)
            # 阶段摘要（events）
            self.assertIn("## 阶段执行摘要（events）", text)
            self.assertIn("execute", text)
            # 模型解读占位
            self.assertIn("## 解读（模型追加）", text)
            self.assertIn("### 残余风险", text)
            self.assertIn("### 下一步", text)

    def test_five_state_reused_and_retested(self) -> None:
        entry_reused = {"status": "OK", "reused": "true"}
        self.assertEqual(
            harness_ledger._render_report_five_state(entry_reused), "REUSED"
        )
        entry_retested = {
            "status": "OK",
            "attempts": [
                {"status": "FAIL"},
                {"status": "OK"},
            ],
        }
        self.assertEqual(
            harness_ledger._render_report_five_state(entry_retested), "RETESTED"
        )
        entry_plain = {"status": "FAIL"}
        self.assertEqual(
            harness_ledger._render_report_five_state(entry_plain), "FAIL"
        )
        entry_empty: dict = {}
        self.assertEqual(
            harness_ledger._render_report_five_state(entry_empty), "UNKNOWN"
        )

    def test_out_flag_writes_custom_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            self._write_ledger(change, {})

            code, payload, err = self._render(
                change, out="reports/test/custom.md"
            )
            self.assertEqual(code, 0, msg=err or payload)
            report = Path(payload["path"])
            self.assertEqual(
                report, (change / "reports" / "test" / "custom.md").resolve()
            )
            self.assertTrue(report.is_file())

    def test_out_path_escape_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            self._write_ledger(change, {})
            outside = project.parent / "escape.md"

            code, payload, err = self._render(
                change, out=str(outside)
            )
            self.assertEqual(code, 1)
            envelope = json.loads(err)
            self.assertEqual(envelope["code"], "REPORT_OUT_OF_PROJECT")
            self.assertFalse(outside.is_file())

    def test_handwritten_report_blocks_render(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            self._write_ledger(change, {})
            handwritten = change / "reports" / "test" / "test-report-20260101-0000.md"
            handwritten.parent.mkdir(parents=True, exist_ok=True)
            handwritten.write_text(
                "## 测试报告 — 手写\n（无 frontmatter）\n", encoding="utf-8"
            )

            code, payload, err = self._render(change)
            self.assertEqual(code, 1)
            envelope = json.loads(err)
            self.assertEqual(envelope["code"], "HANDWRITTEN_REPORT_EXISTS")
            self.assertIn("recoveryAction", envelope)
            # 不产生第二份报告
            reports = list((change / "reports" / "test").glob("*.md"))
            self.assertEqual(reports, [handwritten])

    def test_generated_report_allows_rerender(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            self._write_ledger(
                change,
                {
                    "unitTest": {
                        "status": "OK",
                        "command": "npm test",
                        "exitCode": 0,
                        "durationMs": 100,
                        "evidence": "ok",
                    }
                },
            )
            code, payload, err = self._render(change)
            self.assertEqual(code, 0, msg=err or payload)
            first = Path(payload["path"])
            self.assertTrue(first.is_file())
            # 渲染产物带生成标记 → 重渲染不被手写报告检查阻断
            code2, payload2, err2 = self._render(change)
            self.assertEqual(code2, 0, msg=err2 or payload2)
            second = Path(payload2["path"])
            self.assertTrue(second.is_file())
            # 同分钟内重渲染幂等覆盖同一文件（分钟粒度时间戳）
            self.assertEqual(first, second)

    def test_empty_ledger_renders_with_placeholders(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            # 无 ledger、无 events、无 manifest
            code, payload, err = self._render(change)
            self.assertEqual(code, 0, msg=err or payload)
            text = Path(payload["path"]).read_text(encoding="utf-8")
            self.assertIn("（ledger 无验证记录）", text)
            self.assertIn("（无 scenario-manifest 或检查不适用）", text)
            self.assertIn("（无提交间差异或 base/head 不可得）", text)

    def test_scenario_coverage_summary_rendered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, change = self._setup_change(tmp)
            self._write_ledger(
                change,
                {
                    "apiTest": {
                        "status": "OK",
                        "command": "pytest api",
                        "exitCode": 0,
                        "durationMs": 5000,
                        "evidence": "3/3 passed",
                        "scenarioIds": ["SC-001"],
                        "scenarioReceipt": {
                            "schemaVersion": 1,
                            "runner": {"name": "pytest"},
                            "attempt": 1,
                            "declared": ["SC-001"],
                            "selected": ["SC-001"],
                            "collected": [
                                {
                                    "testId": "SC-001",
                                    "file": "tests/api/test_sc001.py",
                                    "title": "scenario 1",
                                }
                            ],
                            "executed": [
                                {
                                    "testId": "SC-001",
                                    "file": "tests/api/test_sc001.py",
                                    "title": "scenario 1",
                                    "attempt": 1,
                                    "status": "PASSED",
                                }
                            ],
                        },
                    }
                },
            )
            (change / "meta").mkdir()
            (change / "meta" / "scenario-manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "scenarios": [
                            {
                                "id": "SC-001",
                                "priority": "P0",
                                "requiredEvidenceKind": "ledger",
                                "ownerPhase": "execute",
                                "executableTestId": "SC-001",
                                "testFile": "tests/api/test_sc001.py",
                                "testTitle": "scenario 1",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            code, payload, err = self._render(change)
            self.assertEqual(code, 0, msg=err or payload)
            self.assertEqual(payload["scenarioCoverageCode"], "SCENARIO_COVERAGE_OK")
            text = Path(payload["path"]).read_text(encoding="utf-8")
            self.assertIn("## 场景覆盖摘要", text)
            self.assertIn("SC-001", text)
            self.assertIn("SCENARIO_COVERAGE_OK", text)

    def test_change_dir_not_found(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "no-such-change"
            code, payload, err = self._render(missing)
            self.assertEqual(code, 1)
            envelope = json.loads(err)
            self.assertEqual(envelope["code"], "CHANGE_DIR_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
