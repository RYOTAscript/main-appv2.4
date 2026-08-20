// Pure logic for the macOS App Uninstaller (the substitute for the Windows Deep
// Uninstaller). Electron-free + side-effect-free so the leftover-matching and —
// critically — the deletion SAFETY guard are unit-testable on Windows.
//
// macOS paths are POSIX, so everything here uses path.posix. Deletion is always
// via the Trash (reversible) in the electron module; this module only decides
// WHAT matches and WHETHER a path is safe to touch.
const path = require('path');
const posix = path.posix;

// Subdirectories of ~/Library an app scatters files into. Deletion is confined
// to these (plus the app bundle) — nothing else is ever eligible.
const LEFTOVER_ROOTS = [
  'Application Support', 'Caches', 'Preferences', 'Logs',
  'Saved Application State', 'Containers', 'Group Containers',
  'HTTPStorages', 'WebKit', 'Cookies', 'Application Scripts', 'LaunchAgents',
];

// The absolute roots deletion is allowed under: the ~/Library leftover dirs plus
// the app-install locations (so the .app bundle itself can be trashed).
function allowedRoots(homeDir) {
  const lib = posix.join(homeDir, 'Library');
  const roots = LEFTOVER_ROOTS.map((r) => posix.join(lib, r));
  roots.push('/Applications', posix.join(homeDir, 'Applications'));
  return roots;
}

// SAFETY GUARD — the single check every path passes before it can be trashed.
// A path is safe only if it is STRICTLY INSIDE one of the allowed roots (never a
// root itself, never outside them, never containing `..`).
function isPathSafe(fullPath, homeDir) {
  if (!fullPath || !homeDir) return false;
  const norm = posix.normalize(String(fullPath));
  if (norm.split('/').includes('..')) return false;
  return allowedRoots(homeDir).some((root) => {
    const r = posix.normalize(root);
    return norm !== r && norm.startsWith(r + '/');
  });
}

// Does a Library entry name belong to this app? Bundle-id match is the reliable
// signal (exact, or the entry begins with the bundle id at a real boundary, e.g.
// "com.foo.bar.savedState"). App-name match is deliberately strict (exact folder
// name only) to avoid sweeping unrelated files. Apple/system bundle ids never
// match — we don't sweep the OS.
function leftoverMatches(entryName, bundleId, appName) {
  const e = String(entryName || '').toLowerCase();
  if (!e) return false;
  const bid = String(bundleId || '').toLowerCase();
  const an = String(appName || '').toLowerCase();

  if (bid && bid.includes('.') && !bid.startsWith('com.apple')) {
    if (e === bid) return true;
    const rest = e.startsWith(bid) ? e.slice(bid.length) : null;
    if (rest !== null && (rest === '' || /^[^a-z0-9]/.test(rest))) return true; // boundary
  }
  if (an && an.length >= 3 && (e === an || e === an + '.plist')) return true;
  return false;
}

// Is this app one we must never offer to uninstall (Apple/system, or our own app)?
function isProtectedApp(bundleId, appPath) {
  const bid = String(bundleId || '').toLowerCase();
  const p = String(appPath || '');
  if (p.startsWith('/System/')) return true;
  if (bid.startsWith('com.apple')) return true;
  if (bid === 'com.launcher.app') return true; // our own app id
  return false;
}

module.exports = { LEFTOVER_ROOTS, allowedRoots, isPathSafe, leftoverMatches, isProtectedApp };
