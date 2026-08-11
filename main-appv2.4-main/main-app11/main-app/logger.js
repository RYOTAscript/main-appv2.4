const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVES = 3;

class Logger {
  constructor(logDir, appVersion) {
    this.logDir = logDir;
    this.appVersion = appVersion;
    this.sessionId = crypto.randomBytes(4).toString('hex');
    this.pid = process.pid;
    this.mainLog = path.join(logDir, 'main.log');
    this.errorLog = path.join(logDir, 'errors.log');
    // DEBUG entries trace every Spotify poll (~8 lines every 2.5s), which churns
    // the 2 MB rotation and buries real WARN/ERROR lines — so they're opt-in.
    this.debugEnabled = process.env.LAUNCHER_DEBUG === '1';

    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }

  rotateIfNeeded(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      if (fs.statSync(filePath).size < MAX_LOG_BYTES) return;

      for (let i = MAX_ARCHIVES - 1; i >= 1; i -= 1) {
        const from = `${filePath}.${i}`;
        const to = `${filePath}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(filePath, `${filePath}.1`);
    } catch (e) {
      console.error('Log rotation failed:', e.message);
    }
  }

  write(filePath, line) {
    this.rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line, 'utf8');
  }

  format(type, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${type}] [v${this.appVersion}] [sess:${this.sessionId}] [pid:${this.pid}] ${message}${metaStr}\n`;
  }

  log(message, type = 'INFO', meta = {}) {
    const entry = this.format(type, message, meta);
    console.log(entry.trim());
    try {
      this.write(this.mainLog, entry);
      if (type === 'ERROR' || type === 'FATAL') this.write(this.errorLog, entry);
    } catch (e) {
      console.error('Logger write failed:', e.message);
    }
  }

  system(message, meta) { this.log(message, 'SYSTEM', meta); }
  success(message, meta) { this.log(message, 'SUCCESS', meta); }
  warn(message, meta) { this.log(message, 'WARN', meta); }
  debug(message, meta) { if (this.debugEnabled) this.log(message, 'DEBUG', meta); }
  error(message, err, meta = {}) {
    const details = { ...meta };
    if (err) {
      details.error = err.message || String(err);
      if (err.stack) details.stack = err.stack.split('\n').slice(0, 6).join(' | ');
    }
    this.log(message, 'ERROR', details);
  }

  fatal(message, err, meta = {}) {
    this.error(message, err, meta);
    this.log(message, 'FATAL', meta);
  }

  startupBanner() {
    this.system('Application startup', {
      platform: `${os.platform()} ${os.release()}`,
      electron: process.versions.electron,
      node: process.versions.node,
      arch: process.arch,
      logDir: this.logDir,
      debugLogging: this.debugEnabled ? 'on' : 'off (set LAUNCHER_DEBUG=1 to enable)'
    });
  }

  attachProcessHandlers() {
    process.on('uncaughtException', (err) => {
      // Must not throw here — a second uncaught exception terminates the process
      // via abort(), which Windows 10 surfaces as STATUS_STACK_BUFFER_OVERRUN.
      try {
        this.fatal('Uncaught exception', err);
      } catch (logErr) {
        console.error('[logger] fatal() threw inside uncaughtException handler:', logErr);
      }
    });
    process.on('unhandledRejection', (reason) => {
      try {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        this.error('Unhandled promise rejection', err);
      } catch (logErr) {
        console.error('[logger] error() threw inside unhandledRejection handler:', logErr);
      }
    });
  }

  attachWindow(window) {
    if (!window) return;

    window.webContents.on('render-process-gone', (_event, details) => {
      this.error('Renderer process gone', null, details);
    });

    window.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.error('Page failed to load', null, { code, description, url });
    });

    // Renderer console errors (uncaught exceptions, failed loads, script errors)
    // previously vanished unless DevTools happened to be open — record them.
    // Event-object form only (Electron ≥32; this app pins ≥42 — declaring the
    // legacy positional args triggers a deprecation warning).
    window.webContents.on('console-message', (event) => {
      if (!event || event.level !== 'error') return;
      this.error(`Renderer console error: ${event.message}`, null, { source: event.sourceId, line: event.lineNumber });
    });

    window.on('unresponsive', () => this.warn('Window became unresponsive'));
    window.on('responsive', () => this.system('Window responsive again'));
    window.on('closed', () => this.system('Main window closed'));
  }
}

module.exports = Logger;