const { app, BrowserWindow, ipcMain, globalShortcut, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeFetch } = require('./httpClient');
const { BoundedCache } = require('./boundedCache');

const SPOTIFY_REDIRECT_URI_CUSTOM = 'main-launcher://spotify-callback';

const SPOTIFY_SHORTCUTS = {
  spotifyPlay: 'CommandOrControl+Up',
  spotifyPause: 'CommandOrControl+Down',
  spotifyNext: 'CommandOrControl+Right',
  spotifyPrevious: 'CommandOrControl+Left',
  spotifyVolumeUp: 'CommandOrControl+PageUp',
  spotifyVolumeDown: 'CommandOrControl+PageDown'
};

function generateCodeVerifier() {
  // PKCE verifiers must be cryptographically random (RFC 7636 §4.1) — plain
  // Math.random() is predictable and defeats the point of the challenge.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(128);
  let result = '';
  for (let i = 0; i < 128; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
}

function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  const SPOTIFY_CONFIG_PATH = path.join(userDataPath, 'spotify-config.json');
  const SPOTIFY_TOKENS_PATH = path.join(userDataPath, 'spotify-tokens.json');

  let spotifyTokens = null;
  let spotifyConfig = { clientId: '' };
  const spotifyAnalysisCache = new BoundedCache(300);
  const spotifyFeaturesCache = new BoundedCache(300);
  let lastRefreshAttemptTime = 0;
  const REFRESH_RETRY_COOLDOWN_MS = 15000;
  // Concurrent spotifyApiRequest calls (e.g. overlapping polls) can each decide
  // a refresh is needed at the same moment; without this, they'd fire separate
  // refresh_token requests, and Spotify rotates refresh tokens on each grant —
  // whichever response is saved last wins and the other's rotated token is lost.
  // Sharing one in-flight promise makes every concurrent caller await the same
  // single network call instead.
  let refreshInFlightPromise = null;

  let registeredSpotifyShortcuts = {};
  let sleepTimerHandle = null;
  let sleepTimerEndsAt = null;
  let authWindowOpen = false;

  // The Spotify client ID and OAuth tokens used to be written to disk as plain
  // JSON, readable by anything with filesystem access to this machine. These
  // two helpers route every read/write through Electron's safeStorage, which
  // encrypts with the OS keychain (DPAPI on Windows) so the files are only
  // decryptable by this app on this machine.
  function encryptedWriteJSON(filePath, obj) {
    const json = JSON.stringify(obj, null, 2);
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(filePath, safeStorage.encryptString(json));
    } else {
      // OS encryption isn't ready yet (called before the 'ready' event) or isn't
      // supported on this machine (no keychain/libsecret). Fall back to plaintext
      // so the feature keeps working rather than silently losing the save.
      logger.warn('safeStorage unavailable, writing Spotify data as plaintext', { path: filePath });
      fs.writeFileSync(filePath, json, 'utf8');
    }
  }

  function encryptedReadJSON(filePath) {
    const raw = fs.readFileSync(filePath);
    try {
      // Legacy pre-encryption files, and the plaintext fallback above, are plain
      // UTF-8 JSON — try that first so no separate migration path is needed.
      return { data: JSON.parse(raw.toString('utf8')), plaintext: true };
    } catch (e) {
      // Not valid JSON text, so it must be a safeStorage-encrypted buffer.
    }
    if (!app.isReady() || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Spotify data on disk is encrypted but OS encryption is not ready yet');
    }
    return { data: JSON.parse(safeStorage.decryptString(raw)), plaintext: false };
  }

  function loadSpotifyConfig() {
    try {
      if (fs.existsSync(SPOTIFY_CONFIG_PATH)) {
        const { data, plaintext } = encryptedReadJSON(SPOTIFY_CONFIG_PATH);
        spotifyConfig = data;
        if (plaintext && app.isReady() && safeStorage.isEncryptionAvailable()) {
          logger.log('Migrating Spotify config to encrypted storage', 'INFO');
          saveSpotifyConfig();
        }
      }
    } catch (e) {
      logger.error('Failed to load Spotify config', e);
    }
  }

  function saveSpotifyConfig() {
    try {
      encryptedWriteJSON(SPOTIFY_CONFIG_PATH, spotifyConfig);
    } catch (e) {
      logger.error('Failed to save Spotify config', e);
    }
  }

  function loadSpotifyTokens() {
    try {
      if (fs.existsSync(SPOTIFY_TOKENS_PATH)) {
        const { data, plaintext } = encryptedReadJSON(SPOTIFY_TOKENS_PATH);
        spotifyTokens = data;
        logger.debug('Spotify tokens loaded from disk', { hasAccessToken: !!spotifyTokens?.access_token, expiresAt: spotifyTokens?.expires_at, now: Date.now() });
        if (plaintext && app.isReady() && safeStorage.isEncryptionAvailable()) {
          logger.log('Migrating Spotify tokens to encrypted storage', 'INFO');
          saveSpotifyTokens();
        }
        return true;
      } else {
        logger.debug('Spotify tokens file does not exist at', { path: SPOTIFY_TOKENS_PATH });
      }
    } catch (e) {
      logger.error('Failed to load Spotify tokens', e);
    }
    return false;
  }

  function saveSpotifyTokens() {
    try {
      if (spotifyTokens) {
        encryptedWriteJSON(SPOTIFY_TOKENS_PATH, spotifyTokens);
      }
    } catch (e) {
      logger.error('Failed to save Spotify tokens', e);
    }
  }

  async function refreshSpotifyToken() {
    if (refreshInFlightPromise) return refreshInFlightPromise;
    refreshInFlightPromise = doRefreshSpotifyToken().finally(() => {
      refreshInFlightPromise = null;
    });
    return refreshInFlightPromise;
  }

  async function doRefreshSpotifyToken() {
    if (!spotifyTokens?.refresh_token || !spotifyConfig.clientId) return false;
    lastRefreshAttemptTime = Date.now();
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spotifyTokens.refresh_token,
        client_id: spotifyConfig.clientId
      });
      const response = await safeFetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await response.json();
      if (data.access_token) {
        spotifyTokens.access_token = data.access_token;
        if (data.refresh_token) spotifyTokens.refresh_token = data.refresh_token;
        spotifyTokens.expires_at = Date.now() + (data.expires_in * 1000);
        saveSpotifyTokens();
        return true;
      } else {
        logger.error('Spotify token refresh API error', null, { status: response.status, data });
        if (response.status === 400 || data.error === 'invalid_grant') {
          logger.error('Spotify refresh token is invalid or revoked. Disconnecting Spotify.');
          spotifyTokens = null;
          try {
            if (fs.existsSync(SPOTIFY_TOKENS_PATH)) fs.unlinkSync(SPOTIFY_TOKENS_PATH);
          } catch (e) { }
        }
      }
    } catch (e) {
      logger.error('Spotify token refresh failed', e);
    }
    return false;
  }

  async function ensureSpotifyToken() {
    if (!spotifyTokens) {
      logger.debug('spotifyTokens is null, attempting to load from disk');
      if (!loadSpotifyTokens()) {
        logger.warn('Failed to load Spotify tokens from disk');
        return false;
      }
    }
    if (!spotifyTokens?.access_token) {
      logger.warn('Spotify token missing or invalid, attempting refresh', null);
      return await refreshSpotifyToken();
    }
    const expiresAt = spotifyTokens.expires_at;
    const now = Date.now();
    logger.debug('Checking Spotify token validity', { hasToken: !!spotifyTokens?.access_token, expiresAt, now, expiresIn: expiresAt - now });
    if (expiresAt === undefined || expiresAt === null || now >= expiresAt - 60000) {
      if (now - lastRefreshAttemptTime < REFRESH_RETRY_COOLDOWN_MS) {
        logger.debug('Spotify token refresh on cooldown, skipping', { timeSinceLastAttempt: now - lastRefreshAttemptTime, cooldownMs: REFRESH_RETRY_COOLDOWN_MS });
        return spotifyTokens?.access_token ? true : false;
      }
      logger.debug('Spotify token expired or expiring soon, refreshing');
      return await refreshSpotifyToken();
    }
    logger.debug('Spotify token is valid');
    return true;
  }

  async function fetchSpotifyProfile() {
    const data = await spotifyApiRequest('/me');
    if (data) {
      spotifyTokens.display_name = data.display_name || data.id;
      spotifyTokens.id = data.id;
      saveSpotifyTokens();
      return spotifyTokens.display_name;
    }
    return null;
  }

  async function spotifyApiRequest(endpoint, method = 'GET', body = null, retryCount = 0) {
    logger.debug('Spotify API request', { endpoint, method, retryCount });
    const ok = await ensureSpotifyToken();
    if (!ok) {
      logger.warn('Spotify API request failed - no valid token');
      return null;
    }
    try {
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${spotifyTokens.access_token}`,
          'Content-Type': 'application/json'
        }
      };
      if (body) options.body = JSON.stringify(body);
      logger.debug('About to call safeFetch', { endpoint, method });
      const response = await safeFetch(`https://api.spotify.com/v1${endpoint}`, options);
      logger.debug('safeFetch returned', { endpoint, status: response.status });

      if (response.status === 401) {
        // Cap retries — if the refreshed token still gets a 401 (e.g. a scope
        // mismatch that refreshing can never fix), retrying unconditionally with
        // the same retryCount would recurse forever and hang the app.
        if (retryCount >= 1) {
          logger.error('Spotify API still returning 401 after token refresh — giving up', null, { endpoint });
          return { _error: true, status: 401 };
        }
        logger.warn('Spotify API returned 401, attempting token refresh', { endpoint });
        if (await refreshSpotifyToken()) {
          return await spotifyApiRequest(endpoint, method, body, retryCount + 1);
        }
        return null;
      }
      if (response.status === 204) {
        logger.debug('Spotify API returned 204 No Content', { endpoint });
        return { _noContent: true };
      }
      if (response.status === 404) {
        logger.debug('Spotify API returned 404 Not Found', { endpoint });
        return { _noContent: true };
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
        // If rate limited with excessive wait time, fail immediately instead of blocking
        if (retryAfter > 60) {
          logger.warn('Spotify API rate limited with excessive retry-after, failing request', { endpoint, retryAfter });
          return { _error: true, status: 429, retryAfter };
        }
        if (retryCount < 2) {
          logger.warn('Spotify API rate limited, retrying', { endpoint, retryAfter, retryCount });
          await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1000));
          return await spotifyApiRequest(endpoint, method, body, retryCount + 1);
        }
        logger.warn('Spotify API rate limited, max retries exceeded', { endpoint, retryAfter });
        return { _error: true, status: 429, retryAfter };
      }
      if (!response.ok) {
        logger.error('Spotify API error', null, { status: response.status, endpoint, statusText: `HTTP ${response.status}` });
        return { _error: true, status: response.status };
      }
      logger.debug('Spotify API success', { endpoint, status: response.status });
      return await response.json();
    } catch (e) {
      logger.error('Spotify API request failed with exception', e, { endpoint, method });
      return null;
    }
  }

  function handleSpotifyCallback(url) {
    return new Promise((resolve, reject) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'main-launcher:' || parsed.hostname !== 'spotify-callback') {
          resolve(null);
          return;
        }
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        if (error) reject(new Error(error));
        else resolve(code);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function exchangeSpotifyCode(code, codeVerifier) {
    try {
      const response = await safeFetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: SPOTIFY_REDIRECT_URI_CUSTOM,
          client_id: spotifyConfig.clientId,
          code_verifier: codeVerifier
        }).toString()
      });

      const data = await response.json();
      if (data.access_token) {
        spotifyTokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in * 1000)
        };
        saveSpotifyTokens();
        await fetchSpotifyProfile();
        logger.success('Spotify authorized');
        return { success: true };
      } else {
        return { success: false, error: data.error_description || 'Token exchange failed' };
      }
    } catch (e) {
      logger.error('Spotify auth failed', e);
      return { success: false, error: e.message };
    }
  }

  function unregisterAllSpotifyShortcuts() {
    for (const accel of Object.values(registeredSpotifyShortcuts)) {
      globalShortcut.unregister(accel);
    }
    registeredSpotifyShortcuts = {};
  }

  async function adjustSpotifyVolume(delta) {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('spotify-volume-adjust', delta);
    }
  }

  function registerSpotifyShortcutsFromConfig(hotkeys) {
    unregisterAllSpotifyShortcuts();

    const map = {
      spotifyPlay: async () => { await spotifyApiRequest('/me/player/play', 'PUT'); },
      spotifyPause: async () => { await spotifyApiRequest('/me/player/pause', 'PUT'); },
      spotifyNext: async () => { await spotifyApiRequest('/me/player/next', 'POST'); },
      spotifyPrevious: async () => { await spotifyApiRequest('/me/player/previous', 'POST'); },
      spotifyVolumeUp: async () => { await adjustSpotifyVolume(10); },
      spotifyVolumeDown: async () => { await adjustSpotifyVolume(-10); }
    };

    for (const [key, action] of Object.entries(map)) {
      let accel = hotkeys?.[key] || SPOTIFY_SHORTCUTS[key];

      // '-' is the renderer's "unbound" sentinel (written when another binding
      // displaces this one). Registering it would hijack the bare minus key
      // system-wide, so skip it entirely.
      if (accel === '-') continue;

      if (accel && globalShortcut.register(accel, action)) {
        registeredSpotifyShortcuts[key] = accel;
        logger.log('Spotify global shortcut registered', 'INFO', { key, accelerator: accel });
      } else if (accel) {
        logger.error('Spotify global shortcut registration failed', null, { key, accelerator: accel });
      }
    }
  }

  function clearSleepTimerState() {
    if (sleepTimerHandle) clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
    sleepTimerEndsAt = null;
  }

  async function startSleepTimer(minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return { active: false, endsAt: null };
    clearSleepTimerState();
    sleepTimerEndsAt = Date.now() + mins * 60000;
    sleepTimerHandle = setTimeout(async () => {
      try {
        await spotifyApiRequest('/me/player/pause', 'PUT');
        logger.log('Sleep timer elapsed — paused Spotify playback', 'INFO');
      } catch (e) {
        logger.error('Sleep timer pause failed', e);
      }
      sleepTimerHandle = null;
      sleepTimerEndsAt = null;
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('spotify-sleep-timer-ended');
      }
    }, mins * 60000);
    logger.log('Sleep timer started', 'INFO', { minutes: mins });
    return { active: true, endsAt: sleepTimerEndsAt };
  }

  function cancelSleepTimer() {
    const wasActive = !!sleepTimerHandle;
    clearSleepTimerState();
    if (wasActive) logger.log('Sleep timer cancelled', 'INFO');
    return { active: false, endsAt: null };
  }

  function getSleepTimerStatus() {
    return { active: !!sleepTimerHandle, endsAt: sleepTimerEndsAt };
  }

  const handleShortcutRegistration = (_event, hotkeys) => {
    registerSpotifyShortcutsFromConfig(hotkeys);
  };

  ipcMain.handle('spotify-get-config', () => spotifyConfig);

  ipcMain.handle('spotify-save-config', (_event, config) => {
    spotifyConfig = { ...spotifyConfig, ...config };
    saveSpotifyConfig();
    return true;
  });

  ipcMain.handle('spotify-auth-start', async () => {
    if (!spotifyConfig.clientId) {
      return { success: false, error: 'Client ID not configured. Add it in Settings first.' };
    }
    // A double-click (or a second Connect click before the first popup paints)
    // would otherwise open two OAuth windows racing to claim the same
    // authorization code — Spotify's token endpoint rejects the second
    // exchange since a code is single-use, leaving one popup stuck open.
    if (authWindowOpen) {
      return { success: false, error: 'Spotify sign-in is already in progress' };
    }
    authWindowOpen = true;

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const scope = 'user-read-playback-state user-modify-playback-state user-read-private user-read-email';
    const authUrl = `https://accounts.spotify.com/authorize?` +
      `client_id=${encodeURIComponent(spotifyConfig.clientId)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI_CUSTOM)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&code_challenge_method=S256` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&state=${encodeURIComponent(crypto.randomBytes(16).toString('hex'))}`

    logger.log('Starting Spotify auth flow', 'INFO', { clientId: spotifyConfig.clientId?.substring(0, 8) + '...', redirectUri: SPOTIFY_REDIRECT_URI_CUSTOM });

    return new Promise((resolveOuter) => {
      let resolved = false;
      const resolve = (result) => {
        authWindowOpen = false;
        resolveOuter(result);
      };

      const authWindow = new BrowserWindow({
        width: 500,
        height: 700,
        center: true,
        show: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        parent: getMainWindow(),
        modal: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      authWindow.setMenuBarVisibility(false);

      authWindow.webContents.on('crashed', () => {
        logger.error('Spotify auth window crashed', null);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Auth window crashed' });
        }
      });

      authWindow.webContents.on('unresponsive', () => {
        logger.warn('Spotify auth window unresponsive', null);
      });

      // Intercept the redirect before it happens
      authWindow.webContents.on('will-redirect', (event, url) => {
        logger.log('Auth redirect detected', 'INFO', { url: url.substring(0, 100) });
        if (url.startsWith('main-launcher://')) {
          event.preventDefault();
          if (!resolved) {
            resolved = true;
            authWindow.close();
            handleSpotifyCallback(url).then((code) => {
              if (code) resolve(exchangeSpotifyCode(code, codeVerifier));
              else resolve({ success: false, error: 'Auth callback failed to parse code' });
            }).catch((err) => {
              logger.error('Auth callback error', err);
              resolve({ success: false, error: err.message });
            });
          }
        }
      });

      // Also catch if navigation somehow gets through
      authWindow.webContents.on('will-navigate', (event, url) => {
        logger.log('Auth navigation detected', 'INFO', { url: url.substring(0, 100) });
        if (url.startsWith('main-launcher://')) {
          event.preventDefault();
          if (!resolved) {
            resolved = true;
            authWindow.close();
            handleSpotifyCallback(url).then((code) => {
              if (code) resolve(exchangeSpotifyCode(code, codeVerifier));
              else resolve({ success: false, error: 'Auth callback failed to parse code' });
            }).catch((err) => {
              logger.error('Auth callback error', err);
              resolve({ success: false, error: err.message });
            });
          }
        }
      });

      authWindow.on('closed', () => {
        if (!resolved) {
          resolved = true;
          logger.log('Auth window closed by user', 'INFO');
          resolve({ success: false, error: 'Auth window closed' });
        }
      });

      authWindow.loadURL(authUrl).catch((err) => {
        if (!resolved) {
          resolved = true;
          logger.error('Failed to load Spotify auth URL', err);
          resolve({ success: false, error: `Failed to load auth page: ${err.message}` });
        }
      });
    });
  });

  ipcMain.handle('spotify-auth-status', () => {
    return {
      authenticated: !!spotifyTokens?.access_token,
      clientIdSet: !!spotifyConfig.clientId,
      displayName: spotifyTokens?.display_name || null
    };
  });

  ipcMain.handle('spotify-disconnect', () => {
    spotifyTokens = null;
    try {
      if (fs.existsSync(SPOTIFY_TOKENS_PATH)) fs.unlinkSync(SPOTIFY_TOKENS_PATH);
    } catch (e) { }
    logger.log('Spotify disconnected', 'INFO');
    return true;
  });

  ipcMain.handle('spotify-get-current-track', async () => {
    logger.debug('spotify-get-current-track: Checking token');
    const tokenOk = await ensureSpotifyToken();
    if (!tokenOk) {
      logger.warn('Spotify not connected - ensureSpotifyToken returned false');
      return { connected: false };
    }
    logger.debug('spotify-get-current-track: Token is valid, fetching player state');

    const data = await spotifyApiRequest('/me/player');
    if (data === null) {
      logger.warn('Spotify API returned null - treating as not connected');
      return { connected: false };
    }
    if (data._error) {
      logger.warn('Spotify API returned error - treating as not connected', { status: data.status });
      return { connected: false };
    }
    if (data._noContent) {
      return {
        connected: true,
        is_playing: false,
        track: null,
        device: null,
        volume_percent: undefined,
        playerError: false
      };
    }

    return {
      connected: true,
      is_playing: !!data.is_playing,
      // Podcast episodes (and other non-track items) have no artists/album —
      // guard those fields so one of them can't crash the whole poll.
      track: data.item ? {
        id: data.item.id,
        name: data.item.name,
        artist: (data.item.artists || []).map(a => a.name).join(', ') || data.item.show?.publisher || '',
        album: data.item.album?.name || data.item.show?.name || '',
        image: data.item.album?.images?.[0]?.url || data.item.images?.[0]?.url,
        duration_ms: data.item.duration_ms,
        progress_ms: data.progress_ms
      } : null,
      device: data.device?.name,
      volume_percent: data.device?.volume_percent
    };
  });

  ipcMain.handle('spotify-get-audio-analysis', async (_event, trackId) => {
    if (!trackId) return { ok: false, status: 400 };
    if (spotifyAnalysisCache.has(trackId)) {
      return { ok: true, data: spotifyAnalysisCache.get(trackId) };
    }
    const data = await spotifyApiRequest(`/audio-analysis/${trackId}`);
    if (data?._error) return { ok: false, status: data.status || 403 };
    if (data && !data._noContent) {
      spotifyAnalysisCache.set(trackId, data);
      return { ok: true, data };
    }
    return { ok: false, status: 404 };
  });

  ipcMain.handle('spotify-get-audio-features', async (_event, trackId) => {
    if (!trackId) return { ok: false, status: 400 };
    if (spotifyFeaturesCache.has(trackId)) {
      return { ok: true, data: spotifyFeaturesCache.get(trackId) };
    }
    const data = await spotifyApiRequest(`/audio-features/${trackId}`);
    if (data?._error) return { ok: false, status: data.status || 403 };
    if (data && !data._noContent) {
      spotifyFeaturesCache.set(trackId, data);
      return { ok: true, data };
    }
    return { ok: false, status: 404 };
  });

  ipcMain.handle('spotify-sleep-timer-start', (_event, minutes) => startSleepTimer(minutes));
  ipcMain.handle('spotify-sleep-timer-cancel', () => cancelSleepTimer());
  ipcMain.handle('spotify-sleep-timer-status', () => getSleepTimerStatus());

  ipcMain.handle('spotify-control', async (_event, action) => {
    let endpoint;
    let method = 'PUT';
    switch (action) {
      case 'play': endpoint = '/me/player/play'; break;
      case 'pause': endpoint = '/me/player/pause'; break;
      case 'next': endpoint = '/me/player/next'; method = 'POST'; break;
      case 'previous': endpoint = '/me/player/previous'; method = 'POST'; break;
      default: return { success: false, error: 'Unknown action' };
    }
    const result = await spotifyApiRequest(endpoint, method);
    // Error results come back as truthy { _error: true, ... } objects — don't
    // let those read as success.
    return { success: !!result && !result._error };
  });

  ipcMain.handle('spotify-set-volume', async (_event, volume) => {
    const result = await spotifyApiRequest(`/me/player/volume?volume_percent=${volume}`, 'PUT');
    return { success: !!result && !result._error };
  });

  ipcMain.handle('spotify-seek', async (_event, positionMs) => {
    const result = await spotifyApiRequest(`/me/player/seek?position_ms=${positionMs}`, 'PUT');
    return { success: !!result && !result._error };
  });

  ipcMain.on('spotify-register-shortcuts', handleShortcutRegistration);

  ipcMain.handle('register-spotify-shortcuts', async (event, hotkeys) => {
    handleShortcutRegistration(event, hotkeys);
    return { success: true };
  });

  loadSpotifyConfig();
  loadSpotifyTokens();
  if (spotifyConfig.clientId && spotifyTokens?.access_token) {
    logger.success('Spotify config loaded on startup', { hasClientId: !!spotifyConfig.clientId, hasToken: !!spotifyTokens?.access_token });
  }

  // Register default Spotify shortcuts until renderer sends its config
  registerSpotifyShortcutsFromConfig(SPOTIFY_SHORTCUTS);

  return {
    reapplyShortcuts: () => registerSpotifyShortcutsFromConfig(registeredSpotifyShortcuts)
  };
}

module.exports = { init };
