// Unit tests for main/licenseWatermark.js — the clock-rollback guard that bounds
// the offline grace window.
//
// The defect these lock down: the original check was
//   if (typeof stored.maxSeen === 'number' && now < stored.maxSeen - SKEW) ...
// so deleting `maxSeen` from the (plaintext, user-owned) license.json made the
// guard skip itself, and a wound-back clock replayed a 3-day token forever.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../main/licenseWatermark.js');

const SKEW = 24 * 60 * 60 * 1000;
const T = 1_700_000_000_000; // a fixed "now"
const DAY = 24 * 60 * 60 * 1000;

// ── effectiveMaxSeen ────────────────────────────────────────────────────────

test('takes the newer of the record and the mirror', () => {
  assert.equal(W.effectiveMaxSeen({ maxSeen: T, wm: 1 }, T - DAY), T);
  assert.equal(W.effectiveMaxSeen({ maxSeen: T - DAY, wm: 1 }, T), T);
});

test('either copy alone still enforces', () => {
  assert.equal(W.effectiveMaxSeen({ maxSeen: T, wm: 1 }, null), T);
  assert.equal(W.effectiveMaxSeen({ wm: 1 }, T), T);
});

test('THE BUG: deleting maxSeen no longer disables the guard', () => {
  // Record edited to drop maxSeen, but the encrypted mirror survives.
  const seen = W.effectiveMaxSeen({ key: 'MAIN-AAAA-AAAA-AAAA-AAAA', wm: 1 }, T);
  assert.equal(seen, T);
  // A clock wound back a week is still caught.
  assert.equal(W.isRollback(seen, T - 7 * DAY, SKEW), true);
});

test('a flagged record with both copies gone is TAMPERED, not unguarded', () => {
  const seen = W.effectiveMaxSeen({ wm: 1 }, null);
  assert.equal(seen, W.TAMPERED);
  // TAMPERED must fail closed no matter what the clock says, including a clock
  // that looks perfectly normal.
  assert.equal(W.isRollback(seen, T, SKEW), true);
  assert.equal(W.isRollback(seen, T + 10 * DAY, SKEW), true);
});

test('a record predating the mirror gets exactly one ungated run', () => {
  // No `wm` flag → written by an older build → must not lock the user out.
  const seen = W.effectiveMaxSeen({ maxSeen: undefined }, null);
  assert.equal(seen, null);
  assert.equal(W.isRollback(seen, T, SKEW), false);
  // …and noteSeen then establishes a watermark, so the next run is guarded.
  assert.equal(W.nextWatermark(seen, T), T);
});

test('null/absent record does not throw', () => {
  assert.equal(W.effectiveMaxSeen(null, null), null);
  assert.equal(W.effectiveMaxSeen(undefined, T), T);
});

// ── isRollback ──────────────────────────────────────────────────────────────

test('a clock inside the skew window is accepted as drift', () => {
  assert.equal(W.isRollback(T, T, SKEW), false);
  assert.equal(W.isRollback(T, T + DAY, SKEW), false);      // moving forward
  assert.equal(W.isRollback(T, T - SKEW + 1000, SKEW), false); // just inside
});

test('a clock past the skew window is a rollback', () => {
  assert.equal(W.isRollback(T, T - SKEW - 1000, SKEW), true);
  assert.equal(W.isRollback(T, T - 365 * DAY, SKEW), true);
});

test('no watermark yet means nothing to enforce', () => {
  assert.equal(W.isRollback(null, T - 365 * DAY, SKEW), false);
  assert.equal(W.isRollback(0, T - 365 * DAY, SKEW), false);
});

// ── nextWatermark ───────────────────────────────────────────────────────────

test('advances with the clock', () => {
  assert.equal(W.nextWatermark(T, T + DAY), T + DAY);
});

test('never moves backwards, so a slow clock cannot erode it', () => {
  assert.equal(W.nextWatermark(T, T - DAY), T);
  assert.equal(W.nextWatermark(T, T - 365 * DAY), T);
});

test('recovers from TAMPERED and from no prior value', () => {
  assert.equal(W.nextWatermark(W.TAMPERED, T), T);
  assert.equal(W.nextWatermark(null, T), T);
});
