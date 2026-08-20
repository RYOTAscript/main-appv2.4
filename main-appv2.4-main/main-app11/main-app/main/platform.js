// Platform detection + tiny helpers for the MAIN process.
//
// The app began life Windows-only. As macOS support lands, feature modules use
// these flags (instead of scattering `process.platform === 'win32'` checks) to
// branch to the right OS mechanism — PowerShell / winget on Windows, osascript /
// BSD tools on macOS. `pick()` selects a per-platform value with a fallback so a
// caller can read one map instead of writing an if/else ladder.
//
// `make(platform)` builds the helper for an ARBITRARY platform string so unit
// tests can exercise every OS branch from a single Node process (we develop on
// Windows and can't run the app on a Mac). The module's own top-level exports
// are bound to the real `process.platform`.
//
// This module intentionally has NO dependency on electron, so it can be required
// from plain-Node tests. See renderer/widget-platform.js for the renderer twin.

function make(platform) {
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';

  // Choose a value by OS. `map` may hold `win32` / `darwin` / `linux` keys plus
  // an optional `default`. Returns the first matching key for the current OS,
  // else `default`, else undefined. Callers that require a value should always
  // supply `default`.
  function pick(map) {
    if (!map || typeof map !== 'object') return undefined;
    if (isWindows && 'win32' in map) return map.win32;
    if (isMac && 'darwin' in map) return map.darwin;
    if (isLinux && 'linux' in map) return map.linux;
    if ('default' in map) return map.default;
    return undefined;
  }

  return { platform, isWindows, isMac, isLinux, pick };
}

const current = make(process.platform);

module.exports = {
  platform: current.platform,
  isWindows: current.isWindows,
  isMac: current.isMac,
  isLinux: current.isLinux,
  pick: current.pick,
  make,
};
