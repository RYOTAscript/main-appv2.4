// ── Timers engine (pure) ──
// Loaded BOTH as a renderer <script> (window.TimerEngine) and via require()
// from main/timers.js — one copy of the rules, so the panel, the floating
// windows and the scheduler can never disagree about when something ends.
// Same split as the Calendar (see renderer/calendar-engine.js).
//
// Nothing in here touches the DOM, Electron, timers or Math.random: every
// function takes `now` (and a random number where an id is minted) so the whole
// thing is unit-testable (test/timer-engine.test.js).
//
// Time model: a RUNNING countdown stores the wall-clock instant it ends
// (`endAt`), never a ticking counter, so a missed tick, a sleeping laptop or a
// throttled window can't make it drift. Paused timers store what was left.
// A running stopwatch stores the instant it (re)started plus what it had
// accumulated before that.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.TimerEngine = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const STORE_VERSION = 1;
    const MAX_TIMERS = 12;
    const MAX_LAPS = 99;
    const MAX_PRESETS = 16;
    const MAX_CHECKPOINTS = 12;
    const HISTORY_MAX = 50;
    const STATS_DAYS = 60;
    const MAX_DURATION = (100 * 3600 - 1) * 1000; // 99:59:59
    // The scheduler never sleeps longer than this, so a wall-clock change
    // (manual time change, NTP jump) is noticed within a few minutes.
    const WAKE_CAP = 5 * 60 * 1000;
    // A completion noticed this late (app closed, machine asleep) is reported
    // as missed: announced quietly, never rung.
    const MISSED_AFTER = 60 * 1000;

    const KINDS = ['countdown', 'stopwatch', 'pomodoro'];
    const STATUSES = ['idle', 'running', 'paused', 'done'];
    const PHASES = ['focus', 'short', 'long'];
    const PHASE_LABELS = { focus: 'Focus', short: 'Short break', long: 'Long break' };
    const COLORS = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#e5e5e5'];
    const SOUNDS = [
        { id: 'chime', label: 'Chime' },
        { id: 'bell', label: 'Bell' },
        { id: 'digital', label: 'Digital' },
        { id: 'soft', label: 'Soft' },
        { id: 'rise', label: 'Rise' },
        { id: 'none', label: 'Silent' }
    ];
    const WARN_OPTIONS = [0, 10, 30, 60, 300];
    const FLOAT_STYLES = ['ring', 'pill', 'text'];
    const FLOAT_SIZES = ['s', 'm', 'l'];
    // CSS pixels. The floating window is exactly this big, so everything it
    // draws (including hover controls) has to fit inside.
    const FLOAT_DIMS = {
        ring: { s: [150, 150], m: [196, 196], l: [260, 260] },
        pill: { s: [210, 58], m: [260, 72], l: [336, 92] },
        text: { s: [170, 58], m: [220, 74], l: [296, 98] }
    };
    const CORNERS = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'];

    const DEFAULT_SETTINGS = Object.freeze({
        sound: 'chime',
        volume: 70,
        ringUntilDismissed: true,
        warnSeconds: 0,
        notify: true,
        autoFloat: false,
        floatStyle: 'ring',
        floatSize: 'm',
        floatOpacity: 100,
        pomodoro: Object.freeze({ focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, autoBreaks: true, autoFocus: false }),
        hotkeyToggle: '',
        hotkeyFloat: ''
    });

    const DEFAULT_PRESET_MINUTES = [1, 3, 5, 10, 15, 25, 30, 45, 60];

    // ── Small sanitisers ────────────────────────────────────────────────────

    function finite(v) { return v !== null && v !== '' && Number.isFinite(Number(v)); }

    function clampInt(v, min, max, dflt) {
        if (!finite(v)) return dflt;
        return Math.min(max, Math.max(min, Math.round(Number(v))));
    }

    function clampMs(v) {
        if (!finite(v)) return 0;
        return Math.min(MAX_DURATION, Math.max(0, Math.round(Number(v))));
    }

    function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }

    function cleanLabel(s, max) {
        return String(s == null ? '' : s)
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max || 40);
    }

    function cleanId(id) {
        return typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : null;
    }

    function newId(prefix, now, rand) {
        const r = Math.floor((Number.isFinite(rand) ? rand : 0.5) * 2176782336).toString(36);
        return prefix + Math.floor(now).toString(36) + r;
    }

    // Electron accelerator text as the renderer produces it. Empty = unbound.
    function cleanAccel(a) {
        return typeof a === 'string' && /^[A-Za-z0-9+;'=,.\/`\[\]\\-]{1,60}$/.test(a) && a !== '-' ? a : '';
    }

    // ── Settings ────────────────────────────────────────────────────────────

    function mergeSettings(base, patch) {
        const b = base && typeof base === 'object' ? base : {};
        const p = patch && typeof patch === 'object' ? patch : {};
        const pick = (k) => (k in p ? p[k] : (k in b ? b[k] : DEFAULT_SETTINGS[k]));
        const pb = b.pomodoro && typeof b.pomodoro === 'object' ? b.pomodoro : {};
        const pp = p.pomodoro && typeof p.pomodoro === 'object' ? p.pomodoro : {};
        const pk = (k) => (k in pp ? pp[k] : (k in pb ? pb[k] : DEFAULT_SETTINGS.pomodoro[k]));
        const sound = pick('sound');
        const warn = Number(pick('warnSeconds'));
        return {
            sound: SOUNDS.some(s => s.id === sound) ? sound : DEFAULT_SETTINGS.sound,
            volume: clampInt(pick('volume'), 0, 100, DEFAULT_SETTINGS.volume),
            ringUntilDismissed: !!pick('ringUntilDismissed'),
            warnSeconds: WARN_OPTIONS.includes(warn) ? warn : 0,
            notify: !!pick('notify'),
            autoFloat: !!pick('autoFloat'),
            floatStyle: FLOAT_STYLES.includes(pick('floatStyle')) ? pick('floatStyle') : DEFAULT_SETTINGS.floatStyle,
            floatSize: FLOAT_SIZES.includes(pick('floatSize')) ? pick('floatSize') : DEFAULT_SETTINGS.floatSize,
            floatOpacity: clampInt(pick('floatOpacity'), 30, 100, DEFAULT_SETTINGS.floatOpacity),
            pomodoro: {
                focusMin: clampInt(pk('focusMin'), 1, 180, 25),
                shortMin: clampInt(pk('shortMin'), 1, 60, 5),
                longMin: clampInt(pk('longMin'), 1, 120, 15),
                longEvery: clampInt(pk('longEvery'), 2, 12, 4),
                autoBreaks: !!pk('autoBreaks'),
                autoFocus: !!pk('autoFocus')
            },
            hotkeyToggle: cleanAccel(pick('hotkeyToggle')),
            hotkeyFloat: cleanAccel(pick('hotkeyFloat'))
        };
    }

    function phaseMs(settings, phase) {
        const p = (settings && settings.pomodoro) || DEFAULT_SETTINGS.pomodoro;
        const min = phase === 'short' ? p.shortMin : phase === 'long' ? p.longMin : p.focusMin;
        return min * 60000;
    }

    // What follows a phase. `cycle` counts focus sessions completed (or
    // skipped past), which is what decides when the long break comes round.
    function nextPhase(t, settings) {
        const every = ((settings && settings.pomodoro) || DEFAULT_SETTINGS.pomodoro).longEvery;
        if (t.phase === 'focus') {
            const cycle = t.cycle + 1;
            return { phase: cycle % every === 0 ? 'long' : 'short', cycle };
        }
        return { phase: 'focus', cycle: t.cycle };
    }

    // How many of the dots in the current set are filled.
    function cycleDots(t, settings) {
        const every = ((settings && settings.pomodoro) || DEFAULT_SETTINGS.pomodoro).longEvery;
        if (!t || t.kind !== 'pomodoro') return { filled: 0, total: every };
        if (t.phase === 'long') return { filled: every, total: every };
        return { filled: t.cycle % every, total: every };
    }

    // ── Checkpoints ─────────────────────────────────────────────────────────
    // A checkpoint is a moment part-way through a countdown, stored as the time
    // LEFT when it fires (`leftMs`) — so "5 min left" stays 5 min left when the
    // timer is nudged. `hit` marks it passed for the current round. Sorted
    // earliest first (largest leftMs first). Countdowns only.

    function sanitizeCheckpoints(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        const seen = new Set();
        for (const c of list) {
            if (!c || typeof c !== 'object') continue;
            const leftMs = clampMs(c.leftMs);
            if (leftMs < 1000 || seen.has(leftMs)) continue;
            seen.add(leftMs);
            out.push({ id: 'c' + leftMs.toString(36), leftMs, label: cleanLabel(c.label, 30), hit: !!c.hit });
        }
        return out.sort((a, b) => b.leftMs - a.leftMs).slice(0, MAX_CHECKPOINTS);
    }

    // Everything at or beyond `left` has passed; everything after it is still
    // ahead. Infinity = a fresh round (nothing passed), 0 = finished (all passed).
    function markCheckpoints(cps, left) {
        return (cps || []).map(c => {
            const hit = c.leftMs >= left;
            return c.hit === hit ? c : Object.assign({}, c, { hit });
        });
    }

    // Replaces a countdown's checkpoints. Ones already behind a running timer
    // are marked passed quietly rather than firing the moment they're added.
    function setCheckpoints(t, list, now) {
        if (!t || t.kind !== 'countdown') return t;
        const left = t.status === 'idle' ? Infinity : remaining(t, now);
        return Object.assign({}, t, { checkpoints: markCheckpoints(sanitizeCheckpoints(list), left) });
    }

    // Where each checkpoint sits on a draining ring/bar, as the fraction of the
    // timer still LEFT when it fires (1 = the start, 0 = the end).
    function checkpointMarks(t) {
        if (!t || t.kind !== 'countdown' || !t.durationMs) return [];
        return (t.checkpoints || [])
            .filter(c => c.leftMs < t.durationMs)
            .map(c => ({ id: c.id, leftMs: c.leftMs, label: c.label, hit: c.hit, frac: c.leftMs / t.durationMs }));
    }

    // ── Timers ──────────────────────────────────────────────────────────────

    function sanitizeTimer(t, now, settings) {
        if (!t || typeof t !== 'object') return null;
        const kind = KINDS.includes(t.kind) ? t.kind : 'countdown';
        let status = STATUSES.includes(t.status) ? t.status : 'idle';
        const out = {
            id: cleanId(t.id) || newId('t', now, 0.37),
            kind,
            label: cleanLabel(t.label),
            color: isHex(t.color) ? t.color.toLowerCase() : COLORS[0],
            status,
            durationMs: clampMs(t.durationMs),
            remainingMs: clampMs(t.remainingMs),
            endAt: finite(t.endAt) ? Number(t.endAt) : null,
            elapsedMs: clampMs(t.elapsedMs),
            startedAt: finite(t.startedAt) ? Number(t.startedAt) : null,
            laps: Array.isArray(t.laps) ? t.laps.filter(n => finite(n) && Number(n) >= 0).map(Number).slice(-MAX_LAPS) : [],
            checkpoints: sanitizeCheckpoints(t.checkpoints),
            repeat: clampInt(t.repeat, -1, 99, 0),
            repeatsDone: clampInt(t.repeatsDone, 0, 1e6, 0),
            phase: PHASES.includes(t.phase) ? t.phase : 'focus',
            cycle: clampInt(t.cycle, 0, 1e6, 0),
            warned: !!t.warned,
            doneAt: finite(t.doneAt) ? Number(t.doneAt) : null,
            createdAt: finite(t.createdAt) ? Number(t.createdAt) : now
        };

        if (kind === 'stopwatch') {
            out.durationMs = 0; out.remainingMs = 0; out.endAt = null; out.repeat = 0; out.repeatsDone = 0;
            if (status === 'done') status = 'paused';
            if (status === 'running' && out.startedAt == null) status = out.elapsedMs > 0 ? 'paused' : 'idle';
            if (status !== 'running') out.startedAt = null;
            if (status === 'idle') { out.elapsedMs = 0; out.laps = []; }
        } else {
            out.laps = []; out.elapsedMs = 0; out.startedAt = null;
            if (kind === 'pomodoro') out.repeat = 0;
            if (out.durationMs < 1000) out.durationMs = kind === 'pomodoro' ? phaseMs(settings, out.phase) : 60000;
            if (status === 'running' && out.endAt == null) status = out.remainingMs > 0 ? 'paused' : 'idle';
            if (status !== 'running') out.endAt = null;
            if (status === 'paused' && out.remainingMs <= 0) status = 'idle';
            if (status === 'idle') out.remainingMs = out.durationMs;
            if (status === 'done') out.remainingMs = 0;
        }
        if (kind !== 'pomodoro') { out.phase = 'focus'; out.cycle = 0; }
        if (kind !== 'countdown') out.checkpoints = [];
        else if (status === 'idle') out.checkpoints = markCheckpoints(out.checkpoints, Infinity);
        else if (status === 'done') out.checkpoints = markCheckpoints(out.checkpoints, 0);
        if (status !== 'done') out.doneAt = null;
        if (status === 'done' && out.doneAt == null) out.doneAt = now;
        out.status = status;
        return out;
    }

    function remaining(t, now) {
        if (!t || t.kind === 'stopwatch') return 0;
        if (t.status === 'running' && t.endAt != null) return Math.max(0, t.endAt - now);
        if (t.status === 'done') return 0;
        return Math.max(0, t.remainingMs || 0);
    }

    function elapsed(t, now) {
        if (!t) return 0;
        if (t.kind === 'stopwatch') {
            const live = t.status === 'running' && t.startedAt != null ? Math.max(0, now - t.startedAt) : 0;
            return t.elapsedMs + live;
        }
        return Math.max(0, t.durationMs - remaining(t, now));
    }

    // 0 → 1 as a countdown runs out. A stopwatch sweeps once a minute.
    function progress(t, now) {
        if (!t) return 0;
        if (t.kind === 'stopwatch') return (elapsed(t, now) % 60000) / 60000;
        if (t.status === 'done') return 1;
        if (!t.durationMs) return 0;
        return Math.min(1, Math.max(0, 1 - remaining(t, now) / t.durationMs));
    }

    function displayName(t) {
        if (!t) return 'Timer';
        if (t.label) return t.label;
        if (t.kind === 'stopwatch') return 'Stopwatch';
        if (t.kind === 'pomodoro') return 'Pomodoro';
        return formatHuman(t.durationMs) + ' timer';
    }

    function createTimer(opts, now, settings, index, rand) {
        const o = opts && typeof opts === 'object' ? opts : {};
        const S = settings || mergeSettings();
        const kind = KINDS.includes(o.kind) ? o.kind : 'countdown';
        let durationMs = 0;
        if (kind === 'countdown') {
            if (finite(o.until)) durationMs = Number(o.until) - now;
            else durationMs = Number(o.durationMs);
            if (!finite(durationMs) || durationMs < 1000) return null;
            durationMs = Math.min(MAX_DURATION, Math.round(durationMs));
        } else if (kind === 'pomodoro') {
            durationMs = phaseMs(S, 'focus');
        }
        const color = isHex(o.color) ? o.color.toLowerCase() : COLORS[(Number(index) || 0) % COLORS.length];
        let t = sanitizeTimer({
            id: newId('t', now, rand),
            kind,
            label: o.label,
            color,
            status: 'idle',
            durationMs,
            remainingMs: durationMs,
            repeat: o.repeat,
            createdAt: now
        }, now, S);
        if (kind === 'countdown' && Array.isArray(o.checkpoints)) t = setCheckpoints(t, o.checkpoints, now);
        if (o.start) t = applyAction(t, 'start', null, now, S);
        return t;
    }

    // Every state change a timer can go through. Returns a NEW timer, the same
    // timer when the action doesn't apply in this state, or null for an action
    // that doesn't exist.
    function applyAction(timer, action, arg, now, settings) {
        if (!timer) return null;
        const S = settings || mergeSettings();
        const t = Object.assign({}, timer, { laps: (timer.laps || []).slice() });
        switch (action) {
            case 'toggle':
                return applyAction(t, t.status === 'running' ? 'pause' : 'start', null, now, S);

            case 'start': {
                if (t.status === 'running') return timer;
                if (t.status === 'paused') return applyAction(t, 'resume', null, now, S);
                if (t.kind === 'stopwatch') {
                    t.elapsedMs = 0; t.laps = []; t.startedAt = now; t.status = 'running';
                    return t;
                }
                if (t.kind === 'pomodoro') t.durationMs = phaseMs(S, t.phase);
                t.remainingMs = t.durationMs;
                t.endAt = now + t.durationMs;
                t.status = 'running';
                t.warned = false;
                t.doneAt = null;
                t.repeatsDone = 0;
                t.checkpoints = markCheckpoints(t.checkpoints, Infinity);
                return t;
            }

            case 'pause':
                if (t.status !== 'running') return timer;
                if (t.kind === 'stopwatch') { t.elapsedMs = elapsed(t, now); t.startedAt = null; }
                else { t.remainingMs = remaining(t, now); t.endAt = null; }
                t.status = 'paused';
                return t;

            case 'resume':
                if (t.status !== 'paused') return timer;
                if (t.kind === 'stopwatch') { t.startedAt = now; t.status = 'running'; return t; }
                if (t.remainingMs <= 0) return applyAction(t, 'reset', null, now, S);
                t.endAt = now + t.remainingMs;
                t.status = 'running';
                return t;

            case 'reset':
                if (t.kind === 'stopwatch') {
                    t.elapsedMs = 0; t.laps = []; t.startedAt = null;
                } else {
                    if (t.kind === 'pomodoro') t.durationMs = phaseMs(S, t.phase);
                    t.remainingMs = t.durationMs; t.endAt = null;
                }
                t.status = 'idle'; t.warned = false; t.doneAt = null; t.repeatsDone = 0;
                t.checkpoints = markCheckpoints(t.checkpoints, Infinity);
                return t;

            case 'restart':
                return applyAction(applyAction(t, 'reset', null, now, S), 'start', null, now, S);

            case 'dismiss':
                if (t.status !== 'done') return timer;
                return applyAction(t, 'reset', null, now, S);

            case 'adjust': {
                if (t.kind === 'stopwatch' || !finite(arg)) return timer;
                const delta = Math.round(Number(arg));
                if (t.status === 'running') {
                    const left = Math.max(1000, Math.min(MAX_DURATION, remaining(t, now) + delta));
                    t.endAt = now + left;
                    t.durationMs = Math.min(MAX_DURATION, Math.max(left, t.durationMs + delta));
                    if (left > S.warnSeconds * 1000) t.warned = false;
                    t.checkpoints = markCheckpoints(t.checkpoints, left);
                } else if (t.status === 'paused') {
                    t.remainingMs = Math.max(1000, Math.min(MAX_DURATION, t.remainingMs + delta));
                    t.durationMs = Math.min(MAX_DURATION, Math.max(t.remainingMs, t.durationMs + delta));
                    if (t.remainingMs > S.warnSeconds * 1000) t.warned = false;
                    t.checkpoints = markCheckpoints(t.checkpoints, t.remainingMs);
                } else if (t.status === 'done') {
                    // "+1 min" on a finished timer is a snooze: run for that long.
                    if (delta < 1000) return timer;
                    t.durationMs = Math.min(MAX_DURATION, delta);
                    t.remainingMs = t.durationMs;
                    t.endAt = now + t.durationMs;
                    t.status = 'running';
                    t.doneAt = null;
                    t.warned = false;
                    t.checkpoints = markCheckpoints(t.checkpoints, t.durationMs);
                } else {
                    t.durationMs = Math.max(1000, Math.min(MAX_DURATION, t.durationMs + delta));
                    t.remainingMs = t.durationMs;
                }
                return t;
            }

            case 'setDuration': {
                if (t.kind !== 'countdown' || t.status === 'running' || !finite(arg) || Number(arg) < 1000) return timer;
                t.durationMs = Math.min(MAX_DURATION, Math.round(Number(arg)));
                t.remainingMs = t.durationMs;
                t.status = 'idle'; t.endAt = null; t.doneAt = null; t.warned = false; t.repeatsDone = 0;
                t.checkpoints = markCheckpoints(t.checkpoints, Infinity);
                return t;
            }

            case 'lap':
                if (t.kind !== 'stopwatch' || t.status !== 'running' || t.laps.length >= MAX_LAPS) return timer;
                t.laps.push(elapsed(t, now));
                return t;

            case 'skip': {
                if (t.kind !== 'pomodoro') return timer;
                const wasRunning = t.status === 'running';
                const np = nextPhase(t, S);
                t.phase = np.phase; t.cycle = np.cycle;
                t.durationMs = phaseMs(S, np.phase);
                t.remainingMs = t.durationMs;
                t.warned = false; t.doneAt = null;
                if (wasRunning) { t.endAt = now + t.durationMs; t.status = 'running'; }
                else { t.endAt = null; t.status = 'idle'; }
                return t;
            }

            case 'resetCycle':
                if (t.kind !== 'pomodoro') return timer;
                t.phase = 'focus'; t.cycle = 0;
                return applyAction(t, 'reset', null, now, S);

            default:
                return null;
        }
    }

    // Idle Pomodoro timers pick up new phase lengths straight away; a running
    // phase keeps the length it started with.
    function syncPomodoroDurations(timers, settings) {
        return timers.map(t => {
            if (t.kind !== 'pomodoro' || t.status !== 'idle') return t;
            const d = phaseMs(settings, t.phase);
            return d === t.durationMs ? t : Object.assign({}, t, { durationMs: d, remainingMs: d });
        });
    }

    function primaryTimer(store, preferKind) {
        const list = (store && store.timers) || [];
        const pool = preferKind ? list.filter(t => t.kind === preferKind) : list;
        if (!pool.length) return null;
        const focused = pool.find(t => t.id === store.focusId);
        if (focused) return focused;
        return pool.find(t => t.status === 'running')
            || pool.find(t => t.status === 'done')
            || pool.find(t => t.status === 'paused')
            || pool[0];
    }

    // ── Store ───────────────────────────────────────────────────────────────

    function presetLabel(ms) { return formatShort(ms); }

    function defaultPresets() {
        return DEFAULT_PRESET_MINUTES.map(m => ({ id: 'p' + m, label: presetLabel(m * 60000), ms: m * 60000 }));
    }

    function sanitizePresets(list) {
        if (!Array.isArray(list)) return defaultPresets();
        const out = [];
        const seen = new Set();
        for (const p of list) {
            if (!p || typeof p !== 'object') continue;
            const ms = clampMs(p.ms);
            const id = cleanId(p.id);
            if (!id || ms < 1000 || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, label: cleanLabel(p.label, 24) || presetLabel(ms), ms });
            if (out.length >= MAX_PRESETS) break;
        }
        return out;
    }

    function sanitizeFloat(f, settings) {
        const S = settings || mergeSettings();
        const o = f && typeof f === 'object' ? f : {};
        return {
            open: !!o.open,
            x: finite(o.x) ? Math.round(Number(o.x)) : null,
            y: finite(o.y) ? Math.round(Number(o.y)) : null,
            style: FLOAT_STYLES.includes(o.style) ? o.style : S.floatStyle,
            size: FLOAT_SIZES.includes(o.size) ? o.size : S.floatSize,
            opacity: clampInt(o.opacity, 30, 100, S.floatOpacity),
            ghost: !!o.ghost
        };
    }

    function sanitizeStats(raw) {
        const days = {};
        const src = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {};
        const keys = Object.keys(src).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-STATS_DAYS);
        for (const k of keys) {
            const d = src[k] || {};
            days[k] = {
                focusMs: clampInt(d.focusMs, 0, 864e5 * 10, 0),
                pomodoros: clampInt(d.pomodoros, 0, 1e4, 0),
                completed: clampInt(d.completed, 0, 1e5, 0)
            };
        }
        return { days };
    }

    function sanitizeHistory(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const h of list) {
            if (!h || typeof h !== 'object' || !finite(h.at)) continue;
            out.push({
                id: cleanId(h.id) || ('h' + Math.floor(Number(h.at)).toString(36) + out.length),
                label: cleanLabel(h.label),
                kind: KINDS.includes(h.kind) ? h.kind : 'countdown',
                phase: PHASES.includes(h.phase) ? h.phase : null,
                ms: clampMs(h.ms),
                at: Number(h.at),
                color: isHex(h.color) ? h.color.toLowerCase() : COLORS[0],
                missed: !!h.missed
            });
            if (out.length >= HISTORY_MAX) break;
        }
        return out;
    }

    function sanitizeStore(raw, now) {
        const r = raw && typeof raw === 'object' ? raw : {};
        const settings = mergeSettings(r.settings);
        const timers = [];
        const seen = new Set();
        for (const t of Array.isArray(r.timers) ? r.timers : []) {
            const clean = sanitizeTimer(t, now, settings);
            if (!clean || seen.has(clean.id)) continue;
            seen.add(clean.id);
            timers.push(clean);
            if (timers.length >= MAX_TIMERS) break;
        }
        const floats = {};
        const rawFloats = r.floats && typeof r.floats === 'object' ? r.floats : {};
        for (const id of Object.keys(rawFloats)) {
            if (seen.has(id)) floats[id] = sanitizeFloat(rawFloats[id], settings);
        }
        return {
            version: STORE_VERSION,
            enabled: !!r.enabled,
            timers,
            presets: sanitizePresets(r.presets),
            settings,
            floats,
            history: sanitizeHistory(r.history),
            stats: sanitizeStats(r.stats),
            focusId: cleanId(r.focusId) && seen.has(r.focusId) ? r.focusId : null
        };
    }

    // ── Scheduling ──────────────────────────────────────────────────────────

    function dayKey(ts) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function warnApplies(t, settings) {
        const warnMs = settings.warnSeconds * 1000;
        return warnMs > 0 && !t.warned && t.durationMs > warnMs + 1000;
    }

    // The next instant the scheduler has to look at: a running timer's end, or
    // its heads-up, whichever comes first. null when nothing is counting down.
    function nextDue(store, now) {
        let next = null;
        const S = store.settings;
        for (const t of store.timers) {
            if (t.kind === 'stopwatch' || t.status !== 'running' || t.endAt == null) continue;
            let at = t.endAt;
            if (warnApplies(t, S)) at = Math.min(at, Math.max(now, t.endAt - S.warnSeconds * 1000));
            for (const c of t.checkpoints || []) {
                if (!c.hit && c.leftMs < t.durationMs) at = Math.min(at, Math.max(now, t.endAt - c.leftMs));
            }
            next = next == null ? at : Math.min(next, at);
        }
        return next;
    }

    function bumpDay(days, key, patch) {
        const cur = days[key] || { focusMs: 0, pomodoros: 0, completed: 0 };
        days[key] = {
            focusMs: cur.focusMs + (patch.focusMs || 0),
            pomodoros: cur.pomodoros + (patch.pomodoros || 0),
            completed: cur.completed + (patch.completed || 0)
        };
    }

    function pruneDays(days) {
        const keys = Object.keys(days).sort();
        const out = {};
        for (const k of keys.slice(-STATS_DAYS)) out[k] = days[k];
        return out;
    }

    // Runs every timer forward to `now`. Returns { store, events, changed }.
    //
    // Rules:
    //   • countdown ends → 'done' (rings), or with repeats left → next round,
    //     scheduled from the previous END so a repeating timer never drifts;
    //   • pomodoro phase ends → the next phase, started automatically or left
    //     waiting as 'done' depending on the auto-start settings;
    //   • a timer that overshot several rounds while the machine slept is caught
    //     up in one pass, and reported ONCE (with a count), never as a burst;
    //   • anything noticed more than MISSED_AFTER late is `missed` — announced,
    //     never rung.
    function scan(store, now) {
        const S = store.settings;
        const events = [];
        let changed = false;
        const days = Object.assign({}, store.stats.days);
        let history = store.history;

        const timers = store.timers.map(t0 => {
            if (t0.kind === 'stopwatch' || t0.status !== 'running' || t0.endAt == null) return t0;
            let t = t0;

            if (warnApplies(t, S) && now >= t.endAt - S.warnSeconds * 1000 && now < t.endAt) {
                t = Object.assign({}, t, { warned: true });
                changed = true;
                events.push({ type: 'warn', timerId: t.id, kind: t.kind, label: displayName(t), color: t.color, remainingMs: t.endAt - now, count: 1, missed: false });
            }

            let last = null;
            let count = 0;
            let guard = 0;
            while (t.status === 'running' && t.endAt != null && now >= t.endAt && guard++ < 1000) {
                changed = true;
                count++;
                const firedAt = t.endAt;
                const entry = { id: 'h' + firedAt.toString(36) + t.id.slice(-4) + count, label: displayName(t), kind: t.kind, phase: null, ms: t.durationMs, at: firedAt, color: t.color, missed: now - firedAt > MISSED_AFTER };

                if (t.kind === 'countdown') {
                    bumpDay(days, dayKey(firedAt), { completed: 1 });
                    const more = t.repeat !== 0 && (t.repeat < 0 || t.repeatsDone < t.repeat);
                    if (more) {
                        t = Object.assign({}, t, { repeatsDone: t.repeatsDone + 1, endAt: firedAt + t.durationMs, remainingMs: t.durationMs, warned: false, checkpoints: markCheckpoints(t.checkpoints, Infinity) });
                        last = { type: 'repeat', round: t.repeatsDone + 1, of: t.repeat < 0 ? null : t.repeat + 1 };
                    } else {
                        t = Object.assign({}, t, { status: 'done', endAt: null, remainingMs: 0, doneAt: firedAt, warned: false, checkpoints: markCheckpoints(t.checkpoints, 0) });
                        last = { type: 'done' };
                    }
                } else {
                    const finished = t.phase;
                    entry.phase = finished;
                    if (finished === 'focus') bumpDay(days, dayKey(firedAt), { focusMs: t.durationMs, pomodoros: 1 });
                    const np = nextPhase(t, S);
                    const dur = phaseMs(S, np.phase);
                    const auto = np.phase === 'focus' ? S.pomodoro.autoFocus : S.pomodoro.autoBreaks;
                    t = Object.assign({}, t, { phase: np.phase, cycle: np.cycle, durationMs: dur, warned: false });
                    if (auto) Object.assign(t, { remainingMs: dur, endAt: firedAt + dur, status: 'running', doneAt: null });
                    else Object.assign(t, { remainingMs: 0, endAt: null, status: 'done', doneAt: firedAt });
                    last = { type: 'phase', finished, next: np.phase, autoStarted: auto };
                }
                history = [entry].concat(history).slice(0, HISTORY_MAX);
                last.firedAt = firedAt;
            }

            // Checkpoints of the round that is running now. Several passed at
            // once (asleep, app closed) are one announcement for the latest.
            // A round that ended in this same pass already announced itself,
            // so its successor's already-passed checkpoints go by quietly.
            if (t.kind === 'countdown' && t.status === 'running' && t.endAt != null && (t.checkpoints || []).length) {
                const due = t.checkpoints.filter(c => !c.hit && c.leftMs < t.durationMs && now >= t.endAt - c.leftMs);
                if (due.length) {
                    changed = true;
                    t = Object.assign({}, t, { checkpoints: t.checkpoints.map(c => (due.includes(c) ? Object.assign({}, c, { hit: true }) : c)) });
                    if (!last) {
                        const latest = due[due.length - 1];
                        const firedAt = t.endAt - latest.leftMs;
                        events.push({
                            type: 'checkpoint', timerId: t.id, kind: t.kind, label: displayName(t), color: t.color,
                            checkpointLabel: latest.label, leftMs: latest.leftMs, count: due.length,
                            firedAt, missed: now - firedAt > MISSED_AFTER
                        });
                    }
                }
            }

            if (last) {
                events.push(Object.assign({
                    timerId: t.id,
                    kind: t.kind,
                    label: displayName(t),
                    color: t.color,
                    durationMs: t.durationMs,
                    count,
                    missed: now - last.firedAt > MISSED_AFTER
                }, last));
            }
            return t;
        });

        if (!changed) return { store, events, changed: false };
        return {
            store: Object.assign({}, store, { timers, history, stats: { days: pruneDays(days) } }),
            events,
            changed: true
        };
    }

    // The words for an alert — shared by the OS notification and the in-app toast.
    function describeEvent(ev, now) {
        const name = ev.label || 'Timer';
        const ago = ev.missed && ev.firedAt ? ` · ${formatHuman(Math.max(0, now - ev.firedAt))} ago` : '';
        switch (ev.type) {
            case 'warn':
                return { title: `${name} — ${formatHuman(ev.remainingMs)} left`, body: 'Heads-up: almost done.' };
            case 'checkpoint':
                return {
                    title: `${name} — ${ev.checkpointLabel || 'checkpoint'}`,
                    body: `${formatHuman(ev.leftMs)} left` + (ev.count > 1 ? ` · ${ev.count} checkpoints passed` : '') + ago
                };
            case 'repeat':
                return {
                    title: `${name} — round ${ev.round}${ev.of ? ' of ' + ev.of : ''}`,
                    body: (ev.count > 1 ? `${ev.count} rounds passed while you were away` : 'Next round started') + ago
                };
            case 'phase': {
                const next = PHASE_LABELS[ev.next] || 'Next phase';
                if (ev.finished === 'focus') {
                    return {
                        title: 'Focus session complete',
                        body: (ev.autoStarted ? `${next} started (${formatHuman(ev.durationMs)})` : `Time for a ${next.toLowerCase()} — start it when you're ready`) + ago
                    };
                }
                return {
                    title: 'Break is over',
                    body: (ev.autoStarted ? `Focus started (${formatHuman(ev.durationMs)})` : 'Start your next focus session when you\'re ready') + ago
                };
            }
            default:
                return { title: `${name} finished`, body: ev.missed ? `Finished${ago}` : "Time's up!" };
        }
    }

    // ── Stats ───────────────────────────────────────────────────────────────

    function summarize(store, now) {
        const days = (store.stats && store.stats.days) || {};
        const empty = { focusMs: 0, pomodoros: 0, completed: 0 };
        const today = days[dayKey(now)] || empty;
        const week = [];
        const base = new Date(now);
        base.setHours(12, 0, 0, 0);
        for (let i = 6; i >= 0; i--) {
            const d = new Date(base);
            d.setDate(base.getDate() - i);
            const key = dayKey(d.getTime());
            const v = days[key] || empty;
            week.push({ key, weekday: d.getDay(), focusMs: v.focusMs, pomodoros: v.pomodoros, completed: v.completed });
        }
        // Streak: consecutive days with anything finished, ending today — or
        // yesterday, so the streak doesn't read 0 first thing in the morning.
        let streak = 0;
        const cursor = new Date(base);
        const active = (k) => { const v = days[k]; return !!(v && (v.completed || v.pomodoros)); };
        if (!active(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
        while (active(dayKey(cursor.getTime())) && streak < 400) {
            streak++;
            cursor.setDate(cursor.getDate() - 1);
        }
        let totalFocusMs = 0, totalPomodoros = 0, totalCompleted = 0;
        for (const k of Object.keys(days)) {
            totalFocusMs += days[k].focusMs; totalPomodoros += days[k].pomodoros; totalCompleted += days[k].completed;
        }
        return { today, week, streak, totalFocusMs, totalPomodoros, totalCompleted };
    }

    // ── Parsing & formatting ────────────────────────────────────────────────

    const UNIT_MS = [
        [/^(h|hr|hrs|hour|hours)$/, 3600000],
        [/^(m|min|mins|minute|minutes)$/, 60000],
        [/^(s|sec|secs|second|seconds)$/, 1000]
    ];

    const IDIOMS = {
        'half an hour': 1800000,
        'half hour': 1800000,
        'an hour': 3600000,
        'one hour': 3600000,
        'an hour and a half': 5400000,
        'a quarter of an hour': 900000,
        'quarter of an hour': 900000,
        'quarter hour': 900000,
        'a minute': 60000,
        'a couple of minutes': 120000,
        'a few minutes': 180000
    };

    function okMs(ms) { return ms >= 1000 && ms <= MAX_DURATION ? Math.round(ms) : null; }

    // Understands what people type into a timer box:
    //   "10" (minutes) · "90s" · "1h30" · "1h 30m" · "2m30s" · "1.5h" · "10 min"
    //   "5:00" (m:ss) · "1:02:03" (h:mm:ss) · "half an hour"
    //   "at 17:30" · "at 5pm" · "until 9:15am"  (counts down to that clock time)
    // Returns { ms } or { ms, until } — or null when it can't be sure.
    function parseDuration(input, now) {
        const s = String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, ' ');
        if (!s) return null;

        if (IDIOMS[s]) return { ms: IDIOMS[s] };

        let m = s.match(/^(?:at|@|until|till|til|to) ?(\d{1,2})(?:[:.h](\d{2}))? ?(am|pm|a|p)?$/);
        if (m) {
            let h = Number(m[1]);
            const min = m[2] != null ? Number(m[2]) : 0;
            const ap = m[3];
            if (min > 59) return null;
            if (ap) {
                if (h < 1 || h > 12) return null;
                h = (h % 12) + (ap[0] === 'p' ? 12 : 0);
            } else if (h > 23) return null;
            const d = new Date(now);
            d.setHours(h, min, 0, 0);
            if (d.getTime() <= now) d.setDate(d.getDate() + 1);
            const ms = okMs(d.getTime() - now);
            return ms ? { ms, until: d.getTime() } : null;
        }

        m = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
        if (m) {
            let ms;
            if (m[3] != null) {
                if (Number(m[2]) > 59 || Number(m[3]) > 59) return null;
                ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
            } else {
                if (Number(m[2]) > 59) return null;
                ms = (Number(m[1]) * 60 + Number(m[2])) * 1000;
            }
            ms = okMs(ms);
            return ms ? { ms } : null;
        }

        m = s.match(/^(\d+(?:\.\d+)?)$/);
        if (m) {
            const ms = okMs(parseFloat(m[1]) * 60000);
            return ms ? { ms } : null;
        }

        const text = s.replace(/\band\b|,/g, ' ').replace(/\s+/g, ' ').trim();
        const token = /\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*/y;
        let idx = 0;
        let total = 0;
        let lastUnit = null;
        while (idx < text.length) {
            token.lastIndex = idx;
            const t = token.exec(text);
            if (!t || t[0].length === 0) return null;
            idx = token.lastIndex;
            const n = parseFloat(t[1]);
            let mult = null;
            if (t[2] === '') {
                // "1h30" / "2m30": a trailing bare number is the next unit down.
                if (idx < text.length) return null;
                if (lastUnit === 3600000) mult = 60000;
                else if (lastUnit === 60000) mult = 1000;
                else return null;
            } else {
                for (const [re, ms] of UNIT_MS) if (re.test(t[2])) { mult = ms; break; }
                if (mult == null) return null;
            }
            if (lastUnit != null && mult >= lastUnit) return null;
            total += n * mult;
            lastUnit = mult;
        }
        if (lastUnit == null) return null;
        const ms = okMs(total);
        return ms ? { ms } : null;
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    // precision: 0 = whole seconds (countdowns round UP, so "00:01" shows until
    // it really is zero), 1 = tenths, 2 = hundredths (stopwatches round DOWN).
    function formatClock(ms, precision, roundUp) {
        const v = Math.max(0, Number(ms) || 0);
        const p = precision === 1 || precision === 2 ? precision : 0;
        let totalSec, frac = '';
        if (p === 0) {
            totalSec = roundUp === false ? Math.floor(v / 1000) : Math.ceil(v / 1000);
        } else {
            const unit = p === 1 ? 100 : 10;
            const ticks = Math.floor(v / unit);
            const per = p === 1 ? 10 : 100;
            totalSec = Math.floor(ticks / per);
            frac = '.' + String(ticks % per).padStart(p, '0');
        }
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const sec = totalSec % 60;
        return (h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`) + frac;
    }

    // "1 h 30 min", "5 min", "45 s", "2 min 30 s"
    function formatHuman(ms) {
        const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const parts = [];
        if (h) parts.push(h + ' h');
        if (m) parts.push(m + ' min');
        if (s && !h) parts.push(s + ' s');
        return parts.length ? parts.join(' ') : '0 s';
    }

    // Compact chip text: "45s", "5m", "1h", "1h30m", "2m30s"
    function formatShort(ms) {
        const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        let out = '';
        if (h) out += h + 'h';
        if (m) out += m + 'm';
        if (s && !h) out += s + 's';
        return out || '0s';
    }

    // Lap table rows: split time, lap time, and which laps were best/worst.
    function lapRows(laps) {
        const rows = [];
        for (let i = 0; i < (laps || []).length; i++) {
            rows.push({ n: i + 1, total: laps[i], lap: laps[i] - (i ? laps[i - 1] : 0) });
        }
        let best = null, worst = null;
        if (rows.length >= 2) {
            for (const r of rows) {
                if (best == null || r.lap < best.lap) best = r;
                if (worst == null || r.lap > worst.lap) worst = r;
            }
        }
        return rows.map(r => Object.assign(r, { best: r === best, worst: r === worst }));
    }

    // ── Floating window geometry ────────────────────────────────────────────

    function floatDims(style, size) {
        const st = FLOAT_DIMS[style] ? style : 'ring';
        const sz = FLOAT_SIZES.includes(size) ? size : 'm';
        const [width, height] = FLOAT_DIMS[st][sz];
        return { width, height };
    }

    // Pulls a window fully back inside a display's work area (a monitor was
    // unplugged, the resolution changed, or a saved position is stale).
    function clampToArea(bounds, area) {
        const w = Math.min(bounds.width, area.width);
        const h = Math.min(bounds.height, area.height);
        const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - w);
        const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - h);
        return { x: Math.round(x), y: Math.round(y), width: w, height: h };
    }

    function cornerPosition(area, dims, corner, margin) {
        const g = Number.isFinite(margin) ? margin : 16;
        const c = CORNERS.includes(corner) ? corner : 'top-right';
        let x, y;
        if (c.endsWith('left')) x = area.x + g;
        else if (c.endsWith('right')) x = area.x + area.width - dims.width - g;
        else x = area.x + (area.width - dims.width) / 2;
        if (c.startsWith('top')) y = area.y + g;
        else if (c.startsWith('bottom')) y = area.y + area.height - dims.height - g;
        else y = area.y + (area.height - dims.height) / 2;
        return { x: Math.round(x), y: Math.round(y) };
    }

    // Moves a window to another display keeping its relative spot (a timer in
    // the top-right of one monitor lands top-right of the other).
    function mapToArea(bounds, from, to) {
        const fx = from.width > bounds.width ? (bounds.x - from.x) / (from.width - bounds.width) : 0;
        const fy = from.height > bounds.height ? (bounds.y - from.y) / (from.height - bounds.height) : 0;
        const rx = Math.min(1, Math.max(0, fx));
        const ry = Math.min(1, Math.max(0, fy));
        return clampToArea({
            x: to.x + rx * Math.max(0, to.width - bounds.width),
            y: to.y + ry * Math.max(0, to.height - bounds.height),
            width: bounds.width,
            height: bounds.height
        }, to);
    }

    return {
        STORE_VERSION, MAX_TIMERS, MAX_LAPS, MAX_PRESETS, MAX_CHECKPOINTS,
        sanitizeCheckpoints, markCheckpoints, setCheckpoints, checkpointMarks, HISTORY_MAX, MAX_DURATION, WAKE_CAP, MISSED_AFTER,
        KINDS, STATUSES, PHASES, PHASE_LABELS, COLORS, SOUNDS, WARN_OPTIONS, FLOAT_STYLES, FLOAT_SIZES, CORNERS,
        DEFAULT_SETTINGS,
        cleanLabel, cleanId, cleanAccel, newId,
        mergeSettings, phaseMs, nextPhase, cycleDots,
        sanitizeTimer, sanitizeStore, sanitizeFloat, sanitizePresets, defaultPresets,
        remaining, elapsed, progress, displayName,
        createTimer, applyAction, syncPomodoroDurations, primaryTimer,
        dayKey, nextDue, scan, describeEvent, summarize,
        parseDuration, formatClock, formatHuman, formatShort, lapRows,
        floatDims, clampToArea, cornerPosition, mapToArea
    };
});
