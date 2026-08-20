// P2.5 — Claude Code transcript reader (shared, cross-platform).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../main/claudeCcReader');

test('parseRateLimitEvent extracts a rate_limit event', () => {
  const line = JSON.stringify({
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    uuid: 'abc-123',
    timestamp: '2026-08-19T10:30:00.000Z',
    cwd: '/Users/ivan/proj',
    sessionId: 's1',
    message: { content: [{ text: "You've hit your session limit · resets 10:50pm (BST)" }] },
  });
  const ev = cc.parseRateLimitEvent(line);
  assert.ok(ev);
  assert.equal(ev.uuid, 'abc-123');
  assert.equal(ev.cwd, '/Users/ivan/proj');
  assert.match(ev.text, /resets 10:50pm/);
  assert.equal(ev.ts, Date.parse('2026-08-19T10:30:00.000Z'));
});

test('parseRateLimitEvent ignores non-rate_limit / malformed lines', () => {
  assert.equal(cc.parseRateLimitEvent(''), null);
  assert.equal(cc.parseRateLimitEvent('just some text'), null);
  assert.equal(cc.parseRateLimitEvent('{not json but has rate_limit'), null);
  // a normal assistant message (no error field)
  assert.equal(cc.parseRateLimitEvent(JSON.stringify({ type: 'assistant', message: { content: [{ text: 'hi rate_limit talk' }] } })), null);
  // rate_limit but no text
  assert.equal(cc.parseRateLimitEvent(JSON.stringify({ error: 'rate_limit', message: { content: [{}] } })), null);
});

test('parseRateLimitEvent uses the cheap pre-filter (no rate_limit substring)', () => {
  assert.equal(cc.parseRateLimitEvent(JSON.stringify({ error: 'other', message: { content: [{ text: 'x' }] } })), null);
});

test('reader exposes the ~/.claude locations + scan/read API', () => {
  assert.equal(typeof cc.claudeHome(), 'string');
  assert.match(cc.projectsDir().replace(/\\/g, '/'), /\.claude\/projects$/);
  assert.equal(typeof cc.scanCcLimit, 'function');
  assert.equal(typeof cc.readCcLimit, 'function');
});

test('readCcLimit never throws — returns a found:false shape when empty', () => {
  // With no (or an unreadable) ~/.claude/projects, it must resolve cleanly.
  const r = cc.readCcLimit();
  assert.equal(typeof r.ok, 'boolean');
  assert.equal('found' in r, true);
});
