import { spawn, ChildProcess } from 'child_process'
import { log } from './logger'

// Central process runner. Every FFmpeg/FFprobe invocation in the app goes through
// here so progress parsing, cancellation and log capture behave identically everywhere.

export interface RunOptions {
  onStderrLine?: (line: string) => void
  /** parsed key=value blocks from `-progress pipe:1` */
  onProgress?: (p: FFmpegRawProgress) => void
  timeoutMs?: number
  /** working directory — lets filters use relative paths (Windows path escaping in filtergraphs is a minefield) */
  cwd?: string
}

export interface FFmpegRawProgress {
  frame: number
  fps: number
  bitrateKbps: number
  outTimeMs: number
  speed: number
  done: boolean
}

export interface RunHandle {
  promise: Promise<RunResult>
  kill: () => void
  child: ChildProcess
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  killed: boolean
}

export function run(bin: string, args: string[], opts: RunOptions = {}): RunHandle {
  const child = spawn(bin, args, { windowsHide: true, cwd: opts.cwd })
  let stdout = ''
  let stderr = ''
  let killed = false
  let stderrBuf = ''
  let progressBuf: Record<string, string> = {}

  const promise = new Promise<RunResult>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, opts.timeoutMs)
    }

    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stdout += text
      if (opts.onProgress) {
        // -progress pipe:1 emits key=value lines terminated by progress=continue/end
        for (const line of text.split(/\r?\n/)) {
          const eq = line.indexOf('=')
          if (eq <= 0) continue
          const key = line.slice(0, eq).trim()
          const value = line.slice(eq + 1).trim()
          progressBuf[key] = value
          if (key === 'progress') {
            opts.onProgress(parseProgress(progressBuf, value === 'end'))
            progressBuf = {}
          }
        }
      }
    })

    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stderr += text
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024)
      if (opts.onStderrLine) {
        stderrBuf += text
        const lines = stderrBuf.split(/\r?\n/)
        stderrBuf = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) opts.onStderrLine(line)
      }
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, killed })
    })
  })

  return {
    promise,
    child,
    kill: () => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch (err) {
        log.warn('kill failed', String(err))
      }
    }
  }
}

function parseProgress(kv: Record<string, string>, done: boolean): FFmpegRawProgress {
  const num = (s: string | undefined): number => {
    const n = parseFloat(s ?? '')
    return Number.isFinite(n) ? n : 0
  }
  // out_time_us is microseconds; older builds use out_time_ms (also microseconds, misnamed)
  const outUs = num(kv['out_time_us']) || num(kv['out_time_ms'])
  return {
    frame: num(kv['frame']),
    fps: num(kv['fps']),
    bitrateKbps: num((kv['bitrate'] ?? '').replace('kbits/s', '')),
    outTimeMs: outUs / 1000,
    speed: num((kv['speed'] ?? '').replace('x', '')),
    done
  }
}

/** Convenience: run to completion, throw with stderr tail on non-zero exit. */
export async function runOrThrow(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const handle = run(bin, args, opts)
  const res = await handle.promise
  if (res.code !== 0) {
    const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
    throw new Error(`${bin.split(/[\\/]/).pop()} exited with code ${res.code}\n${tail}`)
  }
  return res
}
