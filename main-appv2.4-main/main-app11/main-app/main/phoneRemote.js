// Phone Remote — the launcher's player and lyrics on a phone, from anywhere.
// This is the PC side's Electron glue: pairing, the relay connection and the
// panel's IPC. What gets said to a phone lives in main/phoneRemoteHost.js; the
// crypto and message rules in renderer/remote-protocol.js; the relay in
// relay/ (a Cloudflare Worker); the phone page in website/public/remote/.
//
// Pairing: a 32-byte secret, made here and shown once as a QR code. It is
// stored with safeStorage (OS-encrypted) where available. Unpairing throws it
// away, which cuts off every phone that had it.
//
// The relay socket lives in a hidden window (phone-remote.html + its own
// narrow preload), not in Node: Chromium's network stack honours the OS
// certificate store and proxy, which a TLS-inspecting antivirus needs — the
// same reason the content fetches go through Electron `net` (main/netClient.js).
// The window has no page script and exposes nothing to its page; the preload
// owns the WebSocket and reports to main. Main checks every message's sender.
//
// The relay only opens a room for a licensed copy, so the socket URL carries
// the license token (main/license.js → relayToken). While enabled and paired,
// the PC stays connected (an idle socket costs a ping every 25s, which the
// relay answers without waking up), and only polls Spotify while a phone is
// actually watching.

const { app, ipcMain, BrowserWindow, safeStorage, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { lockNavigation } = require('./windowGuard');
const P = require('../renderer/remote-protocol');
const { RemoteHost } = require('./phoneRemoteHost');

// The relay's host name — where relay/ is deployed (see relay/README.md). Empty
// would make the panel say the remote isn't set up. MAIN_PHONE_RELAY overrides
// it in dev runs only, so a shipped build can't be pointed at another relay.
const RELAY_HOST_DEFAULT = 'main-phone-relay.main-phone-relay.workers.dev';
const RELAY_HOST = (!app.isPackaged && process.env.MAIN_PHONE_RELAY) || RELAY_HOST_DEFAULT;

const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000];
const REPLACED_RETRY_MS = 60000;   // another copy of main holds the room

