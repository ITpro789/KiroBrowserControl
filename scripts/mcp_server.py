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
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HTTP_BASE = "http://127.0.0.1:8765"
ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / ".bridge-token"
REQUEST_TIMEOUT_S = 40

CLIENT_NAME = os.environ.get("BRIDGE_CLIENT_NAME", "Kiro")
if "--client" in sys.argv:
    try:
        idx = sys.argv.index("--client")
        if idx + 1 < len(sys.argv):
            CLIENT_NAME = sys.argv[idx + 1]
    except ValueError:
        pass

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": f"{CLIENT_NAME.lower()}-browser-bridge", "version": "1.0.0"}


def token() -> str:
    if not TOKEN_FILE.exists():
        return ""
    return TOKEN_FILE.read_text(encoding="utf-8").strip()


def is_antigravity() -> bool:
    return CLIENT_NAME.strip().lower() in ("ag", "antigravity")


def sync_brain_artifact(screenshot_path_str: str, tab_info: dict = None):
    """
    Publish the screenshot into Antigravity's brain directory so it renders
    inline there. Antigravity-specific, so it is gated on the client: without
    this check a Kiro command writes into ~/.gemini and overwrites the view
    Antigravity is looking at, and vice versa.
    """
    if not is_antigravity():
        return None
    if not screenshot_path_str:
        return None
    src = Path(screenshot_path_str)
    if not src.exists():
        return None
    brain_dir = Path.home() / ".gemini" / "antigravity" / "brain"
    if not brain_dir.exists():
        return None
    candidates = [d for d in brain_dir.iterdir() if d.is_dir() and not d.name.startswith(".")]
    if not candidates:
        return None
    candidates.sort(key=lambda d: d.stat().st_mtime, reverse=True)
    active_brain = candidates[0]
    dest = active_brain / src.name
    try:
        import shutil
        shutil.copy2(src, dest)
        md_path = active_brain / "browser_live.md"
        title = (tab_info or {}).get("title", "Live Browser View")
        url = (tab_info or {}).get("url", "")
        norm_dest = str(dest).replace("\\", "/")
        md_content = f"# Live Browser View (Personal Chrome Session)\n\n**Page Title**: {title}  \n**Current URL**: [{url}]({url})\n\n![Live Screen Capture](file:///{norm_dest})\n"
        md_path.write_text(md_content, encoding="utf-8")
        return str(dest)
    except Exception:
        return None


def call_bridge(payload: dict) -> dict:
    tok = token()
    if not tok:
        return {"status": "error",
                "error": f"no token at {TOKEN_FILE}. Start bridge_server.py --server once."}

    payload = dict(payload)
    payload.setdefault("agent_name", CLIENT_NAME)

    req = urllib.request.Request(
        f"{HTTP_BASE}/execute",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Bridge-Token": tok},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("screenshot_saved"):
                brain_path = sync_brain_artifact(data.get("screenshot_saved"), data.get("tab"))
                if brain_path:
                    data["brain_sync_path"] = brain_path
            return data
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
    agent_label = tab.get("agent_name", CLIENT_NAME)
    lines = [
        f"url:   {tab.get('url', '?')}",
        f"title: {tab.get('title', '?')}",
        f"tab:   id={tab.get('id', '?')}"
        + (f"  ({agent_label} agent tab, running in the background)" if tab.get("agent")
           else "  (not the agent tab)"),
    ]

    if result.get("result") is not None:
        lines.append(f"result: {json.dumps(result['result'])[:2000]}")

    for dlg in result.get("dialogs", []):
        verb = "accepted" if dlg.get("handled") == "accept" else "cancelled"
        note = ""
        if dlg.get("default_used") and dlg.get("type") in ("confirm", "prompt"):
            note = " - pass on_dialog='accept' to confirm it instead"
        lines.append(f"dialog: {dlg.get('type')} {verb}{note}"
                     f"\n        \"{dlg.get('message', '')}\"")

    if result.get("screenshot_saved"):
        lines.append(f"screenshot: {result['screenshot_saved']}")
    if result.get("brain_sync_path"):
        lines.append(f"brain_artifact: {result['brain_sync_path']}")
    if result.get("screenshot_mode") == "focused":
        lines.append("note: the background screenshot failed so the tab was briefly "
                     "brought to the front. Reason: "
                     f"{result.get('background_capture_error', 'unknown')}")
    if result.get("screenshot_error"):
        lines.append(f"screenshot unavailable: {result['screenshot_error']} "
                     f"(element list below is still accurate)")

    if result.get("recent_errors"):
        lines.append(f"\nrecent errors ({len(result['recent_errors'])}):")
        for err in result["recent_errors"]:
            if err.get("type") == "network":
                lines.append(f"  [network] {err.get('status')} {err.get('statusText')} - {err.get('url')}")
            else:
                lines.append(f"  [console] {err.get('level')}: {err.get('text')}")

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
                "tab_id": {"type": "integer", "description": "Target a specific tab id."},
                "visual_badges": {"type": "boolean", "description": "Whether to overlay high-contrast visual badge stickers on the screenshot (default true)."}
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
                    "description": "Key name (Enter, Tab, Escape, Space, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, or single letter like 'a', 'c').",
                },
                "modifiers": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Modifier keys to hold: Control, Shift, Alt, Meta (e.g. ['Control'] for Ctrl+A).",
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
        "description": (
            "List all open tabs with their ids, titles and URLs. The tab marked [agent] "
            "is the one in the Kiro tab group that browser tools drive by default."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_use_tab",
        "description": (
            "Adopt an existing tab as the agent's working tab, so later calls without "
            "tab_id act on it. Use when the user asks you to work on a page they already "
            "have open instead of the Kiro tab."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"tab_id": {"type": "integer"}},
            "required": ["tab_id"],
        },
    },
    {
        "name": "browser_focus_tab",
        "description": (
            "Bring the agent's tab to the front and focus its window. The agent normally "
            "works in an unfocused background tab; call this only when the user needs to "
            "see or take over the page, for example to sign in or clear a CAPTCHA. It "
            "interrupts whatever they are doing, so do not call it routinely."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"tab_id": {"type": "integer"}},
        },
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
    {
        "name": "browser_read_content",
        "description": "Extract full readable markdown text, headings, tables, and lists from the active web page.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tab_id": {"type": "integer", "description": "Target a specific tab id."},
                "max_length": {"type": "integer", "description": "Maximum character length to return (default 25000)."},
            },
        },
    },
    {
        "name": "browser_get_errors",
        "description": "Inspect recent JavaScript console errors and failed HTTP network requests (status >= 400).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tab_id": {"type": "integer", "description": "Target a specific tab id."},
            },
        },
    },
    {
        "name": "browser_select_option",
        "description": "Select an option in a <select> dropdown or click an ARIA combobox item by its value or text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "Element badge number from browser_get_state."},
                "value": {"type": "string", "description": "Option value or visible text to select."},
                "tab_id": {"type": "integer"},
            },
            "required": ["target", "value"],
        },
    },
    {
        "name": "browser_ensure_tab",
        "description": (
            "Return your working tab, reusing the existing one if it is still open and "
            "only creating one if there is none. Idempotent, so it is safe to call at the "
            "start of a task or after the user has closed tabs. Prefer this over "
            "browser_new_tab, which always adds another tab."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_new_tab",
        "description": "Open a new background tab in the agent tab group with an optional URL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Initial URL to open (default about:blank)."},
            },
        },
    },
    {
        "name": "browser_close_tab",
        "description": "Close the agent's background tab or a specific tab id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tab_id": {"type": "integer", "description": "Target tab id to close (defaults to current agent tab)."},
            },
        },
    },
]

