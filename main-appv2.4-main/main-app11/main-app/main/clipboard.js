const { app, ipcMain, clipboard, nativeImage, safeStorage } = require('electron');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isWindows, isMac } = require('./platform');
const { runAppleScript, scripts } = require('./osascript');

const POLL_INTERVAL_MS = 700;
const MAX_HISTORY = 50;
const MAX_TEXT_LENGTH = 5000;
const THUMB_WIDTH = 240;

// Chromium and password managers (1Password, Bitwarden, etc.) tag clipboard writes
// that carry sensitive data (e.g. copied from a password field) with this custom
// clipboard format -- the same convention Windows' own Clipboard History honors.
// A well-behaved monitor checks for it and skips recording, rather than persisting
// secrets to disk.
const SENSITIVE_CLIPBOARD_FORMAT = 'ExcludeClipboardContentFromMonitorProcessing';

// Entry shapes stored in the history file:
//   { id, type: 'text',  text, pinned, ts }
//   { id, type: 'image', imageFile, thumb, width, height, hash, pinned, ts }
//   { id, type: 'files', files: [absolute paths], pinned, ts }
// Entries written by versions before image/file support have no `type` field and
// are normalized to 'text' at load so old history files keep working.

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  const CONFIG_PATH = path.join(userDataPath, 'clipboard-history.json');
  // Full-size copies of captured images live here (the JSON only holds a small
  // inline thumbnail); files are deleted when their entry is deleted/evicted.
  const IMAGES_DIR = path.join(userDataPath, 'clipboard-images');

  let config = loadConfig();
  let pollTimer = null;
  // Anchors change-detection for the poll loop. Also updated whenever WE write to
  // the clipboard (re-copy), so the next poll doesn't re-capture our own write as
  // a spurious new entry.
  let lastSeenText = null;
  let lastSeenImageHash = null;
  let lastSeenFilesAnchor = null;
  // Guards against overlapping PowerShell reads of the file drop list.
  let filesCaptureBusy = false;

  cleanupOrphanImages();

  // ── Encrypted at rest ──
  // Clipboard history is the single most sensitive thing this app persists: the
  // SENSITIVE_CLIPBOARD_FORMAT check above keeps password-manager copies out of
  // it, but anything copied from a plain web login form, a config file or a
  // terminal still lands here. So it goes through Electron's safeStorage (DPAPI
  // on Windows, Keychain on macOS), exactly like the Spotify tokens — the file
  // is then only decryptable by this app on this machine.
  //
  // The read tries plaintext JSON first, so an existing history file from before
  // this change loads normally and is re-written encrypted on the next save. No
  // separate migration step, and no history lost.
  function writeConfigFile(obj) {
    const json = JSON.stringify(obj, null, 2);
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(CONFIG_PATH, safeStorage.encryptString(json), { mode: 0o600 });
    } else {
      // OS encryption isn't ready yet, or this machine has no keychain. Keep the
      // feature working rather than silently dropping the save.
      logger.warn('safeStorage unavailable, writing clipboard history as plaintext', { path: CONFIG_PATH });
      fs.writeFileSync(CONFIG_PATH, json, { encoding: 'utf8', mode: 0o600 });
    }
  }

  function readConfigFile() {
    const raw = fs.readFileSync(CONFIG_PATH);
    try {
      // Pre-encryption files, and the plaintext fallback above, are UTF-8 JSON.
      return { data: JSON.parse(raw.toString('utf8')), plaintext: true };
    } catch (e) {
      // Not valid JSON text, so it must be a safeStorage-encrypted buffer.
    }
    if (!app.isReady() || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Clipboard history is encrypted but OS encryption is not ready yet');
    }
    return { data: JSON.parse(safeStorage.decryptString(raw)), plaintext: false };
  }

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const { data: raw, plaintext } = readConfigFile();
        const validEntry = (e) => {
          if (!e || typeof e !== 'object' || typeof e.id !== 'string') return false;
          const type = e.type || 'text';
          if (type === 'text') return typeof e.text === 'string';
          if (type === 'image') return typeof e.imageFile === 'string' && typeof e.thumb === 'string';
          if (type === 'files') return Array.isArray(e.files) && e.files.length > 0 && e.files.every((p) => typeof p === 'string');
          return false;
        };
        const loaded = {
          enabled: raw.enabled === true,
          history: Array.isArray(raw.history)
            ? raw.history.filter(validEntry).map((e) => (e.type ? e : { ...e, type: 'text' }))
            : []
        };
        // Upgrade an old plaintext file in place. Waiting for the next copy
        // would leave the secrets already on disk readable indefinitely for
        // anyone who stops using the widget.
        if (plaintext && app.isReady() && safeStorage.isEncryptionAvailable()) {
          logger.log('Migrating clipboard history to encrypted storage', 'INFO');
          try { writeConfigFile(loaded); } catch (e) { logger.warn('Clipboard history migration failed', e); }
        }
        return loaded;
      }
    } catch (e) {
      logger.error('Failed to read clipboard history config', e);
    }
    return { enabled: false, history: [] };
  }

  function cleanupOrphanImages() {
    try {
      if (!fs.existsSync(IMAGES_DIR)) return;
      const referenced = new Set(config.history.filter((e) => e.type === 'image').map((e) => e.imageFile));
      for (const f of fs.readdirSync(IMAGES_DIR)) {
        if (!referenced.has(f)) fs.unlinkSync(path.join(IMAGES_DIR, f));
      }
    } catch (e) {
      logger.error('Failed to clean up clipboard image cache', e);
    }
  }

  function saveConfig() {
    try {
      writeConfigFile(config);
    } catch (e) {
      logger.error('Failed to save clipboard history config', e);
    }
  }

  function pushStatus() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('clipboard-changed', { enabled: config.enabled, history: config.history });
    }
  }

  function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function removeEntryArtifacts(entry) {
    if (entry.type === 'image' && entry.imageFile) {
      fs.unlink(path.join(IMAGES_DIR, entry.imageFile), () => {});
    }
  }

  function evictIfNeeded() {
    let overflow = config.history.length - MAX_HISTORY;
    if (overflow <= 0) return;
    // History is newest-first (unshift). Evict from the tail (oldest) forward,
    // skipping pinned entries so a pin survives the cap.
    for (let i = config.history.length - 1; i >= 0 && overflow > 0; i--) {
      if (!config.history[i].pinned) {
        removeEntryArtifacts(config.history[i]);
        config.history.splice(i, 1);
        overflow--;
      }
    }
  }

  function addEntry(entry) {
    config.history.unshift(entry);
    evictIfNeeded();
    saveConfig();
    pushStatus();
  }

  function captureText(text) {
    if (text === lastSeenText) return;
    lastSeenText = text;
    // Don't duplicate the most recent entry (e.g. an app re-writing the same
    // selection to the clipboard shouldn't produce two history rows).
    const top = config.history[0];
    if (top && top.type === 'text' && top.text === text) return;
    const truncated = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
    addEntry({ id: makeId(), type: 'text', text: truncated, pinned: false, ts: Date.now() });
  }

  // Pixel-level hash for change detection. toBitmap() is deterministic for the
  // same clipboard pixels, so a re-copy of our own writeImage() round-trips to
  // the same hash (unlike toPNG(), whose bytes vary with re-encoding).
  function imageHash(img) {
    return crypto.createHash('sha1').update(img.toBitmap()).digest('hex');
  }

  function captureImage() {
    const img = clipboard.readImage();
    if (img.isEmpty()) return;
    const hash = imageHash(img);
    if (hash === lastSeenImageHash) return;
    lastSeenImageHash = hash;
    const top = config.history[0];
    if (top && top.type === 'image' && top.hash === hash) return;
    const { width, height } = img.getSize();
    if (!width || !height) return;
    const id = makeId();
    const imageFile = `${id}.png`;
    try {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      fs.writeFileSync(path.join(IMAGES_DIR, imageFile), img.toPNG());
    } catch (e) {
      logger.error('Failed to save clipboard image', e);
      return;
    }
    const thumbSource = width > THUMB_WIDTH ? img.resize({ width: THUMB_WIDTH }) : img;
    addEntry({
      id, type: 'image', imageFile,
      thumb: thumbSource.toDataURL(),
      width, height, hash,
      pinned: false, ts: Date.now()
    });
  }

  // Explorer (and most shells) put the first copied file's path on the clipboard
  // as the registered "FileNameW" format alongside CF_HDROP. Electron can read
  // registered formats, so this is the cheap per-poll signal that files were
  // copied; the full multi-file list then comes from one PowerShell call.
  function readClipboardFirstFile() {
    try {
      if (isMac) {
        // macOS: Finder puts copied files on the pasteboard as public.file-url
        // (a file:// URL). Read the first one — multi-file enumeration isn't
        // available without a native pasteboard read.
        const url = clipboard.read('public.file-url');
        if (!url) return null;
        try { return fileURLToPath(url); } catch { return null; }
      }
      // Windows: Explorer registers the first path as the FileNameW format.
      const buf = clipboard.readBuffer('FileNameW');
      if (!buf || !buf.length) return null;
      const p = buf.toString('ucs2').replace(/\0+$/, '');
      return p || null;
    } catch {
      return null;
    }
  }

  function readFileDropList(cb) {
    if (!isWindows) {
      // macOS/other: best-effort single file from the pasteboard (the full
      // multi-file list needs a native read we don't have off Windows).
      const first = readClipboardFirstFile();
      cb(first ? [first] : null);
      return;
    }
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Get-Clipboard -Format FileDropList | ForEach-Object { "$_" }'],
      { windowsHide: true, timeout: 10000 },
      (err, stdout) => {
        if (err) {
          logger.error('Failed to read copied file list from clipboard', err);
          cb(null);
          return;
        }
        cb(String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  }

  function writeFileDropList(paths) {
    if (isMac) {
      // macOS: set the clipboard to file references via AppleScript.
      return runAppleScript(scripts.setClipboardFiles(paths)).then(({ ok }) => ok);
    }
    if (!isWindows) return Promise.resolve(false);
    return new Promise((resolve) => {
      const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Set-Clipboard -Path @(${list})`],
        { windowsHide: true, timeout: 10000 },
        (err) => {
          if (err) {
            logger.error('Failed to copy files to clipboard', err);
            resolve(false);
          } else {
            resolve(true);
          }
        });
    });
  }

  // Returns true when file data is on the clipboard (so the poll skips the
  // text/image checks -- a file copy is never also a text or image copy we
  // want to record separately).
  function captureFiles() {
    const first = readClipboardFirstFile();
    if (!first) {
      lastSeenFilesAnchor = null;
      return false;
    }
    if (first === lastSeenFilesAnchor) return true;
    lastSeenFilesAnchor = first;
    if (filesCaptureBusy) return true;
    filesCaptureBusy = true;
    readFileDropList((paths) => {
      filesCaptureBusy = false;
      const files = paths && paths.length ? paths : [first];
      const top = config.history[0];
      if (top && top.type === 'files' && top.files.join('\n') === files.join('\n')) return;
      addEntry({ id: makeId(), type: 'files', files, pinned: false, ts: Date.now() });
    });
    return true;
  }

  function poll() {
    try {
      const formats = clipboard.availableFormats();
      if (formats.includes(SENSITIVE_CLIPBOARD_FORMAT)) return;
      if (captureFiles()) return;
      const text = clipboard.readText();
      if (text && text.trim()) {
        captureText(text);
        return;
      }
      captureImage();
    } catch (e) {
      logger.error('Clipboard poll failed', e);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    // Seed the change anchors with whatever is already on the clipboard so
    // enabling the widget doesn't retroactively record stale content.
    try {
      lastSeenText = clipboard.readText();
    } catch {
      lastSeenText = null;
    }
    lastSeenFilesAnchor = readClipboardFirstFile();
    try {
      const img = clipboard.readImage();
      lastSeenImageHash = img.isEmpty() ? null : imageHash(img);
    } catch {
      lastSeenImageHash = null;
    }
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setEnabled(enabled) {
    config.enabled = !!enabled;
    saveConfig();
    if (config.enabled) startPolling();
    else stopPolling();
    return config.enabled;
  }

  if (config.enabled) startPolling();

  ipcMain.handle('clipboard-get', () => ({ enabled: config.enabled, history: config.history }));

  ipcMain.handle('clipboard-set-enabled', (_event, enabled) => setEnabled(enabled));

  ipcMain.handle('clipboard-copy', async (_event, id) => {
    const entry = config.history.find((e) => e.id === id);
    if (!entry) return { ok: false };
    const type = entry.type || 'text';
    if (type === 'text') {
      lastSeenText = entry.text;
      clipboard.writeText(entry.text);
      return { ok: true };
    }
    if (type === 'image') {
      const img = nativeImage.createFromPath(path.join(IMAGES_DIR, entry.imageFile));
      if (img.isEmpty()) return { ok: false, error: 'Image is no longer cached' };
      clipboard.writeImage(img);
      // Hash what the clipboard now holds (the DIB round-trip can differ from
      // the source PNG pixels-for-pixels only, so read it back) to stop the
      // next poll from re-recording our own write.
      try {
        lastSeenImageHash = imageHash(clipboard.readImage());
      } catch {}
      return { ok: true };
    }
    if (type === 'files') {
      const existing = entry.files.filter((p) => {
        try { return fs.existsSync(p); } catch { return false; }
      });
      if (!existing.length) return { ok: false, error: 'Those files no longer exist' };
      const ok = await writeFileDropList(existing);
      if (ok) lastSeenFilesAnchor = existing[0];
      return ok ? { ok: true } : { ok: false, error: 'Could not copy files' };
    }
    return { ok: false };
  });

  ipcMain.handle('clipboard-toggle-pin', (_event, id) => {
    const entry = config.history.find((e) => e.id === id);
    if (!entry) return { ok: false };
    entry.pinned = !entry.pinned;
    saveConfig();
    pushStatus();
    return { ok: true, pinned: entry.pinned };
  });

  ipcMain.handle('clipboard-delete', (_event, id) => {
    const entry = config.history.find((e) => e.id === id);
    if (!entry) return { ok: true };
    removeEntryArtifacts(entry);
    config.history = config.history.filter((e) => e.id !== id);
    saveConfig();
    pushStatus();
    return { ok: true };
  });

  ipcMain.handle('clipboard-clear', () => {
    for (const entry of config.history) {
      if (!entry.pinned) removeEntryArtifacts(entry);
    }
    config.history = config.history.filter((e) => e.pinned);
    saveConfig();
    pushStatus();
    return { ok: true };
  });

  return {
    isEnabled: () => config.enabled,
    teardown: stopPolling
  };
}

module.exports = { init };
