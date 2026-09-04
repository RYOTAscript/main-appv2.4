// A fetch-shaped transport built on Electron's `net` module — the drop-in twin of
// httpClient's `safeFetch`, with ONE deliberate difference: it goes through
// Chromium's network stack, which honours the **operating-system certificate
// store and system proxy**. Node's `https` (what safeFetch uses) trusts only its
// own bundled Mozilla roots, so on a PC behind a TLS-inspecting proxy or antivirus
// — which re-signs HTTPS with a private root CA installed in the Windows store —
// every safeFetch call throws `self signed certificate in certificate chain` and
// the feature simply never works (see main/spotify.connectivity.js).
//
// This is NOT "accept any certificate": it uses exactly the trust the OS is
// already configured with, the same way Chrome and Edge do. It is used only by
// the content fetchers (Spotify, weather, lyrics). Security-sensitive paths
// (license verification, updates) intentionally stay on the stricter Node-https
// transport and are unaffected.
//
// The contract matches safeFetch exactly: resolves to
//   { status, ok, headers.get(name), json(), text() }
// and accepts { method, headers, body, signal, timeout }.

const { safeFetch: httpsFetch } = require('./httpClient');

// Lazy so this module is require-safe outside Electron (e.g. under node:test).
function getNet() {
  try {
    return require('electron').net;
  } catch (e) {
    return null;
  }
}

function netFetch(url, options = {}) {
  const net = getNet();
  // Electron `net` is only usable after the app 'ready' event and only inside a
  // real Electron process. If it isn't available, fall back to the Node-https
  // transport so behaviour never regresses — worst case is the pre-existing
  // bundled-CA behaviour, never a hard failure to make a request at all.
  if (!net || typeof net.request !== 'function') return httpsFetch(url, options);

  return new Promise((resolve, reject) => {
    try {
      const headers = { ...(options.headers || {}) };

      let bodyData = null;
      if (options.body) {
        if (typeof options.body === 'string') {
          bodyData = options.body;
        } else if (options.body instanceof URLSearchParams) {
          bodyData = options.body.toString();
          if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
          bodyData = JSON.stringify(options.body);
          if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        }
      }

      const request = net.request({ method: options.method || 'GET', url, redirect: 'follow' });
      for (const [name, value] of Object.entries(headers)) {
        if (value != null) request.setHeader(name, String(value));
      }

      let settled = false;
      let timer = null;
      let onAbortSignal = null;

      function cleanup() {
        if (timer) clearTimeout(timer);
        if (options.signal && onAbortSignal) {
          options.signal.removeEventListener('abort', onAbortSignal);
        }
      }
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(arg);
      };

      const timeoutMs = options.timeout || 20000;
      timer = setTimeout(() => {
        try { request.abort(); } catch (e) { /* already gone */ }
        finish(reject, new Error('Request timeout'));
      }, timeoutMs);

      if (options.signal) {
        onAbortSignal = () => {
          try { request.abort(); } catch (e) { /* already gone */ }
          finish(reject, new Error('Request aborted'));
        };
        if (options.signal.aborted) { onAbortSignal(); return; }
        options.signal.addEventListener('abort', onAbortSignal);
      }

      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const textContent = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode;
          finish(resolve, {
            status,
            ok: status >= 200 && status < 300,
            headers: {
              // Electron lowercases header keys and may return string[] — normalise
              // to the single-string shape safeFetch's callers expect.
              get: (name) => {
                const v = response.headers[name.toLowerCase()];
                if (v == null) return null;
                return Array.isArray(v) ? (v[0] != null ? v[0] : null) : v;
              }
            },
            json: async () => JSON.parse(textContent),
            text: async () => textContent
          });
        });
        response.on('error', (err) => finish(reject, err));
      });

      request.on('error', (err) => finish(reject, err));
      // A stray abort we didn't trigger still has to settle the promise.
      request.on('abort', () => finish(reject, new Error('Request aborted')));

      if (bodyData) request.write(bodyData);
      request.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { netFetch };
