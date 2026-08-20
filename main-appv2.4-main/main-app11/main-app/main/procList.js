const path = require('path');

// Running-process listing, cross-platform. Pure parsers (electron-free) so the
// name extraction is unit-testable on Windows. Used by quickLaunch's
// running-app indicator and anywhere else that needs "is X running?".

// The command that lists running processes for a platform.
//   Windows: tasklist CSV (image name is the first quoted field)
//   macOS/Linux: `ps -axo comm=` — the command path, one per line, no header
function listCommand(platform) {
  return platform === 'win32' ? 'tasklist /fo csv /nh' : 'ps -axo comm=';
}

// Parse Windows `tasklist /fo csv /nh` → Set of lowercased image names ("game.exe").
function parseTasklistNames(stdout) {
  const running = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) running.add(m[1].toLowerCase());
  }
  return running;
}

// Parse `ps -axo comm=` → Set of lowercased names. `comm` is usually a full path
// (/Applications/Discord.app/Contents/MacOS/Discord); we index BOTH the leaf
// basename and the enclosing `.app` bundle name, so a renderer matching on
// either ("Discord.app" or "Discord") lights up the running dot.
function parsePsNames(stdout) {
  const running = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const cmd = line.trim();
    if (!cmd) continue;
    const base = path.posix.basename(cmd.replace(/\\/g, '/'));
    if (base) running.add(base.toLowerCase());
    const appMatch = cmd.match(/([^/\\]+)\.app(?:[/\\]|$)/i);
    if (appMatch) running.add(appMatch[1].toLowerCase());
  }
  return running;
}

// Parse the running-name set for the given platform + tool output.
function parseRunningNames(platform, stdout) {
  return platform === 'win32' ? parseTasklistNames(stdout) : parsePsNames(stdout);
}

module.exports = { listCommand, parseTasklistNames, parsePsNames, parseRunningNames };
