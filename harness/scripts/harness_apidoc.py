#!/usr/bin/env python3
"""Small deterministic helpers for compact API contract reports."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys


COMMIT_ONLY = re.compile(r"^[0-9a-f]{7,64}$", re.IGNORECASE)
INVALID_FILENAME = re.compile(r"[<>:\"/\\|?*\x00-\x1f]+")
SEPARATORS = re.compile(r"[\s_-]+")


def build_filename(description: str, *, date: str | None = None) -> str:
    raw = str(description or "").strip()
    if not raw or COMMIT_ONLY.fullmatch(raw):
        raise ValueError("a human-readable API change description is required")
    slug = INVALID_FILENAME.sub("-", raw)
    slug = SEPARATORS.sub("-", slug).strip(" .-")
    if not slug:
        raise ValueError("description does not contain filename-safe text")
    day = date or dt.date.today().isoformat()
    slug = slug[:86].rstrip(" .-")
    return f"{day}-{slug}.md"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    filename = sub.add_parser("filename", help="build a safe dated report filename")
    filename.add_argument("--description", required=True)
    filename.add_argument("--date", default=None)
    filename.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        value = build_filename(args.description, date=args.date)
    except ValueError as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
        return 1
    payload = {"ok": True, "filename": value}
    if args.json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(value + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
