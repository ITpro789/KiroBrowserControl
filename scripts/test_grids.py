"""
Long lists and grids regression test for KiroBrowserControl.

Serves a top page on 127.0.0.1:8791 with 150+ controls, an open overflow menu
and a plain table, embedding a cross-origin frame from localhost:8792 with a
Fluent UI DetailsList style role=grid, an icon-only button, shadow DOM text and
text that appears late - the shapes the Azure portal's blades take.

Checks:
  - get_state offset / match page and filter the list without renumbering it
  - row checkboxes ("Select row") are listed under their row's text
  - assert_text on a row checkbox matches the row's text
  - wait_for finds aria-label, shadow DOM and late text inside the frame

Usage:  python scripts/test_grids.py [Kiro|AG|Claude]

Needs the bridge running and the extension loaded. Uses ports 8791 and 8792.
Opens its own tab and closes it at the end. BRIDGE_TOKEN_FILE overrides the
token path (for running from a worktree).
"""

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOKEN = Path(os.environ.get("BRIDGE_TOKEN_FILE", REPO / ".bridge-token")).read_text(encoding="utf-8").strip()
AGENT = sys.argv[1] if len(sys.argv) > 1 else "Kiro"

sys.path.insert(0, str(REPO / "scripts"))
import mcp_server  # noqa: E402  (for summarise, the text the model reads)

ITEMS = "\n".join(f'<button class="it">Item {i:03d}</button>' for i in range(1, 151))

