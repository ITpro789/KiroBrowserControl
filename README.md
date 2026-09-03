# Kiro Browser Control

Gives the [Kiro](https://kiro.dev) agent control of your **real, logged-in Chrome** —
navigate, click, fill forms, read pages, screenshot — through MCP tools.

No separate profile. No logging back in. It drives the browser you already use.

---

## Quick start

```powershell
git clone https://github.com/ITpro789/KiroBrowserControl.git
cd KiroBrowserControl
.\install.ps1
```

Then the one thing a script cannot do:

1. `chrome://extensions`
2. **Developer mode** on (top right)
3. **Load unpacked** → select the `extension` folder (the installer copies the path to your clipboard)

Start a new Kiro chat and ask *"what tabs do I have open?"*

---

## If you are Kiro reading this

You have been pointed at this repo to set up browser control. Do this:

1. Run `.\install.ps1` from the repo root. It is idempotent.
2. Report the manual step to the user: load `extension\` unpacked at `chrome://extensions`.
3. Tell them to start a **new** chat session — MCP servers and skills are discovered at session start.
4. Verify with `browser_list_tabs`. If it returns `extension not connected`, the extension is not loaded or needs a reload.

Do not paste tokens anywhere. `install.ps1` embeds the secret in `extension/token.json` and the extension pairs itself.

---

## What install.ps1 does

| Step | Action |
| --- | --- |
| 1 | Finds Python 3.8+ (`python`, `python3` or `py`) |
| 2 | `pip install websockets` |
| 3 | Generates a shared secret, embeds it in `extension/token.json` |
| 4 | Registers the MCP server in `~/.kiro/settings/mcp.json` (backs up any existing file) |
| 5 | Installs the `browser-control` skill to `~/.kiro/skills/` |
| 6 | Creates a **logon scheduled task** so the bridge survives reboots |
| 7 | Starts the bridge, waits for both ports |
| 8 | Runs 8 security tests and fails loudly if any do not pass |

Flags:

```powershell
.\install.ps1 -NoLogonTask    # run the bridge manually instead
.\install.ps1 -AllowEval      # enable browser_eval (arbitrary JS) - off by default
.\install.ps1 -SkipTests
.\uninstall.ps1               # removes task, MCP entry, skill, secrets
```

---

## Tools the agent gains

| Tool | Does |
| --- | --- |
| `browser_get_state` | URL, title, numbered interactive elements, screenshot |
| `browser_navigate` | Go to a URL |
| `browser_click` | Click by element number or x/y |
| `browser_type` | Type into whatever has focus |
| `browser_fill` | Set a field by number or CSS selector — React-safe |
| `browser_key` | Press a named key |
| `browser_scroll` | Scroll up or down |
| `browser_list_tabs` | List open tabs with ids; `[agent]` marks the Kiro tab |
| `browser_use_tab` | Adopt a tab you already have open as the working tab |
| `browser_focus_tab` | Bring the working tab to the front |
| `browser_eval` | Run JS — requires `-AllowEval` |

`browser_navigate`, `browser_click`, `browser_type`, `browser_fill` and
`browser_key` also take `on_dialog` and `dialog_text`. See below.

Element numbers are invalidated by any page change. Call `browser_get_state`
again after every action.

---

## It works in the background, not in your tab

The agent gets a tab of its own, in a tab group labelled **Kiro**, created on
first use. It is never activated, so you keep your own tab focused and carry on
browsing while the agent clicks around.

<p align="center"><code>[ your tab ] [ your tab ] [ Kiro ▸ agent tab ]</code></p>

- Nothing takes focus. No tab switching under your cursor, no window raising.
- `browser_focus_tab` is the one exception, for when you have to sign in or
  clear a CAPTCHA yourself. The agent is told to say why before calling it.
- The popup has **Show Kiro tab** and **Close it**, plus an opt-in
  *Bring the tab to the front while working* checkbox if you would rather watch.
- Ask the agent to work on a page you already have open and it will call
  `browser_use_tab` on that tab instead.

Two things behave differently in a hidden tab, and both are handled:

**Screenshots.** A hidden tab has no compositor, so `Page.captureScreenshot`
waits forever for a frame that never arrives. Emulation overrides do not fix
this. What does is starting a `Page.startScreencast` session first: that
increments Chrome's capturer count on the `WebContents`, which forces it to
composite while hidden — the same mechanism tab capture uses. The screenshot is
then a normal full-fidelity PNG. If it still fails, the screencast's own JPEG
frame is used, and only as a last resort is the tab briefly foregrounded, which
the response reports so the agent can tell you.

**Focus-dependent behaviour.** An unfocused renderer suppresses `:focus`
styles, autocomplete popups and some input handlers.
`Emulation.setFocusEmulationEnabled` makes the page behave as if you were
looking at it. Timers are still throttled and `requestAnimationFrame` is still
paused in a hidden tab, so a page mid-animation can screenshot half-rendered;
re-reading state resolves it.

The working tab id is held in `chrome.storage.session` and recoverable from the
group label, because the MV3 service worker is torn down every ~30s. Without
both, the agent loses track of its tab and starts driving whichever one you are
using.

---

## How it works

```
  Kiro
   │  stdio JSON-RPC (MCP)
   ▼
  scripts/mcp_server.py        11 tools, standard library only
   │  HTTP :8765 + X-Bridge-Token
   ▼
  scripts/bridge_server.py     auth, origin checks, request correlation
   │  WebSocket :8766 + token, chrome-extension origin only
   ▼
  extension/background.js      Manifest V3 service worker
   │  chrome.debugger (CDP 1.3)
   ▼
  your real, logged-in Chrome
```

### Why an extension instead of Playwright

Chrome 136+ **ignores `--remote-debugging-port`** when it targets the default
profile unless a non-standard `--user-data-dir` is also given
([Chromium 422518918](https://issues.chromium.org/issues/422518918),
[Puppeteer #13845](https://github.com/puppeteer/puppeteer/issues/13845)).

So Playwright MCP and chrome-devtools-mcp cannot attach to a profile that
already holds live sessions — they launch a fresh browser, and you are logged
out of everything.

The `chrome.debugger` extension API is not subject to that restriction. It is
the only remaining route to a signed-in profile, and the same one OpenAI's own
ChatGPT extension uses.

### Keeping the service worker alive

Manifest V3 workers are killed after ~30s idle, which would drop the WebSocket.
`content.js` holds a long-lived runtime port from any open page, `chrome.alarms`
fires every 30s, and tab/window events reconnect. All three are needed.

---

## Security

`chrome.debugger` on a logged-in profile is sharp. This technique is
[actively used for session hijacking](https://thehackernews.com/2026/08/chrome-devtools-technique-enables.html).
Treat it as a privileged component.

### What is enforced

| Control | Why |
| --- | --- |
| WebSocket `Origin` must be `chrome-extension://…` | **WebSockets ignore CORS.** Without this, any page you visit could open `ws://127.0.0.1:8766` and drive your browser |
| Shared token on both transports | Stops other local processes and extensions |
| No CORS headers on the HTTP listener | Pages cannot read responses even if they POST |
| `browser_eval` off by default | Arbitrary JS in logged-in tabs is opt-in only |
| Both listeners bound to `127.0.0.1` | Not reachable off-box |

Verify any time:

```powershell
python scripts\test_security.py
```

Expect `8/8 checks passed`. Anything less and it is not safe to run against a
browser holding sessions you care about.

### What it can reach

Everything that profile can. Session cookies including `HttpOnly`, authenticated
sessions without needing credentials, `localStorage`, network request bodies, and
arbitrary DOM access.

**If you administer cloud infrastructure, think before installing this on the
profile that holds those sessions.** An agent-driven browser holding a live
Azure Portal or Entra admin session is a privileged management path with no
audit trail that distinguishes it from you. Conditional Access sees a compliant
device and a satisfied MFA claim either way.

For that case, use a dedicated Chrome profile and keep admin work in a browser
this cannot reach:

```powershell
# create an isolated profile and load the extension only there
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\KiroBrowserBridge\Profile"
```

### Prompt injection

The agent reads page content. A page can contain text written to look like
instructions. Treat every page as untrusted **data**, never as direction — and
do not point the agent at untrusted pages while authenticated sessions are open.

---

## Troubleshooting

**`extension not connected`**

The bridge is not running, or the extension is not loaded.

```powershell
Get-ScheduledTask -TaskName KiroBrowserBridge | Select-Object State
Start-ScheduledTask -TaskName KiroBrowserBridge
Test-NetConnection 127.0.0.1 -Port 8766
```

If the ports are listening but tools still fail, reload the extension:
`chrome://extensions` → **Kiro Browser Bridge** → reload icon.

**How to tell which side is broken**

The bridge logs *every* connection attempt, including rejected origins and bad
tokens. A completely silent log means no TCP connection arrived, so the fault is
browser-side — extension not loaded, not reloaded after a change, or missing the
`ws://` host permission.

**`/browser-control` missing from the slash menu**

Skills are discovered at session start. Open a new chat. If it is still absent,
check the frontmatter is valid YAML — an unquoted `: ` inside `description`
silently invalidates it.

**Tools absent entirely**

MCP servers load at session start too. New chat. Then check
`~/.kiro/settings/mcp.json` contains a `browser-bridge` entry pointing at your
Python and `scripts/mcp_server.py`.

**Custom agents**

Custom agents do not load user skills by default. Add to the agent config:

```json
"resources": ["skill://~/.kiro/skills/*/SKILL.md"]
```

---

## Known limitations

- Chrome shows a yellow "being debugged by automated software" bar on attached tabs. Unavoidable.
- DevTools cannot be open on an attached tab — one debugger client per tab.
- `chrome://`, `edge://` and extension pages cannot be automated.
- Cross-origin iframes are skipped during element discovery; same-origin frames are traversed.
- Screenshots capture the viewport, not the full page.
- Only one browser-control extension should be enabled at a time. Two will contend for the same tabs and fail intermittently.

## Requirements

- Windows 10/11, PowerShell 5.1+
- Python 3.8+ on PATH
- Google Chrome 116+
- Kiro IDE

## Layout

```
install.ps1                     full setup, idempotent
uninstall.ps1                   removes everything it created
extension/                      load unpacked in Chrome
  manifest.json                 MV3: debugger, tabs, scripting, ws:// hosts
  background.js                 CDP driving, WS client, element discovery
  content.js                    MV3 keep-alive
  popup.html / popup.js         status, manual token entry, detach
scripts/
  bridge_server.py              WS + HTTP bridge, auth, CLI
  mcp_server.py                 MCP stdio server, 9 tools
  test_security.py              8 checks on origin and token enforcement
kiro/skills/browser-control/
  SKILL.md                      installed to ~/.kiro/skills by install.ps1
```

Credit: architecture based on the Antigravity `browser-bridge` design, with
authentication, an MCP layer, and bug fixes added.

## Licence

MIT
