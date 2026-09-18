#!/usr/bin/env python3
"""Aggregate per-run metrics from CodeBuddy trace files (O5 evidence, WI-O5.2).

Read-only collector for controlled comparison runs: given a run window
``[start, end]`` it aggregates token usage, coordination-command time
(命令埋点), generation time and span failures from host traces under
``~/.codebuddy/traces/<pid>/trace_*.json``. Manual interventions and ritual
writing are not observable from traces and are reported as unavailable
degradations instead of being guessed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 1

DEFAULT_TRACES_ROOT = Path.home() / ".codebuddy" / "traces"

# 协调命令埋点：harness CLI 与 Python 脚本的调用面。
DEFAULT_COMMAND_PATTERN = r"hunter-harness|harness_[a-z_]+\.py"

COMMAND_SPAN_NAMES = {"bash", "powershell"}


def _timestamp(value: Any) -> dt.datetime | None:
    if isinstance(value, dt.datetime):
        parsed = value
    elif value:
        try:
            parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _duration_ms(span: dict[str, Any]) -> int:
    try:
        return max(0, int(span.get("duration") or 0))
    except (TypeError, ValueError):
        return 0


def iter_trace_files(
    traces_root: Path, *, pids: Iterable[str] | None = None
) -> Iterator[Path]:
    """Yield trace files, optionally restricted to worker pid directories."""
    if not traces_root.is_dir():
        return
    pid_filter = {str(pid) for pid in pids} if pids else None
    for pid_dir in sorted(traces_root.iterdir()):
        if not pid_dir.is_dir():
            continue
        if pid_filter is not None and pid_dir.name not in pid_filter:
            continue
        yield from sorted(pid_dir.glob("trace_*.json"))


def load_trace(path: Path) -> dict[str, Any] | None:
    """Parse one trace file; return None on any failure (caller degrades)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("spans"), list):
        return None
    return data


