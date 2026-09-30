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
const tabElements = new Map(); // tabId -> Map<number, { frameId, localId, x, y, width, height, ... }>
// Which JS world holds window.__agent_elements for the last scan of a tab:
// 'isolated' (chrome.scripting, all frames) or 'main' (Runtime.evaluate
// fallback, top frame only). Lookups have to go to the same world, or they find
// nothing and report "element not found" for an element that is there.
const tabElementWorld = new Map();
// Why the all-frames scan fell back, reported in the response so a missing
// frame is diagnosable rather than silent.
const lastScanError = new Map();

// The element list is also written to session storage. MV3 restarts the service
// worker whenever it likes, and these Maps go with it - after which every click
// by number failed with "call get_state first" even though the page, and its
// in-page registry, were untouched.
function elementsKey(tabId) { return `els_${tabId}`; }

function persistTabElements(tabId, world, items) {
  chrome.storage.session.set({ [elementsKey(tabId)]: { world, items } }).catch(() => {});
}

async function getTabElements(tabId) {
  const cached = tabElements.get(tabId);
  if (cached) return cached;
  try {
    const stored = (await chrome.storage.session.get(elementsKey(tabId)))[elementsKey(tabId)];
    if (stored && Array.isArray(stored.items)) {
      const m = new Map(stored.items.map((it) => [it.id, it]));
      tabElements.set(tabId, m);
      tabElementWorld.set(tabId, stored.world);
      return m;
    }
  } catch (e) { /* nothing stored */ }
  return undefined;
}

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
        enable('Log.enable'),
        enable('Network.enable'),
        // The agent tab is deliberately never the active one, and an unfocused
        // renderer suppresses :focus styles, autocomplete popups and some
        // input handlers. Focus emulation makes the page behave as if the user
        // were looking at it, which background form filling depends on.
        new Promise((r) => chrome.debugger.sendCommand(
          { tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }, () => {
            void chrome.runtime.lastError;
            r();
          })),
        // Enable flattened auto-attach so CDP can route events to Out-of-Process
        // Iframes (OOPIFs) across cross-origin enterprise portals (Azure, ServiceNow).
        new Promise((r) => chrome.debugger.sendCommand(
          { tabId }, 'Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true
          }, () => {
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
const tabErrors = new Map(); // tabId -> Array of error objects (max 30)

function recordError(tabId, err) {
  const list = tabErrors.get(tabId) || [];
  list.push(err);
  if (list.length > 30) list.shift();
  tabErrors.set(tabId, list);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;

  if (method === 'Log.entryAdded' && params && params.entry) {
    if (params.entry.level === 'error' || params.entry.level === 'warning') {
      recordError(source.tabId, {
        type: 'console',
        level: params.entry.level,
        text: String(params.entry.text || '').slice(0, 300),
        url: params.entry.url || '',
        timestamp: Date.now()
      });
    }
    return;
  }

  if (method === 'Network.responseReceived' && params && params.response) {
    if (params.response.status >= 400) {
      recordError(source.tabId, {
        type: 'network',
        status: params.response.status,
        statusText: params.response.statusText,
        url: String(params.response.url || '').slice(0, 250),
        timestamp: Date.now()
      });
    }
    return;
  }

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
  tabErrors.delete(tabId);
  tabElements.delete(tabId);
  tabElementWorld.delete(tabId);
  chrome.storage.session.remove(elementsKey(tabId)).catch(() => {});
  forgetAgentTab(tabId);
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

// Each agent gets its own tab, its own group and its own colour. Sharing one
// tab between agents does not work: two agents navigating the same tab overwrite
// each other's page, and each then reads a screenshot of the other's work.
// Relabelling a single shared group is cosmetic, not isolation.
const AGENT_STYLES = {
  Kiro: { title: 'Kiro', color: 'cyan' },
  AG:   { title: 'AG',   color: 'blue' }
};
const DEFAULT_AGENT = 'Kiro';

function normaliseAgent(agentName) {
  if (/^(ag|antigravity)$/i.test(String(agentName || '').trim())) return 'AG';
  return DEFAULT_AGENT;
}

function getAgentStyle(agentName) {
  return AGENT_STYLES[normaliseAgent(agentName)];
}

// agent key -> { current: tabId|null, tabs: tabId[] }
//
// An agent owns a set of tabs, not one. new_tab used to overwrite the single
// slot, which orphaned the previous tab: it stayed open and grouped but nothing
// tracked it, so it was neither reused nor closed nor recognised as agent-owned.
let agentTabs = Object.create(null);

function agentEntry(agent) {
  const key = normaliseAgent(agent);
  if (!agentTabs[key]) agentTabs[key] = { current: null, tabs: [] };
  return agentTabs[key];
}

// Where to hand focus back to if anything ever has to foreground an agent tab.
let lastUserTabId = null;

// Opt-in via the popup. Off by default: the whole point is not to take over.
let stealFocus = false;

chrome.storage.local.get('bridgeStealFocus').then(({ bridgeStealFocus }) => {
  stealFocus = !!bridgeStealFocus;
}).catch(() => {});

// Rehydrate on every worker start, so the popup and getAllTabs know which tabs
// belong to which agent before any command has run.
chrome.storage.session.get('agentTabs').then(({ agentTabs: stored }) => {
  if (!stored || typeof stored !== 'object') return;
  for (const [agent, value] of Object.entries(stored)) {
    if (agentTabs[agent]) continue;
    // Tolerate the older single-id shape so a worker restart mid-upgrade does
    // not lose the tab and strand it outside the group.
    agentTabs[agent] = (value && typeof value === 'object')
      ? { current: value.current || null, tabs: Array.isArray(value.tabs) ? value.tabs : [] }
      : { current: value || null, tabs: value ? [value] : [] };
  }
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
async function persistAgentTabs() {
  try {
    await chrome.storage.session.set({ agentTabs: { ...agentTabs } });
  } catch (e) { /* session storage unavailable */ }
}

async function rememberAgentTab(agent, tabId, makeCurrent = true) {
  const entry = agentEntry(agent);
  if (!entry.tabs.includes(tabId)) entry.tabs.push(tabId);
  if (makeCurrent) entry.current = tabId;
  await persistAgentTabs();
}

/** Called when a tab closes, so it is keyed by tab rather than by agent. */
async function forgetAgentTab(tabId) {
  let changed = false;
  for (const entry of Object.values(agentTabs)) {
    const idx = entry.tabs.indexOf(tabId);
    if (idx !== -1) {
      entry.tabs.splice(idx, 1);
      changed = true;
    }
    if (entry.current === tabId) {
      // Promote a sibling rather than dropping to null, so closing the active
      // agent tab mid-task does not force a brand new one to be created.
      entry.current = entry.tabs.length ? entry.tabs[entry.tabs.length - 1] : null;
      changed = true;
    }
  }
  if (changed) await persistAgentTabs();
}

function agentOwning(tabId) {
  for (const [agent, entry] of Object.entries(agentTabs)) {
    if (entry.tabs.includes(tabId)) return agent;
  }
  return null;
}

function allAgentTabIds() {
  return Object.values(agentTabs).flatMap((e) => e.tabs);
}

async function recallAgentTab(agent) {
  try {
    const { agentTabs: stored } = await chrome.storage.session.get('agentTabs');
    const value = stored && stored[normaliseAgent(agent)];
    const ids = (value && typeof value === 'object')
      ? [value.current, ...(value.tabs || [])]
      : [value];
    for (const tabId of ids) {
      if (!tabId) continue;
      const tab = await getTabOrNull(tabId);
      if (tab) return tab;
    }
  } catch (e) { /* fall through to the group lookup */ }
  return null;
}

/**
 * Only this agent's own group is considered. Matching any agent's group would
 * hand one agent the other's tab after a service-worker restart, which is the
 * collision this split exists to prevent.
 */
async function findGroupedAgentTab(agent) {
  if (!chrome.tabGroups) return null;
  const { title } = getAgentStyle(agent);
  const claimed = new Set(allAgentTabIds());
  try {
    const groups = await chrome.tabGroups.query({ title });
    for (const group of groups) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const free = tabs.filter((t) => !claimed.has(t.id));
      if (free.length) {
        return free.find((t) => isAutomatable(t.url)) || free[0];
      }
    }
  } catch (e) { /* tabGroups unavailable */ }
  return null;
}

/**
 * Put a tab into this agent's group, reusing that group when it already exists
 * in the same window. Creating a group per tab was giving N tabs = N groups.
 *
 * Title and colour are only written when the group is created. Rewriting them on
 * every join churned the tab strip and would clobber a rename by the user.
 */
async function attachToAgentGroup(tabId, requestedAgent = DEFAULT_AGENT) {
  if (!chrome.tabGroups || !tabId) return;

  const style = getAgentStyle(requestedAgent);
  const ungrouped = chrome.tabGroups.TAB_GROUP_ID_NONE;

  try {
    const tab = await getTabOrNull(tabId);
    if (!tab) return;

    // Already in a correctly titled group in this window: nothing to do.
    if (tab.groupId && tab.groupId !== ungrouped && tab.groupId !== -1) {
      let current = null;
      try { current = await chrome.tabGroups.get(tab.groupId); } catch (e) { /* gone */ }
      if (current && current.title === style.title) return;

      const otherAgentsGroup = current && current.title
        && Object.values(AGENT_STYLES).some((s) => s.title === current.title);
      if (otherAgentsGroup) {
        await chrome.tabs.ungroup(tab.id);
      }
    }

    // Reuse this agent's existing group in the same window if there is one. The
    // query can return a group that has since been emptied and dropped, so the
    // join is retried as a fresh group rather than failing the command.
    let existing = null;
    try {
      const groups = await chrome.tabGroups.query({ title: style.title, windowId: tab.windowId });
      existing = groups && groups[0];
    } catch (e) { /* fall through to creating one */ }

    if (existing) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
        return;
      } catch (e) { /* group vanished between query and join */ }
    }

    const groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: tab.windowId }
    });
    await chrome.tabGroups.update(groupId, {
      title: style.title,
      color: style.color,
      collapsed: false
    });
  } catch (e) {
    console.warn('[bridge] could not place tab in the agent group:', e && e.message);
  }
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

