import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_ledger.py"
SPEC = importlib.util.spec_from_file_location("harness_ledger_targets_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LEDGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEDGER)


class LedgerTargetTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
