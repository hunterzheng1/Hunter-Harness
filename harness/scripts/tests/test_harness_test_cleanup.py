#!/usr/bin/env python3
"""Tests for harness_test_cleanup.py (retro §5.23)."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cleanup_mod = load_module("harness_test_cleanup", "harness_test_cleanup.py")


class CleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self._root = Path(tempfile.mkdtemp(prefix="cleanup-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self._root, ignore_errors=True))

    def _make_files(self, root: Path, count: int) -> int:
        root.mkdir(parents=True, exist_ok=True)
        total = 0
        for i in range(count):
            (root / f"file-{i}.bin").write_bytes(b"x" * 100)
            total += 100
        return total

    def test_cleanup_succeeds_for_allowlisted_root(self) -> None:
        pytest_data = self._root / ".pytest_data"
        total_bytes = self._make_files(pytest_data, 5)
        result = cleanup_mod.cleanup(self._root, [".pytest_data"])
        self.assertTrue(result["ok"], msg=result)
        self.assertEqual(result["code"], "CLEANUP_COMPLETE")
        self.assertEqual(result["removedFiles"], 5)
        self.assertEqual(result["removedBytes"], total_bytes)
        self.assertFalse(pytest_data.exists())

    def test_cleanup_rejects_path_escape(self) -> None:
        result = cleanup_mod.cleanup(self._root, ["../escape"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PATH_ESCAPE_REJECTED")
        self.assertEqual(result["removedFiles"], 0)

    def test_cleanup_rejects_symlink_escape(self) -> None:
        if os.name == "nt":
            self.skipTest("symlink test skipped on Windows without admin")
        target = self._root / "outside"
        target.mkdir()
        (target / "secret.txt").write_text("secret", encoding="utf-8")
        link = self._root / ".pytest_data"
        os.symlink(target, link)
        result = cleanup_mod.cleanup(self._root, [".pytest_data"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "SYMLINK_ESCAPE_REJECTED")
        self.assertEqual(result["removedFiles"], 0)
        # Original target untouched
        self.assertTrue((target / "secret.txt").exists())

    def test_cleanup_idempotent_on_reentry(self) -> None:
        pytest_data = self._root / ".pytest_data"
        self._make_files(pytest_data, 3)
        first = cleanup_mod.cleanup(self._root, [".pytest_data"])
        self.assertTrue(first["ok"])
        second = cleanup_mod.cleanup(self._root, [".pytest_data"])
        self.assertTrue(second["ok"])
        self.assertEqual(second["code"], "ALREADY_ABSENT")
        self.assertEqual(second["removedFiles"], 0)


if __name__ == "__main__":
    unittest.main()
