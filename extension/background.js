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
const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let pingTimer = null;
let authed = false;
let connecting = false;
let reconnectTimer = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
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

      Promise.all([
        enable('Page.enable'),
        enable('DOM.enable'),
        enable('Runtime.enable'),
        // The agent tab is deliberately never the active one, and an unfocused
        // renderer suppresses :focus styles, autocomplete popups and some
        // input handlers. Focus emulation makes the page behave as if the user
        // were looking at it, which background form filling depends on.
        new Promise((r) => chrome.debugger.sendCommand(
          { tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }, () => {
            void chrome.runtime.lastError;
            r();
          }))
      ]).then(() => resolve());
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
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    screencastWaiters.delete(source.tabId);
  }
});

// Screencast frames arrive as CDP events rather than command results, so they
// need a listener and an explicit ack - Chrome stops sending frames otherwise.
const screencastWaiters = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;

  // Handled even when no command is in flight - a page's own setTimeout(alert)
  // would otherwise wedge the tab until it is closed.
  if (method === 'Page.javascriptDialogOpening') {
    handleDialog(source.tabId, params);
    return;
  }

  if (method !== 'Page.screencastFrame') return;

  const waiter = screencastWaiters.get(source.tabId);
  if (waiter) {
    screencastWaiters.delete(source.tabId);
    waiter(params);
  }

  if (params && params.sessionId !== undefined) {
    chrome.debugger.sendCommand(
      { tabId: source.tabId },
      'Page.screencastFrameAck',
      { sessionId: params.sessionId },
      () => { void chrome.runtime.lastError; }
    );
  }
});

// ---------------------------------------------------------------------------
// JavaScript dialogs
//
// With Page.enable active, Chrome hands alert/confirm/prompt/beforeunload to the
// debugger client instead of showing the native dialog. If nobody answers, the
// renderer blocks forever: the navigation never completes, waitForLoad spins out
// and the screenshot times out. So every dialog must be answered.
// ---------------------------------------------------------------------------

const dialogPolicy = new Map();     // tabId -> 'accept' | 'dismiss', one command
const dialogPromptText = new Map(); // tabId -> text to submit to a prompt()
const dialogLog = new Map();        // tabId -> dialogs seen during this command

function defaultDialogAction(type) {
  // alert has a single button, and beforeunload only fires because the agent
  // asked to navigate, so leaving is exactly what was intended.
  if (type === 'alert' || type === 'beforeunload') return 'accept';

  // confirm and prompt are decisions with consequences. "Delete all records?"
  // is indistinguishable from "Save changes?" at this layer, so cancel unless
  // the caller explicitly asked to accept via on_dialog.
  return 'dismiss';
}

function handleDialog(tabId, params) {
  const type = (params && params.type) || 'unknown';
  const action = dialogPolicy.get(tabId) || defaultDialogAction(type);
  const accept = action === 'accept';

  const log = dialogLog.get(tabId) || [];
  log.push({
    type,
    message: String((params && params.message) || '').slice(0, 300),
    handled: action,
    default_used: !dialogPolicy.has(tabId)
  });
  dialogLog.set(tabId, log);

  const args = { accept };
  if (type === 'prompt' && accept) {
    args.promptText = dialogPromptText.get(tabId) || '';
  }

  chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', args, () => {
    void chrome.runtime.lastError;
  });
}

function nextScreencastFrame(tabId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      screencastWaiters.delete(tabId);
      resolve(null);
    }, ms);
    screencastWaiters.set(tabId, (params) => {
      clearTimeout(timer);
      resolve(params);
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  screencastWaiters.delete(tabId);
  dialogPolicy.delete(tabId);
  dialogPromptText.delete(tabId);
  dialogLog.delete(tabId);
  if (tabId === agentTabId) forgetAgentTab();
});

// ---------------------------------------------------------------------------
// Agent workspace
//
// Driving whichever tab the user happens to be looking at makes the browser
// unusable while the agent works. Instead the agent owns one tab of its own,
// held in a labelled "Kiro" tab group and never activated, so the user keeps
// their own tab focused and can carry on browsing.
//
// Passing tab_id explicitly still targets any tab, and 'focus_tab' brings the
// agent tab forward when the user needs to see or take over from it.
// ---------------------------------------------------------------------------

