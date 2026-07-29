import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "harness_knowledge.py"
SPEC = importlib.util.spec_from_file_location("harness_knowledge_incremental", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
KNOWLEDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(KNOWLEDGE)


def make_entry(
    entry_id: str,
    body: str,
    *,
    source_commit: str = "",
    source_files: list[str] | None = None,
) -> dict:
    files = source_files or []
    return {
        "schemaVersion": 1,
        "id": entry_id,
        "projectId": "fixture",
        "type": "decision",
        "status": "candidate",
        "title": body[:80],
        "summary": body,
        "body": body,
        "keywords": ["bounded", "incremental"],
        "source": {
            "archive": ".harness/archive/fixture",
            "summaryData": ".harness/archive/fixture/reports/final/summary-data.json",
            "summarySha256": "fixture",
            "sourceCommit": source_commit,
        },
        "scope": {
            "sourceFiles": files,
            "staleIfPathsChanged": files,
        },
        "lifecycle": {
            "createdAt": "2026-07-29T00:00:00+00:00",
            "verifiedAt": "2026-07-29T00:00:00+00:00",
            "lastCheckedAt": "2026-07-29T00:00:00+00:00",
            "confidence": "medium",
            "supersedes": [],
            "supersededBy": None,
            "conflictsWith": [],
            "staleReasons": [],
        },
    }


class KnowledgeIncrementalTest(unittest.TestCase):
    def test_snapshot_resolves_and_hashes_each_archive_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            summary = (
                project
                / ".harness"
                / "archive"
                / "2026-07-29-fixture"
                / "reports"
                / "final"
                / "summary-data.json"
            )
            summary.parent.mkdir(parents=True)
            summary.write_text(
                json.dumps(
                    {
                        "changeName": "fixture",
                        "finalStatus": "OK",
                        "reportPipeline": {
                            "sourceConsistency": {"ok": True, "issues": []}
                        },
                    }
                ),
                encoding="utf-8",
            )
            original_resolver = KNOWLEDGE.resolve_archive_summary
            original_hash = KNOWLEDGE.sha256_file
            with (
                mock.patch.object(
                    KNOWLEDGE,
                    "resolve_archive_summary",
                    wraps=original_resolver,
                ) as resolver,
                mock.patch.object(
                    KNOWLEDGE,
                    "sha256_file",
                    wraps=original_hash,
                ) as hasher,
            ):
                snapshot = KNOWLEDGE.build_snapshot(project)

            self.assertEqual(len(snapshot.summary_paths), 1)
            self.assertEqual(resolver.call_count, 1)
            summary_hash_calls = [
                call
                for call in hasher.call_args_list
                if Path(call.args[0]).resolve() == summary.resolve()
            ]
            self.assertEqual(len(summary_hash_calls), 1)
            publication = next(iter(snapshot.publications.values()))
            self.assertTrue(publication["allowed"])

    def test_similarity_buckets_bound_candidate_pairs_and_merge_near_duplicate(self) -> None:
        entries = [
            make_entry(
                f"fixture.decision.{index}",
                f"component-{index:03d} owns an intentionally distinct protocol token-{index:03d}",
            )
            for index in range(80)
        ]
        entries.extend(
            [
                make_entry(
                    "fixture.decision.near-a",
                    "sync runner enforces wall timeout heartbeat and bounded diagnostics",
                ),
                make_entry(
                    "fixture.decision.near-b",
                    "sync runner enforces wall timeout, heartbeat and bounded diagnostics",
                ),
            ]
        )

        result = KNOWLEDGE.dedupe_near_duplicates(
            entries,
            max_exact_comparisons=500,
            time_budget_ms=1_000,
        )

        self.assertEqual(result["merged"], 1)
        self.assertGreater(result["bucketCount"], 0)
        self.assertLess(result["candidatePairs"], 400)
        self.assertLess(result["exactSimilarityComparisons"], 100)
        self.assertFalse(result["comparisonBudgetExceeded"])

    def test_similarity_budget_is_explicit_and_skips_uncertain_merges(self) -> None:
        entries = [
            make_entry(
                f"fixture.decision.similar-{index}",
                f"shared workflow verification timeout heartbeat bounded evidence token {index}",
            )
            for index in range(30)
        ]

        result = KNOWLEDGE.dedupe_near_duplicates(
            entries,
            threshold=0.8,
            max_exact_comparisons=5,
            time_budget_ms=5_000,
        )

        self.assertLessEqual(result["exactSimilarityComparisons"], 5)
        self.assertTrue(result["comparisonBudgetExceeded"])
        self.assertGreater(result["comparisonsSkipped"], 0)

    def test_sqlite_second_write_is_a_true_dirty_set_noop(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "index.sqlite"
            entries = [
                make_entry("fixture.decision.one", "one"),
                make_entry("fixture.decision.two", "two"),
            ]
            first = KNOWLEDGE.write_sqlite(path, entries)
            before = path.stat().st_mtime_ns
            second = KNOWLEDGE.write_sqlite(path, json.loads(json.dumps(entries)))

            self.assertEqual(first["sqliteRebuild"], 1)
            self.assertEqual(first["sqliteUpsert"], 2)
            self.assertEqual(
                second,
                {
                    "sqliteRebuild": 0,
                    "sqliteUpsert": 0,
                    "sqliteDelete": 0,
                    "sqliteUnchanged": 2,
                },
            )
            self.assertEqual(path.stat().st_mtime_ns, before)

    def test_git_freshness_batches_commit_and_diff_probes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            subprocess.run(["git", "init", "-q", str(project)], check=True)
            subprocess.run(
                ["git", "-C", str(project), "config", "user.email", "fixture@example.com"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(project), "config", "user.name", "Fixture"],
                check=True,
            )
            changed = project / "changed.txt"
            unchanged = project / "unchanged.txt"
            changed.write_text("before\n", encoding="utf-8")
            unchanged.write_text("stable\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(project), "add", "."], check=True)
            subprocess.run(["git", "-C", str(project), "commit", "-qm", "base"], check=True)
            commit = subprocess.run(
                ["git", "-C", str(project), "rev-parse", "HEAD"],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
            ).stdout.strip()
            changed.write_text("after\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(project), "add", "changed.txt"], check=True)
            subprocess.run(
                ["git", "-C", str(project), "commit", "-qm", "change tracked source"],
                check=True,
            )
            entries = [
                make_entry(
                    "fixture.decision.changed",
                    "changed",
                    source_commit=commit,
                    source_files=["changed.txt"],
                ),
                make_entry(
                    "fixture.decision.unchanged",
                    "unchanged",
                    source_commit=commit,
                    source_files=["unchanged.txt"],
                ),
            ]
            KNOWLEDGE._GIT_SUBPROCESS_COUNT = 0

            result = KNOWLEDGE.apply_batch_git_freshness(project, entries)

            self.assertEqual(result["gitCommitBatches"], 1)
            self.assertEqual(result["gitDiffBatches"], 1)
            self.assertEqual(result["gitEntriesChecked"], 2)
            self.assertLessEqual(KNOWLEDGE._GIT_SUBPROCESS_COUNT, 3)
            self.assertEqual(entries[0]["status"], "stale")
            self.assertIn(
                "source files changed after source commit: changed.txt",
                entries[0]["lifecycle"]["staleReasons"],
            )
            self.assertEqual(entries[1]["status"], "candidate")
            self.assertEqual(entries[1]["lifecycle"]["staleReasons"], [])


if __name__ == "__main__":
    unittest.main()
