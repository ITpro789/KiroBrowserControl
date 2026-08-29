"""
Kiro Browser Bridge - local bridge server.

Sits between an agent (HTTP / CLI / MCP) and the Chrome extension, which does
the actual driving via the Chrome Debugger Protocol.

    agent  --HTTP :8765-->  bridge  --WebSocket :8766-->  extension  --CDP-->  Chrome

Security
--------
Chrome 136+ refuses --remote-debugging-port against the default profile, so an
extension using chrome.debugger is the only way to automate a browser that
already holds live sessions. That power needs guarding:

  * WebSocket clients must present an Origin of chrome-extension://... The
    browser sets Origin itself, so a web page cannot forge it. This is what
    stops any site you visit from opening ws://127.0.0.1:8766 and driving your
    browser - WebSockets are not subject to CORS.
  * Both transports require a shared token, generated on first run and stored
    in .bridge-token next to this script.
  * The HTTP listener sends no permissive CORS headers, so pages cannot read
    responses even if they manage to POST.
  * 'eval' (arbitrary JS in page context) is refused unless --allow-eval.

Even so: do not point this at a browser holding privileged sessions. Use a
dedicated Chrome profile. See README.md.
"""

import argparse
import asyncio
import base64
import json
import secrets
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

try:
    import websockets
except ImportError:
    sys.exit("Missing dependency. Run:  pip install websockets")

HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8765
WS_HOST = "127.0.0.1"
WS_PORT = 8766

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TOKEN_FILE = ROOT / ".bridge-token"
ARTIFACTS = ROOT / "artifacts"

MAX_WS_MESSAGE = 64 * 1024 * 1024   # screenshots are large
COMMAND_TIMEOUT_S = 30

ALLOW_EVAL = False


def load_or_create_token() -> str:
    if TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if tok:
            return tok
    tok = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(tok, encoding="utf-8")
    try:
        # Best effort on Windows; on POSIX this matters more.
        TOKEN_FILE.chmod(0o600)
    except Exception:
        pass
    return tok


TOKEN = ""


class Bridge:
    """Tracks authenticated extension clients and correlates request/response."""

    def __init__(self):
        self.clients = set()
        self.pending = {}
        self.loop = None

    async def handle_ws(self, websocket):
        origin = websocket.request.headers.get("Origin", "") if hasattr(websocket, "request") \
            else websocket.request_headers.get("Origin", "")

        if not origin.startswith("chrome-extension://"):
            print(f"[bridge] REJECTED connection, bad Origin: {origin!r}")
            await websocket.close(code=1008, reason="origin not allowed")
            return

        authed = False
        try:
            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue

                mtype = msg.get("type")

                if not authed:
                    if mtype != "auth":
                        await websocket.close(code=1008, reason="auth required")
                        return
                    if not secrets.compare_digest(str(msg.get("token", "")), TOKEN):
                        print("[bridge] REJECTED connection, bad token")
                        await websocket.send(json.dumps({"type": "auth_failed"}))
                        await websocket.close(code=1008, reason="bad token")
                        return
                    authed = True
                    self.clients.add(websocket)
                    await websocket.send(json.dumps({"type": "auth_ok"}))
                    print(f"[bridge] extension connected and authenticated "
                          f"({len(self.clients)} client(s))")
                    continue

                if mtype == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))
                    continue

                cmd_id = msg.get("command_id")
                if not cmd_id or cmd_id not in self.pending:
                    continue

                shot = msg.pop("screenshot", "")
                if shot and "," in shot:
                    try:
                        ARTIFACTS.mkdir(parents=True, exist_ok=True)
                        path = ARTIFACTS / "browser_view.png"
                        path.write_bytes(base64.b64decode(shot.split(",", 1)[1]))
                        msg["screenshot_saved"] = str(path)
                    except Exception as exc:
                        msg["screenshot_error"] = str(exc)

                fut = self.pending.pop(cmd_id)
                if not fut.done():
                    fut.set_result(msg)
        finally:
            self.clients.discard(websocket)
            if authed:
                print(f"[bridge] extension disconnected ({len(self.clients)} client(s))")

    async def send(self, payload, timeout=COMMAND_TIMEOUT_S):
        if not self.clients:
            return {"status": "error",
                    "error": "extension not connected - load it in Chrome and paste "
                             "the token in its popup"}

        cmd_id = str(uuid.uuid4())
        payload["command_id"] = cmd_id
        payload["eval_allowed"] = ALLOW_EVAL

        fut = self.loop.create_future()
        self.pending[cmd_id] = fut
        raw = json.dumps(payload)

        for client in list(self.clients):
            try:
                await client.send(raw)
            except Exception:
                self.clients.discard(client)

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.pending.pop(cmd_id, None)
            return {"status": "error", "error": f"timed out after {timeout}s"}


bridge = Bridge()