async function ensureAgentTab(agentName = DEFAULT_AGENT) {
  const agent = normaliseAgent(agentName);

  const entry = agentEntry(agent);

  let tab = await getTabOrNull(entry.current);
  if (tab) {
    await attachToAgentGroup(tab.id, agent);
    return { tab, source: 'memory', agent };
  }

  // The current tab is gone but a sibling this agent opened may still be alive.
  // Reusing it is what stops a closed tab from forcing a brand new one.
  for (const candidate of [...entry.tabs].reverse()) {
    tab = await getTabOrNull(candidate);
    if (tab) {
      await rememberAgentTab(agent, tab.id);
      await attachToAgentGroup(tab.id, agent);
      return { tab, source: 'sibling', agent };
    }
  }

  // Drop ids that no longer resolve, so the list does not grow forever.
  if (entry.tabs.length) {
    entry.tabs = [];
    entry.current = null;
    await persistAgentTabs();
  }

  tab = await recallAgentTab(agent);
  if (tab) {
    await rememberAgentTab(agent, tab.id);
    await attachToAgentGroup(tab.id, agent);
    return { tab, source: 'session', agent };
  }

  tab = await findGroupedAgentTab(agent);
  if (tab) {
    await rememberAgentTab(agent, tab.id);
    await attachToAgentGroup(tab.id, agent);
    return { tab, source: 'group', agent };
  }

  const windowId = await pickHostWindowId();
  const created = await chrome.tabs.create({
    url: 'about:blank',
    active: false,               // never pull focus off the user's tab
    ...(windowId ? { windowId } : {})
  });
  await rememberAgentTab(agent, created.id);
  await attachToAgentGroup(created.id, agent);

  return { tab: (await getTabOrNull(created.id)) || created, source: 'created', agent };
}

function agentFor(cmd) {
  return normaliseAgent(cmd?.agent_name || cmd?.client);
}

async function getTargetTab(cmd) {
  const agent = agentFor(cmd);

  if (cmd && cmd.tab_id) {
    const found = await getTabOrNull(cmd.tab_id);
    if (found) return { tab: found, source: 'tab_id', agent };
    return { tab: null, source: 'tab_id_missing', agent };
  }

  // Deliberately no "any tab will do" fallback. Driving a tab the user is
  // using, without being asked to, is worse than returning an error.
  return ensureAgentTab(agent);
}

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    group_id: t.groupId,
    agent: agentOwning(t.id) !== null,
    agent_name: agentOwning(t.id) || undefined
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

const MODIFIER_MASKS = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8
};

function parseModifiers(mods) {
  if (!mods) return 0;
  if (typeof mods === 'string') mods = mods.split(/[+,|]/).map((s) => s.trim());
  let mask = 0;
  for (const m of mods) {
    const key = String(m).toLowerCase();
    if (MODIFIER_MASKS[key]) mask |= MODIFIER_MASKS[key];
  }
  return mask;
}

async function sendKey(tabId, key, modifiers = []) {
  await attachDebugger(tabId);
  const modMask = parseModifiers(modifiers);
  let def = KEY_MAP[key];
  if (!def) {
    if (key && key.length === 1) {
      const char = key.toUpperCase();
      const code = /^[A-Z]$/.test(char) ? ('Key' + char) : (/^[0-9]$/.test(char) ? ('Digit' + char) : 'Unidentified');
      const vkey = char.charCodeAt(0);
      def = { windowsVirtualKeyCode: vkey, code, key, text: key, unmodifiedText: key };
    } else {
      throw new Error(`Unsupported key: ${key}`);
    }
  }
  await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def, modifiers: modMask });
  if (def.text && !modMask) {
    await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: def.text, unmodifiedText: def.unmodifiedText || def.text, modifiers: modMask });
  }
  await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def, modifiers: modMask });
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
// Element discovery (set-of-marks): multi-frame indexing across all frames
// including cross-origin Out-of-Process Iframes (OOPIFs).
// Exposes elements on window.__agent_elements and caches in tabElements.
// ---------------------------------------------------------------------------

/**
 * Tell every frame where it sits in the top-level viewport.
 *
 * A cross-origin frame cannot measure its own position, so each parent measures
 * its iframes and posts the offset down. The receiving side must not trust just
 * any message: a page can postMessage a fake offset to itself or to a frame it
 * embeds, and every click computed from that offset then lands somewhere else.
 * With a hostile page spamming fake offsets, clicks were shifted by exactly the
 * amount it chose, including in the top frame.
 *
 * So a message is only accepted when:
 *   - this is not the top frame. The top frame defines the coordinate space and
 *     is always at 0,0; nothing may move it.
 *   - it comes from this frame's own parent window.
 *   - it carries this scan's nonce. The nonce is written into each frame's
 *     isolated world, which page scripts cannot read, and is fresh per scan.
 *
 * The listener is installed here rather than in content.js so it exists in every
 * frame, including frames loaded before the extension was last reloaded.
 */
