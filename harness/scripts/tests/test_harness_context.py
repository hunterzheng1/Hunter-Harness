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

    def test_close_transition_auto_pairs_missing_phase_end(self) -> None:
        """P0-2：不经 gate close 的阶段（plan）写交接收据时自动补齐 phase.end，
        平台计时事件对不再缺口。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="plan", executor="cursor"
            )
            # plan 阶段的 phase.start（bootstrap-plan 的位置由调用方承担）
            contract = project / ".harness/changes/change"
            (contract / "events.ndjson").write_text(
                json.dumps({
                    "type": "phase.start", "phase": "plan",
                    "run_id": "plan_demo", "attempt": 1,
                }) + "\n",
                encoding="utf-8",
            )

            closed = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor="cursor",
            )

            self.assertTrue(closed["ok"], closed)
            self.assertEqual(
                closed["phaseEndPair"]["code"], "PHASE_END_AUTO_PAIRED"
            )
            events = [
                json.loads(line)
                for line in (contract / "events.ndjson").read_text(
                    encoding="utf-8"
                ).splitlines()
                if line.strip()
            ]
            ends = [
                e for e in events
                if e.get("type") == "phase.end" and e.get("phase") == "plan"
            ]
            self.assertEqual(len(ends), 1)
            self.assertEqual(ends[0]["run_id"], "plan_demo")

            # 幂等：重复 close 不再追加第二条 phase.end
            again = CONTEXT.close_transition(
                project,
                "change",
                from_phase="plan",
                to_phase="execute",
                executor="cursor",
            )
            self.assertTrue(again["ok"], again)
            self.assertIsNone(again["phaseEndPair"])
            events2 = (contract / "events.ndjson").read_text(encoding="utf-8")
            self.assertEqual(events2.count('"phase.end"'), 1)

    def test_close_transition_skips_pairing_when_gate_close_already_wrote_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="cursor"
            )
            contract = project / ".harness/changes/change"
            (contract / "events.ndjson").write_text(
                json.dumps({"type": "phase.start", "phase": "execute", "run_id": "ex_1", "attempt": 1}) + "\n"
                + json.dumps({"type": "phase.end", "phase": "execute", "run_id": "ex_1", "attempt": 1, "status": "OK"}) + "\n",
                encoding="utf-8",
            )

            closed = CONTEXT.close_transition(
                project,
                "change",
                from_phase="execute",
                to_phase="review",
                executor="cursor",
            )

            self.assertTrue(closed["ok"], closed)
            self.assertIsNone(closed["phaseEndPair"])

    def test_handoff_repairs_closed_phase_without_transition(self) -> None:
        """P0-1：review 已关门（phase.end）但没写交接的断链状态，一条 handoff
        命令完成 补租约→写收据→begin 确认，不再需要六命令 choreography。"""
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
            # review 关门但没交接（0.4.7 plain close 的产物）
            state = project / ".harness/state/changes/change"
            with (state / "events.ndjson").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "type": "phase.start", "phase": "review", "run_id": "run-1",
                }) + "\n")
                fh.write(json.dumps({
                    "type": "phase.end", "phase": "review",
                    "run_id": "run-1", "status": "OK",
                }) + "\n")

            result = CONTEXT.handoff_transition(
                project, "change", to_phase="submit", executor="cursor"
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "HANDOFF_COMPLETED")
            self.assertEqual(result["fromPhase"], "review")
            self.assertEqual(result["toPhase"], "submit")
            self.assertEqual(result["transition"]["code"], "TRANSITION_CLOSED")
            view = CONTEXT.context_view(project, "change")
            self.assertEqual(view["currentPhase"], "submit")
            self.assertEqual(view["current"]["phase"], "submit")

    def test_handoff_with_existing_transition_only_confirms_begin(self) -> None:
        """收据已写、只欠 begin 确认的半成品状态：不写重复 receipt。"""
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

            result = CONTEXT.handoff_transition(
                project, "change", to_phase="submit", executor="cursor"
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(
                result["transition"]["code"], "TRANSITION_ALREADY_CLOSED"
            )
            transitions = CONTEXT.context_view(project, "change")["transitions"]
            review_submit = [
                t for t in transitions
                if t.get("fromPhase") == "review" and t.get("toPhase") == "submit"
            ]
            self.assertEqual(len(review_submit), 1, "不得写重复 receipt")

    def test_handoff_refuses_to_hijack_an_open_phase(self) -> None:
        """来源阶段还没关门（无 phase.end）时拒绝补交接——那是截胡。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")
            CONTEXT.prepare_context(
                project, change="change", phase="execute", executor="cursor"
            )

            result = CONTEXT.handoff_transition(
                project, "change", to_phase="review", executor="cursor"
            )

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "HANDOFF_SOURCE_NOT_CLOSED")
            self.assertIn("harness_gate.py close", result["recoveryAction"])

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
                ["review", "submit"],
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


