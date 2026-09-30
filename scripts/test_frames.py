"""
Cross-origin iframe (OOPIF) regression test for KiroBrowserControl.

Serves a top page on 127.0.0.1:8781 embedding a frame from localhost:8782.
127.0.0.1 and localhost are different sites, so Chrome's site isolation puts
the frame in a separate process - a genuine OOPIF, like the Azure portal.

Usage:  python scripts/test_frames.py [Kiro|AG] [--spoof]

--spoof adds a hostile page that forges frame positions every 5ms. Clicks must
still land in the right place. Before the frame-offset handshake was locked
down, that page shifted every click by 400px, including in the top frame.

Needs the bridge running and the extension loaded. Uses ports 8781 and 8782.
"""

import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOKEN = (REPO / ".bridge-token").read_text(encoding="utf-8").strip()
AGENT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "Kiro"
SPOOF = "--spoof" in sys.argv

TOP_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OOPIF top</title>
<style>body{font-family:sans-serif;margin:20px} iframe{border:2px solid #333}</style>
</head><body>
<h1>Top page</h1>
<button id="top_btn" onclick="document.getElementById('top_status').textContent='top clicked'">Top Button</button>
<span id="top_status">top idle</span>
<p>
  <button id="save_btn">Save draft</button>
  <button id="mutate_btn" onclick="setTimeout(()=>{document.getElementById('save_btn').textContent='Delete everything'},3000)">Mutate later</button>
</p>
<div style="margin-left:140px">
  <iframe id="inner" src="http://localhost:8782/frame.html" width="620" height="420"></iframe>
</div>
<div style="height:2400px"></div>
<button id="far_btn">Far Button</button>
__SPOOF__
</body></html>
"""

SPOOF_JS = """<script>
// Hostile page: keep telling every frame, including itself, that it sits
// 400px away from where it really is.
setInterval(() => {
  const msg = { type: '__kiro_frame_pos', x: 400, y: 400 };
  window.postMessage(msg, '*');
  const f = document.getElementById('inner');
  if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*');
}, 5);
</script>"""

FRAME_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OOPIF frame</title>
<style>body{font-family:sans-serif;margin:10px} #box{border:1px dashed #999;padding:8px;margin-top:8px}</style>
</head><body>
<h2>Inner frame content</h2>
<input id="q" placeholder="Search inside frame"
  oninput="document.getElementById('echo').textContent='echo: '+this.value"
  onkeydown="if(event.key==='Enter')document.getElementById('submitted').textContent='submitted: '+this.value">
<span id="echo">echo: </span> <span id="submitted">submitted: none</span>
<p><button id="inner_btn" onclick="document.getElementById('inner_status').textContent='inner clicked'">Inner Button</button>
<span id="inner_status">inner idle</span></p>
<div id="box" tabindex="0" aria-label="Boxed container">
  <button id="boxed" onclick="document.getElementById('box_status').textContent='boxed clicked'">Boxed Button</button>
</div>
<button id="unboxed">Unboxed Button</button>
<span id="box_status">box idle</span>
<p>Frame marker text: zebra-quartz-7731</p>
<div id="list" style="height:70px;overflow:auto;border:1px solid #ccc;width:300px">
__LIST__
</div>
</body></html>
""".replace("__LIST__", "\n".join(
    f'<button style="display:block">List Item {i}</button>' for i in range(1, 31)))


def make_handler(body):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass
    return H


def serve(port, body):
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(body))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def call(**payload):
    payload["agent_name"] = AGENT
    req = urllib.request.Request(
        "http://127.0.0.1:8765/execute",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Bridge-Token": TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def find(res, text, tag=None):
    for e in res.get("elements", []):
        if text.lower() in (e.get("text") or "").lower() and (tag is None or e.get("tag") == tag):
            return e
    return None


def page_text():
    r = call(action="read_content")
    return (r.get("content") or "")


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  - {detail}" if detail else ""))


def main():
    top = serve(8781, TOP_HTML.replace("__SPOOF__", SPOOF_JS if SPOOF else ""))
    frame = serve(8782, FRAME_HTML)
    print(f"agent={AGENT} spoof={SPOOF}")

    try:
        call(action="navigate", url="http://127.0.0.1:8781/top.html")
        time.sleep(1.0)
        st = call(action="get_state")
        # If the user has brought the agent tab forward themselves, that is not
        # something this run did, and the focus check at the end is skipped.
        started_in_front = st["tab"].get("active") is True

        els = st.get("elements", [])
        frames = sorted({e.get("frameId", 0) for e in els})
        print(f"  elements={len(els)} frames={frames} mode={st.get('screenshot_mode')}")

        top_btn = find(st, "Top Button")
        inner_btn = find(st, "Inner Button")
        q = find(st, "Search inside frame", "input")
        boxed = find(st, "Boxed Button")
        unboxed = find(st, "Unboxed Button")
        box = find(st, "Boxed container")

        check("scan: top-frame button found", bool(top_btn))
        check("scan: button inside cross-origin frame found", bool(inner_btn),
              f"frameId={inner_btn.get('frameId') if inner_btn else None}")
        check("scan: input inside cross-origin frame found", bool(q))
        if not (top_btn and inner_btn and q):
            return

        # Coordinates of a frame element must land inside the iframe's real box.
        # The iframe starts ~160px from the left of the page.
        check("coords: inner button x is offset into the frame",
              inner_btn["x"] > 170, f"x={inner_btn['x']} y={inner_btn['y']}")

        r = call(action="click", target=str(top_btn["id"]))
        check("click: top button", "top clicked" in page_text())

        r = call(action="click", target=str(inner_btn["id"]))
        check("click: button inside cross-origin frame", "inner clicked" in page_text(),
              r.get("error", ""))

        st = call(action="get_state")
        q = find(st, "Search inside frame", "input")
        r = call(action="form_input", target=str(q["id"]), text="alpha")
        check("form_input: into cross-origin frame", "echo: alpha" in page_text(),
              r.get("error", ""))

        st = call(action="get_state")
        q = find(st, "alpha", "input") or find(st, "Search inside frame", "input")
        r = call(action="form_input", target=str(q["id"]), text="bravo", enter=True)
        check("form_input --enter: submits inside frame", "submitted: bravo" in page_text(),
              r.get("error", ""))

        # The crux: CDP key/insertText dispatched on the top-level session.
        st = call(action="get_state")
        q = find(st, "bravo", "input") or find(st, "Search inside frame", "input")
        call(action="click", target=str(q["id"]))
        call(action="form_input", target=str(q["id"]), text="")
        st = call(action="get_state")
        q = find(st, "Search inside frame", "input")
        call(action="click", target=str(q["id"]))
        r = call(action="type", text="charlie")
        txt = page_text()
        check("type: keystrokes reach focused input in cross-origin frame",
              "echo: charlie" in txt, r.get("error", "") or txt[txt.find('echo'):txt.find('echo') + 30])

        r = call(action="key", key="Enter")
        check("key Enter: reaches cross-origin frame", "submitted: charlie" in page_text(),
              r.get("error", ""))

        r = call(action="wait_for", text="zebra-quartz-7731", timeout=3000)
        check("wait_for: finds text inside frame", r.get("status") == "ok", r.get("error", ""))

        r = call(action="wait_for", text="text that never appears 991", timeout=800)
        check("wait_for: times out on missing text",
              r.get("status") != "ok" and "timed out" in (r.get("error") or ""), r.get("error", ""))

        check("read_content: includes frame text", "zebra-quartz-7731" in page_text())

        st = call(action="get_state")
        inner_btn = find(st, "Inner Button")
        r = call(action="click", target=str(inner_btn["id"]), assert_text="Inner Button")
        check("assert_text: passes on match", r.get("status") == "ok", r.get("error", ""))

        r = call(action="click", target=str(inner_btn["id"]), assert_text="Nope Wrong")
        check("assert_text: aborts on mismatch", r.get("status") != "ok", r.get("error", ""))

        # Live check: DOM changes AFTER the last get_state. The cached label is
        # "Save draft", the live one becomes "Delete everything".
        st = call(action="get_state")
        mutate = find(st, "Mutate later")
        call(action="click", target=str(mutate["id"]))
        st = call(action="get_state")
        save = find(st, "Save draft")
        # Hidden tabs run timers on 1s wake-ups, so a fixed sleep races the
        # page. Wait for the change instead - the element list is now stale.
        call(action="wait_for", text="Delete everything", timeout=8000)
        r = call(action="click", target=str(save["id"]), assert_text="Save draft") if save else {}
        check("assert_text: catches label change since last get_state",
              bool(save) and r.get("status") != "ok", r.get("error", "") or "click went through")

        st = call(action="get_state")
        boxed = find(st, "Boxed Button")
        unboxed = find(st, "Unboxed Button")
        box = find(st, "Boxed container")
        top_btn = find(st, "Top Button")
        if boxed and unboxed and box:
            r = call(action="click", target=str(boxed["id"]), within=str(box["id"]))
            check("within: passes when contained", r.get("status") == "ok", r.get("error", ""))
            r = call(action="click", target=str(unboxed["id"]), within=str(box["id"]))
            check("within: aborts when not contained", r.get("status") != "ok", r.get("error", ""))
            r = call(action="click", target=str(top_btn["id"]), within=str(box["id"]))
            check("within: aborts when container is in another frame",
                  r.get("status") != "ok", r.get("error", "") or "click went through")
        else:
            check("within: container indexed", False, "box/boxed/unboxed not found")

        # ---- scroll -------------------------------------------------------
        # Anchors are frame elements, which are listed even when offscreen, so
        # their y tracks both page and panel scrolling.
        st = call(action="get_state")
        inner0 = find(st, "Inner Button")
        item1 = find(st, "List Item 1")

        # A: wheel over the left margin, outside the iframe: the page scrolls.
        call(action="scroll", direction="down", amount=300, x=40, y=300)
        st = call(action="get_state")
        inner1 = find(st, "Inner Button")
        moved = inner0["y"] - inner1["y"]
        check("scroll: page scrolls from a point outside the frame", 200 <= moved <= 400,
              f"inner button moved {moved}px")
        call(action="scroll", direction="up", amount=300, x=40, y=300)

        # B: wheel over the list inside the cross-origin frame: only the list
        # scrolls, the page stays put.
        st = call(action="get_state")
        inner0 = find(st, "Inner Button")
        item1 = find(st, "List Item 1")
        call(action="scroll", direction="down", amount=120, x=item1["x"], y=item1["y"])
        st = call(action="get_state")
        inner1 = find(st, "Inner Button")
        item1b = find(st, "List Item 1")
        page_moved = abs(inner0["y"] - inner1["y"])
        list_moved = item1["y"] - item1b["y"]
        check("scroll: inner panel in cross-origin frame scrolls on its own",
              list_moved >= 60 and page_moved <= 5,
              f"list moved {list_moved}px, page moved {page_moved}px")

        # C: scroll a specific element into view.
        st = call(action="get_state")
        last = find(st, "List Item 30")
        before = last["y"]
        r = call(action="scroll", target=str(last["id"]))
        st = call(action="get_state")
        last2 = find(st, "List Item 30")
        check("scroll: target element brought into view", r.get("status") == "ok"
              and last2 and last2["y"] < before, r.get("error", "") or f"y {before} -> {last2 and last2['y']}")

        st = call(action="get_state")
        if started_in_front:
            print("  info  agent tab was already in front when the run started "
                  "(brought forward by the user) - focus check skipped")
        else:
            check("background: agent tab stayed unfocused", st["tab"].get("active") is False,
                  f"active={st['tab'].get('active')}")
    finally:
        top.shutdown()
        frame.shutdown()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
