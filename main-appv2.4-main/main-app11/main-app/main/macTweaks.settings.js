// macOS Tweaks — the macOS substitute for the Windows "Debloat" widget's Tweaks
// tab. A curated set of reversible, per-user `defaults` power-user toggles (the
// famous "macOS defaults" tweaks). No sudo, no security-weakening prompts, every
// one revertible. Pure schema + builders (electron-free, unit-tested).
//
// Each tweak:
//   on  = value written when ENABLED
//   off = value written when DISABLED, or the string 'delete' to restore the
//         macOS default (used for keys whose default is simply "unset")
//   apply = service to restart to apply the change ('Finder'|'SystemUIServer'|
//           'Dock'| null)
const { writeArgs, readArgs, deleteArgs, coerceValue } = require('./macDefaults');

const TWEAKS = [
  // ── Finder ──
  { id: 'finderHidden', group: 'Finder', label: 'Show hidden files', domain: 'com.apple.finder', key: 'AppleShowAllFiles', type: 'bool', on: true, off: false, apply: 'Finder' },
  { id: 'pathBar', group: 'Finder', label: 'Show path bar', domain: 'com.apple.finder', key: 'ShowPathbar', type: 'bool', on: true, off: false, apply: 'Finder' },
  { id: 'statusBar', group: 'Finder', label: 'Show status bar', domain: 'com.apple.finder', key: 'ShowStatusBar', type: 'bool', on: true, off: false, apply: 'Finder' },
  { id: 'allExtensions', group: 'Finder', label: 'Show all file extensions', domain: 'NSGlobalDomain', key: 'AppleShowAllExtensions', type: 'bool', on: true, off: false, apply: 'Finder' },
  { id: 'foldersFirst', group: 'Finder', label: 'Keep folders on top when sorting', domain: 'com.apple.finder', key: '_FXSortFoldersFirst', type: 'bool', on: true, off: false, apply: 'Finder' },
  { id: 'searchCurrentFolder', group: 'Finder', label: 'Search the current folder by default', domain: 'com.apple.finder', key: 'FXDefaultSearchScope', type: 'string', on: 'SCcf', off: 'delete', apply: 'Finder' },
  { id: 'listView', group: 'Finder', label: 'Default view: List', domain: 'com.apple.finder', key: 'FXPreferredViewStyle', type: 'string', on: 'Nlsv', off: 'delete', apply: 'Finder' },
  { id: 'noDSStoreNetwork', group: 'Finder', label: 'Don’t write .DS_Store on network drives', domain: 'com.apple.desktopservices', key: 'DSDontWriteNetworkStores', type: 'bool', on: true, off: false, apply: null },
  { id: 'noDSStoreUSB', group: 'Finder', label: 'Don’t write .DS_Store on USB drives', domain: 'com.apple.desktopservices', key: 'DSDontWriteUSBStores', type: 'bool', on: true, off: false, apply: null },

  // ── Keyboard & typing ──
  { id: 'fastKeyRepeat', group: 'Keyboard', label: 'Faster key repeat', domain: 'NSGlobalDomain', key: 'KeyRepeat', type: 'int', on: 2, off: 'delete', apply: null },
  { id: 'shortRepeatDelay', group: 'Keyboard', label: 'Shorter delay until repeat', domain: 'NSGlobalDomain', key: 'InitialKeyRepeat', type: 'int', on: 15, off: 'delete', apply: null },
  { id: 'pressAndHold', group: 'Keyboard', label: 'Key-repeat over accent popup (disable press-and-hold)', domain: 'NSGlobalDomain', key: 'ApplePressAndHoldEnabled', type: 'bool', on: false, off: 'delete', apply: null },
  { id: 'noAutoCorrect', group: 'Keyboard', label: 'Disable auto-correct', domain: 'NSGlobalDomain', key: 'NSAutomaticSpellingCorrectionEnabled', type: 'bool', on: false, off: 'delete', apply: null },
  { id: 'noAutoCapitalize', group: 'Keyboard', label: 'Disable auto-capitalize', domain: 'NSGlobalDomain', key: 'NSAutomaticCapitalizationEnabled', type: 'bool', on: false, off: 'delete', apply: null },
  { id: 'noSmartQuotes', group: 'Keyboard', label: 'Disable smart quotes', domain: 'NSGlobalDomain', key: 'NSAutomaticQuoteSubstitutionEnabled', type: 'bool', on: false, off: 'delete', apply: null },
  { id: 'noSmartDashes', group: 'Keyboard', label: 'Disable smart dashes', domain: 'NSGlobalDomain', key: 'NSAutomaticDashSubstitutionEnabled', type: 'bool', on: false, off: 'delete', apply: null },

  // ── Screenshots ──
  { id: 'screenshotPng', group: 'Screenshots', label: 'Save screenshots as PNG', domain: 'com.apple.screencapture', key: 'type', type: 'string', on: 'png', off: 'delete', apply: 'SystemUIServer' },
  { id: 'noScreenshotShadow', group: 'Screenshots', label: 'No window shadow in screenshots', domain: 'com.apple.screencapture', key: 'disable-shadow', type: 'bool', on: true, off: false, apply: 'SystemUIServer' },

  // ── Dialogs ──
  { id: 'expandSavePanel', group: 'Dialogs', label: 'Expand the Save dialog by default', domain: 'NSGlobalDomain', key: 'NSNavPanelExpandedStateForSaveMode', type: 'bool', on: true, off: false, apply: null },
  { id: 'expandPrintPanel', group: 'Dialogs', label: 'Expand the Print dialog by default', domain: 'NSGlobalDomain', key: 'PMPrintingExpandedStateForPrint', type: 'bool', on: true, off: false, apply: null },
  { id: 'saveToDisk', group: 'Dialogs', label: 'Save new documents to disk (not iCloud)', domain: 'NSGlobalDomain', key: 'NSDocumentSaveNewDocumentsToCloud', type: 'bool', on: false, off: 'delete', apply: null },
];

const BY_ID = Object.fromEntries(TWEAKS.map((t) => [t.id, t]));
const APPLY_SERVICES = ['Finder', 'SystemUIServer', 'Dock'];

function tweakReadArgs(id) { const t = BY_ID[id]; return t ? readArgs(t.domain, t.key) : null; }

// Args to enable/disable a tweak. Returns { del, args } — del:true means it's a
// `defaults delete` (restore default) rather than a write.
function tweakSetArgs(id, on) {
  const t = BY_ID[id];
  if (!t) return null;
  if (!on && t.off === 'delete') return { del: true, args: deleteArgs(t.domain, t.key) };
  const value = on ? t.on : t.off;
  return { del: false, args: writeArgs(t.domain, t.key, t.type, value) };
}

// Whether a tweak currently reads as ON. `ok` = did `defaults read` succeed
// (false ⇒ key unset ⇒ tweak is off, since our ON always writes an explicit value).
function tweakIsOn(id, raw, ok) {
  const t = BY_ID[id];
  if (!t || !ok) return false;
  return String(coerceValue(t.type, raw)) === String(t.on);
}

function tweakApplyService(id) { const t = BY_ID[id]; return t ? t.apply : null; }

module.exports = { TWEAKS, APPLY_SERVICES, tweakReadArgs, tweakSetArgs, tweakIsOn, tweakApplyService };
