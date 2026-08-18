const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runCmd, runCmdSync } = require('./shellUtils');

// ── Deep Uninstaller mini widget (Revo-Uninstaller-style) ──
// Uninstall a program the way Revo does it: not just "run the built-in
// uninstaller and hope", but a guided 6-stage wipe that also sweeps up the
// leftover files, folders and registry keys the program's own uninstaller
// leaves behind.
//
// The six stages (see STAGES below), streamed live to the panel:
//   1. Restore point   — a System Restore checkpoint first (best-effort; needs
//                        admin + System Protection, so it may legitimately be
//                        skipped — reported honestly, never faked).
//   2. Analyze         — record the program's install folder, uninstall command
//                        and registry footprint from the Uninstall hive.
//   3. Uninstall       — run the program's OWN uninstaller (QuietUninstallString
//                        when it exists, a clean silent `msiexec /x` for MSI
//                        products, otherwise the raw UninstallString).
//   4. Scan leftovers  — after the built-in uninstaller runs, hunt for surviving
//                        traces: the install folder, per-user/app-data folders
//                        named after the program or publisher, Start-menu
//                        shortcuts and Software\<Name|Publisher> registry keys.
//   5. Clean leftovers — delete the leftovers the user ticks. (Stages 4→5 pause
//                        for the user to review — nothing is deleted without a
//                        tick, exactly like Revo.)
//   6. Done            — summary of everything that happened.
//
// Design rules that keep a genuinely destructive tool safe:
//   • It only ever acts on ONE program the user explicitly picked, and only
//     removes leftovers the user explicitly ticks.
//   • The renderer never sends a raw path or command. It sends ids that index
//     into server-held maps (PROGRAMS / session.leftoverMap), mirroring the
//     App Installer's APP_BY_ID guard — an arbitrary string can never reach a
//     shell or a delete.
//   • Every leftover path is RE-VALIDATED before deletion against a fixed
//     allow-list of roots (Program Files, ProgramData, the per-user app-data
//     folders, the program's own recorded install location, the Start menu) and
//     a depth guard, so nothing outside those trees — and never a root itself —
//     can be deleted. Registry deletes are pinned to the Software subtree.
//   • Failures (access-denied, admin-only, a stubborn uninstaller) are reported
//     per-item, never swallowed.

const STAGES = [
  { key: 'restore',   label: 'Create restore point' },
  { key: 'analyze',   label: 'Analyze installation' },
  { key: 'uninstall', label: 'Run the program’s uninstaller' },
  { key: 'scan',      label: 'Scan for leftovers' },
  { key: 'clean',     label: 'Remove leftovers' },
  { key: 'done',      label: 'Finished' }
];

// A registry path we're willing to delete must live under one of the Software
// hives (never a hive root) and contain only tame characters.
const SAFE_REGPATH = /^HK(LM|CU)\\SOFTWARE\\[A-Za-z0-9 ._\-{}\\+()]+$/i;

