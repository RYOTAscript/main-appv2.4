const { ipcMain } = require('electron');
const os = require('os');
const { runCmd, runCmdSync } = require('./shellUtils');

// ── Windows edition detection ──
// os.release() on Windows returns "10.0.<build>" (e.g. "10.0.22631"). Windows 11
// is build 22000+; everything below that is Windows 10. We use this to hide
// tweaks that target UI which only exists on one edition, so every toggle the
// user sees on their machine actually does something (see publicTweakCatalog).
function getOsInfo() {
  const rel = os.release() || '';
  const build = parseInt((rel.split('.')[2] || '0'), 10) || 0;
  const isWin11 = build >= 22000;
  return { build, isWin11, name: isWin11 ? 'Windows 11' : 'Windows 10' };
}

// A tweak with no `platform` applies to every edition. 'win11' → only shown/
// applied on Windows 11 (the UI it toggles doesn't exist on Windows 10).
function tweakAppliesTo(tw, osInfo) {
  if (!tw.platform || tw.platform === 'all') return true;
  if (tw.platform === 'win11') return osInfo.isWin11;
  if (tw.platform === 'win10') return !osInfo.isWin11;
  return true;
}

// ── Windows Debloat mini widget ──
// Two jobs, both done with Windows' OWN built-in tooling — this module ships no
// Microsoft (or third-party) code, exactly like the App Installer wraps winget:
//
//   1. Remove preinstalled Store bloat (Xbox, News, Weather, Solitaire, …) via
//      `Get-AppxPackage … | Remove-AppxPackage`.
//   2. Apply/undo a curated set of privacy & UX tweaks via `reg` on HKCU.
//
// Design rules that keep this safe AND legal to ship in a paid product:
//   • It only ever acts on things the user explicitly ticks.
//   • Every id is validated against a FIXED in-code catalog before it can reach
//     a shell — no arbitrary string is ever interpolated into a command (mirrors
//     the App Installer's APP_BY_ID guard). Package names / reg data are also
//     re-checked against a strict character allow-list as defence in depth.
//   • Everything is PER-USER scope (current-user AppX removal + HKCU reg), so
//     nothing here needs admin / triggers UAC and nothing touches machine-wide
//     system state.
//   • Every tweak is REVERSIBLE — each ships an apply AND a revert, and we read
//     the live registry so the UI shows a real on/off toggle, never a one-way
//     door.
//   • The catalog deliberately EXCLUDES anything dangerous to remove (the Store
//     itself, winget/App Installer, Terminal, .NET/VC++/UI.Xaml runtimes,
//     Defender UI, Calculator, Photos, Notepad, Paint, Snipping Tool). Those
//     packages simply have no entry, so they can never be selected.

// Only these characters may appear in a package name or reg value/data that we
// pass to a shell. Our catalog is entirely within this set; the guard is here so
// a future catalog edit can never smuggle in something shell-active.
const SAFE_TOKEN = /^[A-Za-z0-9 ._\-{}+]+$/;
const SAFE_REGPATH = /^HKCU\\[A-Za-z0-9 ._\-{}\\+]+$/;

