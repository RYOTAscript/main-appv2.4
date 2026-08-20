// Pure logic for the macOS "Free Up & Quiet" widget (the reframed FPS Optimizer:
// macOS manages performance itself, so this is a light memory-purge + quit-
// background-apps tool). Electron-free + unit-tested. The osascript strings live
// in osascript.js; this decides WHICH apps to quit and parses the app list.

// Apps we must never quit (our own app + the Finder + the login shell). Matched
// case-insensitively against the process name. Our own image name is added at
// runtime by the electron module.
const BASE_PROTECTED = ['finder', 'loginwindow', 'systemuiserver', 'dock', 'window server', 'controlcenter', 'notificationcenter'];

// Parse the comma+space list System Events returns for
// `name of every process whose background only is false`.
function parseAppList(stdout) {
  return String(stdout || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Given the running GUI apps, decide which to quit: everything except the
// protected set and (optionally) the frontmost app the user is using.
function quitPlan(runningNames, protectedNames, frontmostName) {
  const protectedSet = new Set((protectedNames || []).map((n) => String(n).toLowerCase()));
  const front = frontmostName ? String(frontmostName).toLowerCase() : null;
  const out = [];
  for (const name of runningNames || []) {
    const low = String(name).toLowerCase();
    if (protectedSet.has(low)) continue;
    if (front && low === front) continue;
    out.push(name);
  }
  return out;
}

module.exports = { BASE_PROTECTED, parseAppList, quitPlan };