# Any action that navigates or mutates the page can raise a dialog, so the same
# override is offered on all of them rather than repeated in five schemas.
DIALOG_PROPS = {
    "on_dialog": {
        "type": "string",
        "enum": ["accept", "dismiss"],
        "description": (
            "How to answer a JavaScript dialog raised by this action. alert and "
            "beforeunload are always accepted. confirm and prompt default to dismiss, "
            "because accepting an unknown confirmation can be destructive - pass "
            "'accept' only when you know what is being confirmed."
        ),
    },
    "dialog_text": {
        "type": "string",
        "description": "Text to submit when the dialog is a prompt() and on_dialog is 'accept'.",
    },
}

for _tool in TOOLS:
    if _tool["name"] in ("browser_navigate", "browser_click", "browser_type",
                         "browser_fill", "browser_key", "browser_select_option"):
        _tool["inputSchema"]["properties"].update(DIALOG_PROPS)

ACTION_FOR = {
    "browser_get_state": "get_state",
    "browser_navigate": "navigate",
    "browser_click": "click",
    "browser_type": "type",
    "browser_fill": "form_input",
    "browser_key": "key",
    "browser_scroll": "scroll",
    "browser_list_tabs": "get_state",
    "browser_ensure_tab": "ensure_tab",
    "browser_use_tab": "switch_tab",
    "browser_focus_tab": "focus_tab",
    "browser_eval": "eval",
    "browser_read_content": "read_content",
    "browser_get_errors": "get_errors",
    "browser_select_option": "select_option",
    "browser_new_tab": "new_tab",
    "browser_close_tab": "close_tab",
}


def dispatch_tool(name: str, args: dict) -> str:
    action = ACTION_FOR.get(name)
    if not action:
        return f"ERROR: unknown tool {name}"

    payload = {"action": action}
    for key in ("tab_id", "url", "text", "key", "modifiers", "code", "direction", "amount", "x", "y",
                "value", "max_length", "visual_badges", "on_dialog", "dialog_text"):
        if key in args and args[key] is not None:
            payload[key] = args[key]

    if "target" in args and args["target"] is not None:
        payload["target"] = str(args["target"])
    if args.get("enter"):
        payload["enter"] = True

    result = call_bridge(payload)

    if name == "browser_read_content":
        if result.get("status") != "ok":
            return f"ERROR: {result.get('error')}"
        title = result.get("title", "")
        url = result.get("url", "")
        content = result.get("content", "(no content)")
        return f"# {title}\nURL: {url}\n\n{content}"

    if name == "browser_get_errors":
        if result.get("status") != "ok":
            return f"ERROR: {result.get('error')}"
        errors = result.get("errors", [])
        if not errors:
            return "No recent console errors or failed network requests."
        lines = [f"Found {len(errors)} recent error(s):"]
        for err in errors:
            if err.get("type") == "network":
                lines.append(f"  [Network HTTP {err.get('status')}] {err.get('statusText')} - {err.get('url')}")
            else:
                lines.append(f"  [Console {err.get('level')}] {err.get('text')}")
        return "\n".join(lines)

    if name == "browser_list_tabs":
        if result.get("status") != "ok":
            return f"ERROR: {result.get('error')}"
        lines = [f"{len(result.get('tabs', []))} open tab(s):"]
        for t in result.get("tabs", []):
            mark = "*" if t.get("active") else " "
            tag = " [agent]" if t.get("agent") else ""
            lines.append(f"  {mark} id={t['id']}{tag}  {str(t.get('title'))[:70]}"
                         f"\n      {t.get('url')}")
        lines.append("\n* = tab the user is looking at, [agent] = the active agent tab you drive")
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
