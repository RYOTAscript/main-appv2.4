const { ipcMain } = require('electron');
const path = require('path');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const { runAppleScript, scripts } = require('./osascript');
const L = require('./macFreeUp.logic');

// "Free Up & Quiet" backend (macOS) — the reframed FPS Optimizer. Purges
// inactive memory and gracefully quits background GUI apps (never the protected
// set, never the app you're using). macOS-only.
function init(ctx) {
  const { logger } = ctx;
  const ownImage = path.basename(process.execPath).replace(/\.app$/i, '').toLowerCase();
  const protectedNames = [...L.BASE_PROTECTED, ownImage, 'main', 'electron'];

  async function listQuittableApps() {
    const list = await runAppleScript(scripts.listGuiApps, 6000);
    if (!list.ok) return { names: [], all: [] };
    const all = L.parseAppList(list.stdout);
    const front = await runAppleScript(scripts.frontmostApp, 4000);
    const frontName = front.ok ? front.stdout.trim() : null;
    return { names: L.quitPlan(all, protectedNames, frontName), all };
  }

  ipcMain.handle('mac-freeup:free-memory', async () => {
    if (!isMac) return { ok: false, error: 'macOS only' };
    // `purge` lives at /usr/sbin on macOS; fall back to a bare lookup.
    let r = await runFile('/usr/sbin/purge', [], 30000);
    if (!r.ok) r = await runFile('purge', [], 30000);
    if (!r.ok) return { ok: false, error: 'purge unavailable' };
    logger.success('Freed inactive memory (purge)');
    return { ok: true };
  });

  ipcMain.handle('mac-freeup:list-apps', async () => {
    if (!isMac) return { ok: false, apps: [] };
    try { const { names } = await listQuittableApps(); return { ok: true, apps: names }; }
    catch (e) { logger.error('Free Up list-apps failed', e); return { ok: false, apps: [] }; }
  });

  ipcMain.handle('mac-freeup:quit-apps', async (_e, names) => {
    if (!isMac) return { ok: false };
    // Re-list now and only quit apps that are genuinely running + quittable, so a
    // stale/forged name from the renderer can't quit something protected.
    const { names: quittable } = await listQuittableApps();
    const allowed = new Set(quittable.map((n) => n.toLowerCase()));
    const want = (Array.isArray(names) ? names : []).filter((n) => allowed.has(String(n).toLowerCase()));

    const quit = [], failed = [];
    for (const name of want) {
      const r = await runAppleScript(scripts.quitApp(name), 5000);
      (r.ok ? quit : failed).push(name);
    }
    logger.success('Free Up quit background apps', { quit: quit.length, failed: failed.length });
    return { ok: true, quit, failed };
  });
}

module.exports = { init };
