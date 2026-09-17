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


class SourceRefBindingTests(unittest.TestCase):
    """source_refs 必须绑定真实仓库文件（服务端 ARCHIVE_CANDIDATE_SOURCE_UNBOUND
    同源规则）：目录/非法路径的候选直接跳过，不生成伪来源（2026-08-31 实测：
    `quality/#L1` 一条挡掉 42 条候选的整包）。"""

    def test_directory_ref_skips_the_candidate(self) -> None:
        finding = {
            "id": "f-5e6c7edd899d9b97",
            "title": "质量模块测试",
            "severity": "YELLOW",
            "disposition": "FIXED",
            "path": "backend/src/main/java/com/klerp/salesinsight/quality/",
            "line": 1,
        }
        self.assertIsNone(hkc._finding_candidate(
            finding,
            change_key="demo-datasource",
            archive_id="arc_x",
            producer_version="1",
            created_at="t",
        ))

    def test_valid_file_ref_is_kept_with_line_anchor(self) -> None:
        finding = {
            "id": "f-1",
            "title": "质量模块测试",
            "severity": "YELLOW",
            "disposition": "FIXED",
            "path": "backend/src/main/java/com/klerp/salesinsight/quality/QualityGate.java",
            "line": 1,
        }
        candidate = hkc._finding_candidate(
            finding,
            change_key="demo-datasource",
            archive_id="arc_x",
            producer_version="1",
            created_at="t",
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(
            candidate["source_refs"],
            ["backend/src/main/java/com/klerp/salesinsight/quality/QualityGate.java#L1"],
        )

    def test_missing_path_falls_back_to_archive_ref(self) -> None:
        finding = {
            "id": "f-1", "title": "t", "severity": "RED",
            "disposition": "FIXED", "path": "", "line": 0,
        }
        candidate = hkc._finding_candidate(
            finding,
            change_key="c", archive_id="arc_x",
            producer_version="1", created_at="t",
        )
        self.assertEqual(candidate["source_refs"], ["archive:arc_x"])

    def test_path_structure_validation(self) -> None:
        for bad in (
            "a\\b\\c.java", "/abs/path.java", "C:/x/y.java",
            "a//b.java", "a/../b.java", "./a.java", "dir/",
        ):
            self.assertIsNone(hkc._valid_source_path(bad), bad)
        self.assertEqual(
            hkc._valid_source_path("backend/src/Main.java"),
            "backend/src/Main.java",
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


class AssetMetadataTests(unittest.TestCase):
    """WI-E2（O3/O4）：候选记录携带资产元数据四键。

    契约（content-sync.ts knowledgeCandidateSchema）以 optional/nullable 增量
    接收这四键；生成期 validation_status 恒 unverified（事实派生），其余三键
    恒 None（空白不凑数——生成期无真实来源）。content_hash 不进这四键：
    hash 锁内容身份，元数据可独立演化。
    """

    _KEYS = ("applicable_versions", "validation_status", "supersedes", "expires_when")

    def _assert_asset_defaults(self, candidate: dict) -> None:
        for key in self._KEYS:
            self.assertIn(key, candidate, f"{candidate.get('summary')!r} 缺 {key}")
        self.assertEqual(candidate["validation_status"], "unverified")
        self.assertIsNone(candidate["applicable_versions"])
        self.assertIsNone(candidate["supersedes"])
        self.assertIsNone(candidate["expires_when"])

    def test_summary_derived_candidates_carry_asset_fields(self) -> None:
        candidates = build()
        self.assertEqual(len(candidates), 4)
        for candidate in candidates:
            self._assert_asset_defaults(candidate)

    def test_decision_candidates_carry_asset_fields(self) -> None:
        candidates = hkc.build_knowledge_candidates(
            {"decisions": [DECISIONS[0]]},
            change_key="decisions-demo",
            archive_id="decisions-demo",
            producer_version="0.4.0",
            created_at="2026-08-23T12:00:00.000Z",
        )
        self.assertEqual(len(candidates), 1)
        self._assert_asset_defaults(candidates[0])

    def test_plan_derived_candidates_carry_asset_fields(self) -> None:
        # 06B-4 起生产路径是 meta/plan-evidence-input.json 直采；
        # 旧 plans/*.md 反解析路径的等价覆盖见 PlanDesignExtractionTest。
        candidates = hkc.build_plan_candidates(
            _archive_dir_with_plan_evidence_input(_minimal_plan_evidence_input()),
            change_key="simple-mode-adoption",
            archive_id="arc_test",
            producer_version="1",
            created_at="2026-09-06T00:00:00.000Z",
        )
        self.assertGreater(len(candidates), 0)
        for candidate in candidates:
            self._assert_asset_defaults(candidate)

    def test_content_hash_ignores_asset_fields(self) -> None:
        # hash 只锁内容身份（entry_type/summary/body/keywords）；
        # F-001 的 hash 在加元数据前后必须逐字节一致。
        by_title = {item["summary"]: item for item in build()}
        self.assertEqual(
            by_title["nonScannablePathPrefixes 把整棵归档树判为不可扫描"]["content_hash"],
            "sha256:ac69cdb862059e882204a9574f5ac0fe226ae883ba37215758a0901e69d4255e",
        )

    def test_schema_version_stays_1(self) -> None:
        # 版本less 增量演化（entry_type/body/keywords 先例）：strict 契约的
        # 共享 schemaVersionSchema 钉死字面量 1，升版本会牵动全链 schema。
        for candidate in build():
            self.assertEqual(candidate["schema_version"], 1)


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

    def test_hostile_plan_evidence_input_does_not_break_summary_candidates(self) -> None:
        # 06B-4：meta/plan-evidence-input.json 非法 → 拒绝直采并记 warning，
        # 计划产物候选按空处理；summary 三源候选照常落盘，归档不中断。
        import tempfile

        import harness_archive as ha

        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / ".harness" / "archive" / "usage-stats-cli-reporting"
            (archive / "reports" / "final").mkdir(parents=True)
            (archive / "meta").mkdir(parents=True)
            (archive / "reports" / "final" / "summary-data.json").write_text(
                json.dumps(SUMMARY, ensure_ascii=False), encoding="utf-8"
            )
            (archive / "meta" / "plan-evidence-input.json").write_text(
                "{not json", encoding="utf-8"
            )

            out = ha.write_knowledge_candidates(archive, SUMMARY)
            written = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(len(written), 4)
            self.assertTrue(all("goal" not in item["keywords"] for item in written))


DESIGN_MD = """# {change}-design

## Goal

让用量上报在离线时也不丢失数据。

## Requirements

- requirement:req-001 [failure_behavior]: git/diff 失败跳过规模判定、不阻断 propose

## Risks

- 遥测失败可能拖慢命令
- Mitigation: 上报失败不阻断 commit

## Invariants

- None.

## Tradeoffs

- 否决独立 /opsx-quick-simple 入口，因为会制造第二入口、与现有流程分裂
- 采纳在既有 propose 流程内加 Simple 标记
- None.

## Compatibility boundaries

- 旧 proposal 没有 auto-scale 字段时不受影响
- None.
"""


class PlanDesignExtractionTest(unittest.TestCase):
    """旧 plans/*.md 反解析路径（dead code 回滚开关）的 design 章节提取。

    06B-4 起生产路径从 meta/plan-evidence-input.json 直采；本组测试用 md 夹具
    钉住回滚路径的输出，新旧路径的逐字段等价由 PlanEvidenceParityTest 保证。
    """

    def _extract(self) -> list[dict]:
        return hkc._build_plan_candidates_from_markdown(
            _archive_dir_with_design(),
            change_key="simple-mode-adoption",
            archive_id="arc_test",
            producer_version="1",
            created_at="2026-09-06T00:00:00.000Z",
        )

    def test_tradeoffs_become_decision_candidates(self) -> None:
        candidates = self._extract()
        tradeoffs = [c for c in candidates if c["entry_type"] == "decision"]
        self.assertEqual(len(tradeoffs), 2)
        self.assertIn("否决独立 /opsx-quick-simple 入口", tradeoffs[0]["summary"])
        self.assertEqual(tradeoffs[0]["body"], f"取舍：{tradeoffs[0]['summary']}")
        self.assertEqual(tradeoffs[0]["confidence"], hkc._PLAN_CONFIDENCE)
        self.assertTrue(all("None." not in c["summary"] for c in tradeoffs))

    def test_compatibility_boundaries_become_api_contract_candidates(self) -> None:
        candidates = self._extract()
        compat = [c for c in candidates if c["entry_type"] == "api-contract"]
        self.assertEqual(len(compat), 1)
        self.assertIn("旧 proposal 没有 auto-scale 字段时不受影响", compat[0]["summary"])
        self.assertEqual(compat[0]["keywords"], hkc._keywords("compatibility", "api-contract", "兼容"))

    def test_candidate_ids_stay_stable_across_runs(self) -> None:
        self.assertEqual(
            [c["candidate_id"] for c in self._extract()],
            [c["candidate_id"] for c in self._extract()],
        )


def _archive_dir_with_design() -> Path:
    import tempfile
    root = Path(tempfile.mkdtemp(prefix="hkc-plan-"))
    plans = root / "plans"
    plans.mkdir(parents=True)
    (plans / "simple-mode-adoption-design.md").write_text(
        DESIGN_MD.replace("{change}", "simple-mode-adoption"), encoding="utf-8"
    )
    return root


# ---------------------------------------------------------------------------
# 06B-4：meta/plan-evidence-input.json 直采（聚焦测试冻结字段映射表）
# ---------------------------------------------------------------------------

_PARITY_REQUIREMENT_TEXT = "git/diff 失败跳过规模判定、不阻断 propose"

# 与 _parity_plan_evidence_input() 逐条等价的 md 三件套（单值列表天然满足
# codepoint 排序，多值的 tasks/scenarios 两条路径都保序）。
PARITY_DESIGN_MD = """# parity-change-design

## Goal

让用量上报在离线时也不丢失数据。

## User-visible outcome

离线期间的数据在恢复连接后自动补报。

## Requirements

- requirement:req-001 [failure_behavior]: git/diff 失败跳过规模判定、不阻断 propose

## Risks

- 遥测失败可能拖慢命令
- Mitigation: 上报失败不阻断 commit

## Invariants

- 上报失败不影响主命令退出码

## Tradeoffs

- 否决独立入口，因为会制造第二入口

## Compatibility boundaries

- 旧 proposal 没有 auto-scale 字段时不受影响
"""

PARITY_PLAN_MD = """# parity-change-plan

## Tasks

### T1

搭建项目骨架

### T2

实现加法与单元测试
"""

PARITY_TEST_SCENARIOS_MD = """# parity-change-test-scenarios

## S1: 加法结果正确

## S2: 除零给出明确错误
"""


def _parity_plan_evidence_input() -> dict:
    """与 PARITY_*_MD 三件套逐条等价（外加 intent.goal，验证优先级）。"""
    return {
        "intent": {"goal": "intent 里的目标，应被 approval.content.goal 覆盖"},
        "approval": {
            "content": {
                "goal": "让用量上报在离线时也不丢失数据。",
                "user_visible_outcome": "离线期间的数据在恢复连接后自动补报。",
                "risks": [
                    {"risk": "遥测失败可能拖慢命令", "mitigation": "上报失败不阻断 commit"},
                ],
                "invariants": ["上报失败不影响主命令退出码"],
                "key_alternatives": ["否决独立入口，因为会制造第二入口"],
                "compatibility_boundaries": ["旧 proposal 没有 auto-scale 字段时不受影响"],
            }
        },
        "structured_input": {
            "requirements": [
                {
                    "requirement_id": "req-001",
                    "kind": "failure_behavior",
                    "text": _PARITY_REQUIREMENT_TEXT,
                }
            ],
            "tasks": [
                {"task_id": "T1", "objective": "搭建项目骨架"},
                {"task_id": "T2", "objective": "实现加法与单元测试"},
            ],
            "scenarios": [
                {"scenario_id": "S1", "title": "加法结果正确"},
                {"scenario_id": "S2", "title": "除零给出明确错误"},
            ],
        },
    }


def _minimal_plan_evidence_input() -> dict:
    return {
        "approval": {
            "content": {
                "goal": "让离线用量不丢失。",
                "risks": [{"risk": "遥测失败拖慢命令", "mitigation": "不阻断 commit"}],
            }
        },
        "structured_input": {"tasks": [{"task_id": "T1", "objective": "搭建骨架"}]},
    }


def _archive_dir_with_plan_evidence_input(payload, *, raw: str | None = None) -> Path:
    import tempfile
    root = Path(tempfile.mkdtemp(prefix="hkc-pei-"))
    meta = root / "meta"
    meta.mkdir(parents=True)
    text = raw if raw is not None else json.dumps(payload, ensure_ascii=False)
    (meta / "plan-evidence-input.json").write_text(text, encoding="utf-8")
    return root


def _archive_dir_with_parity_markdown() -> Path:
    import tempfile
    root = Path(tempfile.mkdtemp(prefix="hkc-parity-md-"))
    plans = root / "plans"
    plans.mkdir(parents=True)
    (plans / "parity-change-design.md").write_text(PARITY_DESIGN_MD, encoding="utf-8")
    (plans / "parity-change-plan.md").write_text(PARITY_PLAN_MD, encoding="utf-8")
    (plans / "parity-change-test-scenarios.md").write_text(
        PARITY_TEST_SCENARIOS_MD, encoding="utf-8"
    )
    return root


_PLAN_KWARGS = {
    "archive_id": "arc_test",
    "producer_version": "1",
    "created_at": "2026-09-17T00:00:00.000Z",
}


def _direct_candidates(payload=None, *, change_key: str = "parity-change") -> list[dict]:
    return hkc.build_plan_candidates(
        _archive_dir_with_plan_evidence_input(
            _parity_plan_evidence_input() if payload is None else payload
        ),
        change_key=change_key,
        **_PLAN_KWARGS,
    )


class PlanEvidenceInputExtractionTest(unittest.TestCase):
    """06B-4 冻结映射表：JSON 直采的各类别映射。"""

    def test_goal_prefers_approval_content_and_appends_outcome(self) -> None:
        candidates = _direct_candidates()
        goals = [c for c in candidates if c["keywords"] == ["目标", "goal", "requirement"]]
        self.assertEqual(len(goals), 1)
        goal = goals[0]
        self.assertEqual(goal["summary"], "让用量上报在离线时也不丢失数据。")
        self.assertEqual(
            goal["body"],
            "目标：让用量上报在离线时也不丢失数据。\n"
            "用户可见结果：离线期间的数据在恢复连接后自动补报。",
        )
        self.assertEqual(goal["entry_type"], "requirement")
        self.assertEqual(goal["source_refs"], ["plans/parity-change-design.md"])

    def test_goal_falls_back_to_intent(self) -> None:
        candidates = _direct_candidates({"intent": {"goal": "意图目标"}})
        self.assertEqual([c["summary"] for c in candidates], ["意图目标"])
        self.assertEqual(candidates[0]["body"], "目标：意图目标")

    def test_requirements_are_sorted_by_kind_then_id(self) -> None:
        payload = {
            "structured_input": {
                "requirements": [
                    {"requirement_id": "REQ-B", "kind": "failure_behavior", "text": "失败行为乙"},
                    {"requirement_id": "REQ-C", "kind": "behavior", "text": "行为丙"},
                    {"requirement_id": "REQ-D", "kind": "invariant", "text": "不变量丁"},
                    {"requirement_id": "REQ-A", "kind": "behavior", "text": "行为甲"},
                ]
            }
        }
        candidates = _direct_candidates(payload)
        self.assertEqual(
            [(c["body"].splitlines()[0], c["summary"]) for c in candidates],
            [
                ("需求类型：behavior", "行为甲"),
                ("需求类型：behavior", "行为丙"),
                ("需求类型：invariant", "不变量丁"),
                ("需求类型：failure_behavior", "失败行为乙"),
            ],
        )

    def test_requirements_derive_from_content_when_key_missing(self) -> None:
        payload = {
            "approval": {
                "content": {
                    "recommended_design": "推荐设计",
                    "invariants": ["乙不变量", "甲不变量"],
                    "failure_behaviors": ["失败乙", "失败甲"],
                }
            }
        }
        candidates = _direct_candidates(payload)
        # codepoint 排序：乙(U+4E59) < 甲(U+7532)。推导的 invariant 候选与
        # _invariant_candidates_pei 从同一 approval.content.invariants 独立产出
        # 的 invariant 候选内容相同、candidate_id 不同（kind 不同）——与 CLI
        # 渲染时代「Requirements 节 + Invariants 节」同源双写的预期一致。
        self.assertEqual(
            [(c["body"].splitlines()[0], c["summary"]) for c in candidates],
            [
                ("需求类型：behavior", "推荐设计"),
                ("需求类型：invariant", "乙不变量"),
                ("需求类型：invariant", "甲不变量"),
                ("需求类型：failure_behavior", "失败乙"),
                ("需求类型：failure_behavior", "失败甲"),
                ("需求类型：invariant", "乙不变量"),
                ("需求类型：invariant", "甲不变量"),
            ],
        )
        # 同源双写的两条 invariant 候选 candidate_id 必须不同（kind 命名空间隔离）。
        invariant_ids = [
            c["candidate_id"] for c in candidates if c["summary"] == "乙不变量"
        ]
        self.assertEqual(len(invariant_ids), 2)
        self.assertNotEqual(invariant_ids[0], invariant_ids[1])

    def test_risks_invariants_tradeoffs_compatibility_map_to_entry_types(self) -> None:
        candidates = _direct_candidates()
        by_summary = {c["summary"]: c for c in candidates}
        risk = by_summary["遥测失败可能拖慢命令"]
        self.assertEqual(risk["entry_type"], "risk")
        self.assertEqual(risk["body"], "遥测失败可能拖慢命令\n缓解：上报失败不阻断 commit")
        self.assertEqual(risk["keywords"], ["risk"])
        invariant = by_summary["上报失败不影响主命令退出码"]
        self.assertEqual(invariant["entry_type"], "requirement")
        self.assertEqual(invariant["body"], "需求类型：invariant\n上报失败不影响主命令退出码")
        self.assertEqual(invariant["keywords"], ["invariant", "requirement"])
        tradeoff = by_summary["否决独立入口，因为会制造第二入口"]
        self.assertEqual(tradeoff["entry_type"], "decision")
        self.assertEqual(tradeoff["body"], "取舍：否决独立入口，因为会制造第二入口")
        self.assertEqual(tradeoff["keywords"], ["tradeoff", "decision", "取舍"])
        compat = by_summary["旧 proposal 没有 auto-scale 字段时不受影响"]
        self.assertEqual(compat["entry_type"], "api-contract")
        self.assertEqual(compat["body"], "兼容边界：旧 proposal 没有 auto-scale 字段时不受影响")
        self.assertEqual(compat["keywords"], ["compatibility", "api-contract", "兼容"])

    def test_tasks_and_scenarios_map(self) -> None:
        candidates = _direct_candidates()
        tasks = [c for c in candidates if c["entry_type"] == "implementation"]
        self.assertEqual([c["summary"] for c in tasks], ["搭建项目骨架", "实现加法与单元测试"])
        self.assertEqual(tasks[0]["body"], "任务：T1\n搭建项目骨架")
        self.assertEqual(tasks[0]["keywords"], ["T1", "implementation"])
        self.assertEqual(tasks[0]["source_refs"], ["plans/parity-change-plan.md"])
        scenarios = [c for c in candidates if c["entry_type"] == "test-evidence"]
        self.assertEqual([c["summary"] for c in scenarios], ["加法结果正确", "除零给出明确错误"])
        self.assertEqual(scenarios[0]["body"], "场景：S1\n加法结果正确")
        self.assertEqual(scenarios[0]["keywords"], ["S1", "test-evidence"])
        self.assertEqual(
            scenarios[0]["source_refs"], ["plans/parity-change-test-scenarios.md"]
        )

    def test_empty_payload_yields_no_candidates(self) -> None:
        self.assertEqual(_direct_candidates({}), [])

    def test_every_candidate_is_deterministic_and_hash_stamped(self) -> None:
        first = _direct_candidates()
        second = _direct_candidates()
        self.assertEqual(first, second)
        for candidate in first:
            self.assertRegex(
                candidate["candidate_id"], r"^kc_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$"
            )
            self.assertRegex(candidate["content_hash"], r"^sha256:[a-f0-9]{64}$")
            self.assertEqual(candidate["confidence"], hkc._PLAN_CONFIDENCE)


class PlanEvidenceParityTest(unittest.TestCase):
    """新旧路径逐字段等价：md 反解析的全部候选必须与 JSON 直采一致。

    唯一例外：`_requirements_from_design` 的 kind 切片缺陷使旧路径从未产出
    requirement 候选（2026-09-17 实证登记）；06B-4 直采修复该缺陷，新增的
    requirement 候选单独断言。
    """

    def _legacy(self) -> list[dict]:
        return hkc._build_plan_candidates_from_markdown(
            _archive_dir_with_parity_markdown(), change_key="parity-change", **_PLAN_KWARGS
        )

    def test_legacy_path_never_emits_requirement_candidates(self) -> None:
        # 登记缺陷：旧路径 kind 切片 bug，Requirements 行永远被跳过。
        summaries = [c["summary"] for c in self._legacy()]
        self.assertNotIn(_PARITY_REQUIREMENT_TEXT, summaries)

    def test_direct_candidates_match_legacy_field_for_field(self) -> None:
        direct = [c for c in _direct_candidates() if c["summary"] != _PARITY_REQUIREMENT_TEXT]
        self.assertEqual(direct, self._legacy())

    def test_direct_path_emits_the_fixed_requirement_candidate(self) -> None:
        requirements = [c for c in _direct_candidates() if c["summary"] == _PARITY_REQUIREMENT_TEXT]
        self.assertEqual(len(requirements), 1)
        requirement = requirements[0]
        self.assertEqual(
            requirement["body"], f"需求类型：failure_behavior\n{_PARITY_REQUIREMENT_TEXT}"
        )
        self.assertEqual(requirement["keywords"], ["failure_behavior", "requirement"])
        self.assertEqual(requirement["entry_type"], "requirement")
        self.assertEqual(requirement["source_refs"], ["plans/parity-change-design.md"])


class PlanEvidenceInputHostileTest(unittest.TestCase):
    """hostile 输入：文件存在但非法 → ValueError 拒绝（调用方软处理）。"""

    def _assert_rejected(self, payload=None, *, raw: str | None = None) -> str:
        archive = _archive_dir_with_plan_evidence_input(payload, raw=raw)
        with self.assertRaises(ValueError) as ctx:
            hkc.build_plan_candidates(archive, change_key="parity-change", **_PLAN_KWARGS)
        message = str(ctx.exception)
        self.assertIn("plan-evidence-input.json", message)
        return message

    def test_invalid_json_is_rejected(self) -> None:
        self._assert_rejected(raw="{not json")

    def test_top_level_must_be_an_object(self) -> None:
        self._assert_rejected(payload=[1, 2, 3])

    def test_section_type_drift_is_rejected(self) -> None:
        self._assert_rejected(payload={"approval": {"content": {"risks": {"risk": "x"}}}})
        self._assert_rejected(payload={"approval": {"content": {"invariants": "not-a-list"}}})
        self._assert_rejected(payload={"structured_input": ["not-an-object"]})

    def test_record_key_set_is_enforced(self) -> None:
        self.assertIn(
            "缺少键 mitigation",
            self._assert_rejected(
                payload={"approval": {"content": {"risks": [{"risk": "x"}]}}}
            ),
        )
        self.assertIn(
            "意外键",
            self._assert_rejected(
                payload={
                    "structured_input": {
                        "requirements": [
                            {"requirement_id": "r", "kind": "behavior", "text": "t", "evil": 1}
                        ]
                    }
                }
            ),
        )

    def test_invalid_requirement_kind_is_rejected(self) -> None:
        self.assertIn(
            "kind",
            self._assert_rejected(
                payload={
                    "structured_input": {
                        "requirements": [
                            {"requirement_id": "r", "kind": "unknown", "text": "t"}
                        ]
                    }
                }
            ),
        )

    def test_task_and_scenario_records_are_validated(self) -> None:
        self._assert_rejected(payload={"structured_input": {"tasks": [{"task_id": "T1"}]}})
        self._assert_rejected(
            payload={
                "structured_input": {
                    "scenarios": [{"scenario_id": "S1", "title": "t", "oops": 1}]
                }
            }
        )

    def test_empty_fields_are_skipped_not_rejected(self) -> None:
        candidates = _direct_candidates(
            {
                "structured_input": {
                    "tasks": [
                        {"task_id": "T1", "objective": ""},
                        {"task_id": "T2", "objective": "有效任务"},
                    ],
                    "scenarios": [{"scenario_id": "", "title": "缺 id 被跳过"}],
                },
                "approval": {"content": {"risks": [{"risk": "None.", "mitigation": "x"}]}},
            }
        )
        self.assertEqual([c["summary"] for c in candidates], ["有效任务"])


class PlanCandidateSourceSelectionTest(unittest.TestCase):
    """来源选择：PEI 缺失 → 软失败/回退；PEI 存在 → 唯一真相源。"""

    def test_no_meta_files_yields_nothing(self) -> None:
        # 只有旧 plans/*.md 渲染件：06B-4 起生产路径不再解析它们。
        candidates = hkc.build_plan_candidates(
            _archive_dir_with_parity_markdown(), change_key="parity-change", **_PLAN_KWARGS
        )
        self.assertEqual(candidates, [])

    def test_empty_archive_yields_nothing(self) -> None:
        import tempfile
        candidates = hkc.build_plan_candidates(
            Path(tempfile.mkdtemp(prefix="hkc-empty-")),
            change_key="parity-change",
            **_PLAN_KWARGS,
        )
        self.assertEqual(candidates, [])

    def test_task_json_fallback_emits_t1_candidate(self) -> None:
        import tempfile
        root = Path(tempfile.mkdtemp(prefix="hkc-taskflow-"))
        meta = root / "meta"
        meta.mkdir(parents=True)
        (meta / "task.json").write_text(json.dumps({"change_key": "x"}), encoding="utf-8")
        candidates = hkc.build_plan_candidates(root, change_key="parity-change", **_PLAN_KWARGS)
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["summary"], hkc._TASK_FLOW_T1_OBJECTIVE)
        self.assertEqual(candidate["body"], f"任务：T1\n{hkc._TASK_FLOW_T1_OBJECTIVE}")
        self.assertEqual(candidate["keywords"], ["T1", "implementation"])
        self.assertEqual(candidate["entry_type"], "implementation")
        self.assertEqual(candidate["source_refs"], ["plans/parity-change-plan.md"])

    def test_plan_evidence_input_wins_over_task_json(self) -> None:
        archive = _archive_dir_with_plan_evidence_input(_minimal_plan_evidence_input())
        (archive / "meta" / "task.json").write_text(
            json.dumps({"change_key": "x"}), encoding="utf-8"
        )
        candidates = hkc.build_plan_candidates(
            archive, change_key="simple-mode-adoption", **_PLAN_KWARGS
        )
        summaries = [c["summary"] for c in candidates]
        self.assertNotIn(hkc._TASK_FLOW_T1_OBJECTIVE, summaries)
        self.assertIn("让离线用量不丢失。", summaries)


if __name__ == "__main__":
    unittest.main()
