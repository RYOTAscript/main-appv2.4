const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { runCmd } = require('./shellUtils');

// Quick Launch Enhanced backend.
//
// Provides the three things the enhanced renderer needs that the base
// launcher (main/appLauncher.js) does not:
//   1. Auto-detecting installed games (Steam + Epic) so they can be
//      dropped into the "Games" folder automatically.
//   2. Telling the renderer which of the pinned apps are currently running,
//      for the running-app indicator dots.
//   3. Launching a batch of apps in one go (Launch Profiles), and launching
//      store URIs (steam://, com.epicgames.launcher://) that the generic
//      open-external handler deliberately refuses.
//
// Everything here is Windows-only and fails soft: a missing store, an
// unreadable manifest, or a blocked reg query just yields fewer results,
// never an exception that reaches the renderer.

// Store-launch URI schemes we explicitly allow. The generic 'open-external'
// handler only opens http/https; game launches need these two, so they are
// whitelisted here (and nowhere else).
const ALLOWED_URI_SCHEMES = ['steam:', 'com.epicgames.launcher:'];

function init(ctx) {
  const { logger } = ctx;

  // ── Steam ────────────────────────────────────────────────────────────────

  // Read the Steam install path from the registry (falls back to the two
  // common default install locations if the key is missing).
  async function getSteamPath() {
    try {
      const { ok, stdout } = await runCmd(
        'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath',
        6000
      );
      if (ok && stdout) {
        const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
        if (m) {
          const p = m[1].trim();
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) {
      logger.warn('Steam registry lookup failed', e);
    }
    for (const guess of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
      if (fs.existsSync(guess)) return guess;
    }
    return null;
  }

  // Parse a Valve VDF blob for every "path" value — used to walk every Steam
  // library folder, not just the default one.
  function parseLibraryPaths(vdf, steamPath) {
    const paths = new Set([steamPath]);
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(vdf)) !== null) {
      paths.add(m[1].replace(/\\\\/g, '\\'));
    }
    return [...paths];
  }

  function readSteamGames(steamPath) {
    const games = [];
    const seen = new Set();
    let libraries = [steamPath];
    try {
      const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
      if (fs.existsSync(vdfPath)) {
        libraries = parseLibraryPaths(fs.readFileSync(vdfPath, 'utf8'), steamPath);
      }
    } catch (e) {
      logger.warn('Failed to read Steam libraryfolders.vdf', e);
    }

    for (const lib of libraries) {
      const appsDir = path.join(lib, 'steamapps');
      let files = [];
      try {
        if (!fs.existsSync(appsDir)) continue;
        files = fs.readdirSync(appsDir).filter(f => /^appmanifest_\d+\.acf$/i.test(f));
      } catch (e) {
        continue;
      }
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(appsDir, file), 'utf8');
          const appid = (raw.match(/"appid"\s*"(\d+)"/i) || [])[1];
          const name = (raw.match(/"name"\s*"([^"]+)"/i) || [])[1];
          if (!appid || !name) continue;
          // Steam's own tools/redistributables masquerade as apps — skip the
          // obvious non-games so the Games folder stays clean.
          if (/^(Steamworks Common Redistributables|Steam Linux Runtime)/i.test(name)) continue;
          if (seen.has(appid)) continue;
          seen.add(appid);
          games.push({
            id: `steam:${appid}`,
            name,
            store: 'steam',
            uri: `steam://rungameid/${appid}`,
            // Games launch through the Steam client via their app id, so there
            // is no single exe to run — the running-indicator matches on the
            // installdir instead (added below when resolvable).
            exe: resolveSteamExe(appsDir, raw)
          });
        } catch (e) {
          // Ignore an individual unreadable manifest.
        }
      }
    }
    return games;
  }

  // Best-effort: the running-indicator wants a process name to match against.
  // We can't know the exe from the acf, but the install dir often shares its
  // name with the exe; returning it lets the renderer do a loose match.
  function resolveSteamExe(appsDir, acf) {
    try {
      const installdir = (acf.match(/"installdir"\s*"([^"]+)"/i) || [])[1];
      if (!installdir) return null;
      const common = path.join(appsDir, 'common', installdir);
      if (!fs.existsSync(common)) return null;
      const exes = fs.readdirSync(common).filter(f => /\.exe$/i.test(f));
      // Prefer an exe whose name resembles the folder (skip unins/setup helpers).
      const pick = exes.find(e => !/^(unins|setup|vcredist|dxsetup|launcher_)/i.test(e)) || exes[0];
      return pick ? path.join(common, pick) : null;
    } catch (e) {
      return null;
    }
  }

  // ── Epic ─────────────────────────────────────────────────────────────────

  function readEpicGames() {
    const games = [];
    const dir = path.join(
      process.env.PROGRAMDATA || 'C:\\ProgramData',
      'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'
    );
    let files = [];
    try {
      if (!fs.existsSync(dir)) return games;
      files = fs.readdirSync(dir).filter(f => /\.item$/i.test(f));
    } catch (e) {
      return games;
    }
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!data.DisplayName || !data.AppName) continue;
        // Skip plugins / non-game artifacts.
        if (data.AppCategories && Array.isArray(data.AppCategories) &&
            !data.AppCategories.includes('games')) continue;
        const exe = data.InstallLocation && data.LaunchExecutable
          ? path.join(data.InstallLocation, data.LaunchExecutable)
          : null;
        games.push({
          id: `epic:${data.AppName}`,
          name: data.DisplayName,
          store: 'epic',
          uri: `com.epicgames.launcher://apps/${encodeURIComponent(data.AppName)}?action=launch&silent=true`,
          exe: exe && fs.existsSync(exe) ? exe : null
        });
      } catch (e) {
        // Ignore an individual malformed manifest.
      }
    }
    return games;
  }

  // ── IPC ────────────────────────────────────────────────────────────────────

  ipcMain.handle('quicklaunch-detect-games', async () => {
    const out = [];
    try {
      const steamPath = await getSteamPath();
      if (steamPath) out.push(...readSteamGames(steamPath));
    } catch (e) {
      logger.error('Steam game detection failed', e);
    }
    try {
      out.push(...readEpicGames());
    } catch (e) {
      logger.error('Epic game detection failed', e);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    logger.log('Game auto-detection complete', 'INFO', { count: out.length });
    return out;
  });

  // Given a list of process "names" (exe basenames the renderer derived from
  // each app's path), return the subset that is currently running. One
  // tasklist call covers every app, so the poll stays cheap.
  ipcMain.handle('quicklaunch-running', async (_event, names) => {
    if (!Array.isArray(names) || !names.length) return [];
    try {
      const { ok, stdout } = await runCmd('tasklist /fo csv /nh', 8000);
      if (!ok || !stdout) return [];
      // Lower-cased set of running image names, e.g. "game.exe".
      const running = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) running.add(m[1].toLowerCase());
      }
      return names.filter(n => n && running.has(String(n).toLowerCase()));
    } catch (e) {
      logger.warn('quicklaunch-running tasklist failed', e);
      return [];
    }
  });

  // Launch a store URI (steam:// or com.epicgames.launcher://). Kept separate
  // from the generic open-external handler, which only permits http/https.
  ipcMain.handle('quicklaunch-launch-uri', async (_event, uri) => {
    let parsed;
    try { parsed = new URL(String(uri)); } catch (e) { parsed = null; }
    if (!parsed || !ALLOWED_URI_SCHEMES.includes(parsed.protocol)) {
      logger.warn('Blocked quicklaunch-launch-uri for disallowed scheme', { uri: String(uri).slice(0, 200) });
      return { success: false, error: 'Unsupported launch URI' };
    }
    try {
      await shell.openExternal(parsed.href);
      logger.success('Launched via store URI', { uri: parsed.href });
      return { success: true };
    } catch (e) {
      logger.error('Store URI launch failed', e, { uri: parsed.href });
      return { success: false, error: e.message };
    }
  });

  // Launch several local executables in one go (Launch Profiles). Each entry
  // is a full path; results are reported per-item so the renderer can toast a
  // summary. A small stagger avoids hammering the shell with simultaneous
  // spawns.
  ipcMain.handle('quicklaunch-launch-many', async (_event, paths) => {
    if (!Array.isArray(paths)) return { launched: 0, failed: 0 };
    let launched = 0;
    let failed = 0;
    for (const raw of paths) {
      let p = typeof raw === 'string' ? raw.trim() : '';
      while (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
        p = p.slice(1, -1).trim();
      }
      if (!p) { failed++; continue; }
      try {
        if (/^[a-z][a-z0-9.+-]*:\/\//i.test(p)) {
          // A store/protocol URI inside a profile.
          let parsed = null;
          try { parsed = new URL(p); } catch (e) { parsed = null; }
          if (parsed && ALLOWED_URI_SCHEMES.includes(parsed.protocol)) {
            await shell.openExternal(parsed.href);
            launched++;
          } else {
            failed++;
          }
        } else if (fs.existsSync(p)) {
          const err = await shell.openPath(p);
          if (err) { failed++; } else { launched++; }
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    logger.log('Launch profile executed', 'INFO', { launched, failed });
    return { launched, failed };
  });
}

module.exports = { init };
