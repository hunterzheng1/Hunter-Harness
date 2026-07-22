#!/usr/bin/env python3
"""Wave-2 regression: H-7 / H-9 / H-15 / H-16."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import harness_events as he  # noqa: E402
import harness_integration as hi  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_migration_head as mh  # noqa: E402


class MigrationHeadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="hh-mig-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / ".harness" / "config").mkdir(parents=True)
        (self.root / "cfg").mkdir()
        (self.root / "cfg" / "app.py").write_text(
            'EXPECTED_ALEMBIC_HEAD = "005_ok"\n', encoding="utf-8"
        )
        (self.root / "manifest.json").write_text(
            json.dumps({"migrationHead": "005_ok"}), encoding="utf-8"
        )
        (self.root / ".harness" / "config" / "migration-head.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "head": "005_ok",
                    "sources": [
                        {
                            "path": "cfg/app.py",
                            "pattern": r"EXPECTED_ALEMBIC_HEAD\s*=\s*[\"']([^\"']+)[\"']",
                        },
                        {"path": "manifest.json", "jsonPointer": "/migrationHead"},
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    def test_ut001_ok(self) -> None:
        result = mh.check_migration_head(self.root)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "MIGRATION_HEAD_OK")

    def test_ut002_drift(self) -> None:
        (self.root / "cfg" / "app.py").write_text(
            'EXPECTED_ALEMBIC_HEAD = "004_old"\n', encoding="utf-8"
        )
        result = mh.check_migration_head(self.root)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MIGRATION_HEAD_DRIFT")

    def test_ut003_missing(self) -> None:
        (self.root / ".harness" / "config" / "migration-head.json").unlink()
        result = mh.check_migration_head(self.root)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MIGRATION_HEAD_MISSING")


class VerificationGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="hh-graph-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.change = self.root / "change"
        (self.change / "evidence").mkdir(parents=True)
        (self.change / "meta").mkdir()
        (self.root / "src").mkdir()
        self.src = self.root / "src" / "a.py"
        self.src.write_text("x=1\n", encoding="utf-8")

    def test_ut010_record_upserts_graph(self) -> None:
        ns = type(
            "Args",
            (),
            {
                "json": True,
                "verbose": True,
                "change_dir": str(self.change),
                "verification": "unitTest",
                "status": "OK",
                "command": "python -m unittest",
                "exit_code": 0,
                "duration_ms": 1,
                "files": str(self.src),
                "files_from": None,
                "evidence": "ok",
                "project": str(self.root),
                "scope": "module",
                "coverage": "module",
                "toolchain_hash": None,
                "profile_hash": None,
                "environment_hash": None,
                "db_schema_hash": None,
                "base_commit": None,
                "diff_hash": None,
                "scenario_ids": None,
                "deploy_artifact": None,
                "artifact_hash": None,
                "tests_executed": False,
                "tests_reused_from": None,
            },
        )()
        # Prefer calling upsert directly for unit isolation
        node = hl.upsert_verification_graph_node(
            self.change,
            verification="unitTestFull",
            status="OK",
            inputs_hash="sha256:abc",
            command="npm test",
        )
        self.assertTrue(node["ok"])
        graph = json.loads(hl.verification_graph_path(self.change).read_text(encoding="utf-8"))
        self.assertEqual(len(graph["nodes"]), 1)
        self.assertEqual(graph["nodes"][0]["identity"]["verification"], "unitTestFull")

    def test_ut011_input_changed_invalidation_code(self) -> None:
        ledger = {
            "validations": {
                "unitTest": {
                    "status": "OK",
                    "evidence": "e",
                    "command": "cmd",
                    "scope": "module",
                    "algorithmVersion": hl.LEDGER_VERSION,
                    "coverage": "module",
                    "inputsHash": "sha256:old",
                    "inputsFiles": [self.src.as_posix()],
                }
            }
        }
        hl.write_ledger(self.change / "evidence" / "verification-ledger.json", ledger)
        payload = hl.decide_can_reuse(
            change_dir=self.change,
            verification="unitTest",
            files=[self.src.as_posix()],
            requested_command="cmd",
            requested_scope="module",
        )
        payload = hl._attach_invalidation_code(payload)
        self.assertFalse(payload["reuse"])
        self.assertEqual(payload["code"], "INPUTS_HASH_CHANGED")
        self.assertEqual(payload["invalidationCode"], "INPUT_CHANGED")

    def test_ut012_missing_identity_alias(self) -> None:
        payload = hl._attach_invalidation_code(
            {
                "ok": True,
                "reuse": False,
                "reason": "insufficient-evidence",
                "code": "MISSING_FIELDS",
            }
        )
        self.assertEqual(payload["invalidationCode"], "MISSING_IDENTITY_FIELD")

    def test_ut013_required_on_merge_commands(self) -> None:
        holder = type("Txn", (), {"project_root": Path(".")})()
        profile = {
            "mergeVerification": {
                "requiredOnMerge": [
                    {"command": [sys.executable, "-c", "pass"]},
                    "echo hh-required-on-merge",
                ]
            }
        }
        with mock.patch("harness_profile.load_profile", return_value=profile):
            commands = hi.IntegrationTransaction._required_on_merge_commands(holder)
        self.assertEqual(commands[0], [sys.executable, "-c", "pass"])
        self.assertEqual(commands[1], ["echo", "hh-required-on-merge"])


class BatchAppendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="hh-batch-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.change = self.root / "change"
        self.change.mkdir()

    def test_ut020_batch_ok(self) -> None:
        result = he.batch_append_events(
            self.change,
            [
                {"phase": "run", "type": "issue", "severity": "info", "note": "a"},
                {"phase": "run", "type": "issue", "severity": "info", "note": "b"},
                {"phase": "run", "type": "issue", "severity": "info", "note": "c"},
            ],
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["count"], 3)
        lines = (self.change / "events.ndjson").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 3)

    def test_ut021_batch_rejects_pathless_artifact(self) -> None:
        result = he.batch_append_events(
            self.change,
            [
                {"phase": "run", "type": "issue", "severity": "info", "note": "ok"},
                {"phase": "run", "type": "artifact", "note": "bad"},
            ],
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ARTIFACT_PATH_REQUIRED")
        self.assertFalse((self.change / "events.ndjson").exists())


class ModelRoutingProtocolTests(unittest.TestCase):
    def test_ut030_protocol_defines_levels(self) -> None:
        path = SCRIPTS.parent / "protocols" / "model-routing-protocol.md"
        text = path.read_text(encoding="utf-8")
        for level in ("economy", "balanced", "frontier"):
            self.assertIn(level, text)


if __name__ == "__main__":
    unittest.main()
