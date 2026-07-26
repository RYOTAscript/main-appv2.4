import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// Simple file logger: everything important lands in %APPDATA%/valclips-quality/logs/app.log.
// No silent failures anywhere in the app — errors always come through here.

let logStream: fs.WriteStream | null = null

function ensureStream(): fs.WriteStream | null {
  if (logStream) return logStream
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logStream = fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a' })
    return logStream
  } catch {
    return null
  }
}

function write(level: string, msg: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${
    extra !== undefined ? ' ' + safeJson(extra) : ''
  }`
  // eslint-disable-next-line no-console
  console.log(line)
  ensureStream()?.write(line + '\n')
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => write('INFO', msg, extra),
  warn: (msg: string, extra?: unknown) => write('WARN', msg, extra),
  error: (msg: string, extra?: unknown) => write('ERROR', msg, extra)
}

export function logFilePath(): string {
  return path.join(app.getPath('userData'), 'logs', 'app.log')
}