// Normalise a name for fuzzy folder/key matching: letters+digits only, lower.
function norm(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// Names we must NEVER delete a folder or registry key for, even if a program's
// publisher/name happens to equal one. These are shared OS / vendor roots that
// hold data far beyond the one program (e.g. a program published by "Microsoft"
// must never let us offer %APPDATA%\Microsoft or HKLM\SOFTWARE\Microsoft). The
// check is on the leaf name of the candidate path — a real per-app subfolder
// under one of these is still fair game.
const CRITICAL_NAMES = new Set([
  'microsoft', 'windows', 'windowsapps', 'commonfiles', 'common', 'system', 'system32',
  'wow6432node', 'classes', 'programs', 'startmenu', 'users', 'appdata', 'local',
  'locallow', 'roaming', 'temp', 'tmp', 'microsoftshared', 'internetexplorer',
  'windowsnt', 'currentversion', 'policies', 'defaultuser', 'default', 'public',
  'intel', 'nvidiacorporation', 'nvidia', 'amd', 'realtek', 'programdata'
]);

// PowerShell's provider paths look like
// "Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE\SOFTWARE\..." — turn
// that (or a bare HKEY_… path) into a `reg`-style "HKLM\SOFTWARE\..." string.
function toRegStyle(psPath) {
  let p = String(psPath || '');
  p = p.replace(/^.*Registry::/i, '');
  p = p.replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM')
       .replace(/^HKEY_CURRENT_USER/i, 'HKCU')
       .replace(/^HKEY_CLASSES_ROOT/i, 'HKCR')
       .replace(/^HKEY_USERS/i, 'HKU');
  return p;
}

function init(ctx) {
  const { logger } = ctx;

  // PowerShell availability is fixed for the session — probe once and cache.
  // Everything here (enumeration, uninstall, scan) needs it.
  let ps = { available: false };
  try {
    const res = runCmdSync('powershell -NoProfile -Command "$PSVersionTable.PSVersion.Major"');
    ps = { available: !!res.ok };
    if (res.ok) logger.system('Deep Uninstaller: PowerShell detected');
    else logger.warn('Deep Uninstaller: PowerShell not available', { stderr: res.stderr });
  } catch (e) {
    logger.warn('Deep Uninstaller: PowerShell probe failed', e);
  }

  // id → program record. Rebuilt on each listPrograms() so an incoming id can be
  // validated + resolved to its real uninstall command in O(1). The renderer
  // only ever sends these ids, never a raw command.
  const PROGRAMS = new Map();

  // One uninstall at a time. session holds the live pipeline state that the
  // panel renders (stage statuses, log lines, discovered leftovers).
  let running = false;
  let cancelRequested = false;
  let session = null;

  function emit(payload) {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('revo-uninstaller:progress', payload);
  }

  function newSession(program) {
    return {
      program: { id: program.id, name: program.name },
      stages: STAGES.map((s) => ({ key: s.key, label: s.label, status: 'pending', note: '' })),
      log: [],
      leftovers: [],       // public leftover list shown to the user
      leftoverMap: new Map(), // leftover id → { type, path } (server-only)
      phase: 'running',    // running | review | cleaning | done
      summary: null,
      startedAt: Date.now()
    };
  }

  function sessionPayload(extra = {}) {
    if (!session) return { running, phase: 'idle', ...extra };
    return {
      running,
      phase: session.phase,
      program: session.program,
      stages: session.stages,
      log: session.log,
      leftovers: session.leftovers,
      summary: session.summary,
      ...extra
    };
  }

  function stageIndex(key) { return STAGES.findIndex((s) => s.key === key); }

  function setStage(key, status, note = '') {
    const st = session.stages[stageIndex(key)];
    if (st) { st.status = status; if (note) st.note = note; }
    emit(sessionPayload());
  }

  function log(line) {
    session.log.push(line);
    if (session.log.length > 200) session.log.shift();
    emit(sessionPayload());
  }

  // ── Enumerate installed programs from the three Uninstall hives ──
  // We read HKLM (64-bit), HKLM\WOW6432Node (32-bit) and HKCU (per-user). We keep
  // only real, user-facing programs: a DisplayName, not a SystemComponent, not a
  // Windows Update / hotfix, not a child MSI patch entry.
  async function listPrograms(force = false) {
    if (!ps.available) return { ok: false, error: 'ps-missing', programs: [] };
    if (PROGRAMS.size && !force) {
      return { ok: true, programs: [...PROGRAMS.values()].map(publicProgram) };
    }
    const script =
      "$paths=@(" +
      "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
      "$items=foreach($p in $paths){Get-ItemProperty $p -ErrorAction SilentlyContinue|" +
      "Where-Object{$_.DisplayName -and -not $_.SystemComponent -and -not $_.ReleaseType -and -not $_.ParentKeyName -and $_.DisplayName -notmatch '^(KB[0-9]{6,}|Security Update|Update for)'}}" +
      ";$items|ForEach-Object{[PSCustomObject]@{name=$_.DisplayName;version=$_.DisplayVersion;publisher=$_.Publisher;" +
      "location=$_.InstallLocation;uninstall=$_.UninstallString;quiet=$_.QuietUninstallString;" +
      "size=$_.EstimatedSize;icon=$_.DisplayIcon;key=$_.PSPath}}|ConvertTo-Json -Compress -Depth 3";

    const res = await runCmd(`powershell -NoProfile -NonInteractive -Command "${script}"`, 90 * 1000);
    if (!res.ok && !(res.stdout || '').trim()) {
      logger.warn('Deep Uninstaller: program scan failed', { stderr: res.stderr });
      return { ok: false, error: 'scan-failed', programs: [] };
    }

    let parsed;
    try {
      const raw = (res.stdout || '').trim();
      parsed = raw ? JSON.parse(raw) : [];
    } catch (e) {
      logger.warn('Deep Uninstaller: program scan parse failed', e);
      return { ok: false, error: 'parse-failed', programs: [] };
    }
    if (!Array.isArray(parsed)) parsed = [parsed];

    PROGRAMS.clear();
    const seen = new Set();
    for (const row of parsed) {
      if (!row || !row.name) continue;
      const keyPath = toRegStyle(row.key);
      const uninstall = String(row.uninstall || '').trim();
      const quiet = String(row.quiet || '').trim();
      // No way to uninstall it → nothing this widget can do, so hide it.
      if (!uninstall && !quiet) continue;
      const id = crypto.createHash('sha1').update(keyPath || row.name).digest('hex').slice(0, 12);
      if (seen.has(id)) continue;
      seen.add(id);
      PROGRAMS.set(id, {
        id,
        name: String(row.name).trim(),
        version: String(row.version || '').trim(),
        publisher: String(row.publisher || '').trim(),
        location: String(row.location || '').trim(),
        uninstall,
        quiet,
        // EstimatedSize is in KB.
        sizeKb: Number.isFinite(+row.size) ? +row.size : 0,
        regKey: keyPath,
        icon: String(row.icon || '').trim()
      });
    }

    logger.system('Deep Uninstaller: program scan', { found: PROGRAMS.size });
    return { ok: true, programs: [...PROGRAMS.values()].map(publicProgram) };
  }

  // What the panel is allowed to see — never the raw uninstall command line.
  function publicProgram(p) {
    return { id: p.id, name: p.name, version: p.version, publisher: p.publisher, sizeKb: p.sizeKb, hasLocation: !!p.location };
  }

  // ── Stage 1: restore point (best-effort) ──
  async function stageRestorePoint(program) {
    setStage('restore', 'active');
    log('Creating a System Restore point…');
    const cmd = `powershell -NoProfile -NonInteractive -Command "try{Checkpoint-Computer -Description 'main Uninstall: ${program.name.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 40)}' -RestorePointType 'APPLICATION_UNINSTALL' -ErrorAction Stop; Write-Output 'OK'}catch{Write-Output ('ERR:'+$_.Exception.Message)}"`;
    const res = await runCmd(cmd, 2 * 60 * 1000);
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (/(^|\n)\s*OK\s*(\n|$)/.test(out)) {
      setStage('restore', 'done', 'Restore point created');
      log('Restore point created.');
      return;
    }
    // Restore points need admin + System Protection on. A miss here is expected
    // on plenty of machines and must not block the uninstall.
    const m = out.match(/ERR:(.+)/);
    const reason = (m ? m[1] : '').trim().split('\n')[0] || 'unavailable';
    setStage('restore', 'skipped', 'Skipped — ' + reason.slice(0, 60));
    log('Restore point skipped (' + reason.slice(0, 80) + ').');
  }

  // ── Stage 2: analyze ──
  function stageAnalyze(program) {
    setStage('analyze', 'active');
    log(`Analyzing ${program.name}…`);
    const bits = [];
    if (program.publisher) bits.push('by ' + program.publisher);
    if (program.location) { bits.push('install folder recorded'); log('Install folder: ' + program.location); }
    if (program.regKey) log('Uninstall key: ' + program.regKey);
    setStage('analyze', 'done', bits.join(' · ') || 'Ready');
  }

  // ── Stage 3: run the program's own uninstaller ──
  // Prefer a silent path: QuietUninstallString, or a clean `msiexec /x {GUID}`
  // for MSI products; otherwise fall back to the raw UninstallString (which may
  // show the program's own uninstall UI — expected, same as Revo).
  function buildUninstallCommand(program) {
    if (program.quiet) return { cmd: program.quiet, silent: true };
    const u = program.uninstall;
    const guid = u.match(/\{[0-9A-Fa-f-]{36}\}/);
    if (guid && /msiexec/i.test(u)) {
      return { cmd: `msiexec.exe /x ${guid[0]} /quiet /norestart`, silent: true };
    }
    return { cmd: u, silent: false };
  }

  async function stageUninstall(program) {
    setStage('uninstall', 'active');
    const { cmd, silent } = buildUninstallCommand(program);
    log(silent ? 'Running the silent uninstaller…' : 'Launching the program’s uninstaller…');

    // Write the raw command verbatim into a temp .cmd so we never have to
    // re-quote a command line that already contains its own quotes.
    const cmdFile = path.join(ctx.userDataPath, `revo-uninstall-${Date.now()}.cmd`);
    let res;
    try {
      fs.writeFileSync(cmdFile, `@echo off\r\n${cmd}\r\n`, 'utf8');
      // exec already runs us through `cmd /d /s /c "…"`; this inner `cmd /c
      // "<file>"` keeps the batch-file path cleanly quoted for spaces.
      res = await runCmd(`cmd /c "${cmdFile}"`, 30 * 60 * 1000);
    } catch (e) {
      logger.error('Deep Uninstaller: uninstall exec failed', e, { id: program.id });
      res = { ok: false, stderr: 'exec-error' };
    } finally {
      try { fs.unlinkSync(cmdFile); } catch (e) { /* leftover temp is harmless */ }
    }

    // Many uninstallers return 0; MSI returns 1605 ("not installed") if it was
    // already gone, 3010 ("reboot required") on success. Treat those as success.
    const code = typeof res.code === 'number' ? res.code : (res.ok ? 0 : 1);
    const okCodes = new Set([0, 1605, 3010, -2147023741]);
    if (res.ok || okCodes.has(code)) {
      setStage('uninstall', 'done', code === 3010 ? 'Done (reboot recommended)' : 'Uninstalled');
      log('The program’s uninstaller finished.');
      return { ok: true, code };
    }
    setStage('uninstall', 'failed', 'Exit code ' + code);
    log('The uninstaller exited with code ' + code + '. Leftover scan will still run.');
    return { ok: false, code };
  }

  // ── Stage 4: scan for leftovers ──
  // The deep sweep. We hand the program's identity (name/publisher/install
  // folder/icon/uninstall key) to a PowerShell scanner via a temp JSON file — no
  // user text is ever interpolated into the script — and it returns a typed,
  // categorised, confidence-scored list of every surviving trace it can find:
  // install & vendor folders, per-user/app-data folders (incl. nested
  // Publisher\App), Start-menu + desktop shortcuts, Software\<App|Publisher>
  // registry keys, the Uninstall key, App Paths entries and Run/RunOnce startup
  // values that point back into the program. The scanner is run as a temp .ps1
  // via -File so a large script needs no shell-quote gymnastics.
  async function stageScan(program) {
    setStage('scan', 'active');
    log('Deep-scanning for leftover files, folders, shortcuts and registry entries…');

    const stamp = Date.now();
    const inputFile = path.join(ctx.userDataPath, `revo-scan-${stamp}.json`);
    const scriptFile = path.join(ctx.userDataPath, `revo-scan-${stamp}.ps1`);
    fs.writeFileSync(inputFile, JSON.stringify({
      name: program.name, publisher: program.publisher, location: program.location,
      regKey: program.regKey, icon: program.icon || ''
    }), 'utf8');
    // The only value substituted into the script is inputFile, a path we control
    // under userDataPath — never user input. Single-quoted → backslashes literal.
    fs.writeFileSync(scriptFile, SCAN_SCRIPT.replace('__INPUT__', inputFile.replace(/'/g, "''")), 'utf8');

    let found = [];
    try {
      const res = await runCmd(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`,
        3 * 60 * 1000
      );
      const raw = (res.stdout || '').trim();
      if (raw) {
        let parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) parsed = [parsed];
        found = parsed;
      }
    } catch (e) {
      logger.warn('Deep Uninstaller: leftover scan failed', e, { id: program.id });
    } finally {
      try { fs.unlinkSync(inputFile); } catch (e) { /* harmless */ }
      try { fs.unlinkSync(scriptFile); } catch (e) { /* harmless */ }
    }

    // De-dupe and build the id → record map. Only keep entries that pass the
    // deletion safety check, so the user is never offered something we'd refuse
    // to delete anyway.
    const seen = new Set();
    const items = [];
    for (const row of found) {
      if (!row || !row.type || !row.path) continue;
      const p = String(row.path);
      const name = row.name != null ? String(row.name) : '';
      const rec = { type: String(row.type), path: p, name };
      const dedupeKey = (rec.type === 'regkey' || rec.type === 'regvalue' ? p.toUpperCase() : p.toLowerCase()) + '|' + name.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      if (!leftoverIsSafe(rec, program)) continue;
      seen.add(dedupeKey);
      const id = crypto.createHash('sha1').update(rec.type + '|' + p + '|' + name).digest('hex').slice(0, 12);
      const confidence = row.confidence === 'high' ? 'high' : 'normal';
      const size = Number.isFinite(+row.size) ? +row.size : 0;
      session.leftoverMap.set(id, rec);
      items.push({
        id, type: rec.type, path: p, name: name || undefined,
        category: String(row.category || 'Other'),
        confidence, size,
        label: leftoverLabel(rec)
      });
    }

    // Sort: high-confidence first, then biggest, then by category — the most
    // obviously-safe, highest-impact removals bubble to the top.
    items.sort((a, b) =>
      (b.confidence === 'high') - (a.confidence === 'high') ||
      (b.size || 0) - (a.size || 0) ||
      a.category.localeCompare(b.category));
    session.leftovers = items;

    const high = items.filter((i) => i.confidence === 'high').length;
    setStage('scan', 'done', items.length
      ? `${items.length} leftover${items.length === 1 ? '' : 's'} found${high ? ` (${high} high-confidence)` : ''}`
      : 'No leftovers found');
    log(items.length ? `Found ${items.length} leftover item(s) across files, folders and the registry.` : 'No leftovers found — clean uninstall.');
  }

  function leftoverLabel(rec) {
    if (rec.type === 'regvalue') return rec.name || rec.path;
    if (rec.type === 'regkey') {
      const seg = rec.path.split('\\').filter(Boolean);
      return seg[seg.length - 1] || rec.path;
    }
    const base = path.basename(rec.path.replace(/[\\/]+$/, ''));
    return base || rec.path;
  }

  // ── Deletion safety: an allow-list of roots + a depth guard ──
  function allowedRoots(program) {
    const env = process.env;
    const roots = [
      env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData,
      env.APPDATA, env.LOCALAPPDATA,
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : '',
      env.ProgramData ? path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
      env.APPDATA ? path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : ''
    ];
    // The program's own recorded install folder is only trusted as a root if it's
    // itself deep enough to be a real app folder (never C:\ or C:\Program Files).
    if (program && program.location) {
      const segs = program.location.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
      if (segs.length >= 3) roots.push(program.location);
    }
    return roots.filter(Boolean).map((r) => path.resolve(r).toLowerCase());
  }

  function leftoverIsSafe(item, program) {
    if (item.type === 'regvalue') {
      // Deleting a single VALUE under a Software key (e.g. a Run startup entry).
      // The key stays; only the named value goes, so the CRITICAL_NAMES leaf
      // guard doesn't apply — but the path must be in the Software subtree and
      // the value name must be tame (no shell metacharacters / quotes).
      if (!SAFE_REGPATH.test(item.path)) return false;
      const nm = String(item.name || '');
      return nm.length > 0 && nm.length <= 255 && !/["\r\n\t]/.test(nm);
    }
    if (item.type === 'regkey') {
      if (!SAFE_REGPATH.test(item.path)) return false;
      // Refuse anything that would delete a whole vendor-agnostic hive branch.
      const tail = item.path.split('\\').filter(Boolean);
      if (tail.length < 3) return false; // HK.. \ SOFTWARE \ <something>
      // Never a shared OS/vendor root, even if a publisher is literally named it.
      if (CRITICAL_NAMES.has(norm(tail[tail.length - 1]))) return false;
      return true;
    }
    if (item.type !== 'file' && item.type !== 'folder') return false;
    let resolved;
    try { resolved = path.resolve(item.path); } catch (e) { return false; }
    const low = resolved.toLowerCase();
    // Never a bare drive root or a Windows/system directory.
    if (/^[a-z]:\\?$/.test(low)) return false;
    if (/\\windows(\\|$)/.test(low) && !low.includes('\\start menu\\')) return false;
    // Never a shared OS/vendor root folder (leaf-name guard) — but a per-app
    // subfolder / shortcut file under one is fine.
    if (item.type === 'folder' && CRITICAL_NAMES.has(norm(path.basename(resolved)))) return false;
    const roots = allowedRoots(program);
    for (const root of roots) {
      if (low === root) return false; // never delete a root itself
      if (low.startsWith(root + path.sep) && low.length > root.length + 1) return true;
    }
    return false;
  }

  // ── Stage 5+6: clean the ticked leftovers, then finish ──
  async function cleanLeftovers(ids) {
    if (!session || session.phase !== 'review') return { ok: false, error: 'not-reviewing' };
    running = true;
    session.phase = 'cleaning';
    setStage('clean', 'active');

    const program = PROGRAMS.get(session.program.id) || null;
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const results = [];

    for (const item of session.leftovers) {
      if (!wanted.has(item.id)) { results.push({ id: item.id, status: 'kept' }); continue; }
      const rec = session.leftoverMap.get(item.id);
      if (!rec || !leftoverIsSafe(rec, program)) {
        results.push({ id: item.id, status: 'failed', reason: 'blocked' });
        log('Refused to remove ' + item.label + ' (safety check).');
        continue;
      }
      log('Removing ' + item.label + '…');
      let r;
      try {
        r = await removeLeftover(rec);
      } catch (e) {
        r = { status: 'failed', reason: 'error' };
      }
      results.push({ id: item.id, status: r.status, reason: r.reason });
      item.result = r.status;
      emit(sessionPayload());
    }

    const summary = {
      removed: results.filter((r) => r.status === 'removed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      kept: results.filter((r) => r.status === 'kept').length
    };
    setStage('clean', 'done', `${summary.removed} removed`);
    setStage('done', 'done', 'Uninstall complete');
    session.phase = 'done';
    session.summary = summary;
    running = false;
    log('Done — ' + summary.removed + ' leftover(s) removed, ' + summary.failed + ' failed.');
    logger.success('Deep Uninstaller: cleanup finished', { program: session.program.name, ...summary });
    emit(sessionPayload({ finished: true, summary }));

    // Refresh the program cache so the just-removed program drops out of the list.
    PROGRAMS.delete(session.program.id);
    return { ok: true, summary };
  }

  async function removeLeftover(rec) {
    if (rec.type === 'regvalue') {
      const res = await runCmd(`reg delete "${rec.path}" /v "${rec.name}" /f`, 30 * 1000);
      const out = `${res.stdout || ''}${res.stderr || ''}`;
      if (res.ok || /cannot find|unable to find/i.test(out)) return { status: 'removed' };
      return { status: 'failed', reason: /denied/i.test(out) ? 'access denied' : 'reg error' };
    }
    if (rec.type === 'regkey') {
      const res = await runCmd(`reg delete "${rec.path}" /f`, 30 * 1000);
      const out = `${res.stdout || ''}${res.stderr || ''}`;
      if (res.ok || /cannot find|unable to find/i.test(out)) return { status: 'removed' };
      return { status: 'failed', reason: /denied/i.test(out) ? 'access denied' : 'reg error' };
    }
    // file / folder
    try {
      if (!fs.existsSync(rec.path)) return { status: 'removed' }; // already gone
      fs.rmSync(rec.path, { recursive: true, force: true });
      return fs.existsSync(rec.path) ? { status: 'failed', reason: 'in use' } : { status: 'removed' };
    } catch (e) {
      const msg = String(e && e.message || '');
      if (/EPERM|EACCES|EBUSY/.test(msg)) return { status: 'failed', reason: 'access denied / in use' };
      return { status: 'failed', reason: 'error' };
    }
  }

  // ── The uninstall pipeline (stages 1–4), then pause for review ──
  async function runUninstall(id) {
    if (running) return { ok: false, error: 'already-running' };
    if (!ps.available) return { ok: false, error: 'ps-missing' };
    const program = PROGRAMS.get(id);
    if (!program) return { ok: false, error: 'unknown-program' };

    running = true;
    cancelRequested = false;
    session = newSession(program);
    logger.system('Deep Uninstaller: uninstall started', { program: program.name });
    emit(sessionPayload({ started: true }));

    try {
      await stageRestorePoint(program);
      if (cancelRequested) return abort();
      stageAnalyze(program);
      if (cancelRequested) return abort();
      await stageUninstall(program);
      if (cancelRequested) return abort();
      await stageScan(program);
    } catch (e) {
      logger.error('Deep Uninstaller: pipeline threw', e, { program: program.name });
      log('Something went wrong during uninstall: ' + (e && e.message || 'error'));
    }

    // Pause here — the user reviews the leftovers and picks which to clean
    // (stages 5→6 run from cleanLeftovers()).
    running = false;
    session.phase = 'review';
    emit(sessionPayload({ readyForReview: true }));
    return { ok: true, phase: 'review', leftovers: session.leftovers };

    function abort() {
      running = false;
      session.phase = 'done';
      session.summary = { removed: 0, failed: 0, kept: session.leftovers.length, cancelled: true };
      log('Uninstall cancelled.');
      emit(sessionPayload({ finished: true, cancelled: true }));
      return { ok: true, cancelled: true };
    }
  }

  // ── IPC ──
  ipcMain.handle('revo-uninstaller:status', () => ({ ok: true, ps, ...sessionPayload() }));
  ipcMain.handle('revo-uninstaller:list', (_e, force) => listPrograms(!!force));
  ipcMain.handle('revo-uninstaller:uninstall', (_e, id) => runUninstall(id));
  ipcMain.handle('revo-uninstaller:clean', (_e, ids) => cleanLeftovers(ids));
  ipcMain.handle('revo-uninstaller:cancel', () => {
    if (running) cancelRequested = true;
    return { ok: true, cancelling: running };
  });
  // Clear a finished session so the panel returns to the program list.
  ipcMain.handle('revo-uninstaller:reset', () => {
    if (running) return { ok: false, error: 'running' };
    session = null;
    return { ok: true };
  });

  return { listPrograms, runUninstall };
}

// The leftover-scan PowerShell. Runs as a temp .ps1 (via -File) so it can be a
// full, readable script. Reads its input (name, publisher, install location,
// DisplayIcon, uninstall key) from the temp JSON file whose path replaces
// __INPUT__, and emits a JSON array of leftover candidates:
//   { type, path, category, confidence, size?, name? }
// type ∈ folder | file | regkey | regvalue. confidence 'high' means an
// unambiguous match (install folder, exact-name app-data, App Paths / Run entry
// pointing back into the program); 'normal' means a broader match (a folder or
// key named after the PUBLISHER, which could be shared with sibling apps) — the
// UI leaves those unticked by default. Node re-validates every path before any
// deletion, so this stays a *finder*, not a deleter.
const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$in = Get-Content -Raw -LiteralPath '__INPUT__' | ConvertFrom-Json

function N($s) { if (-not $s) { return '' }; ($s -replace '[^A-Za-z0-9]', '').ToLower() }
function RegStyle($p) { ($p -replace '^HKCU:', 'HKCU') -replace '^HKLM:', 'HKLM' }
function FSize($p) {
  try { $s = (Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum; if ($s) { return [long]$s } } catch {}
  return [long]0
}

$nm = N $in.name
$pb = N $in.publisher
$out  = New-Object System.Collections.ArrayList
$seen = New-Object 'System.Collections.Generic.HashSet[string]'

function AddF($type, $path, $cat, $conf, $name) {
  if (-not $path) { return }
  $k = ($type + '|' + $path + '|' + [string]$name).ToLower()
  if ($seen.Contains($k)) { return }
  [void]$seen.Add($k)
  $o = [ordered]@{ type = $type; path = $path; category = $cat; confidence = $conf }
  if ($name) { $o.name = [string]$name }
  if ($type -eq 'folder') { $o.size = FSize $path }
  elseif ($type -eq 'file') { try { $o.size = [long]((Get-Item -LiteralPath $path -Force).Length) } catch { $o.size = [long]0 } }
  [void]$out.Add([pscustomobject]$o)
}

# Resolve an install folder — fall back to the DisplayIcon's directory when the
# entry has no InstallLocation (very common).
$loc = [string]$in.location
if (-not $loc -and $in.icon) {
  $ic = ([string]$in.icon) -replace '^"', '' -replace '",.*$', '' -replace ',\d+$', ''
  if ($ic -and (Test-Path -LiteralPath $ic)) {
    try { if ((Get-Item -LiteralPath $ic -Force).PSIsContainer) { $loc = $ic } else { $loc = Split-Path -Parent $ic } } catch {}
  }
}
$locL = if ($loc) { $loc.ToLower() } else { '' }

# 1) Install folder
if ($loc -and (Test-Path -LiteralPath $loc)) { AddF 'folder' $loc 'Install folder' 'high' $null }

# 2) Program Files vendor / app folders
$pf = @($env:ProgramFiles, ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')), $env:ProgramW6432) | Where-Object { $_ } | Select-Object -Unique
foreach ($b in $pf) {
  if ($in.name)      { $p = Join-Path $b $in.name;      if (Test-Path -LiteralPath $p) { AddF 'folder' $p 'Program files' 'high' $null } }
  if ($in.publisher) {
    $p = Join-Path $b $in.publisher
    if (Test-Path -LiteralPath $p) { AddF 'folder' $p 'Program files (publisher)' 'normal' $null }
    if ($in.name) { $p2 = Join-Path $p $in.name; if (Test-Path -LiteralPath $p2) { AddF 'folder' $p2 'Program files' 'high' $null } }
  }
}

# 3) App-data folders (%APPDATA%, %LOCALAPPDATA%, %ProgramData%, ...\Programs)
$adRoots = @($env:APPDATA, $env:LOCALAPPDATA, $env:ProgramData, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ } | Select-Object -Unique
foreach ($r in $adRoots) {
  if (-not (Test-Path -LiteralPath $r)) { continue }
  Get-ChildItem -LiteralPath $r -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $cn = N $_.Name
    if ($cn) {
      if ($nm.Length -ge 3 -and $cn -eq $nm)      { AddF 'folder' $_.FullName 'App data' 'high' $null }
      elseif ($pb.Length -ge 3 -and $cn -eq $pb)  { AddF 'folder' $_.FullName 'App data (publisher)' 'normal' $null }
    }
  }
  # nested Publisher\App
  if ($in.publisher -and $in.name) { $np = Join-Path (Join-Path $r $in.publisher) $in.name; if (Test-Path -LiteralPath $np) { AddF 'folder' $np 'App data' 'high' $null } }
}

# 4) Shortcuts — Start menu + Desktop, per-user and public
$lnkRoots = @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:PUBLIC 'Desktop'),
  ([Environment]::GetFolderPath('Desktop'))
) | Where-Object { $_ } | Select-Object -Unique
foreach ($r in $lnkRoots) {
  if (-not (Test-Path -LiteralPath $r)) { continue }
  Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $bn = N $_.BaseName
    if ($nm.Length -ge 4 -and $bn -like ('*' + $nm + '*')) {
      $conf = if ($bn -eq $nm) { 'high' } else { 'normal' }
      AddF 'file' $_.FullName 'Shortcut' $conf $null
    }
  }
}

# 5) Registry: Software\<App|Publisher> (+ nested Publisher\App) and the Uninstall key
foreach ($b in @('HKCU:\SOFTWARE', 'HKLM:\SOFTWARE', 'HKLM:\SOFTWARE\WOW6432Node')) {
  if ($in.name)      { $p = Join-Path $b $in.name;      if (Test-Path -LiteralPath $p) { AddF 'regkey' (RegStyle $p) 'Registry' 'high' $null } }
  if ($in.publisher) {
    $p = Join-Path $b $in.publisher
    if (Test-Path -LiteralPath $p) { AddF 'regkey' (RegStyle $p) 'Registry (publisher)' 'normal' $null }
    if ($in.name) { $np = Join-Path $p $in.name; if (Test-Path -LiteralPath $np) { AddF 'regkey' (RegStyle $np) 'Registry' 'high' $null } }
  }
}
if ($in.regKey) {
  $rp = ([string]$in.regKey) -replace '/', '\'
  $prov = 'Registry::' + (($rp -replace '^HKLM', 'HKEY_LOCAL_MACHINE') -replace '^HKCU', 'HKEY_CURRENT_USER')
  if (Test-Path -LiteralPath $prov) { AddF 'regkey' $rp 'Registry (uninstall entry)' 'high' $null }
}

# 6) App Paths entries whose target executable lives in the install folder
if ($locL) {
  foreach ($ap in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
    if (-not (Test-Path -LiteralPath $ap)) { continue }
    Get-ChildItem -LiteralPath $ap -ErrorAction SilentlyContinue | ForEach-Object {
      $def = [string](Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).'(default)'
      if ($def -and $def.ToLower().Contains($locL)) {
        $rs = ($_.Name -replace '^HKEY_LOCAL_MACHINE', 'HKLM') -replace '^HKEY_CURRENT_USER', 'HKCU'
        AddF 'regkey' $rs 'App Paths entry' 'high' $null
      }
    }
  }
}

# 7) Startup (Run / RunOnce) values that launch from the install folder or share the app name
foreach ($rk in @(
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce')) {
  if (-not (Test-Path -LiteralPath $rk)) { continue }
  $props = Get-ItemProperty -LiteralPath $rk -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
    $vn = $_.Name; $vd = [string]$_.Value
    $hit = $false
    if ($locL -and $vd.ToLower().Contains($locL)) { $hit = $true }
    elseif ($nm.Length -ge 4 -and (N $vn) -eq $nm) { $hit = $true }
    if ($hit) { AddF 'regvalue' (RegStyle $rk) 'Startup entry' 'high' $vn }
  }
}

$out | ConvertTo-Json -Compress -Depth 4
`;

module.exports = { init };
