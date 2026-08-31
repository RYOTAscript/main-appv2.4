// Pure clock-rollback watermark logic for main/license.js.
//
// Extracted here (electron-free, like machineId.js) so the decision that gates
// the offline grace window can be unit-tested without a running app. license.js
// keeps the file I/O; everything below is a pure function of its inputs.
//
// THE BUG THIS EXISTS TO PREVENT
// -----------------------------
// The original guard read:
//
//   if (typeof stored.maxSeen === 'number' && now < stored.maxSeen - SKEW) return null;
//
// `maxSeen` lives in license.json, which is plaintext and user-owned. Deleting
// that one field made the `typeof` test false, so the guard skipped ITSELF — and
// a wound-back system clock then replayed a 3-day token indefinitely. A guard
// must never treat "the evidence is missing" as "the check passes".
//
// So the watermark is now kept in two places (the record and an OS-encrypted
// mirror file), the newer wins, and a record that should carry one but has
// neither is TAMPERED rather than unguarded.
//
// Honest limit: this raises the cost of offline replay, it doesn't remove it. An
// attacker who strips both copies on every launch AND permanently holds the
// system clock inside the token's own iat..exp window still replays it. That's
// inherent to any local check — the real bound is that `exp` is short and a
// permanently wrong clock breaks TLS everywhere else on the machine.

/** Returned when a record that should carry a watermark has none. */
const TAMPERED = Symbol('license-watermark-tampered');

/**
 * The watermark to enforce for a stored record.
 *
 * @param {object|null} stored    the license record (may carry `maxSeen`, `wm`)
 * @param {number|null} mirrored  the mirror file's value, or null when absent
 * @returns {number|null|TAMPERED} ms epoch to enforce, null for "no watermark
 *          yet, don't enforce" (a record written before the mirror existed), or
 *          TAMPERED when both copies are gone from a record that had them.
 */
function effectiveMaxSeen(stored, mirrored) {
  const inRecord =
    stored && typeof stored.maxSeen === 'number' ? stored.maxSeen : null;
  const mir = typeof mirrored === 'number' ? mirrored : null;

  if (inRecord === null && mir === null) {
    // mintAndStore always writes maxSeen and sets wm, so a record flagged `wm`
    // with no watermark anywhere was edited. Without the flag it simply predates
    // the mirror — grace it for one run, after which noteSeen sets the flag.
    return stored && stored.wm ? TAMPERED : null;
  }
  return Math.max(inRecord || 0, mir || 0);
}

/**
 * Whether `now` represents a clock rolled back far enough to be tampering.
 * `skewMs` tolerates genuine drift and timezone/DST corrections.
 */
function isRollback(seen, now, skewMs) {
  if (seen === TAMPERED) return true;
  if (typeof seen !== 'number' || !seen) return false;
  return now < seen - skewMs;
}

/**
 * The value both copies should advance to on a successful launch. Never moves
 * backwards, so a slow clock can't erode an established watermark.
 */
function nextWatermark(seen, now) {
  const base = seen === TAMPERED || typeof seen !== 'number' ? 0 : seen;
  return Math.max(now, base);
}

module.exports = { TAMPERED, effectiveMaxSeen, isRollback, nextWatermark };
