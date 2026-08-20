// Pure helpers for macOS audio control (mic mute + system volume). Electron-free
// and side-effect-free so they're unit-testable on Windows. The osascript command
// strings live in osascript.js; this module decides WHAT to apply and PARSES
// osascript output.

// Clamp any input to an integer 0-100 (macOS volumes are 0-100).
function clampVolume(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Decide a mic-mute action from the current input volume.
//   action  : 'toggle' | 'status'
//   current : current input volume 0-100, or null if it couldn't be read
//   saved   : volume to restore to when unmuting (falls back to 100 if <= 0)
// Returns { muted, setVolume, remember? }:
//   muted     — resulting mute state (null when `current` is unknown)
//   setVolume — volume to apply (null for a status query / unknown state)
//   remember  — present only when muting: the volume to remember for restore
function inputMuteDecision(action, current, saved) {
  if (current === null || current === undefined || !Number.isFinite(Number(current))) {
    return { muted: null, setVolume: null };
  }
  const cur = Number(current);
  const isMuted = cur <= 0;
  if (action !== 'toggle') return { muted: isMuted, setVolume: null };
  if (!isMuted) return { muted: true, setVolume: 0, remember: cur };
  const restore = saved && saved > 0 ? clampVolume(saved) : 100;
  return { muted: false, setVolume: restore };
}

// Parse the output of AppleScript `get volume settings`, e.g.
// "output volume:50, input volume:75, alert volume:100, output muted:false".
function parseVolumeSettings(str) {
  const s = String(str || '');
  const num = (re) => { const m = s.match(re); return m ? parseInt(m[1], 10) : null; };
  return {
    outputVolume: num(/output volume:(\d+)/i),
    inputVolume: num(/input volume:(\d+)/i),
    outputMuted: /output muted:\s*true/i.test(s),
  };
}

// Translate a volume-engine command line (the Windows engine's stdin protocol)
// into a macOS action, so the same IPC handlers drive both platforms.
//   MASTER <n>       → set the system output volume
//   MASTERMUTE <0|1> → mute/unmute the system output
//   SET / MUTE       → per-app volume: no public macOS API → noop
function macEngineCommand(line) {
  const t = String(line || '').trim();
  if (/^MASTER\s+/i.test(t)) {
    return { kind: 'setOutputVolume', value: clampVolume(t.replace(/^MASTER\s+/i, '')) };
  }
  if (/^MASTERMUTE\s+/i.test(t)) {
    return { kind: 'setOutputMuted', value: t.replace(/^MASTERMUTE\s+/i, '').trim() === '1' };
  }
  return { kind: 'noop' };
}

module.exports = { clampVolume, inputMuteDecision, parseVolumeSettings, macEngineCommand };
