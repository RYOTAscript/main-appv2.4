const { ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function init(ctx) {
  const { logger, getMainWindow } = ctx;

  let currentExport = null; // the in-flight ffmpeg child process, if any

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
          const hasAudio = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:/.test(stderr);
          let sizeBytes = 0;
          try { sizeBytes = fs.statSync(inputPath).size; } catch (e) { /* ignore */ }

          if (!durationMs) {
            resolve(null);
            return;
          }
          resolve({ durationMs: Math.round(durationMs), width, height, fps, hasAudio, sizeBytes });
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

  ipcMain.handle('video-check', () => ({ available: ffmpegAvailable() }));

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
  // the video with a visually-lossless CRF for an exact frame boundary. Audio is
  // copied when kept (or re-encoded to AAC in precise mode) and dropped with -an.
  function buildArgs({ inputPath, startSec, durationSec, keepAudio, precise, outputPath }) {
    const args = ['-y', '-ss', String(startSec), '-i', inputPath, '-t', String(durationSec)];
    if (precise) {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
      if (keepAudio) args.push('-c:a', 'aac', '-b:a', '192k');
      else args.push('-an');
    } else {
      args.push('-c', 'copy');
      if (!keepAudio) args.push('-an');
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

    if (!inputPath || !fs.existsSync(inputPath)) return { ok: false, error: 'Source video not found' };
    if (!outputPath) return { ok: false, error: 'No save location chosen' };
    if (endMs <= startMs) return { ok: false, error: 'Invalid trim range' };
    // Refuse to overwrite the source file.
    if (path.resolve(inputPath) === path.resolve(outputPath)) {
      return { ok: false, error: 'Choose a different file than the source' };
    }

    const durationSec = (endMs - startMs) / 1000;
    const startSec = startMs / 1000;
    const args = buildArgs({ inputPath, startSec, durationSec, keepAudio, precise, outputPath });

    logger.log('Video export started', 'INFO', { outputPath, startMs, endMs, keepAudio, precise });

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
    teardown: () => { if (currentExport) { try { currentExport.kill('SIGKILL'); } catch (e) { /* ignore */ } } }
  };
}

module.exports = { init };
