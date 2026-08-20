const { app, ipcMain, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const { runAppleScript } = require('./osascript');
const macTools = require('./macTools');
const logic = require('./macMacros.logic');

// macOS Macros backend. Plays editor-built macros: keyboard-only macros run via
// osascript (no install — just Accessibility permission); anything with mouse
// steps uses cliclick (a tiny MIT Homebrew CLI, offered via 1-click install).
// Per-macro global hotkeys via globalShortcut. Live recording isn't possible on
// macOS, so macros are built step-by-step in the editor. macOS-only.
function init(ctx) {
  const { logger, userDataPath } = ctx;
  const CONFIG_PATH = path.join(userDataPath, 'mac-macros.json');
  let config = load();
  let registered = [];

  function load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const r = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { enabled: r.enabled === true, macros: Array.isArray(r.macros) ? r.macros : [] };
      }
    } catch (e) { logger.error('mac Macros config read failed', e); }
    return { enabled: false, macros: [] };
  }
  function save() {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8'); }
    catch (e) { logger.error('mac Macros config save failed', e); }
  }

  // Keep only valid steps; cap the count.
  function sanitizeMacro(m) {
    if (!m || typeof m !== 'object') return null;
    const steps = (Array.isArray(m.steps) ? m.steps : []).filter(logic.isValidStep).slice(0, logic.MAX_STEPS);
    return {
      id: String(m.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
      name: String(m.name || 'Macro').slice(0, 80),
      hotkey: typeof m.hotkey === 'string' ? m.hotkey : '',
      steps,
    };
  }

  async function playMacro(macro) {
    if (!macro || !Array.isArray(macro.steps) || !macro.steps.length) return { ok: false, error: 'This macro has no steps yet.' };
    const cli = macTools.toolPath('cliclick');
    const needsMouse = logic.macroNeedsMouse(macro.steps);

    if (cli) {
      const tokens = logic.buildCliclick(macro.steps);
      if (!tokens) return { ok: false, error: 'invalid steps' };
      const r = await runFile(cli, tokens, 60000);
      return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'Playback failed').toString().slice(0, 160) };
    }
    if (needsMouse) return { ok: false, needsTool: 'cliclick', toolLabel: 'cliclick' };

    // Keyboard-only → osascript into the frontmost app.
    const lines = logic.buildOsascript(macro.steps);
    if (!lines) return { ok: false, needsTool: 'cliclick', toolLabel: 'cliclick' };
    const r = await runAppleScript(['tell application "System Events"', ...lines, 'end tell'], 60000);
    return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'Playback failed — grant Accessibility permission to main in System Settings › Privacy.').toString().slice(0, 200) };
  }

  function findMacro(id) { return config.macros.find((m) => m.id === id) || null; }

  function unregisterAll() {
    for (const acc of registered) { try { globalShortcut.unregister(acc); } catch (e) { /* ignore */ } }
    registered = [];
  }
  function registerHotkeys() {
    unregisterAll();
    if (!config.enabled) return;
    for (const m of config.macros) {
      if (!m.hotkey) continue;
      try {
        if (globalShortcut.register(m.hotkey, () => { playMacro(m).catch(() => {}); })) registered.push(m.hotkey);
        else logger.warn('mac Macros hotkey unavailable', { hotkey: m.hotkey });
      } catch (e) { logger.warn('mac Macros hotkey registration failed', e); }
    }
  }

  // ── IPC ──
  ipcMain.handle('mac-macros:get', () => ({
    ok: true,
    enabled: config.enabled,
    macros: config.macros,
    tools: { cliclick: !!macTools.toolPath('cliclick') },
  }));

  ipcMain.handle('mac-macros:set-enabled', (_e, enabled) => {
    config.enabled = !!enabled; save(); registerHotkeys();
    return { ok: true, enabled: config.enabled };
  });

  ipcMain.handle('mac-macros:save', (_e, macro) => {
    const clean = sanitizeMacro(macro);
    if (!clean) return { ok: false, error: 'invalid macro' };
    const i = config.macros.findIndex((m) => m.id === clean.id);
    if (i >= 0) config.macros[i] = clean; else config.macros.push(clean);
    save(); registerHotkeys();
    return { ok: true, macro: clean, macros: config.macros };
  });

  ipcMain.handle('mac-macros:delete', (_e, id) => {
    config.macros = config.macros.filter((m) => m.id !== id);
    save(); registerHotkeys();
    return { ok: true, macros: config.macros };
  });

  ipcMain.handle('mac-macros:play', (_e, id) => {
    const m = findMacro(id);
    if (!m) return { ok: false, error: 'macro not found' };
    return playMacro(m);
  });

  app.on('will-quit', unregisterAll);
  if (config.enabled) registerHotkeys();

  return { teardown: unregisterAll };
}

module.exports = { init };