def parse_span_usage(span: dict[str, Any]) -> dict[str, Any] | None:
    """Extract ``{model, usage}`` from a generation span's toolOutput string.

    toolOutput is a JSON-encoded list of chat.completion objects; token
    accounting lives under ``[0].usage``. Anything unreadable yields None
    (the span is still counted as a generation call by the caller).
    """
    raw = span.get("toolOutput")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(payload, list) or not payload:
        return None
    completion = payload[0]
    if not isinstance(completion, dict):
        return None
    usage = completion.get("usage")
    if not isinstance(usage, dict):
        return None
    prompt_details = usage.get("prompt_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or {}
    return {
        "model": str(completion.get("model") or "unknown"),
        "promptTokens": _integer(usage.get("prompt_tokens")),
        "completionTokens": _integer(usage.get("completion_tokens")),
        "totalTokens": _integer(usage.get("total_tokens")),
        "cachedTokens": _integer(prompt_details.get("cached_tokens")),
        "reasoningTokens": _integer(completion_details.get("reasoning_tokens")),
    }


def _command_kind(tool_input: str, pattern: re.Pattern[str]) -> str | None:
    """Classify a command span by the first harness invocation it contains."""
    match = pattern.search(tool_input)
    return match.group(0) if match else None


def collect_run_metrics(
    traces_root: Path,
    *,
    start: Any,
    end: Any,
    pids: Iterable[str] | None = None,
    command_pattern: str | None = None,
    now: Any = None,
) -> dict[str, Any]:
    """Aggregate metrics for one run window. Read-only; degrades explicitly."""
    start_ts = _timestamp(start)
    end_ts = _timestamp(end)
    if start_ts is None or end_ts is None or end_ts < start_ts:
        raise ValueError("collect_run_metrics requires a valid start <= end window")

    pattern = re.compile(command_pattern or DEFAULT_COMMAND_PATTERN)

    trace_files = 0
    trace_errors: list[str] = []
    matched_spans = 0
    generation_calls = 0
    generation_duration_ms = 0
    by_model: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "calls": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "totalTokens": 0,
            "cachedTokens": 0,
            "reasoningTokens": 0,
        }
    )
    token_spans = 0
    command_count = 0
    command_duration_ms = 0
    command_kinds: dict[str, int] = defaultdict(int)
    failure_count = 0
    failure_duration_ms = 0
    seen_pids: set[str] = set()

    for path in iter_trace_files(traces_root, pids=pids):
        trace_files += 1
        seen_pids.add(path.parent.name)
        trace = load_trace(path)
        if trace is None:
            trace_errors.append(path.name)
            continue
        for span in trace["spans"]:
            if not isinstance(span, dict):
                continue
            started = _timestamp(span.get("startedAt"))
            if started is None or not (start_ts <= started <= end_ts):
                continue
            matched_spans += 1
            name = str(span.get("name") or "")
            status = str(span.get("status") or "").lower()
            if status and status != "ok":
                failure_count += 1
                failure_duration_ms += _duration_ms(span)
            if name == "generation":
                generation_calls += 1
                generation_duration_ms += _duration_ms(span)
                usage = parse_span_usage(span)
                if usage is not None:
                    token_spans += 1
                    bucket = by_model[usage.pop("model")]
                    bucket["calls"] += 1
                    for key, value in usage.items():
                        bucket[key] += value
            elif name.lower() in COMMAND_SPAN_NAMES:
                tool_input = span.get("toolInput")
                if isinstance(tool_input, str):
                    kind = _command_kind(tool_input, pattern)
                    if kind is not None:
                        command_count += 1
                        command_duration_ms += _duration_ms(span)
                        command_kinds[kind] += 1

    totals = {
        key: sum(bucket[key] for bucket in by_model.values())
        for key in ("calls", "promptTokens", "completionTokens", "totalTokens",
                    "cachedTokens", "reasoningTokens")
    }
    generated = _timestamp(now) or dt.datetime.now(dt.timezone.utc)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window": {
            "start": start_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": end_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "wallClockSeconds": round((end_ts - start_ts).total_seconds(), 3),
        },
        "traces": {
            "root": str(traces_root),
            "files": trace_files,
            "pids": sorted(seen_pids),
            "matchedSpans": matched_spans,
            "errors": trace_errors,
        },
        "tokens": (
            {
                "available": True,
                "byModel": {model: by_model[model] for model in sorted(by_model)},
                "totals": totals,
                "spansWithUsage": token_spans,
                "generationSpans": generation_calls,
            }
            if token_spans
            else {
                "available": False,
                "reason": "no generation spans with usage in window",
                "generationSpans": generation_calls,
            }
        ),
        "generation": {
            "calls": generation_calls,
            "totalDurationMs": generation_duration_ms,
        },
        "coordinationCommands": (
            {
                "available": True,
                "count": command_count,
                "totalDurationMs": command_duration_ms,
                "byKind": {kind: command_kinds[kind] for kind in sorted(command_kinds)},
            }
            if command_count
            else {"available": False, "reason": "no harness command spans in window"}
        ),
        "failures": {
            "spanErrors": failure_count,
            "totalDurationMs": failure_duration_ms,
        },
        "ritualWriting": {
            "available": False,
            "reason": "not observable from host traces; keep model self-report in the run record",
        },
        "manualIntervention": {
            "available": False,
            "reason": "not observable from host traces; record manually in the run record",
        },
        "notes": [
            "Read-only aggregation over CodeBuddy traces; writes nothing.",
            "Token usage is extracted from generation span toolOutput (usage fields); "
            "trace header totalTokens is unreliable (observed 0).",
            "Coordination command time is instrumented from Bash/PowerShell spans "
            "matching the harness invocation pattern, replacing self-report.",
            "Concurrent sessions sharing the window pollute the aggregate; pass "
            "--pids to isolate the worker under measurement.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="harness_run_metrics.py")
    parser.add_argument("--start", required=True, help="运行窗口起点（ISO-8601）")
    parser.add_argument("--end", required=True, help="运行窗口终点（ISO-8601）")
    parser.add_argument(
        "--traces-root",
        default=str(DEFAULT_TRACES_ROOT),
        help="CodeBuddy traces 根目录（默认 ~/.codebuddy/traces）",
    )
    parser.add_argument(
        "--pids",
        default=None,
        help="逗号分隔的 workerPid 白名单，隔离被测会话（默认全量）",
    )
    parser.add_argument(
        "--command-pattern",
        default=None,
        help="协调命令匹配正则（默认 hunter-harness / harness_*.py）",
    )
    parser.add_argument(
        "--now",
        default=None,
        help="覆盖 generatedAt 的 ISO-8601 UTC 时间戳（测试用）",
    )
    args = parser.parse_args(argv)
    pids = [pid for pid in (args.pids or "").split(",") if pid] or None
    try:
        result = collect_run_metrics(
            Path(args.traces_root),
            start=args.start,
            end=args.end,
            pids=pids,
            command_pattern=args.command_pattern,
            now=args.now,
        )
    except ValueError as exc:
        parser.error(str(exc))
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
