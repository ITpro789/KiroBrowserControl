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

# Model APIs cap image dimensions, and the cap tightens once a request carries
# several images - which a browser session always ends up doing, one screenshot
# per get_state. Exceeding it rejects the whole request, so a long session dies
# permanently and cannot be recovered by resizing after the fact. Capped here on
# the way out instead.
MAX_IMAGE_EDGE = 1500

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


class OversizeScreenshot(Exception):
    """Raised when the size cap cannot be honoured.

    Deliberately not swallowed. An oversized image is rejected by the model API,
    and because the whole conversation is resent every turn, one of them kills
    the session permanently with no way back. Dropping a single screenshot is
    recoverable; the element list still carries the page. Poisoning the session
    is not. So this fails loudly rather than writing the file.
    """


def downscale_screenshot(image_bytes: bytes, viewport: dict = None, suffix: str = ".png"):
    """Caps the image at MAX_IMAGE_EDGE and returns (bytes, coord_scale).

    coord_scale converts element coordinates, which the extension reports in CSS
    pixels, into pixels of the returned image. Screenshots come back in device
    pixels, so on a scaled display the raw image is already larger than the CSS
    viewport and badges land in the wrong place without this.

    Raises OversizeScreenshot if the cap cannot be verified.
    """
    import io

    try:
        from PIL import Image
    except ImportError:
        raise OversizeScreenshot(
            "Pillow is not installed, so the screenshot cannot be resized below "
            f"the {MAX_IMAGE_EDGE}px limit. Run: pip install Pillow"
        )

    try:
        img = Image.open(io.BytesIO(image_bytes))
        img_w, img_h = img.size

        css_w = int((viewport or {}).get("width") or 0)
        css_h = int((viewport or {}).get("height") or 0)
        # Reference space for the cap is what the agent actually reasons about:
        # CSS pixels when known, otherwise the raw image.
        ref_w = css_w or img_w
        ref_h = css_h or img_h

        k = min(1.0, MAX_IMAGE_EDGE / max(ref_w, ref_h))
        out_w = max(1, int(round(ref_w * k)))
        out_h = max(1, int(round(ref_h * k)))

        if (out_w, out_h) != (img_w, img_h):
            img = img.convert("RGB").resize((out_w, out_h), Image.LANCZOS)
            buf = io.BytesIO()
            # Keep the encoding the extension chose; the filename already
            # committed to it.
            if suffix == ".jpg":
                img.save(buf, format="JPEG", quality=85)
            else:
                img.save(buf, format="PNG")
            image_bytes = buf.getvalue()

        # Re-read what is actually about to be written rather than trusting the
        # arithmetic above. This is the assertion that has to hold.
        final_w, final_h = Image.open(io.BytesIO(image_bytes)).size
        if max(final_w, final_h) > MAX_IMAGE_EDGE:
            raise OversizeScreenshot(
                f"resize produced {final_w}x{final_h}, still over the "
                f"{MAX_IMAGE_EDGE}px limit"
            )

        # Badge coords are CSS px; map them into the emitted image.
        coord_scale = (final_w / css_w) if css_w else (final_w / img_w)
        return image_bytes, coord_scale
    except OversizeScreenshot:
        raise
    except Exception as exc:
        raise OversizeScreenshot(f"could not resize screenshot: {exc}") from exc


