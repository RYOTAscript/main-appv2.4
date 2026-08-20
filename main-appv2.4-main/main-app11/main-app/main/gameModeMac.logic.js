// Pure rule-matching for macOS Game Mode (identical semantics to the Windows
// gameMode.js): a process rule for the frontmost app wins over a generic
// fullscreen rule; among fullscreen rules the first listed wins. Electron-free +
// unit-tested. Matching is case-insensitive so a rule's app name lines up with
// the frontmost app name regardless of how it was typed.
function matchRule(rules, currentExe, currentFullscreen, ownNames) {
  if (!currentExe) return null;
  const exe = String(currentExe).toLowerCase();
  if ((ownNames || []).map((n) => String(n).toLowerCase()).includes(exe)) return null; // never our own app

  let fullscreenRule = null;
  for (const r of rules || []) {
    if (r.match === 'process') {
      if (r.processName && exe === String(r.processName).toLowerCase()) return r;
    } else if (r.match === 'fullscreen' && !fullscreenRule) {
      if (currentFullscreen) fullscreenRule = r;
    }
  }
  return fullscreenRule;
}

module.exports = { matchRule };
