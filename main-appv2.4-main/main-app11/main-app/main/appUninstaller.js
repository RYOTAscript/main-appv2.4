const { ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const posix = path.posix;
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const L = require('./appUninstaller.logic');

// App Uninstaller backend (macOS). Lists apps, finds their ~/Library leftovers,
// and — only after the pure isPathSafe() guard — moves the selection to the
// Trash via shell.trashItem (REVERSIBLE; never a hard delete). macOS-only.
function init(ctx) {
  const { logger } = ctx;

  async function readInfo(appPath, key) {
    const r = await runFile('defaults', ['read', posix.join(appPath, 'Contents', 'Info'), key], 4000);
    return r.ok ? r.stdout.trim() : '';
  }

  async function listApps() {
    const home = os.homedir();
    const dirs = ['/Applications', posix.join(home, 'Applications')];
    const apps = [];
    const seen = new Set();
    for (const dir of dirs) {
      let entries;
      try { entries = await fsp.readdir(dir); } catch (e) { continue; }
      for (const name of entries) {
        if (!name.endsWith('.app')) continue;
        const appPath = posix.join(dir, name);
        if (seen.has(appPath)) continue;
        seen.add(appPath);
        const bundleId = await readInfo(appPath, 'CFBundleIdentifier');
        const displayName = (await readInfo(appPath, 'CFBundleName')) || name.replace(/\.app$/, '');
        apps.push({
          name: displayName,
          appName: name.replace(/\.app$/, ''),
          path: appPath,
          bundleId,
          protected: L.isProtectedApp(bundleId, appPath),
        });
      }
    }
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return apps;
  }

  // Best-effort recursive size, capped so a giant Caches folder can't stall us.
  async function boundedDirSize(target) {
    let total = 0, count = 0;
    async function walk(p) {
      if (count > 4000) return;
      let st;
      try { st = await fsp.lstat(p); } catch (e) { return; }
      if (st.isSymbolicLink()) return;
      count++;
      if (st.isDirectory()) {
        let kids;
        try { kids = await fsp.readdir(p); } catch (e) { return; }
        for (const k of kids) { if (count > 4000) break; await walk(posix.join(p, k)); }
      } else {
        total += st.size;
      }
    }
    await walk(target);
    return total;
  }

  async function scanLeftovers(app) {
    const home = os.homedir();
    const out = [];
    for (const root of L.LEFTOVER_ROOTS) {
      const dir = posix.join(home, 'Library', root);
      let entries;
      try { entries = await fsp.readdir(dir); } catch (e) { continue; }
      for (const name of entries) {
        if (!L.leftoverMatches(name, app.bundleId, app.appName)) continue;
        const full = posix.join(dir, name);
        if (!L.isPathSafe(full, home)) continue; // defensive — should always pass
        out.push({ path: full, name, root, size: await boundedDirSize(full) });
      }
    }
    return out;
  }

  ipcMain.handle('app-uninstaller:list', async () => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    try { return { ok: true, apps: await listApps() }; }
    catch (e) { logger.error('App Uninstaller list failed', e); return { ok: false, error: 'list failed' }; }
  });

  ipcMain.handle('app-uninstaller:scan', async (_e, app) => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    if (!app || !app.path) return { ok: false, error: 'no app' };
    if (L.isProtectedApp(app.bundleId, app.path)) return { ok: false, error: 'protected app' };
    try { return { ok: true, leftovers: await scanLeftovers(app) }; }
    catch (e) { logger.error('App Uninstaller scan failed', e); return { ok: false, error: 'scan failed' }; }
  });

  ipcMain.handle('app-uninstaller:remove', async (_e, payload) => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    const home = os.homedir();
    const { appPath, bundleId, leftovers } = payload || {};

    const targets = [];
    if (appPath) {
      if (L.isProtectedApp(bundleId, appPath)) return { ok: false, error: 'protected app' };
      targets.push(appPath);
    }
    for (const p of (Array.isArray(leftovers) ? leftovers : [])) targets.push(p);

    const trashed = [], failed = [];
    for (const p of targets) {
      // The one gate: every path must pass the allow-list before it can be moved.
      if (!L.isPathSafe(p, home)) { failed.push({ path: p, error: 'outside the allowed locations — skipped' }); continue; }
      try { await shell.trashItem(p); trashed.push(p); }
      catch (e) { failed.push({ path: p, error: e.message }); }
    }
    logger.success('App Uninstaller moved items to Trash', { trashed: trashed.length, failed: failed.length });
    return { ok: failed.length === 0, trashed, failed };
  });
}

module.exports = { init };
