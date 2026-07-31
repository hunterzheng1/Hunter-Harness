import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_ledger.py"
SPEC = importlib.util.spec_from_file_location("harness_ledger_targets_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LEDGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEDGER)


class LedgerTargetTest(unittest.TestCase):
    def _scenario_record_args(
        self,
        *,
        change: Path,
        source: Path,
        receipt: Path | None = None,
    ) -> list[str]:
        args = [
            "record",
            "--change-dir",
            str(change),
            "--verification",
            "compile",
            "--status",
            "ok",
            "--command",
            "npm run typecheck",
            "--exit-code",
            "0",
            "--duration-ms",
            "10",
            "--files",
            str(source),
            "--evidence",
            "typecheck passed",
            "--scope",
            "module",
            "--scenario-ids",
            "SC-001",
            "--json",
        ]
        if receipt is not None:
            args.extend(["--scenario-receipt-file", str(receipt)])
        return args

    def _write_scenario_manifest(self, change: Path) -> None:
        manifest = {
            "schemaVersion": 2,
            "changeName": change.name,
            "scenarios": [
                {
                    "id": "SC-001",
                    "priority": "P0",
                    "scenario": "compile succeeds",
                    "ownerPhase": "test",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "compile::happy-path",
                    "testFile": "tests/compile.spec.ts",
                    "testTitle": "compiles the project",
                }
            ],
        }
        (change / "meta").mkdir(parents=True)
        (change / "meta/scenario-manifest.json").write_text(
            json.dumps(manifest),
            encoding="utf-8",
        )

    def test_schema_v2_scenario_binding_requires_structured_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / "change"
            change.mkdir()
            self._write_scenario_manifest(change)
            source = root / "source.ts"
            source.write_text("export const value = 1\n", encoding="utf-8")

            stderr = io.StringIO()
            with redirect_stderr(stderr):
                code = LEDGER.main(
                    self._scenario_record_args(change=change, source=source)
                )

            self.assertEqual(code, 1)
            self.assertIn("SCENARIO_RECEIPT_REQUIRED", stderr.getvalue())
            self.assertFalse(
                (change / "evidence/verification-ledger.json").exists()
            )

    def test_schema_v2_scenario_receipt_records_exact_execution_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / "change"
            change.mkdir()
            self._write_scenario_manifest(change)
            source = root / "source.ts"
            source.write_text("export const value = 1\n", encoding="utf-8")
            receipt = root / "scenario-receipt.json"
            receipt.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "runner": {"name": "vitest", "version": "3.2.4"},
                        "attempt": 1,
                        "declared": ["compile::happy-path"],
                        "selected": ["compile::happy-path"],
                        "collected": [
                            {
                                "testId": "compile::happy-path",
                                "file": "tests/compile.spec.ts",
                                "title": "compiles the project",
                            }
                        ],
                        "executed": [
                            {
                                "testId": "compile::happy-path",
                                "file": "tests/compile.spec.ts",
                                "title": "compiles the project",
                                "attempt": 1,
                                "status": "PASSED",
                                "secret": "must not be persisted",
                            }
                        ],
                        "secret": "must not be persisted",
                    }
                ),
                encoding="utf-8",
            )

            code = LEDGER.main(
                self._scenario_record_args(
                    change=change,
                    source=source,
                    receipt=receipt,
                )
            )

            self.assertEqual(code, 0)
            ledger = json.loads(
                (change / "evidence/verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            entry = ledger["validations"]["compile"]
            self.assertEqual(entry["scenarioCoverage"]["passed"], ["SC-001"])
            self.assertEqual(
                entry["scenarioReceipt"]["executed"][0],
                {
                    "testId": "compile::happy-path",
                    "file": "tests/compile.spec.ts",
                    "title": "compiles the project",
                    "attempt": 1,
                    "status": "PASSED",
                },
            )
            self.assertNotIn("secret", entry["scenarioReceipt"])

    def test_schema_v2_ok_record_rejects_skipped_required_scenario(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / "change"
            change.mkdir()
            self._write_scenario_manifest(change)
            source = root / "source.ts"
            source.write_text("export const value = 1\n", encoding="utf-8")
            receipt = root / "scenario-receipt.json"
            receipt.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "runner": {"name": "vitest"},
                        "attempt": 1,
                        "declared": ["compile::happy-path"],
                        "selected": ["compile::happy-path"],
                        "collected": [
                            {
                                "testId": "compile::happy-path",
                                "file": "tests/compile.spec.ts",
                                "title": "compiles the project",
                            }
                        ],
                        "executed": [
                            {
                                "testId": "compile::happy-path",
                                "file": "tests/compile.spec.ts",
                                "title": "compiles the project",
                                "attempt": 1,
                                "status": "SKIPPED",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            stderr = io.StringIO()
            with redirect_stderr(stderr):
                code = LEDGER.main(
                    self._scenario_record_args(
                        change=change,
                        source=source,
                        receipt=receipt,
                    )
                )

            self.assertEqual(code, 1)
            self.assertIn("REQUIRED_SCENARIO_NOT_EXECUTED", stderr.getvalue())

    def test_record_writes_dynamic_target_and_legacy_mirror(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / "change"
            change.mkdir()
            source = root / "source.ts"
            source.write_text("export const value = 1\n", encoding="utf-8")
            code = LEDGER.main(
                [
                    "record",
                    "--change-dir",
                    str(change),
                    "--verification",
                    "compile",
                    "--status",
                    "ok",
                    "--command",
                    "npm run typecheck",
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "10",
                    "--files",
                    str(source),
                    "--evidence",
                    "typecheck passed",
                    "--scope",
                    "module",
                    "--json",
                ]
            )
            self.assertEqual(code, 0)
            ledger = json.loads(
                (change / "evidence/verification-ledger.json").read_text(encoding="utf-8")
            )
            self.assertIn("compile", ledger["validations"])
            targets = ledger["verificationTargets"]
            self.assertEqual(len(targets), 1)
            target = next(iter(targets.values()))
            self.assertEqual(target["verification"], "compile")
            self.assertEqual(target["command"], "npm run typecheck")

    def test_rerecord_does_not_inherit_prior_invalidation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / "change"
            (change / "evidence").mkdir(parents=True)
            source = root / "source.ts"
            source.write_text("export const value = 1\n", encoding="utf-8")
            stale = {
                "status": "OK",
                "command": "npm run typecheck",
                "exitCode": 0,
                "durationMs": 10,
                "evidence": "superseded evidence",
                "inputsHash": "sha256:stale",
                "inputsFiles": [str(source)],
                "scope": "module",
                "coverage": "module",
                "algorithmVersion": LEDGER.LEDGER_VERSION,
                "reusable": False,
                "invalidation": {
                    "code": "FIXBACK_INVALIDATED",
                    "transitionHash": "sha256:old-transition",
                },
            }
            (change / "evidence/verification-ledger.json").write_text(
                json.dumps({"validations": {"compile": stale}}),
                encoding="utf-8",
            )

            code = LEDGER.main(
                [
                    "record",
                    "--change-dir",
                    str(change),
                    "--verification",
                    "compile",
                    "--status",
                    "ok",
                    "--command",
                    "npm run typecheck",
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "20",
                    "--files",
                    str(source),
                    "--evidence",
                    "fresh evidence",
                    "--scope",
                    "module",
                    "--json",
                ]
            )

            self.assertEqual(code, 0)
            ledger = json.loads(
                (change / "evidence/verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
            entry = ledger["validations"]["compile"]
            self.assertNotIn("reusable", entry)
            self.assertNotIn("invalidation", entry)
            target = next(iter(ledger["verificationTargets"].values()))
            self.assertNotIn("reusable", target)
            self.assertNotIn("invalidation", target)

    def test_reuse_prefers_latest_dynamic_target_over_stale_mirror(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            (change / "evidence").mkdir(parents=True)
            source = change / "source.ts"
            source.write_text("x", encoding="utf-8")
            inputs_hash, files = LEDGER.compute_inputs_hash([str(source)])
            old = {
                "status": "OK",
                "command": "old command",
                "scope": "module",
                "coverage": "module",
                "algorithmVersion": LEDGER.LEDGER_VERSION,
                "inputsHash": inputs_hash,
                "inputsFiles": files,
                "evidence": "old",
            }
            latest = {
                **old,
                "id": "target-new",
                "verification": "compile",
                "command": "new command",
                "finishedAt": "2026-07-29T12:00:00+00:00",
            }
            (change / "evidence/verification-ledger.json").write_text(
                json.dumps(
                    {
                        "validations": {"compile": old},
                        "verificationTargets": {"target-new": latest},
                    }
                ),
                encoding="utf-8",
            )
            result = LEDGER.decide_can_reuse(
                change_dir=change,
                verification="compile",
                files=[str(source)],
                requested_command="old command",
            )
            self.assertFalse(result["reuse"])
            self.assertEqual(result["code"], "COMMAND_CHANGED")

    def test_verify_reuse_uses_content_key_not_commit_and_invalidates_context(self) -> None:
        """VERIFY-REUSE-01/02: no-ff provenance differs; content/context cannot."""
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            (change / "evidence").mkdir(parents=True)
            source = change / "source.ts"
            source.write_text("x", encoding="utf-8")
            inputs_hash, files = LEDGER.compute_inputs_hash([str(source)])
            command = "npm run test:full"
            target = {
                "id": "feature-tip-full",
                "verification": "unitTestFull",
                "status": "OK",
                "command": command,
                "commandSetHash": LEDGER.command_set_hash(command),
                "productCommit": "feature-tip",
                "productTreeHash": "sha256:" + "a" * 64,
                "environmentHash": "sha256:env-a",
                "toolchainHash": "sha256:tool-a",
                "lockHash": "sha256:lock-a",
                "scope": "module",
                "coverage": "module",
                "algorithmVersion": LEDGER.LEDGER_VERSION,
                "inputsHash": inputs_hash,
                "inputsFiles": files,
                "evidence": "feature evidence",
            }
            (change / "evidence" / "verification-ledger.json").write_text(
                json.dumps({"verificationTargets": {"feature-tip-full": target}}),
                encoding="utf-8",
            )
            reusable = LEDGER.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(source)],
                requested_command=command,
                requested_product_tree_hash="sha256:" + "a" * 64,
                requested_command_set_hash=LEDGER.command_set_hash(command),
                requested_environment_hash="sha256:env-a",
                requested_toolchain_hash="sha256:tool-a",
                requested_lock_hash="sha256:lock-a",
            )
            self.assertTrue(reusable["reuse"], reusable)
            self.assertEqual(reusable["reusedFrom"]["sourceCommit"], "feature-tip")
            self.assertIn("productTreeHash", reusable["reuseKey"])

            invalid = LEDGER.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(source)],
                requested_command=command,
                requested_product_tree_hash="sha256:" + "a" * 64,
                requested_command_set_hash=LEDGER.command_set_hash(command),
                requested_environment_hash="sha256:env-b",
            )
            self.assertFalse(invalid["reuse"])
            self.assertEqual(invalid["code"], "ENVIRONMENT_CHANGED")

            # A newer target for a different product must not mask the
            # feature-tip candidate selected by the canonical key.
            ledger_path = change / "evidence" / "verification-ledger.json"
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            ledger["verificationTargets"]["other-product-newer"] = {
                **target,
                "id": "other-product-newer",
                "productCommit": "unrelated-newer-commit",
                "productTreeHash": "sha256:" + "b" * 64,
                "finishedAt": "2026-07-30T20:00:00+00:00",
            }
            ledger_path.write_text(json.dumps(ledger), encoding="utf-8")
            selected = LEDGER.decide_can_reuse(
                change_dir=change,
                verification="unitTestFull",
                files=[str(source)],
                requested_command=command,
                requested_product_tree_hash="sha256:" + "a" * 64,
                requested_command_set_hash=LEDGER.command_set_hash(command),
                requested_environment_hash="sha256:env-a",
                requested_toolchain_hash="sha256:tool-a",
                requested_lock_hash="sha256:lock-a",
            )
            self.assertTrue(selected["reuse"], selected)
            self.assertEqual(selected["reusedFrom"]["targetId"], "feature-tip-full")


if __name__ == "__main__":
    unittest.main()
