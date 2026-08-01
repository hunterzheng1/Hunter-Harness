from __future__ import annotations

import datetime as dt
import importlib.util
import inspect
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "harness_process.py"
SPEC = importlib.util.spec_from_file_location("harness_process_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PROCESS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PROCESS
SPEC.loader.exec_module(PROCESS)


def identity(
    *,
    pid: int = 4100,
    created_at: str | None = "2026-07-31T10:00:00+00:00",
    executable: str | None = "C:/Python/python.exe",
    argv_hash: str | None = "sha256:" + "a" * 64,
    cwd: str | None = "C:/work",
    parent_pid: int = 4000,
    owner_hash: str | None = "sha256:" + "b" * 64,
    platform: str = "POSIX",
) -> dict:
    return {
        "schemaVersion": 1,
        "pid": pid,
        "alive": True,
        "createdAt": created_at,
        "executable": executable,
        "argvHash": argv_hash,
        "workingDirectory": cwd,
        "parentIdentity": {
            "pid": parent_pid,
            "createdAt": "2026-07-31T09:59:59+00:00",
            "executable": executable,
        },
        "ownerTokenHash": owner_hash,
        "treeIdentity": {
            "platform": platform,
            "proofKind": "OBSERVED_SESSION",
            "memberPids": [pid],
            "complete": True,
            "groupId": pid,
            "sessionId": pid,
        },
        "fieldProvenance": {
            "pid": "OBSERVED",
            "createdAt": "OBSERVED",
            "executable": "OBSERVED",
            "argvHash": "OBSERVED",
            "workingDirectory": "OBSERVED",
            "parentIdentity": "OBSERVED",
            "ownerTokenHash": "ATTESTED",
            "treeIdentity": "OBSERVED",
        },
        "capabilities": {
            "canObserveCreateTime": True,
            "canObserveExecutable": True,
            "canObserveArgv": True,
            "canObserveWorkingDirectory": True,
            "canObserveParent": True,
            "canEnumerateTree": True,
            "canVerifyOwnership": True,
        },
    }


def posix_proof(*expected: dict) -> dict:
    leader = expected[0]
    return {
        "schemaVersion": 1,
        "kind": "POSIX_MEMBERS",
        "ownershipTokenHash": leader["ownerTokenHash"],
        "leaderPid": leader["pid"],
        "leaderCreatedAt": leader["createdAt"],
        "groupId": leader["treeIdentity"]["groupId"],
        "sessionId": leader["treeIdentity"]["sessionId"],
        "members": list(expected),
        "membersComplete": True,
        "leaderExited": False,
    }


class ProcessProviderTests(unittest.TestCase):
    def test_keeps_service_process_compatibility_exports_on_the_shared_provider(
        self,
    ) -> None:
        scripts_dir = str(SCRIPT.parent)
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import harness_process as provider
        import harness_service as service

        self.assertIs(service._process_provider, provider)
        with mock.patch.object(provider, "is_pid_alive", return_value=True) as alive:
            self.assertTrue(service.is_pid_alive(1234))
            alive.assert_called_once_with(1234)
        refused = service.terminate_process_tree(1234)
        self.assertEqual(refused.get("reasonCode"), "IDENTITY_UNVERIFIABLE")
        self.assertFalse(refused.get("cleanupComplete"))

    def test_observes_process_identity_independently_from_expected_state(self) -> None:
        signature = inspect.signature(PROCESS.observe_process_identity)
        self.assertEqual(list(signature.parameters), ["pid"])
        observed = PROCESS.observe_process_identity(sys.pid if hasattr(sys, "pid") else 0)
        self.assertFalse(observed["alive"])
        current = PROCESS.observe_process_identity(PROCESS.os.getpid())
        self.assertTrue(current["alive"])
        self.assertEqual(current["fieldProvenance"]["pid"], "OBSERVED")
        self.assertNotIn("expected", json.dumps(current).lower())

    def test_rejects_reused_pid_by_create_time(self) -> None:
        expected = identity()
        observed = identity(created_at="2026-07-31T10:01:00+00:00")
        result = PROCESS.verify_process_identity(expected, observed)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "PROCESS_CREATE_TIME_MISMATCH")
        self.assertFalse(result["authorized"])

    def test_rejects_every_mismatched_identity_dimension(self) -> None:
        cases = {
            "executable": ("C:/Other/python.exe", "PROCESS_EXECUTABLE_MISMATCH"),
            "argvHash": ("sha256:" + "c" * 64, "PROCESS_ARGV_MISMATCH"),
            "workingDirectory": ("C:/other", "PROCESS_CWD_MISMATCH"),
            "ownerTokenHash": ("sha256:" + "d" * 64, "PROCESS_OWNER_MISMATCH"),
        }
        for field, (actual, code) in cases.items():
            with self.subTest(field=field):
                expected = identity()
                observed = identity()
                observed[field] = actual
                result = PROCESS.verify_process_identity(expected, observed)
                self.assertFalse(result["ok"])
                self.assertEqual(result["reasonCode"], code)
        expected = identity()
        observed = identity(parent_pid=4900)
        result = PROCESS.verify_process_identity(expected, observed)
        self.assertEqual(result["reasonCode"], "PROCESS_PARENT_MISMATCH")

    def test_fails_closed_when_identity_cannot_be_proven(self) -> None:
        expected = identity()
        observed = identity(created_at=None)
        observed["fieldProvenance"]["createdAt"] = "UNAVAILABLE"
        observed["capabilities"]["canObserveCreateTime"] = False
        result = PROCESS.verify_process_identity(expected, observed)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "IDENTITY_UNVERIFIABLE")

    def test_round_trips_every_complex_structured_argv_element(self) -> None:
        with tempfile.TemporaryDirectory(prefix="进程 身份 ") as tmp:
            output = Path(tmp) / "参数.json"
            values = [
                "",
                "a b",
                "中文",
                '"quoted"',
                "`tick`",
                "&",
                "|",
                "<",
                ">",
                "%PATH%",
                "!bang!",
                "tail\\",
            ]
            script = (
                "import json,pathlib,sys;"
                "pathlib.Path(sys.argv[1]).write_text("
                "json.dumps(sys.argv[2:],ensure_ascii=False),encoding='utf-8')"
            )
            spawned = PROCESS.spawn_structured_argv(
                [sys.executable, "-c", script, str(output), *values],
                cwd=Path(tmp),
                environment={},
                owner_token="test-owner",
            )
            try:
                self.assertEqual(spawned.process.wait(timeout=20), 0)
                self.assertEqual(
                    json.loads(output.read_text(encoding="utf-8")),
                    values,
                )
                self.assertEqual(
                    spawned.attestation["argvHash"],
                    PROCESS.canonical_argv_hash(
                        [sys.executable, "-c", script, str(output), *values]
                    ),
                )
            finally:
                spawned.close()

    def test_terminates_only_a_fully_proven_owned_process_tree(self) -> None:
        leader = identity()
        child = identity(pid=4101, parent_pid=4100)
        child["treeIdentity"]["memberPids"] = [4100, 4101]
        child["treeIdentity"]["groupId"] = 4100
        child["treeIdentity"]["sessionId"] = 4100
        leader["treeIdentity"]["memberPids"] = [4100, 4101]
        proof = posix_proof(leader, child)
        alive = {4100, 4101}
        signalled: list[int] = []

        def observe(_proof):
            return [
                {**leader, "alive": leader["pid"] in alive},
                {**child, "alive": child["pid"] in alive},
            ]

        def signal(pid, _sig):
            signalled.append(pid)
            alive.discard(pid)

        result = PROCESS.terminate_owned_tree(
            leader,
            proof,
            timeout_policy={"graceSeconds": 0.01},
            member_observer=observe,
            signaler=signal,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(set(signalled), {4100, 4101})
        self.assertNotIn(4999, signalled)

    def test_never_terminates_an_unknown_process(self) -> None:
        expected = identity()
        observed = identity(created_at="2026-07-31T11:00:00+00:00")
        signalled: list[int] = []
        result = PROCESS.terminate_owned_tree(
            expected,
            posix_proof(expected),
            member_observer=lambda _proof: [observed],
            signaler=lambda pid, _sig: signalled.append(pid),
        )
        self.assertFalse(result["ok"])
        self.assertEqual(signalled, [])

    def test_normalizes_platform_provider_results(self) -> None:
        for platform in ("WINDOWS", "LINUX", "POSIX"):
            normalized = PROCESS.normalize_process_observation(
                {
                    "pid": 7,
                    "alive": True,
                    "platform": platform,
                    "createdAt": None,
                    "executable": None,
                }
            )
            self.assertEqual(normalized["schemaVersion"], 1)
            self.assertEqual(normalized["pid"], 7)
            self.assertEqual(normalized["fieldProvenance"]["pid"], "OBSERVED")
            self.assertEqual(
                set(normalized["capabilities"]),
                {
                    "canObserveCreateTime",
                    "canObserveExecutable",
                    "canObserveArgv",
                    "canObserveWorkingDirectory",
                    "canObserveParent",
                    "canEnumerateTree",
                    "canVerifyOwnership",
                },
            )

    def test_rejects_tampered_state_and_forged_owner_attestations(self) -> None:
        expected = identity()
        observed = identity()
        proof = posix_proof(expected)
        proof["ownershipTokenHash"] = "sha256:" + "f" * 64
        signalled: list[int] = []
        result = PROCESS.terminate_owned_tree(
            expected,
            proof,
            member_observer=lambda _proof: [observed],
            signaler=lambda pid, _sig: signalled.append(pid),
        )
        self.assertEqual(result["reasonCode"], "PROCESS_OWNER_MISMATCH")
        self.assertEqual(signalled, [])

    def test_rejects_posix_group_ownership_after_leader_exit_or_group_reuse(
        self,
    ) -> None:
        expected = identity()
        for mutation in (
            {"leaderExited": True},
            {"groupId": 9999},
            {"sessionId": 9999},
        ):
            with self.subTest(mutation=mutation):
                proof = posix_proof(expected)
                proof.update(mutation)
                result = PROCESS.validate_ownership_proof(
                    expected,
                    proof,
                    [identity()],
                )
                self.assertFalse(result["ok"])
                self.assertEqual(result["reasonCode"], "IDENTITY_UNVERIFIABLE")

    def test_refuses_group_termination_when_any_posix_member_is_foreign_or_unknown(
        self,
    ) -> None:
        expected = identity()
        foreign = identity(pid=4999, parent_pid=1)
        proof = posix_proof(expected)
        signalled: list[int] = []
        result = PROCESS.terminate_owned_tree(
            expected,
            proof,
            member_observer=lambda _proof: [identity(), foreign],
            signaler=lambda pid, _sig: signalled.append(pid),
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "IDENTITY_UNVERIFIABLE")
        self.assertEqual(signalled, [])

    def test_requires_platform_ownership_proof_in_addition_to_complete_process_identity(
        self,
    ) -> None:
        signalled: list[int] = []
        result = PROCESS.terminate_owned_tree(
            identity(),
            None,
            member_observer=lambda _proof: [identity()],
            signaler=lambda pid, _sig: signalled.append(pid),
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "IDENTITY_UNVERIFIABLE")
        self.assertEqual(signalled, [])


if __name__ == "__main__":
    unittest.main()
