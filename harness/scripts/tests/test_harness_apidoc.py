from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_apidoc.py"
SPEC = importlib.util.spec_from_file_location("harness_apidoc", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
apidoc = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = apidoc
SPEC.loader.exec_module(apidoc)


class ApiDocFilenameTests(unittest.TestCase):
    def test_filename_keeps_readable_chinese_and_removes_windows_invalid_chars(self) -> None:
        self.assertEqual(
            apidoc.build_filename("新增/更新:贡献积分接口?", date="2026-07-16"),
            "2026-07-16-新增-更新-贡献积分接口.md",
        )

    def test_filename_is_bounded_and_never_commit_hash_only(self) -> None:
        name = apidoc.build_filename("a" * 120, date="2026-07-16")
        self.assertLessEqual(len(name), 100)
        with self.assertRaisesRegex(ValueError, "description"):
            apidoc.build_filename("9d05b19a90f1e3cd1e13057bc12f3fead2c00659")


if __name__ == "__main__":
    unittest.main()