def annotate_image_with_badges(image_bytes: bytes, elements: list, coord_scale: float = 1.0,
                               suffix: str = ".png"):
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
            # A frame whose position was never confirmed has only frame-local
            # coordinates. Drawing its badges would put them in the wrong place,
            # and the agent would read a badge that points at a different element.
            if el.get("coords_unknown"):
                continue
            # Visually-hidden control clicked by script: its box is 1px or off
            # the page, so a badge would mark nothing.
            if el.get("click_via") == "script":
                continue

            # Position at top-left corner of element if available, else center
            if "left" in el and "top" in el:
                x = el["left"]
                y = el["top"]
            else:
                x = el.get("x", 0)
                y = el.get("y", 0)

            # CSS pixels -> image pixels
            x = int(round(x * coord_scale))
            y = int(round(y * coord_scale))

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
        if suffix == ".jpg":
            img.save(out_buf, format="JPEG", quality=85)
        else:
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
        # CSS pixels per screenshot pixel, per (agent, tab), from the last
        # screenshot sent. Screenshots are shrunk to fit MAX_IMAGE_EDGE, so on a
        # wide viewport a point read off the image is not the same point on the
        # page. Raw x/y from the agent is converted back through this.
        self.image_to_css = {}
        self.last_tab = {}          # agent -> tab id of its last response
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
                        # Cap before anything is written. Both artifacts get read
                        # back by the agent, so both have to be within limits.
                        raw_bytes, coord_scale = downscale_screenshot(
                            raw_bytes, msg.get("viewport"), suffix
                        )
                        clean_path.write_bytes(raw_bytes)
                        msg["clean_screenshot_saved"] = str(clean_path)

                        elements = msg.get("elements", [])
                        show_badges = cmd_opts.get("visual_badges", True)

                        if show_badges and elements:
                            annotated_bytes = annotate_image_with_badges(
                                raw_bytes, elements, coord_scale, suffix
                            )
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

                        # Record how this image maps back to the page, for the
                        # next raw x/y from this agent on this tab.
                        tab_id = (msg.get("tab") or {}).get("id")
                        to_css = (1.0 / coord_scale) if coord_scale else 1.0
                        if tab_id is not None:
                            self.image_to_css[(agent, tab_id)] = to_css
                            self.last_tab[agent] = tab_id
                        try:
                            from PIL import Image
                            import io
                            w, h = Image.open(io.BytesIO(raw_bytes)).size
                            msg["screenshot_size"] = [w, h]
                        except Exception:
                            pass
                        msg["image_to_css"] = round(to_css, 4)
                    except Exception as exc:
                        msg["screenshot_error"] = str(exc)
                        msg.pop("clean_screenshot_saved", None)
                        msg.pop("screenshot_saved", None)
                        # Remove any previous capture too. Left in place, a stale
                        # oversized file stays on disk where something can still
                        # point at it, which is the exact failure being avoided.
                        for stale in ARTIFACTS.glob(f"{stem}*"):
                            try:
                                stale.unlink(missing_ok=True)
                            except Exception:
                                pass
                        print(f"[bridge] screenshot dropped: {exc}")

                self.command_opts.pop(cmd_id, None)
                fut = self.pending.pop(cmd_id)
                if not fut.done():
                    fut.set_result(msg)
        finally:
            self.clients.discard(websocket)
            if authed:
                print(f"[bridge] extension disconnected ({len(self.clients)} client(s))")

    def _convert_image_coords(self, payload):
        """Turn raw x/y read off a screenshot into CSS pixels, in place.

        Agents pick raw coordinates by looking at the screenshot, so that is
        the space they are in. When the viewport is wider than MAX_IMAGE_EDGE
        the image is shrunk and those numbers undershoot - a click aimed at
        the right-hand side of a 1920px page landed about a fifth short.

        coord_space="css" opts out, for callers that took x/y from the element
        list, which is already in CSS pixels. Without a screenshot for this tab
        yet, the scale is taken as 1.
        """
        if payload.get("action") not in ("click", "scroll"):
            return
        if payload.get("x") is None or payload.get("y") is None:
            return
        if str(payload.get("coord_space") or "image").lower() == "css":
            return

        agent = normalise_agent(payload.get("agent_name"))
        tab_id = payload.get("tab_id") or self.last_tab.get(agent)
        scale = self.image_to_css.get((agent, tab_id), 1.0)
        if abs(scale - 1.0) < 1e-3:
            return
        payload["x"] = int(round(float(payload["x"]) * scale))
        payload["y"] = int(round(float(payload["y"]) * scale))
        payload["coords_converted"] = round(scale, 4)

    async def send(self, payload, timeout=COMMAND_TIMEOUT_S):
        if not self.clients:
            return {"status": "error",
                    "error": "extension not connected - load it in Chrome and paste "
                             "the token in its popup"}

        cmd_id = str(uuid.uuid4())
        payload["command_id"] = cmd_id
        payload["eval_allowed"] = ALLOW_EVAL
        self._convert_image_coords(payload)

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
            result = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.pending.pop(cmd_id, None)
            self.command_opts.pop(cmd_id, None)
            return {"status": "error", "error": f"timed out after {timeout}s"}

        # Tell the caller its coordinates were rescaled, so a miss is traceable.
        if "coords_converted" in payload and isinstance(result, dict):
            result["coords_converted"] = payload["coords_converted"]
            result["coords_used"] = [payload["x"], payload["y"]]
        return result


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


def check_image_support():
    """Warn at startup, not mid-task, if screenshots cannot be capped."""
    try:
        from PIL import Image  # noqa: F401
        print(f"[bridge] Pillow present, screenshots capped at {MAX_IMAGE_EDGE}px")
        return True
    except ImportError:
        print("[bridge] WARNING: Pillow is missing. Screenshots cannot be resized "
              f"below {MAX_IMAGE_EDGE}px, so they will be dropped rather than "
              "risk killing the session. Fix with: pip install Pillow")
        return False


def run_server():
    check_image_support()

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
        "assert_text": args.assert_text or None,
        "within": args.within or None,
        "selector": args.selector or None,
        "coord_space": args.coord_space,
        "timeout": args.timeout,
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
                                 "close_tab", "ensure_tab", "reload_extension", "wait_for"])
    parser.add_argument("--url", default="")
    parser.add_argument("--target", default="")
    parser.add_argument("--value", default="", help="option value or text for select_option")
    parser.add_argument("--x", type=int)
    parser.add_argument("--y", type=int)
    parser.add_argument("--text", default="",
                        help="text to type/fill; for click, the visible text of the element "
                             "to click (exact match preferred, ambiguous matches refused)")
    parser.add_argument("--key")
    parser.add_argument("--modifiers", help="comma-separated key modifiers (Control, Shift, Alt, Meta)")
    parser.add_argument("--code")
    parser.add_argument("--enter", action="store_true")
    parser.add_argument("--assert-text", dest="assert_text", default=None,
                        help="abort action if target element's text does not contain this substring")
    parser.add_argument("--within", dest="within", default=None,
                        help="target element must reside inside this container target ID")
    parser.add_argument("--selector", default=None,
                        help="click: CSS selector of the element to click (searches all frames "
                             "and open shadow roots). Combine with --text to narrow it")
    parser.add_argument("--coord-space", dest="coord_space", default=None,
                        choices=["image", "css"],
                        help="click/scroll: --x/--y are screenshot pixels (image, default) or "
                             "page CSS pixels (css, e.g. taken from the element list)")
    parser.add_argument("--timeout", type=int, default=4000,
                        help="timeout in ms for wait_for action (default 4000, max 10000)")
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
