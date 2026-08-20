const { ipcMain } = require('electron');
const { runFile } = require('./shellUtils');
const { isMac } = require('./platform');
const macTools = require('./macTools');
const bu = require('./blueutil');

// macOS Bluetooth backend — registers the SAME IPC channels as the Windows
// bluetooth.js (which is skipped on mac), driven by blueutil. When blueutil isn't
// installed, handlers return { needsTool: 'blueutil' } so the renderer offers a
// 1-click install. macOS-only (init'd in main.js's isMac block).
const TOOL = 'blueutil';
const LABEL = 'blueutil';

function init(ctx) {
  const { logger } = ctx;

  function bin() { return macTools.toolPath(TOOL); }
  const missing = (extra) => ({ ok: false, needsTool: TOOL, toolLabel: LABEL, ...extra });

  async function listDevices() {
    const b = bin();
    if (!b) return missing({ devices: [] });
    const r = await runFile(b, bu.pairedJsonArgs(), 8000);
    if (!r.ok) return { ok: false, devices: [] };
    return { ok: true, devices: bu.parseDevices(r.stdout) };
  }

  async function radioGet() {
    const b = bin();
    if (!b) return missing({ radio: null });
    const r = await runFile(b, bu.powerGetArgs(), 4000);
    return r.ok ? { ok: true, radio: bu.parsePower(r.stdout) } : { ok: false, radio: null };
  }

  async function status() {
    const b = bin();
    if (!b) return missing({ radio: null, devices: [] });
    const [rg, ld] = await Promise.all([radioGet(), listDevices()]);
    return { ok: true, radio: rg.radio || null, devices: ld.devices || [] };
  }

  async function radioSet(state) {
    const b = bin();
    if (!b) return missing();
    const on = state === 'on' || state === 1 || state === true;
    const r = await runFile(b, bu.powerSetArgs(on), 4000);
    return r.ok ? { ok: true } : { ok: false, error: 'Command failed' };
  }

  async function scan() {
    const b = bin();
    if (!b) return missing({ devices: [] });
    const r = await runFile(b, bu.inquiryJsonArgs(5), 12000);
    if (!r.ok) return { ok: false, devices: [] };
    return { ok: true, devices: bu.parseDevices(r.stdout) };
  }

  async function deviceAction(kind, address) {
    const b = bin();
    if (!b) return missing();
    if (!bu.isValidAddress(address)) return { ok: false, error: 'Invalid address' };
    const argsFor = { connect: bu.connectArgs, disconnect: bu.disconnectArgs, pair: bu.pairArgs, remove: bu.unpairArgs }[kind];
    if (!argsFor) return { ok: false, error: 'Unknown action' };
    const r = await runFile(b, argsFor(address), 15000);
    if (!r.ok) logger.warn('Bluetooth action failed', { kind, stderr: (r.stderr || '').slice(0, 120) });
    return r.ok ? { ok: true } : { ok: false, error: 'Command failed' };
  }

  ipcMain.handle('bluetooth-list', () => listDevices());
  ipcMain.handle('bluetooth-status', () => status());
  ipcMain.handle('bluetooth-scan', () => scan());
  ipcMain.handle('bluetooth-radio-get', () => radioGet());
  ipcMain.handle('bluetooth-radio-set', (_e, state) => radioSet(state));
  ipcMain.handle('bluetooth-connect', (_e, a) => deviceAction('connect', a));
  ipcMain.handle('bluetooth-disconnect', (_e, a) => deviceAction('disconnect', a));
  ipcMain.handle('bluetooth-remove', (_e, a) => deviceAction('remove', a));
  ipcMain.handle('bluetooth-pair', (_e, a) => deviceAction('pair', a));
}

module.exports = { init };