function init(ctx, deps) {
  const { logger } = ctx;
  const { spotify, lyrics, license } = deps;
  const siteUrl = deps.siteUrl;
  const STORE_PATH = path.join(ctx.userDataPath, 'phone-remote.json');

  let enabled = false;
  let secret = null;
  let status = 'off';
  let phones = 0;
  let win = null;
  let winReady = false;
  let failed = false;
  let connected = false;
  let reconnectTimer = null;
  let attempt = 0;
  let settings = { look: 'glass', lead: 700 };

  const host = new RemoteHost({
    protocol: P,
    spotify,
    lyrics,
    logger,
    send: (text) => socket({ op: 'send', text }),
    getSettings: () => settings,
  });

  // ── Storage ─────────────────────────────────────────────────────────────

  function load() {
    try {
      if (!fs.existsSync(STORE_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      enabled = raw.enabled === true;
      let s = null;
      if (typeof raw.secretEnc === 'string' && safeStorage.isEncryptionAvailable()) {
        s = safeStorage.decryptString(Buffer.from(raw.secretEnc, 'base64'));
      } else if (typeof raw.secret === 'string') {
        s = raw.secret;
      }
      secret = P.isSecret(s) ? s : null;
    } catch (e) {
      logger.warn('Phone Remote: store unreadable, starting unpaired', { error: e && e.message });
    }
  }

  function save() {
    const rec = { enabled };
    if (secret) {
      if (safeStorage.isEncryptionAvailable()) rec.secretEnc = safeStorage.encryptString(secret).toString('base64');
      else rec.secret = secret;
    }
    try {
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, STORE_PATH);
    } catch (e) {
      logger.error('Phone Remote: could not save pairing', e);
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  function info() {
    return { enabled, paired: !!secret, configured: !!RELAY_HOST, status, phones };
  }

  function setStatus(next, nextPhones = phones) {
    if (next === status && nextPhones === phones) return;
    status = next;
    phones = nextPhones;
    const w = ctx.getMainWindow && ctx.getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('phone-remote:changed', info());
  }

  // ── The socket window ───────────────────────────────────────────────────

  function socket(cmd) {
    if (win && !win.isDestroyed() && winReady) win.webContents.send('phone-remote:socket', cmd);
  }

  function ensureWindow() {
    if (failed || (win && !win.isDestroyed())) return;
    winReady = false;
    win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: path.join(ctx.appRoot, 'phone-remote-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Its keep-alive timer must run while nothing of it is ever on screen.
        backgroundThrottling: false,
        devTools: !app.isPackaged,
      },
    });
    lockNavigation(win, logger);
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      logger.error('Phone Remote: socket page failed to load', null, { code, desc });
      failed = true;
      setStatus('error', 0);
      destroyWindow();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      logger.warn('Phone Remote: socket page went away', { reason: details && details.reason });
      destroyWindow();
      connected = false;
      host.onClose();
      scheduleReconnect();
    });
    win.loadFile(path.join(ctx.appRoot, 'phone-remote.html'));
  }

  function destroyWindow() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    winReady = false;
  }

  const fromSocketWindow = (event) => !!win && !win.isDestroyed() && event.sender === win.webContents;

  ipcMain.on('phone-remote:socket-ready', (event) => {
    if (!fromSocketWindow(event)) return;
    winReady = true;
    connect();
  });

  ipcMain.on('phone-remote:socket-event', (event, ev) => {
    if (!fromSocketWindow(event) || !ev || typeof ev !== 'object') return;
    if (ev.type === 'open') {
      connected = true;
      attempt = 0;
      host.onOpen();
      setStatus('online', 0);
    } else if (ev.type === 'message' && typeof ev.data === 'string') {
      noteRelayFrame(ev.data);
      host.onMessage(ev.data);
    } else if (ev.type === 'close') {
      connected = false;
      host.onClose();
      onClosed(Number(ev.code) || 0);
    }
  });

  // The relay's own frames: how many phones are watching.
  function noteRelayFrame(text) {
    if (!text.startsWith('{"t":"peers"')) return;
    try {
      const frame = JSON.parse(text);
      setStatus('online', Math.max(0, Math.floor(Number(frame.phones) || 0)));
    } catch (e) { /* not a peers frame */ }
  }

  // ── Connecting ──────────────────────────────────────────────────────────

  function wanted() {
    return enabled && !!secret && !!RELAY_HOST && !failed;
  }

  async function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (!wanted()) return;
    const token = license && license.relayToken ? license.relayToken() : null;
    if (!token) {
      setStatus('unlicensed', 0);
      return;
    }
    ensureWindow();
    if (!winReady) return;   // the page's ready signal calls back here
    setStatus('connecting', 0);
    try {
      await host.setSecret(secret);
      const room = await P.deriveRoom(secret);
      if (!wanted()) return;
      socket({ op: 'connect', url: P.relayUrl(RELAY_HOST, room, 'host', token) });
    } catch (e) {
      logger.error('Phone Remote: could not start a session', e);
      setStatus('error', 0);
    }
  }

  function onClosed(code) {
    if (!wanted()) { setStatus(enabled ? status : 'off', 0); return; }
    if (code === 4000) {
      // Another copy of main has the room. Don't fight it for it.
      setStatus('offline', 0);
      scheduleReconnect(REPLACED_RETRY_MS);
      return;
    }
    setStatus('offline', 0);
    scheduleReconnect();
  }

  function scheduleReconnect(ms) {
    clearTimeout(reconnectTimer);
    if (!wanted()) return;
    const delay = ms || RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket({ op: 'close' });
    connected = false;
    host.onClose();
    destroyWindow();
  }

  function reconcile() {
    if (!enabled) { disconnect(); setStatus('off', 0); return; }
    if (!RELAY_HOST) { disconnect(); setStatus('unconfigured', 0); return; }
    if (!secret) { disconnect(); setStatus('unpaired', 0); return; }
    if (!connected) connect();
  }

  // Sleep drops the socket without a close the page always sees; start over.
  if (powerMonitor) {
    powerMonitor.on('resume', () => {
      if (!wanted()) return;
      attempt = 0;
      socket({ op: 'close' });
      connected = false;
      host.onClose();
      setTimeout(connect, 1500);
    });
  }

  // ── Panel IPC (the launcher's Widget Library) ───────────────────────────

  ipcMain.handle('phone-remote:get', () => info());

  ipcMain.handle('phone-remote:set-enabled', (_event, on) => {
    enabled = on === true;
    save();
    reconcile();
    return info();
  });

  // Makes the pairing (if there isn't one yet) and returns the link for the
  // QR code. Adding another phone shows the same link again.
  ipcMain.handle('phone-remote:pair', () => {
    if (!RELAY_HOST) return { ...info(), link: null };
    if (!secret) {
      secret = P.newSecret();
      save();
      disconnect();
    }
    reconcile();
    return { ...info(), link: P.buildLink(siteUrl, secret, RELAY_HOST) };
  });

  ipcMain.handle('phone-remote:unpair', () => {
    secret = null;
    save();
    host.setSecret(null);
    reconcile();
    return info();
  });

  // The launcher's look and lyric timing (main can't read the renderer's storage).
  ipcMain.handle('phone-remote:sync', (_event, s) => {
    if (!s || typeof s !== 'object') return false;
    const look = s.look === 'white' ? 'white' : 'glass';
    const lead = Number.isFinite(s.lead) ? Math.max(0, Math.min(2000, Math.round(s.lead))) : settings.lead;
    if (look !== settings.look || lead !== settings.lead) {
      settings = { look, lead };
      host.settingsChanged();
    }
    return true;
  });

  load();
  reconcile();

  return {
    teardown() {
      enabled = false;
      disconnect();
    },
  };
}

module.exports = { init };
