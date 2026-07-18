#!/usr/bin/env python3
"""Harness integration transaction.

Reentrant, journaled submit pipeline that never stashes, moves or overwrites
the primary worktree. All target-branch mutation happens inside a temporary
integration worktree; the journal is the single contract for step order,
identities and recovery.

Steps: preflight → prepare → merge → verify → push → cleanup.
Journal: ``.harness/state/integration/<transaction-id>/journal.json``.

Python 3.10+, stdlib only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_change  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

STEP_ORDER = ["preflight", "prepare", "merge", "verify", "push", "cleanup"]
_FOREIGN_PATTERNS = (
    re.compile(r"^\.harness/changes/([^/]+)(/|$)"),
    re.compile(r"^\.harness/state/changes/([^/]+)(/|$)"),
)


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


class IntegrationError(Exception):
    code = "INTEGRATION_ERROR"


class IntegrationLockHeldError(IntegrationError):
    code = "INTEGRATION_LOCK_HELD"


class MergeFailedError(IntegrationError):
    code = "MERGE_FAILED"


class ForeignChangePathsError(IntegrationError):
    code = "FOREIGN_CHANGE_PATHS"


class VerificationFailedError(IntegrationError):
    code = "VERIFICATION_FAILED"


class TargetMovedError(IntegrationError):
    code = "TARGET_MOVED"


class CleanupRefusedError(IntegrationError):
    code = "CLEANUP_REFUSED"


class JournalConflictError(IntegrationError):
    code = "JOURNAL_CONFLICT"


JOURNAL_LOCK_STALE_SECONDS = 300


class GitRunner:
    """Recordable git invocation wrapper (command spy for audits)."""

    def __init__(self) -> None:
        self.history: list[tuple[str, tuple[str, ...]]] = []

    def run(self, cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        self.history.append((str(cwd), tuple(args)))
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if check and proc.returncode != 0:
            raise IntegrationError(
                f"git {' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip()}"
            )
        return proc

    def text(self, cwd: Path, *args: str) -> str | None:
        proc = self.run(cwd, *args, check=False)
        if proc.returncode != 0:
            return None
        return proc.stdout.strip()


def _sanitize(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "txn"


def journal_dir(project_root: Path, transaction_id: str) -> Path:
    return (
        Path(project_root)
        / ".harness"
        / "state"
        / "integration"
        / transaction_id
    )


def journal_path(project_root: Path, transaction_id: str) -> Path:
    return journal_dir(project_root, transaction_id) / "journal.json"


def load_journal(project_root: Path, transaction_id: str) -> dict[str, Any]:
    path = journal_path(project_root, transaction_id)
    if not path.is_file():
        raise FileNotFoundError(f"journal not found: {path}")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _acquire_journal_lock(lock_path: Path, journal_path: Path) -> int:
    for _attempt in range(2):
        try:
            descriptor = os.open(
                str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
            )
            payload = json.dumps(
                {"pid": os.getpid(), "createdAtEpoch": time.time()},
                separators=(",", ":"),
            ).encode("utf-8")
            try:
                os.write(descriptor, payload)
                os.fsync(descriptor)
            except BaseException:
                os.close(descriptor)
                lock_path.unlink(missing_ok=True)
                raise
            return descriptor
        except FileExistsError as exc:
            stale = False
            try:
                owner = json.loads(lock_path.read_text(encoding="utf-8-sig"))
                owner_pid = int(owner.get("pid") or 0)
                created = float(owner.get("createdAtEpoch") or 0)
                stale = not _pid_alive(owner_pid) and (
                    created <= 0
                    or time.time() - created > JOURNAL_LOCK_STALE_SECONDS
                )
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                try:
                    stale = (
                        time.time() - lock_path.stat().st_mtime
                        > JOURNAL_LOCK_STALE_SECONDS
                    )
                except OSError:
                    stale = True
            if stale:
                try:
                    lock_path.unlink()
                except FileNotFoundError:
                    pass
                continue
            raise JournalConflictError(
                f"journal writer already active: {journal_path}"
            ) from exc
    raise JournalConflictError(f"could not reclaim stale journal lock: {journal_path}")


def _write_journal(project_root: Path, journal: dict[str, Any]) -> None:
    path = journal_path(project_root, journal["transactionId"])
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    lock_fd = _acquire_journal_lock(lock_path, path)
    os.close(lock_fd)
    expected_revision = int(journal.get("revision") or 0)
    try:
        if path.is_file():
            current = json.loads(path.read_text(encoding="utf-8-sig"))
            current_revision = int(current.get("revision") or 0)
            if current_revision != expected_revision:
                raise JournalConflictError(
                    f"stale journal revision: expected {expected_revision}, "
                    f"current {current_revision}"
                )
        elif expected_revision != 0:
            raise JournalConflictError(
                f"journal disappeared at revision {expected_revision}: {path}"
            )
        journal["revision"] = expected_revision + 1
        text = json.dumps(journal, ensure_ascii=False, indent=2) + "\n"
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            tmp.write_text(text, encoding="utf-8", newline="\n")
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    finally:
        lock_path.unlink(missing_ok=True)


class IntegrationTransaction:
    def __init__(
        self,
        *,
        project_root: Path,
        change_id: str,
        run_id: str,
        target_branch: str,
        feature_branch: str,
        temp_root: Path,
        runner: GitRunner | None = None,
    ) -> None:
        self.project_root = harness_paths.resolve_main_project_root(Path(project_root))
        self.change_id = change_id
        self.run_id = run_id
        self.target_branch = target_branch
        self.feature_branch = feature_branch
        self.temp_root = Path(temp_root).resolve()
        self.runner = runner or GitRunner()
        self.transaction_id = f"{_sanitize(change_id)}-{_sanitize(run_id)}"
        self.temp_branch = f"harness/integration/{self.transaction_id}"

    # ------------------------------------------------------------- journal

    def _new_journal(self, base: str, feature_head: str) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "transactionId": self.transaction_id,
            "changeName": self.change_id,
            "runId": self.run_id,
            "repositoryId": harness_paths.repository_identity(self.project_root),
            "primaryRoot": str(self.project_root),
            "targetBranch": self.target_branch,
            "featureBranch": self.feature_branch,
            "base": base,
            "featureHead": feature_head,
            "evidenceIdentity": self._evidence_identity(),
            "mergeCommit": None,
            "pushedHead": None,
            "integrationRoot": str(self.temp_root / self.transaction_id),
            "allowedCleanupRoot": str(self.temp_root / self.transaction_id),
            "protectionRefs": {
                "base": f"refs/harness/integration/{self.transaction_id}/base",
                "head": f"refs/harness/integration/{self.transaction_id}/head",
            },
            "steps": [
                {"name": name, "status": "PENDING", "attempt": 0}
                for name in STEP_ORDER
            ],
            "createdAt": now_iso(),
        }

    def _evidence_identity(self) -> dict[str, Any]:
        change_dir = (
            self.project_root / ".harness" / "changes" / self.change_id
        ).resolve()
        state_candidates = [
            self.project_root / ".harness" / "state" / "changes" / self.change_id,
            change_dir,
        ]
        events_file = next(
            (root / "events.ndjson" for root in state_candidates if (root / "events.ndjson").is_file()),
            None,
        )
        event_count = 0
        last_event_id = None
        event_hash = None
        if events_file is not None:
            raw = events_file.read_bytes()
            event_hash = "sha256:" + hashlib.sha256(raw).hexdigest()
            for line in raw.decode("utf-8", "replace").splitlines():
                if not line.strip():
                    continue
                event_count += 1
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                last_event_id = item.get("id") or item.get("eventId") or last_event_id

        artifact_hash = None
        ledger_identity: dict[str, Any] = {}
        for root in state_candidates:
            for rel in (
                Path("evidence/artifact-manifest.json"),
                Path("evidence/archive-manifest-before.json"),
                Path("evidence/test-tracking.json"),
            ):
                candidate = root / rel
                if candidate.is_file():
                    artifact_hash = "sha256:" + hashlib.sha256(candidate.read_bytes()).hexdigest()
                    break
            if artifact_hash:
                break
        for root in state_candidates:
            ledger_path = root / "evidence" / "verification-ledger.json"
            if not ledger_path.is_file():
                continue
            try:
                ledger = json.loads(ledger_path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                break
            for key in (
                "schemaVersion",
                "repositoryId",
                "changeName",
                "baseCommit",
                "currentHead",
                "diffHash",
                "ownershipHash",
            ):
                ledger_identity[key] = ledger.get(key)
            break
        return {
            "eventHighWater": {
                "count": event_count,
                "lastEventId": last_event_id,
                "sha256": event_hash,
            },
            "artifactManifestHash": artifact_hash,
            "ledgerIdentity": ledger_identity,
        }

    def _load(self) -> dict[str, Any]:
        return load_journal(self.project_root, self.transaction_id)

    def _save(self, journal: dict[str, Any]) -> dict[str, Any]:
        _write_journal(self.project_root, journal)
        return journal

    def _step(self, journal: dict[str, Any], name: str) -> dict[str, Any]:
        return next(s for s in journal["steps"] if s["name"] == name)

    def _run_step(
        self,
        name: str,
        action: Callable[[dict[str, Any]], None],
    ) -> dict[str, Any]:
        journal = self._load()
        step = self._step(journal, name)
        if step["status"] == "DONE":
            step["reentry"] = "REUSED"
            return self._save(journal)
        step["status"] = "RUNNING"
        step["attempt"] = int(step.get("attempt", 0)) + 1
        step["startedAt"] = now_iso()
        step.pop("error", None)
        self._save(journal)
        try:
            action(journal)
        except IntegrationError as exc:
            journal = self._load()
            step = self._step(journal, name)
            step["status"] = "FAILED"
            step["error"] = f"{exc.code}: {exc}"
            step["finishedAt"] = now_iso()
            self._save(journal)
            raise
        except Exception as exc:  # unexpected: still journal the failure
            journal = self._load()
            step = self._step(journal, name)
            step["status"] = "FAILED"
            step["error"] = f"UNEXPECTED: {exc}"
            step["finishedAt"] = now_iso()
            self._save(journal)
            raise
        journal = self._load()
        step = self._step(journal, name)
        step["status"] = "DONE"
        step["finishedAt"] = now_iso()
        return self._save(journal)

    # -------------------------------------------------------------- steps

    def preflight(self) -> dict[str, Any]:
        def action(journal: dict[str, Any]) -> None:
            base = self.runner.text(
                self.project_root, "rev-parse", self.target_branch
            )
            feature_head = self.runner.text(
                self.project_root, "rev-parse", self.feature_branch
            )
            if not base or not feature_head:
                raise IntegrationError("target or feature branch not found")
            fresh = self._new_journal(base, feature_head)
            fresh["revision"] = int(journal.get("revision") or 0)
            journal.clear()
            journal.update(fresh)
            # Re-mark preflight RUNNING on the fresh journal.
            step = self._step(journal, "preflight")
            step["status"] = "RUNNING"
            step["attempt"] = 1
            step["startedAt"] = now_iso()
            refs = journal["protectionRefs"]
            self.runner.run(
                self.project_root, "update-ref", refs["base"], base
            )
            self.runner.run(
                self.project_root, "update-ref", refs["head"], feature_head
            )
            self._save(journal)

        try:
            existing = self._load()
            step = self._step(existing, "preflight")
            if step["status"] == "DONE":
                step["reentry"] = "REUSED"
                return self._save(existing)
        except FileNotFoundError:
            pass

        # Acquire the target lock BEFORE writing any state: a rejected
        # contender must leave the worktree and state files untouched.
        lock = harness_change.integration_lock_acquire(
            self.project_root, run_id=self.run_id
        )
        if not lock.get("ok"):
            raise IntegrationLockHeldError(
                f"integration lock held: {lock.get('holder')}"
            )

        # Bootstrap: write an initial journal so _run_step has something to load.
        initial = {
            "schemaVersion": 1,
            "transactionId": self.transaction_id,
            "changeName": self.change_id,
            "runId": self.run_id,
            "steps": [
                {"name": name, "status": "PENDING", "attempt": 0}
                for name in STEP_ORDER
            ],
        }
        self._save(initial)
        return self._run_step("preflight", action)

    def prepare(self) -> dict[str, Any]:
        def action(journal: dict[str, Any]) -> None:
            # Best-effort fetch; absence of a remote is tolerated.
            self.runner.run(
                self.project_root,
                "fetch",
                "origin",
                self.target_branch,
                check=False,
            )
            base = journal["base"]
            self.runner.run(
                self.project_root, "branch", "-f", self.temp_branch, base
            )
            intg_root = Path(journal["integrationRoot"])
            intg_root.parent.mkdir(parents=True, exist_ok=True)
            self.runner.run(
                self.project_root,
                "worktree",
                "add",
                str(intg_root),
                self.temp_branch,
            )

        return self._run_step("prepare", action)

    def _foreign_paths(self, journal: dict[str, Any]) -> list[str]:
        diff = self.runner.text(
            self.project_root,
            "diff",
            "--name-only",
            journal["base"],
            journal["featureHead"],
        )
        contract: dict[str, Any] = {}
        contract_path = (
            self.project_root
            / ".harness"
            / "changes"
            / self.change_id
            / "meta"
            / "change-context.json"
        )
        if contract_path.is_file():
            try:
                contract = json.loads(contract_path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                contract = {}
        if not contract:
            shown = self.runner.text(
                self.project_root,
                "show",
                f"{journal['featureHead']}:.harness/changes/{self.change_id}/meta/change-context.json",
            )
            if shown:
                try:
                    contract = json.loads(shown)
                except json.JSONDecodeError:
                    contract = {}
        ownership = contract.get("ownership") or {}
        scoped = bool(
            ownership.get("productPaths") or ownership.get("staticEvidencePaths")
        )
        foreign: list[str] = []
        for line in (diff or "").splitlines():
            line = line.strip()
            if not line:
                continue
            if scoped:
                verdict = hl._classify_ownership_path(line, self.change_id, ownership)
                if verdict == "foreign":
                    foreign.append(line)
                continue
            for pattern in _FOREIGN_PATTERNS:
                match = pattern.match(line)
                if match and match.group(1) != self.change_id:
                    foreign.append(line)
                    break
        return foreign

    def merge(self) -> dict[str, Any]:
        def action(journal: dict[str, Any]) -> None:
            current_target = self.runner.text(
                self.project_root, "rev-parse", self.target_branch
            )
            if current_target != journal["base"]:
                raise TargetMovedError(
                    f"local {self.target_branch} moved: expected "
                    f"{journal['base']}, found {current_target}"
                )
            foreign = self._foreign_paths(journal)
            if foreign:
                raise ForeignChangePathsError(
                    "merge diff touches other changes: " + ", ".join(sorted(foreign))
                )
            intg_root = Path(journal["integrationRoot"])
            proc = self.runner.run(
                intg_root,
                "merge",
                "--no-ff",
                "-m",
                f"harness: integrate {self.change_id} into {self.target_branch}",
                self.feature_branch,
                check=False,
            )
            if proc.returncode != 0:
                raise MergeFailedError(proc.stderr.strip() or "merge conflict")
            journal["mergeCommit"] = self.runner.text(intg_root, "rev-parse", "HEAD")
            self._save(journal)

        return self._run_step("merge", action)

    def verify(self, commands: Sequence[Sequence[str]] | None = None) -> dict[str, Any]:
        commands = list(commands or [])

        def action(journal: dict[str, Any]) -> None:
            intg_root = Path(journal["integrationRoot"]).resolve()
            results: list[dict[str, Any]] = []
            for command in commands:
                started = dt.datetime.now().astimezone()
                proc = subprocess.run(
                    list(command),
                    cwd=str(intg_root),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                finished = dt.datetime.now().astimezone()
                results.append(
                    {
                        "command": list(command),
                        "exitCode": proc.returncode,
                        "startedAt": started.isoformat(timespec="milliseconds"),
                        "finishedAt": finished.isoformat(timespec="milliseconds"),
                        "durationMs": int(
                            (finished - started).total_seconds() * 1000
                        ),
                    }
                )
                if proc.returncode != 0:
                    journal["verifyResults"] = results
                    self._save(journal)
                    raise VerificationFailedError(
                        f"command failed ({proc.returncode}): {' '.join(command)}"
                    )
            journal["verifyResults"] = results
            journal["verifyCwd"] = str(intg_root)
            basis = json.dumps(
                {
                    "mergeCommit": journal.get("mergeCommit"),
                    "results": results,
                    "evidenceIdentity": journal.get("evidenceIdentity"),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            journal["verificationIdentity"] = {
                "sha256": "sha256:" + hashlib.sha256(basis.encode("utf-8")).hexdigest(),
                "ledgerIdentity": (journal.get("evidenceIdentity") or {}).get("ledgerIdentity") or {},
            }
            self._save(journal)

        return self._run_step("verify", action)

    def push(self) -> dict[str, Any]:
        def action(journal: dict[str, Any]) -> None:
            remote_head = self.runner.text(
                self.project_root, "ls-remote", "origin", self.target_branch
            )
            remote_head = (remote_head or "").split()[0] if remote_head else ""
            if not remote_head:
                raise IntegrationError(
                    f"remote branch not found: origin/{self.target_branch}"
                )
            if remote_head != journal["base"]:
                raise TargetMovedError(
                    f"remote {self.target_branch} moved: expected "
                    f"{journal['base']}, found {remote_head}"
                )
            merge_commit = journal.get("mergeCommit")
            if not merge_commit:
                raise IntegrationError("merge step not completed")
            self.runner.run(
                self.project_root,
                "push",
                "origin",
                f"{merge_commit}:refs/heads/{self.target_branch}",
            )
            journal["pushedHead"] = merge_commit
            self._save(journal)

        return self._run_step("push", action)

    # ------------------------------------------------------------ cleanup

    def cleanup_target(self, target: Path) -> None:
        """Boundary-checked removal of this transaction's exact worktree."""
        resolved = harness_paths.assert_path_within(target, self.temp_root)
        try:
            journal = self._load()
        except FileNotFoundError as exc:
            raise CleanupRefusedError(
                f"no journal for transaction {self.transaction_id}; "
                f"refusing cleanup of {resolved}"
            ) from exc
        allowed = journal.get("allowedCleanupRoot")
        if not allowed or resolved != Path(allowed).resolve():
            raise CleanupRefusedError(
                f"refusing to clean non-transaction path: {resolved}"
            )
        self.runner.run(
            self.project_root, "worktree", "remove", "--force", str(resolved),
            check=False,
        )
        if resolved.exists():
            shutil.rmtree(resolved)
        listed = self.runner.text(self.project_root, "worktree", "list", "--porcelain")
        if listed and str(resolved) in listed:
            raise IntegrationError(f"worktree still registered: {resolved}")

    def cleanup(self) -> dict[str, Any]:
        try:
            existing = self._load()
            step = self._step(existing, "cleanup")
            if step["status"] == "DONE":
                step["reentry"] = "REUSED"
                return self._save(existing)
        except FileNotFoundError:
            raise IntegrationError("cannot cleanup before preflight")

        def action(journal: dict[str, Any]) -> None:
            intg_root = Path(journal["integrationRoot"])
            if intg_root.exists():
                self.cleanup_target(intg_root)
            self.runner.run(
                self.project_root, "branch", "-D", self.temp_branch, check=False
            )
            if self._step(journal, "push")["status"] == "DONE":
                refs = journal["protectionRefs"]
                for ref in (refs["base"], refs["head"]):
                    self.runner.run(
                        self.project_root, "update-ref", "-d", ref, check=False
                    )

        journal = self._run_step("cleanup", action)
        harness_change.integration_lock_release(self.project_root, run_id=self.run_id)
        return journal

    # ------------------------------------------------------------ recover

    def recover(
        self, verify_commands: Sequence[Sequence[str]] | None = None
    ) -> dict[str, Any]:
        journal = self._load()
        actions: dict[str, Callable[[], dict[str, Any]]] = {
            "preflight": self.preflight,
            "prepare": self.prepare,
            "merge": self.merge,
            "verify": lambda: self.verify(commands=verify_commands),
            "push": self.push,
            "cleanup": self.cleanup,
        }
        for name in STEP_ORDER:
            step = self._step(journal, name)
            if step["status"] == "DONE":
                step["reentry"] = "REUSED"
                self._save(journal)
                continue
            journal = actions[name]()
        return self._load()

    def status(self) -> dict[str, Any]:
        journal = self._load()
        return {
            "ok": True,
            "transactionId": self.transaction_id,
            "steps": journal["steps"],
            "mergeCommit": journal.get("mergeCommit"),
            "pushedHead": journal.get("pushedHead"),
        }


