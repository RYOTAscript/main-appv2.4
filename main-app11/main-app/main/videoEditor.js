const { ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Video Editor mini widget ──
// A lightweight, fast trimmer built on a bundled FFmpeg (ffmpeg-static). It does
// two things well rather than being a full NLE: frame-accurate trimming and
// keeping or dropping the audio track, exporting losslessly (stream copy) where
// possible so there's no re-encode and no quality loss. A "precise" mode
// re-encodes only when the user needs an exact, frame-accurate cut that a
// keyframe-aligned copy can't give.

// ffmpeg-static returns the path to the bundled binary. In a packaged build the
// app runs from inside app.asar, but native binaries can't execute from within
// an asar archive — they're unpacked to app.asar.unpacked, so rewrite the path.
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'ts'];

// Low-resolution preview proxies live here. They're regenerated on demand and
// cleaned up on quit — they exist only to make heavy/4K clips scrub smoothly in
// the preview; every export always reads the original full-quality source.
const PROXY_DIR = path.join(os.tmpdir(), 'main-video-proxies');
const PROXY_HEIGHTS = [360, 720, 1080];

// Pulls every audio stream out of `ffmpeg -i` stderr, with language / title /
// codec / channel layout where the banner exposes them, so the UI can let the
// user pick which track to keep when a file carries more than one.
function parseAudioTracks(stderr) {
  const lines = stderr.split(/\r?\n/);
  const tracks = [];
  let aIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?:\s*Audio:\s*([A-Za-z0-9_]+)([^\n]*)/);
    if (!m) continue;
    const streamIndex = parseInt(m[1], 10);
    const language = (m[2] || '').trim();
    const codec = (m[3] || '').trim();
    const rest = m[4] || '';
    const chMatch = rest.match(/,\s*(mono|stereo|quad|5\.1(?:\(side\))?|7\.1|downmix|[0-9]+ channels)\b/);
    const channels = chMatch ? chMatch[1] : '';
    // A track's human title, if any, sits in the Metadata block just below it.
    let title = '';
    for (let j = i + 1; j < lines.length && j < i + 8; j++) {
      if (/Stream #\d+:/.test(lines[j])) break;
      const tm = lines[j].match(/^\s*title\s*:\s*(.+?)\s*$/);
      if (tm) { title = tm[1]; break; }
    }
    tracks.push({ aIndex, streamIndex, language, codec, channels, title });
    aIndex++;
  }
  return tracks;
}