const PREPARE_FRAME = (nonce) => {
  window.__kiro_nonce = nonce;
  window.__kiro_frame_offset = (window === window.top) ? { x: 0, y: 0 } : null;

  if (window.__kiro_pos_listener) return;
  window.__kiro_pos_listener = true;

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || d.type !== '__kiro_frame_pos') return;
    if (window === window.top) return;
    if (event.source !== window.parent) return;
    if (!window.__kiro_nonce || d.nonce !== window.__kiro_nonce) return;
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return;

    window.__kiro_frame_offset = { x: d.x, y: d.y };

    for (const f of document.querySelectorAll('iframe')) {
      try {
        const r = f.getBoundingClientRect();
        // clientLeft/Top is the iframe's border: content starts inside it.
        f.contentWindow && f.contentWindow.postMessage({
          type: '__kiro_frame_pos',
          nonce: d.nonce,
          x: d.x + r.left + f.clientLeft,
          y: d.y + r.top + f.clientTop
        }, '*');
      } catch (e) { /* detached frame */ }
    }
  });
};

const POST_TOP_OFFSETS = (nonce) => {
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const r = f.getBoundingClientRect();
      f.contentWindow && f.contentWindow.postMessage({
        type: '__kiro_frame_pos',
        nonce,
        x: r.left + f.clientLeft,
        y: r.top + f.clientTop
      }, '*');
    } catch (e) { /* detached frame */ }
  }
};

function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function cascadeFramePositions(tabId) {
  const nonce = makeNonce();
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: PREPARE_FRAME,
      args: [nonce]
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: POST_TOP_OFFSETS,
      args: [nonce]
    });

    // Offsets arrive asynchronously and cascade one level at a time, so wait
    // until every frame has one rather than guessing with a fixed pause.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => !!window.__kiro_frame_offset
      });
      if (res.every((r) => r.result)) break;
    }
  } catch (e) { /* annotate reports frames without an offset */ }
}

/**
 * What counts as interactive. Beyond native controls and ARIA widgets this
 * covers the custom tags Angular Material (mat-*) and Google's ACX components
 * (material-*) use for radios, checkboxes and toggles - the Play Console's
 * questionnaires are material-radio groups, which had no badges at all - and
 * <label>, which is only kept when it actually controls an input.
 *
 * Shared by the scanner and by click-by-text, so both agree on what exists.
 */
const INTERACTIVE_SEL = 'a, button, input, select, textarea, summary, label, ' +
  '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
  '[role="menuitemradio"], [role="menuitemcheckbox"], ' +
  '[role="combobox"], [role="listbox"], [role="option"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], ' +
  'material-radio, material-checkbox, material-toggle, ' +
  'mat-radio-button, mat-checkbox, mat-slide-toggle, ' +
  '[contenteditable="true"], [tabindex]:not([tabindex="-1"])';

const COLLECT_FRAME_ELEMENTS = (SEL) => {
  window.__agent_elements = {};

  // A subframe whose position never arrived must not be treated as sitting at
  // 0,0 - its elements would be clicked at the wrong place. They are still
  // listed, since form_input and select_option work inside the frame and do not
  // need coordinates, but flagged so click refuses them.
  const offset = window.__kiro_frame_offset;
  const coordsUnknown = !offset;
  const dx = offset ? offset.x : 0;
  const dy = offset ? offset.y : 0;

  // Open shadow roots are walked as well as the document. querySelectorAll
  // stops at a shadow boundary, so web-component UIs showed only their hosts.
  // Closed shadow roots cannot be entered from script by design.
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 500; i++) {
    for (const node of roots[i].querySelectorAll('*')) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }

  const isToggleInput = (el) => el.tagName === 'INPUT' &&
    /^(radio|checkbox)$/i.test(el.getAttribute('type') || '');

  // aria-labelledby ids resolve within the element's own tree, which for a
  // shadow DOM element is its shadow root, not the document.
  const byIds = (root, ids) => ids.split(/\s+/).map((id) => {
    const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
    return n ? n.innerText || n.textContent || '' : '';
  }).join(' ');

  const labelOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    const elRoot = el.getRootNode ? el.getRootNode() : document;
    // A native radio's own value is usually just "on" or "yes"; the words the
    // user reads are in its <label>.
    const fromLabels = isToggleInput(el) && el.labels && el.labels.length
      ? Array.from(el.labels).map((l) => l.innerText).join(' ') : '';
    return (
      el.getAttribute('aria-label') ||
      (labelled ? byIds(elRoot, labelled) : '') ||
      fromLabels ||
      el.innerText ||
      el.value ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('name') || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 80);
  };

  // Checked state, so an agent can confirm a radio or checkbox took the click
  // without a screenshot.
  const checkedOf = (el) => {
    if (isToggleInput(el)) return el.checked;
    if (el.tagName === 'LABEL' && el.control && isToggleInput(el.control)) return el.control.checked;
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    if (aria === 'mixed') return 'mixed';
    if (/^(MATERIAL|MAT)-/.test(el.tagName)) {
      const inner = el.querySelector('input[type="radio"], input[type="checkbox"]') ||
        (el.shadowRoot && el.shadowRoot.querySelector('input[type="radio"], input[type="checkbox"]'));
      if (inner) return inner.checked;
      if (el.hasAttribute('checked')) return true;
      if (/(^|\s)(mat-(mdc-)?(radio|checkbox)-checked|checked)(\s|$)/.test(el.className || '')) return true;
      return false;
    }
    return undefined;
  };

  const isHidden = (el, r, st) =>
    r.width <= 1 || r.height <= 1 ||
    st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0' ||
    st.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(st.clipPath || '');

  const PROXY_SEL = 'material-radio, material-checkbox, material-toggle, mat-radio-button, ' +
    'mat-checkbox, mat-slide-toggle, [role="radio"], [role="checkbox"], [role="switch"], label';

  const entries = [];         // numbered at the end, after duplicates are dropped
  const seen = new Set();
  const recent = [];          // last few indexed, for nested-duplicate detection

  for (const root of roots) {
    for (const el of root.querySelectorAll(SEL)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.disabled) continue;
      // A <label> that controls nothing is just text.
      if (el.tagName === 'LABEL' && !el.control) continue;

      let st;
      try { st = window.getComputedStyle(el); } catch (e) { continue; }
      let r = el.getBoundingClientRect();
      let clickVia = null;

      if (isHidden(el, r, st)) {
        if (!isToggleInput(el)) continue;
        // Visually-hidden native radio or checkbox, styled by something else.
        // Its label or custom wrapper is what the user sees and clicks, and is
        // indexed in its own right - so skip the input rather than badge it
        // twice. Only an input with no visible stand-in is kept, and it is
        // clicked by script since it has no usable coordinates.
        const proxy = (el.labels && el.labels[0]) || el.closest(PROXY_SEL);
        if (proxy && proxy !== el) {
          const pr = proxy.getBoundingClientRect();
          let pst = null;
          try { pst = window.getComputedStyle(proxy); } catch (e) { /* detached */ }
          if (pst && !isHidden(proxy, pr, pst)) continue;
        }
        clickVia = 'script';
      }

      const left = r.left + dx, top = r.top + dy;
      // Top frame: skip what is scrolled entirely out of view.
      if (!clickVia && window === window.top && (top + r.height < 0 || top > window.innerHeight)) continue;

      const cx = Math.round(left + r.width / 2);
      const cy = Math.round(top + r.height / 2);

      // Nested wrappers around one control (a material-radio host and the
      // role="radio" inside it) would give two badges on the same spot.
      // Document order puts the outer one first; keep it.
      if (!clickVia && recent.some((p) =>
        (p.el.contains(el) || el.contains(p.el)) &&
        Math.abs(p.cx - cx) <= 4 && Math.abs(p.cy - cy) <= 4)) {
        continue;
      }

      const checked = checkedOf(el);
      const selected = el.getAttribute('aria-selected');
      entries.push({ el, cx, cy, item: {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || el.getAttribute('role') || '',
        text: labelOf(el),
        href: (el.getAttribute('href') || '').slice(0, 200),
        x: cx,
        y: cy,
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        ...(checked !== undefined ? { checked } : {}),
        ...(selected === 'true' || selected === 'false' ? { selected: selected === 'true' } : {}),
        ...(root !== document ? { shadow: true } : {}),
        ...(clickVia ? { click_via: clickVia } : {}),
        ...(coordsUnknown ? { coords_unknown: true } : {})
      } });

      recent.push({ el, cx, cy });
      if (recent.length > 12) recent.shift();
    }
  }

  // A custom wrapper (mat-radio-button, material-checkbox...) that contains an
  // indexed control is the same control twice, and the wrapper is often a full
  // width block whose centre is empty space - clicking it does nothing. Keep
  // the inner control, which carries the same text and checked state.
  const indexedEls = entries.map((e) => e.el);
  const kept = entries.filter((e) => !(/^(MATERIAL|MAT)-/.test(e.el.tagName) &&
    indexedEls.some((o) => o !== e.el && e.el.contains(o))));

  const items = [];
  let localIdx = 1;
  for (const e of kept) {
    window.__agent_elements[localIdx] = { el: e.el, x: e.cx, y: e.cy };
    items.push({ localId: localIdx, ...e.item });
    localIdx++;
  }
  return items;
};

