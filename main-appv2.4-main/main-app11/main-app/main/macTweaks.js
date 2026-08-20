const { ipcMain } = require('electron');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const cfg = require('./macTweaks.settings');

// macOS Tweaks backend. Reads/writes reversible per-user `defaults` and restarts
// the relevant service (Finder / SystemUIServer) to apply. macOS-only.
function init(ctx) {
  const { logger } = ctx;

  async function readState() {
    const state = {};
    await Promise.all(cfg.TWEAKS.map(async (t) => {
      const r = await runFile('defaults', cfg.tweakReadArgs(t.id), 4000);
      state[t.id] = cfg.tweakIsOn(t.id, r.stdout, r.ok);
    }));
    return state;
  }

  ipcMain.handle('mac-tweaks:get', async () => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    try {
      const tweaks = cfg.TWEAKS.map(({ id, group, label }) => ({ id, group, label }));
      return { ok: true, tweaks, state: await readState() };
    } catch (e) {
      logger.error('macOS Tweaks read failed', e);
      return { ok: false, error: 'read failed' };
    }
  });

  ipcMain.handle('mac-tweaks:set', async (_e, id, on) => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    const plan = cfg.tweakSetArgs(id, !!on);
    if (!plan) return { ok: false, error: 'unknown tweak' };
    const r = await runFile('defaults', plan.args, 4000);
    // `defaults delete` of an unset key exits non-zero — harmless when disabling.
    if (!r.ok && !plan.del) {
      logger.error('macOS Tweak write failed', new Error(r.stderr || 'write failed'), { id });
      return { ok: false, error: 'write failed' };
    }
    const service = cfg.tweakApplyService(id);
    if (service) await runFile('killall', [service], 4000); // no-op if the service isn't running
    return { ok: true };
  });
}

module.exports = { init };
