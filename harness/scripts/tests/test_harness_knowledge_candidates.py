#!/usr/bin/env python3
"""Tests for knowledge candidate generation from summary-data.json.

The mapping is fixed by docs/superpowers/specs/2026-08-18-three-views-data-flow-design.md
("知识来源的选定"): only reviewFindings with disposition FIXED / ACCEPTED_RISK /
DEFERRED and knownRisks[] become candidates. Everything else is dropped, and every
emitted field is derived from real summary-data content — nothing is invented.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_knowledge_candidates as hkc  # noqa: E402


SUMMARY = {
    "changeName": "usage-stats-cli-reporting",
    "baseCommit": "54a1f26fb33695d2d0e6c06e9d1743bd17115169",
    "finalCommit": "aa1f26fb33695d2d0e6c06e9d1743bd171151690",
    "finalStatus": "WARN",
    "reviewFindings": [
        {
            "id": "F-001",
            "severity": "RED",
            "path": "packages/contracts/src/content-sync.ts",
            "line": 1051,
            "title": "nonScannablePathPrefixes 把整棵归档树判为不可扫描",
            "disposition": "FIXED",
        },
        {
            "id": "F-002",
            "severity": "YELLOW",
            "path": "apps/server/src/project-materials/pg-source.ts",
            "line": 316,
            "title": "current() 锚点依赖 latest_project_version",
            "disposition": "ACCEPTED_RISK",
        },
        {
            "id": "F-003",
            "severity": "YELLOW",
            "path": "packages/cli/src/commands/sync.ts",
            "line": 42,
            "title": "planSyncPush 放行 WARN",
            "disposition": "DEFERRED",
        },
        # dropped: severity OK
        {
            "id": "F-004",
            "severity": "OK",
            "path": "packages/cli/src/bin.ts",
            "line": 420,
            "title": "组合根接线正确",
            "disposition": "FIXED",
        },
        # dropped: NOT_APPLICABLE
        {
            "id": "F-005",
            "severity": "RED",
            "path": "apps/web/src/page.tsx",
            "line": 7,
            "title": "不适用的维度",
            "disposition": "NOT_APPLICABLE",
        },
        # dropped: OPEN / UNKNOWN are not in the adopted mapping table
        {
            "id": "F-006",
            "severity": "RED",
            "path": "apps/server/src/app.ts",
            "line": 2886,
            "title": "尚未裁决",
            "disposition": "OPEN",
        },
    ],
    "knownRisks": [
        {"phase": "archive", "severity": "warning", "message": "归档包缺少候选文件"},
    ],
    # must never become candidates (spec: 信噪比过低 / 无知识价值 / 无数据)
    "maintenanceNotes": ["阶段 3 采用 executionMode=inline"],
    "finalStatusReasons": ["stage run=WARN"],
    "manualActions": [],
}


def build(summary=None):
    return hkc.build_knowledge_candidates(
        summary if summary is not None else SUMMARY,
        change_key="usage-stats-cli-reporting",
        archive_id="usage-stats-cli-reporting",
        producer_version="0.2.85",
        created_at="2026-08-18T12:00:00.000Z",
    )


class MappingTableTests(unittest.TestCase):
    def test_only_adopted_sources_become_candidates(self) -> None:
        candidates = build()
        titles = [item["summary"] for item in candidates]
        self.assertEqual(len(candidates), 4, titles)
        self.assertIn("nonScannablePathPrefixes 把整棵归档树判为不可扫描", titles)
        self.assertIn("归档包缺少候选文件", titles)
        for dropped in ("组合根接线正确", "不适用的维度", "尚未裁决"):
            self.assertNotIn(dropped, titles)
        for dropped in ("阶段 3 采用 executionMode=inline", "stage run=WARN"):
            self.assertNotIn(dropped, titles)

    def test_entry_type_and_confidence_follow_the_table(self) -> None:
        by_title = {item["summary"]: item for item in build()}
        fixed_red = by_title["nonScannablePathPrefixes 把整棵归档树判为不可扫描"]
        self.assertEqual(fixed_red["entry_type"], "pitfall")
        self.assertEqual(fixed_red["confidence"], 0.95)

        accepted_yellow = by_title["current() 锚点依赖 latest_project_version"]
        self.assertEqual(accepted_yellow["entry_type"], "risk")
        self.assertEqual(accepted_yellow["confidence"], 0.85)

        deferred_yellow = by_title["planSyncPush 放行 WARN"]
        self.assertEqual(deferred_yellow["entry_type"], "risk")
        self.assertEqual(deferred_yellow["confidence"], 0.85)

        known_risk = by_title["归档包缺少候选文件"]
        self.assertEqual(known_risk["entry_type"], "risk")
        self.assertEqual(known_risk["confidence"], 0.85)

    def test_every_confidence_clears_the_extractor_threshold(self) -> None:
        # extractor.ts:12 auto-admits at >= 0.82; quality comes from the
        # OK/NOT_APPLICABLE filter, not from the threshold.
        for item in build():
            self.assertGreaterEqual(item["confidence"], 0.82)

    def test_body_and_keywords_are_derived_from_real_fields(self) -> None:
        by_title = {item["summary"]: item for item in build()}
        finding = by_title["nonScannablePathPrefixes 把整棵归档树判为不可扫描"]
        self.assertIn("nonScannablePathPrefixes", finding["body"])
        self.assertIn("packages/contracts/src/content-sync.ts:1051", finding["body"])
        self.assertIn("RED", finding["body"])
        self.assertIn("FIXED", finding["body"])
        # file name + parent directory + severity + disposition, all real values
        self.assertIn("content-sync.ts", finding["keywords"])
        self.assertIn("src", finding["keywords"])
        self.assertIn("RED", finding["keywords"])
        self.assertIn("FIXED", finding["keywords"])

    def test_source_refs_and_provenance_point_at_the_real_origin(self) -> None:
        by_title = {item["summary"]: item for item in build()}
        finding = by_title["planSyncPush 放行 WARN"]
        self.assertEqual(finding["source_refs"], ["packages/cli/src/commands/sync.ts#L42"])
        self.assertEqual(finding["provenance"]["source_kind"], "review")
        self.assertEqual(finding["provenance"]["producer_version"], "0.2.85")

        risk = by_title["归档包缺少候选文件"]
        self.assertEqual(risk["source_refs"], ["archive:usage-stats-cli-reporting"])
        self.assertEqual(risk["provenance"]["source_kind"], "archive")

    def test_reusability_scope_comes_from_path_or_phase(self) -> None:
        by_title = {item["summary"]: item for item in build()}
        self.assertEqual(
            by_title["nonScannablePathPrefixes 把整棵归档树判为不可扫描"]["reusability_scope"],
            "packages",
        )
        self.assertEqual(by_title["归档包缺少候选文件"]["reusability_scope"], "archive")

    def test_output_is_deterministic_and_ids_are_stable(self) -> None:
        first = build()
        second = build()
        self.assertEqual(first, second)
        ids = [item["candidate_id"] for item in first]
        self.assertEqual(len(set(ids)), len(ids))
        for candidate_id in ids:
            self.assertRegex(candidate_id, r"^kc_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$")
        for item in first:
            self.assertRegex(item["content_hash"], r"^sha256:[a-f0-9]{64}$")

    def test_empty_and_malformed_input_yields_no_candidates(self) -> None:
        self.assertEqual(build({}), [])
        self.assertEqual(build({"reviewFindings": None, "knownRisks": None}), [])
        self.assertEqual(build({"reviewFindings": ["not-a-dict"]}), [])
        self.assertEqual(build({"knownRisks": [{"severity": "warning"}]}), [])
        # a finding with no title carries no knowledge
        self.assertEqual(
            build({"reviewFindings": [
                {"severity": "RED", "disposition": "FIXED", "path": "a.ts", "title": "  "}
            ]}),
            [],
        )

    def test_matches_the_committed_cross_language_fixture(self) -> None:
        # packages/contracts/test/content-sync-contracts.test.ts parses this same
        # file against knowledgeCandidateSchema. Locking it on both sides means a
        # drift in either language breaks a test instead of silently shipping.
        fixture = (
            SCRIPTS_DIR.parents[1]
            / "packages" / "contracts" / "test" / "fixtures"
            / "knowledge-candidates-v1-archive.json"
        )
        committed = json.loads(fixture.read_text(encoding="utf-8"))
        self.assertEqual(build(), committed)

    def test_serializes_as_a_json_array(self) -> None:
        payload = hkc.render_knowledge_candidates_json(build())
        parsed = json.loads(payload)
        self.assertIsInstance(parsed, list)
        self.assertEqual(len(parsed), 4)
        self.assertTrue(payload.endswith("\n"))


class ArchiveWiringTests(unittest.TestCase):
    """The generator is worthless unless its output reaches the package."""

    def test_write_knowledge_candidates_lands_in_the_core_package(self) -> None:
        import tempfile

        import harness_archive as ha

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "usage-stats-cli-reporting"
            (archive / "reports" / "final").mkdir(parents=True)
            (archive / "meta").mkdir(parents=True)
            (archive / "reports" / "final" / "summary-data.json").write_text(
                json.dumps(SUMMARY, ensure_ascii=False), encoding="utf-8"
            )
            (archive / "meta" / "archive-meta.md").write_text("# m\n", encoding="utf-8")

            out = ha.write_knowledge_candidates(archive, SUMMARY)
            self.assertEqual(out, archive / "candidates" / "knowledge.json")

            written = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(len(written), 4)
            self.assertEqual(
                {item["entry_type"] for item in written}, {"pitfall", "risk"}
            )

            paths = ha.collect_archive_core_paths(root, archive)
            self.assertIn("candidates/knowledge.json", "\n".join(paths))

    def test_archive_without_findings_still_writes_an_empty_array(self) -> None:
        import tempfile

        import harness_archive as ha

        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / ".harness" / "archive" / "quiet-change"
            archive.mkdir(parents=True)
            out = ha.write_knowledge_candidates(archive, {"changeName": "quiet-change"})
            self.assertEqual(json.loads(out.read_text(encoding="utf-8")), [])


if __name__ == "__main__":
    unittest.main()
