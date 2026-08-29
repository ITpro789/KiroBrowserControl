"""
Verifies the bridge rejects the attacks the original design was open to.

Run the server in another terminal first:
    python scripts/bridge_server.py --server

Then:
    python scripts/test_security.py
"""

import asyncio
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import websockets

WS_URL = "ws://127.0.0.1:8766"
HTTP_URL = "http://127.0.0.1:8765"
TOKEN_FILE = Path(__file__).resolve().parent.parent / ".bridge-token"

results = []


def record(name, passed, detail=""):
    results.append((name, passed, detail))
    print(f"  {'PASS' if passed else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


async def ws_attempt(origin, token, label, expect_reject):
    """Try to connect and issue a command. expect_reject=True means it must fail."""
    headers = {"Origin": origin} if origin else {}
    try:
        async with websockets.connect(
            WS_URL, additional_headers=headers, open_timeout=5, close_timeout=2
        ) as sock:
            if token is not None:
                await sock.send(json.dumps({"type": "auth", "token": token}))
            else:
                await sock.send(json.dumps({"type": "ping"}))

            reply = await asyncio.wait_for(sock.recv(), timeout=5)
            data = json.loads(reply)

            accepted = data.get("type") == "auth_ok"
            record(label, accepted is not expect_reject,
                   f"server said {data.get('type')}")
            return
    except Exception as exc:
        kind = type(exc).__name__
        record(label, expect_reject, f"connection refused ({kind})")


def http_attempt(headers, label, expect_reject):
    req = urllib.request.Request(
        f"{HTTP_URL}/execute",
        data=json.dumps({"action": "get_state"}).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            code = resp.status
        record(label, not expect_reject, f"HTTP {code}")
    except urllib.error.HTTPError as exc:
        record(label, expect_reject, f"HTTP {exc.code}")
    except urllib.error.URLError as exc:
        record(label, False, f"bridge unreachable: {exc.reason} - is it running?")


async def main():
    if not TOKEN_FILE.exists():
        sys.exit("No .bridge-token. Run bridge_server.py --server once first.")
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()

    print("\nWebSocket origin and token enforcement")
    print("-" * 60)
    # The original design's core flaw: any web page could drive the browser.
    await ws_attempt("https://evil.example", token, "web page origin is rejected", True)
    await ws_attempt("https://portal.azure.com", token, "even a trusted-looking site is rejected", True)
    await ws_attempt(None, token, "missing Origin is rejected", True)
    await ws_attempt("chrome-extension://aaaabbbbccccdddd", "wrong-token",
                     "extension origin with bad token is rejected", True)
    await ws_attempt("chrome-extension://aaaabbbbccccdddd", None,
                     "command before auth is rejected", True)
    await ws_attempt("chrome-extension://aaaabbbbccccdddd", token,
                     "extension origin with valid token is accepted", False)

    print("\nHTTP token enforcement")
    print("-" * 60)
    http_attempt({"Content-Type": "application/json"},
                 "no token is rejected", True)
    http_attempt({"Content-Type": "application/json", "X-Bridge-Token": "wrong"},
                 "wrong token is rejected", True)

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"  {passed}/{total} checks passed")
    print("=" * 60)
    if passed != total:
        print("\n  Failures above mean the bridge is NOT safe to run against")
        print("  a browser holding sessions you care about.\n")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
