#!/usr/bin/env python3
"""Regression guards for the 2026-09-02 archive performance optimizations.

Each test freezes one behavior that the optimizations depend on, so a future
refactor cannot silently regress them (all of these were verified only by
ad-hoc differential diagnostics during the optimization session):

- e12: sensitive-scan regex fast path still detects mixed-case assignments
  and still skips placeholders / internal recovery_token keys.
- e13: load_events_cached serves repeated loads but always misses after the
  file changes (append).
- e14: the staging-copy hash transfer stays falsifiable — a file modified
  after the copy must hash to its NEW content, and an unscanned tree falls
  back to real reads.
- e18: scanned_file_digest refuses to serve a digest whose stat no longer
  matches the scan-time fingerprint.
- e19: archive append_event renders the execution log only on phase.end /
  auto-seal and respects render-policy.json (on-demand).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_events as he  # noqa: E402
import harness_runtime as hruntime  # noqa: E402


def _write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    elif isinstance(data, dict):
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    else:
        path.write_text(data, encoding="utf-8", newline="\n")


def _clear_caches() -> None:
    hruntime._sensitive_file_cache.clear()
    hruntime._file_hash_cache.clear()
    ha._sha256_cache.clear()
    ha._copy_hash_transfers.clear()
    he._events_cache.clear()


class ScanFastPathTests(unittest.TestCase):
    """e12: pre-lowered subject + case-sensitive patterns + keyword probe."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="guard-scan-"))
        _clear_caches()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _candidates(self) -> list[dict]:
        return hruntime.sensitive_evidence_candidates(self.tmp)

    def test_mixed_case_assignment_is_detected(self) -> None:
        _write(self.tmp / "cfg.txt", b'PASSWORD = "SuperSecret99"\n')
        _write(self.tmp / "env.txt", b'DATABASE_URL: postgres://u:pw@h/db\n')
        found = {item["path"] for item in self._candidates()}
        self.assertIn("cfg.txt", found)
        self.assertIn("env.txt", found)

    def test_uppercase_authorization_bearer_is_detected(self) -> None:
        _write(self.tmp / "hdr.txt", b'"Authorization": "Bearer abcdef123456"\n')
        found = {item["path"] for item in self._candidates()}
        self.assertIn("hdr.txt", found)

    def test_placeholders_are_not_findings(self) -> None:
        _write(
            self.tmp / "doc.txt",
            b"password: <enter-your-password>\ntoken = ${MY_TOKEN}\n"
            b"secret: {{vault.path}}\nauthorization: Bearer\n",
        )
        self.assertEqual(self._candidates(), [])

    def test_internal_recovery_token_key_is_exempt(self) -> None:
        _write(
            self.tmp / "journal.json",
            b'{"recovery_token": "internal-run-credential-1"}\n',
        )
        self.assertEqual(self._candidates(), [])

    def test_digest_matches_file_bytes(self) -> None:
        import hashlib

        _write(self.tmp / "k.txt", b'token = "abcdef123456"\n')
        candidates = self._candidates()
        self.assertEqual(len(candidates), 1)
        expected = "sha256:" + hashlib.sha256(
            b'token = "abcdef123456"\n'
        ).hexdigest()
        self.assertEqual(candidates[0]["digest"], expected)


class EventsCacheTests(unittest.TestCase):
    """e13: load_events_cached must never serve stale bytes."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="guard-evc-"))
        _clear_caches()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _events_file(self) -> Path:
        path = self.tmp / "change" / "events.ndjson"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def test_repeated_load_hits_cache_then_append_invalidates(self) -> None:
        path = self._events_file()
        first = {"schema_version": 3, "id": "evt-1", "timestamp": "t",
                 "phase": "execute", "type": "command", "note": "n"}
        path.write_text(json.dumps(first) + "\n", encoding="utf-8")
        loaded_once = he.load_events_cached(path)
        loaded_twice = he.load_events_cached(path)
        self.assertEqual(loaded_once, loaded_twice)
        # Same cached list object on a fingerprint hit.
        self.assertIs(loaded_once, loaded_twice)
        # Append changes the file: the cache must miss and serve the new event.
        second = {"schema_version": 3, "id": "evt-2", "timestamp": "t",
                  "phase": "execute", "type": "command", "note": "n2"}
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(second) + "\n")
        reloaded = he.load_events_cached(path)
        self.assertEqual([e["id"] for e in reloaded], ["evt-1", "evt-2"])

    def test_corrupt_file_is_never_cached_as_valid(self) -> None:
        path = self._events_file()
        path.write_text("{not json}\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            he.load_events_cached(path)


class TransferMapTests(unittest.TestCase):
    """e14: staging-copy hash transfer stays falsifiable."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="guard-tx-"))
        _clear_caches()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _build_source(self) -> Path:
        source = self.tmp / "src"
        (source / "a").mkdir(parents=True, exist_ok=True)
        _write(source / "a" / "one.txt", b"one" * 100)
        _write(source / "a" / "two.txt", b"two" * 100)
        return source

    def test_transfer_hash_equals_disk_hash_with_and_without_scan(self) -> None:
        import hashlib

        for label in ("with-scan", "without-scan"):
            with self.subTest(label=label):
                _clear_caches()
                source = self._build_source()
                if label == "with-scan":
                    hruntime.sensitive_evidence_candidates(source)
                dest = self.tmp / f"dst-{label}"
                ha._parallel_copytree(source, dest, record_hashes=True)
                for file_path in sorted(dest.rglob("*")):
                    if not file_path.is_file():
                        continue
                    expected = hashlib.sha256(
                        file_path.read_bytes()
                    ).hexdigest()
                    self.assertEqual(ha.sha256_file(file_path), expected)

    def test_modified_file_after_copy_hashes_new_content(self) -> None:
        source = self._build_source()
        dest = self.tmp / "dst"
        ha._parallel_copytree(source, dest, record_hashes=True)
        target = dest / "a" / "one.txt"
        before = ha.sha256_file(target)
        target.write_bytes(b"CHANGED CONTENT 0123456789")
        after = ha.sha256_file(target)
        import hashlib

        self.assertEqual(
            after, hashlib.sha256(b"CHANGED CONTENT 0123456789").hexdigest()
        )
        self.assertNotEqual(before, after)


