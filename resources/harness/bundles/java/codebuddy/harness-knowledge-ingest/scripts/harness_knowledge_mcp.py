#!/usr/bin/env python3
"""MCP entry point for Harness knowledge operations."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import harness_knowledge as hk  # noqa: E402


TOOL_DESCRIPTIONS: list[dict[str, Any]] = [
    {
        "name": "harness_knowledge_ingest",
        "description": "Build or refresh a project-local .harness/knowledge index from .harness/archive.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/archive."},
                "incremental": {"type": "boolean", "default": True, "description": "Reuse cached archive extraction results when valid."},
            },
            "required": ["project"],
        },
    },
    {
        "name": "harness_knowledge_sync",
        "description": "Check whether .harness/knowledge is current, optionally refreshing stale indexes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/archive."},
                "update": {"type": "boolean", "default": False, "description": "Refresh the index when it is out of date."},
                "incremental": {"type": "boolean", "default": True, "description": "Use incremental extraction when update is true."},
            },
            "required": ["project"],
        },
    },
    {
        "name": "harness_knowledge_auto",
        "description": "Run the default automated knowledge maintenance workflow: create config when missing, sync, suggest validators, verify, and audit.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/archive."},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
                "suggest_statuses": {"type": "array", "items": {"type": "string"}, "default": []},
                "apply_suggestions": {"type": "boolean", "default": True, "description": "Write validator suggestions into entry JSON files (default on)."},
                "incremental": {"type": "boolean", "default": True, "description": "Reuse cached archive extraction results when refreshing."},
                "audit_limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
            },
            "required": ["project"],
        },
    },
    {
        "name": "harness_knowledge_audit",
        "description": "Generate review lists for candidate, stale, superseded, and conflicted knowledge.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/knowledge."},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
            },
            "required": ["project"],
        },
    },
    {
        "name": "harness_knowledge_verify",
        "description": "Run configured validators against knowledge entries and refresh verification reports.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/knowledge."},
            },
            "required": ["project"],
        },
    },
    {
        "name": "harness_knowledge_suggest_validators",
        "description": "Suggest deterministic validators for knowledge entries, optionally applying them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/knowledge."},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
                "statuses": {"type": "array", "items": {"type": "string"}, "default": []},
                "apply": {"type": "boolean", "default": False, "description": "Write suggestions into entry JSON files."},
            },
            "required": ["project"],
        },
    },
    {
        "name": "harness_knowledge_query",
        "description": "Search .harness/knowledge and generate a context pack for planning or implementation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/knowledge."},
                "query": {"type": "string", "description": "Need, question, keyword, or file path to search."},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
                "files": {"type": "array", "items": {"type": "string"}, "default": []},
                "statuses": {"type": "array", "items": {"type": "string"}, "default": []},
                "types": {"type": "array", "items": {"type": "string"}, "default": []},
            },
            "required": ["project", "query"],
        },
    },
    {
        "name": "harness_knowledge_promote",
        "description": "Promote a candidate knowledge entry to active after manual confirmation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/knowledge."},
                "entry_id": {"type": "string", "description": "Knowledge entry id to promote."},
                "note": {"type": "string", "default": "", "description": "Manual verification note."},
                "allow_stale": {"type": "boolean", "default": False, "description": "Allow promoting a stale entry after manual verification."},
            },
            "required": ["project", "entry_id"],
        },
    },
    {
        "name": "harness_knowledge_demote",
        "description": "Demote an active knowledge entry to stale or candidate after manual review.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project root containing .harness/knowledge."},
                "entry_id": {"type": "string", "description": "Active knowledge entry id to demote."},
                "status": {"type": "string", "enum": ["candidate", "stale"], "description": "Target lifecycle status."},
                "reason": {"type": "string", "description": "Manual demotion reason."},
            },
            "required": ["project", "entry_id", "status", "reason"],
        },
    },
]


def describe_tools() -> dict[str, Any]:
    return {
        "server": "harness-knowledge",
        "transport": "stdio",
        "tools": TOOL_DESCRIPTIONS,
    }


def create_server() -> Any:
    try:
        from mcp.server.fastmcp import FastMCP
    except Exception as exc:  # pragma: no cover - exercised when SDK is absent
        raise RuntimeError(
            "Python package 'mcp' with FastMCP support is required to run the MCP server. "
            "Use --describe-tools for static tool metadata."
        ) from exc

    server = FastMCP(
        "harness-knowledge",
        instructions=(
            "Use these tools to maintain and query project-local Harness knowledge. "
            "Treat candidate and stale entries as historical context until verified."
        ),
    )

    @server.tool(description=TOOL_DESCRIPTIONS[0]["description"])
    def harness_knowledge_ingest(project: str, incremental: bool = True) -> dict[str, Any]:
        return hk.summarize_index(hk.build_index(Path(project), incremental=incremental))

    @server.tool(description=TOOL_DESCRIPTIONS[1]["description"])
    def harness_knowledge_sync(project: str, update: bool = False, incremental: bool = True) -> dict[str, Any]:
        return hk.sync_status(Path(project), update=update, incremental=incremental)

    @server.tool(description=TOOL_DESCRIPTIONS[2]["description"])
    def harness_knowledge_auto(
        project: str,
        limit: int = 20,
        suggest_statuses: list[str] | None = None,
        apply_suggestions: bool = True,
        incremental: bool = True,
        audit_limit: int = 10,
    ) -> dict[str, Any]:
        return hk.auto_knowledge(
            Path(project),
            limit=limit,
            suggest_statuses=suggest_statuses or [],
            apply_suggestions=apply_suggestions,
            incremental=incremental,
            audit_limit=audit_limit,
        )

    @server.tool(description=TOOL_DESCRIPTIONS[3]["description"])
    def harness_knowledge_audit(project: str, limit: int = 10) -> dict[str, Any]:
        return hk.audit_entries(Path(project), limit=limit)

    @server.tool(description=TOOL_DESCRIPTIONS[4]["description"])
    def harness_knowledge_verify(project: str) -> dict[str, Any]:
        return hk.verify_knowledge(Path(project))

    @server.tool(description=TOOL_DESCRIPTIONS[5]["description"])
    def harness_knowledge_suggest_validators(
        project: str,
        limit: int = 20,
        statuses: list[str] | None = None,
        apply: bool = False,
    ) -> dict[str, Any]:
        return hk.suggest_validators(Path(project), limit=limit, statuses=statuses or [], apply=apply)

    @server.tool(description=TOOL_DESCRIPTIONS[6]["description"])
    def harness_knowledge_query(
        project: str,
        query: str,
        limit: int = 10,
        files: list[str] | None = None,
        statuses: list[str] | None = None,
        types: list[str] | None = None,
    ) -> dict[str, Any]:
        return hk.query_index(
            Path(project),
            query,
            limit=limit,
            file_filters=files or [],
            statuses=statuses or [],
            types=types or [],
        )

    @server.tool(description=TOOL_DESCRIPTIONS[7]["description"])
    def harness_knowledge_promote(
        project: str,
        entry_id: str,
        note: str = "",
        allow_stale: bool = False,
    ) -> dict[str, Any]:
        return hk.promote_entry(Path(project), entry_id, note, allow_stale=allow_stale)

    @server.tool(description=TOOL_DESCRIPTIONS[8]["description"])
    def harness_knowledge_demote(
        project: str,
        entry_id: str,
        status: str,
        reason: str,
    ) -> dict[str, Any]:
        return hk.demote_entry(Path(project), entry_id, status, reason)

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Harness knowledge MCP server.")
    parser.add_argument("--describe-tools", action="store_true", help="Print static MCP tool metadata as JSON and exit.")
    parser.add_argument("--transport", choices=["stdio", "sse", "streamable-http"], default="stdio")
    args = parser.parse_args(argv)

    if args.describe_tools:
        print(json.dumps(describe_tools(), ensure_ascii=False, indent=2))
        return 0

    try:
        server = create_server()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    server.run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