function init(ctx) {
  const { logger, getMainWindow } = ctx;

  let currentExport = null; // the in-flight ffmpeg export child process, if any
  let currentProxy = null;  // the in-flight ffmpeg proxy-build child process, if any
  let currentAsset = null;  // the in-flight ffmpeg timeline-asset child process, if any

  function ffmpegAvailable() {
    return !!ffmpegPath && fs.existsSync(ffmpegPath);
  }

  // Parses metadata out of `ffmpeg -i <file>` stderr (ffmpeg-static ships no
  // ffprobe, and ffmpeg's -i banner carries everything we need: duration,
  // resolution, frame rate, and whether an audio stream exists).
  function probe(inputPath) {
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath]);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => {
        logger.error('ffmpeg probe spawn failed', e);
        resolve(null);
      });
      child.on('close', () => {
        try {
          const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
          let durationMs = 0;
          if (durMatch) {
            durationMs = (parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])) * 1000;
          }
          const videoMatch = stderr.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:.*?(\d{2,5})x(\d{2,5})/);
          const width = videoMatch ? parseInt(videoMatch[1], 10) : null;
          const height = videoMatch ? parseInt(videoMatch[2], 10) : null;
          const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
          const fps = fpsMatch ? parseFloat(fpsMatch[1]) : null;
          const audioTracks = parseAudioTracks(stderr);
          const hasAudio = audioTracks.length > 0;
          let sizeBytes = 0;
          try { sizeBytes = fs.statSync(inputPath).size; } catch (e) { /* ignore */ }

          if (!durationMs) {
            resolve(null);
            return;
          }
          resolve({ durationMs: Math.round(durationMs), width, height, fps, hasAudio, audioTracks, sizeBytes });
        } catch (e) {
          logger.error('ffmpeg probe parse failed', e);
          resolve(null);
        }
      });
    });
  }

  function sendProgress(payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('video-export-progress', payload);
  }

  function sendProxyProgress(payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('video-proxy-progress', payload);
  }

  // A proxy is uniquely identified by the source path + its size + mtime + the
  // target height, so an edited/replaced file never reuses a stale preview.
  function proxyPathFor(inputPath, height) {
    let stat;
    try { stat = fs.statSync(inputPath); } catch (e) { stat = { size: 0, mtimeMs: 0 }; }
    const key = crypto.createHash('md5')
      .update(`${path.resolve(inputPath)}|${stat.size}|${Math.round(stat.mtimeMs)}|${height}`)
      .digest('hex').slice(0, 16);
    return path.join(PROXY_DIR, `proxy-${height}p-${key}.mp4`);
  }

  ipcMain.handle('video-check', () => ({ available: ffmpegAvailable() }));

  // Builds (or returns a cached) low-res H.264 proxy for smooth preview playback.
  // Fast, throwaway quality (ultrafast/CRF 30) — it's only ever shown in the
  // small preview, never exported.
  ipcMain.handle('video-make-proxy', async (_event, opts) => {
    if (!ffmpegAvailable()) return { ok: false, error: 'FFmpeg is unavailable' };
    const inputPath = opts?.inputPath;
    const height = Math.round(Number(opts?.height) || 0);
    if (!inputPath || !fs.existsSync(inputPath)) return { ok: false, error: 'Source video not found' };
    if (!PROXY_HEIGHTS.includes(height)) return { ok: false, error: 'Unsupported preview quality' };

    const outPath = proxyPathFor(inputPath, height);
    try {
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        return { ok: true, path: outPath, cached: true };
      }
    } catch (e) { /* fall through and rebuild */ }

    // Only one proxy build at a time — a new request supersedes the old one.
    if (currentProxy) { try { currentProxy.kill('SIGKILL'); } catch (e) { /* ignore */ } currentProxy = null; }
    try { fs.mkdirSync(PROXY_DIR, { recursive: true }); } catch (e) { /* ignore */ }

    const durationSec = (Number(opts?.durationMs) || 0) / 1000;
    // scale=-2 keeps the aspect ratio and forces an even width (H.264 requires it).
    const args = [
      '-y', '-i', inputPath,
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', outPath
    ];
    logger.log('Video proxy build started', 'INFO', { inputPath, height });

    return new Promise((resolve) => {
      let settled = false;
      let stderrTail = '';
      const child = spawn(ffmpegPath, args);
      currentProxy = child;

      child.stdout.on('data', (d) => {
        const m = d.toString().match(/out_time_us=(\d+)/);
        if (m && durationSec > 0) {
          const pct = Math.max(0, Math.min(100, (parseInt(m[1], 10) / 1e6 / durationSec) * 100));
          sendProxyProgress({ percent: pct });
        }
      });
      child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        currentProxy = null;
        logger.error('Video proxy spawn failed', e);
        resolve({ ok: false, error: e.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        const wasCancelled = child.killed;
        currentProxy = null;
        if (wasCancelled) {
          try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
          resolve({ ok: false, cancelled: true });
          return;
        }
        if (code === 0) {
          sendProxyProgress({ percent: 100 });
          logger.success('Video proxy built', { outPath, height });
          resolve({ ok: true, path: outPath });
        } else {
          try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
          logger.error('Video proxy build failed', null, { code, stderrTail });
          resolve({ ok: false, error: 'Could not build the preview' });
        }
      });
    });
  });

  ipcMain.handle('video-cancel-proxy', () => {
    if (currentProxy) {
      try { currentProxy.kill('SIGKILL'); } catch (e) { /* ignore */ }
      return { ok: true };
    }
    return { ok: false };
  });

  // ── Vegas-style timeline assets: a video filmstrip + one waveform image per
  // audio track, rendered by FFmpeg and cached alongside the proxies. They're
  // purely visual (shown in the track lanes under the trim bar). ──
  function assetKeyPath(inputPath, name) {
    let stat;
    try { stat = fs.statSync(inputPath); } catch (e) { stat = { size: 0, mtimeMs: 0 }; }
    const key = crypto.createHash('md5')
      .update(`${path.resolve(inputPath)}|${stat.size}|${Math.round(stat.mtimeMs)}|${name}`)
      .digest('hex').slice(0, 16);
    return path.join(PROXY_DIR, `${name}-${key}.png`);
  }
  function fileReady(p) {
    try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (e) { return false; }
  }
  function runFfmpegImage(args) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(ffmpegPath, args); } catch (e) { resolve(false); return; }
      currentAsset = child;
      child.stderr.on('data', () => {}); // drain
      child.on('error', () => { currentAsset = null; resolve(false); });
      child.on('close', (code) => { currentAsset = null; resolve(code === 0); });
    });
  }

  ipcMain.handle('video-timeline-assets', async (_event, opts) => {
    if (!ffmpegAvailable()) return { ok: false, error: 'FFmpeg is unavailable' };
    const inputPath = opts?.inputPath;
    if (!inputPath || !fs.existsSync(inputPath)) return { ok: false, error: 'Source video not found' };
    const audioIndices = Array.isArray(opts?.audioIndices) ? opts.audioIndices : [];
    const durationSec = Math.max(0.1, (Number(opts?.durationMs) || 0) / 1000);
    const WAVE_W = 1000, WAVE_H = 48, FILM_H = 44, COLS = 12;

    try { fs.mkdirSync(PROXY_DIR, { recursive: true }); } catch (e) { /* ignore */ }

    // Video filmstrip (non-fatal — the video lane still shows without it).
    let filmstrip = null;
    const filmOut = assetKeyPath(inputPath, `film-${COLS}x${FILM_H}`);
    if (fileReady(filmOut)) {
      filmstrip = filmOut;
    } else {
      const ok = await runFfmpegImage([
        '-y', '-i', inputPath, '-frames:v', '1', '-update', '1',
        '-vf', `fps=${COLS / durationSec},scale=-1:${FILM_H},tile=${COLS}x1`, filmOut
      ]);
      if (ok && fileReady(filmOut)) filmstrip = filmOut;
    }

    // One waveform image per requested audio track.
    const waveforms = [];
    for (const aIndex of audioIndices) {
      if (!Number.isInteger(aIndex)) continue;
      const waveOut = assetKeyPath(inputPath, `wave-a${aIndex}-${WAVE_W}x${WAVE_H}`);
      if (fileReady(waveOut)) { waveforms.push({ aIndex, path: waveOut }); continue; }
      const ok = await runFfmpegImage([
        '-y', '-i', inputPath, '-frames:v', '1', '-update', '1',
        '-filter_complex', `[0:a:${aIndex}]aformat=channel_layouts=mono,showwavespic=s=${WAVE_W}x${WAVE_H}:colors=#8ab4f8`,
        waveOut
      ]);
      if (ok && fileReady(waveOut)) waveforms.push({ aIndex, path: waveOut });
    }

    return { ok: true, filmstrip, waveforms };
  });

  ipcMain.handle('video-pick-input', async () => {
    if (!ffmpegAvailable()) return { ok: false, error: 'FFmpeg is unavailable' };
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Import video',
      properties: ['openFile'],
      filters: [{ name: 'Video files', extensions: VIDEO_EXTENSIONS }, { name: 'All files', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const inputPath = result.filePaths[0];
    const meta = await probe(inputPath);
    if (!meta) return { ok: false, error: 'Could not read this video' };
    logger.log('Video imported', 'INFO', { inputPath, durationMs: meta.durationMs });
    return { ok: true, path: inputPath, name: path.basename(inputPath), ...meta };
  });

  ipcMain.handle('video-pick-output', async (_event, defaultPath) => {
    const win = getMainWindow();
    const result = await dialog.showSaveDialog(win, {
      title: 'Export trimmed video',
      defaultPath: defaultPath || undefined,
      filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    return { ok: true, path: result.filePath };
  });

  // Builds the ffmpeg argument list for a trim. Lossless mode stream-copies (no
  // re-encode, no quality loss, keyframe-aligned cut); precise mode re-encodes
  // the video with a visually-lossless CRF for an exact frame boundary.
  //
  // Audio: `audioSelections` is the (ordered) list of tracks to keep, each with a
  // volume multiplier (1 = unchanged). Every selected track is muxed into the
  // output as its own stream. When every kept track is at 100% and we're not
  // re-encoding, audio is stream-copied losslessly; if any track's volume differs
  // from 100% (or precise mode is on), the selected tracks are re-encoded to AAC
  // with a per-stream `volume` filter. No selections (or keepAudio off) => -an.
  function buildArgs({ inputPath, startSec, durationSec, keepAudio, precise, outputPath, audioSelections }) {
    const args = ['-y', '-ss', String(startSec), '-i', inputPath, '-t', String(durationSec)];
    const sels = (keepAudio && Array.isArray(audioSelections)) ? audioSelections : [];
    const wantAudio = sels.length > 0;

    // Always map the first video stream explicitly (so we don't accidentally pull
    // in a cover-art "video" stream some containers carry) plus each kept track.
    args.push('-map', '0:v:0');
    for (const s of sels) args.push('-map', `0:a:${s.aIndex}`);

    // Video codec.
    if (precise) {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'copy');
    }

    // Audio codec / per-track volume.
    if (!wantAudio) {
      args.push('-an');
    } else {
      const anyVolumeChange = sels.some((s) => Math.abs((Number(s.volume) || 0) - 1) > 0.001);
      if (precise || anyVolumeChange) {
        args.push('-c:a', 'aac', '-b:a', '192k');
        // -filter:a:<outIndex> targets the Nth *output* audio stream, which follows
        // the order the tracks were mapped above.
        sels.forEach((s, i) => {
          const v = Number(s.volume);
          if (Number.isFinite(v) && Math.abs(v - 1) > 0.001) {
            args.push(`-filter:a:${i}`, `volume=${Math.max(0, v).toFixed(3)}`);
          }
        });
      } else {
        args.push('-c:a', 'copy');
      }
    }

    if (!precise) {
      // Avoids a leading gap/negative timestamps when copying from a non-zero cut.
      args.push('-avoid_negative_ts', 'make_zero');
    }
    args.push('-progress', 'pipe:1', '-nostats', outputPath);
    return args;
  }

  ipcMain.handle('video-export', async (_event, opts) => {
    if (!ffmpegAvailable()) return { ok: false, error: 'FFmpeg is unavailable' };
    if (currentExport) return { ok: false, error: 'An export is already running' };

    const inputPath = opts?.inputPath;
    const outputPath = opts?.outputPath;
    const startMs = Math.max(0, Number(opts?.startMs) || 0);
    const endMs = Number(opts?.endMs) || 0;
    const keepAudio = opts?.keepAudio !== false;
    const precise = !!opts?.precise;
    // Sanitise the per-track selection list: valid integer a:index, volume clamped.
    const audioSelections = Array.isArray(opts?.audioSelections)
      ? opts.audioSelections
          .filter((s) => Number.isInteger(s?.aIndex))
          .map((s) => ({ aIndex: s.aIndex, volume: Math.max(0, Math.min(4, Number(s.volume) || 1)) }))
      : [];

    if (!inputPath || !fs.existsSync(inputPath)) return { ok: false, error: 'Source video not found' };
    if (!outputPath) return { ok: false, error: 'No save location chosen' };
    if (endMs <= startMs) return { ok: false, error: 'Invalid trim range' };
    // Refuse to overwrite the source file.
    if (path.resolve(inputPath) === path.resolve(outputPath)) {
      return { ok: false, error: 'Choose a different file than the source' };
    }

    const durationSec = (endMs - startMs) / 1000;
    const startSec = startMs / 1000;
    const args = buildArgs({ inputPath, startSec, durationSec, keepAudio, precise, outputPath, audioSelections });

    logger.log('Video export started', 'INFO', { outputPath, startMs, endMs, keepAudio, precise, audioSelections });

    return new Promise((resolve) => {
      let settled = false;
      let stderrTail = '';
      const child = spawn(ffmpegPath, args);
      currentExport = child;

      child.stdout.on('data', (d) => {
        const text = d.toString();
        // -progress emits "out_time_us=..." (µs) lines; compute % of the trim length.
        const m = text.match(/out_time_us=(\d+)/);
        if (m) {
          const outUs = parseInt(m[1], 10);
          const pct = Math.max(0, Math.min(100, (outUs / 1000 / (durationSec * 1000)) * 100));
          sendProgress({ percent: pct });
        }
      });
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000);
      });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        currentExport = null;
        logger.error('Video export spawn failed', e);
        resolve({ ok: false, error: e.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        const wasCancelled = child.killed;
        currentExport = null;
        if (wasCancelled) {
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
          logger.log('Video export cancelled', 'INFO', { outputPath });
          resolve({ ok: false, cancelled: true });
          return;
        }
        if (code === 0) {
          let sizeBytes = 0;
          try { sizeBytes = fs.statSync(outputPath).size; } catch (e) { /* ignore */ }
          sendProgress({ percent: 100 });
          logger.success('Video export finished', { outputPath, sizeBytes });
          resolve({ ok: true, outputPath, sizeBytes });
        } else {
          logger.error('Video export failed', null, { code, stderrTail });
          resolve({ ok: false, error: 'Export failed — the trim range or format may be unsupported' });
        }
      });
    });
  });

  ipcMain.handle('video-cancel', () => {
    if (currentExport) {
      try { currentExport.kill('SIGKILL'); } catch (e) { /* ignore */ }
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('video-reveal', (_event, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    return { ok: true };
  });

  return {
    teardown: () => {
      if (currentExport) { try { currentExport.kill('SIGKILL'); } catch (e) { /* ignore */ } }
      if (currentProxy) { try { currentProxy.kill('SIGKILL'); } catch (e) { /* ignore */ } }
      if (currentAsset) { try { currentAsset.kill('SIGKILL'); } catch (e) { /* ignore */ } }
      // Preview proxies and timeline assets are throwaway temp files — clear on quit.
      try { fs.rmSync(PROXY_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  };
}

module.exports = { init };