# ------------------------------------------------------------------- CLI


def _txn_from_args(args: argparse.Namespace) -> IntegrationTransaction:
    return IntegrationTransaction(
        project_root=Path.cwd(),
        change_id=args.change,
        run_id=args.run_id,
        target_branch=args.target_branch,
        feature_branch=args.feature_branch,
        temp_root=Path(args.temp_root),
    )


def _emit(payload: Any) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return 0


def cmd_preflight(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).preflight())


def cmd_prepare(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).prepare())


def cmd_merge(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).merge())


def _parse_verify_commands(values: Sequence[str] | None) -> list[list[str]]:
    """Split ``--command`` strings honoring quotes (shlex, POSIX mode).

    Plain ``str.split(" ")`` breaks quoted arguments (e.g. ``-k 'a b'``).
    POSIX shlex semantics: single/double quotes group tokens, backslash
    escapes the next character (quote Windows paths).
    """
    return [shlex.split(value) for value in (values or [])]


def cmd_verify(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).verify(commands=_parse_verify_commands(args.command)))


def cmd_push(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).push())


def cmd_cleanup(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).cleanup())


def cmd_recover(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).recover())


def cmd_status(args: argparse.Namespace) -> int:
    return _emit(_txn_from_args(args).status())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_integration.py")
    sub = parser.add_subparsers(dest="command_name", required=True)

    def add(name: str, func: Callable[[argparse.Namespace], int]) -> None:
        p = sub.add_parser(name)
        p.add_argument("--change", required=True)
        p.add_argument("--run-id", required=True)
        p.add_argument("--target-branch", default="main")
        p.add_argument("--feature-branch", required=True)
        p.add_argument("--temp-root", required=True)
        p.set_defaults(func=func)

    add("preflight", cmd_preflight)
    add("prepare", cmd_prepare)
    add("merge", cmd_merge)
    add("push", cmd_push)
    add("cleanup", cmd_cleanup)
    add("recover", cmd_recover)
    add("status", cmd_status)

    p_verify = sub.add_parser("verify")
    p_verify.add_argument("--change", required=True)
    p_verify.add_argument("--run-id", required=True)
    p_verify.add_argument("--target-branch", default="main")
    p_verify.add_argument("--feature-branch", required=True)
    p_verify.add_argument("--temp-root", required=True)
    p_verify.add_argument("--command", action="append")
    p_verify.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except IntegrationError as exc:
        sys.stderr.write(
            json.dumps(
                {"ok": False, "code": exc.code, "message": str(exc)},
                ensure_ascii=False,
            )
            + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
