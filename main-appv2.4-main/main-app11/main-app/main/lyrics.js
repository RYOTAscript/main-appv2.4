const { ipcMain } = require('electron');
const { safeFetch } = require('./httpClient');
const { BoundedCache } = require('./boundedCache');

const LRCLIB_BASE = 'https://lrclib.net/api';

// Parses an LRC string ("[mm:ss.xx] line text\n...") into
// [{ time: <ms>, text: <string> }, ...] sorted by time.
function parseSyncedLyrics(lrc) {
  if (!lrc) return [];
  const lineRe = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)/;
  const lines = [];
  for (const rawLine of lrc.split('\n')) {
    const match = rawLine.match(lineRe);
    if (!match) continue;
    const minutes = parseInt(match[1], 10);
    const seconds = parseFloat(match[2]);
    const text = match[3].trim();
    if (!text) continue; // skip blank/instrumental-gap markers
    lines.push({ time: Math.round((minutes * 60 + seconds) * 1000), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Plain (untimed) lyrics fallback — used only when lrclib has no synced version.
function parsePlainLyrics(plain) {
  if (!plain) return [];
  return plain.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length < 200)
    .map(text => ({ time: null, text }));
}

function init(ctx) {
  const { logger, APP_VERSION } = ctx;

  const LRCLIB_USER_AGENT = `Launcher/${APP_VERSION} (https://github.com/ryota/launcher)`;
  const lyricsCache = new BoundedCache(300);

  async function lrclibRequest(pathName, params) {
    try {
      const query = new URLSearchParams(params).toString();
      const response = await safeFetch(`${LRCLIB_BASE}${pathName}?${query}`, {
        headers: { 'User-Agent': LRCLIB_USER_AGENT }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      logger.debug('LRCLIB request failed', { error: e.message, pathName });
      return null;
    }
  }

  async function fetchLrclibLyrics(trackName, artistName, albumName, durationMs) {
    const durationSec = durationMs ? Math.round(durationMs / 1000) : undefined;

    // 1. Exact match — most reliable, lrclib matches duration within ±2s.
    if (durationSec) {
      const exact = await lrclibRequest('/get', {
        track_name: trackName,
        artist_name: artistName,
        ...(albumName ? { album_name: albumName } : {}),
        duration: durationSec
      });
      if (exact && (exact.syncedLyrics || exact.plainLyrics)) return exact;
    }

    // 2. Fuzzy search fallback. Only accept a result whose duration actually matches
    // the real track — otherwise it's very likely a cover, remix, or different song
    // with a similar title, which would show completely wrong ("random") lyrics
    // instead of correctly reporting that no lyrics were found.
    const results = await lrclibRequest('/search', {
      track_name: trackName,
      artist_name: artistName
    });
    if (Array.isArray(results) && results.length > 0) {
      if (durationSec) {
        const closeMatches = results.filter(r => Math.abs((r.duration || 0) - durationSec) <= 3);
        if (closeMatches.length === 0) return null; // no real match — report "not found", don't guess
        return closeMatches.find(r => r.syncedLyrics) || closeMatches[0];
      }
      // No track duration to verify against (rare) — best effort, take the top hit.
      return results.find(r => r.syncedLyrics) || results[0];
    }
    return null;
  }

  async function getLyricsWithTimestamps(trackName, artistName, albumName, durationMs) {
    if (!trackName || !artistName) return { success: false, reason: 'missing_track_info' };

    const cacheKey = `${trackName}|${artistName}|${durationMs || ''}`;
    if (lyricsCache.has(cacheKey)) {
      return lyricsCache.get(cacheKey);
    }

    try {
      logger.debug('Fetching lyrics from lrclib.net for', { trackName, artistName });
      const data = await fetchLrclibLyrics(trackName, artistName, albumName, durationMs);

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
}

module.exports = { init };
