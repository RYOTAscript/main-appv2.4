const { app, ipcMain, clipboard, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const { isMac } = require('./platform');
const { runAppleScript, scripts, appleScriptQuote } = require('./osascript');
const cc = require('./claudeCcReader');

// macOS Claude Limit backend — registers the same IPC channels as the Windows
// claudeLimit.js (skipped on mac). The reliable path (reading Claude Code's
// ~/.claude transcript for the exact reset), keep-awake (powerSaveBlocker),
// native notify (Notification) and clipboard read are all cross-platform; only
// the window list + prompt-send are re-done with osascript (needs Accessibility
// permission the first time). readWindowText (banner OCR) isn't feasible on mac,
// so it degrades gracefully — the transcript reader is the recommended source.
const LIMIT_RE = /(usage limit|rate limit|message limit|reached your .{0,30}limit|limit reached|you.?ve (hit|reached)|out of (free )?(messages|usage|credits)|\b\d+\s*-\s*hour limit\b|limit will reset|resets? (at|in|on)\b|try again (later|after)|upgrade to continue)/i;

function init(ctx) {
  const { logger, getMainWindow } = ctx;

  // ── Windows list + send (osascript) ──
  async function listWindows() {
    const r = await runAppleScript(scripts.listGuiApps, 6000);
    if (!r.ok) return { ok: false, windows: [] };
    const names = r.stdout.split(',').map((s) => s.trim()).filter(Boolean);
    // Present each app as a "window" the renderer can target (id === app name).
    const windows = names.map((n) => ({ hwnd: n, pid: 0, title: n, process: n }));
    return { ok: true, windows };
  }

  async function sendToWindow(appName, prompt, pressEnter) {
    if (!appName) return { ok: false, error: 'Invalid window' };
    try {
      clipboard.writeText(String(prompt == null ? '' : prompt)); // paste avoids escaping the prompt into AppleScript
    } catch (e) { /* ignore */ }
    const lines = [
      `tell application ${appleScriptQuote(appName)} to activate`,
      'delay 0.4',
      'tell application "System Events" to keystroke "v" using command down',
    ];
    if (pressEnter) { lines.push('delay 0.15', 'tell application "System Events" to key code 36'); } // Return
    const res = await runAppleScript(lines, 15000);
    if (res.ok) logger.success('Claude-limit continue prompt sent (macOS)', { app: appName, pressEnter: !!pressEnter });
    else logger.warn('Claude-limit send failed (needs Accessibility permission?)', { stderr: (res.stderr || '').slice(0, 160) });
    return res.ok ? { ok: true } : { ok: false, error: 'Send failed — grant Accessibility permission to main in System Settings › Privacy.' };
  }

  function readClipboard() {
    try { return { ok: true, text: clipboard.readText() || '' }; }
    catch (e) { return { ok: false, text: '' }; }
  }

  // ── Keep-awake (powerSaveBlocker — cross-platform) ──
  let keepAwakeId = null;
  function setKeepAwake(enabled) {
    try {
      if (enabled) {
        if (keepAwakeId === null || !powerSaveBlocker.isStarted(keepAwakeId)) keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
      } else if (keepAwakeId !== null) {
        if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
        keepAwakeId = null;
      }
      return { ok: true, keepAwake: keepAwakeId !== null };
    } catch (e) { return { ok: false, keepAwake: false }; }
  }

  // ── Native notification (mac uses a PNG icon) ──
  function notify(title, body) {
    try {
      if (!Notification.isSupported()) return { ok: false };
      const icon = path.join(ctx.appRoot || __dirname, 'icons', 'logo.png');
      const n = new Notification({ title: String(title || 'Claude Auto-Continue'), body: String(body || ''), icon, silent: false });
      n.on('click', () => { try { ctx.focusMainWindow?.(); } catch (e) { /* ignore */ } });
      n.show();
      return { ok: true };
    } catch (e) { return { ok: false }; }
  }

  // ── Claude Code transcript watcher (the reliable path) ──
  let ccTimer = null, ccPolling = false, lastCcUuid = '';
  const CC_FRESH_MS = 15 * 60000;
  async function pollCc() {
    if (ccPolling) return;
    ccPolling = true;
    try {
      const ev = cc.scanCcLimit();
      if (!ev || !ev.text || !ev.uuid || ev.uuid === lastCcUuid) return;
      if (Date.now() - ev.ts > CC_FRESH_MS) { lastCcUuid = ev.uuid; return; }
      lastCcUuid = ev.uuid;
      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) win.webContents.send('claude-limit:cc-hit', { text: ev.text, cwd: ev.cwd });
    } catch (e) { /* transient FS races are fine */ } finally { ccPolling = false; }
  }
  function startCcWatch() {
    stopCcWatch();
    try { const ev = cc.scanCcLimit(); if (ev && ev.uuid && Date.now() - ev.ts > CC_FRESH_MS) lastCcUuid = ev.uuid; } catch (e) { /* ignore */ }
    ccTimer = setInterval(() => { pollCc(); }, 5000);
    setTimeout(pollCc, 800);
  }
  function stopCcWatch() { if (ccTimer) { clearInterval(ccTimer); ccTimer = null; } }

  // ── Clipboard watcher ──
  let clipTimer = null, lastClip = '';
  function startWatch() {
    stopWatch();
    try { lastClip = clipboard.readText() || ''; } catch (e) { lastClip = ''; }
    clipTimer = setInterval(() => {
      let t = '';
      try { t = clipboard.readText() || ''; } catch (e) { return; }
      if (t === lastClip) return;
      lastClip = t;
      if (t && LIMIT_RE.test(t)) {
        const win = getMainWindow?.();
        if (win && !win.isDestroyed()) win.webContents.send('claude-limit:clipboard-hit', { text: t });
      }
    }, 2000);
  }
  function stopWatch() { if (clipTimer) { clearInterval(clipTimer); clipTimer = null; } }

  // ── IPC (same channels as Windows) ──
  ipcMain.handle('claude-limit:list-windows', () => listWindows());
  ipcMain.handle('claude-limit:send', (_e, hwnd, prompt, pressEnter) => sendToWindow(hwnd, prompt, pressEnter));
  ipcMain.handle('claude-limit:read-clipboard', () => readClipboard());
  ipcMain.handle('claude-limit:set-watch', (_e, enabled) => { if (enabled) startWatch(); else stopWatch(); return { ok: true, watching: !!enabled }; });
  ipcMain.handle('claude-limit:set-keep-awake', (_e, enabled) => setKeepAwake(!!enabled));
  ipcMain.handle('claude-limit:notify', (_e, title, body) => notify(title, body));
  // Reading a background window's banner text isn't feasible on macOS — the
  // transcript reader below is the recommended, reliable source.
  ipcMain.handle('claude-limit:read-window-text', () => ({ ok: false, text: '', unsupported: true }));
  ipcMain.handle('claude-limit:set-window-watch', () => ({ ok: true, watching: false, unsupported: true }));
  ipcMain.handle('claude-limit:read-cc-limit', () => cc.readCcLimit());
  ipcMain.handle('claude-limit:set-cc-watch', (_e, enabled) => { if (enabled) startCcWatch(); else stopCcWatch(); return { ok: true, watching: !!enabled }; });

  const teardown = () => { stopWatch(); stopCcWatch(); setKeepAwake(false); };
  app.on('will-quit', teardown);
  return { teardown };
}

module.exports = { init };
