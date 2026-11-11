// Phone Remote protocol — the ONE copy of the pairing crypto and the message
// rules, shared by the desktop app (main/phoneRemoteHost.js), the phone page on
// the website (website/public/remote/protocol.js — kept byte-identical; a test
// fails if the two drift) and the tests. UMD, no imports: it only needs the
// WebCrypto that browsers and Node both have.
//
// Security model
//   The pairing secret is 32 random bytes made by the desktop and handed to the
//   phone once, in a QR code, inside the URL FRAGMENT — the part of a URL a
//   browser never sends to a server. Everything else comes from it via HKDF:
//     room id — names the relay room. The relay sees this, never the secret.
//     key     — AES-256-GCM, so the relay only ever forwards ciphertext.
//   Each direction is bound into the AES-GCM additional data, so a message the
//   PC sent can't be bounced back at it as if a phone had sent it. Commands
//   carry a timestamp and a nonce and the PC drops repeats (ReplayGuard), so a
//   captured "skip" can't be replayed later. States carry a session id and a
//   sequence number and the phone ignores an older one, so a replayed state
//   can't wind the screen back.
//
//   The link IS the credential: anyone holding it can see what's playing and
//   control it, until the PC unpairs (which throws the secret away).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.RemoteProtocol = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const VERSION = 1;
    const TO_PHONE = 'h2p';
    const TO_HOST = 'p2h';
    const ACTIONS = ['hello', 'toggle', 'next', 'previous', 'seek', 'volume', 'like', 'shuffle', 'repeat', 'queue'];
    const REPEAT_MODES = ['off', 'context', 'track'];
    const LOOKS = ['glass', 'white'];
    const LYRIC_STATUS = ['loading', 'ready', 'none'];
    const LIMITS = {
        text: 300,              // characters kept from any title / artist / lyric line
        lyricLines: 400,
        queueItems: 20,
        maxMs: 6 * 60 * 60 * 1000,
        replayWindowMs: 2 * 60 * 1000,
    };

    const B64URL = /^[A-Za-z0-9_-]*$/;
    const SECRET = /^[A-Za-z0-9_-]{43}$/;         // 32 bytes
    const NONCE = /^[A-Za-z0-9_-]{8,32}$/;
    // A hostname with an optional port. Anything that isn't localhost is wss://.
    const RELAY_HOST = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;
    const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i;
    const HTTPS_IMAGE = /^https:\/\/[^\s"'<>\\]+$/i;

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const subtle = () => globalThis.crypto.subtle;

    // ── Encoding ────────────────────────────────────────────────────────────

    function toB64url(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function fromB64url(str) {
        if (typeof str !== 'string' || !B64URL.test(str) || str.length % 4 === 1) return null;
        const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
        const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function randomB64url(bytes) {
        const b = new Uint8Array(bytes);
        globalThis.crypto.getRandomValues(b);
        return toB64url(b);
    }

    // ── Pairing ─────────────────────────────────────────────────────────────

    function isSecret(s) { return typeof s === 'string' && SECRET.test(s); }
    function isRoom(s) { return typeof s === 'string' && SECRET.test(s); }
    function isRelayHost(h) { return typeof h === 'string' && RELAY_HOST.test(h); }

    function newSecret() { return randomB64url(32); }

    async function hkdf(secret, info) {
        const raw = fromB64url(secret);
        if (!isSecret(secret) || !raw || raw.length !== 32) throw new Error('bad secret');
        const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
        return { base, params: { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('main-phone-remote'), info: enc.encode(info) } };
    }

    /** The relay room this secret talks in. Safe to show the relay. */
    async function deriveRoom(secret) {
        const { base, params } = await hkdf(secret, 'room/v1');
        return toB64url(new Uint8Array(await subtle().deriveBits(params, base, 256)));
    }

    /** The AES-256-GCM key both ends encrypt with. Never leaves the device. */
    async function deriveKey(secret) {
        const { base, params } = await hkdf(secret, 'key/v1');
        return subtle().deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    // The phone page link. The secret rides in the fragment, which never
    // reaches the website's server; `r` names the relay.
    function buildLink(siteUrl, secret, relayHost) {
        return `${String(siteUrl).replace(/\/+$/, '')}/remote/index.html#k=${secret}&r=${encodeURIComponent(relayHost)}`;
    }

    function parseLink(hash) {
        const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
        const secret = params.get('k');
        const relay = params.get('r');
        return isSecret(secret) && isRelayHost(relay) ? { secret, relay } : null;
    }

    function relayUrl(relayHost, room, role, licenseToken) {
        const scheme = LOCAL_HOST.test(relayHost) ? 'ws' : 'wss';
        let url = `${scheme}://${relayHost}/v1/room/${room}?role=${role}`;
        if (licenseToken) url += `&lt=${encodeURIComponent(licenseToken)}`;
        return url;
    }

    // ── Envelopes ───────────────────────────────────────────────────────────

    const aad = (direction) => enc.encode(`main-phone-remote/v${VERSION}/${direction}`);

    /** Encrypt a message for one direction. Returns the text to send. */
    async function seal(key, direction, payload) {
        const iv = new Uint8Array(12);
        globalThis.crypto.getRandomValues(iv);
        const data = enc.encode(JSON.stringify(payload));
        const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(direction) }, key, data));
        return JSON.stringify({ t: 'e', v: VERSION, iv: toB64url(iv), d: toB64url(ct) });
    }

    /** Decrypt a received envelope, or null for anything that doesn't check out. */
    async function open(key, direction, text) {
        let env;
        try { env = JSON.parse(text); } catch (e) { return null; }
        if (!env || env.t !== 'e' || env.v !== VERSION) return null;
        const iv = fromB64url(env.iv);
        const ct = fromB64url(env.d);
        if (!iv || iv.length !== 12 || !ct || ct.length < 16) return null;
        try {
            const plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad(direction) }, key, ct);
            const msg = JSON.parse(dec.decode(plain));
            return msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
        } catch (e) {
            return null;
        }
    }

    // ── Commands (phone → PC) ───────────────────────────────────────────────

    // `now` lets the phone stamp commands on the PC's clock (it learns the
    // offset from each state's `ts`), so a phone whose clock is off by more than
    // the replay window is not locked out.
    function makeCommand(action, value, now = Date.now()) {
        const cmd = { k: 'cmd', a: action, ts: Math.round(now), n: randomB64url(12) };
        if (value !== undefined) cmd.v = value;
        return cmd;
    }

    const clampInt = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x)));

    /** A command the PC may act on, normalised — or null. */
    function sanitizeCommand(c) {
        if (!c || c.k !== 'cmd' || !ACTIONS.includes(c.a)) return null;
        if (!Number.isFinite(c.ts) || typeof c.n !== 'string' || !NONCE.test(c.n)) return null;
        const out = { a: c.a, ts: c.ts, n: c.n };
        switch (c.a) {
            case 'seek':
                if (!Number.isFinite(c.v)) return null;
                out.v = clampInt(c.v, 0, LIMITS.maxMs);
                break;
            case 'volume':
                if (!Number.isFinite(c.v)) return null;
                out.v = clampInt(c.v, 0, 100);
                break;
            case 'like':
            case 'shuffle':
                if (typeof c.v !== 'boolean') return null;
                out.v = c.v;
                break;
            case 'repeat':
                if (!REPEAT_MODES.includes(c.v)) return null;
                out.v = c.v;
                break;
            default:
                break;
        }
        return out;
    }

    /** Drops commands that are stale, from the future, or seen before. */
    class ReplayGuard {
        constructor(windowMs = LIMITS.replayWindowMs, max = 2048) {
            this.windowMs = windowMs;
            this.max = max;
            this.seen = new Map();   // nonce -> ts, oldest first
        }

        accept(cmd, now) {
            if (!cmd || Math.abs(now - cmd.ts) > this.windowMs || this.seen.has(cmd.n)) return false;
            this.seen.set(cmd.n, cmd.ts);
            for (const [n, ts] of this.seen) {
                if (this.seen.size <= this.max && now - ts <= this.windowMs) break;
                this.seen.delete(n);
            }
            return true;
        }
    }

    // ── What the phone shows (PC → phone) ───────────────────────────────────

    const text = (x) => (typeof x === 'string' ? x.slice(0, LIMITS.text) : '');
    const image = (x) => (typeof x === 'string' && x.length < 1000 && HTTPS_IMAGE.test(x) ? x : '');
    const ms = (x) => (Number.isFinite(x) ? clampInt(x, 0, LIMITS.maxMs) : 0);

    function sanitizeState(s) {
        if (!s || s.k !== 'state') return null;
        const t = s.track && typeof s.track === 'object' ? s.track : null;
        return {
            sid: text(s.sid).slice(0, 32),
            seq: Number.isFinite(s.seq) ? Math.max(0, Math.floor(s.seq)) : 0,
            ts: Number.isFinite(s.ts) ? Math.floor(s.ts) : 0,   // the PC's clock
            connected: s.connected === true,
            playing: s.playing === true,
            progressMs: ms(s.progressMs),
            durationMs: ms(s.durationMs),
            track: t ? { id: text(t.id).slice(0, 64), name: text(t.name), artist: text(t.artist), album: text(t.album), image: image(t.image) } : null,
            volume: Number.isFinite(s.volume) ? clampInt(s.volume, 0, 100) : null,
            shuffle: s.shuffle === true,
            repeat: REPEAT_MODES.includes(s.repeat) ? s.repeat : 'off',
            liked: s.liked === true ? true : s.liked === false ? false : null,
            look: LOOKS.includes(s.look) ? s.look : 'glass',
            lead: Number.isFinite(s.lead) ? clampInt(s.lead, 0, 2000) : 700,
            device: text(s.device).slice(0, 80),
            // Spotify's device type ("Computer", "Smartphone", "Speaker"…), for its icon.
            deviceType: typeof s.deviceType === 'string' && /^[A-Za-z]{1,20}$/.test(s.deviceType) ? s.deviceType.toLowerCase() : '',
        };
    }

    function sanitizeLyrics(l) {
        if (!l || l.k !== 'lyrics') return null;
        const lines = Array.isArray(l.lines) ? l.lines.slice(0, LIMITS.lyricLines) : [];
        return {
            key: text(l.key),
            status: LYRIC_STATUS.includes(l.status) ? l.status : 'none',
            synced: l.synced === true,
            lines: lines.map((x) => ({
                t: x && Number.isFinite(x.t) ? ms(x.t) : null,
                text: text(x && x.text),
            })),
        };
    }

    function sanitizeQueue(q) {
        if (!q || q.k !== 'queue') return null;
        const items = Array.isArray(q.items) ? q.items.slice(0, LIMITS.queueItems) : [];
        return {
            ok: q.ok === true,
            items: items.filter((x) => x && typeof x === 'object').map((x) => ({
                name: text(x.name), artist: text(x.artist), image: image(x.image), durationMs: ms(x.durationMs),
            })),
        };
    }

    // ── Shared player helpers ───────────────────────────────────────────────

    /** Index of the line playing at positionMs (lines show `leadMs` early), or -1. */
    function lineIndex(lines, positionMs, leadMs) {
        let idx = -1;
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].t;
            if (t == null) continue;
            if (Math.max(0, t - leadMs) <= positionMs) idx = i;
            else break;
        }
        return idx;
    }

    function formatTime(msValue) {
        const s = Math.max(0, Math.floor((Number(msValue) || 0) / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    return {
        VERSION, TO_PHONE, TO_HOST, ACTIONS, REPEAT_MODES, LOOKS, LIMITS,
        toB64url, fromB64url, isSecret, isRoom, isRelayHost,
        newSecret, deriveRoom, deriveKey, buildLink, parseLink, relayUrl,
        seal, open, makeCommand, sanitizeCommand, ReplayGuard,
        sanitizeState, sanitizeLyrics, sanitizeQueue, lineIndex, formatTime,
    };
}));
