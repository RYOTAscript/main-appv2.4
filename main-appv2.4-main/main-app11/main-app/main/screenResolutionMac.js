const { ipcMain } = require('electron');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const macTools = require('./macTools');
const dp = require('./displayplacer');

// macOS Screen Resolution backend — registers the same IPC channels as the
// Windows screenResolution.js (skipped on mac), driven by displayplacer. Returns
// { needsTool: 'displayplacer' } when the CLI isn't installed. macOS-only.
const TOOL = 'displayplacer';
const LABEL = 'displayplacer';

function init(ctx) {
  const { logger } = ctx;
  function bin() { return macTools.toolPath(TOOL); }

  async function listMonitors() {
    const b = bin();
    if (!b) return { ok: false, needsTool: TOOL, toolLabel: LABEL, monitors: [] };
    const r = await runFile(b, ['list'], 8000);
    if (!r.ok) return { ok: false, monitors: [] };
    return { ok: true, monitors: dp.parseDisplayplacerList(r.stdout) };
  }

  ipcMain.handle('screen-resolution-list', () => listMonitors());

  ipcMain.handle('screen-resolution-set', async (_e, device, width, height, refresh) => {
    const b = bin();
    if (!b) return { ok: false, needsTool: TOOL };
    const w = Number(width), h = Number(height), hz = Number(refresh);
    if (!device || !w || !h || !hz) return { ok: false, error: 'Invalid mode' };

    // Look up the exact colour depth for a faithful switch.
    let colorDepth = 8;
    const listRes = await runFile(b, ['list'], 8000);
    if (listRes.ok) {
      const mon = dp.parseDisplayplacerList(listRes.stdout).find((m) => m.id === device);
      colorDepth = dp.colorDepthFor(mon, w, h, hz);
    }

    const r = await runFile(b, [dp.setModeArg(device, w, h, hz, colorDepth)], 15000);
    if (!r.ok) {
      logger.warn('Screen resolution switch failed', { device, stderr: (r.stderr || '').slice(0, 160) });
      return { ok: false, error: 'Switch failed' };
    }
    return { ok: true };
  });
}

module.exports = { init };