/**
 * Re-check a target against the live DOM immediately before acting on it.
 *
 * The element list is a snapshot from the last get_state, so checking a label
 * against it only proves the agent used the number it meant to - not that the
 * page still looks that way. A button that read "Save draft" at get_state and
 * "Delete everything" now passed a cached check. This reads the element as it
 * is at the moment of the action.
 *
 * With hitTest, it also confirms the element is what actually sits under its
 * click point, so a modal, toast or overlay covering it is caught instead of
 * receiving the click. Returns the live click point, which is fresher than the
 * cached one if the element has moved.
 *
 * Runs in whichever world the element list was built in, so it is kept free of
 * closures and can be serialised for Runtime.evaluate.
 */
const VERIFY_TARGET = (localId, expected, hitTest, containerLocalId) => {
  const reg = window.__agent_elements || {};
  const item = reg[localId];
  const el = item && item.el;
  if (!el) return { ok: false, error: 'element is no longer indexed - call get_state again' };
  if (!el.isConnected) return { ok: false, error: 'element was removed from the page since get_state' };

  if (expected !== null && expected !== undefined) {
    const live = (
      el.getAttribute('aria-label') || el.innerText || el.value ||
      el.getAttribute('placeholder') || el.getAttribute('title') ||
      el.getAttribute('name') || ''
    ).replace(/\s+/g, ' ').trim();
    const want = String(expected).trim().toLowerCase();
    if (!live.toLowerCase().includes(want)) {
      return {
        ok: false,
        error: `assert_text failed: element now reads "${live.slice(0, 80)}", expected "${expected}"`
      };
    }
  }

  if (containerLocalId !== null && containerLocalId !== undefined) {
    const cItem = reg[containerLocalId];
    const c = cItem && cItem.el;
    if (!c || !c.isConnected) return { ok: false, error: 'within container is no longer on the page' };
    if (c === el || !c.contains(el)) return { ok: false, error: 'target is not inside the within container' };
  }

  if (!hitTest) return { ok: true };

  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { ok: false, error: 'element is no longer visible' };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Hit-test in the element's own tree. For an element inside a shadow root,
  // document.elementFromPoint returns the host, which would read as "covered".
  const elRoot = el.getRootNode ? el.getRootNode() : document;
  const hit = (elRoot && elRoot.elementFromPoint ? elRoot : document).elementFromPoint(cx, cy);
  if (!hit) return { ok: false, error: 'element is scrolled out of view - scroll to it first' };
  // A <label> forwards its click to the control it labels, so landing on
  // either counts.
  const forwarded = el.tagName === 'LABEL' && el.control &&
    (hit === el.control || el.control.contains(hit));
  if (hit !== el && !el.contains(hit) && !forwarded) {
    const what = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '');
    return { ok: false, error: `click point is covered by <${what}> - not clicking` };
  }

  // The top frame is always at 0,0, including in the main-world fallback where
  // the offset was never written.
  const off = window.__kiro_frame_offset || (window === window.top ? { x: 0, y: 0 } : null);
  if (!off) return { ok: false, error: 'position of this frame is unknown - call get_state again' };
  return { ok: true, x: Math.round(cx + off.x), y: Math.round(cy + off.y) };
};

async function runInElementWorld(tabId, frameId, func, args) {
  if (tabElementWorld.get(tabId) === 'main') {
    // Built by the Runtime.evaluate fallback, so the registry lives in the
    // page's main world and an isolated-world lookup would find nothing.
    return evaluate(tabId, `(${func.toString()})(...${JSON.stringify(args)})`);
  }
  const res = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId || 0] },
    func,
    args
  });
  return res && res[0] ? res[0].result : null;
}

/**
 * Find click targets by CSS selector and/or visible text, in one frame.
 *
 * Text matching is where a wrong click comes from, so it is conservative. A
 * container's text includes every option inside it - a radio group matches the
 * text of each of its radios - so of a nested pair only the innermost match is
 * kept. Exact matches beat substring matches. The caller refuses anything still
 * ambiguous rather than picking one.
 *
 * Self-contained so it can run via chrome.scripting or Runtime.evaluate.
 */
const FIND_CLICK_TARGETS = (SEL, selector, text) => {
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 500; i++) {
    for (const n of roots[i].querySelectorAll('*')) if (n.shadowRoot) roots.push(n.shadowRoot);
  }
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const isToggleInput = (el) => el.tagName === 'INPUT' &&
    /^(radio|checkbox)$/i.test(el.getAttribute('type') || '');
  const isHidden = (el, r, st) =>
    r.width <= 1 || r.height <= 1 ||
    st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0' ||
    st.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(st.clipPath || '');
  const labelOf = (el) => {
    const rootNode = el.getRootNode ? el.getRootNode() : document;
    const ids = el.getAttribute('aria-labelledby');
    const byIds = ids ? ids.split(/\s+/).map((id) => {
      const n = rootNode.getElementById ? rootNode.getElementById(id) : null;
      return n ? n.innerText || n.textContent || '' : '';
    }).join(' ') : '';
    const fromLabels = isToggleInput(el) && el.labels && el.labels.length
      ? Array.from(el.labels).map((l) => l.innerText).join(' ') : '';
    return (el.getAttribute('aria-label') || byIds || fromLabels || el.innerText ||
      el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '')
      .replace(/\s+/g, ' ').trim();
  };
  const PROXY_SEL = 'material-radio, material-checkbox, material-toggle, mat-radio-button, ' +
    'mat-checkbox, mat-slide-toggle, [role="radio"], [role="checkbox"], [role="switch"], label';

  const found = new Set();
  for (const root of roots) {
    let list;
    try { list = root.querySelectorAll(selector || SEL); } catch (e) {
      return { error: `invalid CSS selector: ${selector}` };
    }
    for (const el of list) {
      if (el.disabled) continue;
      if (!selector && el.tagName === 'LABEL' && !el.control) continue;
      found.add(el);
    }
  }

  let matches = Array.from(found, (el) => ({ el, label: labelOf(el) }));
  const want = text ? norm(text) : null;
  if (want) {
    matches = matches.filter((m) => norm(m.label).includes(want));
    matches = matches.filter((m) => !matches.some((o) => o !== m && m.el.contains(o.el)));
  }

  // For a visually-hidden radio or checkbox, click what stands in for it.
  const resolved = matches.map((m) => {
    let box = m.el;
    let hidden = isHidden(box, box.getBoundingClientRect(), window.getComputedStyle(box));
    if (hidden && isToggleInput(m.el)) {
      const proxy = (m.el.labels && m.el.labels[0]) || m.el.closest(PROXY_SEL);
      if (proxy && proxy !== m.el &&
        !isHidden(proxy, proxy.getBoundingClientRect(), window.getComputedStyle(proxy))) {
        box = proxy;
        hidden = false;
      }
    }
    return { ...m, box, hidden };
  });

  // A hidden input whose stand-in also matched is the same control twice -
  // "Accept the terms" is both the checkbox's label text and the label itself.
  const matchedEls = new Set(resolved.map((m) => m.el));
  const unique = resolved.filter((m) => !(m.box !== m.el && matchedEls.has(m.box)));

  window.__kiro_pick = [];
  return {
    items: unique.map((m) => ({
      pick: window.__kiro_pick.push({ el: m.el, box: m.box }) - 1,
      label: m.label.slice(0, 80),
      tag: m.el.tagName.toLowerCase(),
      exact: want ? norm(m.label) === want : true,
      visible: !m.hidden
    }))
  };
};

