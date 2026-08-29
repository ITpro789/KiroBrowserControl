/**
 * Kiro Browser Bridge - background service worker.
 *
 * Drives the user's real, logged-in Chrome profile through the Chrome Debugger
 * Protocol (CDP 1.3). Chrome 136+ ignores --remote-debugging-port against the
 * default profile, so chrome.debugger from an installed extension is the only
 * remaining way to automate a profile that already holds live sessions.
 *
 * Security model:
 *   - The bridge server only accepts WebSocket clients whose Origin is a
 *     chrome-extension:// URL. Browsers set Origin themselves, so no web page
 *     can impersonate the extension.
 *   - Additionally the extension must present a shared token as its first
 *     message. The token is generated at install time and pasted into the
 *     popup once; it is stored in chrome.storage.local.
 *   - 'eval' (arbitrary JS in page context) is refused unless the server has
 *     been started with it explicitly enabled.
 */

const WS_URL = 'ws://127.0.0.1:8766';
const PING_INTERVAL_MS = 10000;
const RECONNECT_DELAY_MS = 1500;

let ws = null;
let pingTimer = null;
let authed = false;
const attachedTabs = new Set();

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) return resolve();

    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // "Another debugger is already attached" means DevTools is open on this
        // tab, or we already hold it. Anything else is a real failure and must
        // not be swallowed, or later sendCommand calls fail confusingly.
        if (/already attached/i.test(err.message)) {
          attachedTabs.add(tabId);
          return resolve();
        }
        return reject(new Error(`debugger.attach failed: ${err.message}`));
      }

      attachedTabs.add(tabId);
      const enable = (domain) =>
        new Promise((r) => chrome.debugger.sendCommand({ tabId }, domain, {}, () => r()));

      Promise.all([enable('Page.enable'), enable('DOM.enable'), enable('Runtime.enable')])
        .then(() => resolve());
    });
  });
}

function sendCDP(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(`${method}: ${err.message}`));
      resolve(result || {});
    });
  });
}

async function detachAll() {
  for (const tabId of Array.from(attachedTabs)) {
    try {
      await new Promise((r) => chrome.debugger.detach({ tabId }, () => r()));
    } catch (e) { /* tab already gone */ }
    attachedTabs.delete(tabId);
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

// ---------------------------------------------------------------------------
// Tab selection
// ---------------------------------------------------------------------------

const INTERNAL_PREFIXES = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'devtools://'];

function isAutomatable(url) {
  return !!url && !INTERNAL_PREFIXES.some((p) => url.startsWith(p));
}

async function getTargetTab(cmd) {
  const allTabs = await chrome.tabs.query({});

  if (cmd && cmd.tab_id) {
    const found = allTabs.find((t) => t.id === cmd.tab_id);
    if (found) return found;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab && isAutomatable(activeTab.url)) return activeTab;

  return allTabs.find((t) => isAutomatable(t.url)) || activeTab || allTabs[0] || null;
}

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function captureScreenshot(tabId) {
  await attachDebugger(tabId);
  const { data } = await sendCDP(tabId, 'Page.captureScreenshot', { format: 'png' });
  return `data:image/png;base64,${data}`;
}

async function clickAt(tabId, x, y) {
  await attachDebugger(tabId);
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, clickCount: 0 });
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await new Promise((r) => setTimeout(r, 60));
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

const KEY_MAP = {
  ArrowDown:  { windowsVirtualKeyCode: 40, code: 'ArrowDown',  key: 'ArrowDown' },
  ArrowUp:    { windowsVirtualKeyCode: 38, code: 'ArrowUp',    key: 'ArrowUp' },
  ArrowLeft:  { windowsVirtualKeyCode: 37, code: 'ArrowLeft',  key: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Enter:      { windowsVirtualKeyCode: 13, code: 'Enter',      key: 'Enter', text: '\r', unmodifiedText: '\r' },
  Tab:        { windowsVirtualKeyCode: 9,  code: 'Tab',        key: 'Tab' },
  Escape:     { windowsVirtualKeyCode: 27, code: 'Escape',     key: 'Escape' },
  Space:      { windowsVirtualKeyCode: 32, code: 'Space',      key: ' ', text: ' ' },
  Backspace:  { windowsVirtualKeyCode: 8,  code: 'Backspace',  key: 'Backspace' },
  Delete:     { windowsVirtualKeyCode: 46, code: 'Delete',     key: 'Delete' },
  Home:       { windowsVirtualKeyCode: 36, code: 'Home',       key: 'Home' },
  End:        { windowsVirtualKeyCode: 35, code: 'End',        key: 'End' }
};

async function sendKey(tabId, key) {
  await attachDebugger(tabId);
  const def = KEY_MAP[key];
  if (!def) throw new Error(`Unsupported key: ${key}`);
  await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...def });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def });
}

