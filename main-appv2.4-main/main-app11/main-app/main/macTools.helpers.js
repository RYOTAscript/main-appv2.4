// Pure helpers for detecting / installing the small, free, permissively-licensed
// Homebrew CLIs that back some macOS widgets (blueutil = MIT, displayplacer =
// MIT). Electron-free + unit-tested. See [[legal-to-sell-rule]]: we INVOKE these
// as the user's own action (install-on-demand), never bundle them, and use only
// the official Homebrew installer.
const { appleScriptQuote } = require('./osascript');

// Where a Homebrew `brew` binary lives (Apple Silicon, then Intel).
const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

// Tools we can install on demand, with their Homebrew formula + friendly label.
// All permissively licensed (blueutil MIT, displayplacer MIT, cliclick MIT).
const TOOLS = {
  blueutil: { label: 'blueutil', formula: 'blueutil' },
  displayplacer: { label: 'displayplacer', formula: 'displayplacer' },
  cliclick: { label: 'cliclick', formula: 'cliclick' },
};

// Absolute paths a CLI tool might live at (the two brew prefixes + /usr/bin).
function toolCandidates(tool) {
  return [`/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, `/usr/bin/${tool}`];
}

// The canonical Homebrew installer (brew.sh). NONINTERACTIVE so it doesn't sit
// waiting on a prompt; still opened in Terminal because it may ask for a password.
const BREW_INSTALL_CMD =
  'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

// AppleScript to run the Homebrew installer in a new Terminal window.
function brewInstallTerminalScript() {
  return `tell application "Terminal" to do script ${appleScriptQuote(BREW_INSTALL_CMD)}`;
}

function brewInstallArgs(formula) { return ['install', formula]; }
function caskInstallArgs(id) { return ['install', '--cask', id]; }
function caskUpgradeArgs() { return ['upgrade', '--cask']; }

// Parse `which <tool>` / command -v output → first non-empty path or ''.
function parseWhich(stdout) {
  const line = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || '';
}

module.exports = {
  BREW_CANDIDATES, TOOLS, toolCandidates, BREW_INSTALL_CMD,
  brewInstallTerminalScript, brewInstallArgs, caskInstallArgs, caskUpgradeArgs, parseWhich,
};
