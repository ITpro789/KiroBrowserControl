"""
Kiro Browser Bridge - MCP server.

Exposes the bridge as Model Context Protocol tools over stdio, so Kiro gets
first-class tools with schemas instead of shelling out to the CLI.

Zero dependencies beyond the standard library: the MCP stdio transport is
newline-delimited JSON-RPC 2.0, which is simple enough to implement directly.

    Kiro  --stdio JSON-RPC-->  this  --HTTP :8765-->  bridge  --WS-->  extension

The bridge server (bridge_server.py --server) must already be running.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HTTP_BASE = "http://127.0.0.1:8765"
ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / ".bridge-token"
REQUEST_TIMEOUT_S = 40

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "kiro-browser-bridge", "version": "1.0.0"}


def token() -> str:
    if not TOKEN_FILE.exists():
        return ""
    return TOKEN_FILE.read_text(encoding="utf-8").strip()


def call_bridge(payload: dict) -> dict:
    tok = token()
    if not tok:
        return {"status": "error",
                "error": f"no token at {TOKEN_FILE}. Start bridge_server.py --server once."}

    req = urllib.request.Request(
        f"{HTTP_BASE}/execute",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Bridge-Token": tok},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"status": "error", "error": f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}"}
    except urllib.error.URLError as exc:
        return {"status": "error",
                "error": f"bridge not reachable on :8765 - run "
                         f"'python scripts/bridge_server.py --server' first ({exc.reason})"}


def summarise(result: dict, include_elements=True) -> str:
    """Turn a bridge response into compact text for the model."""
    if result.get("status") != "ok":
        return f"ERROR: {result.get('error', 'unknown error')}"

    tab = result.get("tab", {})
    lines = [
        f"url:   {tab.get('url', '?')}",
        f"title: {tab.get('title', '?')}",
    ]

    if result.get("result") is not None:
        lines.append(f"result: {json.dumps(result['result'])[:2000]}")

    if result.get("screenshot_saved"):
        lines.append(f"screenshot: {result['screenshot_saved']}")

    if include_elements:
        elements = result.get("elements", [])
        lines.append(f"\ninteractive elements ({len(elements)}):")
        for el in elements[:120]:
            text = el.get("text", "")
            bits = [f"[{el['id']}]", el.get("tag", "")]
            if el.get("type"):
                bits.append(f"({el['type']})")
            if text:
                bits.append(f'"{text}"')
            lines.append("  " + " ".join(bits))
        if len(elements) > 120:
            lines.append(f"  … {len(elements) - 120} more")

    tabs = result.get("tabs", [])
    if len(tabs) > 1:
        lines.append(f"\nopen tabs ({len(tabs)}):")
        for t in tabs[:25]:
            mark = "*" if t.get("active") else " "
            lines.append(f"  {mark} id={t['id']} {str(t.get('title'))[:60]}")

    return "\n".join(lines)


TOOLS = [
    {
        "name": "browser_get_state",
        "description": (
            "Read the current browser state: URL, title, a numbered list of interactive "
            "elements, and a screenshot saved to disk. Call this FIRST, and again after "
            "any action, because element numbers are only valid until the page changes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tab_id": {"type": "integer", "description": "Target a specific tab id."}
            },
        },
    },
    {
        "name": "browser_navigate",
        "description": "Navigate the active tab to a URL. https:// is added if no scheme is given.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "tab_id": {"type": "integer"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "browser_click",
        "description": (
            "Click an element by its number from browser_get_state, or by raw viewport "
            "x/y coordinates. Dispatches real CDP mouse events so React and other "
            "frameworks register it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "integer", "description": "Element number from get_state."},
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "tab_id": {"type": "integer"},
            },
        },
    },
    {
        "name": "browser_type",
        "description": (
            "Type text into whatever currently has focus, optionally pressing Enter. "
            "To fill a specific field reliably, prefer browser_fill."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "enter": {"type": "boolean", "description": "Press Enter afterwards."},
                "tab_id": {"type": "integer"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "browser_fill",
        "description": (
            "Set a form field's value by element number or CSS selector. Uses the native "
            "property setter so React, Angular and Vue state updates correctly, which a "
            "plain value assignment does not do."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "Element number or CSS selector."},
                "text": {"type": "string"},
                "tab_id": {"type": "integer"},
            },
            "required": ["target", "text"],
        },
    },
    {
        "name": "browser_key",
        "description": "Press a single named key.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "enum": ["Enter", "Tab", "Escape", "Space", "Backspace", "Delete",
                             "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"],
                },
                "tab_id": {"type": "integer"},
            },
            "required": ["key"],
        },
    },
    {
        "name": "browser_scroll",
        "description": "Scroll the page up or down by a pixel amount.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["up", "down"]},
                "amount": {"type": "integer", "description": "Pixels, default 500."},
                "tab_id": {"type": "integer"},
            },
        },
    },
    {
        "name": "browser_list_tabs",
        "description": "List all open tabs with their ids, titles and URLs.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_eval",
        "description": (
            "Evaluate a JavaScript expression in the page and return its value. Disabled "
            "unless the bridge was started with --allow-eval, because it grants arbitrary "
            "code execution in a logged-in browser."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string"},
                "tab_id": {"type": "integer"},
            },
            "required": ["code"],
        },
    },
]

ACTION_FOR = {
    "browser_get_state": "get_state",
    "browser_navigate": "navigate",
    "browser_click": "click",
    "browser_type": "type",
    "browser_fill": "form_input",
    "browser_key": "key",
    "browser_scroll": "scroll",
    "browser_list_tabs": "get_state",
    "browser_eval": "eval",
}


def dispatch_tool(name: str, args: dict) -> str:
    action = ACTION_FOR.get(name)
    if not action:
        return f"ERROR: unknown tool {name}"

    payload = {"action": action}
    for key in ("tab_id", "url", "text", "key", "code", "direction", "amount", "x", "y"):
        if key in args and args[key] is not None:
            payload[key] = args[key]

    if "target" in args and args["target"] is not None:
        payload["target"] = str(args["target"])
    if args.get("enter"):
        payload["enter"] = True

    result = call_bridge(payload)

    if name == "browser_list_tabs":
        if result.get("status") != "ok":
            return f"ERROR: {result.get('error')}"
        lines = [f"{len(result.get('tabs', []))} open tab(s):"]
        for t in result.get("tabs", []):
            mark = "*" if t.get("active") else " "
            lines.append(f"  {mark} id={t['id']}  {str(t.get('title'))[:70]}\n      {t.get('url')}")
        return "\n".join(lines)

    return summarise(result, include_elements=(name != "browser_eval"))


# ---------------------------------------------------------------------------
# JSON-RPC / MCP stdio loop
# ---------------------------------------------------------------------------

def respond(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def respond_error(msg_id, code, message):
    sys.stdout.write(json.dumps(
        {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue

        method = msg.get("method")
        msg_id = msg.get("id")

        if method == "initialize":
            respond(msg_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            })
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            respond(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params") or {}
            name = params.get("name", "")
            args = params.get("arguments") or {}
            try:
                text = dispatch_tool(name, args)
                is_error = text.startswith("ERROR:")
                respond(msg_id, {
                    "content": [{"type": "text", "text": text}],
                    "isError": is_error,
                })
            except Exception as exc:
                respond(msg_id, {
                    "content": [{"type": "text", "text": f"ERROR: {exc}"}],
                    "isError": True,
                })
        elif method == "ping":
            respond(msg_id, {})
        elif msg_id is not None:
            respond_error(msg_id, -32601, f"method not found: {method}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
