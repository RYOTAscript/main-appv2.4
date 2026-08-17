const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { runCmd } = require('./shellUtils');

// ── App-wide elevation (UAC) ──
// Some features (FPS Optimizer's HKLM writes, service start/stop, powercfg) need
// administrator rights. Rather than trying to elevate a single command — which
// UAC can't do for an already-running unelevated process without relaunching —
// this module relaunches the WHOLE app elevated: it shows the Windows UAC prompt
// and, if the user accepts, starts a fresh admin instance and quits this one. The
// new instance then has admin for the entire session, so every admin-gated step
// just works.
//
// Detection is synchronous and shell-free: only an elevated (or admin) process can
// create a file directly under C:\Windows, so a probe write there is a reliable,
// instant admin check. The result is cached for the process lifetime (elevation
// state can't change without a relaunch).

let cachedElevated = null;

function detectElevatedSync() {
  if (process.platform !== 'win32') return true; // non-Windows: treat as capable
  try {
    const dir = process.env.SystemRoot || 'C:\\Windows';
    const probe = path.join(dir, `main-elev-probe-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, '');
    try { fs.unlinkSync(probe); } catch (e) { /* leftover 0-byte temp is harmless */ }
    return true;
  } catch (e) {
    return false; // EPERM/EACCES → standard (unelevated) user
  }
}

function isElevated() {
  if (cachedElevated === null) cachedElevated = detectElevatedSync();
  return cachedElevated;
}

// Build the { target, args } we relaunch with, mirroring autostart's logic so a
// dev run (electron.exe + app path) and a packaged run (main.exe) both relaunch
// correctly. Existing argv flags (e.g. --startup) are preserved.
function relaunchTarget() {
  const exe = process.execPath;
  const isDevElectron = /electron(?:\.exe)?$/i.test(path.basename(exe));
  const passthrough = process.argv.slice(1).filter((a) => a && a !== '.');
  if (!app.isPackaged && isDevElectron) {
    return { target: exe, args: [app.getAppPath(), ...passthrough] };
  }
  return { target: exe, args: passthrough };
}

// Single-quote for a PowerShell literal string (double any embedded quote).
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Triggers the UAC prompt via Start-Process -Verb RunAs. Returns synchronously:
//   { ok:true,  relaunching:true }  — UAC accepted; this instance is quitting.
//   { ok:false, declined:true }     — UAC dismissed/denied; app stays as-is.
// When accepted, the elevated child is already launching, so we release the
// single-instance lock and quit — the child (delayed by UAC + Electron bootstrap)
// acquires the freed lock well after we've let go of it.
async function relaunchAsAdmin(logger) {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported' };
  if (isElevated()) return { ok: true, alreadyElevated: true };

  const { target, args } = relaunchTarget();
  const argList = args.length ? ` -ArgumentList @(${args.map(psQuote).join(',')})` : '';
  const cmd = `powershell -NoProfile -Command "Start-Process -FilePath ${psQuote(target)}${argList} -Verb RunAs"`;

  // Async (runCmd) so the UAC dialog doesn't freeze the main process while it's up.
  const res = await runCmd(cmd, 120000);
  if (!res.ok) {
    // Non-zero exit here is overwhelmingly "user clicked No / dismissed the UAC
    // dialog" (Start-Process throws when RunAs is denied). Stay running unelevated.
    if (logger) logger.warn('Elevation declined or failed — staying unelevated', { stderr: (res.stderr || '').slice(0, 200) });
    return { ok: false, declined: true };
  }

  if (logger) logger.system('Elevation accepted — relaunching as administrator');
  try { app.releaseSingleInstanceLock(); } catch (e) { /* ignore */ }
  // Give the log write a beat, then quit so the elevated instance takes over.
  setTimeout(() => { try { app.quit(); } catch (e) { /* ignore */ } }, 150);
  return { ok: true, relaunching: true };
}

function init(ctx) {
  const { logger } = ctx;

  // Warm the cache once so the first UI query is instant.
  isElevated();
  logger.system('Elevation state', { elevated: isElevated() });

  ipcMain.handle('admin:is-elevated', () => isElevated());

  // Renderer calls this when a feature needs admin. If already elevated it's a
  // no-op success; otherwise it shows UAC and (on accept) relaunches the app.
  ipcMain.handle('admin:elevate', async () => {
    if (isElevated()) return { ok: true, alreadyElevated: true };
    return relaunchAsAdmin(logger);
  });

  return { isElevated, relaunchAsAdmin: () => relaunchAsAdmin(logger) };
}

module.exports = { init, isElevated };
