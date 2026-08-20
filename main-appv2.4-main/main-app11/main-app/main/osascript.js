// macOS AppleScript / osascript helper — the mac counterpart to shellUtils.js.
//
// Feature modules that need to drive macOS (hide apps, set the clipboard, mute
// the mic, set volume …) build their AppleScript here and run it via
// runAppleScript(). Kept free of any `electron` dependency so the pure builders
// below are unit-testable on Windows, where the app is developed.
const { execFile } = require('child_process');

// Build the argv for `osascript`. Accepts a single script string or an array of
// lines (each line becomes its own `-e`, which is how multi-statement AppleScript
// is passed on the command line). Pure — no spawn — so it's unit-testable.
function osascriptArgs(scriptOrLines) {
  const lines = Array.isArray(scriptOrLines) ? scriptOrLines : [scriptOrLines];
  const args = [];
  for (const line of lines) { args.push('-e', String(line)); }
  return args;
}

// Quote a string as an AppleScript string literal (double-quoted, backslash- and
// quote-escaped). Use for any user/OS value interpolated into a script.
function appleScriptQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Run an AppleScript via `osascript -e …`. Uses execFile (NOT a shell), so the
// script text needs no shell-escaping. Never rejects — resolves
// { ok, stdout, stderr, code } to match shellUtils.runCmd's contract.
function runAppleScript(scriptOrLines, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile('osascript', osascriptArgs(scriptOrLines), { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
        code: err ? err.code : 0,
      });
    });
  });
}

// Named AppleScript snippets/builders shared across feature modules. Constants
// for fixed scripts, functions where a value is interpolated.
const scripts = {
  // Hide every other visible app so our window comes up on a clear desktop — the
  // macOS stand-in for Windows' Shell.Application.MinimizeAll(). Needs Automation
  // (System Events) permission; callers treat it as best-effort.
  hideOtherApps: 'tell application "System Events" to set visible of (every process whose visible is true and frontmost is false) to false',

  // Put a list of files onto the clipboard as file references (so they can be
  // pasted in Finder), the mac equivalent of Windows' Set-Clipboard -Path.
  setClipboardFiles(paths) {
    const items = paths.map((p) => `POSIX file ${appleScriptQuote(p)}`).join(', ');
    return `set the clipboard to {${items}}`;
  },

  // ── Audio (mic mute + system volume) ──
  // macOS has no "input muted" flag, so mic mute is done by driving the input
  // GAIN to 0 and restoring it. Output (system) volume + mute are first-class.
  getInputVolume: 'input volume of (get volume settings)',
  setInputVolume(v) { return `set volume input volume ${v}`; },
  getVolumeSettings: 'get volume settings',
  setOutputVolume(v) { return `set volume output volume ${v}`; },
  setOutputMuted(b) { return `set volume output muted ${b ? 'true' : 'false'}`; },

  // ── App / window state (Free Up & Quiet, Game Mode) ──
  // Names of every foreground (GUI) app, comma-separated.
  listGuiApps: 'tell application "System Events" to get name of every process whose background only is false',
  // The app currently in front.
  frontmostApp: 'tell application "System Events" to get name of first process whose frontmost is true',
  // Ask an app to quit gracefully.
  quitApp(name) { return `tell application ${appleScriptQuote(name)} to quit`; },
  // Whether the frontmost app is in fullscreen (a rough "a game is on" signal).
  frontmostFullscreen: 'tell application "System Events" to tell (first process whose frontmost is true) to if exists (window 1) then get value of attribute "AXFullScreen" of window 1',
};

module.exports = { osascriptArgs, appleScriptQuote, runAppleScript, scripts };
