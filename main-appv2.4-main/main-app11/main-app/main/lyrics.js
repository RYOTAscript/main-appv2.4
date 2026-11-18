const { ipcMain } = require('electron');
// Uses the Electron-`net` transport so lyric fetches honour the OS certificate
// store (works behind a TLS-inspecting proxy/AV). See main/netClient.js.
const { netFetch: safeFetch } = require('./netClient');
const { BoundedCache } = require('./boundedCache');
const M = require('./lyricsMatch');

const LRCLIB_BASE = 'https://lrclib.net/api';
// A lookup that failed on the network is retried after this, not remembered
// as "no lyrics" for the rest of the session.
const RETRY_AFTER_ERROR_MS = 60 * 1000;

// LRC → [{ time, text }], with the swearing a clean transcription starred out
// put back (see main/lyricsMatch.js).
function parseSyncedLyrics(lrc) {
  return M.parseLrc(lrc).map((l) => ({ time: l.time, text: M.uncensor(l.text) }));
}

// Plain (untimed) lyrics fallback — used only when lrclib has no synced version.
function parsePlainLyrics(plain) {
  if (!plain) return [];
  return plain.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length < 200)
    .map(text => ({ time: null, text: M.uncensor(text) }));
}

function init(ctx) {
  const { logger, APP_VERSION } = ctx;

  // LRCLIB asks clients to identify themselves with a URL its operators can
  // actually reach, so they can get in touch before resorting to a block. This
  // used to point at a repository that doesn't exist — keep it a live contact.
  const LRCLIB_USER_AGENT =
    `main-launcher/${APP_VERSION} (+https://main-website-eosin-beta.vercel.app; mainappsupport@gmail.com)`;
  const lyricsCache = new BoundedCache(300);

  // { data } on an answer (null data for "nothing here"), { error } when the
  // network failed — the two must not be confused, or a dropped connection
  // gets remembered as "this song has no lyrics".
  async function lrclibRequest(pathName, params) {
    try {
      const query = new URLSearchParams(params).toString();
      const response = await safeFetch(`${LRCLIB_BASE}${pathName}?${query}`, {
        headers: { 'User-Agent': LRCLIB_USER_AGENT }
      });
      if (response.status === 404) return { data: null };
      if (!response.ok) return { error: `HTTP ${response.status}` };
      return { data: await response.json() };
    } catch (e) {
      logger.debug('LRCLIB request failed', { error: e.message, pathName });
      return { error: e.message };
    }
  }

  // Every plausible lrclib entry for the song, then the best of them
  // (lyricsMatch.pickBest): right length, timed, and not the clean version.
  async function fetchLrclibLyrics(trackName, artistName, albumName, durationMs) {
    const durationSec = durationMs ? Math.round(durationMs / 1000) : undefined;
    const want = { title: trackName, artist: artistName, album: albumName, durationSec };
    const title = M.cleanTitle(trackName) || trackName;
    const artist = M.primaryArtist(artistName) || artistName;
    const candidates = [];
    let answered = false;
    const ask = async (pathName, params) => {
      const r = await lrclibRequest(pathName, params);
      if (r.error) return;
      answered = true;
      if (Array.isArray(r.data)) candidates.push(...r.data);
      else if (r.data) candidates.push(r.data);
    };
    const good = () => {
      const best = M.pickBest(candidates, want);
      return best && best.syncedLyrics && !M.countMasked(best.syncedLyrics) ? best : null;
    };

    // 1. lrclib's own exact lookup — right most of the time on its own.
    if (durationSec) {
      await ask('/get', {
        track_name: trackName, artist_name: artistName,
        ...(albumName ? { album_name: albumName } : {}),
        duration: durationSec
      });
      if (good()) return { data: good() };
      if (title !== trackName || artist !== artistName) {
        await ask('/get', { track_name: title, artist_name: artist, duration: durationSec });
        if (good()) return { data: good() };
      }
    }
    // 2. Search: by title and artist, then by words alone. Every result is
    // scored; one that isn't this recording's length is never taken (it's a
    // cover, a remix or a different song, and would show the wrong words).
    await ask('/search', { track_name: title, artist_name: artist });
    if (!good()) await ask('/search', { q: `${artist} ${title}` });
    const best = M.pickBest(candidates, want);
    if (best) return { data: best };
    return answered ? { data: null } : { error: true };
  }

  async function getLyricsWithTimestamps(trackName, artistName, albumName, durationMs) {
    if (!trackName || !artistName) return { success: false, reason: 'missing_track_info' };

    const cacheKey = `${trackName}|${artistName}|${durationMs || ''}`;
    if (lyricsCache.has(cacheKey)) {
      return lyricsCache.get(cacheKey);
    }

    try {
      logger.debug('Fetching lyrics from lrclib.net for', { trackName, artistName });
      const found = await fetchLrclibLyrics(trackName, artistName, albumName, durationMs);
      if (found.error) {
        // Not cached as "not found": asked again after a minute.
        const result = { success: false, reason: 'network' };
        lyricsCache.set(cacheKey, result);
        const retry = setTimeout(() => { if (lyricsCache.get(cacheKey) === result) lyricsCache.delete(cacheKey); }, RETRY_AFTER_ERROR_MS);
        if (retry.unref) retry.unref();   // never what keeps the app (or a test) running
        return result;
      }
      const data = found.data;

      if (!data) {
        const result = { success: false, reason: 'lyrics_not_found' };
        lyricsCache.set(cacheKey, result);
        return result;
      }

      if (data.instrumental) {
        const result = { success: false, reason: 'instrumental' };
        lyricsCache.set(cacheKey, result);
        return result;
      }

      const synced = parseSyncedLyrics(data.syncedLyrics);
      const lines = synced.length > 0 ? synced : parsePlainLyrics(data.plainLyrics);

      if (lines.length === 0) {
        const result = { success: false, reason: 'no_valid_lines' };
        lyricsCache.set(cacheKey, result);
        return result;
      }

      const result = {
        success: true,
        synced: synced.length > 0, // true => lines carry real per-line timestamps
        lyrics: lines,
        track: {
          name: data.trackName || trackName,
          artist: data.artistName || artistName,
          album: data.albumName || albumName || '',
          cover_url: null
        }
      };

      lyricsCache.set(cacheKey, result);
      return result;
    } catch (e) {
      logger.error('getLyricsWithTimestamps failed', e);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  ipcMain.handle('get-lyrics', async (_event, trackName, artistName, albumName, durationMs) => {
    return await getLyricsWithTimestamps(trackName, artistName, albumName, durationMs);
  });

  // The corner player (main/miniPlayer.js) looks lyrics up from main and
  // shares this cache with the launcher's own player.
  return { getLyrics: getLyricsWithTimestamps };
}

module.exports = { init };
