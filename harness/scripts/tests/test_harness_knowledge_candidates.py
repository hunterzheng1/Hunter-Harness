#!/usr/bin/env python3
"""Tests for knowledge candidate generation from summary-data.json.

The mapping is fixed by docs/superpowers/specs/2026-08-18-three-views-data-flow-design.md
("知识来源的选定"), extended 2026-08-23: reviewFindings with disposition FIXED /
ACCEPTED_RISK / DEFERRED, knownRisks[], and adopted decisions[] become candidates.
Everything else is dropped, and every emitted field is derived from real
summary-data content — nothing is invented.
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

    def test_counts_only_unadjudicated_knowledge_carrying_findings(self) -> None:
        # SUMMARY 里只有 F-006（RED + OPEN）是未裁决且带知识严重度的；
        # F-005 虽 RED 但已裁决为 NOT_APPLICABLE，F-004 已裁决 FIXED。
        self.assertEqual(hkc.count_unadjudicated_findings(SUMMARY), 1)
        self.assertEqual(hkc.count_unadjudicated_findings({}), 0)
        self.assertEqual(hkc.count_unadjudicated_findings({"reviewFindings": None}), 0)
        self.assertEqual(
            hkc.count_unadjudicated_findings({"reviewFindings": [
                {"severity": "YELLOW", "disposition": "UNKNOWN", "title": "x"},
                {"severity": "RED", "title": "缺 disposition 等同未裁决"},
                {"severity": "OK", "disposition": "OPEN", "title": "OK 不带知识"},
                "not-a-dict",
            ]}),
            2,
        )

    def test_serializes_as_a_json_array(self) -> None:
        payload = hkc.render_knowledge_candidates_json(build())
        parsed = json.loads(payload)
        self.assertIsInstance(parsed, list)
        self.assertEqual(len(parsed), 4)
        self.assertTrue(payload.endswith("\n"))


DECISIONS = [
    {
        "id": "D-001",
        "title": "归档候选生成零 LLM，仅做确定性投影",
        "rationale": "可复现、无幻觉、无成本；筛选在上游完成。",
        "entry_type": "decision",
        "status": "adopted",
        "path": "docs/design/knowledge.md",
        "line": 42,
        "keywords": ["零 LLM", "确定性"],
        "source": "plan",
    },
    {
        "id": "D-002",
        "title": "summary 的 stageStatus 必须含 run/test 键",
        "rationale": "服务端 CLI schema 2.3 的必需键。",
        "entry_type": "requirement",
        "status": "adopted",
        "path": "docs/contracts/summary-schema.md",
        "source": "review",
    },
    {
        "id": "D-003",
        "title": "尚未采纳的提案",
        "entry_type": "decision",
        "status": "proposed",
    },
    {
        "id": "D-004",
        "title": "已被否决的做法",
        "entry_type": "decision",
        "status": "rejected",
    },
    {
        "id": "D-005",
        "title": "非法 entry_type",
        "entry_type": "pitfall",
        "status": "adopted",
    },
]


class DecisionSourceTests(unittest.TestCase):
    def build(self, decisions):
        return hkc.build_knowledge_candidates(
            {"decisions": decisions},
            change_key="decisions-demo",
            archive_id="decisions-demo",
            producer_version="0.4.0",
            created_at="2026-08-23T12:00:00.000Z",
        )

    def test_only_adopted_decisions_become_candidates(self) -> None:
        candidates = self.build(DECISIONS)
        titles = [item["summary"] for item in candidates]
        self.assertEqual(titles, [
            "归档候选生成零 LLM，仅做确定性投影",
            "summary 的 stageStatus 必须含 run/test 键",
        ])

    def test_entry_type_and_provenance_come_from_the_record(self) -> None:
        by_title = {item["summary"]: item for item in self.build(DECISIONS)}
        decision = by_title["归档候选生成零 LLM，仅做确定性投影"]
        self.assertEqual(decision["entry_type"], "decision")
        self.assertEqual(decision["confidence"], 0.85)
        self.assertEqual(decision["provenance"]["source_kind"], "plan")
        self.assertEqual(decision["provenance"]["source_ref"], "archive:decisions-demo#D-001")
        self.assertEqual(decision["source_refs"], ["docs/design/knowledge.md#L42"])
        self.assertEqual(decision["reusability_scope"], "docs")
        self.assertIn("零 LLM", decision["keywords"])
        self.assertIn("decision", decision["keywords"])
        requirement = by_title["summary 的 stageStatus 必须含 run/test 键"]
        self.assertEqual(requirement["entry_type"], "requirement")
        self.assertEqual(requirement["provenance"]["source_kind"], "review")
        self.assertEqual(requirement["source_refs"], ["docs/contracts/summary-schema.md"])

    def test_output_is_deterministic(self) -> None:
        first = self.build(DECISIONS)
        self.assertEqual(first, self.build(DECISIONS))
        for item in first:
            self.assertRegex(item["candidate_id"], r"^kc_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$")
            self.assertRegex(item["content_hash"], r"^sha256:[a-f0-9]{64}$")

    def test_missing_source_defaults_to_plan_and_no_path_to_archive_ref(self) -> None:
        candidates = self.build([{
            "title": "无溯源字段的决策",
            "entry_type": "decision",
            "status": "adopted",
        }])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["provenance"]["source_kind"], "plan")
        self.assertEqual(candidates[0]["source_refs"], ["archive:decisions-demo"])
        self.assertEqual(candidates[0]["reusability_scope"], "project")


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

    def test_load_change_decisions_validates_and_counts_drops(self) -> None:
        import tempfile

        import harness_archive as ha

        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / ".harness" / "changes" / "decisions-demo"
            evidence = change / "evidence"
            evidence.mkdir(parents=True)

            # 缺失文件 → 无决策、无丢弃
            self.assertEqual(ha.load_change_decisions(change), ([], 0))

            (evidence / "decisions.json").write_text(
                json.dumps({
                    "schema_version": 1,
                    "decisions": [
                        DECISIONS[0],
                        DECISIONS[2],  # proposed：合法但不成候选
                        {"title": "缺 entry_type"},
                        {"title": "越界路径", "entry_type": "decision",
                         "status": "adopted", "path": "../escape.md"},
                    ],
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            valid, dropped = ha.load_change_decisions(change)
            self.assertEqual([item["id"] for item in valid], ["D-001", "D-003"])
            self.assertEqual(dropped, 2)

            # 版本不符 → 视为没有决策
            (evidence / "decisions.json").write_text(
                json.dumps({"schema_version": 99, "decisions": [DECISIONS[0]]}),
                encoding="utf-8",
            )
            self.assertEqual(ha.load_change_decisions(change), ([], 0))

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
