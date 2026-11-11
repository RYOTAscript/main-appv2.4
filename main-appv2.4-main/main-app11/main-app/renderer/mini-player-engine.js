// ── Corner player engine (pure) ──
// Loaded BOTH as a <script> in the corner player's own window
// (window.MiniPlayerEngine) and via require() from main/miniPlayer.js — one
// copy of the placement, visibility and lyric-timing rules, so the window and
// the process that moves it can never disagree. Same split as the Timers and
// Calendar engines.
//
// Nothing in here touches the DOM, Electron or the clock: every function takes
// what it needs as arguments (test/mini-player-engine.test.js).

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.MiniPlayerEngine = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const STYLES = ['glass', 'white'];
    // 'hidden' = only while the launcher is hidden or minimised; 'always' =
    // whenever something is playing.
    const SHOW_MODES = ['hidden', 'always'];

    // The card is drawn inside a transparent window with room around it for
    // its shadow. PAD must match the page's .wrap padding (mini-player.html).
    const CARD_WIDTH = 336;
    const PAD = 20;
    // Gap between the window and the edge of the usable screen area. The
    // window stays inside the work area so its transparent edge never sits over
    // the taskbar and swallows clicks meant for it.
    const EDGE = 6;
    const MIN_CARD_HEIGHT = 40;
    const MAX_CARD_HEIGHT = 400;
    // The launcher's own lyrics surface each line this long before its
    // timestamp (renderer/settings.js, "Lyrics Timing"); the corner player
    // follows the same setting so both show the same line.
    const DEFAULT_ANTICIPATE_MS = 700;
    const MAX_ANTICIPATE_MS = 2000;
    // Spotify answers every couple of seconds, and each answer is a little stale
    // by the time it lands, so taken literally the position hops back and forth
    // a few hundred ms on every poll. Under this it's that noise; at or over it,
    // somebody really moved the song.
    const DRIFT_JUMP_MS = 1500;
    // How much of that noise one poll corrects, so a real offset still melts away.
    const DRIFT_NUDGE = 0.3;
    // A long line shrinks this far to fit before it gets an ellipsis. It is also
    // the size of the "next line" row, so a line never changes length on its way
    // up.
    const MIN_LINE_SCALE = 0.8;
    const POLL_PLAYING_MS = 2500;
    const POLL_IDLE_MS = 6000;
    // Spotify not connected (or the network is down): check back quietly.
    const POLL_OFFLINE_MS = 30000;
    // Waiting for a song to end, or for a skip to show up.
    const POLL_CHASE_MS = 500;
    const POLL_EDGE_MIN_MS = 400;

    function normalizeHex(v) {
        if (typeof v !== 'string') return null;
        const s = v.trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(s)) return s;
        if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        return null;
    }

    function hexToRgb(hex) {
        const h = normalizeHex(hex) || '#ffffff';
        const n = parseInt(h.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function sanitizePrefs(raw) {
        const r = raw && typeof raw === 'object' ? raw : {};
        return {
            enabled: r.enabled === true,
            lyrics: r.lyrics !== false,
            style: STYLES.includes(r.style) ? r.style : 'glass',
            showWhen: SHOW_MODES.includes(r.showWhen) ? r.showWhen : 'hidden',
            corner: CORNERS.includes(r.corner) ? r.corner : 'bottom-right',
            displayId: Number.isFinite(r.displayId) ? r.displayId : null,
            accent: normalizeHex(r.accent) || '#ffffff',
            anticipateMs: Number.isFinite(r.anticipateMs)
                ? Math.min(MAX_ANTICIPATE_MS, Math.max(0, Math.round(r.anticipateMs)))
                : DEFAULT_ANTICIPATE_MS
        };
    }

    // Window size for a card of the given height (what the page measured).
    function windowSize(cardHeight) {
        const h = Number.isFinite(cardHeight)
            ? Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(cardHeight)))
            : 72;
        return { width: CARD_WIDTH + PAD * 2, height: h + PAD * 2 };
    }

    // Top-left of a window of `size` tucked into `corner` of `area`.
    function cornerPosition(area, size, corner) {
        const c = CORNERS.includes(corner) ? corner : 'bottom-right';
        const left = c.endsWith('left');
        const top = c.startsWith('top');
        return {
            x: Math.round(left ? area.x + EDGE : area.x + area.width - size.width - EDGE),
            y: Math.round(top ? area.y + EDGE : area.y + area.height - size.height - EDGE)
        };
    }

    // The corner of `area` a window at `bounds` is closest to, by its centre —
    // where a dragged corner player snaps when it is let go.
    function nearestCorner(bounds, area) {
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y + bounds.height / 2;
        const top = cy < area.y + area.height / 2;
        const left = cx < area.x + area.width / 2;
        return (top ? 'top' : 'bottom') + '-' + (left ? 'left' : 'right');
    }

    // Where playback is at `now`, from the last sample and when it was taken.
    function positionAt(sample, now) {
        if (!sample || !sample.track) return 0;
        const dur = Number(sample.track.durationMs) || 0;
        const base = Number(sample.progressMs) || 0;
        const at = Number(sample.at) || now;
        const p = sample.playing ? base + Math.max(0, now - at) : base;
        return dur > 0 ? Math.min(dur, Math.max(0, p)) : Math.max(0, p);
    }

    // Index of the line being sung at `positionMs`, or -1 before the first
    // line. Unsynced lyrics (no timestamps) have no current line: -1.
    function lineIndex(lines, positionMs, anticipateMs) {
        if (!Array.isArray(lines) || !lines.length) return -1;
        const lead = Number.isFinite(anticipateMs) ? anticipateMs : DEFAULT_ANTICIPATE_MS;
        let k = -1;
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i] ? lines[i].t : null;
            if (!Number.isFinite(t)) return -1;
            if (Math.max(0, t - lead) <= positionMs) k = i;
            else break;
        }
        return k;
    }

    // The window's own playback clock, which a poll corrects instead of replaces.
    // Returns the next clock and how it moved: 'track' (another song), 'state'
    // (play/pause), 'seek' (the position really jumped) or null (same song, same
    // state, nothing worth showing — the case for almost every poll).
    function followClock(clock, sample, now) {
        const heard = positionAt(sample, now);
        const track = (sample && sample.track) || null;
        const playing = !!(sample && sample.playing);
        const adopted = { track, playing, progressMs: heard, at: now };
        if (!clock || trackKey(clock.track) !== trackKey(track)) return { clock: adopted, jump: 'track' };
        if (clock.playing !== playing) return { clock: adopted, jump: 'state' };
        const held = positionAt(clock, now);
        if (Math.abs(heard - held) >= DRIFT_JUMP_MS) return { clock: adopted, jump: 'seek' };
        const progressMs = playing ? held + (heard - held) * DRIFT_NUDGE : held;
        return { clock: { track, playing, progressMs, at: now }, jump: null };
    }

    // The line to show at `positionMs`, given the one on screen (`shown`, a line
    // index, or anything else if there isn't one). A correction can pull the clock
    // back a little under a line that has only just appeared; taken literally that
    // line would drop away and come straight back. So the screen only goes back
    // for a position that is really behind — and a jump passes no `shown` at all.
    function settledLine(lines, positionMs, anticipateMs, shown) {
        const idx = lineIndex(lines, positionMs, anticipateMs);
        if (!Number.isInteger(shown) || idx >= shown || !lines[shown]) return idx;
        const lead = Number.isFinite(anticipateMs) ? anticipateMs : DEFAULT_ANTICIPATE_MS;
        const start = Math.max(0, lines[shown].t - lead);
        return positionMs > start - DRIFT_JUMP_MS ? shown : idx;
    }

    // How a line of `width` px sits in the lyric row: `room` is the free span
    // inside the card ({ left, right, centre, align }). A line that doesn't fit
    // shrinks, down to MIN_LINE_SCALE; a centred one that would run under the
    // corner buttons slides left, clear of them.
    function lyricFit(width, room) {
        const w = Number.isFinite(width) && width > 0 ? width : 0;
        const avail = room.right - room.left;
        const scale = w > avail ? Math.max(MIN_LINE_SCALE, avail / w) : 1;
        if (room.align === 'left') return { scale, shift: 0 };
        const half = Math.min(w * scale, avail) / 2;
        const centre = Math.min(room.right - half, Math.max(room.left + half, room.centre));
        return { scale, shift: Math.round(centre - room.centre) };
    }

    // The instrumental gap around `positionMs`, for the dots that fill up as the
    // next line nears: from where the rest began (the start of the song, or of the
    // empty line `idx`) to when the next line surfaces. null if nothing follows.
    function restSpan(lines, idx, positionMs, anticipateMs) {
        const lead = Number.isFinite(anticipateMs) ? anticipateMs : DEFAULT_ANTICIPATE_MS;
        const next = Array.isArray(lines) ? lines[idx + 1] : null;
        if (!next || !Number.isFinite(next.t)) return null;
        const line = lines[idx];
        const from = line && Number.isFinite(line.t) ? Math.max(0, line.t - lead) : 0;
        const to = Math.max(0, next.t - lead);
        if (to <= from) return null;
        return { durationMs: to - from, elapsedMs: Math.min(to - from, Math.max(0, positionMs - from)) };
    }

    // How long main waits before asking Spotify again. A song about to end gets
    // asked right after it does, so the next one lands on time instead of up to
    // a whole poll late.
    function pollDelay(sample, now) {
        if (!sample || !sample.connected) return POLL_OFFLINE_MS;
        if (!sample.playing || !sample.track) return POLL_IDLE_MS;
        const dur = Number(sample.track.durationMs) || 0;
        if (dur > 0) {
            const left = dur - positionAt(sample, now);
            if (left < POLL_PLAYING_MS) return Math.max(POLL_EDGE_MIN_MS, Math.ceil(left) + 150);
        }
        return POLL_PLAYING_MS;
    }

    // One step of the window easing into its corner, t from 0 to 1.
    function snapStep(from, to, t) {
        const k = t >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, t), 3);
        return {
            x: Math.round(from.x + (to.x - from.x) * k),
            y: Math.round(from.y + (to.y - from.y) * k),
            width: to.width,
            height: to.height
        };
    }

    // Whether the corner player should be on screen right now.
    function shouldShow(s) {
        if (!s || !s.enabled || !s.hasTrack) return false;
        // The full-screen lyrics stage already shows everything.
        if (s.immersive) return false;
        // "Hide until the next song".
        if (s.dismissedKey && s.dismissedKey === s.trackKey) return false;
        return s.showWhen === 'always' || !s.mainVisible;
    }

    // A stable identity for a track: its Spotify id, or (local files and
    // episodes without one) what it looks like.
    function trackKey(track) {
        if (!track) return null;
        if (track.id) return String(track.id);
        return [track.name || '', track.artist || '', track.durationMs || 0].join('|');
    }

    function formatTime(ms) {
        const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    return {
        CORNERS, STYLES, SHOW_MODES, CARD_WIDTH, PAD, EDGE, DEFAULT_ANTICIPATE_MS, MAX_ANTICIPATE_MS,
        DRIFT_JUMP_MS, DRIFT_NUDGE, MIN_LINE_SCALE,
        POLL_PLAYING_MS, POLL_IDLE_MS, POLL_OFFLINE_MS, POLL_CHASE_MS, POLL_EDGE_MIN_MS,
        normalizeHex, hexToRgb, sanitizePrefs, windowSize, cornerPosition, nearestCorner,
        positionAt, lineIndex, followClock, settledLine, lyricFit, restSpan, pollDelay, snapStep,
        shouldShow, trackKey, formatTime
    };
});
