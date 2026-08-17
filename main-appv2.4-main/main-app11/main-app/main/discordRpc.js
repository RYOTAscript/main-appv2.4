const { ipcMain } = require('electron');
const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Discord Rich Presence widget (backend) ──
// Talks to the local Discord desktop client over its IPC named pipe
// (\\?\pipe\discord-ipc-0..9) directly — no third-party dependency. The wire
// format is a stream of framed messages: a little-endian uint32 opcode, a
// little-endian uint32 byte length, then that many bytes of UTF-8 JSON.
//   op 0 HANDSHAKE  {v:1, client_id}
//   op 1 FRAME      command payloads (SET_ACTIVITY, and the READY dispatch back)
//   op 2 CLOSE      either side closing
//   op 3 PING / op 4 PONG   keep-alive
// After a successful handshake Discord dispatches READY; we then push the user's
// configured activity with SET_ACTIVITY. Everything the user can customise lives
// in discord-rpc-config.json under userData. Disabled by default.

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

// Reconnect backoff when Discord isn't running / the pipe drops. Capped so a
// perpetually-closed Discord doesn't spin, but quick enough to latch on within
// a couple of seconds of Discord starting.
const RECONNECT_MS = 8000;
// Discord rejects activity updates more than 5x / 20s; we debounce edits well
// under that, but keep a hard floor between pushes as a backstop.
const MIN_PUSH_INTERVAL_MS = 2000;

function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  // Discord requires 2..128 chars for most fields; empty is allowed (it just
  // omits the field). Trim and cap — never send something Discord will reject.
  return v.slice(0, max);
}

function sanitizeButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  const out = [];
  for (const b of buttons) {
    if (!b || typeof b !== 'object') continue;
    const label = clampStr(b.label, 32).trim();
    let url = typeof b.url === 'string' ? b.url.trim() : '';
    if (!label || !url) continue;
    // Discord only accepts http/https button URLs.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      url = parsed.href;
    } catch (e) { continue; }
    out.push({ label, url });
    if (out.length === 2) break; // Discord allows at most two buttons
  }
  return out;
}

function sanitizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true,
    clientId: typeof c.clientId === 'string' ? c.clientId.replace(/[^0-9]/g, '').slice(0, 32) : '',
    details: clampStr(c.details, 128),
    state: clampStr(c.state, 128),
    largeImageKey: clampStr(c.largeImageKey, 256).trim(),
    largeImageText: clampStr(c.largeImageText, 128),
    smallImageKey: clampStr(c.smallImageKey, 256).trim(),
    smallImageText: clampStr(c.smallImageText, 128),
    showTimestamp: c.showTimestamp !== false, // default: show elapsed time
    buttons: sanitizeButtons(c.buttons)
  };
}

