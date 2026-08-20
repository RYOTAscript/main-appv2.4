const { ipcMain } = require('electron');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const macTools = require('./macTools');
const { caskInstallArgs } = require('./macTools.helpers');
const { MAC_CASK_CATALOG, MAC_CASK_IDS } = require('./macCaskCatalog');

// macOS App Installer backend — Homebrew Cask. Only ids from MAC_CASK_IDS ever
// reach brew (validated below), via runFile (no shell). Installs run sequentially
// and stream progress to the renderer. macOS-only.
function init(ctx) {
  const { logger, getMainWindow } = ctx;
  let installing = false;
  let cancelRequested = false;

  function send(payload) {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('app-installer-mac:progress', payload);
  }

  async function installedCasks() {
    const b = macTools.brewPath();
    if (!b) return new Set();
    const r = await runFile(b, ['list', '--cask'], 15000);
    if (!r.ok) return new Set();
    return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }

  ipcMain.handle('app-installer-mac:catalog', () => {
    if (!isMac) return { ok: false };
    return { ok: true, catalog: MAC_CASK_CATALOG, brew: { available: !!macTools.brewPath() } };
  });

  ipcMain.handle('app-installer-mac:installed', async () => {
    if (!isMac) return { ok: false, installed: [] };
    return { ok: true, installed: [...await installedCasks()] };
  });

  ipcMain.handle('app-installer-mac:cancel', () => { cancelRequested = true; return { ok: true }; });

  ipcMain.handle('app-installer-mac:install', async (_e, ids) => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    if (!macTools.brewPath()) return { ok: false, needsBrew: true };
    if (installing) return { ok: false, error: 'already running' };

    // Validate every id against the catalog allow-list.
    const list = (Array.isArray(ids) ? ids : []).filter((id) => MAC_CASK_IDS.has(id));
    if (!list.length) return { ok: false, error: 'no valid apps' };

    installing = true;
    cancelRequested = false;
    const already = await installedCasks();
    const brew = macTools.brewPath();

    (async () => {
      for (const id of list) {
        if (cancelRequested) { send({ id, state: 'cancelled' }); break; }
        if (already.has(id)) { send({ id, state: 'skipped', message: 'Already installed' }); continue; }
        send({ id, state: 'installing' });
        const r = await runFile(brew, caskInstallArgs(id), 600000); // up to 10 min per cask
        send({ id, state: r.ok ? 'done' : 'error', message: r.ok ? 'Installed' : (r.stderr || 'Failed').toString().slice(0, 160) });
      }
      installing = false;
      send({ done: true });
      logger.success('App Installer (Homebrew) run complete', { requested: list.length });
    })();

    return { ok: true, started: list.length };
  });
}

module.exports = { init };
