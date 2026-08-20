// Reads Claude Code's own session transcripts (~/.claude/projects/*/*.jsonl) to
// find the exact rate-limit reset time — the reliable, focus-independent signal
// the Claude Limit widget prefers. Pure Node fs (no electron, no OS-specific
// calls), so it works identically on Windows + macOS and the line parser is
// unit-testable. (The Windows claudeLimit.js keeps its own copy to stay
// untouched; this is the shared reader the mac backend uses.)
const fs = require('fs');
const os = require('os');
const path = require('path');

function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function projectsDir() { return path.join(claudeHome(), 'projects'); }

// Parse one JSONL line → a rate_limit event { ts, uuid, text, cwd, sessionId }
// or null. PURE — the cheap 'rate_limit' pre-filter + JSON shape checks match
// the Windows implementation exactly.
function parseRateLimitEvent(line) {
  if (!line || line.indexOf('rate_limit') === -1) return null;
  let obj;
  try { obj = JSON.parse(line); } catch (e) { return null; }
  if (!obj || obj.error !== 'rate_limit') return null;
  const ts = Date.parse(obj.timestamp || '') || 0;
  const text = (obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].text) || '';
  if (!text) return null;
  return { ts, uuid: obj.uuid || '', text, cwd: obj.cwd || '', sessionId: obj.sessionId || '' };
}

// Read only the last `maxBytes` of a file (limit events are appended at the end).
function tailRead(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function listTranscripts() {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch (e) { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir(), p.name);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try { const st = fs.statSync(path.join(dir, f)); out.push({ file: path.join(dir, f), mtime: st.mtimeMs }); } catch (e) { /* skip */ }
    }
  }
  return out;
}

// Newest rate_limit event across the 25 most-recently-modified transcripts, or null.
function scanCcLimit() {
  const files = listTranscripts().sort((a, b) => b.mtime - a.mtime).slice(0, 25);
  let best = null;
  for (const { file } of files) {
    let tail;
    try { tail = tailRead(file, 262144); } catch (e) { continue; }
    if (tail.indexOf('rate_limit') === -1) continue;
    for (const line of tail.split('\n')) {
      const ev = parseRateLimitEvent(line);
      if (ev && (!best || ev.ts > best.ts)) best = ev;
    }
  }
  return best;
}

function readCcLimit() {
  try {
    const ev = scanCcLimit();
    if (!ev || !ev.text) return { ok: true, found: false };
    return { ok: true, found: true, text: ev.text, at: ev.ts, cwd: ev.cwd };
  } catch (e) {
    return { ok: false, found: false };
  }
}

module.exports = { claudeHome, projectsDir, parseRateLimitEvent, scanCcLimit, readCcLimit };