/**
 * Act on a target chosen by FIND_CLICK_TARGETS, in the same frame.
 *   'point'  - live click point, with a hit-test so a covered target is refused
 *   'reveal' - scroll it into view
 *   'script' - element.click(), for controls with no usable box
 */
const PICK_ACT = (pickIdx, mode) => {
  const p = (window.__kiro_pick || [])[pickIdx];
  if (!p || !p.el.isConnected) return { ok: false, error: 'target disappeared - try again' };
  if (mode === 'script') { p.el.click(); return { ok: true }; }
  if (mode === 'reveal') { p.box.scrollIntoView({ block: 'center', inline: 'center' }); return { ok: true }; }

  const r = p.box.getBoundingClientRect();
  if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
    return { ok: false, needsReveal: true };
  }
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const rootNode = p.box.getRootNode ? p.box.getRootNode() : document;
  const hit = (rootNode && rootNode.elementFromPoint ? rootNode : document).elementFromPoint(cx, cy);
  const forwarded = p.box.tagName === 'LABEL' && p.box.control &&
    hit && (hit === p.box.control || p.box.control.contains(hit));
  if (!hit || (hit !== p.box && !p.box.contains(hit) && !forwarded)) {
    const what = hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : 'nothing';
    return { ok: false, error: `click point is covered by <${what}> - not clicking` };
  }
  const off = window.__kiro_frame_offset || (window === window.top ? { x: 0, y: 0 } : null);
  if (!off) return { ok: false, offsetUnknown: true };
  return { ok: true, x: Math.round(cx + off.x), y: Math.round(cy + off.y) };
};

/**
 * Click by CSS selector and/or visible text, across every frame. Prefers a real
 * mouse click at the element's live position, and falls back to element.click()
 * only for controls that have no box to click.
 */
async function clickByQuery(tabId, selector, text) {
  const what = [selector ? `selector ${JSON.stringify(selector)}` : '',
    text ? `text ${JSON.stringify(text)}` : ''].filter(Boolean).join(' and ');

  let world = 'isolated';
  let results;
  try {
    await cascadeFramePositions(tabId);
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: FIND_CLICK_TARGETS,
      args: [INTERACTIVE_SEL, selector || null, text || null]
    });
  } catch (e) {
    // No script access (e.g. file:// without the setting): top frame only.
    world = 'main';
    const r = await evaluate(tabId,
      `(${FIND_CLICK_TARGETS.toString()})(...${JSON.stringify([INTERACTIVE_SEL, selector || null, text || null])})`);
    results = [{ frameId: 0, result: r }];
  }

  const all = [];
  for (const { frameId, result } of results || []) {
    if (!result) continue;
    if (result.error) throw new Error(result.error);
    for (const it of result.items || []) all.push({ ...it, frameId: frameId || 0 });
  }
  if (!all.length) throw new Error(`nothing clickable matches ${what}`);

  let pool = all;
  if (text) {
    const exact = pool.filter((i) => i.exact);
    if (exact.length) pool = exact;
  }
  const visible = pool.filter((i) => i.visible);
  if (visible.length) pool = visible;

  if (pool.length > 1) {
    const list = pool.slice(0, 6)
      .map((i) => `"${i.label}" <${i.tag}>${i.frameId ? ' in frame' : ''}`).join('; ');
    throw new Error(`${pool.length} elements match ${what} - not guessing. Be more specific, ` +
      `or click by number. Matches: ${list}${pool.length > 6 ? '; ...' : ''}`);
  }

  const pick = pool[0];
  const act = async (mode) => {
    if (world === 'main') {
      return evaluate(tabId, `(${PICK_ACT.toString()})(${pick.pick}, ${JSON.stringify(mode)})`);
    }
    const r = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [pick.frameId] },
      func: PICK_ACT,
      args: [pick.pick, mode]
    });
    return r && r[0] ? r[0].result : null;
  };

  let method = 'mouse';
  if (!pick.visible) {
    const r = await act('script');
    if (!r || !r.ok) throw new Error((r && r.error) || 'could not click target');
    method = 'script';
  } else {
    let pt = await act('point');
    if (pt && pt.needsReveal) {
      await act('reveal');
      // Scrolling can move the frame itself, so re-measure before clicking.
      if (world === 'isolated') await cascadeFramePositions(tabId);
      pt = await act('point');
    }
    if (pt && pt.offsetUnknown) {
      const r = await act('script');
      if (!r || !r.ok) throw new Error((r && r.error) || 'could not click target');
      method = 'script';
    } else if (!pt || !pt.ok) {
      throw new Error((pt && pt.error) || 'could not locate target');
    } else {
      await clickAt(tabId, pt.x, pt.y);
    }
  }

  return {
    clicked: pick.label,
    tag: pick.tag,
    in_frame: pick.frameId !== 0,
    method,
    matched_by: selector && text ? 'selector+text' : selector ? 'selector' : 'text'
  };
}

/** Throws with a precise reason if the target fails any requested check. */
async function verifyTarget(tabId, targetElement, { expected = null, hitTest = false, container = null } = {}) {
  if (!targetElement) {
    throw new Error('target has no entry in the element list - call get_state first');
  }
  if (container && container.frameId !== targetElement.frameId) {
    throw new Error('target is not inside the within container (they are in different frames)');
  }
  const res = await runInElementWorld(tabId, targetElement.frameId, VERIFY_TARGET, [
    targetElement.localId,
    expected,
    hitTest,
    container ? container.localId : null
  ]);
  if (!res || !res.ok) throw new Error((res && res.error) || 'could not verify target');
  return res;
}

const ANNOTATE_JS = `
(() => {
  window.__agent_elements = {};
  // Same set as the all-frames scanner, so the fallback does not quietly
  // drop the custom controls.
  const SEL = ${JSON.stringify(INTERACTIVE_SEL)};

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
      if (el.tagName === 'LABEL' && !el.control) continue;

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
        y: cy,
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      });
      i++;
    }
  }
  return items;
})()
`;