// ── Removable preinstalled apps ──
// name = the exact AppX package Name (the middle field of a PackageFullName).
// caution:true → still perfectly safe to remove per-user, but something a chunk
// of people actually use, so we badge it as "you might want this".
const APP_CATALOG = [
  { category: 'Bloatware', apps: [
    { name: 'Microsoft.549981C3F5F10',            label: 'Cortana' },
    { name: 'Microsoft.BingWeather',              label: 'Weather' },
    { name: 'Microsoft.BingNews',                 label: 'News' },
    { name: 'Microsoft.BingSearch',               label: 'Web Search' },
    { name: 'Microsoft.WindowsMaps',              label: 'Maps' },
    { name: 'Microsoft.GetHelp',                  label: 'Get Help' },
    { name: 'Microsoft.Getstarted',               label: 'Tips' },
    { name: 'Microsoft.WindowsFeedbackHub',       label: 'Feedback Hub' },
    { name: 'Microsoft.MicrosoftOfficeHub',       label: 'Office Hub' },
    { name: 'Microsoft.MicrosoftSolitaireCollection', label: 'Solitaire' },
    { name: 'Microsoft.People',                   label: 'People' },
    { name: 'Microsoft.Todos',                    label: 'Microsoft To Do' },
    { name: 'Microsoft.PowerAutomateDesktop',     label: 'Power Automate' },
    { name: 'MicrosoftCorporationII.QuickAssist', label: 'Quick Assist' },
    { name: 'Microsoft.Windows.DevHome',          label: 'Dev Home' },
    { name: 'Clipchamp.Clipchamp',                label: 'Clipchamp' },
    { name: 'Microsoft.OutlookForWindows',        label: 'New Outlook' }
  ]},
  { category: 'Xbox & Gaming', apps: [
    { name: 'Microsoft.GamingApp',                label: 'Xbox App' },
    { name: 'Microsoft.XboxGamingOverlay',        label: 'Xbox Game Bar' },
    { name: 'Microsoft.XboxGameOverlay',          label: 'Game Bar Overlay' },
    { name: 'Microsoft.XboxSpeechToTextOverlay',  label: 'Xbox Speech-to-Text' },
    { name: 'Microsoft.XboxIdentityProvider',     label: 'Xbox Identity', caution: true, note: 'Needed to sign into Xbox / Game Pass games' },
    { name: 'Microsoft.Xbox.TCUI',                label: 'Xbox Game UI', caution: true, note: 'Some games use this for in-game overlays' }
  ]},
  { category: 'Communication', apps: [
    { name: 'Microsoft.SkypeApp',                 label: 'Skype' },
    { name: 'MicrosoftTeams',                     label: 'Teams (personal)' },
    { name: 'MSTeams',                            label: 'Teams (new)' },
    { name: 'Microsoft.YourPhone',                label: 'Phone Link', caution: true, note: 'Links your Android/iPhone to Windows' }
  ]},
  { category: 'Media', apps: [
    { name: 'Microsoft.ZuneMusic',                label: 'Media Player / Groove' },
    { name: 'Microsoft.ZuneVideo',                label: 'Movies & TV' },
    { name: 'Microsoft.WindowsSoundRecorder',     label: 'Sound Recorder', caution: true }
  ]},
  { category: 'Sponsored / OEM', apps: [
    { name: 'SpotifyAB.SpotifyMusic',             label: 'Spotify (stub)' },
    { name: 'Disney.37853FC22B2CE',               label: 'Disney+ (stub)' },
    { name: 'Microsoft.Advertising.Xaml',         label: 'Ad framework', caution: true }
  ]},
  { category: 'Extras', apps: [
    { name: 'Microsoft.WindowsAlarms',            label: 'Clock', caution: true },
    { name: 'Microsoft.MicrosoftStickyNotes',     label: 'Sticky Notes', caution: true }
  ]}
];

// Flat name → app lookup so an incoming name can be validated + labelled in O(1).
const APP_BY_NAME = new Map();
for (const group of APP_CATALOG) {
  for (const app of group.apps) APP_BY_NAME.set(app.name, { ...app, category: group.category });
}

// ── Reversible tweaks (all HKCU, no elevation) ──
// Each tweak is a genuine toggle:
//   read   — one representative value we query to decide on/off state.
//   apply  — the reg ops that turn it ON (the "tweaked" state).
//   revert — the reg ops that restore Windows' default.
// A reg op is one of:
//   { op:'add', path, name, type:'REG_DWORD'|'REG_SZ', data }   ('' name → default value /ve)
//   { op:'delValue', path, name }
//   { op:'delKey', path }
const CDM = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager';
const ADV = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const SEARCH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search';

