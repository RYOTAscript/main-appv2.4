const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { isMac } = require('./platform');
const { runAppleScript, scripts } = require('./osascript');
const { matchRule } = require('./gameModeMac.logic');

// macOS Game Mode backend — registers the same IPC channels + emits the same
// game-mode-event / game-mode-detect payloads as the Windows gameMode.js (which
// is skipped on mac). The only difference is the watcher: an osascript poll of
// the frontmost app + its fullscreen state, instead of the Win32 FG watcher.
// Actions (mute mic, crosshair, notify, enable widgets) are applied renderer-side
// exactly as on Windows. macOS-only.
function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;
  const CONFIG_PATH = path.join(userDataPath, 'game-mode-config.json');
  const OWN = ['launcher', 'electron', 'main'];

  let config = load();
  let currentExe = '';
  let currentFullscreen = false;
  let activeRuleId = null;
  let timer = null;

  function load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const r = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { enabled: r.enabled === true, rules: Array.isArray(r.rules) ? r.rules : [] };
      }
    } catch (e) { logger.error('Game Mode config read failed', e); }
    return { enabled: false, rules: [] };
  }
  function save() {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8'); }
    catch (e) { logger.error('Game Mode config save failed', e); }
  }
  function send(ch, payload) { const w = getMainWindow(); if (w && !w.isDestroyed()) w.webContents.send(ch, payload); }
  function pushDetect() { send('game-mode-detect', { exe: currentExe, fullscreen: currentFullscreen, activeRuleId }); }
  function status() { return { enabled: config.enabled, rules: config.rules, exe: currentExe, fullscreen: currentFullscreen, activeRuleId }; }

  function evaluate() {
    const matched = matchRule(config.rules, currentExe, currentFullscreen, OWN);
    const id = matched ? matched.id : null;
    if (id !== activeRuleId) {
      const prev = config.rules.find((r) => r.id === activeRuleId);
      if (prev) send('game-mode-event', { type: 'stop', rule: prev, exe: currentExe });
      activeRuleId = id;
      if (matched) { send('game-mode-event', { type: 'start', rule: matched, exe: currentExe }); logger.success('Game Mode activated', { rule: matched.name }); }
    }
    pushDetect();
  }

  async function poll() {
    const f = await runAppleScript(scripts.frontmostApp, 4000);
    const exe = f.ok ? f.stdout.trim() : '';
    let full = false;
    const fsr = await runAppleScript(scripts.frontmostFullscreen, 4000);
    if (fsr.ok) full = /true/i.test(fsr.stdout); // best-effort (needs Accessibility)
    if (exe !== currentExe || full !== currentFullscreen) {
      currentExe = exe; currentFullscreen = full; evaluate();
    }
  }
  function startWatcher() { if (timer) return; timer = setInterval(() => { poll().catch(() => {}); }, 2500); poll().catch(() => {}); }
  function stopWatcher() { if (timer) { clearInterval(timer); timer = null; } }

  ipcMain.handle('game-mode-get', () => status());

  ipcMain.handle('game-mode-set-enabled', (_e, enabled) => {
    config.enabled = !!enabled; save();
    if (config.enabled) {
      startWatcher();
    } else {
      if (activeRuleId) { const prev = config.rules.find((r) => r.id === activeRuleId); if (prev) send('game-mode-event', { type: 'stop', rule: prev, exe: currentExe }); activeRuleId = null; }
      stopWatcher(); currentExe = ''; currentFullscreen = false;
    }
    pushDetect();
    return status();
  });

  ipcMain.handle('game-mode-save-rule', (_e, rule) => {
    if (!rule || !rule.id) return status();
    const i = config.rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) config.rules[i] = rule; else config.rules.push(rule);
    save();
    return status();
  });

  ipcMain.handle('game-mode-delete-rule', (_e, id) => {
    config.rules = config.rules.filter((r) => r.id !== id);
    if (activeRuleId === id) activeRuleId = null;
    save();
    return status();
  });

  ipcMain.handle('game-mode-list-processes', async () => {
    const r = await runAppleScript(scripts.listGuiApps, 6000);
    return r.ok ? r.stdout.split(',').map((s) => s.trim()).filter(Boolean) : [];
  });

  app.on('will-quit', stopWatcher);
  if (config.enabled) startWatcher();

  return { teardown: stopWatcher };
}

module.exports = { init };
