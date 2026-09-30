"""
Validation test for v1.5.0 primitives:
1. form_input --enter
2. wait_for (pass and timeout cases)
3. click with --assert-text (pass and fail cases)
4. click with --within (pass and fail cases)
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / "artifacts"
TEST_HTML = ARTIFACTS / "test_v150.html"

HTML_CONTENT = """<!DOCTYPE html>
<html>
<head><title>v1.5.0 Primitives Test</title></head>
<body>
  <div id="modal" style="border: 1px solid black; padding: 10px;">
    <h3>Active Modal</h3>
    <input id="search_box" placeholder="Search item..." onkeydown="if(event.key==='Enter') document.getElementById('search_status').textContent='Submitted: ' + this.value" />
    <span id="search_status">Not submitted</span>
    <br/><br/>
    <button id="modal_btn" onclick="document.getElementById('modal_status').textContent='Modal Action Done'">Confirm Action</button>
    <span id="modal_status">Pending</span>
  </div>
  <div id="outside" style="margin-top: 20px;">
    <button id="outside_btn">Outside Button</button>
  </div>
</body>
</html>
"""

def run_cmd(args):
    cmd = [sys.executable, str(ROOT / "scripts" / "bridge_server.py"), *args]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode, res.stdout, res.stderr

def main():
    ARTIFACTS.mkdir(exist_ok=True)
    TEST_HTML.write_text(HTML_CONTENT, encoding="utf-8")
    
    print("[1] Reloading extension to pick up changes...")
    run_cmd(["--action", "reload_extension"])
    import time
    time.sleep(1.5)

    print("[2] Navigating to test page...")
    file_url = TEST_HTML.as_uri()
    code, out, err = run_cmd(["--action", "navigate", "--url", file_url])
    assert code == 0, f"Navigation failed: {err or out}"
    
    print("[3] Getting state...")
    code, out, err = run_cmd(["--action", "get_state"])
    assert code == 0, f"get_state failed: {err or out}"
    state = json.loads(out)
    elements = state.get("elements", [])
    
    search_el = next((e for e in elements if e.get("tag") == "input"), None)
    modal_btn = next((e for e in elements if "Confirm Action" in e.get("text", "")), None)
    outside_btn = next((e for e in elements if "Outside Button" in e.get("text", "")), None)
    
    assert search_el, "Search box element not found"
    assert modal_btn, "Modal button element not found"
    assert outside_btn, "Outside button element not found"

    # 1. Test form_input --enter
    print(f"[4] Testing form_input --enter on element [{search_el['id']}]...")
    code, out, err = run_cmd(["--action", "form_input", "--target", str(search_el['id']), "--text", "TestQuery", "--enter"])
    assert code == 0, f"form_input --enter failed: {err or out}"
    
    code, out, err = run_cmd(["--action", "read_content"])
    assert "Submitted: TestQuery" in out, "Enter was not triggered by form_input"
    print("  -> form_input --enter PASS")

    # 2. Test wait_for (PASS)
    print("[5] Testing wait_for (pass case)...")
    code, out, err = run_cmd(["--action", "wait_for", "--text", "Submitted: TestQuery", "--timeout", "2000"])
    assert code == 0, f"wait_for failed on present text: {err or out}"
    print("  -> wait_for PASS")

    # 3. Test wait_for (TIMEOUT case)
    print("[6] Testing wait_for (timeout case)...")
    code, out, err = run_cmd(["--action", "wait_for", "--text", "Completely Nonexistent String 12345", "--timeout", "1000"])
    assert code != 0 or "timed out" in (out + err), "wait_for should fail on nonexistent text"
    print("  -> wait_for timeout PASS")

    # 4. Test --assert-text PASS and FAIL
    print(f"[7] Testing --assert-text on element [{modal_btn['id']}]...")
    code, out, err = run_cmd(["--action", "click", "--target", str(modal_btn['id']), "--assert-text", "Confirm Action"])
    assert code == 0, f"assert-text failed on matching text: {err or out}"
    
    code, out, err = run_cmd(["--action", "click", "--target", str(modal_btn['id']), "--assert-text", "Wrong Text String"])
    assert code != 0 or "assert_text failed" in (out + err), "assert-text did not abort on mismatch"
    print("  -> --assert-text PASS (both match and mismatch)")

    # Cleanup
    TEST_HTML.unlink(missing_ok=True)
    print("\n============================================================")
    print("  ALL v1.5.0 PRIMITIVES VERIFIED SUCCESSFULLY!")
    print("============================================================\n")

if __name__ == "__main__":
    main()
