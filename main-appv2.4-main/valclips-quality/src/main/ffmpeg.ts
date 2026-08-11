import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import type { FFmpegState, FFmpegCapabilities, FFmpegSource } from '@shared/types'
import { run, runOrThrow } from './run'
import { tempPathFor, commitTemp, discardTemp } from './atomic'
import { log } from './logger'

// FFmpeg toolchain manager.
// Order of preference:
//   1. previously installed bundled copy (userData/ffmpeg/bin) — known-good, has libvmaf
//   2. system install found on PATH — only if it actually runs AND has every
//      capability we need (libx264 + libvmaf + the denoise/scale filters)
//   3. auto-download of the BtbN full GPL build (includes libx264, libvmaf,
//      nlmeans, hqdn3d, zscale, unsharp), extracted into userData/ffmpeg
//
// A binary is never trusted by its presence alone: we always run `-version`
// and check the exit code, so a corrupt/blocked exe produces a clear
// "found but not working" state instead of failing mid-encode.

const DOWNLOAD_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'

type Listener = (s: FFmpegState) => void

let state: FFmpegState = { status: 'checking' }
let ffmpegPath = ''
let ffprobePath = ''
const listeners = new Set<Listener>()

export function onStateChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setState(s: FFmpegState): void {
  state = s
  for (const fn of listeners) fn(s)
}

export function getState(): FFmpegState {
  return state
}

export function paths(): { ffmpeg: string; ffprobe: string } {
  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
}

export function requireReady(): { ffmpeg: string; ffprobe: string } {
  if (state.status !== 'ready') throw new Error('FFmpeg is not ready yet — open Settings to set it up.')
  return paths()
}

function bundledDir(): string {
  return path.join(app.getPath('userData'), 'ffmpeg', 'bin')
}

// ---------- validation ----------

async function validateBinary(bin: string): Promise<{ ok: boolean; version: string; detail: string }> {
  try {
    const res = await runOrThrow(bin, ['-version'], { timeoutMs: 15000 })
    const first = (res.stdout || res.stderr).split(/\r?\n/)[0] ?? ''
    const m = first.match(/version\s+(\S+)/)
    if (!m) return { ok: false, version: '', detail: `Unexpected -version output: ${first}` }
    return { ok: true, version: m[1], detail: '' }
  } catch (err) {
    return { ok: false, version: '', detail: String(err instanceof Error ? err.message : err) }
  }
}

async function detectCapabilities(ffmpeg: string): Promise<FFmpegCapabilities> {
  const caps: FFmpegCapabilities = {
    libx264: false,
    libvmaf: false,
    nlmeans: false,
    hqdn3d: false,
    zscale: false,
    unsharp: false
  }
  try {
    const enc = await runOrThrow(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15000 })
    caps.libx264 = /\blibx264\b/.test(enc.stdout)
    const flt = await runOrThrow(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15000 })
    caps.libvmaf = /\blibvmaf\b/.test(flt.stdout)
    caps.nlmeans = /\bnlmeans\b/.test(flt.stdout)
    caps.hqdn3d = /\bhqdn3d\b/.test(flt.stdout)
    caps.zscale = /\bzscale\b/.test(flt.stdout)
    caps.unsharp = /\bunsharp\b/.test(flt.stdout)
  } catch (err) {
    log.warn('capability detection failed', String(err))
  }
  return caps
}

function capsSufficient(c: FFmpegCapabilities): boolean {
  return c.libx264 && c.libvmaf && c.hqdn3d && c.zscale && c.unsharp && c.nlmeans
}

function findOnPath(name: string): string | null {
  try {
    const res = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (res.status === 0) {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      return first ?? null
    }
  } catch (err) {
    log.warn('where.exe lookup failed', String(err))
  }
  return null
}

async function tryCandidate(
  ffmpeg: string,
  ffprobe: string,
  source: FFmpegSource
): Promise<{ ok: true; state: FFmpegState } | { ok: false; detail: string }> {
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return { ok: false, detail: 'not found' }
  const v1 = await validateBinary(ffmpeg)
  if (!v1.ok) return { ok: false, detail: `ffmpeg found but not working: ${v1.detail}` }
  const v2 = await validateBinary(ffprobe)
  if (!v2.ok) return { ok: false, detail: `ffprobe found but not working: ${v2.detail}` }
  const caps = await detectCapabilities(ffmpeg)
  if (!capsSufficient(caps)) {
    return {
      ok: false,
      detail: `build is missing required components (libx264:${caps.libx264} libvmaf:${caps.libvmaf} nlmeans:${caps.nlmeans})`
    }
  }
  ffmpegPath = ffmpeg
  ffprobePath = ffprobe
  return {
    ok: true,
    state: {
      status: 'ready',
      source,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      version: v1.version,
      capabilities: caps
    }
  }
}

