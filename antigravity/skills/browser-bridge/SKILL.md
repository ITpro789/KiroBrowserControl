---
name: browser-bridge
description: Connects to and controls the user's live Chrome browser tabs (Azure Portal, AWS, GitHub, SaaS, local web apps) via Chrome Debugger Protocol (CDP) and WebMCP. Captures live screenshots, annotates interactive elements with numbered badges, and dispatches hardware clicks, typing, and tab switching.
---

# Universal Browser Bridge Skill (Antigravity & Kiro)

This skill equips Antigravity with full, bi-directional control over the user's personal Google Chrome browser sessions without isolated profiles or login barriers, operating concurrently alongside Kiro via a unified bridge daemon.

---

## 🚨 MANDATORY EXECUTION RULES FOR THE AGENT

1. **NEVER BYPASS THE BROWSER**: When `/browser-bridge`, `/browser`, or browser tasks are invoked, **NEVER switch to background curl/REST scripts or headless tools**. The user wants to see the actual Chrome UI being operated.
2. **BACKGROUND TAB ISOLATION (ZERO FOCUS STEALING)**: The browser operates in a dedicated background tab group. When Antigravity uses it, the tab group badge in Chrome dynamically changes to **`[ AG ]`** (blue). When Kiro uses it, it displays **`[ Kiro ]`** (cyan). The user's active browsing tab is never interrupted. **NEVER call `browser_focus_tab` unless the user explicitly asks you to bring the browser forward for manual CAPTCHA or 2FA.**
3. **ALWAYS SHOW SCREENSHOTS & BADGES**: Every browser action captures `browser_view.png` (using Chrome screencast compositing) and references visual badges `[1]`, `[2]`, `[3]`.
4. **UNIFIED MCP & CLI ACCESS**:
   - Registered as native MCP server `browser-bridge` in `~/.gemini/config/mcp_config.json`.
   - CLI script available at `C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py`.

---

## Agent Usage Runbook

### 1. Capturing Current Screen & Interactive Badges
```powershell
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action get_state
```

### 2. Clicking Elements by Badge ID
```powershell
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action click --target <BADGE_NUMBER>
```

### 3. Typing into Inputs & Submitting
```powershell
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action type --target <BADGE_NUMBER> --text "Input text" --enter
```

### 4. Navigating to URLs
```powershell
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action navigate --url "https://example.com"
```

### 5. Switching Tabs or Focusing
```powershell
# List open tabs and switch to a tab ID
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action switch_tab --tab-id <TAB_ID>

# Bring the AG tab to foreground only when CAPTCHA or user interaction is needed
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action focus_tab

### 6. Extracting Clean Page Markdown
```powershell
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action read_content
```

### 7. Reading Console & Network Errors
```powershell
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action get_errors
```

### 8. Dropdowns, New Tabs, & Modifier Keys
```powershell
# Select option in dropdown
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action select_option --target <BADGE_NUMBER> --value "OptionText"

# Keyboard shortcuts (e.g. Ctrl+A, Ctrl+C)
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action key --key "a" --modifiers "Control"

# Open a new tab in the AG group
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action new_tab --url "https://news.ycombinator.com"

# Close the AG tab
python C:\Users\sohai\.gemini\config\skills\browser-bridge\scripts\bridge_server.py --action close_tab
```