class BootstrapExecuteTests(unittest.TestCase):
    """批次 2 WI-2a：bootstrap-execute 一条命令完成 execute 阶段引导。

    消除不对称 C（execute 入口三连命令，参数各自必填，漏参=白跑一轮）。
    冻结的契约：
    - 正常路径返回紧凑摘要（runId/attempt/tier/租约 TTL/测试基线状态）；
    - 幂等：重跑复用同一 runId、不追加第二条 phase.start（与 bootstrap-plan
      同语义——换 run-id 会让 finalize 的生命周期身份校验 fail-closed）；
    - 失败信封保留原错误码 + recoveryAction 指回原三连命令路径（§10.1
      排障出口保留，旧 change 沿用原序列）。
    """

    @staticmethod
    def _events(change_dir: Path) -> list[dict]:
        import sys

        sys.path.insert(0, str(SCRIPT.parent))
        import harness_events as he

        return he.load_events(he.events_path(change_dir))

    def _make_project(self) -> tuple[Path, Path, Path]:
        """已 init 的 harness 项目 + 已 bootstrap-plan 的 change + bundle 身份。

        返回 (project, change_dir, skills_root)。bundle 身份三件套
        （.harness-build.json / context-index.json / installed-harness-bundle.json）
        按 validate_identity 的真实校验链构造（bare hexdigest，无 sha256: 前缀）。
        """
        import hashlib

        tmp = Path(tempfile.mkdtemp(prefix="harness-bootstrap-exec-"))
        project = tmp / "proj"
        project.mkdir()
        init_repo(project)
        (project / ".harness" / "changes").mkdir(parents=True)

        CONTEXT.bootstrap_plan(project, change="demo-change", executor="codebuddy")
        change_dir = project / ".harness" / "changes" / "demo-change"

        # v2 计划完成证据：committed 发布 journal（prepare 据此补录交接凭证）
        journal_dir = change_dir / "meta" / "publication-journals"
        journal_dir.mkdir(parents=True, exist_ok=True)
        (journal_dir / "plan_finalize%3Ademo%3Aabc123.json").write_text(
            json.dumps({
                "schema_version": 1,
                "operation_id": "plan_finalize:demo-change:abc123",
                "change_key": "demo-change",
                "state": "committed",
                "readback": "verified",
            }),
            encoding="utf-8",
        )

        skills_root = project / ".agents" / "skills"
        skills_root.mkdir(parents=True)
        (skills_root / ".harness-build.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "agent": "codebuddy",
                "overlay": "none",
                "coreHash": "a" * 16,
            }) + "\n",
            encoding="utf-8",
        )
        (project / ".harness" / "context-index.json").write_text(
            json.dumps({
                "schema_version": 2,
                "project": {"adapters": {"codebuddy": {"skills_root": ".agents/skills"}}},
                "skill_bundles": {
                    "codebuddy": {
                        "registry_version": "0.2.80",
                        "bundle_hash": "sha256:" + "b" * 64,
                    }
                },
            }) + "\n",
            encoding="utf-8",
        )
        build_hash = hashlib.sha256(
            (skills_root / ".harness-build.json").read_bytes()
        ).hexdigest()
        state = project / ".harness" / "state" / "local" / "installed-harness-bundle.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(
            json.dumps({
                "schema_version": 4,
                "profiles": {"codebuddy": "general"},
                "manifests": [{
                    "adapter": "codebuddy",
                    "profile": "general",
                    "bundle_version": "0.2.80",
                    "bundle_manifest_hash": "sha256:" + "b" * 64,
                }],
                "files": [{
                    "owner": "codebuddy",
                    "target_path": ".agents/skills/.harness-build.json",
                    "sha256": build_hash,
                }],
            }) + "\n",
            encoding="utf-8",
        )
        return project, change_dir, skills_root

    def _bootstrap(self, project, change_dir, skills_root, **kwargs):
        return CONTEXT.bootstrap_execute(
            project,
            change="demo-change",
            executor="codebuddy",
            skills_root=str(skills_root),
            executor_tool="codebuddy",
            **kwargs,
        )

    def test_normal_path_returns_compact_summary_and_starts_phase(self) -> None:
        project, change_dir, skills_root = self._make_project()

        result = self._bootstrap(project, change_dir, skills_root, task=1)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "EXECUTE_BOOTSTRAPPED")
        self.assertEqual(result["changeName"], "demo-change")
        # v2 identity：必须小写字母开头，裸 UUID 有 10/16 概率数字开头被拒
        self.assertRegex(result["runId"], r"^execute_[a-z0-9]")
        self.assertEqual(result["attempt"], 1)
        self.assertFalse(result["reused"])
        # tier 来自 gate-policy 权威（bootstrap-plan 的 classify 已写入）
        self.assertEqual(result["tier"], "standard")
        self.assertEqual(result["leaseTtlSeconds"], 3600)
        # 测试基线 guard 已由 gate begin 内部建立
        self.assertTrue(result["testBaseline"]["ok"])
        self.assertEqual(result["testBaseline"]["code"], "SNAPSHOT_CAPTURED")
        # 16-M2：信封携带 waveDispatch（本夹具无 manifest → advisory 降级，不阻断）
        self.assertIn("waveDispatch", result)
        self.assertFalse(result["waveDispatch"]["available"])
        self.assertEqual(
            result["waveDispatch"]["reason"], "scenario-manifest-missing"
        )

        starts = [
            e for e in self._events(change_dir)
            if e.get("phase") == "execute" and e.get("type") == "phase.start"
        ]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0].get("run_id"), result["runId"])

    def test_rerun_reuses_run_id_without_second_phase_start(self) -> None:
        project, change_dir, skills_root = self._make_project()

        first = self._bootstrap(project, change_dir, skills_root, task=1)
        second = self._bootstrap(project, change_dir, skills_root, task=1)

        self.assertTrue(second["ok"], second)
        self.assertEqual(second["runId"], first["runId"])
        self.assertEqual(second["attempt"], first["attempt"])
        self.assertTrue(second["reused"])
        starts = [
            e for e in self._events(change_dir)
            if e.get("phase") == "execute" and e.get("type") == "phase.start"
        ]
        self.assertEqual(len(starts), 1)

    def test_missing_publication_evidence_fails_closed_with_recovery(self) -> None:
        """无 committed 发布 journal：HANDOFF_REQUIRED 原样暴露，不绕过交接校验。"""
        project, change_dir, skills_root = self._make_project()
        # 撤掉发布证据——plan 没有完成的机器证据
        for journal in (change_dir / "meta" / "publication-journals").glob("*.json"):
            journal.unlink()

        result = self._bootstrap(project, change_dir, skills_root, task=1)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "BOOTSTRAP_EXECUTE_PREPARE_FAILED")
        self.assertEqual(result["error"]["code"], "HANDOFF_REQUIRED")
        # recoveryAction 指回原三连命令路径（排障出口保留）
        recovery = str(result.get("recoveryAction") or "")
        self.assertIn("harness_context.py prepare", recovery)
        self.assertIn("harness_gate.py begin", recovery)
        # 失败不得留下半成品 execute phase.start
        starts = [
            e for e in self._events(change_dir)
            if e.get("phase") == "execute" and e.get("type") == "phase.start"
        ]
        self.assertEqual(len(starts), 0)

    def test_gate_stage_failure_surfaces_inner_error_code(self) -> None:
        """gate begin 失败（foundation-gate pending 且未带 --task）：错误码透传。

        emit_error 的 JSON 走 stderr——复合命令必须双捕获才能还原真实错误码，
        而不是笼统的 BOOTSTRAP_GATE_BEGIN_FAILED。
        """
        project, change_dir, skills_root = self._make_project()

        result = self._bootstrap(project, change_dir, skills_root)  # 不带 task

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "BOOTSTRAP_EXECUTE_GATE_BEGIN_FAILED")
        self.assertEqual(result["stage"], "gate-begin")
        self.assertEqual(result["error"]["code"], "TASK_NUMBER_REQUIRED")
        self.assertTrue(result.get("recoveryAction"))

    def test_missing_change_dir_fails_without_creating_it(self) -> None:
        """execute 引导不创建 change（那是 bootstrap-plan 的职责）。"""
        project, _change_dir, skills_root = self._make_project()

        result = CONTEXT.bootstrap_execute(
            project,
            change="nonexistent-change",
            executor="codebuddy",
            skills_root=str(skills_root),
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "CHANGE_NOT_FOUND")
        self.assertFalse((project / ".harness" / "changes" / "nonexistent-change").exists())

    def test_uninitialized_project_reports_init_hint(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="harness-bootstrap-exec-"))
        project = tmp / "proj"
        project.mkdir()
        init_repo(project)

        result = CONTEXT.bootstrap_execute(
            project, change="demo-change", executor="codebuddy"
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "PROJECT_ROOT_INVALID")
        self.assertIn("hunter-harness init", result["error"])


