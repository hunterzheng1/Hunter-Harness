import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "harness_knowledge.py"
MCP_SCRIPT = ROOT / "scripts" / "harness_knowledge_mcp.py"
MCP_CONFIG = ROOT / "mcp-config.example.json"
EVALUATION_XML = ROOT / "evaluations" / "harness_knowledge_evaluation.xml"
FIXTURE_PROJECT = ROOT / "tests" / "fixtures" / "mcp-eval-project"
REPAIR_ARCHIVE_ID = "2026-07-28-authoritative-repair"
REPAIR_ORIGINAL_REL = (
    f".harness/archive/{REPAIR_ARCHIVE_ID}/reports/final/summary-data.json"
)
REPAIR_DERIVED_REL = (
    f".harness/archive/{REPAIR_ARCHIVE_ID}/derived/v1/summary-data.json"
)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# Fixture archives simulate finalized, source-consistent summaries so the
# knowledge publication gate (API-006/RET-40) allows promote/judge paths.
VERIFIED_REPORT_PIPELINE = {"sourceConsistency": {"ok": True, "issues": []}}


class HarnessKnowledgeCliTest(unittest.TestCase):
    def make_project(self, root: Path, final_commit: str = "abc1234") -> Path:
        project = root / "sample-project"
        archive = project / ".harness" / "archive" / "2026-06-30-ai-check-job" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "ai-check-job",
                "businessGoal": "实现异步 AI 检查 job，复用现有 LlmClient 和 draft.aiChecks 结果展示。",
                "finalStatus": "OK",
                "finalCommit": final_commit,
                "baseCommit": "base0001",
                "diffStat": {"filesChanged": 3, "insertions": 120, "deletions": 8, "range": "base0001..abc1234"},
                "changedFiles": [
                    {
                        "path": "apps/server/src/registry/store.ts",
                        "summary": "新增 AI job 状态机和持久化字段",
                        "insertions": 80,
                        "deletions": 4,
                    },
                    {
                        "path": "apps/web/components/registry.tsx",
                        "summary": "展示 draft.aiChecks 异步结果",
                        "insertions": 40,
                        "deletions": 4,
                    },
                ],
                "verification": {
                    "unitTests": {"run": 12, "failures": 0, "errors": 0, "passRate": "12/12"},
                    "apiTests": {"status": "OK", "total": 3, "passed": 3, "failed": 0, "passRate": "3/3"},
                },
                "reviewSummary": {
                    "status": "ADVISORY",
                    "red": 0,
                    "yellow": 1,
                    "summary": "异步 job 轮询间隔后续可优化。",
                },
                "maintenanceNotes": [
                    "AI 检查 job 复用 LlmClient，不新增 provider 抽象。",
                    "draft.aiChecks 是前后端展示结果的唯一来源。",
                ],
                "knownRisks": [
                    "真实 provider key 与用量计费需要单独治理。",
                ],
                "manualActions": [
                    "部署前确认 AI provider 环境变量已配置。",
                ],
            },
        )
        return project

    def add_followup_archive(self, project: Path) -> None:
        archive = project / ".harness" / "archive" / "2026-07-01-ai-check-job-followup" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "ai-check-job-followup",
                "businessGoal": "调整异步 AI 检查 job 展示与 registry store 持久化策略，替代上一版前端轮询假设。",
                "finalStatus": "OK",
                "finalCommit": "def5678",
                "baseCommit": "abc1234",
                "changedFiles": [
                    {
                        "path": "apps/server/src/registry/store.ts",
                        "summary": "调整 AI job store 字段和状态兼容逻辑",
                    },
                    {
                        "path": "apps/web/components/registry.tsx",
                        "summary": "调整 AI checks 展示入口",
                    },
                ],
                "maintenanceNotes": [
                    "新的 registry store 状态字段替代上一版 AI job 轮询假设。",
                ],
                "knownRisks": [],
                "manualActions": [],
            },
        )

    def add_candidate_archive_without_commit(self, project: Path) -> None:
        archive = project / ".harness" / "archive" / "2026-07-01-candidate-note" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "candidate-note",
                "businessGoal": "记录一个仍需人工确认的候选知识条目。",
                "finalStatus": "OK",
                "changedFiles": [
                    {
                        "path": "docs/candidate.md",
                        "summary": "候选知识说明",
                    }
                ],
                "maintenanceNotes": [],
                "knownRisks": [],
                "manualActions": [],
            },
        )

    def add_old_archive_without_commit(self, project: Path) -> None:
        archive = project / ".harness" / "archive" / "2026-01-01-old-decision" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "old-decision",
                "businessGoal": "旧归档知识应在 TTL 过期后要求重新确认。",
                "finalStatus": "OK",
                "changedFiles": [
                    {
                        "path": "docs/old-decision.md",
                        "summary": "旧决策说明",
                    }
                ],
                "maintenanceNotes": [],
                "knownRisks": [],
                "manualActions": [],
            },
        )

    def add_conflicting_archive(self, project: Path) -> None:
        archive = project / ".harness" / "archive" / "2026-07-02-ai-check-conflict" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "ai-check-conflict",
                "businessGoal": "不再使用 draft.aiChecks 作为唯一来源，改为 server aiJobResult 替代旧展示结果。",
                "finalStatus": "OK",
                "changedFiles": [
                    {
                        "path": "apps/web/components/registry.tsx",
                        "summary": "不再读取 draft.aiChecks，改为 aiJobResult 展示",
                    }
                ],
                "maintenanceNotes": [
                    "server aiJobResult 替代 draft.aiChecks，旧的唯一来源约束不再成立。",
                ],
                "knownRisks": [],
                "manualActions": [],
            },
        )

    def add_failed_verification_archive(self, project: Path) -> None:
        archive = project / ".harness" / "archive" / "2026-07-03-ai-check-test-regression" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "ai-check-test-regression",
                "businessGoal": "验证异步 AI 检查 job 后续改动时发现 registry store 相关测试退化。",
                "finalStatus": "WARN",
                "finalCommit": "fedcba9",
                "baseCommit": "def5678",
                "changedFiles": [
                    {
                        "path": "apps/server/src/registry/store.ts",
                        "summary": "调整 registry store 后测试出现失败",
                    }
                ],
                "verification": {
                    "unitTests": {"run": 12, "failures": 2, "errors": 0, "passed": 10, "passRate": "10/12"},
                    "apiTests": {"status": "FAILED", "total": 3, "passed": 2, "failed": 1, "passRate": "2/3"},
                },
                "maintenanceNotes": [],
                "knownRisks": ["registry store 后续测试失败，需要重新确认旧测试证据。"],
                "manualActions": [],
            },
        )

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def run_git(self, cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def make_authoritative_repair_project(
        self,
        root: Path,
        *,
        name: str = "authoritative-repair-project",
    ) -> tuple[Path, Path, Path]:
        project = root / name
        archive_dir = (
            project
            / ".harness"
            / "archive"
            / REPAIR_ARCHIVE_ID
        )
        original_path = (
            archive_dir / "reports" / "final" / "summary-data.json"
        )
        write_json(
            original_path,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "original-change",
                "businessGoal": "原版归档内容不应覆盖有效 authoritative repair。",
                "finalStatus": "OK",
                "changedFiles": [],
                "maintenanceNotes": [],
                "knownRisks": [],
                "manualActions": [],
            },
        )
        return project, archive_dir, original_path

    def write_valid_authoritative_repair(
        self,
        archive_dir: Path,
        *,
        change_name: str = "authoritative-repaired-change",
        version: str = "v1",
        business_goal: str = "修复后的 authoritative 内容必须进入知识索引。",
        final_commit: str = "",
        changed_files: list[dict] | None = None,
    ) -> tuple[Path, str]:
        derived_path = archive_dir / "derived" / version / "summary-data.json"
        summary = {
            "schemaVersion": "2.3",
            "reportPipeline": VERIFIED_REPORT_PIPELINE,
            "changeName": change_name,
            "businessGoal": business_goal,
            "finalStatus": "OK",
            "changedFiles": changed_files or [],
            "maintenanceNotes": [],
            "knownRisks": [],
            "manualActions": [],
        }
        if final_commit:
            summary["finalCommit"] = final_commit
        write_json(derived_path, summary)
        derived_hash = hashlib.sha256(derived_path.read_bytes()).hexdigest()
        authoritative_hash = "sha256:" + derived_hash
        write_json(
            derived_path.parent / "repair-record.json",
            {
                "version": version,
                "summarySha256": authoritative_hash,
            },
        )
        write_json(
            archive_dir / "derived" / "authoritative.json",
            {
                "version": version,
                "summarySha256": authoritative_hash,
            },
        )
        return derived_path, derived_hash

    def ingest_payload(
        self,
        project: Path,
        *,
        no_incremental: bool = False,
    ) -> dict:
        args = ["ingest", "--project", str(project)]
        if no_incremental:
            args.append("--no-incremental")
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def knowledge_index(self, project: Path) -> dict:
        return json.loads(
            (
                project / ".harness" / "knowledge" / "index.json"
            ).read_text(encoding="utf-8")
        )

    def knowledge_entries(self, project: Path) -> list[dict]:
        entries_dir = project / ".harness" / "knowledge" / "entries"
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(entries_dir.rglob("*.json"))
        ]

    def assert_archive_record(
        self,
        project: Path,
        summary_rel: str,
        summary_hash: str,
    ) -> dict:
        archive_item = self.knowledge_index(project)["archives"]["items"][0]
        self.assertEqual(archive_item["summaryData"], summary_rel)
        self.assertEqual(archive_item["summarySha256"], summary_hash)
        return archive_item

    def assert_single_entry_provenance(
        self,
        project: Path,
        summary_rel: str,
        summary_hash: str,
        change_name: str,
    ) -> dict:
        entries = self.knowledge_entries(project)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["source"]["summaryData"], summary_rel)
        self.assertEqual(entry["source"]["summarySha256"], summary_hash)
        self.assertEqual(entry["source"]["changeName"], change_name)
        return entry

    def break_valid_authoritative_repair(
        self,
        archive_dir: Path,
        case: str,
    ) -> str:
        pointer_path = archive_dir / "derived" / "authoritative.json"
        record_path = archive_dir / "derived" / "v1" / "repair-record.json"
        if case == "record-version":
            path, key, value = record_path, "version", "v2"
            reason = "repair record version mismatch"
        elif case == "pointer-hash":
            path, key, value = (
                pointer_path,
                "summarySha256",
                "sha256:" + ("1" * 64),
            )
            reason = "authoritative pointer hash mismatch"
        else:
            path, key, value = (
                record_path,
                "summarySha256",
                "sha256:" + ("2" * 64),
            )
            reason = "repair record summary hash mismatch"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload[key] = value
        write_json(path, payload)
        return reason

    def assert_archive_quarantined(
        self,
        project: Path,
        reason: str,
        *,
        required_id: str | None = None,
    ) -> list[dict]:
        entries = self.knowledge_entries(project)
        self.assertTrue(entries)
        self.assertFalse(
            any(entry["status"] == "active" for entry in entries),
            entries,
        )
        self.assertTrue(
            all(
                reason in (entry["lifecycle"].get("publishBlocked") or [])
                for entry in entries
            ),
            entries,
        )
        if required_id is not None:
            self.assertIn(required_id, {entry["id"] for entry in entries})
        return entries

    def promote_only_knowledge_entry(self, project: Path) -> str:
        entries = self.knowledge_entries(project)
        self.assertEqual(len(entries), 1)
        entry_id = entries[0]["id"]
        result = self.run_cli(
            "promote",
            "--project",
            str(project),
            "--id",
            entry_id,
            "--note",
            "authoritative repair transition fixture",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return entry_id

    def promote_entry_with_provenance(
        self,
        project: Path,
        summary_rel: str,
        summary_hash: str,
    ) -> str:
        matches = [
            entry
            for entry in self.knowledge_entries(project)
            if entry["source"]["summaryData"] == summary_rel
            and entry["source"]["summarySha256"] == summary_hash
        ]
        self.assertEqual(len(matches), 1, matches)
        entry_id = matches[0]["id"]
        result = self.run_cli(
            "promote",
            "--project",
            str(project),
            "--id",
            entry_id,
            "--note",
            "current authoritative provenance fixture",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return entry_id

    def assert_only_provenance_is_active(
        self,
        project: Path,
        summary_rel: str,
        summary_hash: str,
    ) -> list[dict]:
        entries = self.knowledge_entries(project)
        active = [entry for entry in entries if entry["status"] == "active"]
        self.assertTrue(active, entries)
        self.assertEqual(
            {
                (
                    entry["source"]["summaryData"],
                    entry["source"]["summarySha256"],
                )
                for entry in active
            },
            {(summary_rel, summary_hash)},
            entries,
        )
        return active

    def assert_single_id_consistent_across_indexes(
        self,
        project: Path,
        entry_id: str,
        *,
        status: str,
        summary_rel: str,
        summary_hash: str,
    ) -> dict:
        knowledge = project / ".harness" / "knowledge"
        matching_paths = [
            path
            for path in (knowledge / "entries").rglob("*.json")
            if json.loads(path.read_text(encoding="utf-8")).get("id")
            == entry_id
        ]
        self.assertEqual(len(matching_paths), 1, matching_paths)
        entry_path = matching_paths[0]
        entry = json.loads(entry_path.read_text(encoding="utf-8"))
        self.assertEqual(entry_path.parent.name, status)
        self.assertEqual(entry["status"], status)
        self.assertEqual(entry["source"]["summaryData"], summary_rel)
        self.assertEqual(entry["source"]["summarySha256"], summary_hash)

        index = self.knowledge_index(project)
        index_matches = [
            item for item in index["entries"] if item["id"] == entry_id
        ]
        self.assertEqual(len(index_matches), 1, index_matches)
        index_entry = index_matches[0]
        self.assertEqual(index_entry["status"], entry["status"])
        self.assertEqual(
            index_entry["sourceArchive"],
            entry["source"]["archive"],
        )
        self.assertEqual(
            index_entry["sourceCommit"],
            entry["source"]["sourceCommit"],
        )
        self.assertEqual(
            index["archives"]["items"][0]["summaryData"],
            summary_rel,
        )
        self.assertEqual(
            index["archives"]["items"][0]["summarySha256"],
            summary_hash,
        )

        con = sqlite3.connect(knowledge / "index.sqlite")
        try:
            rows = con.execute(
                """
                select status, source_archive, source_commit, entry_json
                from entries where id=?
                """,
                (entry_id,),
            ).fetchall()
        finally:
            con.close()
        self.assertEqual(len(rows), 1, rows)
        sqlite_entry = json.loads(rows[0][3])
        self.assertEqual(rows[0][0], entry["status"])
        self.assertEqual(rows[0][1], entry["source"]["archive"])
        self.assertEqual(rows[0][2] or "", entry["source"]["sourceCommit"])
        self.assertEqual(sqlite_entry["status"], entry["status"])
        self.assertEqual(sqlite_entry["source"], entry["source"])
        return entry

    def test_later_failed_verification_marks_older_test_evidence_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.add_failed_verification_archive(project)

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            knowledge = project / ".harness" / "knowledge"
            stale_files = list((knowledge / "entries" / "stale").glob("*.json"))
            self.assertGreaterEqual(len(stale_files), 1)
            stale_entries = [json.loads(path.read_text(encoding="utf-8")) for path in stale_files]
            stale_test_entries = [entry for entry in stale_entries if entry["type"] == "test-evidence"]
            self.assertGreaterEqual(len(stale_test_entries), 1)
            reasons = "\n".join(
                reason
                for entry in stale_test_entries
                for reason in entry["lifecycle"].get("staleReasons", [])
            )
            self.assertIn("newer verification degraded", reasons)
            self.assertIn("2026-07-03-ai-check-test-regression", reasons)

    def test_incremental_ingest_reuses_unchanged_archive_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))

            first = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(first.returncode, 0, first.stderr)
            first_payload = json.loads(first.stdout)
            self.assertEqual(first_payload["ingestMode"]["archivesExtracted"], 1)
            self.assertEqual(first_payload["ingestMode"]["archivesReused"], 0)

            second = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(second.returncode, 0, second.stderr)
            second_payload = json.loads(second.stdout)
            self.assertEqual(second_payload["ingestMode"]["archivesExtracted"], 0)
            self.assertEqual(second_payload["ingestMode"]["archivesReused"], 1)
            cache_files = list((project / ".harness" / "knowledge" / "cache" / "archive-entries").glob("*.json"))
            self.assertEqual(len(cache_files), 1)

            self.add_candidate_archive_without_commit(project)
            third = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(third.returncode, 0, third.stderr)
            third_payload = json.loads(third.stdout)
            self.assertEqual(third_payload["ingestMode"]["archivesExtracted"], 1)
            self.assertEqual(third_payload["ingestMode"]["archivesReused"], 1)

    def test_sync_accepts_explicit_json_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.assertEqual(
                self.run_cli("ingest", "--project", str(project)).returncode,
                0,
            )

            result = self.run_cli(
                "sync", "--project", str(project), "--json"
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["upToDate"])

    def add_independent_archive(self, project: Path) -> Path:
        archive = project / ".harness" / "archive" / "2026-07-05-independent-feature" / "reports" / "final" / "summary-data.json"
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "independent-feature",
                "businessGoal": "独立功能 X，与 AI job 模块无关。",
                "finalStatus": "OK",
                "finalCommit": "ind0001",
                "baseCommit": "base0000",
                "changedFiles": [{"path": "docs/feature-x.md", "summary": "独立功能文档"}],
                "maintenanceNotes": ["功能 X 独立实现，不依赖 AI job。"],
                "knownRisks": [],
                "manualActions": [],
            },
        )
        return archive

    def _knowledge_content_hashes(self, knowledge: Path) -> dict[str, str]:
        """Snapshot content hashes of entry/index/view files (excluding per-run reports)."""
        hashes: dict[str, str] = {}
        for sub in ["candidate", "active", "stale", "superseded", "conflicted"]:
            for path in sorted((knowledge / "entries" / sub).glob("*.json")):
                hashes[f"entries/{sub}/{path.name}"] = hashlib.sha256(path.read_bytes()).hexdigest()
        index_path = knowledge / "index.json"
        if index_path.exists():
            hashes["index.json"] = hashlib.sha256(index_path.read_bytes()).hexdigest()
        for path in sorted((knowledge / "views").glob("*")):
            if path.is_file():
                hashes[f"views/{path.name}"] = hashlib.sha256(path.read_bytes()).hexdigest()
        return hashes

    def _sqlite_content_hash(self, sqlite_path: Path) -> str:
        con = sqlite3.connect(sqlite_path)
        try:
            rows = con.execute("select id, entry_json from entries order by id").fetchall()
        finally:
            con.close()
        return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode("utf-8")).hexdigest()

    def test_no_op_ingest_writes_zero_content_changes(self) -> None:
        """UT-025: archives/config 未变时，再 ingest 不改写任何 entry/index/view/sqlite 内容。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            first = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(first.returncode, 0, first.stderr)
            knowledge = project / ".harness" / "knowledge"

            before = self._knowledge_content_hashes(knowledge)
            before_sqlite = self._sqlite_content_hash(knowledge / "index.sqlite")

            # ensure lastCalculatedAt/generatedAt would tick across runs, so a
            # no-op must be detected by input fingerprint, not by same-second luck
            time.sleep(1.2)

            second = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(second.returncode, 0, second.stderr)
            payload = json.loads(second.stdout)
            self.assertEqual(
                payload["ingestMode"].get("mode"),
                "no-op",
                f"expected no-op mode, got ingestMode: {payload['ingestMode']}",
            )
            self.assertEqual(payload["ingestMode"].get("entriesWritten", -1), 0)

            after = self._knowledge_content_hashes(knowledge)
            self.assertEqual(before, after, "no-op ingest rewrote entry/index/view content")
            self.assertEqual(
                self._sqlite_content_hash(knowledge / "index.sqlite"),
                before_sqlite,
                "no-op ingest changed sqlite content",
            )

    def test_single_archive_change_updates_only_dirty_entries(self) -> None:
        """UT-026: 多 archive 中修改 1 个，只更新受影响 dirty set，未变化 archive 的 entry 内容不变。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            independent_archive = self.add_independent_archive(project)
            self.run_cli("ingest", "--project", str(project))
            knowledge = project / ".harness" / "knowledge"

            def hashes_for_archive(archive_suffix: str) -> dict[str, str]:
                result: dict[str, str] = {}
                for sub in ["candidate", "active", "stale", "superseded", "conflicted"]:
                    for path in sorted((knowledge / "entries" / sub).glob("*.json")):
                        entry = json.loads(path.read_text(encoding="utf-8"))
                        if entry.get("source", {}).get("archive", "").endswith(archive_suffix):
                            result[f"{sub}/{path.name}"] = hashlib.sha256(path.read_bytes()).hexdigest()
                return result

            ai_job_before = hashes_for_archive("2026-06-30-ai-check-job")
            self.assertGreater(len(ai_job_before), 0, "ai-check-job entries should exist")
            total_files_before = len(self._knowledge_content_hashes(knowledge))

            # ensure lastCalculatedAt/generatedAt would tick across runs
            time.sleep(1.2)

            data = json.loads(independent_archive.read_text(encoding="utf-8"))
            data["businessGoal"] = "独立功能 X（已更新描述），与 AI job 模块无关。"
            independent_archive.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )

            second = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(second.returncode, 0, second.stderr)
            payload = json.loads(second.stdout)
            self.assertEqual(payload["ingestMode"]["archivesExtracted"], 1)
            self.assertEqual(payload["ingestMode"]["archivesReused"], 1)
            written = payload["ingestMode"].get("entriesWritten")
            self.assertIsNotNone(written, "ingestMode should report entriesWritten")
            self.assertLess(
                written,
                total_files_before,
                "dirty set should be smaller than a full rewrite of all entries",
            )

            ai_job_after = hashes_for_archive("2026-06-30-ai-check-job")
            self.assertEqual(
                ai_job_before,
                ai_job_after,
                "unchanged archive entries must not be rewritten",
            )

    def test_head_change_without_archive_change_keeps_index_current(self) -> None:
        """UT-027: 普通 HEAD 变化但 archive 不变，索引仍 current，不全量 rebuild。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.run_git(project, "init", "-q")
            self.run_git(project, "config", "user.email", "t@t.t")
            self.run_git(project, "config", "user.name", "t")
            self.run_git(project, "add", "-A")
            self.run_git(project, "commit", "-q", "-m", "init")
            self.run_cli("ingest", "--project", str(project))

            (project / "src").mkdir(exist_ok=True)
            (project / "src" / "noise.ts").write_text("// unrelated business code\n", encoding="utf-8")
            self.run_git(project, "add", "-A")
            self.run_git(project, "commit", "-q", "-m", "noise")

            sync = self.run_cli("sync", "--project", str(project))
            self.assertEqual(sync.returncode, 0, sync.stderr)
            payload = json.loads(sync.stdout)
            reasons_text = " ".join(payload["reasons"]).lower()
            self.assertNotIn(
                "head commit",
                reasons_text,
                "HEAD change alone must not invalidate the knowledge index",
            )
            self.assertTrue(
                payload["upToDate"],
                f"index should stay current when only HEAD changed, reasons: {payload['reasons']}",
            )

    def test_mcp_entrypoint_describes_harness_knowledge_tools(self) -> None:
        result = subprocess.run(
            [sys.executable, str(MCP_SCRIPT), "--describe-tools"],
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        tool_names = {tool["name"] for tool in payload["tools"]}
        self.assertIn("harness_knowledge_ingest", tool_names)
        self.assertIn("harness_knowledge_sync", tool_names)
        self.assertIn("harness_knowledge_query", tool_names)
        self.assertIn("harness_knowledge_promote", tool_names)
        self.assertIn("harness_knowledge_demote", tool_names)
        self.assertIn("harness_knowledge_verify", tool_names)
        self.assertIn("harness_knowledge_suggest_validators", tool_names)
        self.assertIn("harness_knowledge_auto", tool_names)

        config = json.loads(MCP_CONFIG.read_text(encoding="utf-8"))
        server = config["mcpServers"]["harness-knowledge"]
        self.assertEqual(server["command"], "python")
        self.assertIn("harness_knowledge_mcp.py", server["args"][0])

    def test_ingest_builds_index_entries_sqlite_and_views(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            knowledge = project / ".harness" / "knowledge"
            index_path = knowledge / "index.json"
            sqlite_path = knowledge / "index.sqlite"
            self.assertTrue(index_path.exists(), "index.json should be generated")
            self.assertTrue(sqlite_path.exists(), "index.sqlite should be generated")
            self.assertTrue((knowledge / "views" / "knowledge-dashboard.md").exists())
            self.assertTrue((knowledge / "views" / "by-file.md").exists())
            base_path = knowledge / "views" / "knowledge.base"
            self.assertTrue(base_path.exists())
            base = yaml.safe_load(base_path.read_text(encoding="utf-8"))
            self.assertIn("views", base)
            view_names = {view["name"] for view in base["views"]}
            self.assertIn("Lifecycle Table", view_names)
            self.assertIn("Needs Review", view_names)

            index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertGreaterEqual(index["stats"]["candidate"], 5)
            self.assertEqual(index["archives"]["scanned"], 1)
            self.assertEqual(index["archives"]["indexed"], 1)

            candidate_files = list((knowledge / "entries" / "candidate").glob("*.json"))
            self.assertGreaterEqual(len(candidate_files), 5)
            entry = json.loads(candidate_files[0].read_text(encoding="utf-8"))
            self.assertIn("source", entry)
            self.assertIn("sourceCommit", entry["source"])
            self.assertIn("sourceFiles", entry["scope"])

            con = sqlite3.connect(sqlite_path)
            try:
                count = con.execute("select count(*) from entries").fetchone()[0]
                file_count = con.execute("select count(*) from entry_files").fetchone()[0]
                by_file = con.execute(
                    "select count(*) from entry_files where source_file = ?",
                    ("apps/server/src/registry/store.ts",),
                ).fetchone()[0]
            finally:
                con.close()
            self.assertEqual(count, index["stats"]["candidate"])
            self.assertGreaterEqual(file_count, count)
            self.assertGreaterEqual(by_file, 1)

    def test_no_incremental_ingest_uses_hash_valid_authoritative_repair_for_index_and_entries(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, _ = self.make_authoritative_repair_project(
                Path(tmp)
            )
            _, derived_hash = self.write_valid_authoritative_repair(archive_dir)
            self.ingest_payload(project, no_incremental=True)
            index = self.knowledge_index(project)
            self.assertEqual(len(index["archives"]["items"]), 1)
            entries = self.knowledge_entries(project)
            self.assertEqual(len(entries), 1)
            entry = entries[0]

            archive_item = index["archives"]["items"][0]
            self.assertEqual(
                archive_item["summaryData"],
                REPAIR_DERIVED_REL,
                "index archives.items.summaryData must select the authoritative repair",
            )
            self.assertEqual(
                archive_item["summarySha256"],
                derived_hash,
                "index archives.items.summarySha256 must hash the authoritative repair",
            )
            self.assertEqual(
                entry["source"]["summaryData"],
                REPAIR_DERIVED_REL,
                "entry source.summaryData must select the authoritative repair",
            )
            self.assertEqual(
                entry["source"]["summarySha256"],
                derived_hash,
                "entry source.summarySha256 must hash the authoritative repair",
            )
            self.assertEqual(
                entry["source"]["changeName"],
                "authoritative-repaired-change",
                "entry source.changeName must be extracted from the authoritative repair",
            )

    def test_missing_authoritative_repair_pointer_preserves_original_summary_compatibility(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, _, original_path = (
                self.make_authoritative_repair_project(Path(tmp))
            )
            self.ingest_payload(project, no_incremental=True)

            original_hash = hashlib.sha256(original_path.read_bytes()).hexdigest()
            self.assert_archive_record(project, REPAIR_ORIGINAL_REL, original_hash)
            entry = self.assert_single_entry_provenance(
                project,
                REPAIR_ORIGINAL_REL,
                original_hash,
                "original-change",
            )
            self.assertFalse(
                entry["lifecycle"].get("publishBlocked"),
                "missing repair pointer must preserve publication compatibility",
            )

    def test_invalid_authoritative_repair_metadata_falls_back_and_blocks_publication(
        self,
    ) -> None:
        for case in ("record-version", "pointer-hash", "record-hash"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                project, archive_dir, original_path = (
                    self.make_authoritative_repair_project(Path(tmp))
                )
                self.write_valid_authoritative_repair(archive_dir)
                expected_reason = self.break_valid_authoritative_repair(
                    archive_dir, case
                )

                self.ingest_payload(project, no_incremental=True)
                original_hash = hashlib.sha256(
                    original_path.read_bytes()
                ).hexdigest()
                self.assert_archive_record(
                    project, REPAIR_ORIGINAL_REL, original_hash
                )
                entry = self.assert_single_entry_provenance(
                    project,
                    REPAIR_ORIGINAL_REL,
                    original_hash,
                    "original-change",
                )
                self.assert_archive_quarantined(project, expected_reason)

                promote = self.run_cli(
                    "promote",
                    "--project",
                    str(project),
                    "--id",
                    entry["id"],
                    "--note",
                    "must stay quarantined",
                )
                self.assertNotEqual(promote.returncode, 0)
                self.assertIn("publication blocked", promote.stderr.lower())

    def test_authoritative_repair_path_escape_falls_back_and_blocks_publication(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project, archive_dir, original_path = (
                self.make_authoritative_repair_project(root)
            )
            outside_version = root / "outside-authoritative-v1"
            outside_summary = outside_version / "summary-data.json"
            write_json(
                outside_summary,
                {
                    "schemaVersion": "2.3",
                    "reportPipeline": VERIFIED_REPORT_PIPELINE,
                    "changeName": "escaped-authoritative-change",
                    "businessGoal": "归档外摘要绝不能成为知识来源。",
                    "finalStatus": "OK",
                    "changedFiles": [],
                    "maintenanceNotes": [],
                    "knownRisks": [],
                    "manualActions": [],
                },
            )
            derived_hash = hashlib.sha256(
                outside_summary.read_bytes()
            ).hexdigest()
            authoritative_hash = "sha256:" + derived_hash
            write_json(
                outside_version / "repair-record.json",
                {
                    "version": "v1",
                    "summarySha256": authoritative_hash,
                },
            )
            derived_root = archive_dir / "derived"
            derived_root.mkdir(parents=True)
            version_link = derived_root / "v1"
            try:
                version_link.symlink_to(outside_version, target_is_directory=True)
            except (NotImplementedError, OSError):
                if not sys.platform.startswith("win"):
                    self.skipTest("directory symlink is unavailable")
                junction = subprocess.run(
                    [
                        "cmd.exe",
                        "/c",
                        "mklink",
                        "/J",
                        str(version_link),
                        str(outside_version),
                    ],
                    text=True,
                    encoding="utf-8",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                if junction.returncode != 0:
                    self.skipTest(
                        "directory link unavailable: "
                        + (junction.stderr or junction.stdout).strip()
                    )
            write_json(
                derived_root / "authoritative.json",
                {
                    "version": "v1",
                    "summarySha256": authoritative_hash,
                },
            )

            self.ingest_payload(project, no_incremental=True)
            original_hash = hashlib.sha256(
                original_path.read_bytes()
            ).hexdigest()
            self.assert_archive_record(
                project,
                REPAIR_ORIGINAL_REL,
                original_hash,
            )
            entry = self.assert_single_entry_provenance(
                project,
                REPAIR_ORIGINAL_REL,
                original_hash,
                "original-change",
            )
            self.assertNotEqual(entry["status"], "active")
            self.assert_archive_quarantined(
                project,
                "authoritative version escapes derived root",
            )

    def test_original_path_escape_is_never_discovered_recorded_or_extracted(
        self,
    ) -> None:
        from unittest import mock

        module = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project, _, original_path = self.make_authoritative_repair_project(
                Path(tmp)
            )
            outside_path = project / "outside-archive" / "summary-data.json"
            escaped_resolution = {
                "summaryPath": outside_path,
                "status": "degraded",
                "allowed": False,
                "version": None,
                "reasons": ["summary-data.json escapes archive root"],
                "fingerprint": {
                    "resolverVersion": 1,
                    "status": "degraded",
                    "allowed": False,
                    "version": None,
                    "reasons": ["summary-data.json escapes archive root"],
                    "original": {"state": "path-escape", "sha256": None},
                    "pointer": {"state": "missing", "sha256": None},
                    "record": {"state": "not-applicable", "sha256": None},
                    "summary": {"state": "not-applicable", "sha256": None},
                },
            }
            path_type = type(outside_path)
            real_stat = path_type.stat
            stat_paths: list[Path] = []
            hash_paths: list[Path] = []
            extract_paths: list[Path] = []

            def tracking_stat(path: Path, *args, **kwargs):
                if path == outside_path:
                    stat_paths.append(path)
                    return mock.Mock(st_mtime=0)
                return real_stat(path, *args, **kwargs)

            def tracking_hash(path: Path) -> str:
                hash_paths.append(Path(path))
                return "0" * 64

            def tracking_extract(
                _project: Path,
                _project_name: str,
                summary_path: Path,
            ) -> list[dict]:
                extract_paths.append(Path(summary_path))
                return []

            with (
                mock.patch.object(
                    module,
                    "resolve_archive_summary",
                    return_value=escaped_resolution,
                ),
                mock.patch.object(path_type, "stat", new=tracking_stat),
                mock.patch.object(
                    module,
                    "sha256_file",
                    side_effect=tracking_hash,
                ),
                mock.patch.object(
                    module,
                    "extract_entries",
                    side_effect=tracking_extract,
                ),
            ):
                discovered = module.discover_archive_summary_paths(project)
                records = module.archive_summary_records(
                    project,
                    [original_path],
                )
                module.build_index(project, incremental=False)

            self.assertEqual(discovered, [])
            self.assertEqual(records, [])
            self.assertNotIn(outside_path, stat_paths)
            self.assertNotIn(outside_path, hash_paths)
            self.assertNotIn(outside_path, extract_paths)

    def test_repair_record_missing_null_or_empty_version_falls_back_and_blocks(
        self,
    ) -> None:
        cases = (("missing", ...), ("null", None), ("empty", ""))
        for case, value in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                project, archive_dir, original_path = (
                    self.make_authoritative_repair_project(Path(tmp))
                )
                derived_path, _ = self.write_valid_authoritative_repair(
                    archive_dir
                )
                record_path = derived_path.parent / "repair-record.json"
                record = json.loads(record_path.read_text(encoding="utf-8"))
                if value is ...:
                    record.pop("version")
                else:
                    record["version"] = value
                write_json(record_path, record)

                self.ingest_payload(project, no_incremental=True)

                original_hash = hashlib.sha256(
                    original_path.read_bytes()
                ).hexdigest()
                self.assert_archive_record(
                    project,
                    REPAIR_ORIGINAL_REL,
                    original_hash,
                )
                entry = self.assert_single_entry_provenance(
                    project,
                    REPAIR_ORIGINAL_REL,
                    original_hash,
                    "original-change",
                )
                self.assertNotEqual(entry["status"], "active")
                self.assertIn(
                    "repair record version mismatch",
                    entry["lifecycle"].get("publishBlocked") or [],
                )

    def test_incremental_original_to_valid_authoritative_repair_then_no_op(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, _ = self.make_authoritative_repair_project(
                Path(tmp)
            )
            original = self.ingest_payload(project)
            _, derived_hash = self.write_valid_authoritative_repair(archive_dir)

            repaired = self.ingest_payload(project)
            unchanged = self.ingest_payload(project)

            self.assertNotEqual(
                original["ingestMode"]["inputsHash"],
                repaired["ingestMode"]["inputsHash"],
            )
            self.assertNotEqual(repaired["ingestMode"]["mode"], "no-op")
            self.assertEqual(repaired["ingestMode"]["archivesExtracted"], 1)
            self.assertEqual(repaired["ingestMode"]["archivesReused"], 0)
            self.assertEqual(unchanged["ingestMode"]["mode"], "no-op")
            self.assertEqual(unchanged["ingestMode"]["archivesExtracted"], 0)
            self.assertEqual(unchanged["ingestMode"]["archivesReused"], 1)
            self.assertEqual(
                repaired["ingestMode"]["inputsHash"],
                unchanged["ingestMode"]["inputsHash"],
            )
            archive_item = self.knowledge_index(project)["archives"]["items"][0]
            self.assertEqual(archive_item["summaryData"], REPAIR_DERIVED_REL)
            self.assertEqual(archive_item["summarySha256"], derived_hash)
            entries = self.knowledge_entries(project)
            self.assertEqual(len(entries), 1)
            self.assertEqual(
                entries[0]["source"]["changeName"],
                "authoritative-repaired-change",
            )

    def test_same_id_v1_auto_promote_replaces_original_active_source(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, original_path = (
                self.make_authoritative_repair_project(Path(tmp))
            )
            original = json.loads(original_path.read_text(encoding="utf-8"))
            self.ingest_payload(project)
            entry_id = self.promote_only_knowledge_entry(project)
            knowledge = project / ".harness" / "knowledge"
            write_json(
                knowledge / "config.json",
                {
                    "autoPromote": {
                        "enabled": True,
                        "minConfidence": 0.82,
                        "allowedTypes": ["requirement"],
                        "maxPerRun": 10,
                    }
                },
            )

            _, v1_hash = self.write_valid_authoritative_repair(
                archive_dir,
                change_name=original["changeName"],
                business_goal=original["businessGoal"],
            )
            result = self.ingest_payload(project)

            self.assertGreaterEqual(
                result["ingestMode"]["candidateAutoPromoted"],
                1,
            )
            entry = self.assert_single_id_consistent_across_indexes(
                project,
                entry_id,
                status="active",
                summary_rel=REPAIR_DERIVED_REL,
                summary_hash=v1_hash,
            )
            self.assertEqual(entry["id"], entry_id)

    def test_same_id_stale_v1_replaces_original_active_source(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, original_path = (
                self.make_authoritative_repair_project(Path(tmp))
            )
            original = json.loads(original_path.read_text(encoding="utf-8"))
            self.assertEqual(self.run_git(project, "init").returncode, 0)
            self.ingest_payload(project)
            entry_id = self.promote_only_knowledge_entry(project)
            missing_commit = "deadbeef" * 5

            _, v1_hash = self.write_valid_authoritative_repair(
                archive_dir,
                change_name=original["changeName"],
                business_goal=original["businessGoal"],
                final_commit=missing_commit,
                changed_files=[
                    {
                        "path": "apps/server/src/repaired-source.ts",
                        "summary": "同 ID repair source provenance",
                    }
                ],
            )
            self.ingest_payload(project)

            entry = self.assert_single_id_consistent_across_indexes(
                project,
                entry_id,
                status="stale",
                summary_rel=REPAIR_DERIVED_REL,
                summary_hash=v1_hash,
            )
            self.assertEqual(entry["source"]["sourceCommit"], missing_commit)
            self.assertIn(
                "source commit missing from local git history",
                "\n".join(entry["lifecycle"].get("staleReasons") or []),
            )

    def test_active_original_loses_eligibility_when_valid_v1_is_selected(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, original_path = (
                self.make_authoritative_repair_project(Path(tmp))
            )
            self.ingest_payload(project)
            original_id = self.promote_only_knowledge_entry(project)
            original_hash = hashlib.sha256(
                original_path.read_bytes()
            ).hexdigest()

            _, v1_hash = self.write_valid_authoritative_repair(
                archive_dir,
                change_name="original-change",
                business_goal=(
                    "原版归档内容不应覆盖有效 authoritative repair。"
                ),
            )
            self.ingest_payload(project)
            v1_id = self.promote_entry_with_provenance(
                project,
                REPAIR_DERIVED_REL,
                v1_hash,
            )

            active = self.assert_only_provenance_is_active(
                project,
                REPAIR_DERIVED_REL,
                v1_hash,
            )
            self.assertIn(v1_id, {entry["id"] for entry in active})
            if original_id != v1_id:
                self.assertNotIn(original_id, {entry["id"] for entry in active})
            self.assertFalse(
                any(
                    entry["status"] == "active"
                    and entry["source"]["summaryData"] == REPAIR_ORIGINAL_REL
                    and entry["source"]["summarySha256"] == original_hash
                    for entry in self.knowledge_entries(project)
                )
            )

    def test_active_v1_loses_eligibility_when_valid_v2_is_selected(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, _ = self.make_authoritative_repair_project(
                Path(tmp)
            )
            _, v1_hash = self.write_valid_authoritative_repair(archive_dir)
            self.ingest_payload(project)
            v1_id = self.promote_only_knowledge_entry(project)

            _, v2_hash = self.write_valid_authoritative_repair(
                archive_dir,
                version="v2",
                change_name="authoritative-repaired-v2",
                business_goal="v2 authoritative 内容替代 v1 进入知识索引。",
            )
            v2_rel = (
                f".harness/archive/{REPAIR_ARCHIVE_ID}"
                "/derived/v2/summary-data.json"
            )
            self.ingest_payload(project)
            v2_id = self.promote_entry_with_provenance(
                project,
                v2_rel,
                v2_hash,
            )

            active = self.assert_only_provenance_is_active(
                project,
                v2_rel,
                v2_hash,
            )
            self.assertIn(v2_id, {entry["id"] for entry in active})
            self.assertNotIn(v1_id, {entry["id"] for entry in active})
            self.assertFalse(
                any(
                    entry["status"] == "active"
                    and entry["source"]["summaryData"] == REPAIR_DERIVED_REL
                    and entry["source"]["summarySha256"] == v1_hash
                    for entry in self.knowledge_entries(project)
                )
            )

    def test_auto_demoted_original_does_not_restore_after_valid_v1_repair(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, original_path = (
                self.make_authoritative_repair_project(Path(tmp))
            )
            self.ingest_payload(project)
            original_id = self.promote_only_knowledge_entry(project)
            original_hash = hashlib.sha256(
                original_path.read_bytes()
            ).hexdigest()

            write_json(
                archive_dir / "derived" / "authoritative.json",
                {
                    "version": "v1",
                    "summarySha256": "sha256:" + ("7" * 64),
                },
            )
            self.ingest_payload(project)
            self.assert_archive_quarantined(
                project,
                "authoritative version missing",
                required_id=original_id,
            )

            _, v1_hash = self.write_valid_authoritative_repair(archive_dir)
            self.ingest_payload(project)
            v1_id = self.promote_entry_with_provenance(
                project,
                REPAIR_DERIVED_REL,
                v1_hash,
            )

            active = self.assert_only_provenance_is_active(
                project,
                REPAIR_DERIVED_REL,
                v1_hash,
            )
            self.assertIn(v1_id, {entry["id"] for entry in active})
            self.assertNotIn(original_id, {entry["id"] for entry in active})
            self.assertFalse(
                any(
                    entry["status"] == "active"
                    and entry["source"]["summaryData"] == REPAIR_ORIGINAL_REL
                    and entry["source"]["summarySha256"] == original_hash
                    for entry in self.knowledge_entries(project)
                )
            )

    def test_incremental_repair_becoming_invalid_quarantines_active_entries(
        self,
    ) -> None:
        cases = (
            ("valid", "authoritative pointer hash mismatch"),
            ("missing-pointer", "authoritative version missing"),
        )
        for initial_state, reason in cases:
            with self.subTest(initial_state=initial_state), tempfile.TemporaryDirectory() as tmp:
                project, archive_dir, _ = self.make_authoritative_repair_project(
                    Path(tmp)
                )
                if initial_state == "valid":
                    self.write_valid_authoritative_repair(archive_dir)
                self.ingest_payload(project)
                promoted_id = self.promote_only_knowledge_entry(project)
                valid_active_hash = self.knowledge_index(project)["inputsHash"]

                if initial_state == "valid":
                    self.break_valid_authoritative_repair(
                        archive_dir, "pointer-hash"
                    )
                else:
                    write_json(
                        archive_dir / "derived" / "authoritative.json",
                        {
                            "version": "v1",
                            "summarySha256": "sha256:" + ("4" * 64),
                        },
                    )
                invalid = self.ingest_payload(project)

                self.assertNotEqual(invalid["ingestMode"]["mode"], "no-op")
                self.assertNotEqual(
                    valid_active_hash,
                    invalid["ingestMode"]["inputsHash"],
                )
                entries = self.assert_archive_quarantined(
                    project,
                    reason,
                    required_id=promoted_id,
                )
                self.assertTrue(
                    any(
                        entry["source"]["summaryData"] == REPAIR_ORIGINAL_REL
                        for entry in entries
                    ),
                    entries,
                )

    def test_incremental_invalid_authoritative_repair_reason_change_breaks_no_op(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, _ = self.make_authoritative_repair_project(
                Path(tmp)
            )
            original = self.ingest_payload(project)
            write_json(
                archive_dir / "derived" / "authoritative.json",
                {
                    "version": "v1",
                    "summarySha256": "sha256:" + ("5" * 64),
                },
            )
            invalid_a = self.ingest_payload(project)
            reasons_a = self.knowledge_entries(project)[0]["lifecycle"].get(
                "publishBlocked"
            ) or []

            derived_path, _ = self.write_valid_authoritative_repair(archive_dir)
            record_path = derived_path.parent / "repair-record.json"
            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["summarySha256"] = "sha256:" + ("6" * 64)
            write_json(record_path, record)
            invalid_b = self.ingest_payload(project)
            reasons_b = self.knowledge_entries(project)[0]["lifecycle"].get(
                "publishBlocked"
            ) or []

            self.assertNotEqual(invalid_a["ingestMode"]["mode"], "no-op")
            self.assertNotEqual(invalid_b["ingestMode"]["mode"], "no-op")
            self.assertNotEqual(
                original["ingestMode"]["inputsHash"],
                invalid_a["ingestMode"]["inputsHash"],
            )
            self.assertNotEqual(
                invalid_a["ingestMode"]["inputsHash"],
                invalid_b["ingestMode"]["inputsHash"],
            )
            self.assertIn("authoritative version missing", reasons_a)
            self.assertIn("repair record summary hash mismatch", reasons_b)
            self.assertNotEqual(reasons_a, reasons_b)

    def test_sync_and_verify_refresh_keep_authoritative_repair_provenance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, archive_dir, original_path = (
                self.make_authoritative_repair_project(Path(tmp))
            )
            _, derived_hash = self.write_valid_authoritative_repair(archive_dir)
            self.ingest_payload(project, no_incremental=True)
            original = json.loads(original_path.read_text(encoding="utf-8"))
            original["changeName"] = "mutated-non-authoritative-original"
            write_json(original_path, original)

            sync = self.run_cli("sync", "--project", str(project))
            self.assertEqual(sync.returncode, 0, sync.stderr)
            sync_payload = json.loads(sync.stdout)
            self.assertTrue(sync_payload["upToDate"], sync_payload["reasons"])

            refresh = self.run_cli("verify", "--project", str(project))
            self.assertEqual(refresh.returncode, 0, refresh.stderr)
            archive_item = self.knowledge_index(project)["archives"]["items"][0]
            self.assertEqual(archive_item["summaryData"], REPAIR_DERIVED_REL)
            self.assertEqual(archive_item["summarySha256"], derived_hash)
            entries = self.knowledge_entries(project)
            self.assertEqual(len(entries), 1)
            self.assertEqual(
                entries[0]["source"]["changeName"],
                "authoritative-repaired-change",
            )

    def test_verify_quarantines_active_repair_after_pointer_or_record_damage(
        self,
    ) -> None:
        for case in ("pointer-hash", "record-hash"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                project, archive_dir, _ = self.make_authoritative_repair_project(
                    Path(tmp)
                )
                self.write_valid_authoritative_repair(archive_dir)
                self.ingest_payload(project, no_incremental=True)
                entry_id = self.promote_only_knowledge_entry(project)
                reason = self.break_valid_authoritative_repair(
                    archive_dir,
                    case,
                )

                verified = self.run_cli(
                    "verify",
                    "--project",
                    str(project),
                )

                self.assertEqual(verified.returncode, 0, verified.stderr)
                knowledge = project / ".harness" / "knowledge"
                entry_paths = list((knowledge / "entries").rglob("*.json"))
                matching_paths = [
                    path
                    for path in entry_paths
                    if json.loads(path.read_text(encoding="utf-8")).get("id")
                    == entry_id
                ]
                self.assertEqual(len(matching_paths), 1)
                entry_path = matching_paths[0]
                entry = json.loads(entry_path.read_text(encoding="utf-8"))
                self.assertEqual(entry["status"], "candidate")
                self.assertEqual(entry_path.parent.name, entry["status"])
                self.assertIn(
                    reason,
                    entry["lifecycle"].get("publishBlocked") or [],
                )
                self.assertFalse(
                    list((knowledge / "entries" / "active").glob("*.json"))
                )

                index = self.knowledge_index(project)
                index_entry = next(
                    item for item in index["entries"] if item["id"] == entry_id
                )
                self.assertEqual(index_entry["status"], entry["status"])
                self.assertEqual(index["stats"]["active"], 0)
                self.assertEqual(
                    index["archives"]["items"][0]["summaryData"],
                    REPAIR_ORIGINAL_REL,
                )

                con = sqlite3.connect(knowledge / "index.sqlite")
                try:
                    row = con.execute(
                        "select status, entry_json from entries where id=?",
                        (entry_id,),
                    ).fetchone()
                finally:
                    con.close()
                self.assertIsNotNone(row)
                sqlite_entry = json.loads(row[1])
                self.assertEqual(row[0], entry["status"])
                self.assertEqual(sqlite_entry["status"], entry["status"])
                self.assertIn(
                    reason,
                    sqlite_entry["lifecycle"].get("publishBlocked") or [],
                )

    def test_query_generates_context_pack_with_relevant_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            change_meta = project / ".harness" / "changes" / "demo-change" / "meta"
            change_meta.mkdir(parents=True)
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)

            result = self.run_cli(
                "query", "--project", str(project), "--query", "异步 AI 检查 job",
                "--change", "demo-change",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            context_pack = Path(payload["contextPack"])
            self.assertTrue(context_pack.exists())
            text = context_pack.read_text(encoding="utf-8")
            self.assertIn("异步 AI 检查 job", text)
            self.assertIn("ai-check-job", text)
            self.assertIn("apps/server/src/registry/store.ts", text)
            self.assertIn("Before planning", text)
            self.assertGreaterEqual(payload["matchCount"], 1)
            self.assertIn("planInput", payload)
            self.assertEqual(payload["planInput"]["kind"], "harness-knowledge-context-pack")
            latest = context_pack.parent / "latest.json"
            self.assertTrue(latest.exists())
            latest_payload = json.loads(latest.read_text(encoding="utf-8"))
            self.assertEqual(latest_payload["contextPack"], str(context_pack))
            self.assertGreaterEqual(len(latest_payload["matchIds"]), 1)
            change_pointer = json.loads(
                (change_meta / "knowledge-context.json").read_text(encoding="utf-8")
            )
            self.assertEqual(change_pointer["changeId"], "demo-change")
            self.assertEqual(change_pointer["contextPack"], str(context_pack))

    def test_query_can_filter_by_source_file_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)

            result = self.run_cli(
                "query",
                "--project",
                str(project),
                "--query",
                "registry",
                "--file",
                "apps/web/components/registry.tsx",
                "--status",
                "candidate",
                "--verbose",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["matchCount"], 1)
            self.assertEqual(payload["filters"]["files"], ["apps/web/components/registry.tsx"])
            self.assertEqual(payload["filters"]["statuses"], ["candidate"])
            for match in payload["matches"]:
                self.assertEqual(match["status"], "candidate")
                self.assertIn("apps/web/components/registry.tsx", match["sourceFiles"])

    def test_sync_detects_missing_current_and_changed_knowledge_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))

            missing = self.run_cli("sync", "--project", str(project))
            self.assertEqual(missing.returncode, 0, missing.stderr)
            missing_payload = json.loads(missing.stdout)
            self.assertFalse(missing_payload["upToDate"])
            self.assertIn("index.json missing", missing_payload["reasons"])

            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            current = self.run_cli("sync", "--project", str(project))
            self.assertEqual(current.returncode, 0, current.stderr)
            current_payload = json.loads(current.stdout)
            self.assertTrue(current_payload["upToDate"])
            self.assertEqual(current_payload["reasons"], [])

            summary = project / ".harness" / "archive" / "2026-06-30-ai-check-job" / "reports" / "final" / "summary-data.json"
            data = json.loads(summary.read_text(encoding="utf-8"))
            data["knownRisks"].append("新增归档风险，知识索引应提示需要刷新")
            write_json(summary, data)

            changed = self.run_cli("sync", "--project", str(project))
            self.assertEqual(changed.returncode, 0, changed.stderr)
            changed_payload = json.loads(changed.stdout)
            self.assertFalse(changed_payload["upToDate"])
            self.assertIn("archive checksum changed", " ".join(changed_payload["reasons"]))

    def test_config_ttl_marks_old_entries_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "sample-project"
            self.add_old_archive_without_commit(project)
            write_json(project / ".harness" / "knowledge" / "config.json", {"staleTtlDays": 1})

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            stale_files = list((project / ".harness" / "knowledge" / "entries" / "stale").glob("*.json"))
            self.assertGreaterEqual(len(stale_files), 1)
            stale_text = "\n".join(path.read_text(encoding="utf-8") for path in stale_files)
            self.assertIn("ttl expired", stale_text)

    def test_audit_reports_top_candidate_and_stale_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp), final_commit="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
            self.add_candidate_archive_without_commit(project)
            (project / "apps" / "server" / "src" / "registry").mkdir(parents=True)
            (project / "apps" / "server" / "src" / "registry" / "store.ts").write_text("export const x = 1;\n", encoding="utf-8")
            self.assertEqual(self.run_git(project, "init").returncode, 0)
            self.assertEqual(self.run_git(project, "config", "user.email", "test@example.com").returncode, 0)
            self.assertEqual(self.run_git(project, "config", "user.name", "Test User").returncode, 0)
            self.assertEqual(self.run_git(project, "add", ".").returncode, 0)
            self.assertEqual(self.run_git(project, "commit", "-m", "initial").returncode, 0)
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)

            result = self.run_cli("audit", "--project", str(project), "--limit", "3")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["limit"], 3)
            self.assertTrue(Path(payload["report"]).exists())
            self.assertGreaterEqual(len(payload["candidateReview"]), 1)
            self.assertGreaterEqual(len(payload["staleReview"]), 1)
            report_text = Path(payload["report"]).read_text(encoding="utf-8")
            self.assertIn("Candidate Review", report_text)
            self.assertIn("Stale Review", report_text)

    def test_followup_archive_marks_older_overlapping_entries_superseded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.add_followup_archive(project)

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            knowledge = project / ".harness" / "knowledge"
            index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
            self.assertGreaterEqual(index["stats"]["superseded"], 1)
            superseded_files = list((knowledge / "entries" / "superseded").glob("*.json"))
            self.assertGreaterEqual(len(superseded_files), 1)
            superseded_text = "\n".join(path.read_text(encoding="utf-8") for path in superseded_files)
            self.assertIn("overlapped by newer archive", superseded_text)
            self.assertTrue((knowledge / "views" / "superseded-items.md").exists())

    def test_conflicting_entries_are_marked_and_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.add_conflicting_archive(project)

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            knowledge = project / ".harness" / "knowledge"
            index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
            self.assertGreaterEqual(index["stats"]["conflicted"], 2)
            conflicted_files = list((knowledge / "entries" / "conflicted").glob("*.json"))
            self.assertGreaterEqual(len(conflicted_files), 2)
            conflicted_text = "\n".join(path.read_text(encoding="utf-8") for path in conflicted_files)
            self.assertIn("potential conflict with", conflicted_text)
            self.assertIn("conflictsWith", conflicted_text)
            view = knowledge / "views" / "conflicted-items.md"
            self.assertTrue(view.exists())
            self.assertIn("Harness Conflicted Knowledge", view.read_text(encoding="utf-8"))

            audit = self.run_cli("audit", "--project", str(project), "--limit", "5")
            self.assertEqual(audit.returncode, 0, audit.stderr)
            payload = json.loads(audit.stdout)
            self.assertGreaterEqual(len(payload["conflictReview"]), 1)
            report_text = Path(payload["report"]).read_text(encoding="utf-8")
            self.assertIn("Conflict Review", report_text)

    def test_promote_moves_candidate_to_active_and_updates_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            index_path = project / ".harness" / "knowledge" / "index.json"
            index = json.loads(index_path.read_text(encoding="utf-8"))
            entry_id = next(entry["id"] for entry in index["entries"] if entry["status"] == "candidate")

            promoted = self.run_cli(
                "promote",
                "--project",
                str(project),
                "--id",
                entry_id,
                "--note",
                "人工确认可作为新需求上下文",
            )

            self.assertEqual(promoted.returncode, 0, promoted.stderr)
            payload = json.loads(promoted.stdout)
            self.assertEqual(payload["status"], "active")
            active_files = list((project / ".harness" / "knowledge" / "entries" / "active").glob("*.json"))
            self.assertEqual(len(active_files), 1)
            active = json.loads(active_files[0].read_text(encoding="utf-8"))
            self.assertEqual(active["id"], entry_id)
            self.assertEqual(active["status"], "active")
            self.assertEqual(active["lifecycle"]["promotionNote"], "人工确认可作为新需求上下文")
            refreshed_index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertEqual(refreshed_index["stats"]["active"], 1)

    def test_ingest_writes_explainable_confidence_scores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))

            ingest = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "candidate").glob("*.json")
            ]
            self.assertTrue(entries)
            for entry in entries:
                confidence = entry.get("confidence")
                self.assertIsInstance(confidence, dict)
                self.assertIsInstance(confidence.get("score"), float)
                self.assertIn(confidence.get("level"), {"low", "medium", "high"})
                self.assertIsInstance(confidence.get("signals"), list)
                self.assertTrue(confidence["signals"])
            index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
            self.assertIn("confidence", index["entries"][0])

    def test_configured_auto_promote_only_activates_high_confidence_long_lived_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            knowledge = project / ".harness" / "knowledge"
            write_json(
                knowledge / "config.json",
                {
                    "autoPromote": {
                        "enabled": True,
                        "minConfidence": 0.82,
                        "allowedTypes": ["requirement", "decision", "api-contract", "pitfall"],
                        "maxPerRun": 10,
                    }
                },
            )

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["ingestMode"]["candidateAutoPromoted"], 1)
            active_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "active").glob("*.json")
            ]
            self.assertTrue(active_entries)
            for entry in active_entries:
                self.assertIn(entry["type"], {"requirement", "decision", "api-contract", "pitfall"})
                self.assertGreaterEqual(entry["confidence"]["score"], 0.82)
                self.assertTrue(entry["lifecycle"]["autoPromoted"])
                self.assertIn("autoPromote", entry["lifecycle"]["promotionNote"])
            self.assertFalse(any(entry["type"] == "implementation" for entry in active_entries))

    def test_confidence_penalizes_stale_and_old_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.add_old_archive_without_commit(project)
            knowledge = project / ".harness" / "knowledge"
            write_json(knowledge / "config.json", {"staleTtlDays": 1})

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            stale_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "stale").glob("*.json")
            ]
            expired = next(
                entry
                for entry in stale_entries
                if any("ttl expired" in reason for reason in entry["lifecycle"].get("staleReasons", []))
            )
            self.assertLess(expired["confidence"]["score"], 0.55)
            self.assertIn("status_stale_penalty", expired["confidence"]["signals"])
            self.assertTrue(any(signal.startswith("age_penalty:") for signal in expired["confidence"]["signals"]))

    def test_auto_creates_enabled_autopromote_config_and_applies_when_index_is_current(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            initial = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(initial.returncode, 0, initial.stderr)
            initial_payload = json.loads(initial.stdout)
            self.assertEqual(initial_payload["ingestMode"]["candidateAutoPromoted"], 0)
            knowledge = project / ".harness" / "knowledge"
            config_path = knowledge / "config.json"
            self.assertFalse(config_path.exists())

            result = self.run_cli("auto", "--project", str(project), "--limit", "5")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["config"]["created"])
            self.assertEqual(payload["config"]["path"], str(config_path))
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertTrue(config["autoPromote"]["enabled"])
            index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
            self.assertGreaterEqual(index["ingestMode"]["candidateAutoPromoted"], 1)
            self.assertGreaterEqual(index["stats"]["active"], 1)
            active_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "active").glob("*.json")
            ]
            self.assertTrue(active_entries)
            self.assertTrue(any(entry["lifecycle"].get("autoPromoted") for entry in active_entries))

    def test_active_review_flags_promoted_entry_without_demoting_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            candidate_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "candidate").glob("*.json")
            ]
            entry_id = next(entry["id"] for entry in candidate_entries if "唯一来源" in entry["body"])
            promoted = self.run_cli(
                "promote",
                "--project",
                str(project),
                "--id",
                entry_id,
                "--note",
                "人工确认 draft.aiChecks 当时是唯一来源",
            )
            self.assertEqual(promoted.returncode, 0, promoted.stderr)
            self.add_conflicting_archive(project)

            ingest_after_conflict = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest_after_conflict.returncode, 0, ingest_after_conflict.stderr)
            audit = self.run_cli("audit", "--project", str(project), "--limit", "5")

            self.assertEqual(audit.returncode, 0, audit.stderr)
            payload = json.loads(audit.stdout)
            self.assertGreaterEqual(len(payload["activeReview"]), 1)
            self.assertEqual(payload["activeReview"][0]["status"], "active")
            self.assertIn("requires manual review", " ".join(payload["activeReview"][0]["reviewReasons"]))
            active = json.loads(next((knowledge / "entries" / "active").glob("*.json")).read_text(encoding="utf-8"))
            self.assertEqual(active["status"], "active")
            view = knowledge / "views" / "active-review.md"
            self.assertTrue(view.exists())
            self.assertIn("Harness Active Review", view.read_text(encoding="utf-8"))

    def test_demote_moves_active_entry_to_stale_after_manual_review(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            index_path = project / ".harness" / "knowledge" / "index.json"
            index = json.loads(index_path.read_text(encoding="utf-8"))
            entry_id = next(entry["id"] for entry in index["entries"] if entry["status"] == "candidate")
            promoted = self.run_cli(
                "promote",
                "--project",
                str(project),
                "--id",
                entry_id,
                "--note",
                "人工确认可作为新需求上下文",
            )
            self.assertEqual(promoted.returncode, 0, promoted.stderr)

            demoted = self.run_cli(
                "demote",
                "--project",
                str(project),
                "--id",
                entry_id,
                "--status",
                "stale",
                "--reason",
                "后续归档替代，人工确认降级",
            )

            self.assertEqual(demoted.returncode, 0, demoted.stderr)
            payload = json.loads(demoted.stdout)
            self.assertEqual(payload["status"], "stale")
            self.assertFalse(list((project / ".harness" / "knowledge" / "entries" / "active").glob("*.json")))
            stale_files = list((project / ".harness" / "knowledge" / "entries" / "stale").glob("*.json"))
            self.assertEqual(len(stale_files), 1)
            stale = json.loads(stale_files[0].read_text(encoding="utf-8"))
            self.assertEqual(stale["id"], entry_id)
            self.assertEqual(stale["status"], "stale")
            self.assertEqual(stale["lifecycle"]["demotionReason"], "后续归档替代，人工确认降级")
            self.assertIn("manual demotion: 后续归档替代，人工确认降级", stale["lifecycle"]["staleReasons"])
            refreshed_index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertEqual(refreshed_index["stats"]["active"], 0)

    def test_configured_active_auto_demote_moves_reviewed_active_to_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            candidate_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "candidate").glob("*.json")
            ]
            entry_id = next(entry["id"] for entry in candidate_entries if "唯一来源" in entry["body"])
            promoted = self.run_cli(
                "promote",
                "--project",
                str(project),
                "--id",
                entry_id,
                "--note",
                "人工确认 draft.aiChecks 当时是唯一来源",
            )
            self.assertEqual(promoted.returncode, 0, promoted.stderr)
            write_json(
                knowledge / "config.json",
                {
                    "activeLifecycle": {
                        "autoDemote": True,
                        "targetStatus": "stale",
                    }
                },
            )
            self.add_conflicting_archive(project)

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["ingestMode"]["activeAutoDemoted"], 1)
            self.assertFalse(list((knowledge / "entries" / "active").glob("*.json")))
            stale_files = list((knowledge / "entries" / "stale").glob("*.json"))
            stale_entries = [json.loads(path.read_text(encoding="utf-8")) for path in stale_files]
            demoted = next(entry for entry in stale_entries if entry["id"] == entry_id)
            self.assertTrue(demoted["lifecycle"]["autoDemoted"])
            self.assertIn("activeLifecycle auto-demotion", demoted["lifecycle"]["demotionReason"])
            self.assertIn("auto demotion:", "\n".join(demoted["lifecycle"]["staleReasons"]))

            current = self.run_cli("sync", "--project", str(project))
            self.assertEqual(current.returncode, 0, current.stderr)
            current_payload = json.loads(current.stdout)
            self.assertTrue(
                current_payload["upToDate"],
                "an ingest that mutates preserved lifecycle state must persist its final inputs hash",
            )
            self.assertEqual(current_payload["reasons"], [])

    def test_configured_validators_mark_active_stale_when_symbol_disappears(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            candidate_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "candidate").glob("*.json")
            ]
            entry_id = next(entry["id"] for entry in candidate_entries if "唯一来源" in entry["body"])
            promoted = self.run_cli(
                "promote",
                "--project",
                str(project),
                "--id",
                entry_id,
                "--note",
                "人工确认 draft.aiChecks 当时是唯一来源",
            )
            self.assertEqual(promoted.returncode, 0, promoted.stderr)
            active_path = next((knowledge / "entries" / "active").glob("*.json"))
            active_entry = json.loads(active_path.read_text(encoding="utf-8"))
            active_entry["validators"] = [
                {
                    "type": "symbol_exists",
                    "symbol": "draft.aiChecks",
                    "files": ["apps/web/components/registry.tsx"],
                    "description": "registry view still reads draft.aiChecks",
                }
            ]
            write_json(active_path, active_entry)
            write_json(
                knowledge / "config.json",
                {
                    "knowledgeValidation": {
                        "enabled": True,
                        "autoDemoteActive": True,
                    }
                },
            )

            source_file.write_text("export const source = aiJobResult;\n", encoding="utf-8")
            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["ingestMode"]["validationAutoDemoted"], 1)
            self.assertFalse(list((knowledge / "entries" / "active").glob("*.json")))
            stale_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "stale").glob("*.json")
            ]
            demoted = next(entry for entry in stale_entries if entry["id"] == entry_id)
            validation = demoted["lifecycle"]["validation"]
            self.assertEqual(validation["status"], "failed")
            self.assertIn("validator failed:", "\n".join(demoted["lifecycle"]["staleReasons"]))

    def test_verify_command_reports_validator_results_without_reingesting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            candidate_path = next((knowledge / "entries" / "candidate").glob("*.json"))
            entry = json.loads(candidate_path.read_text(encoding="utf-8"))
            entry["validators"] = [
                {
                    "type": "file_contains",
                    "path": "apps/web/components/registry.tsx",
                    "pattern": "draft.aiChecks",
                    "description": "registry view still contains draft.aiChecks",
                }
            ]
            write_json(candidate_path, entry)

            result = self.run_cli("verify", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["checked"], 1)
            self.assertEqual(payload["passed"], 1)
            self.assertEqual(payload["failed"], 0)
            self.assertEqual(payload["entries"][0]["id"], entry["id"])
            reports = list((knowledge / "reports").glob("verification-report-*.md"))
            self.assertEqual(len(reports), 1)
            self.assertIn("registry view still contains", reports[0].read_text(encoding="utf-8"))

    def test_verify_preserves_sqlite_entries_without_file_copies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            sqlite_path = knowledge / "index.sqlite"
            entry_path = next((knowledge / "entries" / "candidate").glob("*.json"))
            entry = json.loads(entry_path.read_text(encoding="utf-8"))
            virtual = json.loads(json.dumps(entry, ensure_ascii=False))
            virtual["id"] = entry["id"] + ".virtual"
            virtual["title"] = entry["title"] + " virtual"
            virtual["summary"] = entry["summary"] + " virtual"

            con = sqlite3.connect(sqlite_path)
            try:
                con.execute(
                    """
                    insert into entries (
                      id, project_id, type, status, title, summary, body, source_archive,
                      source_commit, source_files_json, keywords_json, entry_json
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        virtual["id"],
                        virtual["projectId"],
                        virtual["type"],
                        virtual["status"],
                        virtual["title"],
                        virtual["summary"],
                        virtual["body"],
                        virtual["source"]["archive"],
                        virtual["source"]["sourceCommit"],
                        json.dumps(virtual["scope"]["sourceFiles"], ensure_ascii=False),
                        json.dumps(virtual["keywords"], ensure_ascii=False),
                        json.dumps(virtual, ensure_ascii=False),
                    ),
                )
                con.commit()
            finally:
                con.close()

            result = self.run_cli("verify", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
            self.assertTrue(any(item["id"] == virtual["id"] for item in index["entries"]))

    def test_suggest_validators_reports_candidates_without_applying(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            candidate_path = next((knowledge / "entries" / "candidate").glob("*.json"))
            before = json.loads(candidate_path.read_text(encoding="utf-8"))
            self.assertNotIn("validators", before)

            result = self.run_cli("suggest-validators", "--project", str(project), "--limit", "5")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["suggested"], 1)
            self.assertEqual(payload["applied"], 0)
            suggestion_text = json.dumps(payload["entries"], ensure_ascii=False)
            self.assertIn("file_exists", suggestion_text)
            self.assertIn("draft.aiChecks", suggestion_text)
            after = json.loads(candidate_path.read_text(encoding="utf-8"))
            self.assertNotIn("validators", after)
            reports = list((knowledge / "reports").glob("validator-suggestions-*.md"))
            self.assertEqual(len(reports), 1)

    def test_suggest_validators_apply_enables_verify_to_check_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"

            suggested = self.run_cli("suggest-validators", "--project", str(project), "--limit", "5", "--apply")
            self.assertEqual(suggested.returncode, 0, suggested.stderr)
            suggestion_payload = json.loads(suggested.stdout)
            self.assertGreaterEqual(suggestion_payload["applied"], 1)
            verify = self.run_cli("verify", "--project", str(project))

            self.assertEqual(verify.returncode, 0, verify.stderr)
            verify_payload = json.loads(verify.stdout)
            self.assertGreaterEqual(verify_payload["checked"], 1)
            self.assertGreaterEqual(verify_payload["passed"], 1)
            applied_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "candidate").glob("*.json")
                if "validators" in json.loads(path.read_text(encoding="utf-8"))
            ]
            self.assertTrue(applied_entries)

    def test_auto_no_apply_suggestions_opt_out(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")

            result = self.run_cli(
                "auto",
                "--project",
                str(project),
                "--limit",
                "5",
                "--no-apply-suggestions",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["sync"]["upToDate"])
            self.assertGreaterEqual(payload["suggestions"]["suggested"], 1)
            self.assertEqual(payload["suggestions"]["applied"], 0)
            self.assertFalse(payload["mode"]["applySuggestions"])
            self.assertEqual(payload["verification"]["checked"], 0)
            knowledge = project / ".harness" / "knowledge"
            entries_with_validators = [
                path
                for path in (knowledge / "entries" / "candidate").glob("*.json")
                if "validators" in json.loads(path.read_text(encoding="utf-8"))
            ]
            self.assertFalse(entries_with_validators)

    def test_auto_default_applies_suggestions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")

            result = self.run_cli(
                "auto",
                "--project",
                str(project),
                "--limit",
                "5",
                "--suggest-status",
                "candidate",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["mode"]["applySuggestions"])
            self.assertGreaterEqual(payload["suggestions"]["applied"], 1)
            self.assertGreaterEqual(payload["verification"]["checked"], 1)
            self.assertGreaterEqual(payload["lifecycle"]["validatorsApplied"], 1)

    def test_auto_bootstraps_full_default_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            result = self.run_cli("auto", "--project", str(project))
            self.assertEqual(result.returncode, 0, result.stderr)
            config_path = project / ".harness" / "knowledge" / "config.json"
            self.assertTrue(config_path.exists())
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertTrue(config["activeLifecycle"]["autoDemote"])
            self.assertTrue(config["knowledgeValidation"]["autoDemoteActive"])
            self.assertEqual(config["judge"]["maxCandidatesPerRun"], 100)
            self.assertEqual(config["autoPromote"]["minConfidence"], 0.82)

    def test_auto_apply_suggestions_writes_validators_and_verifies_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_file = project / "apps" / "web" / "components" / "registry.tsx"
            source_file.parent.mkdir(parents=True)
            source_file.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")

            result = self.run_cli(
                "auto",
                "--project",
                str(project),
                "--limit",
                "5",
                "--suggest-status",
                "candidate",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["suggestions"]["applied"], 1)
            self.assertGreaterEqual(payload["verification"]["checked"], 1)
            self.assertGreaterEqual(payload["verification"]["passed"], 1)
            self.assertTrue(payload["sync"]["upToDate"])

    @unittest.skipUnless(
        FIXTURE_PROJECT.exists(),
        "mcp-eval-project fixture not committed (pre-existing, cluster 6b hygiene: ERROR -> SKIP)",
    )
    def test_mcp_evaluation_fixture_is_stable_and_queryable(self) -> None:
        self.assertTrue(EVALUATION_XML.exists())
        root = ET.parse(EVALUATION_XML).getroot()
        pairs = root.findall("qa_pair")
        self.assertEqual(len(pairs), 10)
        for pair in pairs:
            self.assertTrue(pair.findtext("question", "").strip())
            self.assertTrue(pair.findtext("answer", "").strip())

        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "mcp-eval-project"
            shutil.copytree(FIXTURE_PROJECT, project)
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            query = self.run_cli(
                "query",
                "--project",
                str(project),
                "--query",
                "billing reconciliation source of truth",
                "--limit",
                "5",
            )
            self.assertEqual(query.returncode, 0, query.stderr)
            payload = json.loads(query.stdout)
            text = json.dumps(payload, ensure_ascii=False)
            self.assertIn("LedgerReconciler", text)

    def test_git_repo_missing_source_commit_has_specific_stale_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp), final_commit="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
            (project / "apps" / "server" / "src" / "registry").mkdir(parents=True)
            (project / "apps" / "server" / "src" / "registry" / "store.ts").write_text("export const x = 1;\n", encoding="utf-8")
            self.assertEqual(self.run_git(project, "init").returncode, 0)
            self.assertEqual(self.run_git(project, "config", "user.email", "test@example.com").returncode, 0)
            self.assertEqual(self.run_git(project, "config", "user.name", "Test User").returncode, 0)
            self.assertEqual(self.run_git(project, "add", ".").returncode, 0)
            self.assertEqual(self.run_git(project, "commit", "-m", "initial").returncode, 0)

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            stale_files = list((project / ".harness" / "knowledge" / "entries" / "stale").glob("*.json"))
            self.assertGreaterEqual(len(stale_files), 1)
            stale_text = "\n".join(path.read_text(encoding="utf-8") for path in stale_files)
            self.assertIn("source commit missing from local git history", stale_text)

    def add_long_name_archive(self, project: Path) -> None:
        archive = (
            project
            / ".harness"
            / "archive"
            / "2026-07-01-skill-center-per-agent-version-implementation-long-name-archive"
            / "reports"
            / "final"
            / "summary-data.json"
        )
        write_json(
            archive,
            {
                "schemaVersion": "2.1",
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "changeName": "skill-center-per-agent-version-implementation-long-name-archive",
                "businessGoal": "长归档名验证 entry 文件名末尾哈希不被 72 字符截断。",
                "finalStatus": "OK",
                "finalCommit": "long1234",
                "baseCommit": "base0001",
                "changedFiles": [
                    {
                        "path": "apps/server/src/skill/center/per-agent-store.ts",
                        "summary": "per-agent skill 状态机字段",
                    },
                    {
                        "path": "apps/server/src/skill/center/per-agent-router.ts",
                        "summary": "per-agent skill 路由入口",
                    },
                ],
                "maintenanceNotes": [],
                "knownRisks": [],
                "manualActions": [],
            },
        )

    def _import_harness_knowledge(self):
        import importlib

        sys.path.insert(0, str(SCRIPT.parent))
        try:
            import harness_knowledge

            return importlib.reload(harness_knowledge)
        finally:
            sys.path.pop(0)

    def test_long_archive_name_does_not_collapse_entries_into_one_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "long-name-project"
            self.add_long_name_archive(project)

            result = self.run_cli("ingest", "--project", str(project))

            self.assertEqual(result.returncode, 0, result.stderr)
            knowledge = project / ".harness" / "knowledge"
            index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
            manifest_count = len(index["entries"])
            self.assertGreaterEqual(manifest_count, 2)
            disk_count = sum(1 for _ in (knowledge / "entries").rglob("*.json"))
            self.assertEqual(
                disk_count,
                manifest_count,
                f"filename collision: disk={disk_count} < manifest={manifest_count}",
            )

    def test_collision_guard_records_failure_without_silent_overwrite(self) -> None:
        from unittest import mock

        module = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "long-name-project"
            self.add_long_name_archive(project)

            with mock.patch.object(
                module, "entry_filename", lambda entry: "collision.json", create=True
            ):
                index = module.build_index(project, incremental=False)

            failures = index.get("failures", [])
            collision_failures = [
                f for f in failures if f.get("reason") == "filename collision"
            ]
            self.assertGreaterEqual(
                len(collision_failures),
                1,
                f"expected filename collision failure, got: {failures}",
            )
            collision_files = list(
                (project / ".harness" / "knowledge" / "entries").rglob("collision.json")
            )
            self.assertEqual(len(collision_files), 1)

    def test_entry_id_collision_guard_rejects_different_payloads(self) -> None:
        module = self._import_harness_knowledge()
        first = {
            "id": "sample.archive.decision.deadbeef00",
            "body": "first",
            "source": {"archive": ".harness/archive/a"},
        }
        second = {
            "id": first["id"],
            "body": "second",
            "source": {"archive": ".harness/archive/a"},
        }

        with self.assertRaisesRegex(ValueError, "ENTRY_ID_COLLISION"):
            module.assert_unique_entry_ids([first, second])

    def test_archive_cache_key_survives_path_only_migration(self) -> None:
        module = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "project"
            knowledge = project / ".harness" / "knowledge"
            old = (
                project / ".harness" / "archive" / "old-name"
                / "reports" / "final" / "summary-data.json"
            )
            new = (
                project / ".harness" / "archive" / "new-name"
                / "reports" / "final" / "summary-data.json"
            )

            self.assertEqual(
                module.archive_entry_cache_path(
                    project, knowledge, old, "a" * 64
                ),
                module.archive_entry_cache_path(
                    project, knowledge, new, "a" * 64
                ),
            )

    def test_entry_filename_preserves_full_hash_suffix(self) -> None:
        module = self._import_harness_knowledge()
        self.assertTrue(hasattr(module, "entry_filename"), "entry_filename helper missing")
        name = module.entry_filename(
            {"id": "proj.2026-07-01-long-arch.impl.58063efb81"}
        )
        self.assertTrue(name.endswith("-58063efb81.json"), f"hash suffix lost: {name}")

    def test_entry_filename_keeps_hash_when_prefix_exceeds_limit(self) -> None:
        module = self._import_harness_knowledge()
        long_prefix = "proj." + ("a" * 85)
        entry_id = long_prefix + ".impl.abc123def0"
        name = module.entry_filename({"id": entry_id})
        self.assertTrue(name.endswith("-abc123def0.json"), f"hash lost when prefix>72: {name}")

    def test_entry_filename_falls_back_when_id_has_no_hash_segment(self) -> None:
        module = self._import_harness_knowledge()
        name = module.entry_filename({"id": "nohash"})
        hash_part = name.rsplit("-", 1)[-1].removesuffix(".json")
        self.assertEqual(len(hash_part), 10, f"expected 10-char fallback hash: {name}")

    def test_entry_filename_falls_back_when_hash_segment_too_short(self) -> None:
        module = self._import_harness_knowledge()
        name = module.entry_filename({"id": "proj.arch.impl.ab"})
        hash_part = name.rsplit("-", 1)[-1].removesuffix(".json")
        self.assertEqual(len(hash_part), 10, f"expected fallback hash for short segment: {name}")

    def test_entry_filename_sanitizes_digest_with_special_chars(self) -> None:
        module = self._import_harness_knowledge()
        # 末段 "ab<cd>e" 长度 6（≥6）但含文件系统非法字符 <>，应被清理而非原样拼入
        name = module.entry_filename({"id": "proj.arch.impl.ab<cd>e"})
        self.assertNotIn("<", name, f"digest contains illegal '<': {name}")
        self.assertNotIn(">", name, f"digest contains illegal '>': {name}")
        self.assertTrue(name.endswith(".json"), f"missing .json suffix: {name}")

    def _write_entry(self, knowledge: Path, entry: dict) -> Path:
        status = entry["status"]
        path = knowledge / "entries" / status / f"{entry['id'].replace('.', '-')}.json"
        write_json(path, entry)
        return path

    def _minimal_entry(
        self,
        entry_id: str,
        *,
        status: str = "candidate",
        entry_type: str = "decision",
        title: str = "title",
        body: str = "body",
        archive: str = ".harness/archive/2026-06-30-sample",
        source_files: list[str] | None = None,
        keywords: list[str] | None = None,
    ) -> dict:
        return {
            "schemaVersion": 1,
            "id": entry_id,
            "projectId": "sample",
            "type": entry_type,
            "status": status,
            "title": title,
            "summary": body[:40],
            "body": body,
            "keywords": keywords or ["sample"],
            "source": {
                "archive": archive,
                "summaryData": archive + "/reports/final/summary-data.json",
                "summarySha256": "abc",
                "sourceCommit": "",
                "baseCommit": "",
                "changeName": "sample",
                "finalStatus": "OK",
            },
            "scope": {"sourceFiles": source_files or ["apps/server/src/registry/store.ts"]},
            "lifecycle": {
                "createdAt": "2026-06-30T00:00:00+08:00",
                "verifiedAt": "2026-06-30T00:00:00+08:00",
                "lastCheckedAt": "2026-06-30T00:00:00+08:00",
                "confidence": "medium",
                "supersedes": [],
                "supersededBy": None,
                "conflictsWith": [],
                "staleReasons": [],
            },
        }

    def test_dedupe_merges_near_duplicates_and_keeps_provenance_union(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            base = self._minimal_entry(
                "sample.dup.decision.aaaaaaaaaa",
                title="AI job 复用 LlmClient",
                body="AI 检查 job 复用 LlmClient，不新增 provider 抽象。",
                keywords=["llm"],
                source_files=["apps/server/src/registry/store.ts"],
            )
            near = self._minimal_entry(
                "sample.dup.decision.bbbbbbbbbb",
                title="AI job 复用 LlmClient",
                body="AI 检查 job 复用 LlmClient，不新增 provider 抽象层。",
                keywords=["client"],
                source_files=["apps/web/components/registry.tsx"],
            )
            self._write_entry(knowledge, base)
            self._write_entry(knowledge, near)
            # Refresh index so CLI can load the planted entries.
            module = self._import_harness_knowledge()
            module.refresh_outputs_from_entry_files(project, knowledge)

            result = self.run_cli("dedupe", "--project", str(project), "--json")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["merged"], 1)
            superseded = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "superseded").glob("*.json")
            ]
            merged = [entry for entry in superseded if "near-duplicate merged into" in "\n".join(entry["lifecycle"].get("staleReasons", []))]
            self.assertGreaterEqual(len(merged), 1)
            kept_id = merged[0]["lifecycle"]["supersededBy"]
            kept_path = next(
                path
                for status in ["candidate", "active", "stale", "conflicted"]
                for path in (knowledge / "entries" / status).glob("*.json")
                if json.loads(path.read_text(encoding="utf-8")).get("id") == kept_id
            )
            kept = json.loads(kept_path.read_text(encoding="utf-8"))
            self.assertTrue({"llm", "client"} <= set(kept.get("keywords") or []))
            self.assertTrue(
                {"apps/server/src/registry/store.ts", "apps/web/components/registry.tsx"}
                <= set(kept.get("scope", {}).get("sourceFiles") or [])
            )
            self.assertIn(merged[0]["id"], kept["lifecycle"].get("mergedFrom") or [])

    def test_auto_supersede_only_touches_clear_same_topic_evolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "auto-supersede-project"
            knowledge = project / ".harness" / "knowledge"
            for status in ["candidate", "active", "stale", "superseded", "conflicted"]:
                (knowledge / "entries" / status).mkdir(parents=True, exist_ok=True)
            write_json(knowledge / "index.json", {"schemaVersion": 1, "entries": [], "stats": {}})
            older = self._minimal_entry(
                "sample.topic.decision.old0000001",
                title="registry store 状态字段",
                body="registry store 使用旧版 AI job 状态字段。",
                archive=".harness/archive/2026-06-01-old-topic",
                source_files=["apps/server/src/registry/store.ts"],
            )
            newer = self._minimal_entry(
                "sample.topic.decision.new0000001",
                title="registry store 状态字段",
                body="registry store 使用新版 AI job 状态字段，兼容旧字段。",
                archive=".harness/archive/2026-07-01-new-topic",
                source_files=["apps/server/src/registry/store.ts", "apps/web/components/registry.tsx"],
            )
            unrelated = self._minimal_entry(
                "sample.topic.risk.other00001",
                entry_type="risk",
                title="billing 风险",
                body="计费 provider key 需要单独治理。",
                archive=".harness/archive/2026-07-02-other",
                source_files=["apps/billing/provider.ts"],
            )
            conflict_old = self._minimal_entry(
                "sample.topic.decision.confold01",
                title="draft.aiChecks 唯一来源",
                body="draft.aiChecks 是前后端展示结果的唯一来源。",
                archive=".harness/archive/2026-06-15-conflict-old",
                source_files=["apps/web/components/registry.tsx"],
            )
            conflict_new = self._minimal_entry(
                "sample.topic.decision.confnew01",
                title="改为 aiJobResult",
                body="不再使用 draft.aiChecks 作为唯一来源，改为 server aiJobResult 替代旧展示结果。",
                archive=".harness/archive/2026-07-03-conflict-new",
                source_files=["apps/web/components/registry.tsx"],
            )
            for entry in [older, newer, unrelated, conflict_old, conflict_new]:
                self._write_entry(knowledge, entry)
            module = self._import_harness_knowledge()
            module.refresh_outputs_from_entry_files(project, knowledge)

            result = self.run_cli("auto-supersede", "--project", str(project), "--json")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["superseded"], 1)
            action_ids = {item["id"] for item in payload["actions"]}
            self.assertIn(older["id"], action_ids)
            self.assertNotIn(unrelated["id"], action_ids)
            self.assertNotIn(conflict_old["id"], action_ids)
            self.assertNotIn(conflict_new["id"], action_ids)
            older_after = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "superseded").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == older["id"]
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(older_after["lifecycle"]["supersededBy"], newer["id"])
            unrelated_after = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "candidate").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == unrelated["id"]
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(unrelated_after["status"], "candidate")

    def test_reverify_stale_restores_or_keeps_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            source_ok = project / "apps" / "web" / "components" / "registry.tsx"
            source_ok.parent.mkdir(parents=True)
            source_ok.write_text("export const source = draft.aiChecks;\n", encoding="utf-8")
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"

            restore_entry = self._minimal_entry(
                "sample.reverify.decision.rest0001",
                status="stale",
                title="可恢复 stale",
                body="文件仍存在时应恢复。",
            )
            restore_entry["lifecycle"]["previousStatus"] = "active"
            restore_entry["lifecycle"]["demotedAt"] = "2026-07-01T00:00:00+08:00"
            restore_entry["validators"] = [
                {
                    "type": "file_exists",
                    "path": "apps/web/components/registry.tsx",
                    "description": "registry file exists",
                },
                {
                    "type": "file_contains",
                    "path": "apps/web/components/registry.tsx",
                    "pattern": "draft.aiChecks",
                    "description": "contains draft.aiChecks",
                },
            ]
            keep_entry = self._minimal_entry(
                "sample.reverify.decision.keep0001",
                status="stale",
                title="保持 stale",
                body="文件缺失时应保持 stale。",
                archive=".harness/archive/2026-07-02-keep-stale",
            )
            keep_entry["lifecycle"]["previousStatus"] = "candidate"
            keep_entry["validators"] = [
                {
                    "type": "file_exists",
                    "path": "apps/missing/not-there.ts",
                    "description": "missing file",
                }
            ]
            self._write_entry(knowledge, restore_entry)
            self._write_entry(knowledge, keep_entry)
            module = self._import_harness_knowledge()
            module.refresh_outputs_from_entry_files(project, knowledge)

            result = self.run_cli("reverify-stale", "--project", str(project), "--json")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertGreaterEqual(payload["restored"], 1)
            self.assertGreaterEqual(payload["keptStale"], 1)
            restored_ids = {item["id"] for item in payload["entries"]["restored"]}
            kept_ids = {item["id"] for item in payload["entries"]["keptStale"]}
            self.assertIn(restore_entry["id"], restored_ids)
            self.assertIn(keep_entry["id"], kept_ids)
            active = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "active").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == restore_entry["id"]
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(active["status"], "active")
            kept = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "stale").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == keep_entry["id"]
                ).read_text(encoding="utf-8")
            )
            self.assertIn("reverify failed", "\n".join(kept["lifecycle"].get("staleReasons", [])))

    def test_judge_export_apply_rollback_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            candidate = self._minimal_entry(
                "sample.judge.decision.cand00001",
                title="待 promote 候选",
                body="这条候选知识需要 AI 裁决 promote。",
            )
            conflict_a = self._minimal_entry(
                "sample.judge.decision.confla001",
                status="conflicted",
                title="冲突 A",
                body="draft.aiChecks 是唯一来源。",
                archive=".harness/archive/2026-06-20-judge-a",
            )
            conflict_b = self._minimal_entry(
                "sample.judge.decision.conflb001",
                status="conflicted",
                title="冲突 B",
                body="不再使用 draft.aiChecks，改为 aiJobResult。",
                archive=".harness/archive/2026-07-04-judge-b",
            )
            conflict_a["lifecycle"]["conflictsWith"] = [conflict_b["id"]]
            conflict_b["lifecycle"]["conflictsWith"] = [conflict_a["id"]]
            deferred = self._minimal_entry(
                "sample.judge.decision.defer0001",
                title="defer candidate",
                body="Review this candidate after related sources stabilize.",
            )
            for entry in [candidate, conflict_a, conflict_b, deferred]:
                self._write_entry(knowledge, entry)
            module = self._import_harness_knowledge()
            module.refresh_outputs_from_entry_files(project, knowledge)

            export_path = Path(tmp) / "judge-export.json"
            exported = self.run_cli(
                "judge",
                "--project",
                str(project),
                "--export",
                str(export_path),
                "--json",
            )
            self.assertEqual(exported.returncode, 0, exported.stderr)
            export_payload = json.loads(exported.stdout)
            self.assertTrue(export_path.exists())
            self.assertGreaterEqual(export_payload["counts"]["promoteCandidates"], 1)
            self.assertGreaterEqual(export_payload["counts"]["conflicts"], 1)

            before_candidate = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "candidate").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == candidate["id"]
                ).read_text(encoding="utf-8")
            )
            decisions_path = Path(tmp) / "decisions.json"
            write_json(
                decisions_path,
                {
                    "decisions": [
                        {"id": candidate["id"], "action": "promote", "reason": "AI 确认可提升"},
                        {
                            "id": conflict_a["id"],
                            "action": "supersede",
                            "supersededBy": conflict_b["id"],
                            "reason": "B 取代 A",
                        },
                        {"id": conflict_b["id"], "action": "keep-conflict", "reason": "保留观察"},
                        {
                            "id": deferred["id"],
                            "action": "defer",
                            "reason": "wait for source changes",
                            "reviewAfter": "2099-01-01",
                        },
                    ]
                },
            )
            applied = self.run_cli(
                "judge",
                "--project",
                str(project),
                "--apply",
                str(decisions_path),
                "--json",
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            apply_payload = json.loads(applied.stdout)
            self.assertEqual(apply_payload["applied"], 4)
            self.assertTrue(Path(apply_payload["decisionsLedger"]).exists())
            judgement_path = Path(apply_payload["judgement"])
            self.assertTrue(judgement_path.exists())
            judgement = json.loads(judgement_path.read_text(encoding="utf-8"))
            self.assertEqual(len(judgement["applied"]), 4)
            self.assertEqual(judgement["applied"][0]["before"]["status"], "candidate")

            promoted = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "active").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == candidate["id"]
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(promoted["status"], "active")

            rebuilt = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
            kept_conflict = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "conflicted").glob("*.json")
                if json.loads(path.read_text(encoding="utf-8")).get("id") == conflict_b["id"]
            ]
            self.assertEqual(kept_conflict[0]["lifecycle"]["judgeAction"], "keep-conflict")
            deferred_entries = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (knowledge / "entries" / "candidate").glob("*.json")
                if json.loads(path.read_text(encoding="utf-8")).get("id") == deferred["id"]
            ]
            self.assertEqual(deferred_entries[0]["lifecycle"]["judgeAction"], "defer")
            exported_again = self.run_cli(
                "judge", "--project", str(project),
                "--export", str(Path(tmp) / "judge-export-again.json"), "--json",
            )
            self.assertEqual(exported_again.returncode, 0, exported_again.stderr)
            pending = json.loads(exported_again.stdout)
            self.assertFalse(any(
                item.get("id") == deferred["id"]
                for item in pending["promoteCandidates"]
            ))

            rolled = self.run_cli(
                "rollback",
                "--project",
                str(project),
                "--judgement",
                str(judgement_path),
                "--json",
            )
            self.assertEqual(rolled.returncode, 0, rolled.stderr)
            rollback_payload = json.loads(rolled.stdout)
            self.assertEqual(rollback_payload["restored"], 4)
            restored_candidate = json.loads(
                next(
                    path
                    for path in (knowledge / "entries" / "candidate").glob("*.json")
                    if json.loads(path.read_text(encoding="utf-8")).get("id") == candidate["id"]
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(restored_candidate["status"], before_candidate["status"])
            self.assertEqual(restored_candidate["title"], before_candidate["title"])

    def test_judge_apply_requires_force_when_manual_review_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            ingest = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(ingest.returncode, 0, ingest.stderr)
            knowledge = project / ".harness" / "knowledge"
            write_json(
                project / ".harness" / "config" / "harness.json",
                {"schemaVersion": 1, "knowledge": {"manualReview": True}},
            )
            candidate = self._minimal_entry(
                "sample.force.decision.cand00001",
                title="manualReview 候选",
                body="需要 --force 才能 apply。",
            )
            self._write_entry(knowledge, candidate)
            module = self._import_harness_knowledge()
            module.refresh_outputs_from_entry_files(project, knowledge)
            decisions_path = Path(tmp) / "decisions.json"
            write_json(
                decisions_path,
                {"decisions": [{"id": candidate["id"], "action": "promote", "reason": "force test"}]},
            )

            blocked = self.run_cli(
                "judge",
                "--project",
                str(project),
                "--apply",
                str(decisions_path),
                "--json",
            )
            self.assertEqual(blocked.returncode, 1, blocked.stdout)
            self.assertIn("manualReview", blocked.stderr)

            forced = self.run_cli(
                "judge",
                "--project",
                str(project),
                "--apply",
                str(decisions_path),
                "--force",
                "--json",
            )
            self.assertEqual(forced.returncode, 0, forced.stderr)
            payload = json.loads(forced.stdout)
            self.assertEqual(payload["applied"], 1)

    def test_ingest_runs_near_dedupe_and_keeps_old_index_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            # Plant a second near-duplicate decision via an extra archive with almost identical note.
            archive = project / ".harness" / "archive" / "2026-06-30-ai-check-job-dup" / "reports" / "final" / "summary-data.json"
            write_json(
                archive,
                {
                    "schemaVersion": "2.1",
                    "reportPipeline": VERIFIED_REPORT_PIPELINE,
                "reportPipeline": VERIFIED_REPORT_PIPELINE,
                    "changeName": "ai-check-job-dup",
                    "businessGoal": "实现异步 AI 检查 job，复用现有 LlmClient 和 draft.aiChecks 结果展示。",
                    "finalStatus": "OK",
                    "finalCommit": "abc1234",
                    "baseCommit": "base0001",
                    "changedFiles": [
                        {
                            "path": "apps/server/src/registry/store.ts",
                            "summary": "新增 AI job 状态机和持久化字段",
                        }
                    ],
                    "maintenanceNotes": [
                        "AI 检查 job 复用 LlmClient，不新增 provider 抽象。",
                    ],
                    "knownRisks": [],
                    "manualActions": [],
                },
            )
            # Force same archive name group by rewriting the planted archive folder name is different,
            # so near-dedupe within same archive is validated via module helper + ingestMode field.
            result = self.run_cli("ingest", "--project", str(project))
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertIn("nearDuplicatesMerged", payload["ingestMode"])
            self.assertIn("stats", payload)
            self.assertIn("candidate", payload["stats"])

            module = self._import_harness_knowledge()
            same_archive_entries = [
                self._minimal_entry(
                    "sample.ingest.decision.dupaaaaa1",
                    title="同一归档近重复 A",
                    body="同一归档内的近重复决策正文内容几乎完全一致。",
                    archive=".harness/archive/2026-06-30-same",
                ),
                self._minimal_entry(
                    "sample.ingest.decision.dupbbbbb1",
                    title="同一归档近重复 A",
                    body="同一归档内的近重复决策正文内容几乎完全一致！",
                    archive=".harness/archive/2026-06-30-same",
                    keywords=["extra"],
                    source_files=["apps/web/components/registry.tsx"],
                ),
            ]
            near = module.dedupe_near_duplicates(same_archive_entries)
            self.assertEqual(near["merged"], 1)
            statuses = {entry["id"]: entry["status"] for entry in same_archive_entries}
            self.assertEqual(sum(1 for status in statuses.values() if status == "superseded"), 1)


    def _enqueue_pending(self, project: Path, archive_id: str) -> Path:
        outbox = project / ".harness" / "knowledge" / "maintenance-outbox"
        pending = outbox / "pending" / f"{archive_id}.json"
        write_json(
            pending,
            {
                "schemaVersion": 1,
                "archiveId": archive_id,
                "archivePath": f".harness/archive/{archive_id}",
                "archiveManifestHash": "",
                "status": "pending",
                "attempts": 0,
                "createdAt": "2026-07-10T00:00:00+08:00",
                "lastError": None,
            },
        )
        return outbox

    def test_maintain_claims_and_completes_pending_item(self) -> None:
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)
            result = hk.maintain_knowledge(project, archive_id)
            self.assertTrue(result["ok"], msg=result)
            self.assertIn(result["status"], {"completed", "pending-judge"})
            self.assertFalse((outbox / "pending" / f"{archive_id}.json").exists())
            self.assertFalse((outbox / "running" / f"{archive_id}.json").exists())
            self.assertTrue(any((outbox / state / f"{archive_id}.json").exists() for state in ("completed", "pending-judge")))

    def test_maintain_drain_processes_pending_items_in_one_call(self) -> None:
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self._enqueue_pending(project, "2026-06-30-ai-check-job")
            self._enqueue_pending(project, "2026-07-01-ai-check-job")
            result = hk.drain_maintenance_outbox(project)
            self.assertTrue(result["ok"], msg=result)
            self.assertEqual(result["processed"], 2)
            self.assertEqual(len(result["results"]), 2)

    def test_maintain_failure_moves_item_to_failed_and_can_retry(self) -> None:
        from unittest import mock

        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)
            with mock.patch.object(hk, "build_index", side_effect=RuntimeError("boom")):
                result = hk.maintain_knowledge(project, archive_id)
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "failed")
            failed_path = outbox / "failed" / f"{archive_id}.json"
            self.assertTrue(failed_path.exists())
            item = json.loads(failed_path.read_text(encoding="utf-8"))
            self.assertEqual(item["status"], "failed")
            self.assertEqual(item["attempts"], 1)
            self.assertIn("boom", item["lastError"])
            # retry without the exception -> completed
            result2 = hk.maintain_knowledge(project, archive_id)
            self.assertTrue(result2["ok"], msg=result2)
            self.assertTrue(any((outbox / state / f"{archive_id}.json").exists() for state in ("completed", "pending-judge")))
            self.assertFalse((outbox / "failed" / f"{archive_id}.json").exists())

    def test_maintain_is_idempotent_for_completed_archive(self) -> None:
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)
            hk.maintain_knowledge(project, archive_id)
            entries_dir = project / ".harness" / "knowledge" / "entries"
            snap1 = sorted(
                p.relative_to(entries_dir).as_posix() for p in entries_dir.rglob("*.json")
            )
            ids1 = sorted(
                e["id"] for _, e in hk.load_entry_files(project / ".harness" / "knowledge")
            )
            r2 = hk.maintain_knowledge(project, archive_id)
            r3 = hk.maintain_knowledge(project, archive_id)
            self.assertTrue(r2["ok"] and r3["ok"])
            snap2 = sorted(
                p.relative_to(entries_dir).as_posix() for p in entries_dir.rglob("*.json")
            )
            self.assertEqual(snap1, snap2)
            ids2 = sorted(
                e["id"] for _, e in hk.load_entry_files(project / ".harness" / "knowledge")
            )
            self.assertEqual(ids1, ids2)
            item_path = next(
                outbox / state / f"{archive_id}.json"
                for state in ("completed", "pending-judge")
                if (outbox / state / f"{archive_id}.json").exists()
            )
            item = json.loads(item_path.read_text(encoding="utf-8"))
            self.assertIn(item["status"], {"completed", "pending-judge"})

    def test_pending_judgements_are_not_reported_as_completed(self) -> None:
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.add_followup_archive(project)  # semantic conflict with the first archive
            archive_id = "2026-07-01-ai-check-job-followup"
            self._enqueue_pending(project, archive_id)
            result = hk.maintain_knowledge(project, archive_id)
            self.assertEqual(
                result["status"], "pending-judge", msg=result
            )
            self.assertGreater(result["pendingJudgements"], 0)

    def test_maintenance_auxiliary_failure_moves_item_to_failed(self) -> None:
        from unittest import mock

        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            archive_id = "2026-07-02-maintenance-failure"
            outbox = self._enqueue_pending(project, archive_id)
            with mock.patch.object(hk, "auto_supersede_knowledge", side_effect=RuntimeError("supersede failed")):
                result = hk.maintain_knowledge(project, archive_id)
            self.assertFalse(result["ok"], msg=result)
            self.assertEqual(result["status"], "failed")
            item = json.loads((outbox / "failed" / f"{archive_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(item["attempts"], 1)
            self.assertIn("supersede failed", item["lastError"])
            self.assertIn("supersede failed", item["lastError"])

    # --- HH-KNOW-20260730-001: sync_status must drain the maintenance outbox ---

    def test_sync_status_drains_outbox_when_index_already_up_to_date(self) -> None:
        """sync_status(update=False) on an already-current index must still drain
        pending outbox items instead of leaving them in pending/ forever."""
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            hk.build_index(project)
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)

            result = hk.sync_status(project)

            self.assertTrue(result["upToDate"], msg=result)
            self.assertTrue(result["ok"], msg=result)
            self.assertIsNone(result["nextAction"])
            self.assertTrue(result["maintenance"]["attempted"])
            self.assertFalse(result["maintenance"]["skipped"])
            self.assertTrue(result["maintenance"]["ok"], msg=result["maintenance"])
            self.assertEqual(result["maintenance"]["processed"], 1)
            self.assertEqual(result["maintenance"]["remaining"], 0)
            self.assertFalse((outbox / "pending" / f"{archive_id}.json").exists())
            self.assertTrue(
                any((outbox / state / f"{archive_id}.json").exists() for state in ("completed", "pending-judge"))
            )

    def test_sync_status_drains_outbox_after_rebuilding_stale_index(self) -> None:
        """sync_status(update=True) must ingest AND drain in one call."""
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            hk.build_index(project)
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)

            summary = project / ".harness" / "archive" / archive_id / "reports" / "final" / "summary-data.json"
            data = json.loads(summary.read_text(encoding="utf-8"))
            data["knownRisks"].append("新增归档风险，知识索引应提示需要刷新")
            write_json(summary, data)

            result = hk.sync_status(project, update=True)

            self.assertEqual(result["action"], "ingested")
            self.assertTrue(result["upToDate"], msg=result)
            self.assertTrue(result["ok"], msg=result)
            self.assertTrue(result["maintenance"]["attempted"])
            self.assertTrue(result["maintenance"]["ok"], msg=result["maintenance"])
            self.assertFalse((outbox / "pending" / f"{archive_id}.json").exists())

    def test_sync_status_skips_drain_when_stale_and_update_not_requested(self) -> None:
        """A plain status check (update=False) on a stale index must not force a
        rebuild via maintain_knowledge's internal build_index call -- it should
        report the pending outbox count and mark maintenance as skipped instead."""
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            hk.build_index(project)
            archive_id = "2026-06-30-ai-check-job"
            self._enqueue_pending(project, archive_id)

            summary = project / ".harness" / "archive" / archive_id / "reports" / "final" / "summary-data.json"
            data = json.loads(summary.read_text(encoding="utf-8"))
            data["knownRisks"].append("新增归档风险，知识索引应提示需要刷新")
            write_json(summary, data)

            result = hk.sync_status(project, update=False)

            self.assertFalse(result["upToDate"], msg=result)
            self.assertFalse(result["ok"], msg=result)
            self.assertIsNotNone(result["nextAction"])
            self.assertTrue(result["maintenance"]["skipped"], msg=result["maintenance"])
            self.assertFalse(result["maintenance"]["attempted"])
            self.assertEqual(result["maintenance"]["pending"], 1)

    def test_sync_status_reports_warn_when_outbox_fails_to_drain(self) -> None:
        """If the outbox drain itself fails, sync_status must surface ok=False
        and a retryable nextAction even though the index is current."""
        from unittest import mock

        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            hk.build_index(project)
            archive_id = "2026-06-30-ai-check-job"
            self._enqueue_pending(project, archive_id)

            with mock.patch.object(hk, "auto_supersede_knowledge", side_effect=RuntimeError("boom")):
                result = hk.sync_status(project)

            self.assertTrue(result["upToDate"], msg=result)
            self.assertFalse(result["ok"], msg=result)
            self.assertFalse(result["maintenance"]["ok"], msg=result["maintenance"])
            self.assertIsNotNone(result["nextAction"])
            self.assertIn("maintain", result["nextAction"])

    def test_drain_maintenance_outbox_recovers_stale_running_item(self) -> None:
        """API-010 crash recovery: a `running` item left behind by a killed
        process must be reclaimed and re-driven to completion by drain, not
        left stuck forever."""
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            hk.build_index(project)
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)

            item, status = hk.claim_outbox(outbox, archive_id)
            self.assertEqual(status, "running")
            running_path = outbox / "running" / f"{archive_id}.json"
            self.assertTrue(running_path.exists())
            stale_mtime = time.time() - 3600
            os.utime(running_path, (stale_mtime, stale_mtime))

            result = hk.drain_maintenance_outbox(project, stale_running_seconds=300.0)

            self.assertTrue(result["ok"], msg=result)
            self.assertEqual(result["staleRunningRecovered"], 1)
            self.assertFalse(running_path.exists())
            self.assertTrue(
                any((outbox / state / f"{archive_id}.json").exists() for state in ("completed", "pending-judge"))
            )

    def test_drain_maintenance_outbox_ignores_fresh_running_item(self) -> None:
        """A `running` item that is not stale yet (still owned by an in-flight
        process) must not be re-entered by a concurrent drain call."""
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            hk.build_index(project)
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)
            item, status = hk.claim_outbox(outbox, archive_id)
            self.assertEqual(status, "running")

            result = hk.drain_maintenance_outbox(project, stale_running_seconds=300.0)

            self.assertEqual(result["processed"], 0)
            self.assertEqual(result["staleRunningRecovered"], 0)
            self.assertTrue((outbox / "running" / f"{archive_id}.json").exists())

    # --- cluster 6b: knowledge 真增量补全 + 共享 snapshot (UT-028/029, API-009/010, INT-003) ---

    def _normalize_entry_for_equiv(self, entry: dict) -> dict:
        """Strip time-dependent fields so incremental ≡ no-incremental can be compared (UT-028)."""
        e = json.loads(json.dumps(entry, ensure_ascii=False))
        life = e.get("lifecycle") or {}
        for key in (
            "createdAt", "verifiedAt", "lastCheckedAt",
            "promotedAt", "demotedAt", "reverifiedAt",
        ):
            life.pop(key, None)
        if isinstance(life.get("validation"), dict):
            life["validation"].pop("validatedAt", None)
        e["lifecycle"] = life
        conf = e.get("confidence")
        if isinstance(conf, dict):
            conf.pop("lastCalculatedAt", None)
        return e

    def _normalized_entry_map(self, knowledge: Path) -> dict:
        result: dict = {}
        for sub in ["candidate", "active", "stale", "superseded", "conflicted"]:
            for path in sorted((knowledge / "entries" / sub).glob("*.json")):
                entry = json.loads(path.read_text(encoding="utf-8"))
                result[entry["id"]] = self._normalize_entry_for_equiv(entry)
        return result

    def _normalized_sqlite_hash(self, sqlite_path: Path) -> str:
        con = sqlite3.connect(sqlite_path)
        try:
            rows = con.execute("select id, entry_json from entries order by id").fetchall()
        finally:
            con.close()
        normalized = {
            row[0]: self._normalize_entry_for_equiv(json.loads(row[1])) for row in rows
        }
        return hashlib.sha256(
            json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

    def test_incremental_equiv_no_incremental_golden(self) -> None:
        """UT-028: incremental 与 no-incremental 同 fixture 产生语义等价的 entries/stats/sqlite/inputsHash。"""
        def build_state(incremental: bool) -> dict:
            with tempfile.TemporaryDirectory() as tmp:
                project = self.make_project(Path(tmp))
                self.add_independent_archive(project)
                args = ["ingest", "--project", str(project)]
                if not incremental:
                    args.append("--no-incremental")
                res = self.run_cli(*args)
                self.assertEqual(res.returncode, 0, res.stderr)
                knowledge = project / ".harness" / "knowledge"
                index = json.loads((knowledge / "index.json").read_text(encoding="utf-8"))
                return {
                    "entries": self._normalized_entry_map(knowledge),
                    "stats": {
                        k: index["stats"].get(k, 0)
                        for k in ["candidate", "active", "stale", "superseded", "conflicted"]
                    },
                    "byType": index.get("byType"),
                    "sqlite": self._normalized_sqlite_hash(knowledge / "index.sqlite"),
                    "inputsHash": index.get("inputsHash"),
                }

        inc = build_state(True)
        full = build_state(False)
        self.assertEqual(inc["inputsHash"], full["inputsHash"], "inputsHash must match for same archives")
        self.assertEqual(inc["stats"], full["stats"], "stats diverge")
        self.assertEqual(inc["byType"], full["byType"], "byType diverge")
        self.assertEqual(
            inc["entries"], full["entries"],
            "incremental vs no-incremental entries diverge (modulo timestamps)",
        )
        self.assertEqual(inc["sqlite"], full["sqlite"], "sqlite content diverges (modulo timestamps)")

    def test_lifecycle_change_invalidates_no_op_closure(self) -> None:
        """UT-029: promote/demote (preserved lifecycle 变化) 使 no-op 快路径失效；闭包内条目保留。"""
        module = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            module.build_index(project, incremental=True)  # cold
            second = module.build_index(project, incremental=True)
            self.assertEqual(second["ingestMode"]["mode"], "no-op", "second build should be no-op after cold")

            knowledge = project / ".harness" / "knowledge"
            candidate_files = list((knowledge / "entries" / "candidate").glob("*.json"))
            self.assertTrue(candidate_files, "cold build should produce candidate entries")
            candidate_path = candidate_files[0]
            entry = json.loads(candidate_path.read_text(encoding="utf-8"))
            entry_id = entry["id"]

            # mimic promote: write to active dir + remove candidate, WITHOUT rebuilding
            # so index.json still holds the pre-promote inputsHash.
            entry["status"] = "active"
            life = entry.setdefault("lifecycle", {})
            life["promotedAt"] = "2026-07-14T00:00:00+08:00"
            life["promotionNote"] = "manual promote for UT-029"
            active_path = knowledge / "entries" / "active" / candidate_path.name
            write_json(active_path, entry)
            candidate_path.unlink()

            after = module.build_index(project, incremental=True)
            self.assertNotEqual(
                after["ingestMode"]["mode"], "no-op",
                "promote (preserved lifecycle change) must invalidate the no-op fast path",
            )
            active_ids = {
                json.loads(p.read_text(encoding="utf-8"))["id"]
                for p in (knowledge / "entries" / "active").glob("*.json")
            }
            self.assertIn(entry_id, active_ids, "promoted entry must survive in active closure")

            # demote the active entry -> another preserved lifecycle invalidation
            active_file = next(
                p for p in (knowledge / "entries" / "active").glob("*.json")
                if json.loads(p.read_text(encoding="utf-8"))["id"] == entry_id
            )
            demoted = json.loads(active_file.read_text(encoding="utf-8"))
            demoted["status"] = "stale"
            dlife = demoted.setdefault("lifecycle", {})
            dlife["demotedAt"] = "2026-07-14T00:01:00+08:00"
            dlife["demotionReason"] = "manual demote for UT-029"
            dlife.setdefault("staleReasons", []).append("manual demotion: manual demote for UT-029")
            stale_path = knowledge / "entries" / "stale" / active_file.name
            write_json(stale_path, demoted)
            active_file.unlink()

            after2 = module.build_index(project, incremental=True)
            self.assertNotEqual(
                after2["ingestMode"]["mode"], "no-op",
                "demote (preserved lifecycle change) must invalidate the no-op fast path",
            )
            stale_ids = {
                json.loads(p.read_text(encoding="utf-8"))["id"]
                for p in (knowledge / "entries" / "stale").glob("*.json")
            }
            self.assertIn(entry_id, stale_ids, "demoted entry must survive in stale closure")

    def test_query_ensure_current_single_build(self) -> None:
        """API-009: query 一次 ensure-current — build_index 至多一次，inputs_hash 只算一次（共享 snapshot）。"""
        from unittest import mock

        module = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            calls = {"build": 0, "inputs_hash": 0}
            orig_build = module.build_index
            orig_hash = module.compute_inputs_hash

            def counting_build(*a, **kw):
                calls["build"] += 1
                return orig_build(*a, **kw)

            def counting_hash(*a, **kw):
                calls["inputs_hash"] += 1
                return orig_hash(*a, **kw)

            with mock.patch.object(module, "build_index", counting_build), \
                 mock.patch.object(module, "compute_inputs_hash", counting_hash):
                result = module.query_index(project, "异步 AI 检查 job", limit=5)
            self.assertGreaterEqual(result["matchCount"], 1)
            self.assertEqual(calls["build"], 1, "query must build at most once (one ensure-current)")
            self.assertEqual(
                calls["inputs_hash"], 1,
                "query must compute inputs_hash once (shared snapshot, not sync->build twice)",
            )

            # up-to-date project: query still one build (no-op path), no rewrite
            calls["build"] = 0
            calls["inputs_hash"] = 0
            with mock.patch.object(module, "build_index", counting_build), \
                 mock.patch.object(module, "compute_inputs_hash", counting_hash):
                module.query_index(project, "registry", limit=5)
            self.assertEqual(calls["build"], 1, "up-to-date query still calls build_index once (no-op path)")
            self.assertEqual(calls["inputs_hash"], 1, "up-to-date query must compute inputs_hash once")

    def test_maintain_claim_is_atomic_single_process(self) -> None:
        """API-010: claim_outbox 原子占有 (pending->running)；二次 claim 见 running 不重复占有；maintain 完成推进。"""
        hk = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            archive_id = "2026-06-30-ai-check-job"
            outbox = self._enqueue_pending(project, archive_id)

            item1, status1 = hk.claim_outbox(outbox, archive_id)
            self.assertEqual(status1, "running")
            self.assertIsNotNone(item1)
            self.assertFalse(
                (outbox / "pending" / f"{archive_id}.json").exists(),
                "claim must atomically move pending -> running (single-process ownership)",
            )

            # second claim sees running, does NOT re-claim from pending
            item2, status2 = hk.claim_outbox(outbox, archive_id)
            self.assertEqual(status2, "running")
            self.assertEqual(item2.get("status"), "running")

            # maintain on the running item completes it (bounded single-process推进)
            result = hk.maintain_knowledge(project, archive_id)
            self.assertTrue(result["ok"], msg=result)
            self.assertIn(result["status"], {"completed", "pending-judge"})
            self.assertFalse((outbox / "running" / f"{archive_id}.json").exists())

    def test_cold_warm_no_op_command_counts(self) -> None:
        """INT-003: cold/warm/no-op 命令与写入计数递减；no-op 写入 0、git 调用 0；未变 archive 输出等价。"""
        from unittest import mock

        module = self._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(Path(tmp))
            self.add_independent_archive(project)

            git_calls = {"count": 0}
            orig_git = module.run_git

            def counting_git(*a, **kw):
                git_calls["count"] += 1
                return orig_git(*a, **kw)

            with mock.patch.object(module, "run_git", counting_git):
                git_calls["count"] = 0
                cold = module.build_index(project, incremental=True)
                cold_git = git_calls["count"]
                cold_writes = cold["ingestMode"]["entriesWritten"] + cold["ingestMode"]["sqliteRebuild"]

                git_calls["count"] = 0
                noop = module.build_index(project, incremental=True)
                noop_git = git_calls["count"]
                noop_writes = (
                    noop["ingestMode"]["entriesWritten"]
                    + noop["ingestMode"].get("sqliteRebuild", 0)
                    + noop["ingestMode"].get("sqliteUpsert", 0)
                    + noop["ingestMode"].get("sqliteDelete", 0)
                )

            self.assertEqual(cold["ingestMode"]["mode"], "cold")
            self.assertEqual(noop["ingestMode"]["mode"], "no-op")
            self.assertEqual(noop_writes, 0, "no-op must write nothing")
            self.assertEqual(noop_git, 0, "no-op must not invoke git")
            self.assertGreater(cold_git, 0, "cold build must invoke git (stale checks + head)")
            self.assertGreater(cold_writes, noop_writes)

            # warm: change one archive -> fewer writes/git than cold, unchanged archive untouched
            indep = (
                project / ".harness" / "archive" / "2026-07-05-independent-feature"
                / "reports" / "final" / "summary-data.json"
            )
            data = json.loads(indep.read_text(encoding="utf-8"))
            data["businessGoal"] = "独立功能 X（已更新描述），与 AI job 模块无关。"
            indep.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

            knowledge = project / ".harness" / "knowledge"

            def ai_job_hashes() -> dict:
                result: dict = {}
                for sub in ["candidate", "active", "stale", "superseded", "conflicted"]:
                    for path in sorted((knowledge / "entries" / sub).glob("*.json")):
                        e = json.loads(path.read_text(encoding="utf-8"))
                        if e.get("source", {}).get("archive", "").endswith("2026-06-30-ai-check-job"):
                            result[e["id"]] = hashlib.sha256(path.read_bytes()).hexdigest()
                return result

            ai_job_before = ai_job_hashes()
            self.assertGreater(len(ai_job_before), 0)

            with mock.patch.object(module, "run_git", counting_git):
                git_calls["count"] = 0
                warm = module.build_index(project, incremental=True)
                warm_git = git_calls["count"]
                warm_writes = (
                    warm["ingestMode"]["entriesWritten"]
                    + warm["ingestMode"].get("sqliteUpsert", 0)
                    + warm["ingestMode"].get("sqliteRebuild", 0)
                )

            self.assertEqual(warm["ingestMode"]["mode"], "warm")
            self.assertLess(warm_writes, cold_writes, "warm writes must be fewer than cold")
            self.assertLess(warm_git, cold_git, "warm git calls must be fewer than cold")
            self.assertEqual(
                ai_job_before, ai_job_hashes(),
                "unchanged archive entries must not be rewritten (equivalent output)",
            )


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ENTRY_FIXTURE = REPO_ROOT / "packages" / "contracts" / "test" / "fixtures" / "knowledge-ingest-entry.json"
CONTRACT_INDEX_FIXTURE = REPO_ROOT / "packages" / "contracts" / "test" / "fixtures" / "knowledge-ingest-index.json"


class KnowledgeContractParityTest(unittest.TestCase):
    def test_shared_entry_fixture_matches_runtime_shape(self) -> None:
        payload = json.loads(CONTRACT_ENTRY_FIXTURE.read_text(encoding="utf-8"))
        required = {
            "schemaVersion", "id", "projectId", "type", "status", "title", "summary", "body",
            "keywords", "source", "scope", "lifecycle",
        }
        self.assertTrue(required.issubset(payload.keys()))
        self.assertEqual(payload["schemaVersion"], 1)

    def test_shared_index_fixture_matches_manifest_shape(self) -> None:
        payload = json.loads(CONTRACT_INDEX_FIXTURE.read_text(encoding="utf-8"))
        required = {
            "schemaVersion", "generatedAt", "projectId", "projectRoot", "archives",
            "stats", "byType", "duplicatesSkipped", "ingestMode", "failures", "entries",
        }
        self.assertTrue(required.issubset(payload.keys()))
        self.assertEqual(payload["schemaVersion"], 1)

    def test_make_entry_emits_schema_version_one(self) -> None:
        module = HarnessKnowledgeCliTest()._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "sample-project"
            project.mkdir(parents=True)
            summary_path = project / ".harness" / "archive" / "2026-06-30-sample" / "reports" / "final" / "summary-data.json"
            summary_path.parent.mkdir(parents=True, exist_ok=True)
            write_json(summary_path, {"changeName": "sample", "finalStatus": "OK"})
            entry = module.make_entry(
                project=project,
                project_name="sample",
                summary_path=summary_path,
                summary_hash="abc",
                summary={"changeName": "sample", "finalStatus": "OK"},
                entry_type="decision",
                title="title",
                body="body",
                source_files=["apps/server/src/registry/store.ts"],
                keywords=["sample"],
            )
            self.assertEqual(entry["schemaVersion"], 1)
            self.assertEqual(entry["type"], "decision")

    def test_make_entry_hashes_the_complete_canonical_body(self) -> None:
        module = HarnessKnowledgeCliTest()._import_harness_knowledge()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "sample-project"
            project.mkdir(parents=True)
            summary_path = (
                project / ".harness" / "archive" / "2026-06-30-sample"
                / "reports" / "final" / "summary-data.json"
            )
            summary_path.parent.mkdir(parents=True, exist_ok=True)
            summary = {"changeName": "sample", "finalStatus": "OK"}
            write_json(summary_path, summary)
            prefix = "x" * 160

            common = {
                "project": project,
                "project_name": "sample",
                "summary_path": summary_path,
                "summary_hash": "abc",
                "summary": summary,
                "entry_type": "decision",
                "title": "same title",
                "source_files": ["src/a.py"],
                "keywords": ["sample"],
            }
            first = module.make_entry(body=prefix + " first", **common)
            second = module.make_entry(body=prefix + " second", **common)

            self.assertNotEqual(first["id"], second["id"])


class QueryCompactOutputTests(unittest.TestCase):
    """C5: query 默认 compact 输出，--verbose 展开全量。"""

    def setUp(self) -> None:
        self._cli = HarnessKnowledgeCliTest()

    def test_query_default_compact_omits_matches_array(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self._cli.make_project(Path(tmp))
            self._cli.run_cli("ingest", "--project", str(project))

            result = self._cli.run_cli(
                "query", "--project", str(project), "--query", "异步 AI 检查 job",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            # compact: 无 matches 数组
            self.assertNotIn("matches", payload)
            # compact 必备字段
            self.assertIn("matchCount", payload)
            self.assertIn("contextPack", payload)
            self.assertIn("planInput", payload)
            self.assertGreaterEqual(payload["matchCount"], 1)

    def test_query_verbose_returns_full_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self._cli.make_project(Path(tmp))
            self._cli.run_cli("ingest", "--project", str(project))

            result = self._cli.run_cli(
                "query", "--project", str(project), "--query", "异步 AI 检查 job",
                "--verbose",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertIn("matches", payload)
            self.assertGreaterEqual(len(payload["matches"]), 1)
            self.assertIn("planInput", payload)


if __name__ == "__main__":
    unittest.main()