const INTERNAL_PREFIXES = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'devtools://'];
const AGENT_GROUP_TITLE = 'Kiro';
const AGENT_GROUP_COLOR = 'cyan';

let agentTabId = null;

// Where to hand focus back to if anything ever has to foreground the agent tab.
let lastUserTabId = null;

// Opt-in via the popup. Off by default: the whole point is not to take over.
let stealFocus = false;

chrome.storage.local.get('bridgeStealFocus').then(({ bridgeStealFocus }) => {
  stealFocus = !!bridgeStealFocus;
}).catch(() => {});

// Rehydrate on every worker start, so the popup and getAllTabs know which tab
// is the agent's before any command has run.
chrome.storage.session.get('agentTabId').then(({ agentTabId: stored }) => {
  if (stored && !agentTabId) agentTabId = stored;
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bridgeStealFocus) {
    stealFocus = !!changes.bridgeStealFocus.newValue;
  }
});

function isAutomatable(url) {
  return !!url && !INTERNAL_PREFIXES.some((p) => url.startsWith(p));
}

async function getTabOrNull(tabId) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

/**
 * MV3 tears the service worker down after ~30s idle, so module state cannot be
 * trusted between commands. Two independent records survive that: session
 * storage, and the tab group label itself. Both are needed - storage is exact
 * but cleared when Chrome restarts, and the group label survives that.
 *
 * Getting this wrong is not cosmetic. Losing the id used to fall through to
 * "any automatable tab", which silently hijacked whatever the user had open.
 */
async function rememberAgentTab(tabId) {
  agentTabId = tabId;
  try {
    await chrome.storage.session.set({ agentTabId: tabId });
  } catch (e) { /* session storage unavailable */ }
}

async function forgetAgentTab() {
  agentTabId = null;
  try {
    await chrome.storage.session.remove('agentTabId');
  } catch (e) { /* nothing to do */ }
}

async function recallAgentTab() {
  try {
    const { agentTabId: stored } = await chrome.storage.session.get('agentTabId');
    if (stored) {
      const tab = await getTabOrNull(stored);
      if (tab) return tab;
    }
  } catch (e) { /* fall through to the group lookup */ }
  return null;
}

async function findGroupedAgentTab() {
  if (!chrome.tabGroups) return null;
  try {
    const groups = await chrome.tabGroups.query({ title: AGENT_GROUP_TITLE });
    for (const group of groups) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length) {
        return tabs.find((t) => isAutomatable(t.url)) || tabs[0];
      }
    }
  } catch (e) { /* tabGroups unavailable */ }
  return null;
}

async function pickHostWindowId() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win && win.type === 'normal') return win.id;
  } catch (e) { /* no focused window */ }
  try {
    const wins = await chrome.windows.getAll({});
    const normal = wins.find((w) => w.type === 'normal');
    if (normal) return normal.id;
  } catch (e) { /* none open */ }
  return null;
}

async function ensureAgentTab() {
  let tab = await getTabOrNull(agentTabId);
  if (tab) return { tab, source: 'memory' };

  tab = await recallAgentTab();
  if (tab) {
    await rememberAgentTab(tab.id);
    return { tab, source: 'session' };
  }

  tab = await findGroupedAgentTab();
  if (tab) {
    await rememberAgentTab(tab.id);
    return { tab, source: 'group' };
  }

  const windowId = await pickHostWindowId();
  const created = await chrome.tabs.create({
    url: 'about:blank',
    active: false,               // never pull focus off the user's tab
    ...(windowId ? { windowId } : {})
  });
  await rememberAgentTab(created.id);

  try {
    const groupId = await chrome.tabs.group({ tabIds: created.id });
    await chrome.tabGroups.update(groupId, {
      title: AGENT_GROUP_TITLE,
      color: AGENT_GROUP_COLOR,
      collapsed: false
    });
  } catch (e) {
    // Grouping is cosmetic, but without it the label-based recovery above stops
    // working, so it is worth surfacing.
    console.warn('[bridge] could not group agent tab:', e && e.message);
  }

  return { tab: (await getTabOrNull(created.id)) || created, source: 'created' };
}