async function typeText(tabId, text, pressEnter) {
  await attachDebugger(tabId);
  // insertText is far more reliable than per-character key events for IME,
  // emoji and non-Latin input, and much faster.
  await sendCDP(tabId, 'Input.insertText', { text: String(text) });
  if (pressEnter) await sendKey(tabId, 'Enter');
}

async function evaluate(tabId, expression) {
  await attachDebugger(tabId);
  const res = await sendCDP(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'evaluation threw');
  }
  return res.result ? res.result.value : null;
}

// ---------------------------------------------------------------------------
// Element discovery (set-of-marks): index every interactive element, record
// viewport coordinates, expose them on window.__agent_elements.
// ---------------------------------------------------------------------------

const ANNOTATE_JS = `
(() => {
  window.__agent_elements = {};
  const SEL = 'a, button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[role="combobox"], [role="listbox"], [role="option"], ' +
    '[role="checkbox"], [role="radio"], [role="switch"], ' +
    '[contenteditable="true"], [tabindex]:not([tabindex="-1"])';

  const frames = [{ doc: document, dx: 0, dy: 0 }];
  document.querySelectorAll('iframe').forEach((f) => {
    try {
      if (f.contentDocument) {
        const r = f.getBoundingClientRect();
        frames.push({ doc: f.contentDocument, dx: r.left, dy: r.top });
      }
    } catch (e) { /* cross-origin frame */ }
  });

  const items = [];
  let i = 1;

  for (const { doc, dx, dy } of frames) {
    const view = doc.defaultView || window;
    for (const el of Array.from(doc.querySelectorAll(SEL))) {
      const r = el.getBoundingClientRect();
      const left = r.left + dx, top = r.top + dy;
      if (r.width <= 0 || r.height <= 0) continue;
      if (top + r.height < 0 || top > window.innerHeight) continue;

      let st;
      try { st = view.getComputedStyle(el); } catch (e) { continue; }
      if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
      if (el.disabled) continue;

      const cx = Math.round(left + r.width / 2);
      const cy = Math.round(top + r.height / 2);

      window.__agent_elements[i] = { el, x: cx, y: cy };

      const label = (
        el.getAttribute('aria-label') ||
        el.innerText ||
        el.value ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('name') || ''
      ).replace(/\\s+/g, ' ').trim().slice(0, 80);

      items.push({
        id: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        text: label,
        href: (el.getAttribute('href') || '').slice(0, 200),
        x: cx,
        y: cy
      });
      i++;
    }
  }
  return items;
})()
`;

async function annotate(tabId) {
  try {
    return (await evaluate(tabId, ANNOTATE_JS)) || [];
  } catch (e) {
    return [];
  }
}

/**
 * Set a form field's value in a way React/Angular/Vue actually notice.
 * Assigning .value directly bypasses the framework's property setter and the
 * component state never updates.
 */
