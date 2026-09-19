"""WI-O5.2：harness_run_metrics 只读采集壳测试。"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_run_metrics as hrm


def _span(
    name: str,
    started: str,
    *,
    duration: int = 1000,
    status: str = "ok",
    tool_input: str | None = None,
    tool_output: str | None = None,
) -> dict:
    return {
        "traceId": "trace_t",
        "spanId": f"span_{name}_{started}",
        "parentId": None,
        "name": name,
        "type": name,
        "startedAt": started,
        "endedAt": started,
        "duration": duration,
        "status": status,
        "error": None,
        "toolInput": tool_input,
        "toolOutput": tool_output,
    }


def _generation_output(
    model: str = "custom:test-model",
    prompt: int = 100,
    completion: int = 50,
    cached: int = 10,
    reasoning: int = 5,
) -> str:
    return json.dumps(
        [
            {
                "id": "x",
                "model": model,
                "object": "chat.completion",
                "choices": [],
                "usage": {
                    "prompt_tokens": prompt,
                    "completion_tokens": completion,
                    "total_tokens": prompt + completion,
                    "prompt_tokens_details": {"cached_tokens": cached},
                    "completion_tokens_details": {"reasoning_tokens": reasoning},
                },
            }
        ]
    )


def _write_trace(root: Path, pid: str, name: str, spans: list[dict]) -> Path:
    pid_dir = root / pid
    pid_dir.mkdir(parents=True, exist_ok=True)
    path = pid_dir / name
    path.write_text(
        json.dumps(
            {
                "trace": {"traceId": name, "workerPid": int(pid), "totalTokens": 0},
                "spans": spans,
            }
        ),
        encoding="utf-8",
    )
    return path


class CollectRunMetricsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "traces"
        self.start = "2026-09-18T10:00:00Z"
        self.end = "2026-09-18T10:30:00Z"

    def _collect(self, **kwargs):
        kwargs.setdefault("now", "2026-09-18T11:00:00Z")
        return hrm.collect_run_metrics(
            self.root, start=self.start, end=self.end, **kwargs
        )

    def test_aggregates_tokens_by_model(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "generation",
                    "2026-09-18T10:01:00Z",
                    duration=5000,
                    tool_output=_generation_output(prompt=100, completion=50),
                ),
                _span(
                    "generation",
                    "2026-09-18T10:02:00Z",
                    duration=3000,
                    tool_output=_generation_output(prompt=200, completion=80),
                ),
            ],
        )
        result = self._collect()
        tokens = result["tokens"]
        self.assertTrue(tokens["available"])
        bucket = tokens["byModel"]["custom:test-model"]
        self.assertEqual(bucket["calls"], 2)
        self.assertEqual(bucket["promptTokens"], 300)
        self.assertEqual(bucket["completionTokens"], 130)
        self.assertEqual(bucket["totalTokens"], 430)
        self.assertEqual(bucket["cachedTokens"], 20)
        self.assertEqual(bucket["reasoningTokens"], 10)
        self.assertEqual(tokens["totals"]["totalTokens"], 430)
        self.assertEqual(result["generation"]["calls"], 2)
        self.assertEqual(result["generation"]["totalDurationMs"], 8000)

    def test_window_filters_outside_spans(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "generation",
                    "2026-09-18T09:59:59Z",
                    tool_output=_generation_output(),
                ),
                _span(
                    "generation",
                    "2026-09-18T10:30:01Z",
                    tool_output=_generation_output(),
                ),
                _span(
                    "generation",
                    "2026-09-18T10:15:00Z",
                    tool_output=_generation_output(),
                ),
            ],
        )
        result = self._collect()
        self.assertEqual(result["traces"]["matchedSpans"], 1)
        self.assertEqual(result["tokens"]["totals"]["calls"], 1)

    def test_pids_filter_isolates_worker(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "generation",
                    "2026-09-18T10:05:00Z",
                    tool_output=_generation_output(prompt=100, completion=50),
                )
            ],
        )
        _write_trace(
            self.root,
            "222",
            "trace_b.json",
            [
                _span(
                    "generation",
                    "2026-09-18T10:06:00Z",
                    tool_output=_generation_output(prompt=999, completion=1),
                )
            ],
        )
        result = self._collect(pids=["111"])
        self.assertEqual(result["traces"]["pids"], ["111"])
        self.assertEqual(result["tokens"]["totals"]["promptTokens"], 100)

    def test_coordination_commands_instrumented(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "PowerShell",
                    "2026-09-18T10:03:00Z",
                    duration=1200,
                    tool_input='{"command": "python harness/scripts/harness_gate.py close execute"}',
                ),
                _span(
                    "Bash",
                    "2026-09-18T10:04:00Z",
                    duration=800,
                    tool_input="hunter-harness archive run",
                ),
                _span(
                    "PowerShell",
                    "2026-09-18T10:05:00Z",
                    duration=9999,
                    tool_input='{"command": "git status"}',
                ),
                _span("Read", "2026-09-18T10:06:00Z", duration=1, tool_input="x"),
            ],
        )
        result = self._collect()
        commands = result["coordinationCommands"]
        self.assertTrue(commands["available"])
        self.assertEqual(commands["count"], 2)
        self.assertEqual(commands["totalDurationMs"], 2000)
        self.assertEqual(commands["byKind"]["hunter-harness"], 1)

    def test_artifact_writes_classified(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "Write",
                    "2026-09-18T10:03:00Z",
                    tool_input=json.dumps(
                        {
                            "file_path": "repo/.harness/changes/cn-1/plan.md",
                            "content": "abc计划",
                        }
                    ),
                ),
                _span(
                    "Edit",
                    "2026-09-18T10:04:00Z",
                    tool_input=json.dumps(
                        {
                            "file_path": "repo/harness/scripts/harness_change.py",
                            "new_str": "x" * 10,
                        }
                    ),
                ),
                _span(
                    "Write",
                    "2026-09-18T10:05:00Z",
                    tool_input="{broken json",
                ),
            ],
        )
        result = self._collect()
        writes = result["artifactWrites"]
        self.assertTrue(writes["available"])
        self.assertEqual(writes["writeSpans"], 3)
        self.assertEqual(writes["artifactWriteSpans"], 1)
        self.assertEqual(
            writes["artifactContentBytes"], len("abc计划".encode("utf-8"))
        )

    def test_artifact_writes_unavailable_without_write_spans(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "generation",
                    "2026-09-18T10:05:00Z",
                    tool_output=_generation_output(),
                )
            ],
        )
        result = self._collect()
        self.assertFalse(result["artifactWrites"]["available"])

    def test_failure_spans_counted(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "Bash",
                    "2026-09-18T10:03:00Z",
                    duration=400,
                    status="error",
                    tool_input="python harness_ledger.py record",
                ),
            ],
        )
        result = self._collect()
        self.assertEqual(result["failures"]["spanErrors"], 1)
        self.assertEqual(result["failures"]["totalDurationMs"], 400)

    def test_malformed_trace_degrades_without_crash(self) -> None:
        pid_dir = self.root / "111"
        pid_dir.mkdir(parents=True)
        (pid_dir / "trace_broken.json").write_text("{not json", encoding="utf-8")
        (pid_dir / "trace_shape.json").write_text(
            json.dumps({"spans": "not-a-list"}), encoding="utf-8"
        )
        _write_trace(
            self.root,
            "111",
            "trace_ok.json",
            [
                _span(
                    "generation",
                    "2026-09-18T10:05:00Z",
                    tool_output=_generation_output(),
                )
            ],
        )
        result = self._collect()
        self.assertEqual(result["traces"]["files"], 3)
        self.assertEqual(
            sorted(result["traces"]["errors"]),
            ["trace_broken.json", "trace_shape.json"],
        )
        self.assertTrue(result["tokens"]["available"])

    def test_unobservable_dimensions_degrade_explicitly(self) -> None:
        _write_trace(
            self.root,
            "111",
            "trace_a.json",
            [
                _span(
                    "generation",
                    "2026-09-18T10:05:00Z",
                    tool_output="{broken",
                )
            ],
        )
        result = self._collect()
        self.assertFalse(result["tokens"]["available"])
        self.assertEqual(result["tokens"]["generationSpans"], 1)
        self.assertFalse(result["coordinationCommands"]["available"])
        self.assertFalse(result["ritualWriting"]["available"])
        self.assertFalse(result["manualIntervention"]["available"])
        self.assertEqual(result["window"]["wallClockSeconds"], 1800.0)

    def test_missing_root_returns_empty_aggregate(self) -> None:
        result = hrm.collect_run_metrics(
            self.root / "nope",
            start=self.start,
            end=self.end,
            now="2026-09-18T11:00:00Z",
        )
        self.assertEqual(result["traces"]["files"], 0)
        self.assertFalse(result["tokens"]["available"])

    def test_invalid_window_rejected(self) -> None:
        with self.assertRaises(ValueError):
            hrm.collect_run_metrics(
                self.root, start=self.end, end=self.start
            )
        with self.assertRaises(ValueError):
            hrm.collect_run_metrics(self.root, start="garbage", end=self.end)


class CliTests(unittest.TestCase):
    def test_main_prints_json(self) -> None:
        import contextlib
        import io

        with tempfile.TemporaryDirectory() as tmp:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = hrm.main(
                    [
                        "--start",
                        "2026-09-18T10:00:00Z",
                        "--end",
                        "2026-09-18T10:30:00Z",
                        "--traces-root",
                        tmp,
                        "--now",
                        "2026-09-18T11:00:00Z",
                    ]
                )
            self.assertEqual(code, 0)
            payload = json.loads(buffer.getvalue())
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["generatedAt"], "2026-09-18T11:00:00Z")


if __name__ == "__main__":
    unittest.main()