function init(ctx) {
  const { logger, userDataPath } = ctx;
  const CONFIG_PATH = path.join(userDataPath, 'discord-rpc-config.json');

  let config = loadConfig();
  let socket = null;
  let connected = false;      // pipe open AND handshake READY received
  let handshaking = false;
  let readBuffer = Buffer.alloc(0);
  let reconnectTimer = null;
  let lastError = null;       // human-readable last failure, surfaced to the UI
  let activityStart = null;   // ms epoch used for the elapsed timestamp
  let lastPushAt = 0;
  let pushPending = false;
  // The bold top line of a Discord Rich Presence card is the *application's*
  // registered name (from the Application ID) — it isn't part of the activity we
  // send and the user can't edit it. We fetch it once from Discord's public app
  // endpoint purely so the live preview matches what others actually see.
  let appName = '';
  let appNameFetchedFor = '';

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
      }
    } catch (e) {
      logger.error('Failed to read Discord RPC config', e);
    }
    return sanitizeConfig({});
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save Discord RPC config', e);
    }
  }

  function pushStatus(extra) {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('discord-rpc-status', {
        enabled: config.enabled,
        connected,
        hasClientId: !!config.clientId,
        error: lastError,
        appName,
        ...(extra || {})
      });
    }
  }

  // Look up the application's public name so the preview shows the same bold
  // top line Discord renders. Best-effort: any failure just leaves it blank.
  function fetchAppName() {
    const id = config.clientId;
    if (!id) { appName = ''; appNameFetchedFor = ''; return; }
    if (appNameFetchedFor === id) return; // already tried this id
    appNameFetchedFor = id;
    try {
      const req = https.get({
        hostname: 'discord.com',
        path: `/api/v9/applications/${id}/rpc`,
        headers: { 'User-Agent': 'main-launcher' }
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return; }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j && typeof j.name === 'string' && j.name) {
              appName = j.name;
              pushStatus();
            }
          } catch (e) { /* ignore malformed */ }
        });
      });
      req.on('error', () => { /* offline / blocked — preview just omits the name */ });
      req.setTimeout(8000, () => req.destroy());
    } catch (e) { /* ignore */ }
  }

  // ── Wire helpers ──
  function encode(op, dataObj) {
    const json = Buffer.from(JSON.stringify(dataObj), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    return Buffer.concat([header, json]);
  }

  function send(op, dataObj) {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(encode(op, dataObj));
      return true;
    } catch (e) {
      logger.warn('Discord RPC write failed', e);
      return false;
    }
  }

  function pipePath(index) {
    // Node accepts the \\?\pipe\ form; discord-ipc-0 is by far the most common
    // but a busy machine (multiple Discord installs) can push it up to 9.
    return `\\\\?\\pipe\\discord-ipc-${index}`;
  }

  function scheduleReconnect() {
    if (reconnectTimer || !config.enabled) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (config.enabled && !connected) connect(0);
    }, RECONNECT_MS);
  }

  function cleanupSocket() {
    if (socket) {
      try { socket.removeAllListeners(); socket.destroy(); } catch (e) { /* ignore */ }
      socket = null;
    }
    connected = false;
    handshaking = false;
    readBuffer = Buffer.alloc(0);
  }

  // Try pipe `index`; on ENOENT (that pipe number not present) walk to the next
  // one, up to 9, before giving up and scheduling a retry.
  function connect(index) {
    if (!config.enabled) return;
    if (!config.clientId) {
      lastError = 'Add your Discord Application ID to connect.';
      pushStatus();
      return;
    }
    if (index > 9) {
      lastError = 'Discord not found — is the desktop app running?';
      cleanupSocket();
      pushStatus();
      scheduleReconnect();
      return;
    }
    cleanupSocket();

    const sock = net.createConnection({ path: pipePath(index) });
    socket = sock;

    sock.on('connect', () => {
      handshaking = true;
      lastError = null;
      logger.log(`Discord IPC pipe opened (discord-ipc-${index})`, 'INFO');
      send(OP_HANDSHAKE, { v: 1, client_id: config.clientId });
    });

    sock.on('data', (chunk) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);
      drainFrames();
    });

    sock.on('error', (err) => {
      if (sock !== socket) return; // stale socket
      // ENOENT = this pipe index isn't there; try the next before failing.
      if (err && err.code === 'ENOENT' && !connected) {
        cleanupSocket();
        connect(index + 1);
        return;
      }
      logger.warn('Discord IPC socket error', err);
      lastError = 'Lost the connection to Discord.';
      cleanupSocket();
      pushStatus();
      scheduleReconnect();
    });

    sock.on('close', () => {
      if (sock !== socket) return;
      const wasConnected = connected;
      cleanupSocket();
      if (wasConnected) {
        lastError = 'Discord closed the connection.';
        pushStatus();
      }
      scheduleReconnect();
    });
  }

  function drainFrames() {
    // Each frame: 8-byte header (op, len) + len bytes of JSON.
    while (readBuffer.length >= 8) {
      const op = readBuffer.readInt32LE(0);
      const len = readBuffer.readInt32LE(4);
      if (readBuffer.length < 8 + len) return; // wait for the rest
      const payload = readBuffer.slice(8, 8 + len);
      readBuffer = readBuffer.slice(8 + len);
      let msg = null;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { msg = null; }
      handleFrame(op, msg);
    }
  }

  function handleFrame(op, msg) {
    if (op === OP_PING) { send(OP_PONG, msg || {}); return; }
    if (op === OP_CLOSE) {
      const reason = msg && (msg.message || msg.code);
      logger.warn('Discord IPC sent CLOSE', new Error(String(reason || 'unknown')));
      lastError = msg && msg.message ? `Discord: ${msg.message}` : 'Discord rejected the connection (check the Application ID).';
      cleanupSocket();
      pushStatus();
      scheduleReconnect();
      return;
    }
    if (op !== OP_FRAME || !msg) return;

    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      connected = true;
      handshaking = false;
      lastError = null;
      logger.success('Discord Rich Presence connected', {
        user: msg.data && msg.data.user ? msg.data.user.username : undefined
      });
      pushStatus({ event: 'ready' });
      // Fresh connection → (re)start the elapsed clock and push the activity.
      activityStart = Date.now();
      pushActivity(true);
      return;
    }
    if (msg.evt === 'ERROR') {
      const detail = msg.data && msg.data.message;
      logger.warn('Discord RPC command error', new Error(String(detail || 'unknown')));
      lastError = detail ? `Discord: ${detail}` : 'Discord rejected the presence data.';
      pushStatus();
    }
    // SET_ACTIVITY success replies (cmd SET_ACTIVITY, no evt) need no action.
  }

  // ── Activity ──
  function buildActivity() {
    const hasAssets = config.largeImageKey || config.smallImageKey;
    const activity = {};
    if (config.details) activity.details = config.details;
    if (config.state) activity.state = config.state;
    if (config.showTimestamp && activityStart) {
      activity.timestamps = { start: activityStart };
    }
    if (hasAssets) {
      activity.assets = {};
      if (config.largeImageKey) activity.assets.large_image = config.largeImageKey;
      if (config.largeImageText) activity.assets.large_text = config.largeImageText;
      if (config.smallImageKey) activity.assets.small_image = config.smallImageKey;
      if (config.smallImageText) activity.assets.small_text = config.smallImageText;
    }
    if (config.buttons.length) activity.buttons = config.buttons;
    return activity;
  }

  // Discord needs at least a details OR state OR asset to show a card; with
  // nothing set we clear the presence rather than push an empty object.
  function activityIsEmpty(a) {
    return !a.details && !a.state && !a.assets && !a.buttons;
  }

  function pushActivity(immediate) {
    if (!connected) return;
    const now = Date.now();
    const wait = Math.max(0, MIN_PUSH_INTERVAL_MS - (now - lastPushAt));
    if (wait > 0 && !immediate) {
      if (pushPending) return;
      pushPending = true;
      setTimeout(() => { pushPending = false; pushActivity(true); }, wait);
      return;
    }
    lastPushAt = now;
    const activity = buildActivity();
    const args = { pid: process.pid };
    // An empty activity clears the presence; otherwise send the built object.
    if (!activityIsEmpty(activity)) args.activity = activity;
    send(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      args,
      nonce: crypto.randomUUID()
    });
  }

  function start() {
    if (!config.enabled) return;
    lastError = null;
    if (connected || handshaking) return;
    connect(0);
  }

  function stop() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Politely clear the presence before dropping the pipe.
    if (connected) send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() });
    cleanupSocket();
    activityStart = null;
    pushStatus();
  }

  function statusForRenderer() {
    return {
      enabled: config.enabled,
      connected,
      hasClientId: !!config.clientId,
      error: lastError,
      appName,
      config: { ...config }
    };
  }

  // ── IPC ──
  ipcMain.handle('discord-rpc-get', () => statusForRenderer());

  ipcMain.handle('discord-rpc-set-enabled', (_event, enabled) => {
    config.enabled = !!enabled;
    saveConfig();
    if (config.enabled) start();
    else stop();
    logger.success('Discord Rich Presence widget toggled', { enabled: config.enabled });
    return statusForRenderer();
  });

  ipcMain.handle('discord-rpc-set-config', (_event, next) => {
    const prevClientId = config.clientId;
    const prevEnabled = config.enabled;
    // Preserve the enabled flag — it's owned by the toggle, not the config form.
    config = sanitizeConfig({ ...next, enabled: prevEnabled });
    saveConfig();
    // A changed Application ID means a different app name — refetch for the preview.
    if (config.clientId !== prevClientId) { appName = ''; appNameFetchedFor = ''; }
    fetchAppName();
    if (config.enabled) {
      // Changing the client id means a new app identity → full reconnect.
      if (config.clientId !== prevClientId || !connected) {
        stopSilently();
        start();
      } else {
        pushActivity(false);
      }
    }
    return statusForRenderer();
  });

  ipcMain.handle('discord-rpc-reconnect', () => {
    if (!config.enabled) return statusForRenderer();
    stopSilently();
    start();
    return statusForRenderer();
  });

  // Like stop() but without clearing presence noise or firing status — used when
  // we're about to immediately reconnect.
  function stopSilently() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    cleanupSocket();
  }

  fetchAppName();
  if (config.enabled) start();

  return {
    teardown: () => { config.enabled = false; stop(); }
  };
}

module.exports = { init };
