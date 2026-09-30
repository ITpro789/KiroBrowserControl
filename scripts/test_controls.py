"""
Custom form controls, click-by-text/selector, and screenshot coordinate scaling.

Covers what the badge scan used to miss: Google ACX material-radio groups (the
Play Console's questionnaires), Angular Material mat-radio-button with a
visually-hidden native input, a hidden checkbox behind a <label for>, a hidden
checkbox with no stand-in at all, role="switch", and a button inside an open
shadow root. Also click-by-text inside a cross-origin frame.

Usage:  python scripts/test_controls.py [Kiro|AG]

Needs the bridge running and the extension loaded. Uses ports 8784 and 8785.
"""

import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
TOKEN = (REPO / ".bridge-token").read_text(encoding="utf-8").strip()
AGENT = sys.argv[1] if len(sys.argv) > 1 else "Kiro"

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Controls</title>
<style>
  body { font-family: sans-serif; margin: 20px; }
  material-radio { display: block; padding: 6px; cursor: pointer; }
  material-radio[aria-checked="true"]::before { content: "(o) "; }
  material-radio[aria-checked="false"]::before { content: "( ) "; }
  .vh { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
  mat-radio-button { display: block; margin: 6px 0; }
  .sw { display: inline-block; padding: 4px 10px; border: 1px solid #666; }
</style></head><body>
<h2>Does your app contain ads?</h2>
<div role="radiogroup" tabindex="0" aria-label="Ads question">
  <material-radio role="radio" tabindex="0" aria-checked="false" value="yes">
    <div class="content">Yes, my app contains ads</div></material-radio>
  <material-radio role="radio" tabindex="0" aria-checked="false" value="no">
    <div class="content">No, my app does not contain ads</div></material-radio>
</div>

<mat-radio-button class="mat-radio-button">
  <label class="mat-radio-label" for="matA">
    <input type="radio" id="matA" name="mat" value="a" class="vh">
    <span class="mat-radio-label-content">Option Alpha</span>
  </label>
</mat-radio-button>

<p><input type="checkbox" id="terms" class="vh"><label for="terms">Accept the terms</label></p>
<p><input type="checkbox" id="orphan" class="vh" aria-label="Orphan toggle"></p>
<p><span class="sw" role="switch" tabindex="0" aria-checked="false" id="sw">Dark mode</span></p>
<p><shadow-card></shadow-card></p>
<p id="status">status: idle</p>
<iframe src="http://localhost:8785/frame.html" width="420" height="120"></iframe>

<script>
  const status = (t) => { document.getElementById('status').textContent = 'status: ' + t; };
  document.querySelectorAll('material-radio').forEach((r) => r.addEventListener('click', () => {
    document.querySelectorAll('material-radio').forEach((o) => o.setAttribute('aria-checked', 'false'));
    r.setAttribute('aria-checked', 'true');
    status('ads=' + r.getAttribute('value'));
  }));
  document.getElementById('matA').addEventListener('change', () => status('mat=a'));
  document.getElementById('terms').addEventListener('change', (e) => status('terms=' + e.target.checked));
  document.getElementById('orphan').addEventListener('change', (e) => status('orphan=' + e.target.checked));
  const sw = document.getElementById('sw');
  sw.addEventListener('click', () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    status('switch=' + on);
  });
  customElements.define('shadow-card', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="inner">Shadow Save</button>';
      root.getElementById('inner').addEventListener('click', () => status('shadow saved'));
    }
  });
</script></body></html>
"""

FRAME = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>f</title>
<style>material-radio{display:block;padding:6px}</style></head><body>
<material-radio role="radio" tabindex="0" aria-checked="false" value="f">Frame Radio Choice</material-radio>
<p id="fs">frame: idle</p>
<script>
  const r = document.querySelector('material-radio');
  r.addEventListener('click', () => { r.setAttribute('aria-checked', 'true');
    document.getElementById('fs').textContent = 'frame: picked'; });
</script></body></html>"""


