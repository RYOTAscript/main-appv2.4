'use strict';

// Every renderer document ships a Content-Security-Policy, and this suite is
// what makes that claim mean something.
//
// It exists because the old check was `assert.match(src, /img-src ... https:;/)`
// — a substring match on the file. That is not a test of the policy, it is a
// test of the text, and the two came apart: voice-overlay.html carried a
// `/* ... */` comment INSIDE the content attribute. CSP has no comment syntax.
// `/*` parses as a directive NAME, which is invalid, so the parser discards the
// whole directive — everything up to the next `;`, which swallowed the img-src
// that followed it. default-src 'none' applied instead and album art was blocked
// in the overlay, while the substring test went on passing.
//
// So: parse the policy the way a browser does, then assert against the parsed
// directives. A directive that does not survive parsing does not count.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const here = (...p) => path.join(__dirname, '..', ...p);

// Every HTML document the app can load into a BrowserWindow.
const HTML_FILES = [
  'main.html',
  'license-gate.html',
  'first-run.html',
  'voice-overlay.html',
  'crosshair-overlay.html',
  'mic-mute-overlay.html',
  'area-select-overlay.html',
  'timer-float.html',
  'mini-player.html',
  'phone-remote.html',
];

// A directive name is 1*( ALPHA / DIGIT / "-" ). Anything else and the browser
// throws the directive away — which is exactly the failure this file exists for.
const VALID_DIRECTIVE_NAME = /^[a-z0-9-]+$/;

/** Pull the CSP meta tag's content attribute out of an HTML source string. */
function extractPolicy(html) {
  const meta = html.match(
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']([\s\S]*?)["']\s*\/?>/i,
  );
  return meta ? meta[1] : null;
}

/**
 * Parse a serialized policy the way the CSP spec says to: split on ";", take
 * the first whitespace-delimited token as the directive name, and DISCARD any
 * directive whose name is not a valid name. Returns { directives, discarded }.
 */
function parsePolicy(policy) {
  const directives = new Map();
  const discarded = [];
  for (const token of policy.split(';')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts[0].toLowerCase();
    if (!VALID_DIRECTIVE_NAME.test(name)) {
      discarded.push(trimmed);
      continue;
    }
    // First occurrence wins; a repeat is ignored by the browser too.
    if (!directives.has(name)) directives.set(name, parts.slice(1));
  }
  return { directives, discarded };
}

const parsed = new Map();
for (const file of HTML_FILES) {
  const policy = extractPolicy(fs.readFileSync(here(file), 'utf8'));
  parsed.set(file, policy === null ? null : parsePolicy(policy));
}

test('every renderer document ships a CSP', () => {
  for (const file of HTML_FILES) {
    assert.ok(parsed.get(file), `${file} has no Content-Security-Policy meta tag`);
  }
});

test('no policy contains a directive the browser will silently throw away', () => {
  // This is the assertion that would have caught the album-art regression. A
  // comment, a stray token, a typo'd name — all of them look harmless in the
  // file and all of them delete a directive at runtime, with no error the app
  // ever sees.
  for (const file of HTML_FILES) {
    const { discarded } = parsed.get(file);
    assert.deepStrictEqual(
      discarded, [],
      `${file}: these are not valid CSP directives and are dropped at parse ` +
      `time, taking everything up to the next ";" with them:\n  ` +
      discarded.join('\n  ') +
      `\n(CSP has no comment syntax — put explanations outside the content attribute.)`,
    );
  }
});

// The one page that talks to the network itself: the Phone Remote socket, a
// hidden window with no page script whose preload holds the relay WebSocket
// (main/phoneRemote.js). It may reach the relay over wss:, plus loopback for a
// dev relay — and nothing else, pinned exactly.
const CONNECT_ALLOWED = {
  'phone-remote.html': ['wss:', 'ws://localhost:*', 'ws://127.0.0.1:*'],
};

test('every policy locks the default down and denies the dangerous sinks', () => {
  for (const file of HTML_FILES) {
    const { directives } = parsed.get(file);
    assert.deepStrictEqual(directives.get('default-src'), ["'none'"],
      `${file}: default-src must be 'none' so anything not named is denied`);
    assert.deepStrictEqual(directives.get('base-uri'), ["'none'"],
      `${file}: base-uri must be 'none' — a <base> tag rewrites every relative URL`);
    assert.deepStrictEqual(directives.get('form-action'), ["'none'"],
      `${file}: form-action must be 'none'`);
    // frame-src/object-src fall through to default-src 'none' when absent, so
    // they only need checking when they are present and might widen it.
    for (const name of ['frame-src', 'object-src', 'child-src', 'worker-src', 'connect-src']) {
      const value = directives.get(name);
      if (name === 'connect-src' && CONNECT_ALLOWED[file]) {
        assert.deepStrictEqual(value, CONNECT_ALLOWED[file], `${file}: connect-src is exactly the relay`);
      } else if (value) {
        assert.deepStrictEqual(value, ["'none'"],
          `${file}: ${name} is present and must stay 'none'`);
      }
    }
  }
});

test('no policy allows remote script, whatever else it allows', () => {
  // 'unsafe-inline' is still here because of the inline on* handlers (see the
  // CLAUDE.md gotcha). Remote script is a different question and the answer is
  // no, everywhere — that is what keeps a DOM injection a defacement.
  for (const file of HTML_FILES) {
    const { directives } = parsed.get(file);
    const scriptSrc = directives.get('script-src') || directives.get('default-src');
    for (const source of scriptSrc) {
      assert.ok(
        !/^https?:/.test(source) && source !== '*',
        `${file}: script-src must not permit remote script (found ${source})`,
      );
    }
  }
});

test('the voice overlay really can load album art — as a parsed directive', () => {
  // The overlay renders <img id="answer-art"> from the now-playing cover, which
  // is either a remote https: URL or a base64 data: URI handed over by the main
  // window. Both have to survive parsing, not merely appear in the file.
  const { directives } = parsed.get('voice-overlay.html');
  const imgSrc = directives.get('img-src');
  assert.ok(imgSrc, 'voice-overlay.html: img-src did not survive CSP parsing');
  assert.ok(imgSrc.includes('https:'), 'remote album art must be allowed');
  assert.ok(imgSrc.includes('data:'), 'a base64 cover handed over by the main window must be allowed');
  assert.ok(imgSrc.includes("'self'"), "the overlay's own local images must be allowed");
});

test('main.html allows the same album art it always did', () => {
  const { directives } = parsed.get('main.html');
  const imgSrc = directives.get('img-src');
  assert.ok(imgSrc, 'main.html: img-src did not survive CSP parsing');
  assert.ok(imgSrc.includes('https:'), 'remote album art must be allowed');
});
