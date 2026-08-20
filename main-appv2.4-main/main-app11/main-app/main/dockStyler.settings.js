// Dock Styler — the macOS substitute for the Windows "Translucent Taskbar"
// widget. macOS has no taskbar; the Dock is its analog, and Apple exposes a rich
// set of reversible `com.apple.dock` preferences. Pure schema + arg builders
// (electron-free, unit-tested); the electron module (dockStyler.js) runs them.
const { writeArgs, readArgs, deleteArgs, coerceValue } = require('./macDefaults');

const DOMAIN = 'com.apple.dock';
// Dock changes take effect when the Dock is restarted.
const APPLY = { file: 'killall', args: ['Dock'] };

// UI-exposed, reversible Dock settings. `default` = the macOS baseline shown when
// the key is unset. enum values are stored as strings.
const DOCK_SETTINGS = [
  { key: 'autohide', label: 'Auto-hide the Dock', type: 'bool', default: false },
  { key: 'tilesize', label: 'Icon size', type: 'int', min: 16, max: 128, default: 48 },
  { key: 'magnification', label: 'Magnify on hover', type: 'bool', default: false },
  { key: 'largesize', label: 'Magnified size', type: 'int', min: 16, max: 128, default: 64 },
  { key: 'orientation', label: 'Position on screen', type: 'enum', options: ['bottom', 'left', 'right'], default: 'bottom' },
  { key: 'mineffect', label: 'Minimize animation', type: 'enum', options: ['genie', 'scale', 'suck'], default: 'genie' },
  { key: 'autohide-time-modifier', label: 'Auto-hide animation speed', type: 'float', min: 0, max: 2, default: 1 },
  { key: 'autohide-delay', label: 'Auto-hide delay (s)', type: 'float', min: 0, max: 2, default: 0.5 },
  { key: 'showhidden', label: 'Translucent hidden-app icons', type: 'bool', default: false },
  { key: 'show-recents', label: 'Show recent apps', type: 'bool', default: true },
  { key: 'minimize-to-application', label: 'Minimize windows into app icon', type: 'bool', default: false },
  { key: 'static-only', label: 'Show running apps only', type: 'bool', default: false },
];

const BY_KEY = Object.fromEntries(DOCK_SETTINGS.map((s) => [s.key, s]));

// enums are stored as `-string` in defaults.
function defaultsType(setting) { return setting.type === 'enum' ? 'string' : setting.type; }

// Validate + clamp a set request → `defaults write` args, or null if invalid.
function dockWriteArgs(key, value) {
  const s = BY_KEY[key];
  if (!s) return null;
  let v = value;
  if (s.type === 'int' || s.type === 'float') {
    v = Number(v);
    if (!Number.isFinite(v)) return null;
    if (s.min != null) v = Math.max(s.min, v);
    if (s.max != null) v = Math.min(s.max, v);
    if (s.type === 'int') v = Math.round(v);
  } else if (s.type === 'bool') {
    v = !!v;
  } else if (s.type === 'enum') {
    if (!s.options.includes(String(v))) return null;
    v = String(v);
  }
  return writeArgs(DOMAIN, key, defaultsType(s), v);
}

function dockReadArgs(key) { return BY_KEY[key] ? readArgs(DOMAIN, key) : null; }
function dockResetArgsList() { return DOCK_SETTINGS.map((s) => deleteArgs(DOMAIN, s.key)); }
function dockCoerce(key, raw) { const s = BY_KEY[key]; return s ? coerceValue(defaultsType(s), raw) : null; }

module.exports = { DOMAIN, APPLY, DOCK_SETTINGS, dockWriteArgs, dockReadArgs, dockResetArgsList, dockCoerce };
