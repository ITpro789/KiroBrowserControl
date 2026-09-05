"""
Robust WebMCP WebSocket & HTTP Bridge Server
"""

import sys
import os
import time
import json
import base64
import uuid
import asyncio
import threading
import argparse
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import websockets

HTTP_PORT = 8765
WS_PORT = 8766
SHARED_TOKEN_FILE = Path(r"C:\Users\sohai\OneDrive - SKP Consultancy Ltd\Documents\KiroBrowserControl\.bridge-token")
def get_bridge_token():
    if SHARED_TOKEN_FILE.exists():
        return SHARED_TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""

class WebMCPBridge:
    def __init__(self):
        self.clients = set()
        self.pending = {}
        self.loop = None

    async def handle_ws(self, websocket):
        self.clients.add(websocket)
        print(f"\n[WebMCP] >>> Chrome Extension CONNECTED! Total active clients: {len(self.clients)} <<<")
        try:
            async for raw in websocket:
                try:
                    data = json.loads(raw)
                    cmd_id = data.get("command_id")
                    if cmd_id and cmd_id in self.pending:
                        screenshot_data = data.get("screenshot", "")
                        if screenshot_data and "," in screenshot_data:
                            b64_str = screenshot_data.split(",", 1)[1]
                            img_bytes = base64.b64decode(b64_str)
                            screenshot_file = ARTIFACTS_DIR / "browser_view.png"
                            with open(screenshot_file, "wb") as f:
                                f.write(img_bytes)
                            data["screenshot_saved"] = str(screenshot_file)
                            del data["screenshot"]

                        self.save_artifact(data)

                        fut = self.pending.pop(cmd_id)
                        if not fut.done():
                            fut.set_result(data)
                except Exception as e:
                    print("[WebMCP] Message handling error:", e)
        finally:
            self.clients.discard(websocket)
            print(f"\n[WebMCP] Chrome Extension disconnected. Active clients: {len(self.clients)}")

    def save_artifact(self, data):
        tab = data.get("tab", {})
        md_path = ARTIFACTS_DIR / "browser_live.md"
        content = f"""# Live Browser View (Personal Chrome Session)

**Page Title**: {tab.get('title', 'Unknown')}  
**Current URL**: [{tab.get('url', 'Unknown')}]({tab.get('url', '#')})

![Live Screen Capture](file:///{str(ARTIFACTS_DIR / 'browser_view.png').replace(chr(92), '/')})
"""
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content)

    async def send(self, payload, timeout=12):
        if not self.clients:
            return {"error": "Extension not connected. Make sure Chrome has the extension loaded and active."}

        cmd_id = str(uuid.uuid4())
        payload["command_id"] = cmd_id
        fut = self.loop.create_future()
        self.pending[cmd_id] = fut

        msg = json.dumps(payload)
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:
                pass

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.pending.pop(cmd_id, None)
            return {"error": "Timeout waiting for Chrome extension"}

bridge = WebMCPBridge()

class HTTPHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/status':
            connected = len(bridge.clients) > 0
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"connected": connected, "clients": len(bridge.clients)}).encode('utf-8'))
        elif self.path == '/portal' or self.path == '/':
            portal_path = Path(r"C:\Users\sohai\Documents\AccounTech_AI_System\accounting_portal.html")
            if portal_path.exists():
                with open(portal_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(content)
            else:
                self.send_response(404)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len).decode('utf-8')
        data = json.loads(body) if body else {}

        if self.path == '/execute':
            fut = asyncio.run_coroutine_threadsafe(bridge.send(data), bridge.loop)
            res = fut.result()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(res).encode('utf-8'))

    def log_message(self, format, *args):
        pass


def free_port(port):
    import subprocess, sys
    try:
        if sys.platform == "win32":
            res = subprocess.run(["netstat", "-ano"], capture_output=True, text=True)
            for line in res.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.strip().split()
                    pid = parts[-1]
                    if pid.isdigit() and int(pid) != os.getpid():
                        subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
    except Exception:
        pass

def run_servers():
    free_port(HTTP_PORT)
    free_port(WS_PORT)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bridge.loop = loop

    # Start HTTP server in a separate thread
    http_server = HTTPServer(('127.0.0.1', HTTP_PORT), HTTPHandler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()
    print(f"[WebMCP] HTTP API ready on http://127.0.0.1:{HTTP_PORT}")

    # Start WebSocket Server
    async def main():
        async with websockets.serve(bridge.handle_ws, "127.0.0.1", WS_PORT, max_size=50 * 1024 * 1024):
            print(f"[WebMCP] WebSocket Server ready on ws://127.0.0.1:{WS_PORT}")
            await asyncio.Future()

    loop.run_until_complete(main())

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WebMCP Bridge")
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--action", choices=["get_state", "navigate", "click", "type", "form_input", "scroll", "switch_tab", "focus_tab", "eval", "key", "select_option", "read_content", "get_errors", "new_tab", "close_tab", "reload_extension"], default="get_state")
    parser.add_argument("--url", default="")
    parser.add_argument("--target", default="")
    parser.add_argument("--option", default="", help="Option text to select from dropdown/combobox")
    parser.add_argument("--x", type=int, default=None)
    parser.add_argument("--y", type=int, default=None)
    parser.add_argument("--text", default="")
    parser.add_argument("--key", help="Key name to send via CDP (ArrowDown, ArrowUp, Enter, Tab, Escape, etc.)")
    parser.add_argument("--code", help="Javascript expression to evaluate")
    parser.add_argument("--code-b64", help="Base64 encoded javascript expression to evaluate")
    parser.add_argument("--enter", action="store_true", help="Press enter after typing")
    parser.add_argument("--direction", default="down")
    parser.add_argument("--amount", type=int, default=500)
    parser.add_argument("--tab-id", type=int, default=None)

    args = parser.parse_args()

    if args.server:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('127.0.0.1', HTTP_PORT))
        sock.close()
        if result == 0:
            print(f"[WebMCP] Universal Browser Bridge is already running and listening on http://127.0.0.1:{HTTP_PORT}")
            sys.exit(0)
        run_servers()
    else:
        import urllib.request
        import base64
        code = args.code
        if args.code_b64:
            code = base64.b64decode(args.code_b64).decode('utf-8')
        payload = {
            "action": args.action,
            "agent_name": "AG",
            "url": args.url,
            "target": args.target,
            "option": args.option,
            "x": args.x,
            "y": args.y,
            "text": args.text,
            "key": args.key,
            "code": code,
            "enter": args.enter,
            "direction": args.direction,
            "amount": args.amount,
            "tab_id": args.tab_id
        }
        tok = get_bridge_token()
        headers = {'Content-Type': 'application/json'}
        if tok:
            headers['X-Bridge-Token'] = tok

        req = urllib.request.Request(
            f"http://127.0.0.1:{HTTP_PORT}/execute",
            data=json.dumps(payload).encode('utf-8'),
            headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=35) as resp:
                print(resp.read().decode('utf-8'))
        except Exception as e:
            print(json.dumps({"error": f"Failed: {e}"}))
