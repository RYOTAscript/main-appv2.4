const { ipcMain } = require('electron');
const fs = require('fs');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const { runAppleScript } = require('./osascript');
const H = require('./macTools.helpers');

// Shared macOS tool detection + on-demand install (Homebrew + blueutil /
// displayplacer). Other mac widgets call hasTool()/toolPath(); the renderer's
// "Install <tool>" button calls the `mac-tools:install` IPC. See
// macTools.helpers.js for the (legal) install commands.

function firstExisting(paths) {
  for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch (e) { /* skip */ } }
  return null;
}

function brewPath() { return firstExisting(H.BREW_CANDIDATES); }
function toolPath(tool) { return firstExisting(H.toolCandidates(tool)); }
function hasTool(tool) { return !!toolPath(tool); }

async function installTool(tool, logger) {
  const brew = brewPath();
  if (!brew) {
    // Homebrew first — open its official installer in Terminal (may need a
    // password, so it can't be silent). The renderer tells the user to retry.
    await runAppleScript(H.brewInstallTerminalScript());
    return { ok: false, opened: true, needsBrew: true };
  }
  if (tool === 'brew') return { ok: true, alreadyBrew: true };
  const formula = (H.TOOLS[tool] && H.TOOLS[tool].formula) || tool;
  const r = await runFile(brew, H.brewInstallArgs(formula), 300000); // brew install, up to 5 min
  if (!r.ok) logger && logger.warn && logger.warn('brew install failed', { tool, stderr: (r.stderr || '').slice(0, 200) });
  return { ok: r.ok, error: r.ok ? undefined : (r.stderr || 'install failed').toString().slice(0, 300) };
}

function init(ctx) {
  const { logger } = ctx;

  ipcMain.handle('mac-tools:status', () => {
    if (!isMac) return { ok: false };
    return {
      ok: true,
      brew: !!brewPath(),
      tools: { blueutil: hasTool('blueutil'), displayplacer: hasTool('displayplacer'), cliclick: hasTool('cliclick') },
    };
  });

  ipcMain.handle('mac-tools:install', async (_e, tool) => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    if (!['blueutil', 'displayplacer', 'cliclick', 'brew'].includes(tool)) return { ok: false, error: 'unknown tool' };
    try { return await installTool(tool, logger); }
    catch (e) { logger.error('mac-tools install failed', e, { tool }); return { ok: false, error: 'install failed' }; }
  });
}

module.exports = { init, hasTool, toolPath, brewPath };
