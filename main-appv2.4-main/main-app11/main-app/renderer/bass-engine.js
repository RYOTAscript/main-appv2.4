// ── Bass Boost: the pure engine ──────────────────────────────────────────────
//
// UMD, no DOM and no Node built-ins: loaded as a <script> by the panel
// (window.BassEngine — it draws the curve with the same maths) and require()d
// by main/bassBoost.js, which turns prefs into the DSP chain the C# host runs
// (main/bassBoostHostScript.js). One copy, so the curve on screen IS the sound.
//
// The chain, in order (every stage always present, so filter state survives a
// knob turn — an identity biquad is cheap, a reset one clicks):
//   speaker guard  2 × Butterworth high-pass (24 dB/oct). The speaker profile
//                  sets a floor: a small ported box unloads below its port
//                  tuning and the cone just flaps, so boosting there is noise
//   BASS           0..+24 dB at FREQ — a low shelf for full-range speakers, a
//                  focused bump for small ones (energy only where they play)
//   PUNCH          peak at 1.6 × FREQ — the kick-drum knock above the sub
//   CLARITY        a mud cut at ~2.6 × FREQ scaled to how hard BASS is pushed,
//                  plus a little presence: the boost's broad skirt is what
//                  buries vocals, not the bass itself
//   speaker fix    3 fixed filters per profile (e.g. the Eris E3.5's own
//                  ~100 Hz bump, recessed mids and bright top)
//   10 bands       graphic EQ, one-octave peaks, ±12 dB
//   HARMONICS      (parallel) low band → tanh → high-passed: overtones that let
//                  small speakers SUGGEST bass they physically can't play
//   bass limiter   the low band (below ~2.2 × FREQ) gets its OWN compressor, so
//                  a kick drum squeezes only the bass — the vocals never duck
//   protect        auto preamp + an instant-attack limiter at −0.5 dBFS on the
//                  sum, as the last line of defence against clipping
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BassEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAMPLE_RATE = 48000;
  const BAND_FREQS = Object.freeze([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  const BAND_LABELS = Object.freeze(['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']);
  const BAND_Q = 1.414;
  const METER_BANDS = 32;
  const GUARDS = Object.freeze([0, 30, 40, 50, 60]);
  const MID_HEADROOM_DB = 2;      // mids/highs may sit this far over 0 dB before the preamp steps in
  const BASS_DRIVE_DB = 12;       // the most the bass limiter is ever asked to swallow
  const CEILING = 0.944;          // −0.5 dBFS, final limiter
  const RELEASE_MS = 80;
  const BASS_CEILING = 0.5;       // −6 dBFS: the bass band's share of the headroom
  const BASS_ATTACK_MS = 1;      // gain smoothing; the detector itself is peak-hold
  const BASS_RELEASE_MS = 140;
  const MAX_CUSTOM = 12;
  const N_BIQUADS = 19;

  const LIMITS = Object.freeze({
    bass: [0, 24], freq: [30, 150], punch: [0, 12], harmonics: [0, 100], clarity: [0, 100], output: [-12, 12], band: [-12, 12]
  });

  // Speaker profiles. `fix` filters are [type, Hz, dB, Q].
  //  eris35 — PreSonus Eris E3.5: 3.5" woven-composite woofer, rear-ported,
  //  rated 80 Hz–20 kHz, 25 W/side Class AB, ~100 dB peak. Measured (Erin's
  //  Audio Corner, 2021): a peaky midbass bump around 100 Hz, recessed mids and
  //  a bright treble — a strong "smiley face" out of the box. So: nothing below
  //  60 Hz, the boost aimed at 70–90 Hz where the woofer still has output, the
  //  100 Hz bump pulled down so it doesn't swamp everything, mids lifted, and
  //  BASS capped at +12 dB (16× the power at 70 Hz into 25 W and a 3.5" cone —
  //  past that it only distorts; HARMONICS carries the rest of the weight).
  const SPEAKERS = Object.freeze({
    generic: Object.freeze({ id: 'generic', name: 'Other speakers / subwoofer', minGuard: 0, minFreq: 30, maxBass: 24, bassShape: 'shelf', fix: [] }),
    eris35: Object.freeze({
      id: 'eris35', name: 'PreSonus Eris E3.5', minGuard: 60, minFreq: 70, maxBass: 12, bassShape: 'peak',
      fix: [['peak', 100, -3, 1.2], ['peak', 1200, 2.5, 0.7], ['hshelf', 7000, -2.5, 0.707]]
    })
  });

  // Built-in presets. 'flat' is the honest A/B reference.
  const PRESETS = Object.freeze([
    { id: 'flat', name: 'Flat', bass: 0, freq: 80, punch: 0, harmonics: 0, clarity: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'eris', name: 'Eris Punch', bass: 10, freq: 75, punch: 2, harmonics: 60, clarity: 70, bands: [0, 0, 0, -1, -1, 0, 1, 0, 0, 0] },
    { id: 'punchy', name: 'Punchy', bass: 6, freq: 90, punch: 4, harmonics: 10, clarity: 40, bands: [2, 2, 1, 0, 0, 0, 0, 0, 1, 1] },
    { id: 'heavy', name: 'Heavy', bass: 12, freq: 80, punch: 5, harmonics: 25, clarity: 50, bands: [3, 3, 2, 0, -1, 0, 0, 0, 1, 1] },
    { id: 'extreme', name: 'Extreme', bass: 18, freq: 70, punch: 6, harmonics: 40, clarity: 60, bands: [4, 4, 2, 0, -1, -1, 0, 0, 1, 2] },
    { id: 'earthquake', name: 'Earthquake', bass: 24, freq: 60, punch: 8, harmonics: 55, clarity: 70, bands: [6, 5, 3, 0, -2, -1, 0, 0, 0, 1] },
    { id: 'vshape', name: 'V-Shape', bass: 9, freq: 85, punch: 3, harmonics: 15, clarity: 40, bands: [3, 3, 1, -1, -3, -2, 0, 2, 4, 4] }
  ].map(Object.freeze));

  const DEFAULT_PREFS = Object.freeze({
    on: false,
    bypass: false,
    preset: 'extreme',
    bass: 18, freq: 70, punch: 6, harmonics: 40, clarity: 60, output: 0,
    bands: Object.freeze([4, 4, 2, 0, -1, -1, 0, 0, 1, 2]),
    guard: 40,
    speaker: 'generic',
    device: '',       // '' = the Windows default output
    sink: '',         // '' = pick a spare output automatically
    hotkey: 'CommandOrControl+Alt+B',
    custom: Object.freeze([])
  });

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v, lo, hi, dflt, step) {
    let n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return dflt;
    n = clamp(n, lo, hi);
    if (step) n = Math.round(n / step) * step;
    return Math.round(n * 100) / 100;
  }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

  function sanitizeBands(b, dflt) {
    const src = Array.isArray(b) ? b : dflt;
    const out = [];
    for (let i = 0; i < BAND_FREQS.length; i++) out.push(num(src[i], LIMITS.band[0], LIMITS.band[1], Number(dflt && dflt[i]) || 0, 0.5));
    return out;
  }

  function sanitizeSound(s, base) {
    const d = base || DEFAULT_PREFS;
    const o = s && typeof s === 'object' ? s : {};
    return {
      bass: num(o.bass, LIMITS.bass[0], LIMITS.bass[1], d.bass, 0.5),
      freq: Math.round(num(o.freq, LIMITS.freq[0], LIMITS.freq[1], d.freq)),
      punch: num(o.punch, LIMITS.punch[0], LIMITS.punch[1], d.punch, 0.5),
      harmonics: Math.round(num(o.harmonics, LIMITS.harmonics[0], LIMITS.harmonics[1], d.harmonics)),
      clarity: Math.round(num(o.clarity, LIMITS.clarity[0], LIMITS.clarity[1], typeof d.clarity === 'number' ? d.clarity : DEFAULT_PREFS.clarity)),
      bands: sanitizeBands(o.bands, d.bands)
    };
  }

  function sanitizeCustom(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const name = str(c.name, 32).trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const id = /^c[a-z0-9]{1,16}$/.test(c.id) ? c.id : 'c' + (out.length + 1) + Math.random().toString(36).slice(2, 8);
      out.push(Object.assign({ id, name }, sanitizeSound(c, PRESETS[0])));
      if (out.length >= MAX_CUSTOM) break;
    }
    return out;
  }

  function sanitizePrefs(p) {
    const o = p && typeof p === 'object' ? p : {};
    const custom = sanitizeCustom(o.custom);
    const sound = sanitizeSound(o, DEFAULT_PREFS);
    const known = PRESETS.some((x) => x.id === o.preset) || custom.some((x) => x.id === o.preset);
    const guard = GUARDS.includes(Number(o.guard)) ? Number(o.guard) : DEFAULT_PREFS.guard;
    const speaker = Object.prototype.hasOwnProperty.call(SPEAKERS, o.speaker) ? o.speaker : DEFAULT_PREFS.speaker;
    sound.bass = Math.min(sound.bass, SPEAKERS[speaker].maxBass);
    return Object.assign({
      on: o.on === true,
      bypass: o.bypass === true,
      preset: known ? o.preset : 'custom',
      output: num(o.output, LIMITS.output[0], LIMITS.output[1], DEFAULT_PREFS.output, 0.5),
      guard,
      speaker,
      device: /^\{[0-9a-zA-Z.\-{}]{8,120}$/.test(o.device || '') ? o.device : '',
      sink: /^\{[0-9a-zA-Z.\-{}]{8,120}$/.test(o.sink || '') ? o.sink : '',
      hotkey: typeof o.hotkey === 'string' ? o.hotkey.slice(0, 60) : DEFAULT_PREFS.hotkey,
      custom
    }, sound);
  }

  // Merge a patch from the panel (or the voice assistant) into prefs. Touching
  // any sound control turns the preset into 'custom'; picking a preset loads it.
  function applyPatch(prefs, patch) {
    const p = Object.assign({}, prefs);
    const q = patch && typeof patch === 'object' ? patch : {};
    if (typeof q.preset === 'string') {
      const pre = findPreset(prefs, q.preset);
      if (pre) Object.assign(p, sanitizeSound(pre), { preset: pre.id });
    }
    let touched = false;
    for (const k of ['bass', 'freq', 'punch', 'harmonics', 'clarity']) if (k in q) { p[k] = q[k]; touched = true; }
    if (Array.isArray(q.bands)) { p.bands = q.bands; touched = true; }
    if (q.band && typeof q.band === 'object' && Number.isInteger(q.band.index)) {
      const b = (p.bands || []).slice();
      b[q.band.index] = q.band.value;
      p.bands = b;
      touched = true;
    }
    for (const k of ['on', 'bypass', 'output', 'guard', 'speaker', 'device', 'sink', 'hotkey']) if (k in q) p[k] = q[k];
    if (touched) p.preset = 'custom';
    return sanitizePrefs(p);
  }

  function findPreset(prefs, id) {
    return PRESETS.find((x) => x.id === id) || ((prefs && prefs.custom) || []).find((x) => x.id === id) || null;
  }

  function saveCustom(prefs, name) {
    const n = str(name, 32).trim();
    if (!n) return { prefs, error: 'Give the preset a name' };
    const list = (prefs.custom || []).filter((c) => c.name.toLowerCase() !== n.toLowerCase());
    if (list.length >= MAX_CUSTOM) return { prefs, error: `You can keep ${MAX_CUSTOM} presets — delete one first` };
    const id = 'c' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);
    list.push(Object.assign({ id, name: n }, sanitizeSound(prefs)));
    return { prefs: sanitizePrefs(Object.assign({}, prefs, { custom: list, preset: id })) };
  }

  function deleteCustom(prefs, id) {
    const list = (prefs.custom || []).filter((c) => c.id !== id);
    return sanitizePrefs(Object.assign({}, prefs, { custom: list, preset: prefs.preset === id ? 'custom' : prefs.preset }));
  }

  function speakerOf(prefs) { return SPEAKERS[prefs && prefs.speaker] || SPEAKERS.generic; }

  // The BASS knob's range for these speakers.
  function bassRange(prefs) { return [LIMITS.bass[0], speakerOf(prefs).maxBass]; }

  // What the chain actually uses once the speaker profile has had its say.
  function effective(prefs) {
    const p = sanitizePrefs(prefs);
    const sp = speakerOf(p);
    const guard = Math.max(p.guard, sp.minGuard);
    const freq = Math.max(p.freq, sp.minFreq);
    const bass = Math.min(p.bass, sp.maxBass);
    return { p, sp, guard, freq, bass };
  }

  // ── Filter design (RBJ Audio EQ Cookbook), normalised so a0 = 1 ──
  const IDENTITY = Object.freeze([1, 0, 0, 0, 0]);

  function norm(b0, b1, b2, a0, a1, a2) { return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]; }

  function peaking(f, gainDb, q, fs) {
    if (Math.abs(gainDb) < 1e-6) return IDENTITY.slice();
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w);
    return norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  function lowShelf(f, gainDb, fs) {
    if (Math.abs(gainDb) < 1e-6) return IDENTITY.slice();
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f / fs, c = Math.cos(w);
    const al = Math.sin(w) / 2 * Math.SQRT2;      // shelf slope S = 1
    const s = 2 * Math.sqrt(A) * al;
    return norm(A * ((A + 1) - (A - 1) * c + s), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - s),
      (A + 1) + (A - 1) * c + s, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - s);
  }

  function highShelf(f, gainDb, fs) {
    if (Math.abs(gainDb) < 1e-6) return IDENTITY.slice();
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f / fs, c = Math.cos(w);
    const al = Math.sin(w) / 2 * Math.SQRT2;
    const s = 2 * Math.sqrt(A) * al;
    return norm(A * ((A + 1) + (A - 1) * c + s), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - s),
      (A + 1) - (A - 1) * c + s, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - s);
  }

  function highPass(f, q, fs) {
    const w = 2 * Math.PI * f / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w);
    return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  function lowPass(f, q, fs) {
    const w = 2 * Math.PI * f / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w);
    return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  // |H(e^jw)| in dB of one normalised biquad.
  function magnitudeDb(c, f, fs) {
    const w = 2 * Math.PI * f / (fs || SAMPLE_RATE);
    const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * cw + c[2] * c2, ni = -(c[1] * sw + c[2] * s2);
    const dr = 1 + c[3] * cw + c[4] * c2, di = -(c[3] * sw + c[4] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  function fixFilter(f, fs) {
    if (f[0] === 'hshelf') return highShelf(f[1], f[2], fs);
    return peaking(f[1], f[2], f[3], fs);
  }

  // The linear filters, in host order. Always N_BIQUADS long.
  function biquads(prefs, fs) {
    const r = fs || SAMPLE_RATE;
    const { p, sp, guard, freq, bass } = effective(prefs);
    const list = [];
    if (guard > 0) { list.push(highPass(guard, 0.5412, r)); list.push(highPass(guard, 1.3066, r)); }
    else { list.push(IDENTITY.slice()); list.push(IDENTITY.slice()); }
    list.push(sp.bassShape === 'peak' ? peaking(freq, bass, 0.9, r) : lowShelf(freq, bass, r));
    list.push(peaking(Math.min(freq * 1.6, 240), p.punch, 1.2, r));
    // CLARITY: cut the boost's skirt where it buries vocals, scaled to how hard
    // BASS is pushed, plus a touch of presence.
    const c = p.clarity / 100;
    list.push(peaking(clamp(freq * 2.6, 160, 360), -c * Math.min(6, 1 + bass * 0.3), 1.0, r));
    list.push(peaking(2500, c * 2, 0.8, r));
    for (let i = 0; i < 3; i++) list.push(sp.fix[i] ? fixFilter(sp.fix[i], r) : IDENTITY.slice());
    for (let i = 0; i < BAND_FREQS.length; i++) list.push(peaking(BAND_FREQS[i], p.bands[i], BAND_Q, r));
    return list;
  }

  // Combined response of the EQ curve (dB, before preamp/output), on `points`
  // log-spaced frequencies from 20 Hz to 20 kHz.
  function responseCurve(prefs, points) {
    const n = points || 128;
    const qs = biquads(prefs);
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = 20 * Math.pow(1000, i / (n - 1));
      let db = 0;
      for (const q of qs) db += magnitudeDb(q, f);
      out.push({ f, db });
    }
    return out;
  }

  function crossoverHz(prefs) { return clamp(effective(prefs).freq * 2.2, 120, 220); }

  function peakGainDb(prefs, fromHz) {
    let peak = -Infinity;
    for (const pt of responseCurve(prefs, 256)) if (pt.f >= (fromHz || 0) && pt.db > peak) peak = pt.db;
    return peak;
  }

  // Auto-protect. The mids and highs set the level (they get only a couple of
  // dB of headroom over 0), and the bass may drive its own limiter by at most
  // BASS_DRIVE_DB — past that the preamp comes down too, because a limiter
  // swallowing more than that is audibly distorting a 3.5" woofer's signal.
  function preampDb(prefs) {
    const mids = peakGainDb(prefs, crossoverHz(prefs) * 1.8);
    const all = peakGainDb(prefs);
    return -Math.max(0, mids - MID_HEADROOM_DB, all - BASS_DRIVE_DB);
  }

  function dbToLin(db) { return Math.pow(10, db / 20); }

  // Everything the host needs, as numbers.
  // `fs` is the rate the host is really running at (48 kHz unless a capture
  // fallback needed 44.1 kHz — the host reports it with a RATE line).
  function buildChain(prefs, fs) {
    const r = fs || SAMPLE_RATE;
    const { p, freq } = effective(prefs);
    const pre = preampDb(p);
    const harmF = clamp(freq * 1.2, 40, 200);
    const xo = crossoverHz(p);
    return {
      bypass: !!p.bypass,
      preampDb: pre,
      pre: dbToLin(pre),
      out: dbToLin(p.output),
      ceil: CEILING,
      releaseMs: RELEASE_MS,
      harm: (p.harmonics / 100) * 1.6,
      harmLp: lowPass(harmF, 0.7071, r),
      harmHp: highPass(harmF * 1.7, 0.7071, r),
      crossoverHz: xo,
      xoLp: lowPass(xo, 0.7071, r),
      xoHp: highPass(xo, 0.7071, r),
      bassCeil: BASS_CEILING,
      bassAttackMs: BASS_ATTACK_MS,
      bassReleaseMs: BASS_RELEASE_MS,
      biquads: biquads(p, r)
    };
  }

  function fmt(n) {
    if (!Number.isFinite(n)) return '0';
    const s = n.toPrecision(12);
    return s.indexOf('e') >= 0 ? Number(s).toString() : String(Number(s));
  }

  // The host's CHAIN line (see main/bassBoostHostScript.js):
  // CHAIN bypass pre out ceil relMs harm lp×5 hp×5 xoLp×5 xoHp×5 bassCeil bassAtk bassRel n bq×5n
  function chainLine(chain) {
    const c = chain;
    const parts = ['CHAIN', c.bypass ? '1' : '0', fmt(c.pre), fmt(c.out), fmt(c.ceil), fmt(c.releaseMs), fmt(c.harm)];
    for (const v of c.harmLp) parts.push(fmt(v));
    for (const v of c.harmHp) parts.push(fmt(v));
    for (const v of c.xoLp) parts.push(fmt(v));
    for (const v of c.xoHp) parts.push(fmt(v));
    parts.push(fmt(c.bassCeil), fmt(c.bassAttackMs), fmt(c.bassReleaseMs));
    parts.push(String(c.biquads.length));
    for (const q of c.biquads) for (const v of q) parts.push(fmt(v));
    return parts.join(' ');
  }

  // Parse the host's LV line into numbers the visualiser draws.
  function parseMeter(line) {
    const m = /^LV ([0-9a-f]{64}) (\d+) (\d+) (\d+)(?: (\d+))?$/.exec(String(line || '').trim());
    if (!m) return null;
    const bands = [];
    for (let i = 0; i < METER_BANDS; i++) bands.push(parseInt(m[1].substr(i * 2, 2), 16) / 255);
    return {
      bands,
      reductionDb: Math.round(parseInt(m[2], 10) / 255 * 24 * 10) / 10,
      peak: parseInt(m[3], 10) / 255,
      latencyMs: parseInt(m[4], 10),
      bassReductionDb: m[5] === undefined ? 0 : Math.round(parseInt(m[5], 10) / 255 * 24 * 10) / 10
    };
  }

  // Voice / hotkey nudges.
  function nudgeBass(prefs, deltaDb) {
    const p = sanitizePrefs(prefs);
    const [lo, hi] = bassRange(p);
    return applyPatch(p, { bass: clamp(p.bass + deltaDb, lo, hi) });
  }

  function meterBandFreq(i) { return 20 * Math.pow(1000, (i + 0.5) / METER_BANDS); }

  function formatFreq(f) { return f >= 1000 ? (Math.round(f / 100) / 10) + 'k' : String(Math.round(f)); }

  return {
    SAMPLE_RATE, BAND_FREQS, BAND_LABELS, METER_BANDS, GUARDS, LIMITS, PRESETS, SPEAKERS, DEFAULT_PREFS,
    MID_HEADROOM_DB, BASS_DRIVE_DB, CEILING, BASS_CEILING, MAX_CUSTOM, N_BIQUADS,
    sanitizePrefs, applyPatch, findPreset, saveCustom, deleteCustom, effective, speakerOf, bassRange,
    peaking, lowShelf, highShelf, highPass, lowPass, magnitudeDb, biquads, responseCurve, crossoverHz, peakGainDb, preampDb, dbToLin,
    buildChain, chainLine, parseMeter, nudgeBass, meterBandFreq, formatFreq
  };
});