TOP_HTML = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Grids top</title>
<style>
 body{{font-family:sans-serif;margin:8px;font-size:10px}}
 .it{{font-size:9px;padding:0 2px;margin:1px}}
 [role=menu]{{display:inline-flex;gap:4px;border:1px solid #888;padding:2px}}
 iframe{{border:2px solid #333}}
</style></head><body>
<div>{ITEMS}</div>
<div>
  <button>Delete resource group</button>
  <button aria-expanded="true" aria-haspopup="menu">6 more items</button>
  <div role="menu">
    <div role="menuitem" tabindex="-1" onclick="document.getElementById('st').textContent='move clicked'">Move</div>
    <div role="menuitem" tabindex="-1">Export template</div>
    <div role="menuitem" tabindex="-1">Tags</div>
    <div role="menuitem" tabindex="-1">Lock</div>
    <div role="menuitem" tabindex="-1">Pin to dashboard</div>
    <div role="menuitem" tabindex="-1">Feedback</div>
  </div>
  <span id="st">top idle</span>
</div>
<table>
  <tr><td><input type="checkbox" aria-label="Select row"></td><td>SRV-TABLE-01</td><td>Windows</td></tr>
  <tr><td><input type="checkbox" aria-label="Select row"></td><td>SRV-TABLE-02</td><td>Linux</td></tr>
</table>
<iframe src="http://localhost:8792/frame.html" width="900" height="420"></iframe>
</body></html>"""

ROWS = [("UKCPDC01", "rg-idn-euw-arc"), ("UKCPDC02", "rg-idn-euw-arc"),
        ("UKCPDC03", "rg-idn-uks-arc")] + [(f"UKCPAPP{i:02d}", "rg-app-uks") for i in range(1, 30)]
GRID_ROWS = "\n".join(
    f'<div role="row" class="row" tabindex="{0 if i == 0 else -1}" data-is-focusable="true">'
    f'<div role="gridcell"><div role="checkbox" class="ck" aria-label="Select row" aria-checked="false"></div></div>'
    f'<div role="gridcell">{name}</div><div role="gridcell">Machine - Azure Arc</div>'
    f'<div role="gridcell">{rg}</div></div>'
    for i, (name, rg) in enumerate(ROWS))

FRAME_HTML = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Select resources</title>
<style>
 body{{font-family:sans-serif;margin:6px;font-size:12px}}
 .row{{display:flex;gap:12px;align-items:center;height:22px}}
 .ck{{width:16px;height:16px;border:1px solid #333}}
 .ck[aria-checked=true]{{background:#06c}}
</style></head><body>
<button aria-label="Run query" onclick="0"><svg width="14" height="14"><rect width="14" height="14"/></svg></button>
<button id="deploy">Start deploy</button>
<shadow-status></shadow-status>
<span id="sel">selected: none</span>
<div role="grid" aria-label="Select resources">
  <div role="row" class="row"><div role="columnheader">
    <div role="checkbox" class="ck" aria-label="Toggle selection for all items" aria-checked="false"></div></div>
    <div role="columnheader">Name</div><div role="columnheader">Type</div>
    <div role="columnheader">Resource group</div></div>
  {GRID_ROWS}
</div>
<script>
customElements.define('shadow-status', class extends HTMLElement {{
  connectedCallback() {{
    this.attachShadow({{ mode: 'open' }}).innerHTML = '<span>Shadow status: ready</span>';
  }}
}});
document.querySelectorAll('[role=row] .ck').forEach((ck) => ck.addEventListener('click', () => {{
  ck.setAttribute('aria-checked', ck.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  const names = [...document.querySelectorAll('.ck[aria-checked=true]')]
    .map((c) => c.closest('[role=row]').children[1].innerText);
  document.getElementById('sel').textContent = 'selected: ' + (names.join(', ') || 'none');
}}));
document.getElementById('deploy').onclick = () => setTimeout(() => {{
  const d = document.createElement('div'); d.textContent = 'Deployment succeeded';
  document.body.appendChild(d);
}}, 1500);
</script>
</body></html>"""


def make_handler(body):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            data = body.encode()
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


TAB = {}


def call(**payload):
    payload["agent_name"] = AGENT
    if "id" in TAB:
        payload.setdefault("tab_id", TAB["id"])
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


def element_lines(summary):
    return [ln for ln in summary.splitlines() if ln.startswith("  [")]


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  - {detail}" if detail else ""))


def main():
    top = serve(8791, TOP_HTML)
    frame = serve(8792, FRAME_HTML)
    print(f"agent={AGENT}")
    try:
        r = call(action="new_tab", url="http://127.0.0.1:8791/")
        TAB["id"] = r["tab"]["id"]
        time.sleep(1.0)
        st = call(action="get_state", visual_badges=False)
        els = st.get("elements", [])
        print(f"  elements={len(els)} frames={sorted({e.get('frameId', 0) for e in els})}")

        # 1. offset / match
        full = mcp_server.summarise(st)
        check("list: more than 120 elements", len(els) > 120, f"{len(els)}")
        check("list: overflow line names the next offset", "pass offset=120" in full)
        move = find(st, "Move")
        check("list: Move is past the first 120", move and els.index(move) >= 120,
              f"index={els.index(move) if move else None}")
        check("list: Move not printed by default", '"Move"' not in full)
        paged = mcp_server.summarise(st, offset=120)
        first = element_lines(paged)[0] if element_lines(paged) else ""
        check("offset: starts at element 121, numbers unchanged",
              first.startswith(f"  [{els[120]['id']}]"), first[:60])
        check("offset: Move reachable", move and f'[{move["id"]}] div (menuitem) "Move"' in paged)
        only = element_lines(mcp_server.summarise(st, match="move"))
        check("match: only the Move item", len(only) == 1 and f'[{move["id"]}]' in only[0],
              only[0][:60] if only else "none")
        check("match: no hits says so", element_lines(mcp_server.summarise(st, match="zzz")) == [])

        # 2. row checkboxes carry their row's text
        ck = find(st, "UKCPDC02")
        want = "Select row: UKCPDC02 Machine - Azure Arc rg-idn-euw-arc"
        check("grid: row checkbox labelled with row text", ck and ck.get("text") == want,
              (ck or {}).get("text"))
        check("grid: checkbox is in the frame", ck and ck.get("frameId", 0) != 0)
        hdr = find(st, "Toggle selection for all items")
        check("grid: header checkbox gets column names",
              hdr and "Name Type Resource group" in hdr.get("text", ""), (hdr or {}).get("text"))
        tbl = find(st, "SRV-TABLE-02")
        check("table: <tr> checkbox labelled with row text",
              tbl and tbl.get("text") == "Select row: SRV-TABLE-02 Linux", (tbl or {}).get("text"))
        hits = element_lines(mcp_server.summarise(st, match="UKCPDC02"))
        check("match: server name finds its checkbox", any("(checkbox)" in h for h in hits),
              hits[0][:90] if hits else "none")

        # 3. assert_text sees the row text
        if ck:
            r = call(action="click", target=str(ck["id"]), assert_text="UKCPDC02")
            st = call(action="get_state", visual_badges=False)
            ck = find(st, "UKCPDC02")
            check("click: row checkbox by number with assert_text row name",
                  r.get("status") == "ok" and ck and ck.get("checked") is True, r.get("error", ""))
            other = find(st, "UKCPDC03")
            r = call(action="click", target=str(other["id"]), assert_text="UKCPDC09")
            check("click: assert_text for another row is refused",
                  r.get("status") == "error" and "assert_text failed" in r.get("error", ""),
                  r.get("error", "")[:80])
        else:
            check("click: row checkbox by number with assert_text row name", False, "no row label")

        # 4. wait_for inside the cross-origin frame
        for text in ("Run query", "Shadow status: ready", "Machine -   Azure Arc"):
            r = call(action="wait_for", text=text, timeout=3000)
            check(f"wait_for: {text!r}", r.get("status") == "ok", r.get("error", ""))
        dep = find(st, "Start deploy")
        call(action="click", target=str(dep["id"]))
        t0 = time.time()
        r = call(action="wait_for", text="Deployment succeeded", timeout=5000)
        check("wait_for: text that appears late", r.get("status") == "ok",
              r.get("error", "") or f"{time.time() - t0:.1f}s")
        r = call(action="wait_for", text="no such text anywhere", timeout=1000)
        check("wait_for: missing text still times out",
              r.get("status") == "error" and "timed out" in r.get("error", ""))
    finally:
        if "id" in TAB:
            try:
                call(action="close_tab")
            except Exception:
                pass
        top.shutdown()
        frame.shutdown()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