/** Startup check: bundled copy → system PATH → report missing/broken. */
export async function ensureToolchain(): Promise<FFmpegState> {
  setState({ status: 'checking' })

  const bundled = await tryCandidate(
    path.join(bundledDir(), 'ffmpeg.exe'),
    path.join(bundledDir(), 'ffprobe.exe'),
    'bundled'
  )
  if (bundled.ok) {
    log.info('using bundled ffmpeg', bundledDir())
    setState(bundled.state)
    return bundled.state
  }
  if (bundled.detail !== 'not found') {
    log.warn('bundled ffmpeg invalid, will offer re-download', bundled.detail)
  }

  const sysFfmpeg = findOnPath('ffmpeg')
  const sysFfprobe = findOnPath('ffprobe')
  if (sysFfmpeg && sysFfprobe) {
    const sys = await tryCandidate(sysFfmpeg, sysFfprobe, 'system')
    if (sys.ok) {
      log.info('using system ffmpeg', sysFfmpeg)
      setState(sys.state)
      return sys.state
    }
    log.warn('system ffmpeg unusable', sys.detail)
    if (bundled.detail === 'not found') {
      // Real system install exists but is broken/insufficient — tell the user
      // clearly instead of failing later, and let them auto-install a good build.
      const s: FFmpegState = { status: 'broken', detail: sys.detail }
      setState(s)
      return s
    }
  }

  const s: FFmpegState =
    bundled.detail !== 'not found'
      ? { status: 'broken', detail: bundled.detail }
      : { status: 'missing' }
  setState(s)
  return s
}

// ---------- download & install ----------

function download(url: string, dest: string, onBytes: (recv: number, total: number) => void, depth = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('Too many redirects downloading FFmpeg'))
    const req = https.get(url, { headers: { 'User-Agent': 'valclips-quality' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onBytes, depth + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] ?? '0', 10)
      const hash = createHash('sha256')
      const file = fs.createWriteStream(dest)
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        hash.update(chunk)
        onBytes(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(hash.digest('hex'))))
      file.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out')))
  })
}

function findFileRecursive(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFileRecursive(p, name)
      if (found) return found
    } else if (entry.name.toLowerCase() === name) {
      return p
    }
  }
  return null
}

let installing = false

/** Download + install the bundled build. Safe to call from the UI at any time. */
export async function setupToolchain(): Promise<FFmpegState> {
  if (installing) return state
  installing = true
  const root = path.join(app.getPath('userData'), 'ffmpeg')
  const zipTmp = tempPathFor(path.join(root, 'ffmpeg-download.zip'))
  const extractDir = path.join(root, 'extract-tmp')
  try {
    await fs.promises.mkdir(root, { recursive: true })
    setState({ status: 'installing', phase: 'download', receivedBytes: 0, totalBytes: 0 })

    let lastEmit = 0
    const sha = await download(DOWNLOAD_URL, zipTmp, (recv, total) => {
      const now = Date.now()
      if (now - lastEmit > 200) {
        lastEmit = now
        setState({ status: 'installing', phase: 'download', receivedBytes: recv, totalBytes: total })
      }
    })
    log.info('ffmpeg zip downloaded', { sha256: sha })

    setState({ status: 'installing', phase: 'extract', receivedBytes: 0, totalBytes: 0 })
    await fs.promises.rm(extractDir, { recursive: true, force: true })
    await fs.promises.mkdir(extractDir, { recursive: true })
    // Expand-Archive needs a .zip extension to accept the archive
    const zipPath = zipTmp + '.zip'
    await fs.promises.rename(zipTmp, zipPath)
    await runOrThrow(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ],
      { timeoutMs: 300000 }
    )
    await fs.promises.unlink(zipPath).catch(() => {})

    const foundFfmpeg = findFileRecursive(extractDir, 'ffmpeg.exe')
    const foundFfprobe = findFileRecursive(extractDir, 'ffprobe.exe')
    if (!foundFfmpeg || !foundFfprobe) throw new Error('Downloaded archive did not contain ffmpeg.exe/ffprobe.exe')

    await fs.promises.mkdir(bundledDir(), { recursive: true })
    for (const [src, name] of [
      [foundFfmpeg, 'ffmpeg.exe'],
      [foundFfprobe, 'ffprobe.exe']
    ] as const) {
      const target = path.join(bundledDir(), name)
      const tmp = tempPathFor(target)
      await fs.promises.copyFile(src, tmp)
      await commitTemp(tmp, target)
    }
    await fs.promises.rm(extractDir, { recursive: true, force: true })

    setState({ status: 'installing', phase: 'validate', receivedBytes: 0, totalBytes: 0 })
    const result = await tryCandidate(
      path.join(bundledDir(), 'ffmpeg.exe'),
      path.join(bundledDir(), 'ffprobe.exe'),
      'bundled'
    )
    if (!result.ok) throw new Error(`Installed FFmpeg failed validation: ${result.detail}`)
    log.info('ffmpeg toolchain installed', result.state)
    setState(result.state)
    return result.state
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.error('ffmpeg setup failed', detail)
    await discardTemp(zipTmp)
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {})
    const s: FFmpegState = { status: 'error', detail }
    setState(s)
    return s
  } finally {
    installing = false
  }
}

export { run as runProcess }
