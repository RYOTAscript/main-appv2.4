// Shared, injection-safe builders for the macOS `defaults` CLI — used by the
// Dock Styler and macOS Tweaks widgets. Pure (no electron / no spawn): every
// function returns an argv ARRAY to hand to shellUtils.runFile('defaults', args)
// / runFile('killall', …), so dynamic values never touch a shell. Unit-tested.
//
// Legal note: this only reads/writes the user's OWN preference domains via
// Apple's own `defaults` tool — no private APIs, no protected paths — and every
// change is reversible with `defaults delete` (see the widgets' Reset).

const TYPE_FLAG = { bool: '-bool', int: '-int', float: '-float', string: '-string' };

// CLI string form of a typed value.
function formatValue(type, value) {
  if (type === 'bool') return value ? 'true' : 'false';
  if (type === 'int') return String(Math.round(Number(value)));
  if (type === 'float') return String(Number(value));
  return String(value);
}

// Coerce a raw `defaults read` value back into a JS value of the given type.
function coerceValue(type, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (type === 'bool') return s === '1' || /^true$/i.test(s) || /^yes$/i.test(s);
  if (type === 'int') { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; }
  if (type === 'float') { const n = parseFloat(s); return Number.isFinite(n) ? n : null; }
  return s;
}

function writeArgs(domain, key, type, value) {
  const flag = TYPE_FLAG[type];
  if (!flag) throw new Error(`Unknown defaults type: ${type}`);
  return ['write', domain, key, flag, formatValue(type, value)];
}

function readArgs(domain, key) {
  return ['read', domain, key];
}

function deleteArgs(domain, key) {
  return ['delete', domain, key];
}

module.exports = { TYPE_FLAG, formatValue, coerceValue, writeArgs, readArgs, deleteArgs };
