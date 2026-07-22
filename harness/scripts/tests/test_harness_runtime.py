#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_module("harness_runtime", "harness_runtime.py")


class RuntimeDoctorTests(unittest.TestCase):
    def test_doctor_uses_absolute_current_python_when_path_lookup_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            runtime.shutil, "which", return_value=None
        ):
            root = Path(tmp)
            change_dir = root / ".harness" / "changes" / "demo"

            result = runtime.doctor(root, change_dir, agent="codex")

            python = result["runtimes"]["python"]
            self.assertTrue(Path(python["executable"]).is_absolute())
            self.assertEqual(python["argvPrefix"], [python["executable"]])
            self.assertEqual(result["adapter"]["worktreeRoot"], ".worktrees")
            self.assertEqual(result["adapter"]["branchPrefix"], "harness/")
            capsule = json.loads(
                (change_dir / "meta" / "runtime.json").read_text(encoding="utf-8")
            )
            self.assertEqual(capsule["schemaVersion"], 1)
            self.assertTrue(capsule["capabilities"]["jsonRoundTrip"])

    def test_powershell_51_probe_never_uses_test_json(self) -> None:
        calls: list[list[str]] = []

        def fake_run(argv, **_kwargs):
            calls.append(list(argv))
            return subprocess.CompletedProcess(
                argv,
                0,
                stdout='{"edition":"Desktop","version":"5.1.19041.5608"}',
                stderr="",
            )

        result = runtime.probe_powershell(
            Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
            runner=fake_run,
        )

        self.assertEqual(result["edition"], "Desktop")
        self.assertTrue(result["version"].startswith("5.1"))
        self.assertNotIn("Test-Json", " ".join(calls[0]))
        self.assertEqual(result["jsonCapability"], "convert-to-json")

    def test_adapter_worktree_contract_is_unified_across_agents(self) -> None:
        expected = {
            "worktreeRoot": ".worktrees",
            "path": ".worktrees/runtime-plan",
            "branchPrefix": "harness/",
            "branch": "harness/runtime-plan",
        }
        for agent in ("codex", "claude-code", "cursor", "codebuddy"):
            result = runtime.adapter_worktree(agent, "runtime-plan")
            self.assertEqual(result["agent"], agent)
            for key, value in expected.items():
                self.assertEqual(result[key], value, f"{agent}.{key}")

    def test_adapter_worktree_all_agents_share_path_and_branch(self) -> None:
        results = [
            runtime.adapter_worktree(agent, "same-change")
            for agent in ("codex", "claude-code", "cursor", "codebuddy")
        ]
        paths = {r["path"] for r in results}
        branches = {r["branch"] for r in results}
        self.assertEqual(paths, {".worktrees/same-change"})
        self.assertEqual(branches, {"harness/same-change"})
        agents = {r["agent"] for r in results}
        self.assertEqual(agents, {"codex", "claude-code", "cursor", "codebuddy"})

    def test_adapter_rejects_path_like_change_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "ADAPTER_CHANGE_ID_INVALID"):
            runtime.adapter_worktree("codex", "../escape")


if __name__ == "__main__":
    unittest.main()
