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

  let port = null;
  let pingTimer = null;

  function teardown() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (port) {
      try { port.disconnect(); } catch (e) { /* already gone */ }
      port = null;
    }
  }

  function keepAlive() {
    if (port) return;

    try {
      port = chrome.runtime.connect({ name: 'keepAlive' });
    } catch (e) {
      // Extension context not ready, or the extension was reloaded.
      port = null;
      setTimeout(keepAlive, 2000);
      return;
    }

    port.onDisconnect.addListener(() => {
      // Must be read, or Chrome reports it as an unchecked runtime.lastError.
      // The usual cause is entirely benign: this page was put into the
      // back/forward cache, which closes the message channel.
      void chrome.runtime.lastError;

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      port = null;

      // A frozen page's timers do not run, so this fires on restore rather than
      // reconnecting from the bfcache - which is what we want.
      setTimeout(keepAlive, RECONNECT_DELAY_MS);
    });

    pingTimer = setInterval(() => {
      if (!port) return;
      try {
        port.postMessage({ ping: 1 });
      } catch (e) {
        // Port died; onDisconnect handles reconnection.
      }
    }, PING_INTERVAL_MS);
  }

  // Drop the port before the page is frozen. Holding it into the bfcache is
  // what produces the "message channel is closed" error, and a frozen page
  // cannot keep a service worker alive anyway.
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) teardown();
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) keepAlive();
  });

  const proto = document.location.protocol;
  if (proto === 'http:' || proto === 'https:' || proto === 'file:') {
    keepAlive();
  }
})();
