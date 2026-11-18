// Lyrics matching rules (pure, no Electron, no network — test/lyrics-match.test.js).
//
// lrclib often holds several entries for one song: the explicit release and a
// "clean" one with the swearing starred out, an album cut and a single, a
// listing under one artist and another under "A feat. B". main/lyrics.js
// gathers every plausible entry and picks with pickBest(): the right length
// first (anything more than a few seconds off is a different recording), then
// timed over untimed, then uncensored over starred. Whatever is still starred
// in the winner is filled back in by uncensor(), for the common words whose
// masked spelling leaves only one possible reading.

'use strict';

// "[mm:ss]", "[mm:ss.xx]", "[mm:ss:xx]", minutes of any length.
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET = /\[offset:\s*([+-]?\d+)\s*\]/i;

// LRC text → [{ time, text }] sorted by time. A line sung more than once can
// carry several stamps ("[00:12.00][00:45.00]chorus"); each becomes a line.
// [offset:±ms] is honoured (positive means the lyrics come earlier).
function parseLrc(lrc) {
  if (typeof lrc !== 'string' || !lrc) return [];
  const offsetMatch = lrc.match(OFFSET);
  const offset = offsetMatch ? parseInt(offsetMatch[1], 10) || 0 : 0;
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    STAMP.lastIndex = 0;
    const times = [];
    let m;
    let end = 0;
    while ((m = STAMP.exec(raw)) && m.index === end) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      times.push(Math.round((parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac) * 1000));
      end = STAMP.lastIndex;
    }
    if (!times.length) continue;
    const text = raw.slice(end).trim();
    if (!text) continue; // blank/instrumental-gap markers
    for (const t of times) lines.push({ time: Math.max(0, t - offset), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// What lrclib calls a song is often barer than Spotify's title.
function cleanTitle(name) {
  return String(name || '')
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([](?:explicit|clean|edited|album version|single version|radio edit)[)\]]/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?(?:\s+\d{4})?|radio edit|single version|album version|mono|stereo|explicit)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Spotify joins a song's artists with ", ". The first is what lrclib usually
// lists — but "Tyler, The Creator" is one artist, so the full string is always
// tried first.
function primaryArtist(artist) {
  const s = String(artist || '').trim();
  const first = s.split(/,\s+|\s+&\s+|\s+(?:feat\.?|ft\.?|featuring|x|with)\s+/i)[0];
  return (first || s).trim();
}

// ── Starred-out swearing ────────────────────────────────────────────────────

// Masked tokens: letters with at least one of * # • standing in for some.
const MASKED = /[A-Za-z]*[*#•][A-Za-z*#•]*/g;

// Checked in this order, so the far likelier reading wins where two could fit
// (s**t is shit before it is anything else).
const SWEARS = [
  'fuck', 'fucking', 'fuckin', 'fucked', 'fucker', 'fuckers', 'fucks',
  'motherfucker', 'motherfuckers', 'motherfucking', 'motherfuckin', 'mothafucka', 'mothafuckas',
  'shit', 'shits', 'shitty', 'bullshit',
  'bitch', 'bitches', 'bitchin',
  'nigga', 'niggas', 'nigger', 'niggers',
  'ass', 'asses', 'asshole', 'assholes',
  'dick', 'dicks', 'pussy', 'pussies',
  'damn', 'goddamn', 'hoe', 'hoes', 'whore', 'whores',
  'cunt', 'cunts', 'bastard', 'bastards', 'cock', 'slut', 'sluts', 'thot', 'thots', 'piss', 'crap',
];

function countMasked(text) {
  const m = String(text || '').match(MASKED);
  return m ? m.length : 0;
}

function fill(token) {
  const lower = token.toLowerCase();
  if (!/[a-z]/.test(lower)) return token;           // "****": nothing to go on
  for (const word of SWEARS) {
    if (word.length !== lower.length) continue;
    let ok = true;
    for (let i = 0; i < word.length && ok; i++) {
      const c = lower[i];
      ok = c === '*' || c === '#' || c === '•' || c === word[i];
    }
    if (!ok) continue;
    if (token === token.toUpperCase() && /[A-Z]/.test(token)) return word.toUpperCase();
    return /^[A-Z]/.test(token) ? word[0].toUpperCase() + word.slice(1) : word;
  }
  return token;
}

// Puts back the words a censored transcription starred out.
function uncensor(text) {
  return String(text || '').replace(MASKED, fill);
}

// ── Choosing an entry ───────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const xs = new Set(x.split(' '));
  const ys = y.split(' ');
  const shared = ys.filter((w) => xs.has(w)).length;
  return shared / Math.max(xs.size, ys.length);
}

// How good an lrclib entry is for the song wanted ({ title, artist, album,
// durationSec }); -Infinity when it can't be this song at all.
function scoreCandidate(c, want) {
  if (!c || typeof c !== 'object') return -Infinity;
  const hasLyrics = !!(c.syncedLyrics || c.plainLyrics) || c.instrumental;
  if (!hasLyrics) return -Infinity;
  let score = 0;
  if (want.durationSec) {
    const off = Math.abs((Number(c.duration) || 0) - want.durationSec);
    if (off > 3) return -Infinity;
    score += 3 - off;                                // 0..3
  }
  score += c.syncedLyrics ? 10 : 0;
  score += 4 * similar(cleanTitle(c.trackName), cleanTitle(want.title));
  score += 3 * Math.max(similar(c.artistName, want.artist), similar(c.artistName, primaryArtist(want.artist)));
  if (want.album && similar(c.albumName, want.album) >= 0.8) score += 1;
  const starred = countMasked(c.syncedLyrics || c.plainLyrics);
  if (starred) score -= 6 + Math.min(6, starred);   // a clean version only wins when nothing else fits
  if (/\b(clean|edited)\b/i.test(`${c.trackName || ''} ${c.albumName || ''}`)) score -= 4;
  return score;
}

function pickBest(candidates, want) {
  let best = null;
  let bestScore = -Infinity;
  const seen = new Set();
  for (const c of candidates || []) {
    if (!c) continue;
    const id = c.id != null ? `id:${c.id}` : `${c.trackName}|${c.artistName}|${c.duration}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const score = scoreCandidate(c, want);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

module.exports = { parseLrc, cleanTitle, primaryArtist, countMasked, uncensor, scoreCandidate, pickBest };