async function formInput(tabId, target, value) {
  const js = `
  (() => {
    const t = ${JSON.stringify(String(target))};
    let el = null;
    if (/^\\d+$/.test(t)) {
      const item = window.__agent_elements && window.__agent_elements[parseInt(t, 10)];
      el = item ? item.el : null;
    } else {
      el = document.querySelector(t);
    }
    if (!el) return { success: false, error: 'element not found: ' + t };

    el.scrollIntoView({ block: 'center' });
    el.focus();

    const v = ${JSON.stringify(String(value))};
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');

    if (desc && desc.set) { desc.set.call(el, v); } else { el.value = v; }

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, value: el.value };
  })()
  `;
  return evaluate(tabId, js);
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function handleCommand(cmd) {
  const action = cmd.action || 'get_state';
  const tab = await getTargetTab(cmd);

  if (!tab || !tab.id) {
    return { status: 'error', error: 'no automatable tab found', tabs: await getAllTabs() };
  }
  const tabId = tab.id;

  try {
    if (action !== 'get_state') {
      try {
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await new Promise((r) => setTimeout(r, 250));
      } catch (e) { /* window may be minimised */ }
    }

    switch (action) {
      case 'get_state':
        break;

      case 'navigate': {
        if (!cmd.url) throw new Error('navigate requires url');
        let url = cmd.url;
        // Only add a scheme when there is genuinely none. Matching on http(s)
        // alone mangled file://, chrome:// and about: URLs into https://file///...
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        await chrome.tabs.update(tabId, { url });
        await new Promise((r) => setTimeout(r, 1800));
        break;
      }

      case 'click': {
        if (cmd.target !== undefined && cmd.target !== '') {
          const pt = await evaluate(tabId, `(() => {
            const it = window.__agent_elements && window.__agent_elements[${parseInt(cmd.target, 10)}];
            return it ? { x: it.x, y: it.y } : null;
          })()`);
          if (!pt) throw new Error(`element [${cmd.target}] not found - call get_state first`);
          await clickAt(tabId, pt.x, pt.y);
        } else if (cmd.x !== undefined && cmd.y !== undefined) {
          await clickAt(tabId, cmd.x, cmd.y);
        } else {
          throw new Error('click requires target or x/y');
        }
        await new Promise((r) => setTimeout(r, 600));
        break;
      }

      case 'form_input': {
        const r = await formInput(tabId, cmd.target, cmd.text || '');
        if (r && r.success === false) throw new Error(r.error);
        await new Promise((r2) => setTimeout(r2, 250));
        break;
      }

      case 'type':
        await typeText(tabId, cmd.text || '', !!cmd.enter);
        await new Promise((r) => setTimeout(r, 500));
        break;

      case 'key':
        await sendKey(tabId, cmd.key || 'Enter');
        await new Promise((r) => setTimeout(r, 350));
        break;

      case 'scroll': {
        const dy = cmd.direction === 'up' ? -(cmd.amount || 500) : (cmd.amount || 500);
        await evaluate(tabId, `window.scrollBy({ top: ${dy} })`);
        await new Promise((r) => setTimeout(r, 300));
        break;
      }

      case 'switch_tab':
        // Focus already handled above via cmd.tab_id.
        break;

      case 'eval': {
        if (!cmd.eval_allowed) {
          throw new Error('eval is disabled; start the bridge with --allow-eval to enable it');
        }
        if (!cmd.code) throw new Error('eval requires code');
        const value = await evaluate(tabId, cmd.code);
        return { status: 'ok', result: value, tab: { id: tabId, url: tab.url } };
      }

      default:
        throw new Error(`unknown action: ${action}`);
    }

    const current = await chrome.tabs.get(tabId);
    const elements = await annotate(tabId);
    const screenshot = await captureScreenshot(tabId);

    return {
      status: 'ok',
      tab: { id: current.id, title: current.title, url: current.url },
      tabs: await getAllTabs(),
      interactive_elements_count: elements.length,
      elements,
      screenshot
    };
  } catch (err) {
    return { status: 'error', error: String(err && err.message || err), tabs: await getAllTabs() };
  }
}

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------

async function getToken() {
  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  if (bridgeToken) return bridgeToken;

  // Fall back to token.json, written into this folder by install.ps1, so the
  // extension self-pairs with no manual step. The file is not listed in
  // web_accessible_resources, so no web page can read it; a local process that
  // could read it could equally read .bridge-token, so this costs nothing in
  // terms of the threat this token defends against.
  try {
    const resp = await fetch(chrome.runtime.getURL('token.json'));
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.token) {
        await chrome.storage.local.set({ bridgeToken: data.token });
        console.log('[bridge] paired from token.json');
        return data.token;
      }
    }
  } catch (e) {
    // No bundled token; the popup can still be used.
  }
  return null;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const token = await getToken();
  if (!token) {
    console.warn('[bridge] no token set - open the extension popup and paste the bridge token');
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setTimeout(connect, 2000);
    return;
  }

  authed = false;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'auth_ok') {
      authed = true;
      console.log('[bridge] authenticated');
      return;
    }
    if (msg.type === 'auth_failed') {
      console.error('[bridge] token rejected - re-paste the token in the popup');
      try { ws.close(); } catch (e) {}
      return;
    }
    if (msg.type === 'pong') return;

    if (!authed || !msg.command_id) return;

    const result = await handleCommand(msg);
    result.command_id = msg.command_id;
    try { ws.send(JSON.stringify(result)); } catch (e) {}
  };

  ws.onclose = () => {
    authed = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function ensureConnected() {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
}

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'keepAlive') ensureConnected(); });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onMessage.addListener(() => {});
    ensureConnected();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'status') {
    reply({ connected: !!ws && ws.readyState === WebSocket.OPEN, authed, attached: attachedTabs.size });
    return true;
  }
  if (msg && msg.type === 'reconnect') {
    try { if (ws) ws.close(); } catch (e) {}
    connect().then(() => reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'detach_all') {
    detachAll().then(() => reply({ ok: true }));
    return true;
  }
  return false;
});

chrome.tabs.onActivated.addListener(ensureConnected);
chrome.tabs.onUpdated.addListener(ensureConnected);
chrome.windows.onFocusChanged.addListener(ensureConnected);
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

connect();
