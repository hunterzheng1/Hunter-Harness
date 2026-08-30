import datetime as dt
import importlib.util
import json
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_context.py"
SPEC = importlib.util.spec_from_file_location("harness_context_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CONTEXT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTEXT)
# 权威阶段清单与别名表都住在 harness_paths（叶子模块），context 引的是同一个对象。
hpaths = CONTEXT.hpaths


def make_change(project: Path, name: str, status: str = "active") -> Path:
    change = project / ".harness/changes" / name
    (change / "meta").mkdir(parents=True)
    (change / "meta/change-context.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "changeName": name,
                "lifecycle": {"status": status},
                "stateOwnership": {
                    "runtimeRoot": f".harness/state/changes/{name}"
                },
            }
        ),
        encoding="utf-8",
    )
    return change


def init_repo(project: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.name", "tester"], cwd=project, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=project, check=True)
    (project / "tracked.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=project, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=project, check=True)


def add_linked_worktree(project: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "worktree", "add", "--detach", str(target), "HEAD"],
        cwd=project,
        check=True,
        capture_output=True,
    )


class HarnessContextTest(unittest.TestCase):
    def test_json_flag_is_accepted_after_every_subcommand(self) -> None:
        parser = CONTEXT.build_parser()
        command_lines = [
            ["prepare", "--project", ".", "--phase", "execute", "--executor", "codex", "--json"],
            [
                "close",
                "--project",
                ".",
                "--change",
                "demo",
                "--from-phase",
                "execute",
                "--to-phase",
                "execute",
                "--executor",
                "codex",
                "--json",
            ],
            [
                "begin",
                "--project",
                ".",
                "--change",
                "demo",
                "--phase",
                "execute",
                "--executor",
                "codex",
                "--json",
            ],
            ["view", "--project", ".", "--change", "demo", "--json"],
        ]
        for argv in command_lines:
            with self.subTest(argv=argv):
                self.assertTrue(parser.parse_args(argv).json)

    def test_prepare_bootstraps_unique_active_change_and_execution_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "active")
            make_change(project, "archived", "archived")
            result = CONTEXT.prepare_context(
                project, phase="execute", executor="codex", ttl_seconds=60
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["changeName"], "active")
            self.assertTrue(result["legacyBootstrap"])
            self.assertEqual(result["nextPhases"], ["plan", "execute"])
            self.assertEqual(result["executionRoot"], str(project.resolve()))

    def test_prepare_persists_the_first_plan_display_title(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "pomodoro-timer")

            first = CONTEXT.prepare_context(
                project,
                change="pomodoro-timer",
                phase="plan",
                executor="codex",
                display_title="番茄钟计时器",
            )
            second = CONTEXT.prepare_context(
                project,
                change="pomodoro-timer",
                phase="plan",
                executor="codex",
                display_title="不应覆盖原始标题",
            )

            self.assertTrue(first["ok"], first)
            self.assertTrue(second["ok"], second)
            self.assertEqual(first["displayTitle"], "番茄钟计时器")
            self.assertEqual(second["displayTitle"], "番茄钟计时器")
            metadata = json.loads(
                (change / "meta/change-title.json").read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["displayTitle"], "番茄钟计时器")

            args = CONTEXT.build_parser().parse_args(
                [
                    "prepare",
                    "--project",
                    str(project),
                    "--change",
                    "pomodoro-timer",
                    "--phase",
                    "plan",
                    "--executor",
                    "codex",
                    "--title",
                    "番茄钟计时器",
                ]
            )
            self.assertEqual(args.title, "番茄钟计时器")

    def test_prepare_resolves_relative_worktree_path_from_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            change = make_change(project, "active")
            worktree = project / ".worktrees" / "active"
            add_linked_worktree(project, worktree)
            (change / "meta/worktree.json").write_text(
                json.dumps(
                    {
                        "created": False,
                        "path": ".worktrees/active",
                        "worktreeRoot": ".worktrees",
                    }
                ),
                encoding="utf-8",
            )

            result = CONTEXT.prepare_context(
                project,
                change="active",
                phase="execute",
                executor="codex",
                ttl_seconds=60,
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["executionRoot"], str(worktree.resolve()))

    def test_prepare_supports_worktree_path_and_exact_worktree_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            cases = (
                ("worktree-path", "worktreePath"),
                ("exact-root", "worktreeRoot"),
            )
            for change_name, field in cases:
                with self.subTest(field=field):
                    change = make_change(project, change_name)
                    worktree = project / ".worktrees" / change_name
                    add_linked_worktree(project, worktree)
                    (change / "meta/worktree.json").write_text(
                        json.dumps({field: f".worktrees/{change_name}"}),
                        encoding="utf-8",
                    )
                    result = CONTEXT.prepare_context(
                        project,
                        change=change_name,
                        phase="execute",
                        executor="codex",
                        ttl_seconds=60,
                    )
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(result["executionRoot"], str(worktree.resolve()))

    def test_prepare_rejects_declared_non_git_and_foreign_worktrees(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project = base / "project"
            project.mkdir()
            init_repo(project)
            plain = base / "plain"
            plain.mkdir()
            foreign = base / "foreign"
            foreign.mkdir()
            init_repo(foreign)
            for change_name, target in (("plain", plain), ("foreign", foreign)):
                with self.subTest(change=change_name):
                    change = make_change(project, change_name)
                    (change / "meta/worktree.json").write_text(
                        json.dumps({"worktreePath": str(target)}),
                        encoding="utf-8",
                    )
                    result = CONTEXT.prepare_context(
                        project,
                        change=change_name,
                        phase="execute",
                        executor="codex",
                    )
                    self.assertFalse(result["ok"], result)
                    self.assertEqual(result["code"], "EXECUTION_WORKTREE_INVALID")

    def test_prepare_rejects_independent_clone_with_same_origin_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project = base / "project"
            project.mkdir()
            init_repo(project)
            subprocess.run(
                ["git", "remote", "add", "origin", "https://example.test/shared/repo.git"],
                cwd=project,
                check=True,
            )
            clone = base / "clone"
            subprocess.run(["git", "clone", "-q", str(project), str(clone)], check=True)
            subprocess.run(
                ["git", "remote", "set-url", "origin", "https://example.test/shared/repo.git"],
                cwd=clone,
                check=True,
            )
            change = make_change(project, "clone")
            (change / "meta/worktree.json").write_text(
                json.dumps({"worktreePath": str(clone)}),
                encoding="utf-8",
            )

            result = CONTEXT.prepare_context(
                project,
                change="clone",
                phase="execute",
                executor="codex",
            )

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "EXECUTION_WORKTREE_INVALID")

    def test_prepare_fails_closed_for_ambiguous_active_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "one")
            make_change(project, "two")
            result = CONTEXT.prepare_context(
                project, phase="execute", executor="codex"
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "ACTIVE_CHANGE_AMBIGUOUS")
            self.assertEqual(result["candidates"], ["one", "two"])

    def test_executor_change_without_receipt_requires_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            first = CONTEXT.prepare_context(
                project,
                change="change",
                phase="plan",
                executor="codebuddy",
                ttl_seconds=60,
            )
            self.assertTrue(first["ok"])
            state = project / ".harness/state/changes/change/runtime"
            (state / "context-lease.json").unlink()
            second = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="codex"
            )
            self.assertFalse(second["ok"])
            self.assertEqual(second["code"], "HANDOFF_REQUIRED")

    def test_review_fixback_can_reselect_unbegun_submit_branch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project,
                change="change",
                phase="review",
                executor="cursor",
            )
            closed = CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="submit",
                executor="cursor",
            )
            self.assertTrue(closed["ok"], closed)

            selected = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
            )

            self.assertTrue(selected["ok"], selected)
            self.assertEqual(selected["latestTransition"]["toPhase"], "execute")
            self.assertEqual(
                selected["latestTransition"]["trigger"], "review-fixback"
            )

    def test_review_fixback_treats_plain_review_execute_handoff_as_selected(self) -> None:
        """P0-3：review 关门时已显式交接 execute（普通 trigger，非 review-fixback），
        fixback 重入必须视为已选定，而不是 FIXBACK_RESELECT_UNAVAILABLE。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="cursor"
            )
            closed = CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="execute",
                executor="cursor",
            )
            self.assertTrue(closed["ok"], closed)

            selected = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
            )

            self.assertTrue(selected["ok"], selected)
            self.assertEqual(selected["latestTransition"]["toPhase"], "execute")
            # 普通交接不会被改写成 review-fixback
            self.assertNotEqual(
                selected["latestTransition"].get("trigger"), "review-fixback"
            )

    def test_review_fixback_reselects_when_review_closed_without_successor(self) -> None:
        """P0-3：execute→review 之后 review 已关门（phase.end）但从没写后继分支
        （0.4.7 plain close 的断链产物）——fixback 必须能补写 review→execute 收据。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="cursor"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="execute",
                to_phase="review",
                executor="cursor",
            )
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="cursor"
            )
            # review 关门但没交接：phase.end 已写，后继 receipt 缺失
            state = project / ".harness/state/changes/change"
            with (state / "events.ndjson").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "type": "phase.start", "phase": "review", "run_id": "run-1",
                }) + "\n")
                fh.write(json.dumps({
                    "type": "phase.end", "phase": "review",
                    "run_id": "run-1", "status": "OK",
                }) + "\n")

            selected = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
            )

            self.assertTrue(selected["ok"], selected)
            self.assertEqual(selected["latestTransition"]["fromPhase"], "review")
            self.assertEqual(selected["latestTransition"]["toPhase"], "execute")
            self.assertEqual(
                selected["latestTransition"]["trigger"], "review-fixback"
            )

    def test_review_fixback_unavailable_reports_state_when_review_open(self) -> None:
        """review 尚未关门时拒绝重选，但必须给出当前状态与可执行恢复指引。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="cursor"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="execute",
                to_phase="review",
                executor="cursor",
            )
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="cursor"
            )

            selected = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
            )

            self.assertFalse(selected["ok"], selected)
            self.assertEqual(selected["code"], "FIXBACK_RESELECT_UNAVAILABLE")
            self.assertEqual(
                selected["latestTransition"],
                {"fromPhase": "execute", "toPhase": "review", "trigger": None},
            )
            self.assertFalse(selected["reviewPhaseEnded"])
            self.assertIn("harness_gate.py close", selected["recoveryAction"])

    def test_cancel_prepared_fixback_removes_unstarted_target_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="cursor"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="submit",
                executor="cursor",
            )
            prepared = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
            )
            self.assertTrue(prepared["ok"], prepared)
            self.assertTrue(CONTEXT.begin_transition(
                project, "change", phase="execute", executor="cursor"
            )["ok"])

            cancelled = CONTEXT.cancel_prepared_context(
                project, "change", phase="execute", executor="cursor"
            )

            self.assertTrue(cancelled["ok"], cancelled)
            view = CONTEXT.context_view(project, "change")
            self.assertIsNone(view["current"])
            runtime = project / ".harness" / "state" / "changes" / "change" / "runtime"
            self.assertFalse((runtime / "context-lease.json").exists())
            self.assertFalse(any(
                item.get("phase") == "execute"
                for item in view["attemptHistory"]["begins"]
            ))

    def test_duplicate_fixback_cannot_cancel_the_running_preparation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="cursor"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="submit",
                executor="cursor",
            )
            first = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
                preparation_id="fixback-run-1",
            )
            self.assertTrue(first["ok"], first)
            begun = CONTEXT.begin_transition(
                project,
                "change",
                phase="execute",
                executor="cursor",
                preparation_id="fixback-run-1",
            )
            self.assertTrue(begun["ok"], begun)

            duplicate = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
                preparation_id="fixback-run-2",
            )
            self.assertFalse(duplicate["ok"], duplicate)
            self.assertEqual(duplicate["code"], "CONTEXT_PREPARATION_ACTIVE")
            cancellation = CONTEXT.cancel_prepared_context(
                project,
                "change",
                phase="execute",
                executor="cursor",
                preparation_id="fixback-run-2",
            )
            self.assertEqual(cancellation["code"], "PREPARED_CONTEXT_NOT_OWNED")

            view = CONTEXT.context_view(project, "change")
            self.assertEqual(view["current"]["preparationId"], "fixback-run-1")
            lease_path = (
                project
                / ".harness"
                / "state"
                / "changes"
                / "change"
                / "runtime"
                / "context-lease.json"
            )
            lease = json.loads(lease_path.read_text(encoding="utf-8"))
            self.assertEqual(
                lease["preparationId"], "fixback-run-1"
            )
            self.assertTrue(any(
                item.get("preparationId") == "fixback-run-1"
                for item in view["attemptHistory"]["begins"]
            ))

    def test_concurrent_fixback_preparations_claim_only_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="cursor"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="submit",
                executor="cursor",
            )
            ready = threading.Barrier(2)

            def prepare(preparation_id: str) -> dict:
                ready.wait(timeout=5)
                return CONTEXT.prepare_context(
                    project,
                    change="change",
                    phase="execute",
                    executor="cursor",
                    trigger="review-fixback",
                    preparation_id=preparation_id,
                )

            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(
                    pool.map(prepare, ["fixback-concurrent-a", "fixback-concurrent-b"])
                )

            self.assertEqual(sum(bool(item["ok"]) for item in results), 1, results)
            blocked = next(item for item in results if not item["ok"])
            self.assertEqual(blocked["code"], "CONTEXT_PREPARATION_ACTIVE")
            winner = next(item for item in results if item["ok"])
            lease_path = (
                project
                / ".harness/state/changes/change/runtime/context-lease.json"
            )
            lease = json.loads(lease_path.read_text(encoding="utf-8"))
            self.assertEqual(
                lease["preparationId"], winner["lease"]["preparationId"]
            )

    def test_review_fixback_cannot_reselect_after_submit_begin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project,
                change="change",
                phase="review",
                executor="cursor",
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="submit",
                executor="cursor",
            )
            self.assertTrue(
                CONTEXT.begin_transition(
                    project,
                    "change",
                    phase="submit",
                    executor="cursor",
                )["ok"]
            )

            selected = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="cursor",
                trigger="review-fixback",
            )

            self.assertFalse(selected["ok"])
            self.assertEqual(selected["code"], "FIXBACK_RESELECT_UNSAFE")

    def test_close_and_begin_cross_tool_receipt_with_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "change")
            artifact = change / "plans/plan.md"
            artifact.parent.mkdir()
            artifact.write_text("approved plan", encoding="utf-8")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="codebuddy"
            )
            closed = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor="codebuddy",
                artifacts=[str(artifact)],
            )
            self.assertTrue(closed["ok"])
            begun = CONTEXT.begin_transition(
                project, "change", phase="execute", executor="codex"
            )
            self.assertTrue(begun["ok"])
            self.assertEqual(begun["receipt"]["fromPhase"], "plan")
            self.assertEqual(begun["receipt"]["toPhase"], "execute")

    def test_configured_phase_plan_allows_run_to_archive_and_skips_optional_phases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "fast-change")
            (change / "meta" / "gate-policy.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "tier": "fast",
                        "source": "change",
                        "defaultPhases": ["plan", "execute", "archive"],
                    }
                ),
                encoding="utf-8",
            )

            configured = CONTEXT.configure_phase_plan(
                project,
                "fast-change",
                phases=["plan", "execute", "archive"],
                operator="tester",
                reason="本次只需本地快速迭代",
            )
            self.assertTrue(configured["ok"], configured)
            self.assertEqual(configured["plannedPhases"], ["plan", "execute", "archive"])
            self.assertEqual(
                [item["phase"] for item in configured["skippedPhases"]],
                ["review", "package", "apidoc", "submit"],
            )

            prepared = CONTEXT.prepare_context(
                project,
                change="fast-change",
                phase="plan",
                executor="codex",
            )
            self.assertEqual(prepared["nextPhases"], ["execute"])
            self.assertEqual(prepared["plannedPhases"], ["plan", "execute", "archive"])
            self.assertTrue(
                CONTEXT.close_transition(
                    project,
                    "fast-change",
                    from_phase="plan",
                    to_phase="execute",
                    executor="codex",
                )["ok"]
            )
            self.assertTrue(
                CONTEXT.begin_transition(
                    project,
                    "fast-change",
                    phase="execute",
                    executor="codex",
                )["ok"]
            )
            run_context = CONTEXT.prepare_context(
                project,
                change="fast-change",
                phase="execute",
                executor="codex",
            )
            self.assertEqual(run_context["nextPhases"], ["archive", "execute"])
            self.assertTrue(
                CONTEXT.close_transition(
                    project,
                    "fast-change",
                    from_phase="execute",
                    to_phase="archive",
                    executor="codex",
                )["ok"]
            )
            illegal = CONTEXT.close_transition(
                project,
                "fast-change",
                from_phase="execute",
                to_phase="review",
                executor="codex",
            )
            self.assertFalse(illegal["ok"])
            self.assertEqual(illegal["code"], "TRANSITION_ILLEGAL")

    def test_configure_phase_plan_inserts_merge_for_worktree_execution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "worktree-change")
            (change / "meta/worktree.json").write_text(
                json.dumps(
                    {
                        "requested": True,
                        "created": True,
                        "path": ".worktrees/worktree-change",
                        "worktreeRoot": ".worktrees",
                        "branch": "harness/worktree-change",
                    }
                ),
                encoding="utf-8",
            )

            configured = CONTEXT.configure_phase_plan(
                project,
                "worktree-change",
                phases=["plan", "execute", "review", "submit", "archive"],
                operator="tester",
                reason="使用隔离 worktree 完成实现",
            )

            self.assertTrue(configured["ok"], configured)
            self.assertEqual(
                configured["plannedPhases"],
                ["plan", "execute", "review", "submit", "merge", "archive"],
            )
            persisted = json.loads(
                (change / "meta/gate-policy.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["plannedPhases"], configured["plannedPhases"])
            self.assertNotIn(
                "merge", [item["phase"] for item in configured["skippedPhases"]]
            )

    def test_close_accepts_absolute_project_relative_and_change_relative_artifacts(self) -> None:
        forms = (
            lambda project, change, artifact: str(artifact),
            lambda project, change, artifact: artifact.relative_to(project).as_posix(),
            lambda project, change, artifact: artifact.relative_to(change).as_posix(),
        )
        hashes: set[str] = set()
        for artifact_form in forms:
            with self.subTest(form=artifact_form), tempfile.TemporaryDirectory() as tmp:
                project = Path(tmp)
                change = make_change(project, "change")
                artifact = change / "meta/plan-finalization.json"
                artifact.write_text('{"status":"finalized"}\n', encoding="utf-8")
                CONTEXT.prepare_context(
                    project, change="change", phase="plan", executor="planner"
                )

                result = CONTEXT.close_transition(
                    project,
                    "change",
                    from_phase="plan",
                    to_phase="execute",
                    executor="planner",
                    artifacts=[artifact_form(project, change, artifact)],
                )

                self.assertTrue(result["ok"], result)
                self.assertEqual(
                    result["receipt"]["artifacts"][0]["path"],
                    ".harness/changes/change/meta/plan-finalization.json",
                )
                hashes.add(result["receipt"]["artifacts"][0]["sha256"])
        self.assertEqual(len(hashes), 1)

    def test_close_accepts_artifact_from_split_state_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            state_artifact = (
                project
                / ".harness/state/changes/change/evidence/verification-ledger.json"
            )
            state_artifact.parent.mkdir(parents=True)
            state_artifact.write_text('{"schemaVersion":3}\n', encoding="utf-8")
            CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="runner"
            )

            result = CONTEXT.close_transition(
                project,
                "change",
                from_phase="execute",
                to_phase="execute",
                executor="runner",
                artifacts=["evidence/verification-ledger.json"],
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(
                result["receipt"]["artifacts"][0]["path"],
                ".harness/state/changes/change/evidence/verification-ledger.json",
            )

    def test_close_rejects_missing_directory_and_outside_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as external:
            project = Path(tmp)
            change = make_change(project, "change")
            directory = change / "meta"
            outside = Path(external) / "outside.json"
            outside.write_text("outside\n", encoding="utf-8")
            invalid_paths = [
                str(change / "meta/missing.json"),
                str(directory),
                str(outside),
            ]
            for invalid_path in invalid_paths:
                with self.subTest(path=invalid_path):
                    CONTEXT.prepare_context(
                        project, change="change", phase="plan", executor="planner"
                    )
                    result = CONTEXT.close_transition(
                        project,
                        "change",
                        from_phase="plan",
                        to_phase="execute",
                        executor="planner",
                        artifacts=[invalid_path],
                    )
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["code"], "TRANSITION_ARTIFACT_INVALID")
                    self.assertEqual(len(result["acceptedBases"]), 3)
                    self.assertTrue(result["examples"])

    def test_close_rejects_an_ambiguous_relative_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "change")
            project_artifact = project / "meta/plan-finalization.json"
            project_artifact.parent.mkdir(parents=True)
            project_artifact.write_text("project", encoding="utf-8")
            change_artifact = change / "meta/plan-finalization.json"
            change_artifact.write_text("change", encoding="utf-8")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="planner"
            )

            result = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor="planner",
                artifacts=["meta/plan-finalization.json"],
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "TRANSITION_ARTIFACT_AMBIGUOUS")

    def test_close_is_idempotent_after_the_context_lease_is_released(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="planner"
            )
            first = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor=None,
            )
            second = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor=None,
            )

            self.assertTrue(first["ok"], first)
            self.assertTrue(second["ok"], second)
            self.assertEqual(second["code"], "TRANSITION_ALREADY_CLOSED")
            self.assertTrue(second["idempotent"])
            self.assertEqual(
                second["receipt"]["receiptHash"], first["receipt"]["receiptHash"]
            )

    def test_begin_rejects_artifact_hash_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = make_change(project, "change")
            artifact = change / "plans/plan.md"
            artifact.parent.mkdir()
            artifact.write_text("approved", encoding="utf-8")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="codebuddy"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor="codebuddy",
                artifacts=[str(artifact)],
            )
            artifact.write_text("tampered", encoding="utf-8")
            result = CONTEXT.begin_transition(
                project, "change", phase="execute", executor="codex"
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "HANDOFF_IDENTITY_MISMATCH")

    def test_lease_active_blocks_and_expired_lease_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            first = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="agent-a",
                ttl_seconds=60,
            )
            self.assertTrue(first["ok"])
            blocked = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="agent-b"
            )
            self.assertEqual(blocked["code"], "CONTEXT_LEASE_HELD")
            lease_path = project / ".harness/state/changes/change/runtime/context-lease.json"
            lease = json.loads(lease_path.read_text(encoding="utf-8"))
            lease["expiresAt"] = (
                dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
            ).isoformat()
            lease_path.write_text(json.dumps(lease), encoding="utf-8")
            recovered = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="agent-b"
            )
            self.assertTrue(recovered["ok"])
            self.assertEqual(recovered["recovery"]["code"], "LEASE_EXPIRED_RECOVERED")

    def test_fixback_transition_defers_invalidation_until_changed_files_are_known(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            state = project / ".harness/state/changes/change"
            (state / "evidence").mkdir(parents=True)
            ledger_path = state / "evidence/verification-ledger.json"
            ledger_path.write_text(
                json.dumps(
                    {
                        "verificationTargets": {
                            "unit": {
                                "id": "unit",
                                "verification": "unitTestFull",
                                "status": "OK",
                            },
                            "api": {
                                "id": "api",
                                "verification": "apiTest",
                                "status": "OK",
                            },
                        },
                        "validations": {},
                    }
                ),
                encoding="utf-8",
            )
            CONTEXT.prepare_context(
                project, change="change", phase="review", executor="reviewer"
            )
            result = CONTEXT.close_transition(
                project,
                "change",
                from_phase="review",
                to_phase="execute",
                executor="reviewer",
            )
            self.assertTrue(result["ok"])
            updated = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual(len(updated["verificationTargets"]), 2)
            self.assertNotIn("reusable", updated["verificationTargets"]["unit"])
            self.assertNotIn("reusable", updated["verificationTargets"]["api"])
            self.assertIn("invalidation", result)
            self.assertTrue(result["invalidation"]["deferred"])

    def test_view_reconstructs_append_only_transition_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="planner"
            )
            CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor="planner",
            )
            view = CONTEXT.context_view(project, "change")
            self.assertEqual(len(view["transitions"]), 1)
            self.assertEqual(view["currentPhase"], "execute")
            self.assertIn("attemptHistory", view)


class ContextLeaseLifetimeTests(unittest.TestCase):
    """A lease that outlived its TTL is not evidence of a conflict.

    `_claim_lease` only refuses a *live* lease held by someone else, and a
    takeover rewrites the owner. So at close time a real conflict always shows
    up as CONTEXT_LEASE_MISMATCH; an expired lease with the same owner means
    only that the phase ran longer than the TTL, which plan and run phases do.
    """

    def _prepared(self, project: Path) -> None:
        make_change(project, "demo")
        init_repo(project)
        result = CONTEXT.prepare_context(
            project, phase="plan", executor="codex", ttl_seconds=3600
        )
        self.assertTrue(result["ok"], result)

    def _expire_lease(self, project: Path) -> dict:
        state = project / ".harness/state/changes/demo/runtime/context-lease.json"
        lease = json.loads(state.read_text(encoding="utf-8"))
        lease["expiresAt"] = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
        ).isoformat()
        state.write_text(json.dumps(lease), encoding="utf-8")
        return lease

    def test_close_succeeds_after_the_lease_lapsed_and_records_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self._prepared(project)
            self._expire_lease(project)

            result = CONTEXT.close_transition(
                project, "demo", from_phase="plan", to_phase="execute",
                executor="codex", artifacts=[], status="OK",
            )

            self.assertTrue(result["ok"], result)
            self.assertIn("leaseLapsed", result["receipt"])

    def test_close_still_refuses_a_lease_owned_by_someone_else(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self._prepared(project)
            state = project / ".harness/state/changes/demo/runtime/context-lease.json"
            lease = json.loads(state.read_text(encoding="utf-8"))
            lease["owner"] = "another-agent"
            state.write_text(json.dumps(lease), encoding="utf-8")

            result = CONTEXT.close_transition(
                project, "demo", from_phase="plan", to_phase="execute",
                executor="codex", artifacts=[], status="OK",
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "CONTEXT_LEASE_MISMATCH")

    def test_renew_extends_only_the_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self._prepared(project)
            stale = self._expire_lease(project)
            current_before = (
                project / ".harness/state/changes/demo/runtime/current-context.json"
            ).read_text(encoding="utf-8")

            result = CONTEXT.renew_lease(
                project, "demo", executor="codex", ttl_seconds=3600
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "CONTEXT_LEASE_RENEWED")
            self.assertTrue(result["wasLapsed"])
            self.assertGreater(result["lease"]["expiresAt"], stale["expiresAt"])
            self.assertEqual(result["lease"]["owner"], "codex")
            self.assertEqual(
                (project / ".harness/state/changes/demo/runtime/current-context.json")
                .read_text(encoding="utf-8"),
                current_before,
                "renew must not rewrite the current context",
            )

    def test_renew_refuses_a_lease_owned_by_someone_else(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self._prepared(project)

            result = CONTEXT.renew_lease(project, "demo", executor="intruder")

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "CONTEXT_LEASE_MISMATCH")


class HarnessContextBootstrapPlanTest(unittest.TestCase):
    """阶段 0 一次性引导：doctor + prepare + capture + classify + phase.start。

    拆成 5 条子进程调用时，每条都要 agent 记住完整 argv，日志里已经出现过两次
    因为参数残缺而白跑一轮；run-id 还必须由 agent 自己生成并保证小写字母开头。
    这些都是脚本该负责的确定性工作。
    """

    @staticmethod
    def _events(change_dir: Path) -> list[dict]:
        path = change_dir / "events.ndjson"
        if not path.is_file():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_bootstrap_plan_returns_run_identity_and_writes_phase_start(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)

            result = CONTEXT.bootstrap_plan(
                project,
                change="demo-change",
                executor="codex",
                display_title="演示变更",
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "PLAN_BOOTSTRAPPED")
            self.assertEqual(result["changeName"], "demo-change")
            self.assertEqual(result["attempt"], 1)
            # v2 identity：必须小写字母开头，裸 UUID 有 10/16 概率被拒
            self.assertRegex(result["runId"], r"^plan_[a-z0-9][a-z0-9_.:-]*$")
            self.assertTrue(result["tier"])
            self.assertIn("plan", result["defaultPhases"])
            self.assertTrue(result["changeBase"])

            # 产物必须落在 change 目录，不是执行根——两者在无 worktree 时不相等
            change_dir = project / ".harness/changes/demo-change"
            self.assertEqual(result["changeDir"], str(change_dir.resolve()))
            self.assertTrue((change_dir / "meta/gate-policy.json").is_file())
            self.assertTrue((change_dir / "meta/state-snapshot.json").is_file())

            starts = [e for e in self._events(change_dir) if e.get("type") == "phase.start"]
            self.assertEqual(len(starts), 1)
            self.assertEqual(starts[0].get("runId") or starts[0].get("run_id"), result["runId"])

    def test_bootstrap_plan_rerun_reuses_run_id_without_second_phase_start(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)

            first = CONTEXT.bootstrap_plan(project, change="demo-change", executor="codex")
            second = CONTEXT.bootstrap_plan(project, change="demo-change", executor="codex")

            # 换 run-id 会让 finalize 的生命周期身份校验 fail-closed，重跑必须复用
            self.assertEqual(second["runId"], first["runId"])
            self.assertEqual(second["attempt"], first["attempt"])
            self.assertTrue(second["reused"])
            change_dir = project / ".harness/changes/demo-change"
            starts = [e for e in self._events(change_dir) if e.get("type") == "phase.start"]
            self.assertEqual(len(starts), 1)

    def test_bootstrap_plan_keeps_change_base_immutable_across_commits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)
            first = CONTEXT.bootstrap_plan(project, change="demo-change", executor="codex")

            (project / "tracked.txt").write_text("moved\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "next"], cwd=project, check=True)
            second = CONTEXT.bootstrap_plan(project, change="demo-change", executor="codex")

            # changeBase 是计划起点，HEAD 前进不得把它冲掉（design §3.6）
            self.assertEqual(second["changeBase"], first["changeBase"])
            self.assertNotEqual(second["head"], first["changeBase"])

    def test_bootstrap_plan_autocreates_changes_dir_for_initialized_project(self) -> None:
        """已 init 但从未建过 change 的项目：自动补建 changes/，不再误导去跑 init。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            (project / ".harness").mkdir()
            self.assertFalse((project / ".harness/changes").exists())

            result = CONTEXT.bootstrap_plan(project, change="demo-change", executor="codex")

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "PLAN_BOOTSTRAPPED")
            self.assertTrue((project / ".harness/changes/demo-change").is_dir())

    def test_bootstrap_plan_uninitialized_project_reports_init_hint(self) -> None:
        """`.harness` 本身不存在才是未初始化——保留 PROJECT_ROOT_INVALID 与 init 提示。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)

            result = CONTEXT.bootstrap_plan(project, change="demo-change", executor="codex")

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PROJECT_ROOT_INVALID")
            self.assertIn("hunter-harness init", result["error"])


class V2PlanHandoffBootstrapTests(unittest.TestCase):
    """v2 plan finalize 不写 context 交接凭证，run 阶段因此必然卡死。

    执行日志里的实际后果：prepare 报 HANDOFF_REQUIRED、begin 报
    LEGACY_BOOTSTRAP_REQUIRED，两个错误都不带恢复路径，调用方只能去读脚本源码，
    最后自己拼出 classify + configure-plan + close 三步把凭证补出来——约 20 次
    工具调用，且 close 的参数全是现编的，可审计性反而更差。

    committed 的发布 journal 就是"plan 确实完成了"的机器证据，比手搓的 close
    更强。这里冻结：有该证据时自动补录交接凭证；没有时仍然 fail-closed。
    """

    def _make_project(self) -> Path:
        project = Path(tempfile.mkdtemp(prefix="harness-v2-handoff-"))
        init_repo(project)
        (project / ".harness/changes").mkdir(parents=True)
        return project

    @staticmethod
    def _write_committed_journal(project: Path, change: str) -> Path:
        journal_dir = project / ".harness/changes" / change / "meta" / "publication-journals"
        journal_dir.mkdir(parents=True, exist_ok=True)
        path = journal_dir / "plan_finalize%3Ademo%3Aabc123.json"
        path.write_text(
            json.dumps({
                "schema_version": 1,
                "operation_id": f"plan_finalize:{change}:abc123",
                "change_key": change,
                "state": "committed",
                "readback": "verified",
            }),
            encoding="utf-8",
        )
        return path

    def test_prepare_run_bootstraps_transition_from_committed_publication(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            project.mkdir()
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)
            CONTEXT.bootstrap_plan(project, change="demo-change", executor="codebuddy")
            self._write_committed_journal(project, "demo-change")

            result = CONTEXT.prepare_context(
                project, change="demo-change", phase="execute", executor="codebuddy"
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "CONTEXT_PREPARED")

    def test_bootstrapped_receipt_records_its_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            project.mkdir()
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)
            CONTEXT.bootstrap_plan(project, change="demo-change", executor="codebuddy")
            self._write_committed_journal(project, "demo-change")

            CONTEXT.prepare_context(
                project, change="demo-change", phase="execute", executor="codebuddy"
            )

            view = CONTEXT.context_view(project, "demo-change")
            transitions = view["transitions"]
            self.assertEqual(len(transitions), 1, transitions)
            receipt = transitions[-1]
            self.assertEqual(receipt["fromPhase"], "plan")
            self.assertEqual(receipt["toPhase"], "execute")
            self.assertEqual(receipt["status"], "OK")
            # 自动补录必须留痕，否则事后无法把它与人工 close 区分开
            self.assertEqual(receipt["bootstrapSource"], "plan_publication_journal")
            self.assertIn("demo-change", receipt["bootstrapEvidence"])

    def test_without_committed_publication_the_handoff_still_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            project.mkdir()
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)
            CONTEXT.bootstrap_plan(project, change="demo-change", executor="codebuddy")

            result = CONTEXT.prepare_context(
                project, change="demo-change", phase="execute", executor="codebuddy"
            )

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "HANDOFF_REQUIRED")

    def test_uncommitted_publication_is_not_accepted_as_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            project.mkdir()
            init_repo(project)
            (project / ".harness/changes").mkdir(parents=True)
            CONTEXT.bootstrap_plan(project, change="demo-change", executor="codebuddy")
            journal = self._write_committed_journal(project, "demo-change")
            payload = json.loads(journal.read_text(encoding="utf-8"))
            payload["state"] = "applying"
            journal.write_text(json.dumps(payload), encoding="utf-8")

            result = CONTEXT.prepare_context(
                project, change="demo-change", phase="execute", executor="codebuddy"
            )

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "HANDOFF_REQUIRED")


class PhasePlanDegradationTests(unittest.TestCase):
    """阶段计划读不动时必须说明原因，不能悄悄退成 legacy。

    以前遇到未知阶段名一律返回 (None, "legacy")：整个阶段计划失效，
    _allowed_next_phases 退回硬编码的 PHASE_GRAPH，而调用方看不出发生过这件事。
    这不是假想问题——阶段清单少一个 merge 时，worktree 变更的 plannedPhases
    就带着 merge 走到这里。
    """

    def _policy(self, tmp: Path, phases: list[str]) -> Path:
        change = tmp / "change"
        (change / "meta").mkdir(parents=True)
        (change / "meta" / "gate-policy.json").write_text(
            json.dumps({"schemaVersion": 1, "plannedPhases": phases}),
            encoding="utf-8",
        )
        return change

    def test_a_valid_plan_is_read_as_planned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._policy(Path(tmp), ["plan", "execute", "archive"])

            planned, source = CONTEXT._phase_plan(change)

            self.assertEqual(planned, ["plan", "execute", "archive"])
            self.assertEqual(source, "change")

    def test_an_unknown_phase_names_itself_in_the_degradation_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._policy(Path(tmp), ["plan", "run", "teleport", "archive"])

            planned, source = CONTEXT._phase_plan(change)

            self.assertIsNone(planned)
            # 降级仍然发生（fail-safe），但原因和具体阶段名要带出来。
            self.assertIn("unknown-phases", source)
            self.assertIn("teleport", source)

    def test_a_renamed_phase_is_read_through_the_alias_table(self) -> None:
        """run/test 合并为 execute 后历史 change 仍要能读——本仓库没有 change 级 schema 迁移。"""
        with tempfile.TemporaryDirectory() as tmp:
            change = self._policy(
                Path(tmp), ["plan", "run", "test", "review", "archive"]
            )

            planned, source = CONTEXT._phase_plan(change)

            # 两个旧名映射到同一个 execute，保序去重。
            self.assertEqual(planned, ["plan", "execute", "review", "archive"])
            self.assertEqual(source, "change")

    def test_unreadable_policy_is_distinguished_from_a_missing_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            (change / "meta").mkdir(parents=True)
            (change / "meta" / "gate-policy.json").write_text("{not json", encoding="utf-8")

            _planned, source = CONTEXT._phase_plan(change)

            self.assertEqual(source, "legacy:policy-unreadable")
            # 文件不存在是另一回事，不该与"读坏了"混为一谈。
            self.assertEqual(CONTEXT._phase_plan(Path(tmp) / "absent")[1], "legacy")


class SamePhaseAdoptionTests(unittest.TestCase):
    """上一个工具崩了没能正常 close，接手的工具也得能把这个阶段干完。

    以前只要 executor 变了就要求一张 transition receipt，可 receipt 正是
    上一阶段 close 才会写的——崩溃场景里它根本不存在，于是任务卡死。跨阶段
    推进仍然必须有证据，同阶段接管不需要。

    并发保护不受影响：租约未过期而 owner 不同，CONTEXT_LEASE_HELD 已经在更早
    的地方拦下了，能走到接管这一步只剩「租约过期」和「租约已被 close 删除」。
    """

    def _adoptions(self, project: Path, change: str) -> list[dict]:
        path = (
            project
            / ".harness/state/changes"
            / change
            / "runtime/context-adoptions.ndjson"
        )
        if not path.is_file():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_same_phase_executor_change_is_adopted_without_a_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            first = CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="codex",
                ttl_seconds=60,
            )
            self.assertTrue(first["ok"], first)
            # 上一个工具没能正常收尾，只留下一个被清掉的租约。
            state = project / ".harness/state/changes/change/runtime"
            (state / "context-lease.json").unlink()

            second = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="codebuddy"
            )

            self.assertTrue(second["ok"], second)

    def test_adoption_is_recorded_not_silent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="codex",
                ttl_seconds=60,
            )
            state = project / ".harness/state/changes/change/runtime"
            (state / "context-lease.json").unlink()

            CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="codebuddy"
            )

            # 接管必须落盘。以前过期租约允许任何执行者顶替，但只在返回体里挂一个
            # recovery，退出进程就没了，事后查"谁接手的"无据可依。
            adoptions = self._adoptions(project, "change")
            self.assertEqual(len(adoptions), 1, adoptions)
            self.assertEqual(adoptions[0]["previousExecutor"], "codex")
            self.assertEqual(adoptions[0]["newExecutor"], "codebuddy")
            self.assertEqual(adoptions[0]["phase"], "execute")
            self.assertEqual(adoptions[0]["reason"], "same_phase_handoff")

    def test_expired_lease_recovery_is_recorded_as_such(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="codex",
                ttl_seconds=1,
            )
            state = project / ".harness/state/changes/change/runtime"
            lease_path = state / "context-lease.json"
            lease = json.loads(lease_path.read_text(encoding="utf-8"))
            lease["expiresAt"] = "2000-01-01T00:00:00+00:00"
            lease_path.write_text(json.dumps(lease), encoding="utf-8")

            second = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="codebuddy"
            )

            self.assertTrue(second["ok"], second)
            adoptions = self._adoptions(project, "change")
            self.assertEqual(len(adoptions), 1, adoptions)
            self.assertEqual(adoptions[0]["reason"], "lease_expired")
            self.assertEqual(adoptions[0]["previousOwner"], "codex")

    def test_cross_phase_jump_without_a_receipt_is_still_blocked(self) -> None:
        """收窄的是同阶段接管，跨阶段推进照旧要证据。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project,
                change="change",
                phase="plan",
                executor="codex",
                ttl_seconds=60,
            )
            state = project / ".harness/state/changes/change/runtime"
            (state / "context-lease.json").unlink()

            second = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="codex"
            )

            self.assertFalse(second["ok"], second)
            self.assertEqual(second["code"], "HANDOFF_REQUIRED")

    def test_a_live_lease_held_by_another_executor_still_blocks(self) -> None:
        """接管只在旧持有者已失活时成立，不能拿它绕过并发保护。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project,
                change="change",
                phase="execute",
                executor="codex",
                ttl_seconds=3600,
            )

            second = CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="codebuddy"
            )

            self.assertFalse(second["ok"], second)
            self.assertEqual(second["code"], "CONTEXT_LEASE_HELD")
            self.assertEqual(self._adoptions(project, "change"), [])


if __name__ == "__main__":
    unittest.main()
