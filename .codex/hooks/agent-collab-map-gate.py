#!/usr/bin/env python3
"""Adapt Codex apply_patch hook payloads to MAP's upstream MultiEdit gate."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_GATE = PROJECT_ROOT / ".codex" / "hooks" / "workflow-gate.py"
PATCH_PATH = re.compile(
    r"^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$",
    re.MULTILINE,
)
MOVE_PATH = re.compile(r"^\*\*\* Move to: (.+?)\s*$", re.MULTILINE)


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def patch_text(tool_input: object) -> str | None:
    if isinstance(tool_input, str):
        return tool_input
    if not isinstance(tool_input, dict):
        return None
    for key in ("patch", "input", "text"):
        value = tool_input.get(key)
        if isinstance(value, str):
            return value
    return None


def adapt(tool_call: dict[str, object]) -> dict[str, object]:
    tool_name = tool_call.get("tool_name")
    if tool_name in {"Edit", "Write", "MultiEdit"}:
        return tool_call
    if tool_name != "apply_patch":
        raise ValueError("unexpected editing tool for the MAP adapter")
    source = patch_text(tool_call.get("tool_input"))
    if source is None:
        raise ValueError("apply_patch payload has no exact patch text")
    paths = [path.strip() for path in PATCH_PATH.findall(source)]
    paths.extend(path.strip() for path in MOVE_PATH.findall(source))
    paths = list(dict.fromkeys(path for path in paths if path))
    if not paths:
        raise ValueError("apply_patch payload has no target path")
    return {
        **tool_call,
        "tool_name": "MultiEdit",
        "tool_input": {"edits": [{"file_path": path} for path in paths]},
    }


def main() -> None:
    try:
        incoming = json.load(sys.stdin)
        if not isinstance(incoming, dict):
            raise ValueError("hook payload must be a JSON object")
        adapted = adapt(incoming)
        environment = dict(os.environ)
        environment["CLAUDE_PROJECT_DIR"] = str(PROJECT_ROOT)
        completed = subprocess.run(
            [sys.executable, str(UPSTREAM_GATE)],
            input=json.dumps(adapted),
            text=True,
            capture_output=True,
            cwd=PROJECT_ROOT,
            env=environment,
            timeout=10,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"upstream MAP gate exited {completed.returncode}")
        output = json.loads(completed.stdout)
        if not isinstance(output, dict):
            raise ValueError("upstream MAP gate returned a non-object response")
        print(json.dumps(output))
    except Exception as error:
        deny(f"Blocked: Codex MAP editing adapter failed closed: {error}")


if __name__ == "__main__":
    main()