class ExecuteCircuitBreakerTests(unittest.TestCase):
    """15-M3：失败断路器——同 (verification, 指纹) 连续 ≥2 次 FAIL 阻断引导。

    纯派生判定（只读 run-sessions），不持久化；人工 --circuit-ack 放行。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-circuit-"))
        self.change_dir = self.tmp / ".harness" / "changes" / "demo"
        # 无 change-context.json 时 resolve_state_dir_for_contract 原样返回
        # contract_dir（colocated 语义），sessions 写在其下。
        self.state_root = self.change_dir

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _session(
        self,
        name: str,
        verification: str,
        *,
        status: str = "FAIL",
        exit_code: int = 1,
        started: str,
        stderr: str = "",
    ) -> None:
        session_dir = self.state_root / "runtime" / "run-sessions" / name
        session_dir.mkdir(parents=True, exist_ok=True)
        receipt = {
            "status": status,
            "verification": verification,
            "exitCode": exit_code,
            "sessionId": name,
            "startedAt": started,
        }
        if stderr:
            stderr_path = session_dir / "stderr.log"
            stderr_path.write_text(stderr, encoding="utf-8")
            receipt["stderrPath"] = str(stderr_path)
        (session_dir / "session.json").write_text(
            json.dumps(receipt), encoding="utf-8"
        )

    def test_no_sessions_closed(self) -> None:
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "closed")
        self.assertEqual(result["reason"], "no-run-sessions")

    def test_single_failure_closed(self) -> None:
        self._session("s1", "unitTestFull", started="2026-09-17T01:00:00Z")
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "closed")

    def test_two_same_fingerprint_opens_circuit(self) -> None:
        for i in (1, 2):
            self._session(
                f"s{i}",
                "unitTestFull",
                started=f"2026-09-17T0{i}:00:00Z",
                stderr="FAIL com.example.FooTest.testBar\n",
            )
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "open", result)
        self.assertEqual(len(result["circuits"]), 1)
        circuit = result["circuits"][0]
        self.assertEqual(circuit["verification"], "unitTestFull")
        self.assertEqual(circuit["consecutiveFailures"], 2)
        self.assertEqual(len(circuit["recentSessions"]), 2)

    def test_distinct_fingerprints_do_not_open(self) -> None:
        self._session(
            "s1", "unitTestFull", started="2026-09-17T01:00:00Z",
            stderr="FAIL com.example.FooTest.testA\n",
        )
        self._session(
            "s2", "unitTestFull", started="2026-09-17T02:00:00Z",
            exit_code=2, stderr="FAIL com.example.BarTest.testB\n",
        )
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "closed", result)

    def test_ok_after_fail_resets_consecutive(self) -> None:
        self._session(
            "s1", "unitTestFull", started="2026-09-17T01:00:00Z",
            stderr="FAIL x\n",
        )
        self._session(
            "s2", "unitTestFull", status="OK", exit_code=0,
            started="2026-09-17T02:00:00Z",
        )
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "closed")

    def test_timestamps_normalized_into_same_fingerprint(self) -> None:
        """时间戳差异不应产生不同指纹（归一化生效）。"""
        self._session(
            "s1", "compile", started="2026-09-17T01:00:00Z",
            stderr="2026-09-17T01:00:01Z error: cannot find symbol BudgetStatusEnum\n",
        )
        self._session(
            "s2", "compile", started="2026-09-17T02:00:00Z",
            stderr="2026-09-17T02:00:02Z error: cannot find symbol BudgetStatusEnum\n",
        )
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "open", result)
        self.assertEqual(result["circuits"][0]["verification"], "compile")

    def test_verification_groups_are_independent(self) -> None:
        """不同 verification 的失败互不累计。"""
        self._session("s1", "unitTestFull", started="2026-09-17T01:00:00Z",
                      stderr="FAIL a\n")
        self._session("s2", "compile", started="2026-09-17T02:00:00Z",
                      stderr="FAIL a\n")
        result = CONTEXT.execute_circuit_check(self.change_dir)
        self.assertEqual(result["state"], "closed")


class BootstrapScenarioWavesTest(unittest.TestCase):
    """16-M1：bootstrap-execute 的场景波次派生（advisory，失败安全不阻断）。"""

    def _change_dir(self, tmp: str, manifest: dict | None) -> Path:
        change_dir = Path(tmp) / "chg"
        (change_dir / "meta").mkdir(parents=True, exist_ok=True)
        if manifest is not None:
            (change_dir / "meta" / "scenario-manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
        return change_dir

    def _v2_wrapper(self, scenarios: list[dict]) -> dict:
        return {
            "artifact_type": "scenario_manifest",
            "schema_version": 2,
            "content": {"scenarios": scenarios},
        }

    def test_v2_wrapper_with_deps_produces_waves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._change_dir(tmp, self._v2_wrapper([
                {"scenario_id": "UT-001", "priority": "P0", "owner_phase": "execute",
                 "required_evidence_kind": "automated_test"},
                {"scenario_id": "UT-002", "priority": "P1", "owner_phase": "execute",
                 "required_evidence_kind": "automated_test", "depends_on": ["UT-001"]},
                {"scenario_id": "UT-003", "priority": "P1", "owner_phase": "execute",
                 "required_evidence_kind": "automated_test"},
            ]))
            waves = CONTEXT._bootstrap_scenario_waves(change_dir)
            self.assertTrue(waves["available"])
            self.assertEqual(waves["waves"], [["UT-001", "UT-003"], ["UT-002"]])
            self.assertEqual(waves["waveCount"], 2)
            self.assertEqual(waves["declared"], 1)

    def test_legacy_flat_manifest_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._change_dir(tmp, {"schemaVersion": 2, "scenarios": [
                {"id": "A", "priority": "P1", "ownerPhase": "execute",
                 "requiredEvidenceKind": "automated_test"},
                {"id": "B", "priority": "P1", "ownerPhase": "execute",
                 "requiredEvidenceKind": "automated_test", "dependsOn": ["A"]},
            ]})
            waves = CONTEXT._bootstrap_scenario_waves(change_dir)
            self.assertTrue(waves["available"])
            self.assertEqual(waves["waves"], [["A"], ["B"]])

    def test_missing_or_broken_manifest_degrades_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = CONTEXT._bootstrap_scenario_waves(self._change_dir(tmp, None))
            self.assertFalse(missing["available"])
            self.assertEqual(missing["reason"], "scenario-manifest-missing")

            unsupported = CONTEXT._bootstrap_scenario_waves(
                self._change_dir(tmp, {"not": "a manifest"}))
            self.assertFalse(unsupported["available"])
            self.assertEqual(unsupported["reason"], "scenario-manifest-unsupported")

            cyclic = CONTEXT._bootstrap_scenario_waves(self._change_dir(tmp, self._v2_wrapper([
                {"scenario_id": "A", "priority": "P0", "owner_phase": "execute",
                 "required_evidence_kind": "automated_test", "depends_on": ["B"]},
                {"scenario_id": "B", "priority": "P0", "owner_phase": "execute",
                 "required_evidence_kind": "automated_test", "depends_on": ["A"]},
            ])))
            self.assertFalse(cyclic["available"])
            self.assertEqual(cyclic["reason"], "scenario-dependency-cycle")

            unreadable_dir = Path(tmp) / "broken"
            (unreadable_dir / "meta").mkdir(parents=True)
            (unreadable_dir / "meta" / "scenario-manifest.json").write_text(
                "{not json", encoding="utf-8")
            unreadable = CONTEXT._bootstrap_scenario_waves(unreadable_dir)
            self.assertFalse(unreadable["available"])
            self.assertEqual(unreadable["reason"], "scenario-manifest-unreadable")


class ExecuteWaveDispatchTests(unittest.TestCase):
    """16-M2：波次派发计划（完成集派生 + _bootstrap_wave_dispatch + execute-wave 命令）。"""

    def _change_dir(self, tmp: str, manifest: dict | None) -> Path:
        change_dir = Path(tmp) / "chg"
        meta = change_dir / "meta"
        meta.mkdir(parents=True)
        if manifest is not None:
            (meta / "scenario-manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
        return change_dir

    def _write_ledger(self, change_dir: Path, validations: dict) -> None:
        evidence = change_dir / "evidence"
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / "verification-ledger.json").write_text(
            json.dumps({"schema_version": 2, "validations": validations}),
            encoding="utf-8",
        )

    def test_derive_completed_scenarios_status_filter_and_dual_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._change_dir(tmp, None)
            self.assertEqual(CONTEXT._derive_completed_scenarios(change_dir), set())
            self._write_ledger(
                change_dir,
                {
                    # v2 收据路径：OK 时取 coverage.passed
                    "unitTests": {
                        "status": "OK",
                        "scenarioIds": ["UT-001"],
                        "scenarioCoverage": {"passed": ["UT-001", "UT-002"]},
                    },
                    # 非 OK 条目不贡献完成集
                    "lint": {"status": "FAIL", "scenarioIds": ["UT-009"]},
                    # legacy 路径：OK + 无 coverage 时退回 scenarioIds（大小写不敏感）
                    "legacyGate": {"status": "ok", "scenarioIds": ["UT-003"]},
                    # 非 dict 条目容错
                    "broken": "not-a-dict",
                },
            )
            self.assertEqual(
                CONTEXT._derive_completed_scenarios(change_dir),
                {"UT-001", "UT-002", "UT-003"},
            )

    def test_derive_completed_scenarios_tolerates_malformed_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._change_dir(tmp, None)
            evidence = change_dir / "evidence"
            evidence.mkdir(parents=True)
            (evidence / "verification-ledger.json").write_text(
                "{not json", encoding="utf-8"
            )
            self.assertEqual(CONTEXT._derive_completed_scenarios(change_dir), set())
            # validations 非 dict/list 也容错
            (evidence / "verification-ledger.json").write_text(
                json.dumps({"schema_version": 2, "validations": "oops"}),
                encoding="utf-8",
            )
            self.assertEqual(CONTEXT._derive_completed_scenarios(change_dir), set())

    def test_wave_dispatch_progression_via_ledger(self) -> None:
        manifest = {
            "schemaVersion": 2,
            "scenarios": [
                {"id": "UT-001", "priority": "P0", "ownerPhase": "execute"},
                {
                    "id": "UT-002",
                    "priority": "P1",
                    "ownerPhase": "execute",
                    "dependsOn": ["UT-001"],
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._change_dir(tmp, manifest)
            first = CONTEXT._bootstrap_wave_dispatch(change_dir)
            self.assertTrue(first["available"])
            self.assertEqual(
                [s["id"] for s in first["runnableNow"][0]["scenarios"]],
                ["UT-001"],
            )
            self.assertEqual(first["blocked"][0]["id"], "UT-002")

            self._write_ledger(
                change_dir,
                {
                    "unitTests": {
                        "status": "OK",
                        "scenarioCoverage": {"passed": ["UT-001"]},
                    }
                },
            )
            second = CONTEXT._bootstrap_wave_dispatch(change_dir)
            self.assertEqual(second["completed"], ["UT-001"])
            self.assertEqual(
                [s["id"] for s in second["runnableNow"][0]["scenarios"]],
                ["UT-002"],
            )
            self.assertEqual(second["blocked"], [])
            self.assertFalse(second["complete"])

    def test_wave_dispatch_degrades_without_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dispatch = CONTEXT._bootstrap_wave_dispatch(self._change_dir(tmp, None))
            self.assertFalse(dispatch["available"])
            self.assertEqual(dispatch["reason"], "scenario-manifest-missing")
            self.assertEqual(dispatch["runnableNow"], [])
            self.assertEqual(dispatch["blocked"], [])
            self.assertFalse(dispatch["complete"])

    def test_execute_wave_command_split_local_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "demo")  # split-local：stateOwnership.runtimeRoot
            contract_root = project / ".harness" / "changes" / "demo"
            state_root = project / ".harness" / "state" / "changes" / "demo"
            (state_root / "evidence").mkdir(parents=True)
            # manifest 在 contract 根（plan 发布的耐用品）
            (contract_root / "meta" / "scenario-manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "scenarios": [
                            {"id": "UT-001", "ownerPhase": "execute"},
                            {
                                "id": "UT-002",
                                "ownerPhase": "execute",
                                "dependsOn": ["UT-001"],
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            # ledger 在 state 根（split-local 运行态）
            (state_root / "evidence" / "verification-ledger.json").write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "validations": {
                            "unitTests": {
                                "status": "OK",
                                "scenarioCoverage": {"passed": ["UT-001"]},
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            result = CONTEXT.execute_wave_dispatch(project, "demo")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "EXECUTE_WAVE_DISPATCH")
            dispatch = result["dispatch"]
            self.assertTrue(dispatch["available"])
            self.assertEqual(dispatch["completed"], ["UT-001"])
            self.assertEqual(
                [s["id"] for s in dispatch["runnableNow"][0]["scenarios"]],
                ["UT-002"],
            )
            self.assertTrue(result["nextAction"])

    def test_execute_wave_command_missing_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / ".harness" / "changes").mkdir(parents=True)
            result = CONTEXT.execute_wave_dispatch(project, "ghost")
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "CHANGE_NOT_FOUND")

    def test_execute_wave_command_phase_parameter_defers_later_phases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "demo2")
            contract_root = project / ".harness" / "changes" / "demo2"
            (contract_root / "meta" / "scenario-manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "scenarios": [
                            {"id": "UT-001", "ownerPhase": "execute"},
                            {"id": "RV-001", "ownerPhase": "review"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            result = CONTEXT.execute_wave_dispatch(project, "demo2")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["dispatch"]["deferred"], ["RV-001"])
            # review 视角下不再 deferred
            review = CONTEXT.execute_wave_dispatch(project, "demo2", phase="review")
            self.assertEqual(review["dispatch"]["deferred"], [])
            self.assertEqual(review["dispatch"]["phase"], "review")


class BootstrapManifestCalibrationTests(unittest.TestCase):
    """19-M1：bootstrap-execute 信封 manifestCalibration advisory（失败安全不阻断）。"""

    GUARD_SCRIPT = Path(__file__).resolve().parents[1] / "harness_test_guard.py"

    @classmethod
    def _guard(cls):
        spec = importlib.util.spec_from_file_location(
            "harness_test_guard_for_context", cls.GUARD_SCRIPT
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_missing_manifest_degrades(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change_dir = project / ".harness" / "changes" / "demo"
            change_dir.mkdir(parents=True)

            result = CONTEXT._bootstrap_manifest_calibration(project, change_dir)

            self.assertFalse(result["available"])
            self.assertEqual(result["reason"], "manifest-missing")

    def test_drifted_manifest_surfaces_hint(self) -> None:
        guard = self._guard()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            change_dir = make_change(project, "demo")
            test_file = project / "src" / "test" / "java" / "AppTest.java"
            test_file.parent.mkdir(parents=True)
            test_file.write_text("class AppTest {}\n", encoding="utf-8")
            recorded = guard.record(
                project, change_dir, [str(test_file)], "tdd-created"
            )
            self.assertTrue(recorded["ok"], recorded)
            test_file.write_text(
                "class AppTest { int changed; }\n", encoding="utf-8"
            )

            result = CONTEXT._bootstrap_manifest_calibration(project, change_dir)

            self.assertTrue(result["available"], result)
            self.assertTrue(result["drifted"])
            self.assertEqual(result["hashDrift"], ["src/test/java/AppTest.java"])
            self.assertIn("--apply", result["hint"])

    def test_clean_manifest_reports_not_drifted(self) -> None:
        guard = self._guard()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            change_dir = make_change(project, "demo")
            test_file = project / "src" / "test" / "java" / "AppTest.java"
            test_file.parent.mkdir(parents=True)
            test_file.write_text("class AppTest {}\n", encoding="utf-8")
            recorded = guard.record(
                project, change_dir, [str(test_file)], "tdd-created"
            )
            self.assertTrue(recorded["ok"], recorded)

            result = CONTEXT._bootstrap_manifest_calibration(project, change_dir)

            self.assertTrue(result["available"], result)
            self.assertFalse(result["drifted"])
            self.assertIsNone(result["hint"])


if __name__ == "__main__":
    unittest.main()
