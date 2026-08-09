#!/usr/bin/env python3
"""Remote archive upload state and credential resolution tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_json(path: Path, data: object) -> None:
    _write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def _seed_core_archive(root: Path, change_key: str) -> Path:
    archive = root / ".harness" / "archive" / change_key
    _write_json(
        archive / "reports" / "final" / "summary-data.json",
        {
            "schemaVersion": "2.3",
            "changeKey": change_key,
            "summary": "服务端知识归档",
        },
    )
    _write(archive / "spec" / "design.md", "# 设计\n")
    return archive


def _write_local_credentials(root: Path) -> None:
    _write(
        root / ".harness" / "credentials.local.yaml",
        "server_url: https://platform.example.test\ntoken: local-token\n",
    )


def _npx_upload_calls(run: mock.Mock) -> list[object]:
    return [
        call
        for call in run.call_args_list
        if call.args
        and isinstance(call.args[0], list)
        and "hunter-harness" in call.args[0]
        and "--yes" in call.args[0]
        and call.args[0].index("--yes") + 1 == call.args[0].index("hunter-harness")
    ]


class ArchiveRemoteUploadStateTests(unittest.TestCase):
    def test_windows_npx_launcher_uses_node_instead_of_bare_cmd_shim(self) -> None:
        with mock.patch.object(
            ha.shutil,
            "which",
            side_effect=lambda name: {
                "node": r"C:\Program Files\nodejs\node.exe",
                "npx": r"C:\Program Files\nodejs\npx.CMD",
            }.get(name),
        ), mock.patch.object(ha.os, "name", "nt"):
            launcher = ha.resolve_npx_launcher()

        self.assertEqual(launcher[0], r"C:\Program Files\nodejs\node.exe")
        self.assertEqual(
            launcher[1],
            r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js",
        )

    def test_no_database_capability_projects_get_typed_not_applicable_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            _write_json(
                change / "meta" / "gate-policy.json",
                {"schemaVersion": 1, "capabilities": []},
            )

            projection = ha.build_verification_projection({}, change_dir=change)

            self.assertEqual(projection["dbCompatibility"], "NOT_APPLICABLE")
            self.assertEqual(
                projection["dbCompatibilityEvidence"]["source"],
                "capability-profile",
            )

    def test_loopback_http_platform_is_valid_for_local_development(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write(
                root / ".harness" / "credentials.local.yaml",
                "server_url: http://127.0.0.1:3003\ntoken: local-token\n",
            )

            resolved = ha._resolve_archive_remote_credentials(root, {})

            self.assertTrue(resolved["configured"], resolved)
            self.assertEqual(resolved["serverUrl"], "http://127.0.0.1:3003")

    def test_non_loopback_plain_http_platform_remains_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write(
                root / ".harness" / "credentials.local.yaml",
                "server_url: http://platform.example.test\ntoken: local-token\n",
            )

            resolved = ha._resolve_archive_remote_credentials(root, {})

            self.assertFalse(resolved["configured"], resolved)

    def test_missing_credentials_still_builds_retryable_package_and_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = _seed_core_archive(root, "change-no-auth")

            with mock.patch.object(ha.subprocess, "run") as run:
                result = ha.auto_push_archive_core(
                    root, archive, change_key="change-no-auth"
                )

            self.assertEqual(_npx_upload_calls(run), [])
            self.assertTrue(result.get("skipped"))
            self.assertEqual(
                result.get("reasonCode"), "ARCHIVE_UPLOAD_CREDENTIALS_MISSING"
            )
            self.assertTrue(Path(str(result["packagePath"])).is_file())
            receipt_path = Path(str(result["pending"]))
            self.assertEqual(receipt_path.name, "change-no-auth.upload.json")
            self.assertEqual(
                receipt_path.parent,
                root / ".harness" / "state" / "local" / "archive-packages",
            )
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["uploadStatus"], "pending")
            self.assertEqual(
                receipt["reasonCode"], "ARCHIVE_UPLOAD_CREDENTIALS_MISSING"
            )

    def test_project_server_and_token_env_automatically_invoke_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = _seed_core_archive(root, "change-env")
            _write(
                root / ".harness" / "project.yaml",
                "server:\n"
                "  url: https://env-platform.example.test\n"
                "  token_env: PROJECT_ARCHIVE_TOKEN\n",
            )
            completed = subprocess.CompletedProcess(
                [],
                0,
                stdout=json.dumps(
                    {
                        "archive_id": "arc_env",
                        "archive_status": "durable",
                        "knowledge_status": "ready",
                    }
                ),
                stderr="",
            )

            with mock.patch.dict(
                os.environ, {"PROJECT_ARCHIVE_TOKEN": "env-token"}, clear=False
            ), mock.patch.object(
                ha.subprocess, "run", return_value=completed
            ) as run:
                result = ha.auto_push_archive_core(
                    root, archive, change_key="change-env"
                )

            upload_calls = _npx_upload_calls(run)
            self.assertEqual(len(upload_calls), 1)
            command = upload_calls[0].args[0]
            self.assertIn("archive", command)
            self.assertIn("upload", command)
            self.assertEqual(
                command[command.index("--server-url") + 1],
                "https://env-platform.example.test",
            )
            self.assertEqual(
                command[command.index("--token-env") + 1],
                "PROJECT_ARCHIVE_TOKEN",
            )
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("uploadStatus"), "ready")
            self.assertFalse(Path(str(result["packagePath"])).exists())
            self.assertFalse(Path(str(result["pending"])).exists())

    def test_nested_credential_like_fields_are_not_treated_as_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = _seed_core_archive(root, "change-nested-auth")
            _write(
                root / ".harness" / "credentials.local.yaml",
                "unrelated:\n"
                "  server_url: https://nested.example.test\n"
                "  token: must-not-be-used\n",
            )
            completed = subprocess.CompletedProcess(
                [], 1, stdout="", stderr=""
            )

            with mock.patch.object(
                ha.subprocess, "run", return_value=completed
            ) as run:
                result = ha.auto_push_archive_core(
                    root, archive, change_key="change-nested-auth"
                )

            self.assertEqual(_npx_upload_calls(run), [])
            self.assertTrue(result.get("skipped"))
            self.assertEqual(
                result.get("reasonCode"), "ARCHIVE_UPLOAD_CREDENTIALS_MISSING"
            )

    def test_failed_uploads_for_two_changes_keep_distinct_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_archive = _seed_core_archive(root, "change-one")
            second_archive = _seed_core_archive(root, "change-two")
            _write_local_credentials(root)
            completed = subprocess.CompletedProcess(
                [],
                8,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "errors": [
                            {
                                "code": "ARCHIVE_REMOTE_UNAVAILABLE",
                                "message": "远端暂不可用",
                            }
                        ],
                    }
                ),
                stderr="远端暂不可用",
            )

            with mock.patch.object(ha.subprocess, "run", return_value=completed):
                first = ha.auto_push_archive_core(
                    root, first_archive, change_key="change-one"
                )
                second = ha.auto_push_archive_core(
                    root, second_archive, change_key="change-two"
                )

            package_root = (
                root / ".harness" / "state" / "local" / "archive-packages"
            )
            self.assertEqual(
                sorted(path.name for path in package_root.glob("*.upload.json")),
                ["change-one.upload.json", "change-two.upload.json"],
            )
            self.assertEqual(Path(str(first["pending"])).name, "change-one.upload.json")
            self.assertEqual(Path(str(second["pending"])).name, "change-two.upload.json")
            self.assertTrue(Path(str(first["packagePath"])).is_file())
            self.assertTrue(Path(str(second["packagePath"])).is_file())
            self.assertEqual(first.get("uploadStatus"), "pending")
            self.assertEqual(second.get("uploadStatus"), "pending")
            self.assertEqual(first.get("reasonCode"), "ARCHIVE_REMOTE_UNAVAILABLE")

    def test_indexing_receipt_is_pending_and_kept_for_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = _seed_core_archive(root, "change-indexing")
            _write_local_credentials(root)
            completed = subprocess.CompletedProcess(
                [],
                0,
                stdout=json.dumps(
                    {
                        "archive_id": "arc_indexing",
                        "archive_status": "durable",
                        "knowledge_status": "indexing",
                    }
                ),
                stderr="",
            )

            with mock.patch.object(ha.subprocess, "run", return_value=completed):
                result = ha.auto_push_archive_core(
                    root, archive, change_key="change-indexing"
                )

            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("uploadStatus"), "pending")
            self.assertEqual(
                result.get("reasonCode"), "ARCHIVE_KNOWLEDGE_INDEXING"
            )
            self.assertTrue(Path(str(result["packagePath"])).is_file())
            receipt_path = Path(str(result["pending"]))
            self.assertTrue(receipt_path.is_file())
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["uploadStatus"], "pending")
            self.assertEqual(receipt["knowledgeStatus"], "indexing")

    def test_success_exit_with_invalid_cli_receipt_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = _seed_core_archive(root, "change-invalid-receipt")
            _write_local_credentials(root)
            completed = subprocess.CompletedProcess(
                [], 0, stdout="not-json", stderr=""
            )

            with mock.patch.object(ha.subprocess, "run", return_value=completed):
                result = ha.auto_push_archive_core(
                    root, archive, change_key="change-invalid-receipt"
                )

            self.assertFalse(result.get("ok"))
            self.assertEqual(result.get("uploadStatus"), "pending")
            self.assertEqual(
                result.get("reasonCode"), "ARCHIVE_UPLOAD_RECEIPT_INVALID"
            )
            self.assertTrue(Path(str(result["packagePath"])).is_file())
            self.assertTrue(Path(str(result["pending"])).is_file())

    def test_unsafe_receipt_path_keeps_zip_without_crashing_finalize(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = _seed_core_archive(root, "change-unsafe-receipt")
            original_check = ha._require_archive_project_path

            def reject_receipt(*args: object, **kwargs: object) -> Path:
                if kwargs.get("label") == "archive upload receipt":
                    raise ValueError("receipt path became unsafe")
                return original_check(*args, **kwargs)  # type: ignore[arg-type]

            with mock.patch.object(
                ha, "_require_archive_project_path", side_effect=reject_receipt
            ):
                try:
                    result = ha.auto_push_archive_core(
                        root, archive, change_key="change-unsafe-receipt"
                    )
                except ValueError as exc:
                    self.fail(f"receipt path failure escaped auto-push: {exc}")

            self.assertFalse(result.get("ok"))
            self.assertEqual(
                result.get("reasonCode"), "ARCHIVE_UPLOAD_RECEIPT_PATH_UNSAFE"
            )
            self.assertTrue(Path(str(result["packagePath"])).is_file())

    def test_finalize_knowledge_mapping_keeps_indexing_pending(self) -> None:
        self.assertTrue(hasattr(ha, "_knowledge_maintenance_from_archive_push"))
        if not hasattr(ha, "_knowledge_maintenance_from_archive_push"):
            return
        self.assertEqual(
            ha._knowledge_maintenance_from_archive_push(
                {"archiveStatus": "durable", "knowledgeStatus": "indexing"}
            ),
            "REMOTE_PENDING",
        )
        self.assertEqual(
            ha._knowledge_maintenance_from_archive_push(
                {"archiveStatus": "durable", "knowledgeStatus": "failed"}
            ),
            "REMOTE_INDEX_FAILED",
        )


if __name__ == "__main__":
    unittest.main()
