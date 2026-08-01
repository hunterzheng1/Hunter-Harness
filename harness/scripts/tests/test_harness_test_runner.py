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
    @staticmethod
    def _successful_command_result():
        return runner.CommandResult(
            returncode=0,
            timed_out=False,
            duration_seconds=0.01,
            process_tree_isolated=True,
        )

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

    def test_lock_records_exact_owner_heartbeat_expiry_and_closeout_receipt(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lock-") as raw_tmp:
            tmp = Path(raw_tmp)
            lock_root = tmp / "locks"
            lock = runner.TestRunLock(tmp / "project", lock_root=lock_root)
            lock.acquire()
            payload = json.loads(lock.path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], 2)
            self.assertEqual(payload["status"], "ACTIVE")
            self.assertTrue(payload["owner"]["executable"])
            self.assertTrue(payload["owner"]["startedAt"])
            self.assertGreater(payload["expiresAtUnix"], payload["heartbeatAtUnix"])
            lock.release()
            receipts = list((lock_root / "receipts").glob("*.json"))
            self.assertEqual(len(receipts), 1)
            closeout = json.loads(receipts[0].read_text(encoding="utf-8"))
            self.assertEqual(closeout["status"], "COMPLETED")
            self.assertEqual(closeout["token"], lock.token)

    def test_expired_dead_owner_lock_is_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lock-") as raw_tmp:
            tmp = Path(raw_tmp)
            lock_root = tmp / "locks"
            lock = runner.TestRunLock(tmp / "project", lock_root=lock_root)
            lock.path.parent.mkdir(parents=True)
            lock.path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "token": "dead-owner",
                        "status": "ACTIVE",
                        "heartbeatAtUnix": time.time() - 7200,
                        "expiresAtUnix": time.time() - 3600,
                        "owner": {
                            "pid": 99999999,
                            "executable": sys.executable,
                            "startedAt": "2000-01-01T00:00:00+00:00",
                        },
                    }
                ),
                encoding="utf-8",
            )
            lock.acquire()
            try:
                self.assertEqual(
                    runner.classify_test_lock(lock.path)["classification"],
                    "ACTIVE",
                )
                reap_receipts = list((lock_root / "receipts").glob("*-reap-*.json"))
                self.assertEqual(len(reap_receipts), 1)
                self.assertEqual(
                    json.loads(reap_receipts[0].read_text(encoding="utf-8"))[
                        "status"
                    ],
                    "REAPED",
                )
            finally:
                lock.release()

    def test_unexpired_lock_with_definitely_dead_owner_is_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lock-") as raw_tmp:
            tmp = Path(raw_tmp)
            lock_root = tmp / "locks"
            lock = runner.TestRunLock(tmp / "project", lock_root=lock_root)
            lock.path.parent.mkdir(parents=True)
            lock.path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "token": "dead-before-expiry",
                        "status": "ACTIVE",
                        "heartbeatAtUnix": time.time(),
                        "expiresAtUnix": time.time() + 3600,
                        "owner": {
                            "pid": 99999999,
                            "executable": sys.executable,
                            "startedAt": "2000-01-01T00:00:00+00:00",
                        },
                    }
                ),
                encoding="utf-8",
            )

            lock.acquire()

            try:
                self.assertEqual(
                    runner.classify_test_lock(lock.path)["classification"],
                    "ACTIVE",
                )
                self.assertEqual(
                    len(list((lock_root / "receipts").glob("*-reap-*.json"))),
                    1,
                )
            finally:
                lock.release()

    def test_expired_incomplete_owner_lock_is_report_only(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lock-") as raw_tmp:
            tmp = Path(raw_tmp)
            lock = runner.TestRunLock(tmp / "project", lock_root=tmp / "locks")
            lock.path.parent.mkdir(parents=True)
            lock.path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "token": "incomplete-owner",
                        "status": "ACTIVE",
                        "expiresAtUnix": time.time() - 3600,
                        "owner": {"pid": 99999999},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                runner.TestRunAlreadyActive,
                "OWNER_IDENTITY_INCOMPLETE",
            ):
                lock.acquire()
            self.assertTrue(lock.path.is_file())

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

    def test_keeps_test_runner_and_environment_lifecycle_on_the_shared_process_provider(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-provider-") as raw_tmp:
            with mock.patch.object(
                runner.hprocess,
                "spawn_structured_argv",
                wraps=runner.hprocess.spawn_structured_argv,
            ) as spawn:
                result = runner.run_managed_command(
                    [sys.executable, "-c", "print('provider')"],
                    cwd=Path(raw_tmp),
                    timeout_seconds=5,
                    environ={},
                    capture_output=True,
                )
            self.assertEqual(result.returncode, 0)
            self.assertTrue(spawn.called)
            self.assertIs(runner.henv.hprocess, runner.hprocess)

    def test_keeps_test_runner_and_environment_compatible_through_process_provider_migration(
        self,
    ) -> None:
        self.assertIs(runner.henv.hprocess, runner.hprocess)
        self.assertNotIn("hservice.terminate_process_tree", runner.henv.__dict__)

    def test_keeps_environment_and_test_runner_service_lifecycle_on_the_shared_provider(
        self,
    ) -> None:
        self.assertTrue(callable(runner.hprocess.observe_process_identity))
        self.assertTrue(callable(runner.hprocess.terminate_owned_tree))

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

    def test_detached_service_mode_contains_ordinary_child_when_lineage_scan_misses(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-lineage-race-") as raw_tmp:
            tmp = Path(raw_tmp)
            pid_file = tmp / "child.pid"
            script = (
                "import pathlib,subprocess,sys;"
                "child=subprocess.Popen([sys.executable,'-c',"
                "'import time;time.sleep(10)']);"
                "pathlib.Path(sys.argv[1]).write_text(str(child.pid),encoding='utf-8')"
            )
            with mock.patch.object(
                runner,
                "_update_windows_descendants",
                return_value=True,
            ):
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

    def test_exec_requires_declared_dynamic_environment_fields(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-env-") as raw_tmp:
            tmp = Path(raw_tmp)
            receipt = runner.henv.create_environment_receipt(
                tmp,
                stack_id="stack-a",
                content_evidence={
                    "instanceId": "db-1",
                    "canaries": [{"name": "db", "status": "PASS"}],
                },
                environment_values={"REDIS_URL": "redis://127.0.0.1/4"},
            )
            receipt_path = tmp / "environment-receipt.json"
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            stderr = io.StringIO()
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(runner, "run_managed_command") as managed,
                contextlib.redirect_stderr(stderr),
            ):
                code = runner.main(
                    [
                        "exec",
                        "--project",
                        raw_tmp,
                        "--environment-receipt",
                        str(receipt_path),
                        "--required-environment-field",
                        "REDIS_URL",
                        "--",
                        sys.executable,
                        "-c",
                        "print('must-not-run')",
                    ]
                )
            self.assertEqual(code, 6)
            self.assertIn("VERIFICATION_ENVIRONMENT_INCOMPLETE", stderr.getvalue())
            managed.assert_not_called()

    def test_exec_injects_only_receipted_dynamic_environment_fields(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-env-") as raw_tmp:
            tmp = Path(raw_tmp)
            values = {
                "DATABASE_URL": "postgresql://example/test",
                "REDIS_URL": "redis://example/7",
            }
            receipt = runner.henv.create_environment_receipt(
                tmp,
                stack_id="stack-a",
                content_evidence={
                    "instanceId": "db-1",
                    "canaries": [{"name": "db", "status": "PASS"}],
                },
                environment_values=values,
            )
            receipt_path = tmp / "environment-receipt.json"
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            with (
                mock.patch.dict(os.environ, values, clear=True),
                mock.patch.object(
                    runner,
                    "run_managed_command",
                    return_value=self._successful_command_result(),
                ) as managed,
            ):
                code = runner.main(
                    [
                        "exec",
                        "--project",
                        raw_tmp,
                        "--environment-receipt",
                        str(receipt_path),
                        "--required-environment-field",
                        "DATABASE_URL",
                        "--required-environment-field",
                        "REDIS_URL",
                        "--",
                        sys.executable,
                        "-c",
                        "print('ok')",
                    ]
                )
            self.assertEqual(code, 0)
            child_env = managed.call_args.kwargs["environ"]
            self.assertEqual(child_env["DATABASE_URL"], values["DATABASE_URL"])
            self.assertEqual(child_env["REDIS_URL"], values["REDIS_URL"])

    def test_exec_refuses_persistent_service_launches(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-service-") as raw_tmp:
            stderr = io.StringIO()
            with (
                mock.patch.object(runner, "run_managed_command") as managed,
                contextlib.redirect_stderr(stderr),
            ):
                code = runner.main(
                    [
                        "exec",
                        "--project",
                        raw_tmp,
                        "--",
                        sys.executable,
                        "harness/scripts/harness_service.py",
                        "ensure",
                        "--project",
                        raw_tmp,
                    ]
                )
            self.assertEqual(code, 7)
            self.assertIn("PERSISTENT_SERVICE_MODE_REQUIRED", stderr.getvalue())
            managed.assert_not_called()

    def test_parameter_file_preserves_argv_and_records_powershell_runtime(
        self,
    ) -> None:
        expected = [
            sys.executable,
            "-c",
            "import sys; print(sys.argv[1])",
            '{"template":"{{ value }}","unicode":"环境"}',
        ]
        with tempfile.TemporaryDirectory(prefix="harness-runner-argv-") as raw_tmp:
            tmp = Path(raw_tmp)
            observed: list[list[str]] = []
            for edition, version in (("Desktop", "5.1"), ("Core", "7.5.2")):
                envelope_path = tmp / f"argv-{edition}.json"
                runtime_path = tmp / f"runtime-{edition}.json"
                envelope_path.write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "transport": "utf8-json-argument-file",
                            "argv": expected,
                            "powershell": {
                                "edition": edition,
                                "version": version,
                            },
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                with mock.patch.object(
                    runner,
                    "run_managed_command",
                    return_value=self._successful_command_result(),
                ) as managed:
                    code = runner.main(
                        [
                            "exec",
                            "--project",
                            raw_tmp,
                            "--argv-file",
                            str(envelope_path),
                            "--runtime-receipt",
                            str(runtime_path),
                        ]
                    )
                self.assertEqual(code, 0)
                observed.append(list(managed.call_args.args[0]))
                runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                self.assertEqual(runtime["powershell"]["edition"], edition)
                self.assertEqual(runtime["powershell"]["version"], version)
                self.assertNotIn(expected[-1], json.dumps(runtime))
            self.assertEqual(observed, [expected, expected])

    def test_runtime_receipt_without_argument_file_fails_before_execution(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-runner-receipt-") as raw_tmp:
            stderr = io.StringIO()
            with (
                mock.patch.object(runner, "run_managed_command") as managed,
                contextlib.redirect_stderr(stderr),
            ):
                code = runner.main(
                    [
                        "exec",
                        "--project",
                        raw_tmp,
                        "--runtime-receipt",
                        str(Path(raw_tmp) / "runtime.json"),
                        "--",
                        sys.executable,
                        "-c",
                        "print('must-not-run')",
                    ]
                )
            self.assertEqual(code, 2)
            self.assertIn(
                "RUNTIME_RECEIPT_REQUIRES_ARGUMENT_FILE",
                stderr.getvalue(),
            )
            managed.assert_not_called()


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