async function annotate(tabId) {
  lastScanError.delete(tabId);
  try {
    await cascadeFramePositions(tabId);

    const injectionResults = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: COLLECT_FRAME_ELEMENTS,
        args: [INTERACTIVE_SEL]
      }),
      2500,
      'annotate executeScript'
    ).catch((e) => {
      lastScanError.set(tabId, String((e && e.message) || e));
      return null;
    });

    if (injectionResults && injectionResults.length > 0) {
      const elementMap = new Map();
      const allItems = [];
      let globalId = 1;

      // Process top frame (frameId 0) first, then subframes in stable order
      const sorted = [...injectionResults].sort((a, b) => (a.frameId || 0) - (b.frameId || 0));

      for (const { frameId, result } of sorted) {
        if (!Array.isArray(result)) continue;
        for (const item of result) {
          const assignedId = globalId++;
          const fullItem = {
            ...item,
            id: assignedId,
            frameId: frameId || 0
          };
          allItems.push(fullItem);
          elementMap.set(assignedId, fullItem);
        }
      }

      tabElements.set(tabId, elementMap);
      tabElementWorld.set(tabId, 'isolated');
      persistTabElements(tabId, 'isolated', allItems);
      return allItems;
    }
  } catch (e) {
    // Fall back to evaluate if executeScript fails (e.g. on chrome:// or about:blank)
    lastScanError.set(tabId, String((e && e.message) || e));
  }

  try {
    const fallbackItems = (await evaluate(tabId, ANNOTATE_JS)) || [];
    const elementMap = new Map();
    const stored = [];
    for (const it of fallbackItems) {
      const entry = { ...it, frameId: 0, localId: it.id };
      elementMap.set(it.id, entry);
      stored.push(entry);
    }
    tabElements.set(tabId, elementMap);
    tabElementWorld.set(tabId, 'main');
    persistTabElements(tabId, 'main', stored);
    return fallbackItems;
  } catch (e) {
    return [];
  }
}

async function readContent(tabId, maxLength = 25000) {
  try {
    const injectionResults = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (maxLen) => {
          const clone = document.body ? document.body.cloneNode(true) : null;
          if (!clone) return { title: document.title, url: window.location.href, content: '' };
          clone.querySelectorAll('script, style, noscript, svg, canvas, iframe, [aria-hidden="true"]').forEach(el => el.remove());

          function nodeToMd(node) {
            if (node.nodeType === Node.TEXT_NODE) {
              return node.textContent.replace(/\s+/g, ' ');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            const tag = node.tagName.toLowerCase();
            let text = '';
            for (const child of node.childNodes) {
              text += nodeToMd(child);
            }
            text = text.trim();
            if (!text) return '';

            if (/^h[1-6]$/.test(tag)) {
              const level = parseInt(tag[1], 10);
              return '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n';
            }
            if (tag === 'p') return '\n\n' + text + '\n\n';
            if (tag === 'li') return '\n* ' + text;
            if (tag === 'blockquote') return '\n> ' + text + '\n';
            if (tag === 'pre' || tag === 'code') return '\n```\n' + node.innerText + '\n```\n';
            if (tag === 'a') {
              const href = node.getAttribute('href');
              return href ? '[' + text + '](' + href + ')' : text;
            }
            if (tag === 'tr') return text + ' |\n';
            if (tag === 'th' || tag === 'td') return '| ' + text + ' ';
            return text;
          }

          const md = nodeToMd(clone).replace(/\n{3,}/g, '\n\n').trim();
          return {
            title: document.title,
            url: window.location.href,
            content: md.slice(0, maxLen)
          };
        },
        args: [maxLength]
      }),
      2500,
      'readContent executeScript'
    ).catch(() => null);

    if (injectionResults && injectionResults.length > 0) {
      const topResult = injectionResults.find(r => r.frameId === 0 && r.result)?.result
        || injectionResults[0].result;
      const subResults = injectionResults.filter(r => r.frameId !== 0 && r.result && r.result.content);

      let combinedContent = topResult?.content || '';
      for (const sub of subResults) {
        const subTitle = sub.result.title || sub.result.url || 'Subframe';
        combinedContent += `\n\n---\n### [Frame] ${subTitle}\n${sub.result.content}`;
      }

      return {
        title: topResult?.title || '',
        url: topResult?.url || '',
        content: combinedContent.slice(0, maxLength)
      };
    }
  } catch (e) {}

  const js = `
  (() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg, canvas, iframe, [aria-hidden="true"]').forEach(el => el.remove());

    function nodeToMd(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\\s+/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      let text = '';
      for (const child of node.childNodes) {
        text += nodeToMd(child);
      }
      text = text.trim();
      if (!text) return '';

      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        return '\\n\\n' + '#'.repeat(level) + ' ' + text + '\\n\\n';
      }
      if (tag === 'p') return '\\n\\n' + text + '\\n\\n';
      if (tag === 'li') return '\\n* ' + text;
      if (tag === 'blockquote') return '\\n> ' + text + '\\n';
      if (tag === 'pre' || tag === 'code') return '\\n\`\`\`\\n' + node.innerText + '\\n\`\`\`\\n';
      if (tag === 'a') {
        const href = node.getAttribute('href');
        return href ? '[' + text + '](' + href + ')' : text;
      }
      if (tag === 'tr') return text + ' |\\n';
      if (tag === 'th' || tag === 'td') return '| ' + text + ' ';
      return text;
    }

    const md = nodeToMd(clone).replace(/\\n{3,}/g, '\\n\\n').trim();
    return {
      title: document.title,
      url: window.location.href,
      content: md.slice(0, ${JSON.stringify(maxLength)})
    };
  })()
  `;
  return await evaluate(tabId, js);
}

async function selectOption(tabId, target, valueOrText) {
  const targetStr = String(target);
  let frameId = 0;
  let lookupTarget = targetStr;

  if (/^\d+$/.test(targetStr)) {
    const targetNum = parseInt(targetStr, 10);
    const elementsForTab = await getTabElements(tabId);
    if (elementsForTab && elementsForTab.has(targetNum)) {
      const item = elementsForTab.get(targetNum);
      frameId = item.frameId || 0;
      lookupTarget = item.localId;
    }
  }

  try {
    // Numbered elements from the Runtime.evaluate fallback are registered in the
    // main world. Looking them up here, in the isolated world, finds nothing and
    // returns a definite "element not found" that skips the working path below.
    if (/^\d+$/.test(targetStr) && tabElementWorld.get(tabId) === 'main') {
      throw new Error('element registry is in the main world');
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (t, valText) => {
        const needle = String(valText).toLowerCase();
        let el = null;
        if (typeof t === 'number' || /^\d+$/.test(String(t))) {
          const item = window.__agent_elements && window.__agent_elements[parseInt(t, 10)];
          el = item && item.el;
        }
        if (!el) el = document.querySelector(String(t));
        if (!el) return { error: 'element not found: ' + t };

        if (el.tagName.toLowerCase() === 'select') {
          let matched = null;
          for (const opt of el.options) {
            if (opt.value.toLowerCase() === needle || opt.text.trim().toLowerCase().includes(needle)) {
              matched = opt;
              break;
            }
          }
          if (!matched) return { error: 'option not found in select: ' + needle };
          el.value = matched.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, selected: matched.text };
        }

        el.click();
        return { ok: true, clicked: true, note: 'opened dropdown - select matching badge next' };
      },
      args: [lookupTarget, valueOrText || '']
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
  } catch (e) {}

  const js = `
  (() => {
    const t = ${JSON.stringify(targetStr)};
    const needle = ${JSON.stringify(String(valueOrText).toLowerCase())};
    let el = null;
    if (/^\\d+$/.test(t)) {
      const item = window.__agent_elements && window.__agent_elements[parseInt(t, 10)];
      el = item && item.el;
    }
    if (!el) el = document.querySelector(t);
    if (!el) return { error: 'element not found: ' + t };

    if (el.tagName.toLowerCase() === 'select') {
      let matched = null;
      for (const opt of el.options) {
        if (opt.value.toLowerCase() === needle || opt.text.trim().toLowerCase().includes(needle)) {
          matched = opt;
          break;
        }
      }
      if (!matched) return { error: 'option not found in select: ' + needle };
      el.value = matched.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: matched.text };
    }

    el.click();
    return { ok: true, clicked: true, note: 'opened dropdown - select matching badge next' };
  })()
  `;
  return await evaluate(tabId, js);
}