class ScannedFileDigestTests(unittest.TestCase):
    """e18: scanned_file_digest refuses stale fingerprints."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="guard-sfd-"))
        _clear_caches()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_digest_available_after_scan_and_refused_after_mutation(self) -> None:
        import hashlib

        source = self.tmp / "src"
        source.mkdir()
        file_path = source / "key.txt"
        file_path.write_bytes(b"payload" * 50)
        # Before any scan: no digest.
        self.assertIsNone(
            hruntime.scanned_file_digest(file_path, "key.txt")
        )
        hruntime.sensitive_evidence_candidates(source)
        self.assertEqual(
            hruntime.scanned_file_digest(file_path, "key.txt"),
            hashlib.sha256(b"payload" * 50).hexdigest(),
        )
        # Same size, different bytes: the mtime fingerprint must break.
        file_path.write_bytes(b"PAYLOAD" * 50)
        self.assertIsNone(
            hruntime.scanned_file_digest(file_path, "key.txt")
        )


class CacheCapacityTests(unittest.TestCase):
    """Scale guard: per-file cache caps must stay above realistic tree sizes.

    The caps used to be 8192 with wholesale clear on overflow, which silently
    reverted every optimized pass to full re-reads for trees larger than 8192
    files (verified on a 9000-file tree: 8192 of 9000 transfer entries lost,
    before-manifest re-read 5.41s vs 1.41s after the fix). These assertions
    freeze the floor so the cliff cannot be reintroduced by a constant tweak.
    """

    def test_file_cache_caps_cover_large_change_trees(self) -> None:
        self.assertGreaterEqual(hruntime._FILE_CACHE_MAX, 131_072)
        self.assertGreaterEqual(ha._SHA256_CACHE_MAX, 131_072)


class AppendRenderContractTests(unittest.TestCase):
    """e19: archive append_event renders only on phase.end and honors policy."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="guard-render-"))
        # Real layout: render-policy is read from <project>/.harness/config/.
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "demo"
        self.change.mkdir(parents=True)
        _write(
            self.change / "events.ndjson",
            json.dumps(
                {
                    "schema_version": 3,
                    "id": "evt-1",
                    "timestamp": "2026-09-02T10:00:00+08:00",
                    "phase": "archive",
                    "type": "phase.start",
                    "attempt": 1,
                    "note": "start",
                }
            )
            + "\n",
        )
        _clear_caches()
        # Render once so the log exists.
        events = he.load_events(self.change / "events.ndjson")
        he.write_execution_log(self.change, he.render_execution_log(events))
        self.log_path = self.change / "logs" / "execution-log.md"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _log_content(self) -> str:
        return self.log_path.read_text(encoding="utf-8")

    def test_mechanical_append_does_not_rerender(self) -> None:
        before = self._log_content()
        ha.append_event(
            self.change, phase="archive", type_="command",
            command="cleanup-transients", exit_code=0, note="mechanical",
        )
        self.assertEqual(self._log_content(), before)

    def test_phase_end_rerenders(self) -> None:
        before = self._log_content()
        ha.append_event(
            self.change, phase="archive", type_="phase.end",
            status="OK", note="done",
        )
        after = self._log_content()
        self.assertNotEqual(after, before)
        self.assertIn("done", after)

    def test_on_demand_policy_suppresses_even_phase_end_render(self) -> None:
        policy = self.project / ".harness" / "config" / "render-policy.json"
        _write(policy, {"executionLog": "on-demand"})
        before = self._log_content()
        ha.append_event(
            self.change, phase="archive", type_="phase.end",
            status="OK", note="suppressed",
        )
        self.assertEqual(self._log_content(), before)


if __name__ == "__main__":
    unittest.main()
