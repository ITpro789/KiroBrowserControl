"""
Antigravity CLI shim for the shared browser bridge.

This used to be a full second implementation of the bridge daemon. That was a
problem for two reasons:

  1. Its --server path called free_port(), which taskkills whatever holds 8765
     and 8766. If it ever ran while the real bridge was restarting, this stale
     copy took over the ports, and both agents silently lost every fix made in
     the canonical repo - dialog handling, per-agent tab groups, the lot.
  2. Its --action list was a separate copy, so new actions worked for Kiro and
     failed for Antigravity with an argparse error.

So it is now a thin translator onto the canonical script. One implementation,
one action list, both agents.

The original is kept alongside as bridge_server.py.fork-backup.
"""

import base64
import os
import subprocess
import sys
from pathlib import Path

# install.ps1 rewrites the placeholder below with the repo's real location when it
# deploys this file, because the deployed copy lives under ~/.gemini and cannot
# find the repo relative to itself. BRIDGE_CANONICAL_PATH overrides it, which is
# also the escape hatch if the repo is moved after installing.
# Built by concatenation on purpose: the installer does a plain string replace on
# this file, so spelling the token out here would rewrite the check below too -
# and a Windows path in a non-raw literal breaks on \U and \D escapes.
_PLACEHOLDER = "__CANONICAL" + "_BRIDGE_PATH__"

CANONICAL = Path(
    os.environ.get("BRIDGE_CANONICAL_PATH")
    or r"__CANONICAL_BRIDGE_PATH__"
)

# Flags whose names differ between the old Antigravity CLI and the canonical one.
RENAMED = {
    "--option": "--value",       # select_option's argument
}

# Flags the old CLI accepted that the canonical script does not.
DROPPED = {"--code-b64"}


def translate(argv):
    """Map the old Antigravity flag set onto the canonical script's flags."""
    out = []
    i = 0
    while i < len(argv):
        arg = argv[i]

        # --code-b64 <b64> becomes --code <plain>
        if arg == "--code-b64":
            if i + 1 < len(argv):
                try:
                    out += ["--code", base64.b64decode(argv[i + 1]).decode("utf-8")]
                except Exception:
                    sys.exit("bridge_server shim: --code-b64 is not valid base64")
                i += 2
                continue
            i += 1
            continue

        if arg.startswith("--code-b64="):
            try:
                out += ["--code", base64.b64decode(arg.split("=", 1)[1]).decode("utf-8")]
            except Exception:
                sys.exit("bridge_server shim: --code-b64 is not valid base64")
            i += 1
            continue

        name, sep, value = arg.partition("=")
        if name in RENAMED:
            out.append(RENAMED[name] + sep + value if sep else RENAMED[name])
            i += 1
            continue
        if name in DROPPED:
            i += 2 if not sep else 1
            continue

        out.append(arg)
        i += 1
    return out


def main():
    argv = sys.argv[1:]

    if str(CANONICAL) == _PLACEHOLDER:
        sys.exit(
            "bridge_server shim: path not configured. Re-run install.ps1 from the "
            "KiroBrowserControl repo, or set BRIDGE_CANONICAL_PATH to its "
            "scripts/bridge_server.py"
        )

    if not CANONICAL.exists():
        sys.exit(
            f"bridge_server shim: canonical script not found at {CANONICAL}. "
            "If the repo moved, re-run install.ps1 or set BRIDGE_CANONICAL_PATH."
        )

    # Never start a daemon from here. The KiroBrowserBridge scheduled task owns
    # the ports; starting another would kill the running one.
    if "--server" in argv:
        print("The bridge daemon is managed by the KiroBrowserBridge scheduled task.")
        print("Check it:   Get-ScheduledTask -TaskName KiroBrowserBridge | "
              "Select-Object State")
        print("Start it:   Start-ScheduledTask -TaskName KiroBrowserBridge")
        return 0

    args = translate(argv)

    # Identify as Antigravity unless the caller already said otherwise, so this
    # agent gets its own tab and its own tab group.
    if not any(a in ("--client", "--agent-name") or a.startswith(("--client=", "--agent-name="))
               for a in args):
        args += ["--client", "AG"]

    env = dict(os.environ)
    env.setdefault("BRIDGE_CLIENT_NAME", "AG")

    return subprocess.call([sys.executable, str(CANONICAL), *args], env=env)


if __name__ == "__main__":
    sys.exit(main())
