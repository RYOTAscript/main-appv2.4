const { ipcMain, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ── ValClips Quality mini widget ──
// A faithful port of the standalone "valclips quality" app (see
// ../../valclips-quality) into the launcher's main process. It turns a ~20s
// Valorant edit into a TikTok-optimised file that survives TikTok's re-encode:
// deep source probe → noise/motion analysis → decision engine → lossless remux
// or a VMAF-verified x264 encode with denoise / tone-map / scale / sharpen, plus
// a live before/after tune preview and a motion-hotspot compare viewer.
//
// The engine needs a full FFmpeg toolchain (ffmpeg + ffprobe + libvmaf, nlmeans,
// zscale, unsharp, hqdn3d). The launcher's bundled ffmpeg-static ships neither
// ffprobe nor libvmaf, so — exactly like the original app — this manages its own
// toolchain: it prefers a previously-installed copy under userData, then a
// capable system install on PATH, and otherwise offers a one-time download of
// the BtbN full GPL build. Everything lives under %APPDATA%/main-launcher/valclips.

const DOWNLOAD_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'];

const DEFAULT_TIKTOK_SPEC = {
  width: 1080,
  height: 1920,
  fpsHigh: 60,
  fpsLow: 30,
  fpsHighCutoff: 50,
  minSaneBitrate: 3_000_000,
  maxSaneBitrate: 100_000_000
};

const DEFAULT_SETTINGS = {
  // 'sizecap' = crush every clip to below `targetSizeMB` (2-pass, quality-max
  // within the budget). 'master' / 'smart' remain available for quality-first work.
  outputMode: 'sizecap',
  orientation: 'maintain',
  masterCrf: 12,
  vmafTarget: 97,
  // Fit-size mode: the hard output cap and the accepted input ceiling.
  targetSizeMB: 28,
  maxInputSizeMB: 500,
  loudnorm: true,
  outputFolder: null,
  filenameTemplate: '{name}_output',
  confirmOverwrite: true,
  hardwarePreview: false,
  tiktokSpec: DEFAULT_TIKTOK_SPEC
};

function init(ctx) {
  const { logger, getMainWindow, userDataPath } = ctx;

  // logger.info() doesn't exist on the launcher's Logger — shim to its .log().
  const log = {
    info: (m, meta) => logger.log(`[valclips] ${m}`, 'INFO', meta || {}),
    warn: (m, meta) => logger.warn(`[valclips] ${m}`, meta),
    error: (m, meta) => logger.error(`[valclips] ${m}`, null, meta || {}),
    success: (m, meta) => logger.success(`[valclips] ${m}`, meta || {})
  };

  const ROOT = path.join(userDataPath, 'valclips');
  const PREVIEW_DIR = path.join(os.tmpdir(), 'main-valclips-previews');
  const SETTINGS_PATH = path.join(ROOT, 'settings.json');

  function bundledDir() {
    return path.join(ROOT, 'ffmpeg', 'bin');
  }

  function send(channel, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  // ────────────────────────────────────────────────────────────────────────
  // atomic writes
  // ────────────────────────────────────────────────────────────────────────
  function tempPathFor(target) {
    return path.join(path.dirname(target), `.${path.basename(target)}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  }
  async function commitTemp(tmp, target) {
    try {
      await fs.promises.rename(tmp, target);
    } catch (err) {
      const code = err && err.code;
      if (code === 'EXDEV' || code === 'EPERM') {
        await fs.promises.copyFile(tmp, target);
        await fs.promises.unlink(tmp).catch(() => {});
      } else {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
    }
  }
  async function discardTemp(tmp) {
    if (!tmp) return;
    await fs.promises.unlink(tmp).catch(() => {});
  }
  async function atomicWriteFile(target, data) {
    const tmp = tempPathFor(target);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(tmp, data);
    await commitTemp(tmp, target);
  }

  // ────────────────────────────────────────────────────────────────────────
  // process runner (progress parsing, cancellation, log capture)
  // ────────────────────────────────────────────────────────────────────────
  function run(bin, args, opts = {}) {
    const child = spawn(bin, args, { windowsHide: true, cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let stderrBuf = '';
    let progressBuf = {};

    const promise = new Promise((resolve, reject) => {
      let timer = null;
      if (opts.timeoutMs) {
        timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (e) {} }, opts.timeoutMs);
      }
      child.stdout && child.stdout.on('data', (d) => {
        const text = d.toString('utf8');
        stdout += text;
        if (opts.onProgress) {
          for (const line of text.split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            progressBuf[key] = value;
            if (key === 'progress') { opts.onProgress(parseProgress(progressBuf, value === 'end')); progressBuf = {}; }
          }
        }
      });
      child.stderr && child.stderr.on('data', (d) => {
        const text = d.toString('utf8');
        stderr += text;
        if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024);
        if (opts.onStderrLine) {
          stderrBuf += text;
          const lines = stderrBuf.split(/\r?\n/);
          stderrBuf = lines.pop() || '';
          for (const line of lines) if (line.trim()) opts.onStderrLine(line);
        }
      });
      child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
      child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr, killed }); });
    });

    return {
      promise,
      child,
      kill: () => { killed = true; try { child.kill('SIGKILL'); } catch (e) { log.warn('kill failed', String(e)); } }
    };
  }
  function parseProgress(kv, done) {
    const num = (s) => { const n = parseFloat(s == null ? '' : s); return Number.isFinite(n) ? n : 0; };
    const outUs = num(kv['out_time_us']) || num(kv['out_time_ms']);
    return {
      frame: num(kv['frame']),
      fps: num(kv['fps']),
      bitrateKbps: num((kv['bitrate'] || '').replace('kbits/s', '')),
      outTimeMs: outUs / 1000,
      speed: num((kv['speed'] || '').replace('x', '')),
      done
    };
  }
  async function runOrThrow(bin, args, opts = {}) {
    const res = await run(bin, args, opts).promise;
    if (res.code !== 0) {
      const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
      throw new Error(`${bin.split(/[\\/]/).pop()} exited with code ${res.code}\n${tail}`);
    }
    return res;
  }

  // ────────────────────────────────────────────────────────────────────────
  // FFmpeg toolchain manager
  // ────────────────────────────────────────────────────────────────────────
  let state = { status: 'checking' };
  let ffmpegPath = '';
  let ffprobePath = '';
  let installing = false;

  function setState(s) { state = s; send('valclips:ffmpeg-state', s); }
  function getState() { return state; }
  function requireReady() {
    if (state.status !== 'ready') throw new Error('The ValClips FFmpeg engine is not ready yet — set it up in the widget first.');
    return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
  }

  async function validateBinary(bin) {
    try {
      const res = await runOrThrow(bin, ['-version'], { timeoutMs: 15000 });
      const first = (res.stdout || res.stderr).split(/\r?\n/)[0] || '';
      const m = first.match(/version\s+(\S+)/);
      if (!m) return { ok: false, version: '', detail: `Unexpected -version output: ${first}` };
      return { ok: true, version: m[1], detail: '' };
    } catch (err) {
      return { ok: false, version: '', detail: String(err && err.message ? err.message : err) };
    }
  }
  async function detectCapabilities(ffmpeg) {
    const caps = { libx264: false, libvmaf: false, nlmeans: false, hqdn3d: false, zscale: false, unsharp: false };
    try {
      const enc = await runOrThrow(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
      caps.libx264 = /\blibx264\b/.test(enc.stdout);
      const flt = await runOrThrow(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15000 });
      caps.libvmaf = /\blibvmaf\b/.test(flt.stdout);
      caps.nlmeans = /\bnlmeans\b/.test(flt.stdout);
      caps.hqdn3d = /\bhqdn3d\b/.test(flt.stdout);
      caps.zscale = /\bzscale\b/.test(flt.stdout);
      caps.unsharp = /\bunsharp\b/.test(flt.stdout);
    } catch (err) {
      log.warn('capability detection failed', String(err));
    }
    return caps;
  }
  function capsSufficient(c) {
    return c.libx264 && c.libvmaf && c.hqdn3d && c.zscale && c.unsharp && c.nlmeans;
  }
  function findOnPath(name) {
    try {
      const res = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (res.status === 0) {
        const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        return first || null;
      }
    } catch (err) { log.warn('where.exe lookup failed', String(err)); }
    return null;
  }
  async function tryCandidate(ffmpeg, ffprobe, source) {
    if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return { ok: false, detail: 'not found' };
    const v1 = await validateBinary(ffmpeg);
    if (!v1.ok) return { ok: false, detail: `ffmpeg found but not working: ${v1.detail}` };
    const v2 = await validateBinary(ffprobe);
    if (!v2.ok) return { ok: false, detail: `ffprobe found but not working: ${v2.detail}` };
    const caps = await detectCapabilities(ffmpeg);
    if (!capsSufficient(caps)) {
      return { ok: false, detail: `build is missing required components (libx264:${caps.libx264} libvmaf:${caps.libvmaf} nlmeans:${caps.nlmeans})` };
    }
    ffmpegPath = ffmpeg;
    ffprobePath = ffprobe;
    return { ok: true, state: { status: 'ready', source, ffmpegPath: ffmpeg, ffprobePath: ffprobe, version: v1.version, capabilities: caps } };
  }

  async function ensureToolchain() {
    setState({ status: 'checking' });
    const bundled = await tryCandidate(path.join(bundledDir(), 'ffmpeg.exe'), path.join(bundledDir(), 'ffprobe.exe'), 'bundled');
    if (bundled.ok) { log.info('using bundled ffmpeg', { dir: bundledDir() }); setState(bundled.state); return bundled.state; }
    if (bundled.detail !== 'not found') log.warn('bundled ffmpeg invalid, will offer re-download', { detail: bundled.detail });

    const sysFfmpeg = findOnPath('ffmpeg');
    const sysFfprobe = findOnPath('ffprobe');
    if (sysFfmpeg && sysFfprobe) {
      const sys = await tryCandidate(sysFfmpeg, sysFfprobe, 'system');
      if (sys.ok) { log.info('using system ffmpeg', { path: sysFfmpeg }); setState(sys.state); return sys.state; }
      log.warn('system ffmpeg unusable', { detail: sys.detail });
      if (bundled.detail === 'not found') { const s = { status: 'broken', detail: sys.detail }; setState(s); return s; }
    }
    const s = bundled.detail !== 'not found' ? { status: 'broken', detail: bundled.detail } : { status: 'missing' };
    setState(s);
    return s;
  }

  function download(url, dest, onBytes, depth = 0) {
    return new Promise((resolve, reject) => {
      if (depth > 6) return reject(new Error('Too many redirects downloading FFmpeg'));
      const req = https.get(url, { headers: { 'User-Agent': 'main-launcher-valclips' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, onBytes, depth + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed: HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const hash = crypto.createHash('sha256');
        const file = fs.createWriteStream(dest);
        let received = 0;
        res.on('data', (chunk) => { received += chunk.length; hash.update(chunk); onBytes(received, total); });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(hash.digest('hex'))));
        file.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
    });
  }
  function findFileRecursive(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findFileRecursive(p, name); if (found) return found; }
      else if (entry.name.toLowerCase() === name) return p;
    }
    return null;
  }
  async function setupToolchain() {
    if (installing) return state;
    installing = true;
    const root = path.join(ROOT, 'ffmpeg');
    const zipTmp = tempPathFor(path.join(root, 'ffmpeg-download.zip'));
    const extractDir = path.join(root, 'extract-tmp');
    try {
      await fs.promises.mkdir(root, { recursive: true });
      setState({ status: 'installing', phase: 'download', receivedBytes: 0, totalBytes: 0 });
      let lastEmit = 0;
      const sha = await download(DOWNLOAD_URL, zipTmp, (recv, total) => {
        const now = Date.now();
        if (now - lastEmit > 200) { lastEmit = now; setState({ status: 'installing', phase: 'download', receivedBytes: recv, totalBytes: total }); }
      });
      log.info('ffmpeg zip downloaded', { sha256: sha });

      setState({ status: 'installing', phase: 'extract', receivedBytes: 0, totalBytes: 0 });
      await fs.promises.rm(extractDir, { recursive: true, force: true });
      await fs.promises.mkdir(extractDir, { recursive: true });
      const zipPath = zipTmp + '.zip';
      await fs.promises.rename(zipTmp, zipPath);
      await runOrThrow('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ], { timeoutMs: 300000 });
      await fs.promises.unlink(zipPath).catch(() => {});

      const foundFfmpeg = findFileRecursive(extractDir, 'ffmpeg.exe');
      const foundFfprobe = findFileRecursive(extractDir, 'ffprobe.exe');
      if (!foundFfmpeg || !foundFfprobe) throw new Error('Downloaded archive did not contain ffmpeg.exe/ffprobe.exe');

      await fs.promises.mkdir(bundledDir(), { recursive: true });
      for (const [src, name] of [[foundFfmpeg, 'ffmpeg.exe'], [foundFfprobe, 'ffprobe.exe']]) {
        const target = path.join(bundledDir(), name);
        const tmp = tempPathFor(target);
        await fs.promises.copyFile(src, tmp);
        await commitTemp(tmp, target);
      }
      await fs.promises.rm(extractDir, { recursive: true, force: true });

      setState({ status: 'installing', phase: 'validate', receivedBytes: 0, totalBytes: 0 });
      const result = await tryCandidate(path.join(bundledDir(), 'ffmpeg.exe'), path.join(bundledDir(), 'ffprobe.exe'), 'bundled');
      if (!result.ok) throw new Error(`Installed FFmpeg failed validation: ${result.detail}`);
      log.success('ffmpeg toolchain installed', result.state);
      setState(result.state);
      // A newly-ready engine can drain any clips queued while it was missing.
      pump();
      return result.state;
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      log.error('ffmpeg setup failed', { detail });
      await discardTemp(zipTmp);
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      const s = { status: 'error', detail };
      setState(s);
      return s;
    } finally {
      installing = false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // settings
  // ────────────────────────────────────────────────────────────────────────
  let cachedSettings = null;
  function getSettings() {
    if (cachedSettings) return cachedSettings;
    try {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      // A settings file written before the Fit-size feature has no targetSizeMB —
      // adopt the new size-cap default for it so existing users get the behaviour.
      const preSizeCap = parsed.targetSizeMB === undefined;
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed, tiktokSpec: { ...DEFAULT_SETTINGS.tiktokSpec, ...(parsed.tiktokSpec || {}) } };
      if (preSizeCap) cachedSettings.outputMode = 'sizecap';
    } catch (e) {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
    return cachedSettings;
  }
  async function ensureSettingsFile() {
    if (!fs.existsSync(SETTINGS_PATH)) await atomicWriteFile(SETTINGS_PATH, JSON.stringify(getSettings(), null, 2));
  }
  async function setSettings(patch) {
    const next = { ...getSettings(), ...patch };
    next.masterCrf = Math.min(16, Math.max(10, Math.round(next.masterCrf)));
    next.vmafTarget = Math.min(99, Math.max(80, next.vmafTarget));
    next.targetSizeMB = Math.min(2000, Math.max(1, Math.round(Number(next.targetSizeMB) || 28)));
    next.maxInputSizeMB = Math.min(100000, Math.max(1, Math.round(Number(next.maxInputSizeMB) || 500)));
    if (!['sizecap', 'smart', 'master'].includes(next.outputMode)) next.outputMode = 'sizecap';
    if (!['maintain', 'vertical', 'horizontal'].includes(next.orientation)) next.orientation = 'maintain';
    cachedSettings = next;
    try {
      await atomicWriteFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
    } catch (err) { log.error('failed to save settings', { err: String(err) }); throw err; }
    return next;
  }

  // ────────────────────────────────────────────────────────────────────────
  // shared pure logic — naming / formats / decision / filters / encode args
  // ────────────────────────────────────────────────────────────────────────
  function extensionOf(pathOrName) {
    const file = (pathOrName.split(/[\\/]/).pop()) || '';
    const dot = file.lastIndexOf('.');
    return dot > 0 ? file.slice(dot).toLowerCase() : '';
  }
  function isSupportedVideo(pathOrName) { return SUPPORTED_EXTENSIONS.includes(extensionOf(pathOrName)); }
  function supportedListHuman() { return SUPPORTED_EXTENSIONS.join(', '); }

  function splitPath(p) {
    const sep = p.includes('\\') ? '\\' : '/';
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return { dir: idx >= 0 ? p.slice(0, idx) : '', sep, file: idx >= 0 ? p.slice(idx + 1) : p };
  }
  function baseNameNoExt(file) { const dot = file.lastIndexOf('.'); return dot > 0 ? file.slice(0, dot) : file; }
  function stripOutputSuffix(base) { const s = base.replace(/(?:_output)+$/i, ''); return s.length > 0 ? s : base; }
  function outputPathFor(inputPath, opts = {}) {
    const { dir, sep, file } = splitPath(inputPath);
    const name = stripOutputSuffix(baseNameNoExt(file));
    const template = opts.template && opts.template.includes('{name}') ? opts.template : '{name}_output';
    let outName = template.replace('{name}', name);
    outName = outName.replace(/[<>:"/\\|?*]/g, '').trim() || `${name}_output`;
    const folder = opts.outputFolder && opts.outputFolder.trim().length > 0 ? opts.outputFolder : dir;
    const folderSep = folder.includes('\\') ? '\\' : sep;
    return folder ? folder.replace(/[\\/]+$/, '') + folderSep + outName + '.mp4' : outName + '.mp4';
  }

  const NOISE_LIGHT_THRESHOLD = 0.18;
  const NOISE_HEAVY_THRESHOLD = 0.55;
  const NOISE_HEAVY_SPATIAL_CORROBORATION = 0.45;
  const MOTION_HIGH_THRESHOLD = 0.03;
  function classifyNoise(temporal, spatial = 1) {
    if (temporal >= NOISE_HEAVY_THRESHOLD && spatial >= NOISE_HEAVY_SPATIAL_CORROBORATION) return 'heavy';
    if (temporal >= NOISE_LIGHT_THRESHOLD) return 'light';
    return 'clean';
  }
  function classifyMotion(level) { return level >= MOTION_HIGH_THRESHOLD ? 'high' : 'low'; }

  function orientedSpec(spec, orientation) {
    const short = Math.min(spec.width, spec.height);
    const long = Math.max(spec.width, spec.height);
    return orientation === 'horizontal' ? { ...spec, width: long, height: short } : { ...spec, width: short, height: long };
  }
  function evenDim(n) { return Math.max(2, Math.round(n / 2) * 2); }
  function fpsIsStandard(fps, spec) {
    const targets = [spec.fpsHigh, spec.fpsHigh * (1000 / 1001), spec.fpsLow, spec.fpsLow * (1000 / 1001)];
    return targets.some((t) => Math.abs(fps - t) < 0.05);
  }
  function remuxBlockers(analysis, spec, orientation) {
    const p = analysis.probe; const v = p.video; const blockers = [];
    if (v.codec !== 'h264') blockers.push(`codec is ${v.codec || 'unknown'}, TikTok wants H.264`);
    else if (!['High', 'Main', 'Constrained Baseline', 'Baseline'].includes(v.profile)) blockers.push(`H.264 profile "${v.profile}" is unusual`);
    if (v.pixFmt !== 'yuv420p') blockers.push(`pixel format ${v.pixFmt || 'unknown'} (need yuv420p)`);
    if (v.bitDepth > 8) blockers.push(`${v.bitDepth}-bit video (need 8-bit)`);
    if (orientation === 'maintain') {
      const shortSide = Math.min(spec.width, spec.height);
      if (Math.min(v.width, v.height) > shortSide) blockers.push(`resolution ${v.width}×${v.height} is above the ${shortSide} class — downscale is a quality win`);
    } else if (v.width !== spec.width || v.height !== spec.height) {
      blockers.push(`resolution ${v.width}×${v.height} (need ${spec.width}×${spec.height})`);
    }
    if (v.rotation !== 0) blockers.push(`rotation metadata (${v.rotation}°) must be baked in`);
    if (v.fpsMode === 'vfr') blockers.push('variable frame rate must be converted to CFR');
    if (!fpsIsStandard(v.fpsAverage, spec)) blockers.push(`${v.fpsAverage.toFixed(2)} fps is not a clean ${spec.fpsLow}/${spec.fpsHigh}`);
    if (v.isHdr) blockers.push('HDR must be tone-mapped to BT.709');
    if (v.colorSpace && !['bt709', 'unknown', 'unspecified'].includes(v.colorSpace)) blockers.push(`color space ${v.colorSpace} (need BT.709)`);
    if (analysis.noise.noiseClass !== 'clean') blockers.push(`${analysis.noise.noiseClass} grain detected — cleanup will save TikTok bitrate`);
    const vbr = v.bitrate || p.overallBitrate;
    if (vbr > 0 && vbr < spec.minSaneBitrate) blockers.push('bitrate is too low — the file is already heavily compressed');
    if (vbr > spec.maxSaneBitrate) blockers.push('bitrate is extreme — smart compression will help');
    return blockers;
  }
  function neutralFilters() {
    return { denoise: 0, denoiseFilter: 'none', tonemapHdr: false, bakeRotation: false, scale: null, fpsTarget: null, minterpolate: false, sharpen: 0, saturationBoost: 1, contrastBoost: 1 };
  }
  function decide(analysis, settings, spec) {
    const p = analysis.probe; const v = p.video; const reasons = [];
    const encode = { outputMode: settings.outputMode, crf: settings.masterCrf, vmafTarget: settings.vmafTarget, preset: 'veryslow', loudnorm: settings.loudnorm && p.audio.present };
    const orientation = settings.orientation || 'vertical';
    const blockers = remuxBlockers(analysis, spec, orientation);
    // Fit-size mode always re-encodes — a lossless stream-copy can't hit a size
    // cap, so remux is never eligible when we're crushing to a target size.
    if (settings.outputMode !== 'sizecap' && blockers.length === 0) {
      reasons.push('Source is already a perfect upload file (H.264, CFR, BT.709, clean, right size) — stream-copy remux, zero quality loss.');
      return { mode: 'remux', reasons, filters: neutralFilters(), encode };
    }
    if (settings.outputMode === 'sizecap') {
      reasons.push(`Fit-size mode → re-encoding to fit under ${settings.targetSizeMB || 28} MB (2-pass).`);
    }
    reasons.push(...blockers.map((b) => `Needs encode: ${b}`));

    let denoise = 0; let denoiseFilter = 'none';
    if (analysis.noise.noiseClass === 'light') { denoise = 30; denoiseFilter = 'hqdn3d'; reasons.push('Light noise → gentle hqdn3d so VFX/muzzle flashes stay intact.'); }
    else if (analysis.noise.noiseClass === 'heavy') { denoise = 60; denoiseFilter = 'nlmeans'; reasons.push('Heavy grain → nlmeans (high quality) tuned conservatively.'); }
    else reasons.push('Clean source → denoising off (never soften intentional VFX).');

    const rotated = v.rotation === 90 || v.rotation === 270;
    const effW = rotated ? v.height : v.width;
    const effH = rotated ? v.width : v.height;
    let scale = null;
    if (orientation === 'maintain') {
      const shortSide = Math.min(spec.width, spec.height);
      const minSide = Math.min(effW, effH);
      if (minSide > shortSide) {
        const ratio = shortSide / minSide;
        scale = { targetW: evenDim(effW * ratio), targetH: evenDim(effH * ratio), mode: 'none' };
        reasons.push(`Keeping ${effW}:${effH} aspect — downscaling to ${scale.targetW}×${scale.targetH} = supersampling, a quality win.`);
      } else reasons.push('Keeping source aspect ratio and resolution — no padding, no cropping, no upscale.');
    } else if (effW !== spec.width || effH !== spec.height) {
      const srcAspect = effW / effH; const dstAspect = spec.width / spec.height;
      const aspectMatches = Math.abs(srcAspect - dstAspect) < 0.01;
      scale = { targetW: spec.width, targetH: spec.height, mode: aspectMatches ? 'none' : 'fit-pad' };
      if (effW > spec.width && aspectMatches) reasons.push(`Downscaling ${effW}×${effH} → ${spec.width}×${spec.height} = supersampling, a quality win.`);
      else if (!aspectMatches) reasons.push(`Source aspect doesn't match ${spec.width}×${spec.height} → fit with blurred background pad (never stretch).`);
      else reasons.push(`Scaling ${effW}×${effH} → ${spec.width}×${spec.height} (lanczos).`);
    }

    const fpsTarget = v.fpsAverage >= spec.fpsHighCutoff ? spec.fpsHigh : spec.fpsLow;
    reasons.push(v.fpsMode === 'vfr' ? `VFR (${v.frameIntervalJitterMs}ms jitter) → forcing constant ${fpsTarget} fps via the fps filter.` : `Constant ${fpsTarget} fps output (source ${v.fpsAverage.toFixed(2)}).`);
    if (v.isHdr) reasons.push('HDR → BT.709 tone-map (zscale + hable).');
    if (v.rotation !== 0) reasons.push(`Baking ${v.rotation}° rotation into pixels.`);
    reasons.push('Subtle pre-sharpen + saturation/contrast lift to counter TikTok softening.');

    const filters = { denoise, denoiseFilter, tonemapHdr: v.isHdr, bakeRotation: v.rotation !== 0, scale, fpsTarget, minterpolate: false, sharpen: 0.25, saturationBoost: 1.05, contrastBoost: 1.02 };
    return { mode: 'encode', reasons, filters, encode };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function hqdn3dParams(denoise) {
    const f = Math.min(2, Math.max(0, denoise) / 50);
    const r = (x) => (Math.round(x * f * 10) / 10).toString();
    return `hqdn3d=${r(4)}:${r(3)}:${r(6)}:${r(4.5)}`;
  }
  function nlmeansParams(denoise) {
    const s = Math.round((1 + (Math.min(100, Math.max(0, denoise)) / 100) * 7) * 10) / 10;
    return `nlmeans=s=${s}:p=7:r=15`;
  }
  function denoiseFilterString(filters) {
    if (filters.denoise <= 0 || filters.denoiseFilter === 'none') return null;
    return filters.denoiseFilter === 'nlmeans' ? nlmeansParams(filters.denoise) : hqdn3dParams(filters.denoise);
  }
  const TONEMAP_CHAIN = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
  function buildVideoChain(filters, _probe, opts = {}) {
    const pre = [];
    if (filters.tonemapHdr) pre.push(TONEMAP_CHAIN);
    const dn = denoiseFilterString(filters);
    if (dn) pre.push(dn);
    if (filters.fpsTarget) {
      if (filters.minterpolate) pre.push(`minterpolate=fps=${filters.fpsTarget}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`);
      else pre.push(`fps=${filters.fpsTarget}`);
    }
    const post = [];
    if (filters.sharpen > 0) { const amt = Math.min(0.8, Math.max(0, filters.sharpen)); post.push(`unsharp=5:5:${amt.toFixed(2)}:5:5:0`); }
    if (filters.saturationBoost !== 1 || filters.contrastBoost !== 1) {
      post.push(`eq=saturation=${clamp(filters.saturationBoost, 0.5, 2).toFixed(3)}:contrast=${clamp(filters.contrastBoost, 0.5, 2).toFixed(3)}`);
    }
    post.push('format=yuv420p', 'setsar=1');
    if (opts.previewHeight) post.push(`scale=-2:${opts.previewHeight}:flags=bilinear`);
    const preStr = pre.length > 0 ? pre.join(',') : 'null';
    const postStr = post.join(',');
    if (filters.scale && filters.scale.mode === 'fit-pad') {
      const w = filters.scale.targetW; const h = filters.scale.targetH;
      const graph = `[0:v]${preStr},split=2[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h},gblur=sigma=24,eq=brightness=-0.08[bgv];[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fgv];[bgv][fgv]overlay=(W-w)/2:(H-h)/2,${postStr}[vout]`;
      return { graph, outLabel: 'vout' };
    }
    const parts = [preStr];
    if (filters.scale && filters.scale.mode === 'none') parts.push(`scale=${filters.scale.targetW}:${filters.scale.targetH}:flags=lanczos`);
    else if (filters.scale && filters.scale.mode === 'fill-crop') parts.push(`scale=${filters.scale.targetW}:${filters.scale.targetH}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${filters.scale.targetW}:${filters.scale.targetH}`);
    parts.push(postStr);
    return { graph: `[0:v]${parts.join(',')}[vout]`, outLabel: 'vout' };
  }
  function applyOverrides(plan, overrides) {
    if (!overrides) return plan;
    const filters = { ...plan.filters, ...overrides };
    if (filters.denoise > 0 && filters.denoiseFilter === 'none') filters.denoiseFilter = 'hqdn3d';
    if (filters.denoise <= 0) filters.denoiseFilter = 'none';
    return { ...plan, filters };
  }

  const X264_HIGH_MOTION_PARAMS = [
    'ref=6', 'bframes=5', 'b-adapt=2', 'me=umh', 'subme=10', 'merange=32', 'rc-lookahead=60',
    'aq-mode=3', 'aq-strength=1.0', 'psy-rd=1.0,0.15', 'deblock=-1,-1',
    // Chroma boost: spend ~2 QP steps more on colour than luma. TikTok crushes
    // chroma hardest, so this protects saturated Valorant VFX (ability reds/blues,
    // muzzle glow) that would otherwise smear after its re-encode.
    'chroma-qp-offset=-2',
    'keyint=120', 'min-keyint=60',
    'colorprim=bt709', 'transfer=bt709', 'colormatrix=bt709'
  ].join(':');
  function audioFilterString(loudnorm) {
    const sync = 'aresample=async=1:first_pts=0';
    if (!loudnorm) return sync;
    return sync + `,loudnorm=I=-14:TP=-1:LRA=11:measured_I=${loudnorm.input_i}:measured_TP=${loudnorm.input_tp}:measured_LRA=${loudnorm.input_lra}:measured_thresh=${loudnorm.input_thresh}:offset=${loudnorm.target_offset}:linear=true`;
  }
  function buildEncodeArgs(o) {
    const args = ['-hide_banner', '-y', '-i', o.inputPath];
    if (o.filterGraph) args.push('-filter_complex', o.filterGraph, '-map', '[vout]');
    else args.push('-map', '0:v:0');
    args.push('-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p', '-x264-params', X264_HIGH_MOTION_PARAMS, '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
    if (o.hasAudio) args.push('-map', '0:a:0', '-af', audioFilterString(o.loudnorm), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2');
    else args.push('-an');
    args.push('-movflags', '+faststart', '-progress', 'pipe:1', o.outputPath);
    return args;
  }
  const SMART_CRF_START = 18, SMART_CRF_MIN = 10, SMART_CRF_MAX = 28, SMART_MAX_ATTEMPTS = 4;
  function nextCrf(tried, target) {
    if (tried.length === 0) return SMART_CRF_START;
    if (tried.length >= SMART_MAX_ATTEMPTS) return null;
    const passing = tried.filter((t) => t.vmaf >= target).map((t) => t.crf);
    const failing = tried.filter((t) => t.vmaf < target).map((t) => t.crf);
    const lo = passing.length > 0 ? Math.max(...passing) : SMART_CRF_MIN - 1;
    const hi = failing.length > 0 ? Math.min(...failing) : SMART_CRF_MAX + 1;
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= lo || mid >= hi) return null;
    return mid;
  }
  function finalCrf(tried, target) {
    const passing = tried.filter((t) => t.vmaf >= target);
    if (passing.length > 0) return Math.max(...passing.map((t) => t.crf));
    return Math.min(...tried.map((t) => t.crf));
  }

  // ────────────────────────────────────────────────────────────────────────
  // probe + analyze
  // ────────────────────────────────────────────────────────────────────────
  function parseRational(s) {
    if (!s) return 0;
    const [num, den] = s.split('/').map(Number);
    if (!den) return Number.isFinite(num) ? num : 0;
    return den === 0 ? 0 : num / den;
  }
  async function probeFile(filePath) {
    const { ffprobe } = requireReady();
    const meta = await runOrThrow(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { timeoutMs: 60000 });
    let parsed;
    try { parsed = JSON.parse(meta.stdout); } catch { throw new Error('This file could not be read as a video — it may be corrupt.'); }
    const streams = parsed.streams || [];
    const v = streams.find((s) => s.codec_type === 'video');
    if (!v) throw new Error('No video stream found in this file.');
    const a = streams.find((s) => s.codec_type === 'audio');
    const format = parsed.format || {};

    let rotation = 0;
    for (const sd of v.side_data_list || []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
    if (rotation === 0 && v.tags && v.tags.rotate) rotation = parseInt(v.tags.rotate, 10) || 0;
    rotation = ((rotation % 360) + 360) % 360;

    const fpsAverage = parseRational(v.avg_frame_rate) || parseRational(v.r_frame_rate);
    const durationSec = parseFloat(format['duration'] || '') || 0;
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filePath).size; } catch { sizeBytes = parseInt(format['size'] || '0', 10) || 0; }

    const colorTransfer = v.color_transfer || '';
    const colorPrimaries = v.color_primaries || '';
    const colorSpace = v.color_space || '';
    const isHdr = colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67' || colorPrimaries === 'bt2020' || colorSpace.startsWith('bt2020');
    const pixFmt = v.pix_fmt || '';
    const bitDepth = parseInt(v.bits_per_raw_sample || '', 10) || (/p?10(le|be)?$/.test(pixFmt) ? 10 : 8);
    const { fpsMode, jitterMs } = await detectFrameRateMode(ffprobe, filePath);

    const info = {
      path: filePath,
      container: (format['format_name'] || '').split(',')[0] || '',
      durationSec, sizeBytes,
      overallBitrate: parseInt(format['bit_rate'] || '0', 10) || 0,
      video: {
        codec: v.codec_name || '', profile: v.profile || '', width: v.width || 0, height: v.height || 0,
        rotation, pixFmt, bitDepth, fpsAverage, fpsMode, frameIntervalJitterMs: jitterMs,
        colorSpace, colorTransfer, colorPrimaries, isHdr, bitrate: parseInt(v.bit_rate || '0', 10) || 0
      },
      audio: {
        present: !!a, codec: (a && a.codec_name) || '', channels: (a && a.channels) || 0,
        sampleRate: parseInt((a && a.sample_rate) || '0', 10) || 0, bitrate: parseInt((a && a.bit_rate) || '0', 10) || 0
      }
    };
    log.info('probe complete', { path: filePath, codec: info.video.codec, res: `${info.video.width}x${info.video.height}`, fps: info.video.fpsAverage, mode: info.video.fpsMode, hdr: info.video.isHdr });
    return info;
  }
  async function detectFrameRateMode(ffprobe, filePath) {
    const res = await runOrThrow(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#600', '-print_format', 'csv=p=0', filePath], { timeoutMs: 60000 });
    const times = res.stdout.split(/\r?\n/).map((l) => parseFloat(l)).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
    if (times.length < 30) return { fpsMode: 'cfr', jitterMs: 0 };
    const deltas = [];
    for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 0 && d < 1) deltas.push(d * 1000); }
    if (deltas.length < 20) return { fpsMode: 'cfr', jitterMs: 0 };
    const sorted = [...deltas].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const stddev = Math.sqrt(deltas.reduce((s, d) => s + (d - mean) * (d - mean), 0) / deltas.length);
    const vfr = median > 0 && stddev / median > 0.15;
    return { fpsMode: vfr ? 'vfr' : 'cfr', jitterMs: Math.round(stddev * 100) / 100 };
  }

  function extractMetadata(stdout, key) {
    const values = [];
    const re = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([0-9.eE+-]+)`, 'g');
    let m;
    while ((m = re.exec(stdout)) !== null) { const v = parseFloat(m[1]); if (Number.isFinite(v)) values.push(v); }
    return values;
  }
  const meanOf = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  const round4 = (n) => Math.round(n * 10000) / 10000;
  async function analyzeContent(probe) {
    const { ffmpeg } = requireReady();
    const p = probe.path;
    const noiseSeekSec = Math.max(0, probe.durationSec * 0.33).toFixed(2);
    // The three measurement passes (temporal noise, spatial noise, motion) are
    // independent read-only scans of the source, so run them concurrently rather
    // than one after another — same results, ~2-3× faster analysis on multi-core.
    const [temporalRes, spatialRes, motionRes] = await Promise.all([
      runOrThrow(ffmpeg, ['-hide_banner', '-nostats', '-ss', noiseSeekSec, '-i', p, '-map', '0:v:0', '-vf', 'tblend=all_mode=difference,bitplanenoise,metadata=print:file=-', '-frames:v', '60', '-f', 'null', 'NUL'], { timeoutMs: 180000 }),
      runOrThrow(ffmpeg, ['-hide_banner', '-nostats', '-i', p, '-map', '0:v:0', '-vf', "select='not(mod(n,15))',bitplanenoise,metadata=print:file=-", '-frames:v', '40', '-f', 'null', 'NUL'], { timeoutMs: 180000 }),
      runOrThrow(ffmpeg, ['-hide_banner', '-nostats', '-i', p, '-map', '0:v:0', '-t', '12', '-vf', 'scale=320:-2:flags=bilinear,signalstats,metadata=print:file=-', '-f', 'null', 'NUL'], { timeoutMs: 180000 })
    ]);
    const temporalValues = extractMetadata(temporalRes.stdout, 'lavfi.bitplanenoise.0.1').slice(1);
    const noiseLevel = meanOf(temporalValues);
    const spatialValues = extractMetadata(spatialRes.stdout, 'lavfi.bitplanenoise.0.1');
    const spatialNoise = meanOf(spatialValues);
    const ydifValues = extractMetadata(motionRes.stdout, 'lavfi.signalstats.YDIF');
    const motionLevel = meanOf(ydifValues) / 255;

    const noise = { noiseLevel: round4(noiseLevel), spatialNoise: round4(spatialNoise), noiseClass: classifyNoise(noiseLevel, spatialNoise), motionLevel: round4(motionLevel), motionClass: classifyMotion(motionLevel) };
    const warnings = [];
    if (probe.video.fpsMode === 'vfr') warnings.push('Variable frame rate detected — will be converted to constant FPS.');
    if (probe.video.isHdr) warnings.push('HDR source — will be tone-mapped to BT.709 for TikTok.');
    if (noise.noiseClass === 'heavy') warnings.push('Heavy grain/particle noise detected — cleanup strongly recommended.');
    if (probe.durationSec > 60) warnings.push(`Clip is ${Math.round(probe.durationSec)}s — TikTok compresses long videos harder.`);
    if (!probe.audio.present) warnings.push('No audio stream — output will be silent.');
    log.info('content analysis', { path: p, noise });
    return { probe, noise, warnings };
  }

  // ────────────────────────────────────────────────────────────────────────
  // VMAF + hotspots
  // ────────────────────────────────────────────────────────────────────────
  function cpuCount() { try { return os.cpus().length; } catch { return 4; } }
  const round2 = (n) => Math.round(n * 100) / 100;
  async function computeVmaf(distortedPath, sourcePath, opts) {
    const { ffmpeg } = requireReady();
    const logName = `vmaf-${crypto.randomBytes(4).toString('hex')}.json`;
    const logDir = os.tmpdir();
    const logPath = path.join(logDir, logName);
    const refChain = opts.sourceFilterGraph
      ? opts.sourceFilterGraph.replace('[0:v]', '[1:v]').replace('[vout]', '')
      : `[1:v]${opts.fps ? `fps=${opts.fps},` : ''}format=yuv420p,setsar=1`;
    const refLabel = 'refv';
    const graph = `${refChain}[${refLabel}];[0:v]setpts=PTS-STARTPTS[dist];[${refLabel}]setpts=PTS-STARTPTS[refs];[dist][refs]libvmaf=log_fmt=json:log_path=${logName}:feature=name=float_ssim:n_threads=${Math.max(2, Math.min(8, cpuCount()))}[vmaf]`;
    const args = ['-hide_banner', '-y', '-i', distortedPath, '-i', sourcePath, '-filter_complex', graph, '-map', '[vmaf]', '-progress', 'pipe:1', '-f', 'null', 'NUL'];
    const handle = run(ffmpeg, args, {
      cwd: logDir, timeoutMs: 3600000,
      onProgress: (pr) => { if (opts.onProgress && opts.durationSec && opts.durationSec > 0) opts.onProgress(Math.min(99, (pr.outTimeMs / 1000 / opts.durationSec) * 100)); }
    });
    if (opts.signal) opts.signal.handle = handle;
    const res = await handle.promise;
    if (opts.signal) opts.signal.handle = null;
    if (res.killed) throw new Error('cancelled');
    if (res.code !== 0) { const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-10).join('\n'); throw new Error(`Quality measurement failed:\n${tail}`); }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(logPath, 'utf8'));
      const pooled = parsed.pooled_metrics || {};
      const result = { vmaf: round2((pooled.vmaf && pooled.vmaf.mean) || 0), vmafMin: round2((pooled.vmaf && pooled.vmaf.min) || 0), ssim: round4((pooled.float_ssim && pooled.float_ssim.mean) || 0) };
      log.info('vmaf computed', { distorted: distortedPath, ...result });
      return result;
    } finally { await fs.promises.unlink(logPath).catch(() => {}); }
  }
  async function detectHotspots(sourcePath, durationSec) {
    const { ffmpeg } = requireReady();
    try {
      const res = await runOrThrow(ffmpeg, ['-hide_banner', '-nostats', '-i', sourcePath, '-map', '0:v:0', '-vf', 'scale=320:-2:flags=bilinear,signalstats,metadata=print:file=-', '-f', 'null', 'NUL'], { timeoutMs: 600000 });
      const samples = []; let currentT = -1;
      for (const line of res.stdout.split(/\r?\n/)) {
        const head = line.match(/^frame:\d+\s+pts:\S+\s+pts_time:([\d.]+)/);
        if (head) { currentT = parseFloat(head[1]); continue; }
        const ydif = line.match(/lavfi\.signalstats\.YDIF=([\d.eE+-]+)/);
        if (ydif && currentT >= 0) samples.push({ t: currentT, ydif: parseFloat(ydif[1]) });
      }
      if (samples.length === 0) return [];
      const buckets = new Map();
      for (const s of samples) { const b = Math.floor(s.t); const cur = buckets.get(b) || { sum: 0, n: 0 }; cur.sum += s.ydif; cur.n += 1; buckets.set(b, cur); }
      const scored = [...buckets.entries()].map(([sec, { sum, n }]) => ({ sec, score: sum / n })).sort((a, b) => b.score - a.score);
      const picked = [];
      for (const { sec, score } of scored) {
        if (picked.length >= 3) break;
        if (picked.some((pk) => Math.abs(pk.timeSec - sec) < 2)) continue;
        picked.push({ timeSec: Math.max(0, Math.min(sec, Math.max(0, durationSec - 2))), score: Math.round((score / 255) * 10000) / 10000 });
      }
      picked.sort((a, b) => a.timeSec - b.timeSec);
      return picked;
    } catch (err) { log.warn('hotspot detection failed', String(err)); return []; }
  }

  // ────────────────────────────────────────────────────────────────────────
  // jobs store + queue driver
  // ────────────────────────────────────────────────────────────────────────
  const jobs = [];
  let running = false;
  function listJobs() { return jobs; }
  function getJob(id) { return jobs.find((j) => j.id === id); }
  function broadcastJobs() { send('valclips:jobs', jobs); }
  function updateJob(id, patch) {
    const job = getJob(id);
    if (!job) return;
    Object.assign(job, patch);
    // Full-process timer: start the clock the moment real work begins (analysis),
    // and stamp the total elapsed once the job reaches a terminal state.
    if (patch.status) {
      if (patch.status === 'analyzing' && !job.startedAt) job.startedAt = Date.now();
      if (['done', 'error', 'cancelled'].includes(patch.status) && job.startedAt && job.elapsedMs == null) {
        job.elapsedMs = Date.now() - job.startedAt;
      }
    }
    broadcastJobs();
    return job;
  }

  function addInputs(paths, opts = {}) {
    const settings = getSettings();
    const result = { accepted: [], rejected: [], needsConfirm: [], needsSelection: [] };
    const expanded = [];
    for (const p of paths) {
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(p).filter((f) => isSupportedVideo(f)).map((f) => path.join(p, f));
          if (entries.length === 0) result.rejected.push({ path: p, reason: 'Folder contains no supported videos' });
          else if (entries.length === 1) expanded.push(entries[0]);
          else result.needsSelection.push({ folder: p, files: entries });
        } else expanded.push(p);
      } catch { result.rejected.push({ path: p, reason: 'File not found or unreadable' }); }
    }
    for (const p of expanded) {
      if (!isSupportedVideo(p)) { result.rejected.push({ path: p, reason: `Unsupported format "${extensionOf(p) || 'no extension'}" — supported: ${supportedListHuman()}` }); continue; }
      try {
        const szMB = fs.statSync(p).size / (1024 * 1024);
        if (szMB > settings.maxInputSizeMB) { result.rejected.push({ path: p, reason: `File is ${Math.round(szMB)} MB — larger than the ${settings.maxInputSizeMB} MB limit` }); continue; }
      } catch { /* stat failure handled by the isSupportedVideo/exists paths */ }
      if (jobs.some((j) => j.inputPath === p && !['done', 'error', 'cancelled'].includes(j.status))) { result.rejected.push({ path: p, reason: 'Already in the queue' }); continue; }
      const outputPath = outputPathFor(p, { template: settings.filenameTemplate, outputFolder: settings.outputFolder });
      if (settings.confirmOverwrite && !opts.overwriteConfirmed && fs.existsSync(outputPath)) { result.needsConfirm.push({ path: p, outputPath }); continue; }
      jobs.push({ id: crypto.randomBytes(6).toString('hex'), inputPath: p, fileName: path.basename(p), outputPath, status: 'queued', note: 'Queued', addedAt: Date.now(), startedAt: null, elapsedMs: null, analysis: null, plan: null, overrides: null, progress: null, result: null, error: null, logTail: [] });
      result.accepted.push(p);
      log.info('job added', { input: p, output: outputPath });
    }
    broadcastJobs();
    if (result.accepted.length > 0) pump();
    return result;
  }
  function removeJob(id) { const idx = jobs.findIndex((j) => j.id === id); if (idx >= 0) { jobs.splice(idx, 1); broadcastJobs(); } }
  function clearFinished() { for (let i = jobs.length - 1; i >= 0; i--) if (['done', 'error', 'cancelled'].includes(jobs[i].status)) jobs.splice(i, 1); broadcastJobs(); }

  async function pump() {
    if (running) return;
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) return;
    running = true;
    try {
      await runPipeline(next);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log.error('pipeline error', { job: next.id, error: msg });
      updateJob(next.id, { status: 'error', error: msg, note: 'Failed' });
    } finally {
      running = false;
      setImmediate(() => { pump(); });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // pipeline: analyze → decide → (remux | encode) → verify
  // ────────────────────────────────────────────────────────────────────────
  async function runPipeline(job) {
    if (getState().status !== 'ready') { updateJob(job.id, { note: 'Waiting for the FFmpeg engine…' }); return; }
    updateJob(job.id, { status: 'analyzing', note: 'Reading source metadata…' });
    const probe = await probeFile(job.inputPath);
    updateJob(job.id, { note: 'Measuring noise & motion…' });
    const analysis = await analyzeContent(probe);
    const settings = getSettings();
    let plan = decide(analysis, { outputMode: settings.outputMode, masterCrf: settings.masterCrf, vmafTarget: settings.vmafTarget, loudnorm: settings.loudnorm, orientation: settings.orientation, targetSizeMB: settings.targetSizeMB }, orientedSpec(settings.tiktokSpec, settings.orientation));
    if (job.overrides && Object.keys(job.overrides).length > 0) {
      plan = applyOverrides(plan, job.overrides);
      if (plan.mode === 'remux') plan = { ...plan, mode: 'encode', reasons: ['Manual tuning applied — running the full encode pipeline.', ...plan.reasons] };
    }
    updateJob(job.id, { analysis, plan });
    log.info('plan decided', { job: job.id, mode: plan.mode });
    if (plan.mode === 'remux') { await runRemux(job, plan); return; }
    await encodeJob(job, plan);
  }
  async function runRemux(job) {
    const { ffmpeg } = requireReady();
    updateJob(job.id, { status: 'processing', note: 'Source already optimal — losslessly remuxing…', progress: { stage: 'Lossless remux', percent: 50, fps: 0, bitrateKbps: 0, speed: 0, etaSec: 0 } });
    const tmp = tempPathFor(job.outputPath) + '.mp4';
    const args = ['-hide_banner', '-y', '-i', job.inputPath, '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', tmp];
    try {
      await runOrThrow(ffmpeg, args, { timeoutMs: 300000 });
      await commitTemp(tmp, job.outputPath);
      const size = fs.statSync(job.outputPath).size;
      updateJob(job.id, { status: 'done', note: 'Source already optimal — losslessly remuxed, no quality lost.', progress: null, result: { outputPath: job.outputPath, sizeBytes: size, wasRemux: true, vmaf: null, ssim: null, finalCrf: null, compressionPercent: null, ffmpegCommand: ['ffmpeg', ...args.slice(0, -1), job.outputPath].join(' '), hotspots: [] } });
    } catch (err) { await discardTemp(tmp); throw err; }
  }

  // ────────────────────────────────────────────────────────────────────────
  // encoder (master / smart) with VMAF-verified CRF search
  // ────────────────────────────────────────────────────────────────────────
  const activeHandles = new Map();
  const cancelled = new Set();
  function cancelActiveJob(id) { cancelled.add(id); const h = activeHandles.get(id); if (h) { h.kill(); return true; } return false; }
  function throwIfCancelled(job) { if (cancelled.has(job.id)) throw new CancelledError(); }
  class CancelledError extends Error { constructor() { super('cancelled'); } }

  async function measureLoudness(job) {
    const { ffmpeg } = requireReady();
    updateJob(job.id, { note: 'Measuring loudness (pass 1 of 2)…' });
    try {
      const res = await runOrThrow(ffmpeg, ['-hide_banner', '-nostats', '-i', job.inputPath, '-map', '0:a:0', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', 'NUL'], { timeoutMs: 600000 });
      const m = res.stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/g);
      if (!m) throw new Error('loudnorm did not report measurements');
      return JSON.parse(m[m.length - 1]);
    } catch (err) { log.warn('loudnorm measurement failed, encoding without normalization', String(err)); return null; }
  }
  async function encodeAttempt(job, plan, crf, loudnorm, stageLabel) {
    const { ffmpeg } = requireReady();
    const probe = job.analysis.probe;
    const { graph } = buildVideoChain(plan.filters, probe);
    const tmp = tempPathFor(job.outputPath) + '.mp4';
    const args = buildEncodeArgs({ inputPath: job.inputPath, filterGraph: graph, crf, preset: plan.encode.preset, hasAudio: probe.audio.present, loudnorm, outputPath: tmp });
    const durationMs = probe.durationSec * 1000;
    const started = Date.now();
    const handle = run(ffmpeg, args, {
      timeoutMs: 4 * 3600000,
      onProgress: (p) => {
        const percent = durationMs > 0 ? Math.min(99.5, (p.outTimeMs / durationMs) * 100) : 0;
        const elapsed = (Date.now() - started) / 1000;
        const eta = percent > 1 ? (elapsed / percent) * (100 - percent) : 0;
        updateJob(job.id, { progress: { stage: stageLabel, percent, fps: p.fps, bitrateKbps: p.bitrateKbps, speed: p.speed, etaSec: Math.round(eta), totalSec: Math.round(elapsed + eta) } });
      },
      onStderrLine: (line) => { job.logTail = [...job.logTail, line].slice(-400); }
    });
    activeHandles.set(job.id, handle);
    const res = await handle.promise;
    activeHandles.delete(job.id);
    if (res.killed || cancelled.has(job.id)) { await discardTemp(tmp); throw new CancelledError(); }
    if (res.code !== 0) { await discardTemp(tmp); const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'); throw new Error(`Encode failed (exit ${res.code}):\n${tail}`); }
    return { tmpPath: tmp, args };
  }
  async function vmafOf(job, plan, candidate, stageLabel) {
    const probe = job.analysis.probe;
    const { graph } = buildVideoChain(plan.filters, probe);
    const started = Date.now();
    return computeVmaf(candidate, job.inputPath, { sourceFilterGraph: graph, fps: plan.filters.fpsTarget, durationSec: probe.durationSec, onProgress: (percent) => {
      const elapsed = (Date.now() - started) / 1000;
      const eta = percent > 1 ? (elapsed / percent) * (100 - percent) : 0;
      updateJob(job.id, { progress: { stage: stageLabel, percent, fps: 0, bitrateKbps: 0, speed: 0, etaSec: Math.round(eta), totalSec: Math.round(elapsed + eta) } });
    } });
  }
  const fmtMB = (bytes) => `${(bytes / 1000000).toFixed(1)} MB`;
  function describePlan(plan) {
    if (plan.encode.outputMode === 'sizecap') return `Fit ≤ ${getSettings().targetSizeMB} MB (2-pass, quality-max within budget)`;
    return plan.encode.outputMode === 'master' ? `Master encode (near-lossless, CRF ${plan.encode.crf})` : `Smart Compress (searching for smallest visually-lossless file, VMAF ≥ ${plan.encode.vmafTarget})`;
  }
  function doneNote(plan, crf, vmaf, compression, outSize) {
    if (plan.encode.outputMode === 'sizecap') {
      const pieces = [`Compressed to ${fmtMB(outSize)} — under the ${getSettings().targetSizeMB} MB cap`];
      if (vmaf !== null) pieces.push(`VMAF ${vmaf.toFixed(1)}`);
      if (compression !== null && compression > 0) pieces.push(`${compression}% smaller`);
      return pieces.join(' · ');
    }
    if (plan.encode.outputMode === 'master') return `Master export finished (CRF ${crf}).`;
    const pieces = [`Smart Compress finished at CRF ${crf}`];
    if (vmaf !== null) pieces.push(`VMAF ${vmaf.toFixed(1)}`);
    if (compression !== null && compression > 0) pieces.push(`${compression}% smaller with no visible loss`);
    return pieces.join(' · ');
  }

  // ── Fit-size (2-pass ABR) encode ──
  // One 2-pass x264 run at a computed average bitrate to hit a target file size.
  // Pass 1 gathers stats (no output); pass 2 writes the file. Same filter chain +
  // high-motion tuning as the quality encoders, so it's the best-looking file that
  // still fits the budget. The caller retries at a lower bitrate if it overshoots.
  async function sizeCapEncode(job, plan, graph, videoKbps, audioKbps, loudnorm, passLog, attemptIdx) {
    const { ffmpeg } = requireReady();
    const probe = job.analysis.probe;
    const tmp = tempPathFor(job.outputPath) + '.mp4';
    const durationMs = probe.durationSec * 1000;
    const cap = getSettings().targetSizeMB;
    const common = [
      '-hide_banner', '-y', '-i', job.inputPath,
      '-filter_complex', graph, '-map', '[vout]',
      '-c:v', 'libx264', '-preset', plan.encode.preset, '-b:v', `${videoKbps}k`,
      '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
      '-x264-params', X264_HIGH_MOTION_PARAMS,
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-passlogfile', passLog
    ];
    const runPass = async (args, stageLabel) => {
      const started = Date.now();
      const handle = run(ffmpeg, args, {
        timeoutMs: 4 * 3600000,
        onProgress: (p) => {
          const percent = durationMs > 0 ? Math.min(99.5, (p.outTimeMs / durationMs) * 100) : 0;
          const elapsed = (Date.now() - started) / 1000;
          const eta = percent > 1 ? (elapsed / percent) * (100 - percent) : 0;
          updateJob(job.id, { progress: { stage: stageLabel, percent, fps: p.fps, bitrateKbps: p.bitrateKbps, speed: p.speed, etaSec: Math.round(eta), totalSec: Math.round(elapsed + eta) } });
        },
        onStderrLine: (line) => { job.logTail = [...job.logTail, line].slice(-400); }
      });
      activeHandles.set(job.id, handle);
      const res = await handle.promise;
      activeHandles.delete(job.id);
      if (res.killed || cancelled.has(job.id)) { await discardTemp(tmp); throw new CancelledError(); }
      if (res.code !== 0) { await discardTemp(tmp); const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'); throw new Error(`Encode failed (exit ${res.code}):\n${tail}`); }
    };
    const label = `Fit ≤ ${cap} MB · attempt ${attemptIdx + 1}`;
    await runPass([...common, '-pass', '1', '-an', '-progress', 'pipe:1', '-f', 'null', 'NUL'], `${label} · pass 1/2 (analysis)`);
    const audioArgs = probe.audio.present
      ? ['-map', '0:a:0', '-af', audioFilterString(loudnorm), '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ar', '48000', '-ac', '2']
      : ['-an'];
    const p2 = [...common, '-pass', '2', ...audioArgs, '-movflags', '+faststart', '-progress', 'pipe:1', tmp];
    await runPass(p2, `${label} · pass 2/2 (encode)`);
    return { tmpPath: tmp, args: p2 };
  }
  async function encodeJob(job, plan) {
    cancelled.delete(job.id);
    const temps = new Set();
    try {
      updateJob(job.id, { status: 'processing', note: describePlan(plan) });
      // Motion hotspots are computed only from the source, so kick that scan off
      // now and let it run alongside the (much longer) encode + verify instead of
      // as a dedicated pass at the end — it finishes early and is awaited for free.
      const hotspotsPromise = detectHotspots(job.inputPath, job.analysis.probe.durationSec).catch(() => []);
      const loudnorm = plan.encode.loudnorm && job.analysis.probe.audio.present ? await measureLoudness(job) : null;
      throwIfCancelled(job);
      let finalTmp, finalArgs, usedCrf, quality = null;
      if (plan.encode.outputMode === 'sizecap') {
        // ----- Fit size: 2-pass ABR aimed at a hard byte cap, retried down if over -----
        const settings = getSettings();
        const durationSec = Math.max(0.1, job.analysis.probe.durationSec);
        const capMB = settings.targetSizeMB || 28;
        // Hard cap in decimal MB so "below 28 MB" holds in both MB and MiB terms.
        const hardCapBytes = Math.round(capMB * 1000 * 1000);
        const totalKbps = (hardCapBytes * 8) / durationSec / 1000;
        // Lean audio: take only ~7% of the budget (40–128 kbps, AAC stays clean for
        // music/voice there) so the picture keeps as many bits as possible. Then aim
        // the video 5% under the remaining budget as muxing/2-pass headroom.
        const audioKbps = job.analysis.probe.audio.present ? Math.min(128, Math.max(40, Math.round(totalKbps * 0.07))) : 0;
        let videoKbps = Math.max(80, Math.round(totalKbps * 0.95) - audioKbps);
        const { graph } = buildVideoChain(plan.filters, job.analysis.probe);
        const passLog = path.join(os.tmpdir(), `main-valclips-2pass-${crypto.randomBytes(4).toString('hex')}`);
        temps.add(`${passLog}-0.log`);
        temps.add(`${passLog}-0.log.mbtree`);
        let attempt = null;
        let outBytes = 0;
        for (let i = 0; i < 3; i++) {
          throwIfCancelled(job);
          if (attempt) { await discardTemp(attempt.tmpPath); temps.delete(attempt.tmpPath); }
          attempt = await sizeCapEncode(job, plan, graph, videoKbps, audioKbps, loudnorm, passLog, i);
          temps.add(attempt.tmpPath);
          outBytes = fs.statSync(attempt.tmpPath).size;
          if (outBytes <= hardCapBytes || videoKbps <= 80) break;
          // Overshot — scale the bitrate down proportionally (with headroom) and retry.
          videoKbps = Math.max(80, Math.floor(videoKbps * (hardCapBytes / outBytes) * 0.95));
          log.warn('size cap overshot, retrying lower', { job: job.id, outBytes, hardCapBytes, nextKbps: videoKbps });
        }
        updateJob(job.id, { status: 'verifying', note: 'Measuring VMAF + SSIM vs source…' });
        try { quality = await vmafOf(job, plan, attempt.tmpPath, 'Measuring quality'); } catch (e) { quality = null; }
        finalTmp = attempt.tmpPath; finalArgs = attempt.args; usedCrf = null;
      } else if (plan.encode.outputMode === 'master') {
        usedCrf = plan.encode.crf;
        let attempt = await encodeAttempt(job, plan, usedCrf, loudnorm, `Master encode · CRF ${usedCrf}`);
        temps.add(attempt.tmpPath);
        updateJob(job.id, { status: 'verifying', note: 'Measuring VMAF + SSIM vs source…' });
        quality = await vmafOf(job, plan, attempt.tmpPath, 'Measuring quality');
        let retries = 0;
        while (quality.vmaf < plan.encode.vmafTarget && usedCrf > 10 && retries < 2) {
          retries += 1;
          const lower = Math.max(10, usedCrf - 2);
          updateJob(job.id, { status: 'processing', note: `VMAF ${quality.vmaf.toFixed(1)} below target ${plan.encode.vmafTarget} — retrying at CRF ${lower}…` });
          await discardTemp(attempt.tmpPath);
          usedCrf = lower;
          attempt = await encodeAttempt(job, plan, usedCrf, loudnorm, `Master re-encode · CRF ${usedCrf}`);
          temps.add(attempt.tmpPath);
          updateJob(job.id, { status: 'verifying', note: 'Re-measuring quality…' });
          quality = await vmafOf(job, plan, attempt.tmpPath, 'Measuring quality');
        }
        finalTmp = attempt.tmpPath; finalArgs = attempt.args;
      } else {
        const tried = [];
        let crf = SMART_CRF_START;
        while (crf !== null) {
          throwIfCancelled(job);
          const attempt = await encodeAttempt(job, plan, crf, loudnorm, `Smart Compress · trying CRF ${crf} (${tried.length + 1})`);
          temps.add(attempt.tmpPath);
          throwIfCancelled(job);
          updateJob(job.id, { status: 'verifying', note: `Verifying CRF ${crf} against VMAF ${plan.encode.vmafTarget}…` });
          const q = await vmafOf(job, plan, attempt.tmpPath, `Measuring quality · CRF ${crf}`);
          updateJob(job.id, { status: 'processing' });
          tried.push({ crf, vmaf: q.vmaf, quality: q, tmp: attempt.tmpPath, args: attempt.args });
          crf = nextCrf(tried, plan.encode.vmafTarget);
        }
        const chosen = finalCrf(tried, plan.encode.vmafTarget);
        const winner = tried.find((t) => t.crf === chosen);
        for (const t of tried) if (t.crf !== chosen) await discardTemp(t.tmp);
        finalTmp = winner.tmp; finalArgs = winner.args; usedCrf = chosen; quality = winner.quality;
      }
      throwIfCancelled(job);
      updateJob(job.id, { status: 'verifying', note: 'Finalizing…' });
      const hotspots = await hotspotsPromise; // already running since the encode began
      throwIfCancelled(job);
      await commitTemp(finalTmp, job.outputPath);
      temps.delete(finalTmp);
      const outSize = fs.statSync(job.outputPath).size;
      const srcSize = job.analysis.probe.sizeBytes;
      const compression = srcSize > 0 ? Math.round((1 - outSize / srcSize) * 100) : null;
      updateJob(job.id, { status: 'done', note: doneNote(plan, usedCrf, (quality && quality.vmaf) != null ? quality.vmaf : null, compression, outSize), progress: null, result: { outputPath: job.outputPath, sizeBytes: outSize, wasRemux: false, vmaf: quality ? quality.vmaf : null, ssim: quality ? quality.ssim : null, finalCrf: usedCrf, compressionPercent: compression, ffmpegCommand: ['ffmpeg', ...finalArgs.slice(0, -1), job.outputPath].join(' '), hotspots } });
    } catch (err) {
      if (err instanceof CancelledError) { updateJob(job.id, { status: 'cancelled', note: 'Cancelled — no partial file left behind', progress: null }); return; }
      throw err;
    } finally {
      for (const t of temps) await discardTemp(t);
      cancelled.delete(job.id);
      activeHandles.delete(job.id);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // preview + comparison (written to a temp dir, served via file:// URLs)
  // ────────────────────────────────────────────────────────────────────────
  let nvencBroken = false;
  let seq = 0;
  const inflight = new Map();
  function fileUrl(p) {
    const parts = p.replace(/\\/g, '/').split('/');
    return 'file:///' + parts.map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');
  }
  function displayEncoderArgs() {
    if (getSettings().hardwarePreview && !nvencBroken) return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '19', '-pix_fmt', 'yuv420p'];
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  }
  async function runOrThrowLocal(bin, args) {
    const res = await run(bin, args, { timeoutMs: 600000 }).promise;
    if (res.code !== 0) { const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n'); throw new Error(`Render failed:\n${tail}`); }
  }
  async function generatePreview(job, overrides) {
    if (!job.analysis || !job.plan) throw new Error('Clip has not been analyzed yet.');
    const { ffmpeg } = requireReady();
    for (const h of inflight.get(job.id) || []) h.kill();
    inflight.set(job.id, []);
    const plan = applyOverrides(job.plan, overrides);
    const dur = job.analysis.probe.durationSec;
    const start = Math.max(0, dur * 0.4 - 1).toFixed(2);
    const id = `${job.id}-${++seq}`;
    const beforeFile = path.join(PREVIEW_DIR, `${id}-before.mp4`);
    const afterFile = path.join(PREVIEW_DIR, `${id}-after.mp4`);
    const common = ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.inputPath];
    const enc = displayEncoderArgs();
    const usingNvenc = enc.includes('h264_nvenc');
    const beforeArgs = [...common, '-vf', 'scale=-2:960:flags=bilinear,setsar=1', '-an', ...enc, beforeFile];
    const { graph } = buildVideoChain(plan.filters, job.analysis.probe, { previewHeight: 960 });
    const afterArgs = [...common, '-filter_complex', graph, '-map', '[vout]', '-an', ...enc, afterFile];
    const hBefore = run(ffmpeg, beforeArgs, { timeoutMs: 300000 });
    const hAfter = run(ffmpeg, afterArgs, { timeoutMs: 300000 });
    inflight.set(job.id, [hBefore, hAfter]);
    const [rBefore, rAfter] = await Promise.all([hBefore.promise, hAfter.promise]);
    inflight.delete(job.id);
    if (rBefore.killed || rAfter.killed) throw new Error('Preview superseded');
    if (rBefore.code !== 0 || rAfter.code !== 0) {
      if (usingNvenc) { nvencBroken = true; log.warn('nvenc preview failed, falling back to libx264'); return generatePreview(job, overrides); }
      const tail = (rAfter.code !== 0 ? rAfter : rBefore).stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
      throw new Error(`Preview failed:\n${tail}`);
    }
    return { beforeUrl: fileUrl(beforeFile), afterUrl: fileUrl(afterFile) };
  }
  async function generateComparison(job, timeSec) {
    if (!job.analysis || !job.plan || !job.result) throw new Error('No finished export to compare yet.');
    const { ffmpeg } = requireReady();
    const plan = applyOverrides(job.plan, job.overrides || null);
    const fps = plan.filters.fpsTarget || (Math.round(job.analysis.probe.video.fpsAverage) || 30);
    const id = `${job.id}-cmp-${++seq}`;
    const start = Math.max(0, timeSec).toFixed(3);
    const expectedFile = path.join(PREVIEW_DIR, `${id}-expected.mp4`);
    const actualFile = path.join(PREVIEW_DIR, `${id}-actual.mp4`);
    const display = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-an'];
    const tasks = [];
    if (job.result.wasRemux) {
      tasks.push(runOrThrowLocal(ffmpeg, ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.inputPath, ...display, expectedFile]));
    } else {
      const { graph } = buildVideoChain(plan.filters, job.analysis.probe);
      tasks.push(runOrThrowLocal(ffmpeg, ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.inputPath, '-filter_complex', graph, '-map', '[vout]', ...display, expectedFile]));
    }
    tasks.push(runOrThrowLocal(ffmpeg, ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.result.outputPath, ...display, actualFile]));
    await Promise.all(tasks);
    return { expectedUrl: fileUrl(expectedFile), actualUrl: fileUrl(actualFile), fps };
  }

  // ────────────────────────────────────────────────────────────────────────
  // IPC surface
  // ────────────────────────────────────────────────────────────────────────
  function handle(channel, fn) {
    ipcMain.handle(channel, async (_event, ...args) => {
      try { return await fn(...args); }
      catch (err) { const msg = err && err.message ? err.message : String(err); log.error(`ipc ${channel} failed`, { msg }); throw new Error(msg); }
    });
  }

  handle('valclips:ffmpeg-state', () => getState());
  handle('valclips:ffmpeg-setup', () => setupToolchain());
  handle('valclips:ffmpeg-recheck', () => ensureToolchain());

  handle('valclips:files-add', (paths, overwriteConfirmed) => addInputs(paths, { overwriteConfirmed }));
  handle('valclips:files-open-dialog', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, { title: 'Choose Valorant clips', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Videos', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) }, { name: 'All files', extensions: ['*'] }] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return addInputs(res.filePaths);
  });
  handle('valclips:jobs-list', () => listJobs());
  handle('valclips:jobs-remove', (id) => removeJob(id));
  handle('valclips:jobs-clear-finished', () => clearFinished());
  handle('valclips:jobs-set-overrides', (id, overrides) => { updateJob(id, { overrides }); });
  handle('valclips:jobs-cancel', (id) => {
    const job = getJob(id);
    if (!job) return;
    if (job.status === 'queued') updateJob(id, { status: 'cancelled', note: 'Cancelled before start' });
    else cancelActiveJob(id);
  });
  handle('valclips:jobs-requeue', (id) => {
    const job = getJob(id);
    if (!job) throw new Error('Job no longer exists');
    if (['analyzing', 'processing', 'verifying'].includes(job.status)) throw new Error('Job is still running');
    updateJob(id, { status: 'queued', note: 'Re-queued with new settings', result: null, error: null, progress: null, startedAt: null, elapsedMs: null });
    pump();
  });

  handle('valclips:preview-generate', (id, overrides) => { const job = getJob(id); if (!job) throw new Error('Job no longer exists'); return generatePreview(job, overrides); });
  handle('valclips:compare-generate', (id, timeSec) => { const job = getJob(id); if (!job) throw new Error('Job no longer exists'); return generateComparison(job, timeSec); });

  handle('valclips:settings-get', () => getSettings());
  handle('valclips:settings-set', (patch) => setSettings(patch));
  handle('valclips:settings-pick-output-folder', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, { title: 'Choose output folder (cancel = next to source)', properties: ['openDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return getSettings();
    return setSettings({ outputFolder: res.filePaths[0] });
  });

  handle('valclips:show-in-folder', (p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
  handle('valclips:open-settings-file', async () => { await ensureSettingsFile(); await shell.openPath(SETTINGS_PATH); });

  // ────────────────────────────────────────────────────────────────────────
  // startup
  // ────────────────────────────────────────────────────────────────────────
  try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(PREVIEW_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  // Detect the toolchain in the background — never blocks widget/app startup.
  ensureToolchain().catch((e) => log.error('toolchain check failed', { e: String(e) }));

  return {
    teardown: () => {
      for (const h of activeHandles.values()) { try { h.kill(); } catch (e) {} }
      for (const list of inflight.values()) for (const h of list) { try { h.kill(); } catch (e) {} }
      try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  };
}

module.exports = { init };
