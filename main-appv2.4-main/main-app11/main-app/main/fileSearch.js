const { ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

// ── File Search mini widget (voidtools "Everything"-style) ──
// A fast filename search across the user's chosen folders. Windows exposes no
// MFT/USN index to us the way Everything uses, so instead of a live disk index
// this builds an in-memory index once (a streamed directory walk of the
// configured roots), persists it to userData, and then answers every keystroke
// instantly by filtering that array in memory. Rebuild on demand from the panel.
//
// The query language mirrors the useful bits of Everything's syntax:
//   plain words        -> AND, case-insensitive substring on the file NAME
//   "quoted phrase"    -> matched as a single literal phrase
//   *  ?               -> wildcards (glob → regex) anywhere in a word
//   ext:mp4,png        -> extension whitelist
//   size:>10mb  <1gb   -> size filter (b / kb / mb / gb, and >= <= > < =)
//   folder:  file:     -> restrict to folders or files only
//   path:              -> match the WHOLE path, not just the name
//   case:              -> make matching case-sensitive
//   regex:<expr>       -> raw regular expression (rest of the query)
//
// Everything user input never touches a shell — all file actions go through
// Electron's shell.openPath / showItemInFolder.

const CONFIG_VERSION = 1;
const INDEX_VERSION = 1;

// Directories that are pure noise / churn for a filename search, skipped by
// default. Matched case-insensitively against the folder's own name.
const DEFAULT_EXCLUDES = [
  'node_modules', '$recycle.bin', 'system volume information', 'windows',
  'winsxs', '$windows.~bt', '$windows.~ws', 'programdata\\package cache',
  '.git', '.svn', '.hg', '.cache', 'appdata\\local\\temp', 'temp', 'tmp',
  'cache', 'caches', 'gpucache', 'code cache', 'crashpad', 'dawncache'
];

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    roots: [os.homedir()],
    excludeDirs: [...DEFAULT_EXCLUDES],
    includeHidden: false,
    followReparse: false,
    collectStats: true,
    maxEntries: 400000
  };
}