def serve(port, body):
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

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def call(**payload):
    payload["agent_name"] = AGENT
    req = urllib.request.Request(
        "http://127.0.0.1:8765/execute", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Bridge-Token": TOKEN}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def find(res, text, **kw):
    for e in res.get("elements", []):
        if text.lower() in (e.get("text") or "").lower() and all(e.get(k) == v for k, v in kw.items()):
            return e
    return None


def status():
    c = call(action="read_content").get("content") or ""
    i = c.find("status:")
    return c[i:i + 40] if i >= 0 else ""


results = []


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  - {detail}" if detail else ""))


def coord_unit_tests():
    """The conversion itself, without depending on the window being wide."""
    import bridge_server as bs
    b = bs.Bridge()
    b.image_to_css[("Kiro", 7)] = 1.28
    b.last_tab["Kiro"] = 7

    p = {"action": "click", "agent_name": "Kiro", "x": 1000, "y": 500}
    b._convert_image_coords(p)
    check("coords: image px scaled to page px", (p["x"], p["y"]) == (1280, 640), f"{p['x']},{p['y']}")

    p = {"action": "click", "agent_name": "Kiro", "x": 1000, "y": 500, "coord_space": "css"}
    b._convert_image_coords(p)
    check("coords: coord_space=css left alone", (p["x"], p["y"]) == (1000, 500))

    p = {"action": "click", "agent_name": "AG", "x": 1000, "y": 500}
    b._convert_image_coords(p)
    check("coords: other agent's scale not applied", (p["x"], p["y"]) == (1000, 500))

    p = {"action": "click", "agent_name": "Kiro", "target": "3"}
    b._convert_image_coords(p)
    check("coords: numbered click untouched", "x" not in p)


def main():
    print(f"agent={AGENT}")
    coord_unit_tests()

    top = serve(8784, PAGE)
    frame = serve(8785, FRAME)
    try:
        call(action="navigate", url="http://127.0.0.1:8784/")
        time.sleep(0.8)
        st = call(action="get_state")
        els = st.get("elements", [])

        yes = find(st, "Yes, my app contains ads")
        no = find(st, "No, my app does not contain ads")
        alpha = [e for e in els if "Option Alpha" in (e.get("text") or "")]
        terms = find(st, "Accept the terms")
        orphan = find(st, "Orphan toggle")
        sw = find(st, "Dark mode")
        shadow = find(st, "Shadow Save")
        framed = find(st, "Frame Radio Choice")

        check("scan: material-radio indexed", bool(yes and no),
              f"yes={yes and yes['tag']} checked={yes and yes.get('checked')}")
        check("scan: radio reports checked state", yes is not None and yes.get("checked") is False)
        check("scan: mat-radio-button badged once, not per nested wrapper", len(alpha) == 1,
              f"{len(alpha)} entries: {[a['tag'] for a in alpha]}")
        check("scan: label for a hidden checkbox indexed with its state",
              bool(terms) and terms.get("checked") is False, terms and terms["tag"])
        check("scan: hidden checkbox with no stand-in kept, clicked by script",
              bool(orphan) and orphan.get("click_via") == "script")
        check("scan: role=switch indexed", bool(sw) and sw.get("checked") is False)
        check("scan: button in open shadow root indexed", bool(shadow) and shadow.get("shadow") is True)
        check("scan: material-radio in cross-origin frame indexed", bool(framed) and framed.get("frameId"))

        r = call(action="click", target=str(no["id"]), assert_text="does not contain")
        check("click number on material-radio (+live assert)", "ads=no" in status(), r.get("error", ""))

        st = call(action="get_state")
        check("state: checked flips after click", (find(st, "No, my app does not") or {}).get("checked") is True)

        r = call(action="click", text="Yes, my app contains ads")
        act = r.get("action_result") or {}
        check("click by text", "ads=yes" in status() and act.get("method") == "mouse",
              r.get("error", "") or str(act))

        r = call(action="click", text="my app")
        check("click by text refuses an ambiguous match",
              r.get("status") != "ok" and "2 elements match" in (r.get("error") or ""), r.get("error", ""))

        call(action="click", target=str(find(call(action="get_state"), "No, my app")["id"]))
        r = call(action="click", selector="material-radio[value='yes']")
        check("click by selector", "ads=yes" in status(), r.get("error", ""))

        r = call(action="click", selector="material-radio")
        check("click by selector refuses several visible matches",
              r.get("status") != "ok" and "match" in (r.get("error") or ""), r.get("error", ""))

        r = call(action="click", selector="nope-not-here")
        check("click by selector reports no match", r.get("status") != "ok", r.get("error", ""))

        r = call(action="click", text="Option Alpha")
        check("click by text on mat-radio-button with hidden input", "mat=a" in status(),
              r.get("error", ""))

        r = call(action="click", text="Accept the terms")
        check("click label toggles hidden checkbox", "terms=true" in status(), r.get("error", ""))

        st = call(action="get_state")
        orphan = find(st, "Orphan toggle")
        r = call(action="click", target=str(orphan["id"]))
        check("click hidden checkbox with no stand-in (script)",
              "orphan=true" in status() and (r.get("action_result") or {}).get("method") == "script",
              r.get("error", ""))

        r = call(action="click", text="Dark mode")
        check("click role=switch by text", "switch=true" in status(), r.get("error", ""))

        st = call(action="get_state")
        shadow = find(st, "Shadow Save")
        r = call(action="click", target=str(shadow["id"]), assert_text="Shadow Save")
        check("click in shadow root with live assert (hit-test inside shadow)",
              "shadow saved" in status(), r.get("error", ""))

        r = call(action="click", text="Frame Radio Choice")
        c = call(action="read_content").get("content") or ""
        check("click by text inside cross-origin frame", "frame: picked" in c,
              r.get("error", "") or str(r.get("action_result")))

        st = call(action="get_state")
        vp = st.get("viewport") or {}
        print(f"  info  viewport={vp.get('width')}x{vp.get('height')} dpr={vp.get('dpr')}")
    finally:
        top.shutdown()
        frame.shutdown()

    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
