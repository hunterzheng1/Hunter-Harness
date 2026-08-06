#!/usr/bin/env python3
"""Shared headless JSON envelope helpers for stage scripts (P5 contract)."""

from __future__ import annotations

import json
import sys
from typing import Any


def headless_envelope(
    *,
    command: str,
    ok: bool,
    exit_code: int,
    change: str | None = None,
    phase: str | None = None,
    warnings: list[Any] | None = None,
    errors: list[Any] | None = None,
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "ok": ok,
        "command": command,
        "change": change,
        "phase": phase,
        "exit_code": exit_code,
        "warnings": warnings or [],
        "errors": errors or [],
        "result": result or {},
    }


def emit_headless(payload: dict[str, Any], *, stream=None) -> None:
    out = stream or sys.stdout
    print(json.dumps(payload, ensure_ascii=False, indent=2), file=out)