function init(ctx) {
  const { logger, userDataPath } = ctx;

  const CONFIG_PATH = path.join(userDataPath, 'file-search-config.json');
  const INDEX_PATH = path.join(userDataPath, 'file-search-index.json');

  let config = loadConfig();

  // In-memory index. Each entry: { name, path, dir, size, mtime, lower }.
  let index = [];
  let indexMeta = { builtAt: 0, roots: [], count: 0, truncated: false, tookMs: 0 };

  // Build state.
  let building = false;
  let cancelRequested = false;

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const merged = { ...defaultConfig(), ...raw };
        merged.roots = Array.isArray(merged.roots) && merged.roots.length ? merged.roots : [os.homedir()];
        merged.excludeDirs = Array.isArray(merged.excludeDirs) ? merged.excludeDirs : [...DEFAULT_EXCLUDES];
        merged.maxEntries = clampInt(merged.maxEntries, 10000, 2000000, 400000);
        return merged;
      }
    } catch (e) {
      logger.warn('File search: config load failed, using defaults', e);
    }
    const c = defaultConfig();
    saveConfig(c);
    return c;
  }

  function saveConfig(c = config) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
    } catch (e) {
      logger.error('File search: config save failed', e);
    }
  }

  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  // ── Persisted index (compact array-of-arrays to keep the file small) ──
  function persistIndex() {
    try {
      const payload = {
        version: INDEX_VERSION,
        builtAt: indexMeta.builtAt,
        roots: indexMeta.roots,
        truncated: indexMeta.truncated,
        tookMs: indexMeta.tookMs,
        entries: index.map((e) => [e.name, e.path, e.dir ? 1 : 0, e.size, e.mtime])
      };
      fs.writeFileSync(INDEX_PATH, JSON.stringify(payload), 'utf8');
    } catch (e) {
      logger.warn('File search: index persist failed (search still works this session)', e);
    }
  }

  function loadIndex() {
    try {
      if (!fs.existsSync(INDEX_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.entries)) return;
      index = raw.entries.map((a) => ({
        name: a[0], path: a[1], dir: !!a[2], size: a[3] || 0, mtime: a[4] || 0, lower: String(a[0]).toLowerCase()
      }));
      indexMeta = {
        builtAt: raw.builtAt || 0,
        roots: Array.isArray(raw.roots) ? raw.roots : [],
        count: index.length,
        truncated: !!raw.truncated,
        tookMs: raw.tookMs || 0
      };
      logger.system('File search: index loaded from disk', { count: index.length, builtAt: indexMeta.builtAt });
    } catch (e) {
      logger.warn('File search: index load failed', e);
      index = [];
    }
  }

  // ── Directory walk / index build ──

  function isExcluded(name, fullPath) {
    const lname = name.toLowerCase();
    const lpath = fullPath.toLowerCase();
    for (const ex of config.excludeDirs) {
      const lex = String(ex).toLowerCase();
      if (!lex) continue;
      // A bare name matches any folder with that name; a path-ish pattern
      // (contains a separator) matches anywhere in the full path.
      if (lex.includes('\\') || lex.includes('/')) {
        if (lpath.includes(lex.replace(/\//g, '\\'))) return true;
      } else if (lname === lex) {
        return true;
      }
    }
    return false;
  }

  function isHiddenName(name) {
    return name.startsWith('.') || name.startsWith('$');
  }

  function emitProgress(win, payload) {
    if (win && !win.isDestroyed()) win.webContents.send('file-search:index-progress', payload);
  }

  async function buildIndex() {
    if (building) return { ok: false, error: 'already-running' };
    building = true;
    cancelRequested = false;
    const started = Date.now();
    const win = ctx.getMainWindow();

    const roots = (config.roots || []).filter((r) => {
      try { return fs.existsSync(r); } catch (e) { return false; }
    });
    if (!roots.length) {
      building = false;
      return { ok: false, error: 'no-valid-roots' };
    }

    logger.system('File search: index build started', { roots, maxEntries: config.maxEntries });

    const result = [];
    let scanned = 0;
    let truncated = false;
    let lastEmit = 0;

    // A stack of directories to visit, with limited concurrency so a big tree
    // indexes quickly without spawning unbounded promises. `active` counts
    // directories currently being read: a worker that finds the stack empty must
    // NOT exit while others are still in flight (they may yet push child dirs) —
    // it waits until the stack is empty AND nothing is being processed.
    const stack = roots.map((r) => path.resolve(r));
    const CONCURRENCY = 12;
    let active = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const worker = async () => {
      while (!cancelRequested && result.length < config.maxEntries) {
        const dir = stack.pop();
        if (dir === undefined) {
          if (active === 0) return;   // stack drained and no work in flight — done
          await sleep(4);             // work still in flight; more dirs may appear
          continue;
        }
        active++;
        try {
          let dirents;
          try {
            dirents = await fsp.readdir(dir, { withFileTypes: true });
          } catch (e) {
            continue; // permission denied / gone — skip quietly (finally still runs)
          }
          for (const d of dirents) {
            if (result.length >= config.maxEntries) { truncated = true; break; }
            const name = d.name;
            if (!config.includeHidden && isHiddenName(name)) continue;
            const full = path.join(dir, name);
            const isSymlink = d.isSymbolicLink();
            const isDir = d.isDirectory();

            if (isDir) {
              if (isSymlink && !config.followReparse) continue;
              if (isExcluded(name, full)) continue;
              result.push({ name, path: full, dir: true, size: 0, mtime: 0, lower: name.toLowerCase() });
              stack.push(full);
            } else {
              if (isSymlink && !config.followReparse) continue;
              let size = 0, mtime = 0;
              if (config.collectStats) {
                try {
                  const st = await fsp.stat(full);
                  size = st.size;
                  mtime = st.mtimeMs;
                } catch (e) { /* keep zeros */ }
              }
              result.push({ name, path: full, dir: false, size, mtime, lower: name.toLowerCase() });
            }
            scanned++;
            const now = Date.now();
            if (now - lastEmit > 150) {
              lastEmit = now;
              emitProgress(win, { building: true, scanned, count: result.length, currentDir: dir, truncated });
            }
          }
        } finally {
          active--;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    } catch (e) {
      logger.error('File search: index build error', e);
    }

    const tookMs = Date.now() - started;
    building = false;

    if (cancelRequested) {
      logger.system('File search: index build cancelled', { partial: result.length });
      emitProgress(win, { building: false, cancelled: true, count: index.length });
      return { ok: false, error: 'cancelled', partial: result.length };
    }

    index = result;
    indexMeta = { builtAt: Date.now(), roots: [...roots], count: index.length, truncated, tookMs };
    persistIndex();
    logger.success('File search: index built', { count: index.length, tookMs, truncated });
    emitProgress(win, { building: false, done: true, count: index.length, truncated, tookMs });
    return { ok: true, count: index.length, truncated, tookMs };
  }

  // ── Query parsing + matching ──

  const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

  function parseSize(str) {
    const m = String(str).trim().toLowerCase().match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/);
    if (!m) return null;
    const op = m[1] || '=';
    const num = parseFloat(m[2]);
    const unit = m[3] || 'b';
    return { op, bytes: num * (SIZE_UNITS[unit] || 1) };
  }

  function globToRegExp(glob, flags) {
    // Escape everything, then turn the (now-escaped) * and ? back into wildcards.
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(pattern, flags);
  }

  // Splits on spaces but keeps "quoted phrases" together.
  function tokenize(q) {
    const tokens = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(q)) !== null) {
      tokens.push({ text: m[1] !== undefined ? m[1] : m[2], quoted: m[1] !== undefined });
    }
    return tokens;
  }

  function parseQuery(q) {
    const spec = {
      terms: [],       // { kind:'substr'|'regex', value, re? }
      exts: null,      // Set of lowercased extensions (no dot)
      size: null,      // { op, bytes }
      onlyDir: false,
      onlyFile: false,
      matchPath: false,
      caseSensitive: false,
      raw: q
    };
    const tokens = tokenize(q);

    // First pass: pull out flags/filters so `case:` and `path:` affect term building.
    const termTokens = [];
    for (const t of tokens) {
      const lower = t.text.toLowerCase();
      if (!t.quoted && (lower === 'case:' || lower === 'case:true')) { spec.caseSensitive = true; continue; }
      if (!t.quoted && (lower === 'path:' || lower === 'p:')) { spec.matchPath = true; continue; }
      if (!t.quoted && (lower === 'folder:' || lower === 'folders:' || lower === 'dir:')) { spec.onlyDir = true; continue; }
      if (!t.quoted && (lower === 'file:' || lower === 'files:')) { spec.onlyFile = true; continue; }
      if (!t.quoted && lower.startsWith('ext:')) {
        const list = t.text.slice(4).split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
        if (list.length) spec.exts = new Set([...(spec.exts || []), ...list]);
        continue;
      }
      if (!t.quoted && lower.startsWith('size:')) {
        const s = parseSize(t.text.slice(5));
        if (s) spec.size = s;
        continue;
      }
      if (!t.quoted && (lower.startsWith('regex:') || lower.startsWith('re:'))) {
        const expr = t.text.slice(t.text.indexOf(':') + 1);
        try { spec.terms.push({ kind: 'regex', value: expr, re: new RegExp(expr, spec.caseSensitive ? '' : 'i') }); }
        catch (e) { /* invalid regex — ignore this term */ }
        continue;
      }
      termTokens.push(t);
    }

    const flags = spec.caseSensitive ? '' : 'i';
    for (const t of termTokens) {
      if (!t.quoted && /[*?]/.test(t.text)) {
        try { spec.terms.push({ kind: 'regex', value: t.text, re: globToRegExp(t.text, flags) }); continue; }
        catch (e) { /* fall through to substring */ }
      }
      spec.terms.push({ kind: 'substr', value: spec.caseSensitive ? t.text : t.text.toLowerCase() });
    }
    return spec;
  }

  function entryExt(e) {
    if (e.dir) return '';
    const dot = e.name.lastIndexOf('.');
    return dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
  }

  function matches(e, spec) {
    if (spec.onlyDir && !e.dir) return false;
    if (spec.onlyFile && e.dir) return false;
    if (spec.exts) { if (e.dir || !spec.exts.has(entryExt(e))) return false; }
    if (spec.size) {
      if (e.dir) return false;
      const { op, bytes } = spec.size;
      if (op === '>' && !(e.size > bytes)) return false;
      if (op === '<' && !(e.size < bytes)) return false;
      if (op === '>=' && !(e.size >= bytes)) return false;
      if (op === '<=' && !(e.size <= bytes)) return false;
      if (op === '=' && !(e.size === Math.round(bytes))) return false;
    }
    const hayName = spec.caseSensitive ? e.name : e.lower;
    const hayPath = spec.caseSensitive ? e.path : e.path.toLowerCase();
    const hay = spec.matchPath ? hayPath : hayName;
    for (const term of spec.terms) {
      if (term.kind === 'substr') {
        if (!hay.includes(term.value)) return false;
      } else {
        if (!term.re.test(spec.matchPath ? e.path : e.name)) return false;
      }
    }
    return true;
  }

  // Cheap relevance score so exact / prefix hits float to the top.
  function scoreEntry(e, spec) {
    if (!spec.terms.length) return 0;
    const name = spec.caseSensitive ? e.name : e.lower;
    const first = spec.terms.find((t) => t.kind === 'substr');
    if (!first) return 10;
    const v = first.value;
    if (name === v) return 100;
    if (name.startsWith(v)) return 60;
    const dot = name.lastIndexOf('.');
    if (dot > 0 && name.slice(0, dot) === v) return 80; // exact base-name match
    if (name.includes(v)) return 40;
    return 10;
  }

  function query(qStr, opts = {}) {
    const started = Date.now();
    const q = String(qStr || '').trim();
    const limit = clampInt(opts.limit, 1, 5000, 500);
    const offset = clampInt(opts.offset, 0, 5000000, 0);
    const sortBy = ['relevance', 'name', 'size', 'modified', 'path', 'type'].includes(opts.sortBy) ? opts.sortBy : 'relevance';
    const sortDir = opts.sortDir === 'asc' ? 'asc' : 'desc';

    if (!index.length) {
      return { ok: true, results: [], total: 0, returned: 0, tookMs: 0, indexed: 0, indexTruncated: indexMeta.truncated, needsIndex: true };
    }
    if (!q) {
      return { ok: true, results: [], total: 0, returned: 0, tookMs: Date.now() - started, indexed: index.length, indexTruncated: indexMeta.truncated };
    }

    const spec = parseQuery(q);
    if (!spec.terms.length && !spec.exts && !spec.size && !spec.onlyDir && !spec.onlyFile) {
      return { ok: true, results: [], total: 0, returned: 0, tookMs: Date.now() - started, indexed: index.length, indexTruncated: indexMeta.truncated };
    }

    const hits = [];
    for (let i = 0; i < index.length; i++) {
      const e = index[i];
      if (matches(e, spec)) hits.push(e);
    }
    const total = hits.length;

    // Sort.
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'relevance') {
      hits.sort((a, b) => {
        const s = scoreEntry(b, spec) - scoreEntry(a, spec);
        if (s) return s;
        return a.name.localeCompare(b.name);
      });
    } else if (sortBy === 'name') {
      hits.sort((a, b) => dir * a.name.localeCompare(b.name));
    } else if (sortBy === 'path') {
      hits.sort((a, b) => dir * a.path.localeCompare(b.path));
    } else if (sortBy === 'size') {
      hits.sort((a, b) => dir * (a.size - b.size));
    } else if (sortBy === 'modified') {
      hits.sort((a, b) => dir * (a.mtime - b.mtime));
    } else if (sortBy === 'type') {
      hits.sort((a, b) => (dir * entryExt(a).localeCompare(entryExt(b))) || a.name.localeCompare(b.name));
    }

    const page = hits.slice(offset, offset + limit).map((e) => ({
      name: e.name, path: e.path, dir: e.dir, size: e.size, mtime: e.mtime, ext: entryExt(e)
    }));

    return {
      ok: true,
      results: page,
      total,
      returned: page.length,
      offset,
      tookMs: Date.now() - started,
      indexed: index.length,
      indexTruncated: indexMeta.truncated
    };
  }

  // ── Roots / drives helpers ──

  function listDrives() {
    const drives = [];
    if (process.platform === 'win32') {
      for (let c = 65; c <= 90; c++) {
        const root = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(root)) drives.push(root); } catch (e) { /* skip */ }
      }
    } else {
      drives.push('/');
    }
    return drives;
  }

  function normalizeRoot(p) {
    try { return path.resolve(String(p)); } catch (e) { return null; }
  }

  function addRoot(p) {
    const r = normalizeRoot(p);
    if (!r || !fs.existsSync(r)) return { ok: false, error: 'Folder not found' };
    const exists = config.roots.some((x) => path.resolve(x).toLowerCase() === r.toLowerCase());
    if (!exists) { config.roots.push(r); saveConfig(); }
    return { ok: true, roots: config.roots };
  }

  function removeRoot(p) {
    const r = normalizeRoot(p);
    config.roots = config.roots.filter((x) => path.resolve(x).toLowerCase() !== (r || '').toLowerCase());
    if (!config.roots.length) config.roots = [os.homedir()];
    saveConfig();
    return { ok: true, roots: config.roots };
  }

  function statusPayload() {
    return {
      building,
      count: index.length,
      builtAt: indexMeta.builtAt,
      roots: config.roots,
      indexedRoots: indexMeta.roots,
      truncated: indexMeta.truncated,
      tookMs: indexMeta.tookMs,
      maxEntries: config.maxEntries
    };
  }

  // Only ever act on a real, existing filesystem path (validated here) via the
  // OS shell — never a shell command line.
  function safeExisting(p) {
    if (typeof p !== 'string' || !p) return null;
    try { return fs.existsSync(p) ? p : null; } catch (e) { return null; }
  }

  // ── IPC ──

  ipcMain.handle('file-search:get-config', () => config);

  ipcMain.handle('file-search:set-config', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      if (typeof patch.includeHidden === 'boolean') config.includeHidden = patch.includeHidden;
      if (typeof patch.followReparse === 'boolean') config.followReparse = patch.followReparse;
      if (typeof patch.collectStats === 'boolean') config.collectStats = patch.collectStats;
      if (patch.maxEntries !== undefined) config.maxEntries = clampInt(patch.maxEntries, 10000, 2000000, 400000);
      if (Array.isArray(patch.excludeDirs)) config.excludeDirs = patch.excludeDirs.map(String);
      saveConfig();
    }
    return config;
  });

  ipcMain.handle('file-search:list-drives', () => ({ ok: true, drives: listDrives(), home: os.homedir() }));

  ipcMain.handle('file-search:add-root', (_e, p) => addRoot(p));
  ipcMain.handle('file-search:remove-root', (_e, p) => removeRoot(p));

  ipcMain.handle('file-search:pick-folder', async () => {
    const win = ctx.getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder to search',
      properties: ['openDirectory', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true, roots: config.roots };
    for (const p of res.filePaths) addRoot(p);
    return { ok: true, roots: config.roots };
  });

  ipcMain.handle('file-search:index-status', () => statusPayload());

  ipcMain.handle('file-search:build-index', async () => {
    const res = await buildIndex();
    return { ...res, status: statusPayload() };
  });

  ipcMain.handle('file-search:cancel-index', () => {
    if (building) cancelRequested = true;
    return { ok: true, cancelling: building };
  });

  ipcMain.handle('file-search:query', (_e, qStr, opts) => {
    try {
      return query(qStr, opts || {});
    } catch (e) {
      logger.error('File search: query failed', e, { qStr });
      return { ok: false, error: 'Query failed', results: [], total: 0 };
    }
  });

  ipcMain.handle('file-search:open', async (_e, p) => {
    const real = safeExisting(p);
    if (!real) return { ok: false, error: 'Not found' };
    const err = await shell.openPath(real);
    if (err) { logger.warn('File search: open failed', { p: real, err }); return { ok: false, error: err }; }
    return { ok: true };
  });

  ipcMain.handle('file-search:reveal', (_e, p) => {
    const real = safeExisting(p);
    if (!real) return { ok: false, error: 'Not found' };
    shell.showItemInFolder(real);
    return { ok: true };
  });

  // Load any previously-built index so search is usable immediately on launch.
  loadIndex();

  return { buildIndex, query, statusPayload };
}

module.exports = { init };
