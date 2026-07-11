#!/usr/bin/env python3
"""Unittests for harness_acceptance.py (REMEDIATION-DESIGN §9).

Verifies the acceptance numbers are computed from this run, not hand-filled.
Does not re-run the full suite (that is Gate 7's `harness_acceptance.py run`);
instead it cross-checks each computed stat against an independent calculation.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SCRIPTS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_acceptance as ha  # noqa: E402
import harness_deploy as hd  # noqa: E402


class AcceptanceStatsRealTests(unittest.TestCase):
    """The acceptance stats must come from real computation, not hand-filled."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-accept-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_skill_counts_match_independent_build_count(self) -> None:
        # generic build skill count
        generic = self.tmp / "generic"
        hd.cmd_build(SKILLS_ROOT, generic, None)
        independent_generic = len(list(generic.glob("harness-*/SKILL.md")))
        self.assertEqual(ha.count_skills(generic), independent_generic)

        java = self.tmp / "java"
        hd.cmd_build(SKILLS_ROOT, java, "java")
        independent_java = len(list(java.glob("harness-*/SKILL.md")))
        self.assertEqual(ha.count_skills(java), independent_java)
        # §9.3: Java overlay is 12 skills, not 15
        self.assertEqual(independent_java, 12)

    def test_source_skill_lines_are_real_disk_values(self) -> None:
        lines = ha.source_skill_lines(SKILLS_ROOT)
        self.assertTrue(lines, "source_skill_lines must return real skills")
        for name, count in lines.items():
            self.assertIsInstance(count, int)
            self.assertGreater(count, 0, f"{name} has non-positive line count")
            # independent re-count
            actual = len((SKILLS_ROOT / name / "SKILL.md").read_text(encoding="utf-8").splitlines())
            self.assertEqual(count, actual, f"{name} line count mismatch")

    def test_scan_forbidden_detects_and_reports_clean(self) -> None:
        generic = self.tmp / "generic"
        hd.cmd_build(SKILLS_ROOT, generic, None)
        scan = ha.scan_forbidden(generic)
        # a clean runtime build has no forbidden patterns / UDP tokens
        self.assertEqual(scan["forbiddenPatterns"], [], msg=scan)
        self.assertEqual(scan["udpTokens"], [], msg=scan)
        self.assertTrue(scan["clean"])

    def test_collect_file_hashes_detects_byte_identity(self) -> None:
        a = self.tmp / "a"
        b = self.tmp / "b"
        hd.cmd_build(SKILLS_ROOT, a, None)
        hd.cmd_build(SKILLS_ROOT, b, None)
        self.assertEqual(ha.collect_file_hashes(a), ha.collect_file_hashes(b))
        # tamper one file -> hashes differ
        skill = next(a.glob("harness-*/SKILL.md"))
        skill.write_text(skill.read_text(encoding="utf-8") + "\n# tampered\n", encoding="utf-8")
        self.assertNotEqual(ha.collect_file_hashes(a), ha.collect_file_hashes(b))

    def test_unitTestFull_cli_is_parseable(self) -> None:
        result = ha.check_unittest_full_cli(SKILLS_ROOT)
        self.assertTrue(result["ok"], msg=result)
        self.assertTrue(result["parseable"])

    def test_run_acceptance_structure_and_archive_immutable(self) -> None:
        # Structure + overall logic without re-running the full suite (which
        # would recurse: run_acceptance -> discover test_harness_*.py -> this
        # test). Patch run_unittest to a fast fake; builds stay real so
        # skillCounts/forbiddenPatterns are still computed from this run.
        from unittest import mock

        fake = {"ran": 1, "ok": True, "exitCode": 0, "tail": ["OK"]}
        before = ha.archive_hash(SKILLS_ROOT)
        with mock.patch.object(ha, "run_unittest", return_value=fake):
            report = ha.run_acceptance(SKILLS_ROOT, None)
        for key in (
            "schemaVersion",
            "overall",
            "tests",
            "skillCounts",
            "skillLines",
            "buildDeterminism",
            "forbiddenPatterns",
            "unitTestFull",
            "gitDiffCheck",
            "goldenReplay",
            "realProjectE2E",
            "d13",
            "generatedAt",
        ):
            self.assertIn(key, report, f"missing key: {key}")
        self.assertIn(report["overall"], {"PASS", "CONDITIONAL", "FAIL"})
        self.assertTrue(report["generatedAt"], "generatedAt must be present in report JSON")
        # skillCounts are real (build_once is not patched)
        generic = self.tmp / "g"
        hd.cmd_build(SKILLS_ROOT, generic, None)
        self.assertEqual(report["skillCounts"]["core"], len(list(generic.glob("harness-*/SKILL.md"))))
        # archive must not be mutated
        self.assertFalse(report["archiveMutated"], "acceptance must not modify .harness/archive/**")
        self.assertEqual(before, ha.archive_hash(SKILLS_ROOT))


if __name__ == "__main__":
    unittest.main()
