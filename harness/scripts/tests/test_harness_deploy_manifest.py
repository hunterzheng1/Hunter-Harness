#!/usr/bin/env python3
"""Tests for per-file bundle manifest generation/verification (C1/T2).

Covers retro 5.1/5.25: registry_version+bundle_hash alone cannot prove each
installed file belongs to the bundle; install must verify per-file content
before the atomic switch and never update metadata on partial failure.
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

import harness_deploy as hd  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _marked_build(root: Path) -> Path:
    """Create a minimal marked build output dir."""
    _write(root / hd.BUILD_MARKER, json.dumps({"built": True}))
    _write(root / "harness-demo" / "SKILL.md", "---\nname: harness-demo\n---\n# Demo\n")
    _write(root / "scripts" / "harness_events.py", "#!/usr/bin/env python3\nprint('events')\n")
    _write(root / "scripts" / "harness_archive.py", "#!/usr/bin/env python3\nprint('archive')\n")
    return root


class BuildManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="deploy-manifest-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_manifest_entries_include_metadata(self) -> None:
        build = _marked_build(self.tmp / "build")
        entries = hd.build_manifest(build, transformation_id="adapted")
        by_rel = {entry["relpath"]: entry for entry in entries}
        self.assertIn("scripts/harness_events.py", by_rel)
        entry = by_rel["scripts/harness_events.py"]
        self.assertEqual(len(entry["sha256"]), 64)
        self.assertGreater(entry["size"], 0)
        self.assertIsInstance(entry["mode"], int)
        self.assertEqual(entry["adapterTransformationId"], "adapted")
        # Build marker and managed manifests are install metadata, not bundle files.
        self.assertNotIn(hd.BUILD_MARKER, by_rel)

    def test_bundle_manifest_hash_is_order_independent(self) -> None:
        build = _marked_build(self.tmp / "build")
        entries = hd.build_manifest(build, transformation_id="raw")
        hash1 = hd.compute_bundle_manifest_hash(entries)
        hash2 = hd.compute_bundle_manifest_hash(list(reversed(entries)))
        self.assertEqual(hash1, hash2)
        self.assertEqual(len(hash1), 64)

    def test_bundle_manifest_hash_changes_with_content(self) -> None:
        build = _marked_build(self.tmp / "build")
        entries = hd.build_manifest(build, transformation_id="raw")
        hash1 = hd.compute_bundle_manifest_hash(entries)
        mutated = [dict(e) for e in entries]
        mutated[0]["sha256"] = "0" * 64
        self.assertNotEqual(hash1, hd.compute_bundle_manifest_hash(mutated))


class InstallTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="deploy-install-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_install_verifies_staging_against_manifest(self) -> None:
        build = _marked_build(self.tmp / "build")
        entries = hd.build_manifest(build, transformation_id="adapted")
        manifest = {
            "schemaVersion": 1,
            "bundleVersion": "0.2.14",
            "bundleManifestHash": hd.compute_bundle_manifest_hash(entries),
            "files": entries,
        }
        _write(build / "bundle-manifest.json", json.dumps(manifest))
        # Corrupt one file AFTER manifest generation: staging must not switch.
        target_file = build / "scripts" / "harness_events.py"
        target_file.write_text("#!/usr/bin/env python3\nprint('tampered')\n", encoding="utf-8")

        project = self.tmp / "project"
        project.mkdir()
        with self.assertRaises(ValueError):
            hd.cmd_install(build, project, None)
        # Destination must not have been created with tampered content.
        dest = project / ".claude" / "skills"
        events = dest / "scripts" / "harness_events.py"
        if events.exists():
            self.assertNotIn("tampered", events.read_text(encoding="utf-8"))

    def test_install_success_writes_bundle_manifest(self) -> None:
        build = _marked_build(self.tmp / "build")
        entries = hd.build_manifest(build, transformation_id="adapted")
        manifest = {
            "schemaVersion": 1,
            "bundleVersion": "0.2.14",
            "bundleManifestHash": hd.compute_bundle_manifest_hash(entries),
            "files": entries,
        }
        _write(build / "bundle-manifest.json", json.dumps(manifest))

        project = self.tmp / "project"
        project.mkdir()
        result = hd.cmd_install(build, project, None)
        self.assertTrue(result["ok"])
        dest = project / ".claude" / "skills"
        installed_manifest = json.loads(
            (dest / "bundle-manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(installed_manifest["bundleVersion"], "0.2.14")
        self.assertEqual(
            installed_manifest["bundleManifestHash"], manifest["bundleManifestHash"]
        )


class VerifyInstalledTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="deploy-verify-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _installed(self) -> Path:
        build = _marked_build(self.tmp / "build")
        project = self.tmp / "project"
        project.mkdir()
        hd.cmd_install(build, project, None)
        return project / ".claude" / "skills"

    def test_verify_installed_ok(self) -> None:
        dest = self._installed()
        entries = hd.build_manifest(dest, transformation_id="adapted")
        result = hd.cmd_verify_installed(dest, entries, "0.2.14")
        self.assertTrue(result["ok"])
        self.assertEqual(result["verificationStatus"], "verified")
        self.assertEqual(len(result["installedContentHash"]), 64)
        self.assertEqual(result["mismatchDetails"], [])

    def test_verify_installed_reports_mismatch_details(self) -> None:
        dest = self._installed()
        entries = hd.build_manifest(dest, transformation_id="adapted")
        # Tamper one installed file: simulates retro 5.1 stale-script drift.
        target = dest / "scripts" / "harness_archive.py"
        target.write_text("#!/usr/bin/env python3\nprint('old-loose-contract')\n", encoding="utf-8")
        result = hd.cmd_verify_installed(dest, entries, "0.2.14")
        self.assertFalse(result["ok"])
        self.assertEqual(result["verificationStatus"], "degraded")
        mismatches = {m["relpath"] for m in result["mismatchDetails"]}
        self.assertIn("scripts/harness_archive.py", mismatches)
        detail = next(
            m for m in result["mismatchDetails"] if m["relpath"] == "scripts/harness_archive.py"
        )
        self.assertEqual(len(detail["expected"]), 64)
        self.assertEqual(len(detail["actual"]), 64)


if __name__ == "__main__":
    unittest.main()
