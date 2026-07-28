#!/usr/bin/env python3
"""Regression tests for resource-safe Harness test execution."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS_DIR.parents[1]
RUNNER_PATH = SCRIPTS_DIR / "harness_test_runner.py"


def load_runner():
    if not RUNNER_PATH.is_file():
        return None
    spec = importlib.util.spec_from_file_location("harness_test_runner", RUNNER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["harness_test_runner"] = module
    spec.loader.exec_module(module)
    return module


runner = load_runner()


class RunnerPresenceTests(unittest.TestCase):
    def test_resource_safe_runner_exists(self) -> None:
        self.assertIsNotNone(
            runner,
            "harness/scripts/harness_test_runner.py must provide the safe test entry point",
        )


@unittest.skipIf(runner is None, "resource-safe runner is not implemented yet")
class RunnerContractTests(unittest.TestCase):
    def test_profiles_partition_regular_and_resource_intensive_modules(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-plan-") as raw_tmp:
            tests_dir = Path(raw_tmp)
            (tests_dir / "test_fast.py").write_text("", encoding="utf-8")
            (tests_dir / "test_harness_service.py").write_text("", encoding="utf-8")
            (tests_dir / "helper.py").write_text("", encoding="utf-8")

            safe = runner.build_unittest_plan(
                tests_dir,
                "safe",
                resource_modules=("test_harness_service.py",),
            )
            system = runner.build_unittest_plan(
                tests_dir,
                "system",
                resource_modules=("test_harness_service.py",),
            )
            full = runner.build_unittest_plan(
                tests_dir,
                "full",
                resource_modules=("test_harness_service.py",),
            )

            self.assertEqual([item.name for item in safe], ["test_fast.py"])
            self.assertEqual(
                [item.name for item in system],
                ["test_harness_service.py"],
            )
            self.assertEqual(
                [item.name for item in full],
                ["test_fast.py", "test_harness_service.py"],
            )

    def test_resource_intensive_profiles_require_explicit_confirmation(self) -> None:
        self.assertTrue(runner.resource_profile_allowed("safe", False, {}))
        self.assertFalse(runner.resource_profile_allowed("system", False, {}))
        self.assertFalse(runner.resource_profile_allowed("full", False, {}))
        self.assertTrue(runner.resource_profile_allowed("system", True, {}))
        self.assertTrue(runner.resource_profile_allowed("full", False, {"CI": "true"}))
        self.assertTrue(
            runner.resource_profile_allowed(
                "full",
                False,
                {"HARNESS_ALLOW_RESOURCE_INTENSIVE_TESTS": "1"},
            )
        )

    def test_worker_count_is_bounded_by_environment(self) -> None:
        self.assertEqual(runner.bounded_worker_count(8, {}), 2)
        self.assertEqual(
            runner.bounded_worker_count(8, {"HARNESS_TEST_MAX_WORKERS": "1"}),
            1,
        )
        self.assertEqual(
            runner.bounded_worker_count(1, {"HARNESS_TEST_MAX_WORKERS": "8"}),
            1,
        )

    def test_single_instance_lock_rejects_a_second_runner(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lock-") as raw_tmp:
            tmp = Path(raw_tmp)
            project = tmp / "project"
            project.mkdir()
            lock_root = tmp / "locks"
            with runner.TestRunLock(project, lock_root=lock_root):
                with self.assertRaises(runner.TestRunAlreadyActive):
                    with runner.TestRunLock(project, lock_root=lock_root):
                        pass

    def test_timeout_terminates_managed_process(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-timeout-") as raw_tmp:
            started = time.monotonic()
            result = runner.run_managed_command(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                cwd=Path(raw_tmp),
                timeout_seconds=0.1,
                environ={},
            )
            self.assertTrue(result.timed_out)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.process_tree_isolated)
            self.assertLess(time.monotonic() - started, 5)

    def test_captured_output_is_available_for_failure_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-output-") as raw_tmp:
            result = runner.run_managed_command(
                [sys.executable, "-c", "print('managed-output-marker')"],
                cwd=Path(raw_tmp),
                timeout_seconds=5,
                environ={},
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0)
            self.assertIn("managed-output-marker", result.output_tail)

    def test_normal_exit_also_cleans_up_descendants(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-descendant-") as raw_tmp:
            tmp = Path(raw_tmp)
            pid_file = tmp / "child.pid"
            script = (
                "import pathlib,subprocess,sys;"
                "child=subprocess.Popen([sys.executable,'-c',"
                "'import time;time.sleep(10)']);"
                "pathlib.Path(sys.argv[1]).write_text(str(child.pid),encoding='utf-8')"
            )
            result = runner.run_managed_command(
                [sys.executable, "-c", script, str(pid_file)],
                cwd=tmp,
                timeout_seconds=5,
                environ={},
            )
            self.assertEqual(result.returncode, 0)
            self.assertTrue(result.process_tree_isolated)
            child_pid = int(pid_file.read_text(encoding="utf-8"))
            deadline = time.monotonic() + 2
            while runner._pid_is_running(child_pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            try:
                self.assertFalse(
                    runner._pid_is_running(child_pid),
                    f"managed descendant still running: pid={child_pid}",
                )
            finally:
                if runner._pid_is_running(child_pid):
                    if os.name == "nt":
                        subprocess.run(
                            ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            check=False,
                        )
                    else:
                        os.kill(child_pid, 9)

    def test_detached_service_mode_uses_pid_lineage_cleanup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lineage-") as raw_tmp:
            tmp = Path(raw_tmp)
            pid_file = tmp / "child.pid"
            script = (
                "import pathlib,subprocess,sys;"
                "child=subprocess.Popen([sys.executable,'-c',"
                "'import time;time.sleep(10)']);"
                "pathlib.Path(sys.argv[1]).write_text(str(child.pid),encoding='utf-8')"
            )
            result = runner.run_managed_command(
                [sys.executable, "-c", script, str(pid_file)],
                cwd=tmp,
                timeout_seconds=5,
                environ={},
                allow_detached_processes=True,
            )
            child_pid = int(pid_file.read_text(encoding="utf-8"))
            try:
                self.assertEqual(result.returncode, 0)
                self.assertTrue(result.process_tree_isolated)
                self.assertFalse(runner._pid_is_running(child_pid))
            finally:
                if runner._pid_is_running(child_pid):
                    subprocess.run(
                        ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                    deadline = time.monotonic() + 5
                    while (
                        runner._pid_is_running(child_pid)
                        and time.monotonic() < deadline
                    ):
                        time.sleep(0.05)

    def test_detached_exec_fails_fast_when_capability_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-capability-") as raw_tmp:
            stderr = io.StringIO()
            with (
                mock.patch.object(
                    runner,
                    "detached_process_capability",
                    return_value=(False, "sandbox blocked nested breakaway"),
                    create=True,
                ),
                contextlib.redirect_stderr(stderr),
            ):
                code = runner.main(
                    [
                        "exec",
                        "--project",
                        raw_tmp,
                        "--profile",
                        "system",
                        "--confirm-resource-intensive",
                        "--allow-detached-processes",
                        "--",
                        sys.executable,
                        "-c",
                        "print('must-not-run')",
                    ]
                )
            self.assertEqual(code, 5)
            self.assertIn("DETACHED_PROCESS_CAPABILITY_UNAVAILABLE", stderr.getvalue())

    def test_detached_unittest_module_fails_fast_when_capability_is_blocked(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-capability-") as raw_tmp:
            project = Path(raw_tmp)
            tests_dir = project / "tests"
            tests_dir.mkdir()
            (tests_dir / "test_harness_service.py").write_text("", encoding="utf-8")
            stderr = io.StringIO()
            with (
                mock.patch.object(
                    runner,
                    "detached_process_capability",
                    return_value=(False, "sandbox blocked nested breakaway"),
                    create=True,
                ),
                contextlib.redirect_stderr(stderr),
            ):
                code = runner.main(
                    [
                        "unittest",
                        "--project",
                        str(project),
                        "--tests-dir",
                        str(tests_dir),
                        "--profile",
                        "system",
                        "--confirm-resource-intensive",
                        "--verbosity",
                        "0",
                    ]
                )
            self.assertEqual(code, 5)
            self.assertIn("DETACHED_PROCESS_CAPABILITY_UNAVAILABLE", stderr.getvalue())


class WorkflowContractTests(unittest.TestCase):
    def test_policy_uses_safe_profile_by_default(self) -> None:
        policy = json.loads(
            (REPO_ROOT / "harness" / "contracts" / "workflow-policy.json").read_text(
                encoding="utf-8-sig"
            )
        )
        self.assertIn("testExecution", policy)
        execution = policy["testExecution"]
        self.assertEqual(execution["defaultProfile"], "safe")
        self.assertEqual(execution["maxWorkers"], 2)
        self.assertTrue(execution["singleInstance"])
        self.assertTrue(execution["processTreeCleanup"])
        self.assertTrue(execution["detachedProcessPreflight"])
        self.assertIn("system", execution["confirmationRequiredProfiles"])
        self.assertIn("full", execution["confirmationRequiredProfiles"])

    def test_harness_test_skill_documents_resource_safety(self) -> None:
        skill = (REPO_ROOT / "harness" / "harness-test" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        checklist = (
            REPO_ROOT / "harness" / "harness-test" / "checklist.md"
        ).read_text(encoding="utf-8")
        for required in (
            "harness_test_runner.py",
            "--profile safe",
            "--confirm-resource-intensive",
            "HARNESS_TEST_MAX_WORKERS",
        ):
            self.assertIn(required, skill)
        self.assertIn("单实例", checklist)
        self.assertIn("进程树", checklist)
        self.assertIn("资源密集型", checklist)

    def test_package_scripts_expose_safe_system_and_full_profiles(self) -> None:
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = package["scripts"]
        for name in ("test:harness:safe", "test:harness:system", "test:harness:full"):
            self.assertIn(name, scripts)
        self.assertIn("--profile safe", scripts["test:harness:safe"])
        self.assertIn("--profile system", scripts["test:harness:system"])
        self.assertIn("--profile full", scripts["test:harness:full"])

    def test_internal_concurrency_tests_obey_the_worker_budget(self) -> None:
        for name in ("test_harness_change.py", "test_harness_test_guard.py"):
            source = (SCRIPTS_DIR / "tests" / name).read_text(encoding="utf-8")
            self.assertIn("HARNESS_TEST_MAX_WORKERS", source, name)


if __name__ == "__main__":
    unittest.main()
