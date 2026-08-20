const { ipcMain } = require('electron');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const cfg = require('./dockStyler.settings');

// Dock Styler backend (macOS). Reads/writes reversible com.apple.dock defaults
// via the injection-safe runFile('defaults', …) and restarts the Dock to apply.
// Only registers on macOS (see main.js mac-only init block).
function init(ctx) {
  const { logger } = ctx;

  async function readAll() {
    const out = {};
    await Promise.all(cfg.DOCK_SETTINGS.map(async (s) => {
      const r = await runFile('defaults', cfg.dockReadArgs(s.key), 4000);
      // An unset key exits non-zero → fall back to the macOS default.
      out[s.key] = r.ok ? cfg.dockCoerce(s.key, r.stdout) : s.default;
    }));
    return out;
  }

  async function applyDock() { await runFile('killall', ['Dock'], 4000); }

  ipcMain.handle('dock-styler:get', async () => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    try {
      return { ok: true, settings: cfg.DOCK_SETTINGS, values: await readAll() };
    } catch (e) {
      logger.error('Dock Styler read failed', e);
      return { ok: false, error: 'read failed' };
    }
  });

  ipcMain.handle('dock-styler:set', async (_e, key, value) => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    const args = cfg.dockWriteArgs(key, value);
    if (!args) return { ok: false, error: 'invalid setting' };
    const r = await runFile('defaults', args, 4000);
    if (!r.ok) {
      logger.error('Dock Styler write failed', new Error(r.stderr || 'write failed'), { key });
      return { ok: false, error: 'write failed' };
    }
    await applyDock();
    return { ok: true };
  });

  ipcMain.handle('dock-styler:reset', async () => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    for (const args of cfg.dockResetArgsList()) {
      await runFile('defaults', args, 4000); // delete of an unset key is a harmless no-op
    }
    await applyDock();
    logger.success('Dock reset to macOS defaults');
    return { ok: true };
  });
}

module.exports = { init };