class Handler(BaseHTTPRequestHandler):
    server_version = "KiroBrowserBridge/1.0"

    def _json(self, code, body):
        blob = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        # Deliberately no Access-Control-Allow-Origin: browsers must not be able
        # to read responses from this endpoint.
        self.end_headers()
        self.wfile.write(blob)

    def _authorised(self):
        supplied = self.headers.get("X-Bridge-Token", "")
        return secrets.compare_digest(supplied, TOKEN)

    def do_GET(self):
        if self.path != "/status":
            return self._json(404, {"error": "not found"})
        if not self._authorised():
            return self._json(401, {"error": "bad or missing X-Bridge-Token"})
        self._json(200, {
            "connected": len(bridge.clients) > 0,
            "clients": len(bridge.clients),
            "eval_allowed": ALLOW_EVAL,
        })

    def do_POST(self):
        if self.path != "/execute":
            return self._json(404, {"error": "not found"})
        if not self._authorised():
            return self._json(401, {"error": "bad or missing X-Bridge-Token"})

        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._json(400, {"error": "bad Content-Length"})
        if length > 2 * 1024 * 1024:
            return self._json(413, {"error": "payload too large"})

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "body must be JSON"})

        payload = {k: v for k, v in payload.items() if v is not None}

        try:
            fut = asyncio.run_coroutine_threadsafe(bridge.send(payload), bridge.loop)
            self._json(200, fut.result(timeout=COMMAND_TIMEOUT_S + 5))
        except Exception as exc:
            self._json(500, {"status": "error", "error": str(exc)})

    def log_message(self, fmt, *args):
        pass


def run_server():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bridge.loop = loop

    httpd = HTTPServer((HTTP_HOST, HTTP_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    print("=" * 66)
    print(" Kiro Browser Bridge")
    print("=" * 66)
    print(f" HTTP API   http://{HTTP_HOST}:{HTTP_PORT}   (X-Bridge-Token required)")
    print(f" WebSocket  ws://{WS_HOST}:{WS_PORT}     (chrome-extension origin only)")
    print(f" eval       {'ENABLED - arbitrary JS permitted' if ALLOW_EVAL else 'disabled'}")
    print("-" * 66)
    print(" Token (paste into the extension popup):")
    print(f"   {TOKEN}")
    print(f" Stored at: {TOKEN_FILE}")
    print("=" * 66)
    print(" Waiting for the extension to connect. Ctrl+C to stop.\n")

    async def main():
        async with websockets.serve(
            bridge.handle_ws, WS_HOST, WS_PORT, max_size=MAX_WS_MESSAGE
        ):
            await asyncio.Future()

    try:
        loop.run_until_complete(main())
    except KeyboardInterrupt:
        print("\n[bridge] stopped")


def run_cli(args):
    import urllib.error
    import urllib.request

    payload = {
        "action": args.action,
        "url": args.url or None,
        "target": args.target or None,
        "x": args.x,
        "y": args.y,
        "text": args.text or None,
        "key": args.key,
        "code": args.code,
        "enter": args.enter or None,
        "direction": args.direction,
        "amount": args.amount,
        "tab_id": args.tab_id,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    req = urllib.request.Request(
        f"http://{HTTP_HOST}:{HTTP_PORT}/execute",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Bridge-Token": TOKEN},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=COMMAND_TIMEOUT_S + 5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        print(json.dumps({"status": "error",
                          "error": f"cannot reach bridge on :{HTTP_PORT} - is it running? ({exc})"}))
        return 1

    body.pop("elements", None) if args.brief else None
    print(json.dumps(body, indent=2))
    return 0 if body.get("status") == "ok" else 1


def main():
    global TOKEN, ALLOW_EVAL

    parser = argparse.ArgumentParser(description="Kiro Browser Bridge")
    parser.add_argument("--server", action="store_true", help="run the bridge server")
    parser.add_argument("--allow-eval", action="store_true",
                        help="permit arbitrary JS execution in page context")
    parser.add_argument("--print-token", action="store_true", help="print the token and exit")
    parser.add_argument("--action", default="get_state",
                        choices=["get_state", "navigate", "click", "type", "form_input",
                                 "scroll", "switch_tab", "eval", "key"])
    parser.add_argument("--url", default="")
    parser.add_argument("--target", default="")
    parser.add_argument("--x", type=int)
    parser.add_argument("--y", type=int)
    parser.add_argument("--text", default="")
    parser.add_argument("--key")
    parser.add_argument("--code")
    parser.add_argument("--enter", action="store_true")
    parser.add_argument("--direction", default="down", choices=["up", "down"])
    parser.add_argument("--amount", type=int, default=500)
    parser.add_argument("--tab-id", type=int, dest="tab_id")
    parser.add_argument("--brief", action="store_true", help="omit the element list from output")
    args = parser.parse_args()

    TOKEN = load_or_create_token()
    ALLOW_EVAL = args.allow_eval

    if args.print_token:
        print(TOKEN)
        return 0
    if args.server:
        run_server()
        return 0
    return run_cli(args)


if __name__ == "__main__":
    sys.exit(main())
