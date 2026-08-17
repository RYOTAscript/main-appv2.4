const { ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { runCmd, runCmdSync } = require('./shellUtils');

// ── App Installer mini widget (Ninite-style bulk installer) ──
// Pick a bunch of popular apps from a category grid, hit one button, and they
// install silently one after another — the Ninite experience. There is no
// bundled downloader here: Windows' own package manager (winget) does the
// fetching + silent install, so every app is pulled from its real publisher.
//
// The catalog below maps friendly names to exact winget package IDs, grouped
// into the same categories Ninite uses. Installs run sequentially (one winget
// call per app) so we can report clean per-app progress and never overwhelm the
// network; overall progress = finished / total. Everything the user picks is an
// entry from this fixed catalog — an id is validated against the catalog before
// it is ever handed to winget, so no arbitrary string reaches the shell.

// winget exit codes we treat as "already there / nothing to do" rather than a
// hard failure (0x8A15002B no applicable upgrade, 0x8A150061 already installed,
// etc.). Signed 32-bit forms are what child_process reports back.
const ALREADY_CODES = new Set([-1978335189, -1978335135, -1978334967, -1978335215]);

// Ordered so the renderer lays the columns out exactly like Ninite.
const CATALOG = [
  { category: 'Web Browsers', apps: [
    { id: 'Google.Chrome',              name: 'Chrome' },
    { id: 'Mozilla.Firefox',            name: 'Firefox' },
    { id: 'Brave.Brave',                name: 'Brave' },
    { id: 'Opera.Opera',                name: 'Opera' },
    { id: 'Microsoft.Edge',             name: 'Edge' }
  ]},
  { category: 'Messaging', apps: [
    { id: 'Discord.Discord',            name: 'Discord' },
    { id: 'Zoom.Zoom',                  name: 'Zoom' },
    { id: 'SlackTechnologies.Slack',    name: 'Slack' },
    { id: 'Telegram.TelegramDesktop',   name: 'Telegram' },
    { id: 'OpenWhisperSystems.Signal',  name: 'Signal' },
    { id: 'Mozilla.Thunderbird',        name: 'Thunderbird' }
  ]},
  { category: 'Media', apps: [
    { id: 'VideoLAN.VLC',               name: 'VLC' },
    { id: 'Spotify.Spotify',            name: 'Spotify' },
    { id: 'Audacity.Audacity',          name: 'Audacity' },
    { id: 'HandBrake.HandBrake',        name: 'HandBrake' },
    { id: 'CodecGuide.K-LiteCodecPack.Standard', name: 'K-Lite Codecs' },
    { id: 'MusicBee.MusicBee',          name: 'MusicBee' }
  ]},
  { category: 'Imaging', apps: [
    { id: 'GIMP.GIMP',                  name: 'GIMP' },
    { id: 'dotPDN.PaintDotNet',         name: 'Paint.NET' },
    { id: 'KDE.Krita',                  name: 'Krita' },
    { id: 'BlenderFoundation.Blender',  name: 'Blender' },
    { id: 'Inkscape.Inkscape',          name: 'Inkscape' },
    { id: 'ShareX.ShareX',              name: 'ShareX' },
    { id: 'IrfanSkiljan.IrfanView',     name: 'IrfanView' }
  ]},
  { category: 'Documents', apps: [
    { id: 'TheDocumentFoundation.LibreOffice', name: 'LibreOffice' },
    { id: 'SumatraPDF.SumatraPDF',      name: 'SumatraPDF' },
    { id: 'Foxit.FoxitReader',          name: 'Foxit Reader' },
    { id: 'Adobe.Acrobat.Reader.64-bit',name: 'Adobe Reader' },
    { id: 'ONLYOFFICE.DesktopEditors',  name: 'OnlyOffice' }
  ]},
  { category: 'Runtimes', apps: [
    { id: 'Python.Python.3.12',         name: 'Python 3' },
    { id: 'EclipseAdoptium.Temurin.21.JRE', name: 'Java (JRE)' },
    { id: 'Microsoft.DotNet.DesktopRuntime.8', name: '.NET 8 Runtime' },
    { id: 'Microsoft.VCRedist.2015+.x64', name: 'VC++ Redist' }
  ]},
  { category: 'Security', apps: [
    { id: 'Malwarebytes.Malwarebytes',  name: 'Malwarebytes' },
    { id: 'Bitwarden.Bitwarden',        name: 'Bitwarden' },
    { id: 'KeePassXCTeam.KeePassXC',    name: 'KeePassXC' }
  ]},
  { category: 'File Sharing', apps: [
    { id: 'Dropbox.Dropbox',            name: 'Dropbox' },
    { id: 'Google.GoogleDrive',         name: 'Google Drive' },
    { id: 'Mega.MEGASync',              name: 'MEGASync' },
    { id: 'qBittorrent.qBittorrent',    name: 'qBittorrent' }
  ]},
  { category: 'Compression', apps: [
    { id: '7zip.7zip',                  name: '7-Zip' },
    { id: 'RARLab.WinRAR',              name: 'WinRAR' },
    { id: 'Giorgiotani.Peazip',         name: 'PeaZip' }
  ]},
  { category: 'Utilities', apps: [
    { id: 'Microsoft.PowerToys',        name: 'PowerToys' },
    { id: 'TeamViewer.TeamViewer',      name: 'TeamViewer' },
    { id: 'voidtools.Everything',       name: 'Everything' },
    { id: 'RevoUninstaller.RevoUninstaller', name: 'Revo Uninstaller' },
    { id: 'WinDirStat.WinDirStat',      name: 'WinDirStat' },
    { id: 'CodeSector.TeraCopy',        name: 'TeraCopy' }
  ]},
  { category: 'Developer Tools', apps: [
    { id: 'Microsoft.VisualStudioCode', name: 'VS Code' },
    { id: 'Git.Git',                    name: 'Git' },
    { id: 'Notepad++.Notepad++',        name: 'Notepad++' },
    { id: 'PuTTY.PuTTY',                name: 'PuTTY' },
    { id: 'WinSCP.WinSCP',              name: 'WinSCP' },
    { id: 'WinMerge.WinMerge',          name: 'WinMerge' },
    { id: 'TimKosse.FileZilla.Client',  name: 'FileZilla' }
  ]},
  { category: 'Gaming', apps: [
    { id: 'Valve.Steam',                name: 'Steam' },
    { id: 'EpicGames.EpicGamesLauncher',name: 'Epic Games' },
    { id: 'Ubisoft.Connect',            name: 'Ubisoft Connect' },
    { id: 'ElectronicArts.EADesktop',   name: 'EA App' }
  ]}
];

// Flat id → app lookup, so an incoming id can be validated + named in O(1).
const APP_BY_ID = new Map();
for (const group of CATALOG) {
  for (const app of group.apps) APP_BY_ID.set(app.id, { ...app, category: group.category });
}

function init(ctx) {
  const { logger } = ctx;

  // ⚠️ WINDOWS VERSION NOTE: this whole widget depends on winget (the App
  // Installer / Microsoft.DesktopAppInstaller package). Present by default on
  // Windows 11 and up-to-date Windows 10 (1809+). MISSING on: Windows 10/11 LTSC
  // & LTSB, Windows Server, some N/EDU images, and machines where App Installer
  // was never updated from the Store. When absent, runInstall() returns
  // 'winget-missing' and the panel offers open-winget-store — expected, not a bug.
  // winget availability is fixed for the session (the user isn't going to
  // install/remove the package manager mid-run), so probe once and cache.
  let winget = { available: false, version: '' };
  try {
    const res = runCmdSync('winget --version');
    if (res.ok) {
      winget = { available: true, version: (res.stdout || '').trim() };
      logger.system('App Installer: winget detected', { version: winget.version });
    } else {
      logger.warn('App Installer: winget not available', { stderr: res.stderr });
    }
  } catch (e) {
    logger.warn('App Installer: winget probe failed', e);
  }

  // Install queue state. Only one run at a time; a run is a sequence of winget
  // installs with per-app status streamed to the renderer.
  let running = false;
  let cancelRequested = false;
  let session = null;   // { total, done, results:[], startedAt }

  function emit(payload) {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('app-installer:progress', payload);
  }

  function sessionPayload(extra = {}) {
    return {
      running,
      total: session ? session.total : 0,
      done: session ? session.done : 0,
      current: session ? session.current : null,
      results: session ? session.results : [],
      ...extra
    };
  }

  // Install one catalog app via winget. --exact pins the id, --silent +
  // the accept flags make it non-interactive, --disable-interactivity stops
  // winget itself from prompting. A generous timeout guards against an
  // installer that hangs waiting on something we can't see.
  async function installOne(app) {
    const cmd = [
      'winget', 'install',
      '--id', app.id,
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity'
    ].join(' ');

    const res = await runCmd(cmd, 20 * 60 * 1000);
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    const code = typeof res.code === 'number' ? res.code : (res.ok ? 0 : 1);

    if (res.ok || code === 0) return { status: 'installed', code: 0 };
    if (ALREADY_CODES.has(code) || /already installed|No available upgrade/i.test(out)) {
      return { status: 'already', code };
    }
    if (res.killed || /timed out/i.test(out)) return { status: 'failed', code, reason: 'timeout' };
    return { status: 'failed', code, reason: (res.stderr || '').trim().split('\n')[0] || `exit ${code}` };
  }

  async function runInstall(ids) {
    if (running) return { ok: false, error: 'already-running' };
    if (!winget.available) return { ok: false, error: 'winget-missing' };

    // Validate every id against the catalog and drop unknowns / dupes.
    const seen = new Set();
    const apps = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const app = APP_BY_ID.get(raw);
      if (app && !seen.has(app.id)) { seen.add(app.id); apps.push(app); }
    }
    if (!apps.length) return { ok: false, error: 'nothing-selected' };

    running = true;
    cancelRequested = false;
    session = { total: apps.length, done: 0, current: null, results: [], startedAt: Date.now() };
    logger.system('App Installer: install run started', { count: apps.length, ids: apps.map(a => a.id) });
    emit(sessionPayload({ started: true }));

    for (let i = 0; i < apps.length; i++) {
      if (cancelRequested) break;
      const app = apps[i];
      session.current = { id: app.id, name: app.name, index: i };
      emit(sessionPayload({ installing: app.id }));

      let result;
      try {
        result = await installOne(app);
      } catch (e) {
        logger.error('App Installer: install threw', e, { id: app.id });
        result = { status: 'failed', code: 1, reason: 'error' };
      }

      session.done++;
      session.results.push({ id: app.id, name: app.name, ...result });
      if (result.status === 'failed') {
        logger.warn('App Installer: install failed', { id: app.id, code: result.code, reason: result.reason });
      } else {
        logger.success('App Installer: install ' + result.status, { id: app.id });
      }
      emit(sessionPayload());
    }

    running = false;
    session.current = null;
    const cancelled = cancelRequested;
    const summary = {
      installed: session.results.filter(r => r.status === 'installed').length,
      already: session.results.filter(r => r.status === 'already').length,
      failed: session.results.filter(r => r.status === 'failed').length
    };
    logger.success('App Installer: install run finished', { ...summary, cancelled });
    emit(sessionPayload({ finished: true, cancelled, summary }));
    return { ok: true, ...summary, cancelled, results: session.results };
  }

  // ── IPC ──

  ipcMain.handle('app-installer:catalog', () => ({ ok: true, catalog: CATALOG, winget }));

  ipcMain.handle('app-installer:status', () => sessionPayload());

  ipcMain.handle('app-installer:install', async (_e, ids) => runInstall(ids));

  ipcMain.handle('app-installer:cancel', () => {
    // We can't kill an in-flight winget child cleanly here, but we can stop the
    // queue advancing to the next app, which is what "Stop" means to the user.
    if (running) cancelRequested = true;
    return { ok: true, cancelling: running };
  });

  // "What's already installed" so the grid can badge known apps. We use
  // `winget export` rather than parsing `winget list`: list renders a fixed-width
  // console table that TRUNCATES the Id column (so "Google.Chrome" / "Discord.
  // Discord" often didn't match), whereas export writes clean JSON of every
  // installed package winget can correlate to a source — exactly the ids in our
  // catalog. export exits non-zero when some apps can't be exported even though
  // it still writes the file, so we read the file regardless of exit code.
  ipcMain.handle('app-installer:installed', async () => {
    if (!winget.available) return { ok: false, error: 'winget-missing', installed: [] };
    const exportPath = path.join(ctx.userDataPath, 'app-installer-export.json');
    try {
      await runCmd(
        `winget export -o "${exportPath}" --accept-source-agreements --disable-interactivity`,
        120 * 1000
      );
      const have = new Set();
      if (fs.existsSync(exportPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
          for (const src of raw.Sources || []) {
            for (const pkg of src.Packages || []) {
              if (pkg && pkg.PackageIdentifier) have.add(String(pkg.PackageIdentifier).toLowerCase());
            }
          }
        } catch (e) {
          logger.warn('App Installer: export parse failed', e);
        }
        try { fs.unlinkSync(exportPath); } catch (e) { /* leftover temp is harmless */ }
      }
      const installed = [];
      for (const id of APP_BY_ID.keys()) {
        if (have.has(id.toLowerCase())) installed.push(id);
      }
      logger.system('App Installer: installed scan', { found: installed.length });
      return { ok: true, installed };
    } catch (e) {
      logger.warn('App Installer: installed scan failed', e);
      return { ok: false, error: 'scan-failed', installed: [] };
    }
  });

  // ── Presets ── save/load a named set of apps to a file the user can keep, so a
  // preset survives a full PC reset (localStorage is wiped when the app is
  // reinstalled). The renderer owns the live preset store (localStorage); these
  // just move the JSON to/from a file the user picks.
  ipcMain.handle('app-installer:export-presets', async (_e, json) => {
    const win = ctx.getMainWindow();
    const res = await dialog.showSaveDialog(win, {
      title: 'Export app presets',
      defaultPath: 'app-presets.json',
      filters: [{ name: 'App presets', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    try {
      // Round-trip through JSON.parse so we only ever write valid, pretty JSON.
      const data = JSON.parse(typeof json === 'string' ? json : '{}');
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
      logger.success('App Installer: presets exported', { file: res.filePath });
      return { ok: true, path: res.filePath };
    } catch (e) {
      logger.error('App Installer: preset export failed', e);
      return { ok: false, error: 'write-failed' };
    }
  });

  ipcMain.handle('app-installer:import-presets', async () => {
    const win = ctx.getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Import app presets',
      properties: ['openFile'],
      filters: [{ name: 'App presets', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
    try {
      const raw = fs.readFileSync(res.filePaths[0], 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'bad-format' };
      // Keep only { name: [validCatalogId, …] } entries so an imported file can
      // never smuggle an unknown id into a later install.
      const clean = {};
      for (const [name, ids] of Object.entries(data)) {
        if (!Array.isArray(ids)) continue;
        const valid = ids.filter((id) => APP_BY_ID.has(id));
        if (valid.length) clean[String(name).slice(0, 60)] = [...new Set(valid)];
      }
      logger.success('App Installer: presets imported', { count: Object.keys(clean).length });
      return { ok: true, presets: clean };
    } catch (e) {
      logger.error('App Installer: preset import failed', e);
      return { ok: false, error: 'read-failed' };
    }
  });

  // Open the Microsoft Store page for App Installer (which provides winget) when
  // it's missing, so the user can fix it in one click.
  ipcMain.handle('app-installer:open-winget-store', () => {
    shell.openExternal('ms-windows-store://pdp/?productid=9NBLGGH4NNS1').catch(() => {
      shell.openExternal('https://apps.microsoft.com/detail/9NBLGGH4NNS1');
    });
    return { ok: true };
  });

  // ── Bootstrap winget without the Store (fixes F3) ──
  // On Windows 10/11 LTSC, Server and stripped images the Store may be absent, so
  // "open the Store page" isn't a fix. This installs winget the same way Microsoft
  // documents for those environments: download the App Installer msixbundle plus
  // its two runtime dependencies (VC++ Libs, UI.Xaml) straight from Microsoft /
  // the official microsoft-ui-xaml release, then register them with
  // Add-AppxPackage. That's a PER-USER registration — no admin / UAC needed — and
  // every URL is served by Microsoft (aka.ms) or the official Microsoft GitHub org,
  // so this app still never ships or serves the binaries itself.
  async function installWinget() {
    if (winget.available) return { ok: true, already: true, winget };

    const tmp = path.join(ctx.userDataPath, 'winget-bootstrap');
    // Single-quote for a PowerShell literal (double any embedded quote).
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const script =
      `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';` +
      `$tmp=${q(tmp)};New-Item -ItemType Directory -Force -Path $tmp | Out-Null;` +
      `$vc=Join-Path $tmp 'vclibs.appx';$xaml=Join-Path $tmp 'xaml.appx';$wg=Join-Path $tmp 'winget.msixbundle';` +
      `Invoke-WebRequest -Uri 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -OutFile $vc;` +
      `Invoke-WebRequest -Uri 'https://github.com/microsoft/microsoft-ui-xaml/releases/download/v2.8.6/Microsoft.UI.Xaml.2.8.x64.appx' -OutFile $xaml;` +
      `Invoke-WebRequest -Uri 'https://aka.ms/getwinget' -OutFile $wg;` +
      // Dependencies may already be present at an equal/newer version, where
      // Add-AppxPackage throws — that's fine, so swallow those two.
      `try{Add-AppxPackage -Path $vc}catch{};try{Add-AppxPackage -Path $xaml}catch{};` +
      `Add-AppxPackage -Path $wg;Write-Output 'WINGET-BOOTSTRAP-OK'`;

    logger.system('App Installer: bootstrapping winget (Store-less install)');
    const res = await runCmd(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, 5 * 60 * 1000);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leftover temp is harmless */ }

    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!/WINGET-BOOTSTRAP-OK/.test(out)) {
      logger.warn('App Installer: winget bootstrap did not complete', { stderr: (res.stderr || '').slice(0, 300) });
      return { ok: false, error: 'bootstrap-failed', detail: (res.stderr || '').trim().split('\n')[0] || 'download/install failed' };
    }

    // Re-probe so the cached availability (and the UI) reflect the new install.
    // A freshly-registered package can take a moment before winget.exe resolves on
    // PATH, so re-check via the App Execution Alias if the bare command misses.
    let probe = runCmdSync('winget --version');
    if (!probe.ok) {
      const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
      if (fs.existsSync(alias)) probe = runCmdSync(`"${alias}" --version`);
    }
    if (probe.ok) {
      winget = { available: true, version: (probe.stdout || '').trim() };
      logger.success('App Installer: winget bootstrapped', { version: winget.version });
      return { ok: true, winget };
    }
    logger.warn('App Installer: winget installed but not yet resolvable — a relaunch may be needed');
    return { ok: false, error: 'installed-pending', hint: 'Restart main to finish enabling winget.' };
  }

  ipcMain.handle('app-installer:install-winget', () => installWinget());

  return { runInstall };
}

module.exports = { init };
