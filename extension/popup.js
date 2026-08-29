'use strict';

const dot    = document.getElementById('dot');
const state  = document.getElementById('state');
const token  = document.getElementById('token');
const warn   = document.getElementById('warn');

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      dot.classList.remove('on');
      state.textContent = 'service worker asleep';
      return;
    }
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

refresh();
setInterval(refresh, 2000);
