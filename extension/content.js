/**
 * Kiro Browser Bridge - keep-alive content script.
 *
 * Manifest V3 service workers are terminated after ~30s idle, which would drop
 * the WebSocket to the local bridge. A long-lived runtime port from any open
 * page resets that idle timer. Combined with chrome.alarms in background.js
 * this keeps the socket up in practice.
 */
(function () {
  'use strict';

  const PING_INTERVAL_MS = 10000;
  const RECONNECT_DELAY_MS = 1500;

  let pingTimer = null;

  function keepAlive() {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'keepAlive' });
    } catch (e) {
      // Extension context not ready or was reloaded.
      setTimeout(keepAlive, 2000);
      return;
    }

    port.onDisconnect.addListener(() => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      setTimeout(keepAlive, RECONNECT_DELAY_MS);
    });

    pingTimer = setInterval(() => {
      try {
        port.postMessage({ ping: 1 });
      } catch (e) {
        // Port died; onDisconnect will handle reconnection.
      }
    }, PING_INTERVAL_MS);
  }

  const proto = document.location.protocol;
  if (proto === 'http:' || proto === 'https:' || proto === 'file:') {
    keepAlive();
  }
})();
