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
import os
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


def normalise_agent(name) -> str:
    """One canonical name per agent, so artifacts and tab groups agree."""
    if str(name or "").strip().lower() in ("ag", "antigravity"):
        return "AG"
    return "Kiro"


def annotate_image_with_badges(image_bytes: bytes, elements: list):
    """Returns annotated PNG bytes, or None when Pillow is unavailable."""
    import io

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        # Reported to the caller rather than swallowed. An agent handed an
        # unbadged screenshot will try to click badge numbers that are not there.
        return None

    try:

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        draw = ImageDraw.Draw(img)

        # Select a crisp font
        font = None
        for f_name in ["consola.ttf", "arialbd.ttf", "segoeuib.ttf", "calibrib.ttf", "arial.ttf"]:
            try:
                font = ImageFont.truetype(f_name, 11)
                break
            except Exception:
                continue
        if font is None:
            font = ImageFont.load_default()

        img_w, img_h = img.size

        for el in elements:
            eid = str(el.get("id", ""))
            if not eid:
                continue

            # Position at top-left corner of element if available, else center
            if "left" in el and "top" in el:
                x = el["left"]
                y = el["top"]
            else:
                x = el.get("x", 0)
                y = el.get("y", 0)

            bbox = draw.textbbox((0, 0), eid, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]

            pad_x = 3
            pad_y = 2
            bw = tw + pad_x * 2
            bh = th + pad_y * 2

            # Position badge at (x, y - bh/2) so it rests neatly on the element
            bx0 = max(0, min(x, img_w - bw))
            by0 = max(0, min(y - bh // 2, img_h - bh))
            bx1 = bx0 + bw
            by1 = by0 + bh

            # Solid yellow fill with 1px black outline
            draw.rectangle([bx0, by0, bx1, by1], fill="#ffeb3b", outline="#000000", width=1)
            draw.text((bx0 + pad_x, by0 + pad_y - 1), eid, fill="#000000", font=font)

        out_buf = io.BytesIO()
        img.save(out_buf, format="PNG")
        return out_buf.getvalue()
    except Exception as exc:
        print(f"[bridge] warning: could not draw badges on image: {exc}")
        return image_bytes


class Bridge:
    """Tracks authenticated extension clients and correlates request/response."""

    def __init__(self):
        self.clients = set()
        self.pending = {}
        self.command_opts = {}
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
                    header, _, payload = shot.partition(",")
                    # Background captures come back as JPEG, so the extension is
                    # taken from the data URL rather than assumed to be PNG.
                    suffix = ".jpg" if "image/jpeg" in header else ".png"
                    cmd_opts = self.command_opts.get(cmd_id, {})

                    # Screenshots are per agent. A single shared browser_view.png
                    # means two agents overwrite each other, and each then reads
                    # a picture of the other's page.
                    agent = normalise_agent(cmd_opts.get("agent_name"))
                    stem = f"browser_view_{agent.lower()}"

                    try:
                        ARTIFACTS.mkdir(parents=True, exist_ok=True)
                        for stale in ARTIFACTS.glob(f"{stem}.*"):
                            if stale.suffix != suffix:
                                stale.unlink(missing_ok=True)
                        path = ARTIFACTS / f"{stem}{suffix}"
                        clean_path = ARTIFACTS / f"{stem}_clean{suffix}"
                        raw_bytes = base64.b64decode(payload)
                        clean_path.write_bytes(raw_bytes)
                        msg["clean_screenshot_saved"] = str(clean_path)

                        elements = msg.get("elements", [])
                        show_badges = cmd_opts.get("visual_badges", True)

                        if show_badges and elements:
                            annotated_bytes = annotate_image_with_badges(raw_bytes, elements)
                            if annotated_bytes is None:
                                # Pillow missing. Say so rather than silently
                                # handing back an unbadged image the agent will
                                # then try to click by number.
                                path.write_bytes(raw_bytes)
                                msg["badges_unavailable"] = (
                                    "Pillow is not installed, so the screenshot has no "
                                    "numbered badges. Use the element list instead, or "
                                    "run: pip install Pillow"
                                )
                            else:
                                path.write_bytes(annotated_bytes)
                        else:
                            path.write_bytes(raw_bytes)

                        msg["screenshot_saved"] = str(path)
                        msg["agent_name"] = agent
                    except Exception as exc:
                        msg["screenshot_error"] = str(exc)

                self.command_opts.pop(cmd_id, None)
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
        self.command_opts[cmd_id] = dict(payload)
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
            self.command_opts.pop(cmd_id, None)
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
    print(" Kiro-AG-Browser Bridge")
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


def sync_brain_artifact(screenshot_path_str: str, tab_info: dict = None):
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


def run_cli(args):
    import urllib.error
    import urllib.request

    mods = [m.strip() for m in args.modifiers.split(",") if m.strip()] if args.modifiers else None

    payload = {
        "action": args.action,
        "agent_name": args.agent_name,
        "url": args.url or None,
        "target": args.target or None,
        "value": args.value or None,
        "x": args.x,
        "y": args.y,
        "text": args.text or None,
        "key": args.key,
        "modifiers": mods,
        "code": args.code,
        "enter": args.enter or None,
        "direction": args.direction,
        "amount": args.amount,
        "max_length": args.max_length,
        "visual_badges": not args.no_badges,
        "tab_id": args.tab_id,
        "on_dialog": args.on_dialog,
        "dialog_text": args.dialog_text,
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

    if body.get("screenshot_saved"):
        brain_path = sync_brain_artifact(body.get("screenshot_saved"), body.get("tab"))
        if brain_path:
            body["brain_sync_path"] = brain_path

    body.pop("elements", None) if args.brief else None
    print(json.dumps(body, indent=2))
    return 0 if body.get("status") == "ok" else 1


def main():
    global TOKEN, ALLOW_EVAL

    parser = argparse.ArgumentParser(description="Kiro-AG-Browser Bridge")
    parser.add_argument("--server", action="store_true", help="run the bridge server")
    parser.add_argument("--allow-eval", action="store_true",
                        help="permit arbitrary JS execution in page context")
    parser.add_argument("--print-token", action="store_true", help="print the token and exit")
    parser.add_argument("--client", "--agent-name", dest="agent_name",
                        default=os.environ.get("BRIDGE_CLIENT_NAME", "Kiro"),
                        help="agent client identifier (e.g. AG or Kiro)")
    parser.add_argument("--action", default="get_state",
                        choices=["get_state", "navigate", "click", "type", "form_input",
                                 "scroll", "switch_tab", "focus_tab", "eval", "key",
                                 "select_option", "read_content", "get_errors", "new_tab",
                                 "close_tab", "ensure_tab", "reload_extension"])
    parser.add_argument("--url", default="")
    parser.add_argument("--target", default="")
    parser.add_argument("--value", default="", help="option value or text for select_option")
    parser.add_argument("--x", type=int)
    parser.add_argument("--y", type=int)
    parser.add_argument("--text", default="")
    parser.add_argument("--key")
    parser.add_argument("--modifiers", help="comma-separated key modifiers (Control, Shift, Alt, Meta)")
    parser.add_argument("--code")
    parser.add_argument("--enter", action="store_true")
    parser.add_argument("--direction", default="down", choices=["up", "down"])
    parser.add_argument("--amount", type=int, default=500)
    parser.add_argument("--max-length", type=int, default=25000)
    parser.add_argument("--no-badges", action="store_true", help="disable visual Set-of-Marks badge overlay")
    parser.add_argument("--tab-id", type=int, dest="tab_id")
    parser.add_argument("--on-dialog", dest="on_dialog", choices=["accept", "dismiss"],
                        help="how to answer a JS dialog raised by this action")
    parser.add_argument("--dialog-text", dest="dialog_text",
                        help="text to submit to a prompt() when accepting")
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