/**
 * Set a form field's value in a way React/Angular/Vue actually notice.
 * Supports elements inside cross-origin Out-of-Process Iframes (OOPIFs).
 */
async function formInput(tabId, target, value) {
  const targetStr = String(target);
  let frameId = 0;
  let lookupTarget = targetStr;

  if (/^\d+$/.test(targetStr)) {
    const targetNum = parseInt(targetStr, 10);
    const elementsForTab = await getTabElements(tabId);
    if (elementsForTab && elementsForTab.has(targetNum)) {
      const item = elementsForTab.get(targetNum);
      frameId = item.frameId || 0;
      lookupTarget = item.localId;
    }
  }

  try {
    // Numbered elements from the Runtime.evaluate fallback are registered in the
    // main world. Looking them up here, in the isolated world, finds nothing and
    // returns a definite "element not found" that skips the working path below.
    if (/^\d+$/.test(targetStr) && tabElementWorld.get(tabId) === 'main') {
      throw new Error('element registry is in the main world');
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (t, val) => {
        let el = null;
        if (typeof t === 'number' || /^\d+$/.test(String(t))) {
          const item = window.__agent_elements && window.__agent_elements[parseInt(t, 10)];
          el = item ? item.el : null;
        } else {
          el = document.querySelector(String(t));
        }
        if (!el) return { success: false, error: 'element not found: ' + t };

        el.scrollIntoView({ block: 'center' });
        el.focus();

        const v = String(val);
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');

        if (desc && desc.set) { desc.set.call(el, v); } else { el.value = v; }

        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, value: el.value };
      },
      args: [lookupTarget, value || '']
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
  } catch (e) {}

  const js = `
  (() => {
    const t = ${JSON.stringify(targetStr)};
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

  const activeAgent = agentFor(cmd);

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

    // What an action actually did, when that is not obvious from the page - for
    // example which element a click-by-text resolved to.
    let actionInfo = null;

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
          let pt = null;
          let targetElement = null;
          const targetNum = parseInt(cmd.target, 10);
          const elementsForTab = await getTabElements(tabId);
          if (elementsForTab && elementsForTab.has(targetNum)) {
            targetElement = elementsForTab.get(targetNum);
            pt = { x: targetElement.x, y: targetElement.y };
          } else {
            pt = await evaluate(tabId, `(() => {
              const it = window.__agent_elements && window.__agent_elements[${targetNum}];
              return it ? { x: it.x, y: it.y } : null;
            })()`);
          }
          if (!pt) throw new Error(`element [${cmd.target}] not found - call get_state first`);

          // A visually-hidden control with nothing standing in for it has no box
          // to click, so it is clicked by script. assert_text is still checked
          // against the live element first.
          if (targetElement && targetElement.click_via === 'script') {
            if (cmd.assert_text) await verifyTarget(tabId, targetElement, { expected: cmd.assert_text });
            const done = await runInElementWorld(tabId, targetElement.frameId, (localId) => {
              const it = window.__agent_elements && window.__agent_elements[localId];
              if (!it || !it.el || !it.el.isConnected) return false;
              it.el.click();
              return true;
            }, [targetElement.localId]);
            if (!done) throw new Error(`element [${cmd.target}] is no longer on the page - call get_state again`);
            actionInfo = { clicked: targetElement.text, tag: targetElement.tag, method: 'script' };
            await new Promise((r) => setTimeout(r, 400));
            break;
          }

          if (targetElement && targetElement.coords_unknown) {
            throw new Error(`element [${cmd.target}] is in a frame whose position could not be ` +
              'confirmed, so its click point is unknown - call get_state again');
          }

          // assert_text and within are checked against the live page, not the
          // snapshot, and include a hit-test so a covered element is refused.
          const wantsWithin = cmd.within !== undefined && cmd.within !== null && cmd.within !== '';
          if (cmd.assert_text || wantsWithin) {
            let container = null;
            if (wantsWithin) {
              container = elementsForTab && elementsForTab.get(parseInt(cmd.within, 10));
              if (!container) throw new Error(`within container [${cmd.within}] not found - call get_state first`);
            }
            const live = await verifyTarget(tabId, targetElement, {
              expected: cmd.assert_text || null,
              hitTest: true,
              container
            });
            pt = { x: live.x, y: live.y };
          }

          // If the element belongs to a subframe, focus it in that frame
          if (targetElement && targetElement.frameId) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId, frameIds: [targetElement.frameId] },
                func: (localId) => {
                  const it = window.__agent_elements && window.__agent_elements[localId];
                  if (it && it.el && typeof it.el.focus === 'function') it.el.focus();
                },
                args: [targetElement.localId]
              });
            } catch (e) {}
          }
          await clickAt(tabId, pt.x, pt.y);
        } else if (cmd.selector || (typeof cmd.text === 'string' && cmd.text.trim())) {
          // Click by CSS selector and/or visible text - for controls the badge
          // scan missed, and for when the text is known but the number is not.
          actionInfo = await clickByQuery(tabId, cmd.selector || null, cmd.text || null);
        } else if (cmd.x !== undefined && cmd.y !== undefined) {
          // The bridge has already converted these from screenshot pixels to CSS
          // pixels, unless the caller said they were CSS already.
          await clickAt(tabId, cmd.x, cmd.y);
        } else {
          throw new Error('click requires target, selector, text, or x/y');
        }
        await new Promise((r) => setTimeout(r, 600));
        break;
      }

      case 'form_input': {
        const targetNum = parseInt(cmd.target, 10);
        const elementsForTab = await getTabElements(tabId);
        const targetElement = elementsForTab && elementsForTab.get(targetNum);

        // Checked against the live page. No hit-test: the value is set
        // programmatically, so an overlay does not intercept it.
        if (cmd.assert_text) {
          await verifyTarget(tabId, targetElement, { expected: cmd.assert_text });
        }

        const r = await formInput(tabId, cmd.target, cmd.text || '');
        if (r && r.success === false) throw new Error(r.error);

        // Atomic Enter
        if (cmd.enter) {
          await sendKey(tabId, 'Enter');
        }
        await new Promise((r2) => setTimeout(r2, 250));
        break;
      }

      case 'type': {
        if (cmd.target !== undefined && cmd.target !== '') {
          const targetNum = parseInt(cmd.target, 10);
          const elementsForTab = await getTabElements(tabId);
          if (elementsForTab && elementsForTab.has(targetNum)) {
            const targetElement = elementsForTab.get(targetNum);
            if (targetElement && targetElement.frameId) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId, frameIds: [targetElement.frameId] },
                  func: (localId) => {
                    const it = window.__agent_elements && window.__agent_elements[localId];
                    if (it && it.el && typeof it.el.focus === 'function') it.el.focus();
                  },
                  args: [targetElement.localId]
                });
              } catch (e) {}
            }
          }
        }
        await typeText(tabId, cmd.text || '', !!cmd.enter);
        await new Promise((r) => setTimeout(r, 500));
        break;
      }

      case 'key':
        await sendKey(tabId, cmd.key || 'Enter', cmd.modifiers || []);
        await new Promise((r) => setTimeout(r, 350));
        break;

      case 'select_option': {
        if (!cmd.target) throw new Error('select_option requires target');
        const r = await selectOption(tabId, cmd.target, cmd.value || cmd.text || '');
        if (r && r.error) throw new Error(r.error);
        await new Promise((r2) => setTimeout(r2, 400));
        break;
      }

      case 'read_content': {
        const data = await readContent(tabId, cmd.max_length || 25000);
        return {
          status: 'ok',
          content: data.content,
          title: data.title,
          url: data.url,
          tab: {
            id: tabId, title: tab.title, url: tab.url,
            agent: agentOwning(tabId) !== null,
            agent_name: agentOwning(tabId) || activeAgent
          }
        };
      }

      case 'get_errors': {
        return {
          status: 'ok',
          errors: tabErrors.get(tabId) || [],
          tab: {
            id: tabId, title: tab.title, url: tab.url,
            agent: agentOwning(tabId) !== null,
            agent_name: agentOwning(tabId) || activeAgent
          }
        };
      }

      case 'ensure_tab': {
        // getTargetTab already ran ensureAgentTab, so the tab exists by now.
        // 'created' means there was nothing to reuse; anything else is a reuse.
        const current = await chrome.tabs.get(tabId);
        return {
          status: 'ok',
          reused: tabSource !== 'created',
          tab: {
            id: current.id,
            title: current.title,
            url: current.url,
            agent: true,
            agent_name: activeAgent,
            source: tabSource
          },
          tabs: await getAllTabs()
        };
      }

      case 'new_tab': {
        const windowId = await pickHostWindowId();
        let url = cmd.url || 'about:blank';
        if (url !== 'about:blank' && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        const created = await chrome.tabs.create({
          url,
          active: false,
          ...(windowId ? { windowId } : {})
        });
        // Joins this agent's existing group rather than making another one, and
        // is tracked alongside its siblings instead of replacing them.
        await rememberAgentTab(activeAgent, created.id);
        await attachToAgentGroup(created.id, activeAgent);
        if (url !== 'about:blank') {
          await waitForLoad(created.id);
        }
        const current = await chrome.tabs.get(created.id);
        return {
          status: 'ok',
          tab: {
            id: current.id,
            title: current.title,
            url: current.url,
            agent: true,
            agent_name: activeAgent
          },
          tabs: await getAllTabs()
        };
      }

      case 'close_tab': {
        const targetId = cmd.tab_id || agentEntry(activeAgent).current;

        // Refuse to close a tab belonging to the other agent, or one the user
        // owns. Only an explicit tab_id can target outside this agent's tab.
        const owner = targetId ? agentOwning(targetId) : null;
        if (targetId && !cmd.tab_id && owner !== activeAgent) {
          return { status: 'error', error: 'no tab of your own to close',
                   tabs: await getAllTabs() };
        }
        if (targetId) {
          await forgetAgentTab(targetId);
          try { await chrome.tabs.remove(targetId); } catch (e) {}
        }
        return { status: 'ok', tabs: await getAllTabs() };
      }

      case 'scroll': {
        const dy = cmd.direction === 'up' ? -(cmd.amount || 500) : (cmd.amount || 500);

        // With a target: bring that element into view, in its own frame.
        if (cmd.target !== undefined && cmd.target !== null && cmd.target !== '') {
          const item = ((await getTabElements(tabId)) || new Map()).get(parseInt(cmd.target, 10));
          if (!item) throw new Error(`element [${cmd.target}] not found - call get_state first`);
          const ok = await runInElementWorld(tabId, item.frameId, (localId) => {
            const it = window.__agent_elements && window.__agent_elements[localId];
            if (!it || !it.el || !it.el.isConnected) return false;
            it.el.scrollIntoView({ behavior: 'auto', block: 'center' });
            return true;
          }, [item.localId]);
          if (!ok) throw new Error(`element [${cmd.target}] is no longer on the page - call get_state again`);
          await new Promise((r) => setTimeout(r, 300));
          break;
        }

        // Without one: a real wheel event, dispatched where the pointer would be.
        //
        // This used to call window.scrollBy and then scroll *every* scrollable
        // element on the page by the same amount, so one call moved the nav
        // rail, the main list and any open panel together. A wheel event is
        // hit-tested by Chrome exactly like a user's, so it scrolls the one
        // container under the point and reaches cross-origin frames, which a
        // script in the top frame cannot. x/y choose the point; default is the
        // centre of the viewport.
        const vp = await evaluate(tabId, '({ w: window.innerWidth, h: window.innerHeight })');
        const wx = Number.isFinite(cmd.x) ? cmd.x : Math.round(((vp && vp.w) || 1280) / 2);
        const wy = Number.isFinite(cmd.y) ? cmd.y : Math.round(((vp && vp.h) || 800) / 2);
        await attachDebugger(tabId);
        await sendCDP(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: dy
        });
        await new Promise((r) => setTimeout(r, 400));
        break;
      }

      case 'switch_tab':
        // Explicitly adopting a tab makes it the agent's working tab from now
        // on, so follow-up commands without a tab_id land on the same page.
        if (cmd.tab_id) await rememberAgentTab(activeAgent, tabId);
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

      case 'wait_for': {
        if (!cmd.text) throw new Error('wait_for requires --text parameter');
        const needle = String(cmd.text).trim().toLowerCase();
        const timeoutMs = Math.min(Math.max(parseInt(cmd.timeout || 4000, 10), 500), 10000);
        const startTime = Date.now();
        let found = false;

        while (Date.now() - startTime < timeoutMs) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: (textToFind) => {
                if (!document || !document.body) return false;
                return document.body.innerText.toLowerCase().includes(textToFind);
              },
              args: [needle]
            });
            if (results && results.some((r) => r && r.result)) {
              found = true;
              break;
            }
          } catch (e) { /* non-fatal, retry until timeout */ }
          await new Promise((r) => setTimeout(r, 200));
        }

        if (!found) {
          throw new Error(`wait_for timed out after ${timeoutMs}ms waiting for text: "${cmd.text}"`);
        }
        break;
      }

      case 'reload_extension':
        setTimeout(() => chrome.runtime.reload(), 50);
        return { status: 'ok', result: 'extension reloading' };

      default:
        throw new Error(`unknown action: ${action}`);
    }

    const current = await chrome.tabs.get(tabId);
    const elements = await annotate(tabId);

    // Element coordinates come from getBoundingClientRect, which is CSS pixels,
    // but Page.captureScreenshot returns device pixels. On a scaled display the
    // two differ, so the viewport is reported and the bridge rescales to match.
    let viewport = null;
    try {
      viewport = await evaluate(
        tabId,
        '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })'
      );
    } catch (e) { /* non-fatal, bridge falls back to a plain size cap */ }

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
        agent: agentOwning(current.id) !== null,
        agent_name: agentOwning(current.id) || activeAgent,
        active: current.active,
        source: tabSource
      },
      tabs: await getAllTabs(),
      interactive_elements_count: elements.length,
      elements,
      ...(actionInfo ? { action_result: actionInfo } : {}),
      // Which path built the list. 'main' means the all-frames scan failed and
      // only the top frame was indexed, so cross-origin frame content is absent.
      element_scan: {
        world: tabElementWorld.get(tabId) || null,
        frames: [...new Set(elements.map((e) => e.frameId || 0))].length,
        ...(lastScanError.get(tabId) ? { error: lastScanError.get(tabId) } : {})
      },
      ...(viewport ? { viewport } : {}),
      ...(dialogLog.get(tabId)?.length ? { dialogs: dialogLog.get(tabId) } : {}),
      ...(tabErrors.get(tabId)?.length ? { recent_errors: tabErrors.get(tabId).slice(-5) } : {}),
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
      agentTabs: { ...agentTabs },
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
    // Closes every agent tab, since the popup is the user's control not an
    // agent's, and they should not have to close them one at a time.
    const ids = allAgentTabIds();
    Promise.all(ids.map((id) => forgetAgentTab(id)))
      .then(() => Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {}))))
      .then(() => reply({ ok: true }))
      .catch(() => reply({ ok: true }));
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
  if (info && info.tabId && agentOwning(info.tabId) === null) lastUserTabId = info.tabId;
  ensureConnected();
});
chrome.tabs.onUpdated.addListener(ensureConnected);
chrome.windows.onFocusChanged.addListener(ensureConnected);
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

connect();
