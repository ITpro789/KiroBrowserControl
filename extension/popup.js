'use strict';

const dot        = document.getElementById('dot');
const state      = document.getElementById('state');
const token      = document.getElementById('token');
const warn       = document.getElementById('warn');
const agentState = document.getElementById('agentState');
const steal      = document.getElementById('stealFocus');

function describeAgentTabs(map) {
  const entries = Object.entries(map || {})
    .map(([agent, e]) => [agent, (e && e.tabs) || []])
    .filter(([, tabs]) => tabs.length);

  if (!entries.length) {
    agentState.textContent = 'none yet - created on first command';
    return;
  }

  agentState.textContent = 'loading…';
  Promise.all(entries.map(([agent, tabs]) => new Promise((resolve) => {
    chrome.tabs.get(tabs[tabs.length - 1], (tab) => {
      if (chrome.runtime.lastError || !tab) return resolve(null);
      const extra = tabs.length > 1 ? ` (+${tabs.length - 1})` : '';
      resolve(`${agent}${extra}: ${(tab.title || tab.url || '').slice(0, 34)}`);
    });
  }))).then((rows) => {
    const found = rows.filter(Boolean);
    agentState.textContent = found.length
      ? found.join('\n')
      : 'none yet - created on first command';
  });
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      dot.classList.remove('on');
      state.textContent = 'service worker asleep';
      return;
    }

    steal.checked = !!res.stealFocus;
    describeAgentTabs(res.agentTabs);

    if (res.connected && res.authed) {
      dot.classList.add('on');
      state.textContent = `connected · ${res.attached} tab(s) attached`;
      warn.style.display = 'none';
    } else if (res.connected) {
      dot.classList.remove('on');
      state.textContent = 'connected, not authenticated';
      warn.textContent = 'Token rejected or missing. Paste it and save.';
      warn.style.display = 'block';
    } else {
      dot.classList.remove('on');
      state.textContent = 'bridge not running';
      warn.textContent = 'Start it: python scripts\\bridge_server.py --server';
      warn.style.display = 'block';
    }
  });
}

chrome.storage.local.get('bridgeToken', ({ bridgeToken }) => {
  if (bridgeToken) token.value = bridgeToken;
});

document.getElementById('save').addEventListener('click', () => {
  const value = token.value.trim();
  if (!value) {
    warn.textContent = 'Token is empty.';
    warn.style.display = 'block';
    return;
  }
  chrome.storage.local.set({ bridgeToken: value }, () => {
    chrome.runtime.sendMessage({ type: 'reconnect' }, () => setTimeout(refresh, 700));
  });
});

document.getElementById('detach').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'detach_all' }, () => setTimeout(refresh, 300));
});

document.getElementById('show').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'show_agent_tab' }, () => window.close());
});

document.getElementById('close').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'close_agent_tab' }, () => setTimeout(refresh, 300));
});

steal.addEventListener('change', () => {
  chrome.storage.local.set({ bridgeStealFocus: steal.checked }, () => setTimeout(refresh, 200));
});

refresh();
setInterval(refresh, 2000);
