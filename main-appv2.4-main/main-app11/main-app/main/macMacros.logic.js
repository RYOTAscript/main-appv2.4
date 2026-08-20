// Pure playback logic for the macOS Macros widget. Turns high-level macro steps
// into either an osascript script (keyboard-only macros — no install needed,
// just Accessibility permission) or a `cliclick` argv (anything with mouse
// steps; cliclick is a tiny MIT Homebrew CLI). Electron-free + unit-tested; the
// electron module (macMacros.js) just runs what these build.
//
// Step shapes (built in the editor — recording isn't possible on macOS):
//   { t: 'text',  s: 'hello' }              type literal text
//   { t: 'key',   key: 'return'|'a'|…, mods: ['cmd','shift',…] }
//   { t: 'delay', ms: 500 }                 wait
//   { t: 'click', x: 100, y: 200 }          click at screen coords
//   { t: 'move',  x: 100, y: 200 }          move the pointer
const { appleScriptQuote } = require('./osascript');

// Named keys → osascript virtual key code + cliclick key name.
const NAMED_KEYS = {
  return: { code: 36, cli: 'return' }, enter: { code: 36, cli: 'return' },
  tab: { code: 48, cli: 'tab' }, space: { code: 49, cli: 'space' },
  delete: { code: 51, cli: 'delete' }, 'forward-delete': { code: 117, cli: 'fwd-delete' },
  escape: { code: 53, cli: 'esc' }, home: { code: 115, cli: 'home' }, end: { code: 119, cli: 'end' },
  'page-up': { code: 116, cli: 'page-up' }, 'page-down': { code: 121, cli: 'page-down' },
  'arrow-up': { code: 126, cli: 'arrow-up' }, 'arrow-down': { code: 125, cli: 'arrow-down' },
  'arrow-left': { code: 123, cli: 'arrow-left' }, 'arrow-right': { code: 124, cli: 'arrow-right' },
  f1: { code: 122, cli: 'f1' }, f2: { code: 120, cli: 'f2' }, f3: { code: 99, cli: 'f3' }, f4: { code: 118, cli: 'f4' },
  f5: { code: 96, cli: 'f5' }, f6: { code: 97, cli: 'f6' }, f7: { code: 98, cli: 'f7' }, f8: { code: 100, cli: 'f8' },
  f9: { code: 101, cli: 'f9' }, f10: { code: 109, cli: 'f10' }, f11: { code: 103, cli: 'f11' }, f12: { code: 111, cli: 'f12' },
};
const MODS = {
  cmd: { osa: 'command down', cli: 'cmd' }, command: { osa: 'command down', cli: 'cmd' },
  opt: { osa: 'option down', cli: 'alt' }, option: { osa: 'option down', cli: 'alt' }, alt: { osa: 'option down', cli: 'alt' },
  ctrl: { osa: 'control down', cli: 'ctrl' }, control: { osa: 'control down', cli: 'ctrl' },
  shift: { osa: 'shift down', cli: 'shift' }, fn: { osa: null, cli: 'fn' },
};

const MAX_STEPS = 200;
const MAX_TEXT = 2000;

function normMods(mods) {
  const out = [];
  for (const m of Array.isArray(mods) ? mods : []) {
    const key = String(m).toLowerCase();
    if (MODS[key] && !out.includes(key)) out.push(key);
  }
  return out;
}
function clampInt(n) { const v = Math.round(Number(n)); return Number.isFinite(v) ? v : null; }

function isValidStep(step) {
  if (!step || typeof step !== 'object') return false;
  switch (step.t) {
    case 'text': return typeof step.s === 'string' && step.s.length <= MAX_TEXT;
    case 'delay': return Number.isFinite(Number(step.ms)) && Number(step.ms) >= 0;
    case 'key': {
      const k = String(step.key || '').toLowerCase();
      return !!NAMED_KEYS[k] || [...k].length === 1; // named key or single character
    }
    case 'click':
    case 'move': return clampInt(step.x) !== null && clampInt(step.y) !== null;
    default: return false;
  }
}

function macroNeedsMouse(steps) {
  return (steps || []).some((s) => s && (s.t === 'click' || s.t === 'move'));
}

// One step → its osascript lines, or null if the step can't be done in osascript
// (mouse steps). Used for the no-install, keyboard-only playback path.
function stepToOsascript(step) {
  if (!isValidStep(step)) return null;
  switch (step.t) {
    case 'text':
      return [`keystroke ${appleScriptQuote(step.s)}`];
    case 'delay':
      return [`delay ${Math.max(0, Number(step.ms)) / 1000}`];
    case 'key': {
      const k = String(step.key).toLowerCase();
      const mods = normMods(step.mods).map((m) => MODS[m].osa).filter(Boolean);
      const using = mods.length ? ` using {${mods.join(', ')}}` : '';
      if (NAMED_KEYS[k]) return [`key code ${NAMED_KEYS[k].code}${using}`];
      return [`keystroke ${appleScriptQuote(step.key)}${using}`];
    }
    default:
      return null; // click / move
  }
}

// One step → its cliclick argv tokens. cliclick does keyboard, mouse and waits,
// so every step maps here (this is the full-featured path).
function stepToCliclick(step) {
  if (!isValidStep(step)) return null;
  switch (step.t) {
    case 'text':
      return [`t:${step.s}`];
    case 'delay':
      return [`w:${Math.max(0, Math.round(Number(step.ms)))}`];
    case 'key': {
      const k = String(step.key).toLowerCase();
      const mods = normMods(step.mods).map((m) => MODS[m].cli);
      const press = NAMED_KEYS[k] ? `kp:${NAMED_KEYS[k].cli}` : `t:${step.key}`;
      if (!mods.length) return [press];
      return [`kd:${mods.join(',')}`, press, `ku:${mods.join(',')}`];
    }
    case 'click':
      return [`c:${clampInt(step.x)},${clampInt(step.y)}`];
    case 'move':
      return [`m:${clampInt(step.x)},${clampInt(step.y)}`];
    default:
      return null;
  }
}

// Build the whole osascript line list for a keyboard-only macro (null if any
// step needs the mouse or is invalid).
function buildOsascript(steps) {
  const list = (steps || []).slice(0, MAX_STEPS);
  const lines = [];
  for (const s of list) {
    const l = stepToOsascript(s);
    if (!l) return null; // a mouse/invalid step → can't use the osascript path
    lines.push(...l);
  }
  return lines;
}

// Build the whole cliclick argv for a macro (null if any step is invalid).
function buildCliclick(steps) {
  const list = (steps || []).slice(0, MAX_STEPS);
  const tokens = [];
  for (const s of list) {
    const t = stepToCliclick(s);
    if (!t) return null;
    tokens.push(...t);
  }
  return tokens;
}

module.exports = {
  NAMED_KEYS, MODS, MAX_STEPS, MAX_TEXT,
  isValidStep, macroNeedsMouse, stepToOsascript, stepToCliclick, buildOsascript, buildCliclick,
};