const TWEAK_CATALOG = [
  { category: 'File Explorer', tweaks: [
    {
      id: 'showFileExtensions',
      label: 'Show file extensions',
      description: 'Always show extensions like .exe and .txt in File Explorer.',
      restartExplorer: true,
      read: { path: ADV, name: 'HideFileExt', type: 'dword', equals: 0 },
      apply:  [{ op: 'add', path: ADV, name: 'HideFileExt', type: 'REG_DWORD', data: '0' }],
      revert: [{ op: 'add', path: ADV, name: 'HideFileExt', type: 'REG_DWORD', data: '1' }]
    },
    {
      id: 'showHiddenFiles',
      label: 'Show hidden files',
      description: 'Reveal hidden files and folders in File Explorer.',
      restartExplorer: true,
      read: { path: ADV, name: 'Hidden', type: 'dword', equals: 1 },
      apply:  [{ op: 'add', path: ADV, name: 'Hidden', type: 'REG_DWORD', data: '1' }],
      revert: [{ op: 'add', path: ADV, name: 'Hidden', type: 'REG_DWORD', data: '2' }]
    },
    {
      id: 'classicContextMenu',
      label: 'Classic right-click menu (Win11)',
      description: 'Bring back the full Windows 10 right-click menu instead of the trimmed Windows 11 one.',
      platform: 'win11', // Win10 already has the classic menu — nothing to restore
      restartExplorer: true,
      read: { path: 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32', name: '', type: 'sz', equals: '' },
      apply:  [{ op: 'add', path: 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32', name: '', type: 'REG_SZ', data: '' }],
      revert: [{ op: 'delKey', path: 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}' }]
    }
  ]},
  // WINDOWS VERSION: the Widgets and Chat buttons are Windows-11-only, so those two
  // tweaks are tagged platform:'win11' and filtered out on Windows 10 by
  // publicTweakCatalog() — the user only ever sees toggles that do something.
  // "Hide taskbar search" (SearchboxTaskbarMode) works on both editions, so it has
  // no platform tag. On Win10 this group therefore shows just the search tweak.
  { category: 'Taskbar', tweaks: [
    {
      id: 'hideTaskbarWidgets',
      label: 'Hide Widgets button',
      description: 'Remove the weather / news Widgets button from the taskbar.',
      platform: 'win11', // the Widgets button only exists on Windows 11
      restartExplorer: true,
      read: { path: ADV, name: 'TaskbarDa', type: 'dword', equals: 0 },
      apply:  [{ op: 'add', path: ADV, name: 'TaskbarDa', type: 'REG_DWORD', data: '0' }],
      revert: [{ op: 'add', path: ADV, name: 'TaskbarDa', type: 'REG_DWORD', data: '1' }]
    },
    {
      id: 'hideTaskbarChat',
      label: 'Hide Chat button',
      description: 'Remove the Teams Chat button from the taskbar.',
      platform: 'win11', // the Teams Chat button only exists on Windows 11
      restartExplorer: true,
      read: { path: ADV, name: 'TaskbarMn', type: 'dword', equals: 0 },
      apply:  [{ op: 'add', path: ADV, name: 'TaskbarMn', type: 'REG_DWORD', data: '0' }],
      revert: [{ op: 'add', path: ADV, name: 'TaskbarMn', type: 'REG_DWORD', data: '1' }]
    },
    {
      id: 'hideTaskbarSearch',
      label: 'Hide taskbar search box',
      description: 'Collapse the big taskbar search box (Start search still works).',
      restartExplorer: true,
      read: { path: SEARCH, name: 'SearchboxTaskbarMode', type: 'dword', equals: 0 },
      apply:  [{ op: 'add', path: SEARCH, name: 'SearchboxTaskbarMode', type: 'REG_DWORD', data: '0' }],
      revert: [{ op: 'add', path: SEARCH, name: 'SearchboxTaskbarMode', type: 'REG_DWORD', data: '1' }]
    }
  ]},
  { category: 'Privacy & Ads', tweaks: [
    {
      id: 'disableWebSearch',
      label: 'Disable Bing web search in Start',
      description: 'Stop the Start menu search from sending queries to Bing and showing web results.',
      restartExplorer: true,
      read: { path: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer', name: 'DisableSearchBoxSuggestions', type: 'dword', equals: 1 },
      apply:  [{ op: 'add', path: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer', name: 'DisableSearchBoxSuggestions', type: 'REG_DWORD', data: '1' }],
      revert: [{ op: 'delValue', path: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer', name: 'DisableSearchBoxSuggestions' }]
    },
    {
      id: 'disableSuggestedContent',
      label: 'Disable suggested content & ads',
      description: 'Turn off suggested apps and advertised content in Settings and the Start menu.',
      read: { path: CDM, name: 'SubscribedContent-338393Enabled', type: 'dword', equals: 0 },
      apply: [
        { op: 'add', path: CDM, name: 'SubscribedContent-338393Enabled', type: 'REG_DWORD', data: '0' },
        { op: 'add', path: CDM, name: 'SubscribedContent-353694Enabled', type: 'REG_DWORD', data: '0' },
        { op: 'add', path: CDM, name: 'SubscribedContent-353696Enabled', type: 'REG_DWORD', data: '0' },
        { op: 'add', path: CDM, name: 'SystemPaneSuggestionsEnabled',    type: 'REG_DWORD', data: '0' }
      ],
      revert: [
        { op: 'add', path: CDM, name: 'SubscribedContent-338393Enabled', type: 'REG_DWORD', data: '1' },
        { op: 'add', path: CDM, name: 'SubscribedContent-353694Enabled', type: 'REG_DWORD', data: '1' },
        { op: 'add', path: CDM, name: 'SubscribedContent-353696Enabled', type: 'REG_DWORD', data: '1' },
        { op: 'add', path: CDM, name: 'SystemPaneSuggestionsEnabled',    type: 'REG_DWORD', data: '1' }
      ]
    },
    {
      id: 'disableTipsAndSpotlight',
      label: 'Disable tips & lock-screen fun facts',
      description: 'Stop Windows tips, "get even more out of Windows" nags and lock-screen spotlight tips.',
      read: { path: CDM, name: 'SoftLandingEnabled', type: 'dword', equals: 0 },
      apply: [
        { op: 'add', path: CDM, name: 'SoftLandingEnabled',                type: 'REG_DWORD', data: '0' },
        { op: 'add', path: CDM, name: 'RotatingLockScreenOverlayEnabled',  type: 'REG_DWORD', data: '0' },
        { op: 'add', path: CDM, name: 'SubscribedContent-338387Enabled',   type: 'REG_DWORD', data: '0' }
      ],
      revert: [
        { op: 'add', path: CDM, name: 'SoftLandingEnabled',                type: 'REG_DWORD', data: '1' },
        { op: 'add', path: CDM, name: 'RotatingLockScreenOverlayEnabled',  type: 'REG_DWORD', data: '1' },
        { op: 'add', path: CDM, name: 'SubscribedContent-338387Enabled',   type: 'REG_DWORD', data: '1' }
      ]
    }
  ]}
];

const TWEAK_BY_ID = new Map();
for (const group of TWEAK_CATALOG) {
  for (const tw of group.tweaks) TWEAK_BY_ID.set(tw.id, tw);
}

// Client-facing catalog: strip the internal reg specs, keep only what the panel
// needs to render (label / description / category / caution). The renderer never
// sees or sends reg data — it only sends ids we look up here.
function publicAppCatalog() {
  return APP_CATALOG.map((g) => ({
    category: g.category,
    apps: g.apps.map((a) => ({ name: a.name, label: a.label, caution: !!a.caution, note: a.note || '' }))
  }));
}
// Only expose tweaks that apply to the running Windows edition, and drop any
// group left empty by that filter — so on Windows 10 the Win11-only tweaks
// simply aren't offered (rather than showing as inert toggles).
function publicTweakCatalog(osInfo) {
  return TWEAK_CATALOG
    .map((g) => ({
      category: g.category,
      tweaks: g.tweaks
        .filter((t) => tweakAppliesTo(t, osInfo))
        .map((t) => ({ id: t.id, label: t.label, description: t.description, restartExplorer: !!t.restartExplorer }))
    }))
    .filter((g) => g.tweaks.length);
}

// Build a single `reg` command string from an op. Every path/name/data here comes
// from the fixed catalog and is re-validated below, so nothing shell-active can
// slip through.
function regCommand(op) {
  const path = op.path;
  if (op.op === 'delKey') return `reg delete "${path}" /f`;
  if (op.op === 'delValue') return `reg delete "${path}" /v "${op.name}" /f`;
  // add
  const valueFlag = op.name ? `/v "${op.name}"` : '/ve';
  const dataFlag = op.data !== '' ? ` /d "${op.data}"` : ' /d ""';
  return `reg add "${path}" ${valueFlag} /t ${op.type}${dataFlag} /f`;
}

function opIsSafe(op) {
  if (!op || typeof op !== 'object') return false;
  if (!SAFE_REGPATH.test(op.path || '')) return false;
  if (op.op === 'add') {
    if (op.name !== '' && !SAFE_TOKEN.test(op.name)) return false;
    if (!/^REG_(DWORD|SZ)$/.test(op.type || '')) return false;
    if (op.data !== '' && !SAFE_TOKEN.test(op.data)) return false;
    return true;
  }
  if (op.op === 'delValue') return op.name === '' || SAFE_TOKEN.test(op.name);
  if (op.op === 'delKey') return true;
  return false;
}

function init(ctx) {
  const { logger } = ctx;

  // Fixed for the session — the OS edition can't change while the app runs.
  const osInfo = getOsInfo();
  logger.system('Debloat: Windows edition', osInfo);

  // PowerShell availability is fixed for the session — probe once and cache.
  let ps = { available: false };
  try {
    const res = runCmdSync('powershell -NoProfile -Command "$PSVersionTable.PSVersion.Major"');
    ps = { available: !!res.ok };
    if (res.ok) logger.system('Debloat: PowerShell detected');
    else logger.warn('Debloat: PowerShell not available', { stderr: res.stderr });
  } catch (e) {
    logger.warn('Debloat: PowerShell probe failed', e);
  }

  // Removal run state — one run at a time, per-app status streamed to the panel.
  let running = false;
  let cancelRequested = false;
  let session = null;

  function emit(payload) {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('debloat:progress', payload);
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

  // Remove one catalog app for the current user. We ask PowerShell to report a
  // clear token so we can tell "removed" from "wasn't installed" from a failure,
  // instead of guessing from exit codes.
  async function removeOne(app) {
    if (!SAFE_TOKEN.test(app.name)) return { status: 'failed', reason: 'bad-name' };
    const inner =
      `$ErrorActionPreference='Stop';` +
      `$p=Get-AppxPackage -Name '${app.name}';` +
      `if(-not $p){Write-Output 'NOTFOUND';exit 0}` +
      `try{$p | Remove-AppxPackage;Write-Output 'REMOVED'}catch{Write-Output ('FAILED:'+$_.Exception.Message)}`;
    const cmd = `powershell -NoProfile -NonInteractive -Command "${inner}"`;
    const res = await runCmd(cmd, 3 * 60 * 1000);
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (/REMOVED/.test(out)) return { status: 'removed' };
    if (/NOTFOUND/.test(out)) return { status: 'absent' };
    const m = out.match(/FAILED:(.+)/);
    const reason = (m ? m[1] : (res.stderr || '')).trim().split('\n')[0] || 'error';
    if (res.killed || /timed out/i.test(out)) return { status: 'failed', reason: 'timeout' };
    return { status: 'failed', reason };
  }

  async function runRemove(names) {
    if (running) return { ok: false, error: 'already-running' };
    if (!ps.available) return { ok: false, error: 'ps-missing' };

    // Validate every name against the catalog; drop unknowns / dupes.
    const seen = new Set();
    const apps = [];
    for (const raw of Array.isArray(names) ? names : []) {
      const app = APP_BY_NAME.get(raw);
      if (app && !seen.has(app.name)) { seen.add(app.name); apps.push(app); }
    }
    if (!apps.length) return { ok: false, error: 'nothing-selected' };

    running = true;
    cancelRequested = false;
    session = { total: apps.length, done: 0, current: null, results: [], startedAt: Date.now() };
    logger.system('Debloat: remove run started', { count: apps.length, names: apps.map((a) => a.name) });
    emit(sessionPayload({ started: true }));

    for (let i = 0; i < apps.length; i++) {
      if (cancelRequested) break;
      const app = apps[i];
      session.current = { name: app.name, label: app.label, index: i };
      emit(sessionPayload({ removing: app.name }));

      let result;
      try {
        result = await removeOne(app);
      } catch (e) {
        logger.error('Debloat: remove threw', e, { name: app.name });
        result = { status: 'failed', reason: 'error' };
      }
      session.done++;
      session.results.push({ name: app.name, label: app.label, ...result });
      if (result.status === 'failed') logger.warn('Debloat: remove failed', { name: app.name, reason: result.reason });
      else logger.success('Debloat: remove ' + result.status, { name: app.name });
      emit(sessionPayload());
    }

    running = false;
    session.current = null;
    const cancelled = cancelRequested;
    const summary = {
      removed: session.results.filter((r) => r.status === 'removed').length,
      absent: session.results.filter((r) => r.status === 'absent').length,
      failed: session.results.filter((r) => r.status === 'failed').length
    };
    logger.success('Debloat: remove run finished', { ...summary, cancelled });
    emit(sessionPayload({ finished: true, cancelled, summary }));
    return { ok: true, ...summary, cancelled, results: session.results };
  }

  // Which catalog apps are actually installed for this user, so the grid can
  // badge them and default-select the safe ones. One PowerShell call lists every
  // package Name; we intersect with the catalog.
  async function scanInstalled() {
    if (!ps.available) return { ok: false, error: 'ps-missing', installed: [] };
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-AppxPackage | ForEach-Object { $_.Name }"`;
    const res = await runCmd(cmd, 90 * 1000);
    if (!res.ok && !(res.stdout || '').trim()) {
      logger.warn('Debloat: appx scan failed', { stderr: res.stderr });
      return { ok: false, error: 'scan-failed', installed: [] };
    }
    const have = new Set(
      String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => s.toLowerCase())
    );
    const installed = [];
    for (const name of APP_BY_NAME.keys()) if (have.has(name.toLowerCase())) installed.push(name);
    logger.system('Debloat: appx scan', { found: installed.length });
    return { ok: true, installed };
  }

  // Read whether a single tweak is currently applied, by querying its
  // representative value.
  async function readTweak(tw) {
    const r = tw.read;
    const res = await runCmd(`reg query "${r.path}"${r.name ? ` /v "${r.name}"` : ' /ve'}`, 15 * 1000);
    if (!res.ok) return false; // key/value missing → not applied
    const out = String(res.stdout || '');
    if (r.type === 'dword') {
      const m = out.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
      if (!m) return false;
      return parseInt(m[1], 16) === r.equals;
    }
    // sz: applied if the value simply exists (empty string counts as present)
    return /REG_SZ/.test(out);
  }

  async function readAllTweaks() {
    const state = {};
    // Only read tweaks applicable to this edition — the others aren't shown, and
    // reading a Win11-only key on Win10 would just report a meaningless "off".
    for (const [id, tw] of TWEAK_BY_ID) {
      if (!tweakAppliesTo(tw, osInfo)) continue;
      try { state[id] = await readTweak(tw); }
      catch (e) { state[id] = false; }
    }
    return state;
  }

  async function setTweak(id, on) {
    const tw = TWEAK_BY_ID.get(id);
    if (!tw) return { ok: false, error: 'unknown-tweak' };
    // Never apply a tweak that doesn't belong to this edition, even if a stale
    // renderer somehow asks for it.
    if (!tweakAppliesTo(tw, osInfo)) return { ok: false, error: 'not-applicable' };
    const ops = on ? tw.apply : tw.revert;
    for (const op of ops) {
      if (!opIsSafe(op)) {
        logger.error('Debloat: refused unsafe reg op', null, { id, op });
        return { ok: false, error: 'unsafe-op' };
      }
    }
    let allOk = true;
    for (const op of ops) {
      const res = await runCmd(regCommand(op), 15 * 1000);
      // A delete that reports "cannot find" just means it was already at default —
      // not a failure for our purposes.
      if (!res.ok && !/cannot find|unable to find/i.test(`${res.stdout}${res.stderr}`)) allOk = false;
    }
    const applied = await readTweak(tw);
    logger.success('Debloat: tweak ' + (on ? 'applied' : 'reverted'), { id, applied });
    return { ok: allOk, applied, restartExplorer: !!tw.restartExplorer };
  }

  // Restart Explorer so taskbar / File Explorer tweaks take effect without a
  // sign-out. Best-effort; Explorer relaunches itself on modern Windows, and we
  // kick it just in case.
  async function restartExplorer() {
    await runCmd('powershell -NoProfile -NonInteractive -Command "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; if(-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)){Start-Process explorer}"', 20 * 1000);
    logger.system('Debloat: Explorer restarted');
    return { ok: true };
  }

  // Optional safety net: a System Restore point before the user makes changes.
  // Needs admin + System Protection enabled, so it can legitimately fail — we
  // report that honestly rather than pretending it worked or blocking anything.
  async function createRestorePoint() {
    if (!ps.available) return { ok: false, error: 'ps-missing' };
    const cmd = `powershell -NoProfile -NonInteractive -Command "try{Checkpoint-Computer -Description 'main Debloat' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop; Write-Output 'OK'}catch{Write-Output ('ERR:'+$_.Exception.Message)}"`;
    const res = await runCmd(cmd, 3 * 60 * 1000);
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (/(^|\n)\s*OK\s*(\n|$)/.test(out)) {
      logger.success('Debloat: restore point created');
      return { ok: true };
    }
    const m = out.match(/ERR:(.+)/);
    const reason = (m ? m[1] : '').trim().split('\n')[0] || 'unavailable';
    logger.warn('Debloat: restore point not created', { reason });
    return { ok: false, error: 'failed', reason };
  }

  // ── IPC ──
  ipcMain.handle('debloat:catalog', () => ({
    ok: true, apps: publicAppCatalog(), tweaks: publicTweakCatalog(osInfo), ps, os: osInfo
  }));
  ipcMain.handle('debloat:status', () => sessionPayload());
  ipcMain.handle('debloat:scan-installed', () => scanInstalled());
  ipcMain.handle('debloat:remove', (_e, names) => runRemove(names));
  ipcMain.handle('debloat:cancel', () => {
    if (running) cancelRequested = true;
    return { ok: true, cancelling: running };
  });
  ipcMain.handle('debloat:read-tweaks', () => readAllTweaks());
  ipcMain.handle('debloat:set-tweak', (_e, { id, on } = {}) => setTweak(id, !!on));
  ipcMain.handle('debloat:restart-explorer', () => restartExplorer());
  ipcMain.handle('debloat:restore-point', () => createRestorePoint());

  return { runRemove, scanInstalled };
}

module.exports = { init, APP_CATALOG, TWEAK_CATALOG, APP_BY_NAME, TWEAK_BY_ID, regCommand, opIsSafe };
