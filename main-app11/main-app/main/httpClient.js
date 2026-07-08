const https = require('https');

// Electron's main process has no built-in fetch with the exact shape the rest of
// this codebase expects, so this wraps Node's https module in a fetch-like API
// (status/ok/headers.get/json()/text()) that every feature module builds on.
function safeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const headers = { ...options.headers };

      let bodyData = null;
      if (options.body) {
        if (typeof options.body === 'string') {
          bodyData = options.body;
        } else if (options.body instanceof URLSearchParams) {
          bodyData = options.body.toString();
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
          bodyData = JSON.stringify(options.body);
          headers['Content-Type'] = 'application/json';
        }
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: headers,
        timeout: 20000
      };

      const req = https.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const textContent = buffer.toString('utf8');

          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => res.headers[name.toLowerCase()] || null
            },
            json: async () => JSON.parse(textContent),
            text: async () => textContent
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request aborted'));
        });
      }

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { safeFetch };