async function getTargetTab(cmd) {
  if (cmd && cmd.tab_id) {
    const found = await getTabOrNull(cmd.tab_id);
    if (found) return { tab: found, source: 'tab_id' };
    return { tab: null, source: 'tab_id_missing' };
  }

  // Deliberately no "any tab will do" fallback. Driving a tab the user is
  // using, without being asked to, is worse than returning an error.
  return ensureAgentTab();
}

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    agent: t.id === agentTabId
  }));
}

async function waitForLoad(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const t = await getTabOrNull(tabId);
    if (!t) return;
    if (t.status === 'complete') {
      await new Promise((r) => setTimeout(r, 350));
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const CAPTURE_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function captureFrame(tabId) {
  // Keep the parameters minimal. captureBeyondViewport in particular never
  // returns here, in either a background or a foreground tab.
  return withTimeout(
    sendCDP(tabId, 'Page.captureScreenshot', { format: 'png' }),
    CAPTURE_TIMEOUT_MS,
    'Page.captureScreenshot'
  ).then(({ data }) => `data:image/png;base64,${data}`);
}

/**
 * Screenshot a tab that is not the active one.
 *
 * An inactive tab has no compositor surface, so a plain Page.captureScreenshot
 * either hangs or comes back empty. Overriding device metrics forces the
 * renderer to produce frames regardless of visibility, which is what makes
 * background capture possible at all. If that still fails we briefly activate
 * the tab and hand focus straight back.
 */
async function captureScreenshot(tabId) {
  await attachDebugger(tabId);

  const target = await getTabOrNull(tabId);
  if (target && target.active) {
    // Already the visible tab, so the ordinary path works.
    return { data: await captureFrame(tabId), mode: 'visible' };
  }

  // A hidden tab has no compositor, so Page.captureScreenshot waits forever for
  // a frame that is never produced. Starting a screencast increments Chrome's
  // capturer count on the WebContents, which forces it to composite while
  // hidden - the same mechanism tab capture relies on. Emulation overrides do
  // not achieve this; only a capturer does.
  let backgroundError = null;
  let screencasting = false;
  const framePromise = nextScreencastFrame(tabId, CAPTURE_TIMEOUT_MS);

  try {
    await sendCDP(tabId, 'Page.startScreencast', {
      format: 'jpeg', quality: 80, everyNthFrame: 1
    });
    screencasting = true;
  } catch (e) {
    backgroundError = `startScreencast: ${(e && e.message) || e}`;
  }

  let shot = null;
  let mode = null;

  if (screencasting) {
    try {
      shot = await captureFrame(tabId);
      mode = 'background';
    } catch (e) {
      backgroundError = String((e && e.message) || e);
    }

    if (!shot) {
      // Fall back to the screencast's own frame. Lower fidelity than a PNG but
      // it is a true picture of the page and costs no focus change.
      const frame = await framePromise;
      if (frame && frame.data) {
        shot = `data:image/jpeg;base64,${frame.data}`;
        mode = 'background-screencast';
      }
    }

    try { await sendCDP(tabId, 'Page.stopScreencast', {}); } catch (e) {}
  }

  screencastWaiters.delete(tabId);

  if (shot) {
    return { data: shot, mode, ...(backgroundError ? { backgroundError } : {}) };
  }

  const data = await captureWithTemporaryFocus(tabId, backgroundError);
  return { data, mode: 'focused', backgroundError };
}

async function captureWithTemporaryFocus(tabId, originalError) {
  let restoreTabId = null;
  try {
    const target = await chrome.tabs.get(tabId);
    const [wasActive] = await chrome.tabs.query({ active: true, windowId: target.windowId });

    // If the agent tab is somehow already active, fall back to the last tab the
    // user chose themselves. Without this the tab stays foregrounded after the
    // first fallback and every later capture leaves it there.
    if (wasActive && wasActive.id !== tabId) restoreTabId = wasActive.id;
    else if (lastUserTabId && lastUserTabId !== tabId) restoreTabId = lastUserTabId;

    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 250));
    return await captureFrame(tabId);
  } catch (e) {
    throw new Error(originalError ? `${originalError}; focused retry: ${e.message}` : e.message);
  } finally {
    if (restoreTabId) {
      try { await chrome.tabs.update(restoreTabId, { active: true }); } catch (e) {}
    }
  }
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

  let tab = null;
  let tabSource = 'unknown';
  try {
    const picked = await getTargetTab(cmd);
    tab = picked.tab;
    tabSource = picked.source;
  } catch (e) {
    return {
      status: 'error',
      error: `could not open the agent tab: ${(e && e.message) || e}`,
      tabs: await getAllTabs()
    };
  }

  if (!tab || !tab.id) {
    return {
      status: 'error',
      error: tabSource === 'tab_id_missing'
        ? `tab_id ${cmd.tab_id} does not exist`
        : 'no agent tab available',
      tabs: await getAllTabs()
    };
  }
  const tabId = tab.id;

  // Set before the action, because the dialog opens while the action is running.
  dialogLog.delete(tabId);
  if (cmd.on_dialog === 'accept' || cmd.on_dialog === 'dismiss') {
    dialogPolicy.set(tabId, cmd.on_dialog);
  } else {
    dialogPolicy.delete(tabId);
  }
  if (typeof cmd.dialog_text === 'string') {
    dialogPromptText.set(tabId, cmd.dialog_text);
  } else {
    dialogPromptText.delete(tabId);
  }

  try {
    // Focus is only taken when the user has opted in from the popup, or when
    // they explicitly asked for it via focus_tab.
    if (stealFocus && action !== 'get_state') {
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
        // A background tab loads on its own schedule, so wait on the real load
        // state instead of guessing with a fixed sleep.
        await waitForLoad(tabId);
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
        // Explicitly adopting a tab makes it the agent's working tab from now
        // on, so follow-up commands without a tab_id land on the same page.
        if (cmd.tab_id) await rememberAgentTab(tabId);
        break;

      case 'focus_tab':
        await chrome.tabs.update(tabId, { active: true });
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (e) { /* window may be minimised */ }
        await new Promise((r) => setTimeout(r, 250));
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

    // The element list is useful on its own, so a capture failure degrades the
    // response rather than failing the whole command.
    let screenshot = '';
    let screenshotError = null;
    let screenshotMode = null;
    let backgroundCaptureError = null;
    try {
      const shot = await captureScreenshot(tabId);
      screenshot = shot.data;
      screenshotMode = shot.mode;
      backgroundCaptureError = shot.backgroundError || null;
    } catch (e) {
      screenshotError = String((e && e.message) || e);
    }

    return {
      status: 'ok',
      tab: {
        id: current.id,
        title: current.title,
        url: current.url,
        agent: current.id === agentTabId,
        active: current.active,
        source: tabSource
      },
      tabs: await getAllTabs(),
      interactive_elements_count: elements.length,
      elements,
      ...(dialogLog.get(tabId)?.length ? { dialogs: dialogLog.get(tabId) } : {}),
      screenshot,
      ...(screenshotMode ? { screenshot_mode: screenshotMode } : {}),
      ...(backgroundCaptureError ? { background_capture_error: backgroundCaptureError } : {}),
      ...(screenshotError ? { screenshot_error: screenshotError } : {})
    };
  } catch (err) {
    return {
      status: 'error',
      error: String(err && err.message || err),
      ...(dialogLog.get(tabId)?.length ? { dialogs: dialogLog.get(tabId) } : {}),
      tabs: await getAllTabs()
    };
  } finally {
    // Policy is per command. Leaking it would silently apply an "accept" the
    // caller asked for once to every later action on this tab.
    dialogPolicy.delete(tabId);
    dialogPromptText.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------

async function getToken() {
  // token.json is authoritative when present. install.ps1 regenerates the secret
  // on every run, so preferring the cached copy in chrome.storage.local would
  // leave the extension authenticating with a stale token after a re-install -
  // which presents as "extension not connected" with a bad-token rejection in
  // the server log.
  //
  // The file is not listed in web_accessible_resources, so no web page can read
  // it. A local process able to read it could read .bridge-token anyway, so this
  // costs nothing against the threat the token defends against.
  try {
    const resp = await fetch(chrome.runtime.getURL('token.json'));
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.token) {
        const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
        if (bridgeToken !== data.token) {
          await chrome.storage.local.set({ bridgeToken: data.token });
          console.log('[bridge] paired from token.json (token changed)');
        }
        return data.token;
      }
    }
  } catch (e) {
    // No bundled token - fall through to whatever the popup stored.
  }

  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  return bridgeToken || null;
}

/**
 * Chrome writes a console error for every refused WebSocket, and the bridge
 * being stopped is a normal state, so retry with backoff instead of hammering
 * the port every 1.5s and filling the log with red.
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

async function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // Claimed synchronously, before the first await. getToken() yields, and
  // connect() is driven by several frequently-firing tab and window listeners,
  // so without this two sockets race: the loser's onopen then fires and calls
  // send() on the module-level `ws`, which by then is the winner's socket and
  // still CONNECTING. That is the InvalidStateError.
  connecting = true;

  let token = null;
  try {
    token = await getToken();
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }

  if (!token) {
    connecting = false;
    console.warn('[bridge] no token set - open the extension popup and paste the bridge token');
    return;
  }

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }

  ws = socket;
  authed = false;
  connecting = false;

  // Handlers act on their own socket and bail if it has since been replaced, so
  // a superseded connection can never touch shared state.
  const isCurrent = () => ws === socket;

  socket.onopen = () => {
    if (!isCurrent()) {
      try { socket.close(); } catch (e) {}
      return;
    }
    reconnectDelayMs = RECONNECT_MIN_MS;
    socket.send(JSON.stringify({ type: 'auth', token }));

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (isCurrent() && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  };

  socket.onmessage = async (event) => {
    if (!isCurrent()) return;

    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'auth_ok') {
      authed = true;
      console.log('[bridge] authenticated');
      return;
    }
    if (msg.type === 'auth_failed') {
      console.error('[bridge] token rejected - re-paste the token in the popup');
      try { socket.close(); } catch (e) {}
      return;
    }
    if (msg.type === 'pong') return;

    if (!authed || !msg.command_id) return;

    const result = await handleCommand(msg);
    result.command_id = msg.command_id;
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(result)); } catch (e) {}
    }
  };

  socket.onclose = () => {
    if (!isCurrent()) return;
    authed = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    scheduleReconnect();
  };

  socket.onerror = () => { try { socket.close(); } catch (e) {} };
}

function ensureConnected() {
  // A queued retry is honoured rather than pre-empted, otherwise the tab and
  // window listeners bypass the backoff and reconnect every few hundred ms.
  if (reconnectTimer || connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connect();
}

function reconnectNow() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelayMs = RECONNECT_MIN_MS;
  const stale = ws;
  ws = null;
  try { if (stale) stale.close(); } catch (e) {}
  return connect();
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
    reply({
      connected: !!ws && ws.readyState === WebSocket.OPEN,
      authed,
      attached: attachedTabs.size,
      agentTabId,
      stealFocus
    });
    return true;
  }
  if (msg && msg.type === 'show_agent_tab') {
    ensureAgentTab()
      .then(async ({ tab }) => {
        await chrome.tabs.update(tab.id, { active: true });
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
        reply({ ok: true, tabId: tab.id });
      })
      .catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === 'close_agent_tab') {
    const id = agentTabId;
    forgetAgentTab().then(() => {
      if (!id) return reply({ ok: true });
      chrome.tabs.remove(id).then(() => reply({ ok: true })).catch(() => reply({ ok: true }));
    });
    return true;
  }
  if (msg && msg.type === 'reconnect') {
    reconnectNow().then(() => reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'detach_all') {
    detachAll().then(() => reply({ ok: true }));
    return true;
  }
  return false;
});

chrome.tabs.onActivated.addListener((info) => {
  if (info && info.tabId && info.tabId !== agentTabId) lastUserTabId = info.tabId;
  ensureConnected();
});
chrome.tabs.onUpdated.addListener(ensureConnected);
chrome.windows.onFocusChanged.addListener(ensureConnected);
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

connect();
