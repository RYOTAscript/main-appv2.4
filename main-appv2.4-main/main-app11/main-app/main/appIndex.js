'use strict';

// ── Installed-app discovery ──────────────────────────────────────────────────
//
// The voice assistant could only launch apps the user had PINNED to the
// launcher. Everything else — the 150-odd things actually installed — was
// simply not a word it knew, so "open OBS" was inaudible rather than misheard.
//
// The Start Menu is the right source: Windows already curates it, every entry
// is something the user can launch, and the shortcut's filename is the name a
// person would say for it. No COM, no shelling out — the .lnk filename is all
// that is needed, so the scan is a directory walk and costs a few milliseconds.
//
// Paths are handed straight to the existing launch-app handler, which resolves
// .lnk through shell.openPath. Nothing new can be launched that the user could
// not already launch from their own Start Menu.

const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');

// Entries that are not applications. Shipping these as voice targets would fill
// the grammar with noise and let "uninstall" become a spoken command.
const SKIP = /(uninstall|remove |readme|read me|release notes|help$|documentation|website|manual|licence|license|report a (bug|problem)|feedback|command prompt|powershell|registry editor|troubleshoot|check for .*update|what.{0,3} new|telemetry|module docs|language preferences|support cent(er|re)|diagnostics|install additional|effect builder|preset manager|administrative tools)/i;

// Windows decorates names in ways nobody says out loud.
function speakableName(base) {
  let n = String(base || '')
    .replace(/\s*\((classic|desktop|64-bit|32-bit|x64|x86)\)\s*/gi, ' ')
    .replace(/\s*\b(20\d\d)\b\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}

function startMenuRoots() {
  const roots = [];
  if (process.env.ProgramData) roots.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return roots;
}

// Folders full of things nobody launches by voice. Including them would not
// just be clutter: every extra phrase is another target the recognizer can
// round noise to, so a bigger vocabulary of junk makes real commands LESS
// reliable. Quality beats coverage here.
const SKIP_FOLDER = /(administrative tools|windows administrative tools|windows tools|system tools|accessibility|windows powershell|maintenance|startup)/i;

// Walks a directory for shortcuts. Depth-limited: the Start Menu is shallow by
// convention, and an unbounded walk over a pathological tree would stall boot.
function collect(dir, out, depth) {
  if (depth > 4 || out.length >= 400) return;
  if (SKIP_FOLDER.test(path.basename(dir))) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    if (out.length >= 400) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { collect(full, out, depth + 1); continue; }
    if (!/\.(lnk|url)$/i.test(entry.name)) continue;
    const base = entry.name.replace(/\.(lnk|url)$/i, '');
    if (SKIP.test(base)) continue;
    const label = speakableName(base);
    // One or two characters is not a name anyone says, and it would be a magnet
    // for misrecognition.
    if (label.length < 3 || label.length > 40) continue;
    // Must read as a name, not an executable: "dfrgui" and "wmplayer" are
    // things a person points at, not things they say.
    if (!/^[A-Za-z][A-Za-z0-9 .,'&+:-]*$/.test(label)) continue;
    if (!/[aeiou]/i.test(label.replace(/[^a-z]/gi, ''))) continue;
    if (/^[a-z]+$/.test(label) && label.length <= 8 && !/\s/.test(label) && label === label.toLowerCase()) continue;
    out.push({ id: full, label });
  }
}

let cache = null;
let cachedAt = 0;
const TTL_MS = 5 * 60 * 1000;

function scan() {
  const found = [];
  for (const root of startMenuRoots()) collect(root, found, 0);

  // De-duplicate by spoken name: the same app is routinely in both the
  // all-users and per-user Start Menu, and two identical grammar phrases would
  // be a collision rather than a choice.
  const byName = new Map();
  for (const item of found) {
    const key = item.label.toLowerCase();
    if (!byName.has(key)) byName.set(key, item);
  }
  // The launcher itself is not something to launch from inside itself.
  const self = String(app.getName() || 'main').toLowerCase();
  return [...byName.values()].filter((x) => x.label.toLowerCase() !== self);
}

function getApps() {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  try {
    cache = scan();
  } catch (e) {
    cache = [];
  }
  cachedAt = now;
  return cache;
}

function init() {
  ipcMain.handle('app-index-list', () => getApps());
}

module.exports = { init, getApps, speakableName };
