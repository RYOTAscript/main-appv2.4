// main Phone Remote — the phone page. index.html says what it is; protocol.js
// holds the crypto. Everything the PC sends is opened, checked
// (protocol.js sanitize*) and drawn with textContent — nothing from the wire
// ever becomes markup.
//
// Connection: one WebSocket to the relay room (the room id comes from the
// pairing secret; the relay never sees the secret or anything readable). A
// ping every 25 s keeps it open; iOS freezes a page in the background, so on
// coming back the socket is checked and, if it went quiet, replaced.
//
// Sideways: turning the phone shows the full-screen stage (big art + controls
// beside big lyrics). The button in the top bar shows it too, turned with CSS,
// for a phone with rotation lock on — then the sliders' touch maths has to be
// turned with it (pointerFraction).
//
// Motion is iOS's: springs live in remote.css (--spring, --bouncy, --smooth);
// the few one-off effects here (a skip nudging, a symbol bouncing, a new song
// rising in) use the same curves through WAAPI, and all of it stands down
// for "Reduce Motion".
(() => {
    'use strict';

    const P = window.RemoteProtocol;
    const STORE_KEY = 'mainRemote.pairing.v1';
    const LOOK_KEY = 'mainRemote.look.v1';
    const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
    const PING_MS = 25000;
    const STALE_MS = 70000;          // nothing heard for this long: reconnect
    const LOCAL_HOLD_MS = 1800;      // a tap's result outlives a state that hasn't caught up
    const VOLUME_DEBOUNCE_MS = 140;
    const TURN_KEY = 'mainRemote.turn.v1';
    // A phone held sideways (a tablet or a desktop window keeps the tall layout).
    const LANDSCAPE = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
    const PORTRAIT = window.matchMedia('(orientation: portrait)');
    const CALM = window.matchMedia('(prefers-reduced-motion: reduce)');
    const SPRING = 'linear(0, 0.0392, 0.1326, 0.2522, 0.3789, 0.5008, 0.6109, 0.7059, 0.7849, 0.8484, 0.8979, 0.9354, 0.9628, 0.9821, 0.9951, 1.0034, 1.0082, 1.0105, 1.0111, 1.0107, 1.0097, 1.0083, 1.0069, 1.0056, 1.0043, 1.0033, 1.0024, 1.0017, 1)';
    const BOUNCY = 'linear(0, 0.0567, 0.1923, 0.3638, 0.5402, 0.7009, 0.8348, 0.9375, 1.0095, 1.0543, 1.0771, 1.0835, 1.0788, 1.0675, 1.0531, 1.0384, 1.025, 1.0138, 1.0052, 0.9992, 0.9955, 0.9936, 0.993, 0.9934, 0.9944, 0.9956, 0.9968, 0.9979, 1)';
    const LYRIC_STAGGER_MS = 46;     // each line below the singing one moves this much later
    const LYRIC_WINDOW = 12;         // lines further away than this are hidden and still

    const $ = (id) => document.getElementById(id);
    const ui = {
        pair: $('pair-screen'), player: $('player-screen'), conn: $('conn'),
        title: $('title'), artist: $('artist'), cover: $('cover'), label: $('label'),
        bgA: $('bg-a'), bgB: $('bg-b'), like: $('like'),
        tabLyrics: $('tab-lyrics'), tabQueue: $('tab-queue'),
        lyricsView: $('lyrics-view'), lines: $('lines'), lyricsMsg: $('lyrics-msg'),
        queueView: $('queue-view'), queue: $('queue'), queueSub: $('queue-sub'),
        seek: $('seek'), seekFill: $('seek-fill'), seekBar: $('seek-bar'),
        volumeFill: $('volume-fill'), volumeBar: $('volume-bar'), tabThumb: $('tab-thumb'),
        elapsed: $('elapsed'), remain: $('remain'),
        shuffle: $('shuffle'), prev: $('prev'), play: $('play'), next: $('next'), repeat: $('repeat'),
        volume: $('volume'), device: $('device'),
        devIcons: { computer: $('dev-computer'), phone: $('dev-phone'), speaker: $('dev-speaker') },
        stageBtn: $('stage-btn'), stageFlip: $('stage-flip'), stageExit: $('stage-exit'),
        menuBtn: $('menu-btn'), sheet: $('sheet'), unpair: $('unpair'), sheetClose: $('sheet-close'),
        installHint: $('install-hint'),
    };

    const app = {
        pairing: null, key: null, room: null,
        ws: null, retry: 0, retryTimer: null, pingTimer: null, lastHeard: 0,
        conn: 'idle',               // idle | connecting | waiting | live | reconnecting | full
        state: null, stateAt: 0, clockOffset: 0, sid: '', seq: 0,
        holds: {},
        lyrics: null, lineEls: [], lineIdx: -2,
        queue: null, tab: 'lyrics',
        look: 'pc',
        seeking: null,
        raf: 0, lastSecond: -1,
        art: '', bgFront: null,
        volumeTimer: null, unpairArmed: false,
        stageForced: false,         // the full-screen button was pressed
        turn: 'cw',                 // which way a forced stage is turned: cw | ccw
        stageClass: '',             // what applyStage last put on <body>
        wakeLock: null,
        volume: 50, volDragging: false,
        sheetTimer: null,
    };

    // A one-off spring on an element, unless the phone asks for less motion.
    function motion(el, frames, options) {
        if (!el || CALM.matches || typeof el.animate !== 'function') return null;
        return el.animate(frames, Object.assign({ duration: 570, easing: SPRING }, options));
    }

    // ── Pairing ─────────────────────────────────────────────────────────────

    function storage(fn) {
        try { return fn(window.localStorage); } catch (e) { return null; }
    }

    // The fragment first (a fresh scan), then what this browser remembers. The
    // fragment is left in the address on purpose: iOS "Add to Home Screen"
    // saves the address, and the home-screen app has storage of its own.
    function loadPairing() {
        const fromLink = P.parseLink(location.hash);
        if (fromLink) {
            storage((s) => s.setItem(STORE_KEY, JSON.stringify(fromLink)));
            return fromLink;
        }
        const saved = storage((s) => JSON.parse(s.getItem(STORE_KEY) || 'null'));
        return saved && P.isSecret(saved.secret) && P.isRelayHost(saved.relay) ? saved : null;
    }

    function unpair() {
        storage((s) => s.removeItem(STORE_KEY));
        history.replaceState(null, '', location.pathname);
        app.pairing = null;
        app.key = null;
        disconnect();
        closeSheet();
        showScreen('pair');
    }

    // ── Connection ──────────────────────────────────────────────────────────

    function setConn(state) {
        app.conn = state;
        const text = {
            connecting: 'Connecting…',
            reconnecting: 'Reconnecting…',
            waiting: 'Your PC is offline. Open main on it.',
            full: 'Too many phones are connected',
        }[state] || '';
        ui.conn.textContent = text;
        ui.conn.hidden = !text;
        ui.conn.classList.toggle('is-down', state === 'waiting' || state === 'full');
    }

    function connect() {
        clearTimeout(app.retryTimer);
        app.retryTimer = null;
        if (app.ws || !app.pairing || !app.room) return;
        if (app.conn !== 'reconnecting') setConn('connecting');
        let ws;
        try {
            ws = new WebSocket(P.relayUrl(app.pairing.relay, app.room, 'phone'));
        } catch (e) {
            scheduleRetry();
            return;
        }
        app.ws = ws;
        ws.onopen = () => {
            if (app.ws !== ws) return;
            app.retry = 0;
            app.lastHeard = Date.now();
            clearInterval(app.pingTimer);
            app.pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}');
                if (Date.now() - app.lastHeard > STALE_MS) ws.close();
            }, PING_MS);
        };
        ws.onmessage = (ev) => { if (app.ws === ws) onMessage(ev.data); };
        ws.onclose = (ev) => {
            if (app.ws !== ws) return;
            app.ws = null;
            clearInterval(app.pingTimer);
            setConn(ev.code === 4001 ? 'full' : 'reconnecting');
            scheduleRetry();
        };
        ws.onerror = () => {};   // a close always follows
    }

    function scheduleRetry() {
        clearTimeout(app.retryTimer);
        if (!app.pairing) return;
        const delay = RETRY_MS[Math.min(app.retry, RETRY_MS.length - 1)];
        app.retry++;
        app.retryTimer = setTimeout(connect, document.hidden ? Math.max(delay, 15000) : delay);
    }

    function disconnect() {
        clearTimeout(app.retryTimer);
        clearInterval(app.pingTimer);
        const ws = app.ws;
        app.ws = null;
        if (ws) { try { ws.close(1000); } catch (e) { /* closing */ } }
    }

    // Coming back from the background: iOS may have frozen the page with the
    // socket half-dead. Check it, and fetch a fresh state either way.
    function wake() {
        if (!app.pairing || !app.room) return;
        if (!app.ws) { app.retry = 0; connect(); return; }
        if (Date.now() - app.lastHeard > STALE_MS) { app.ws.close(); return; }
        send('hello');
    }

    async function send(action, value) {
        const ws = app.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || !app.key) return false;
        const cmd = P.makeCommand(action, value, Date.now() + app.clockOffset);
        ws.send(await P.seal(app.key, P.TO_HOST, cmd));
        return true;
    }

    async function onMessage(text) {
        app.lastHeard = Date.now();
        if (typeof text !== 'string' || text[0] !== '{') return;
        let frame;
        try { frame = JSON.parse(text); } catch (e) { return; }
        if (frame.t === 'pong') return;
        if (frame.t === 'host') {
            if (frame.online) { setConn('live'); send('hello'); } else { setConn('waiting'); }
            return;
        }
        if (frame.t !== 'e' || !app.key) return;
        const msg = await P.open(app.key, P.TO_PHONE, text);
        if (!msg) return;
        if (msg.k === 'state') onState(P.sanitizeState(msg));
        else if (msg.k === 'lyrics') onLyrics(P.sanitizeLyrics(msg));
        else if (msg.k === 'queue') onQueue(P.sanitizeQueue(msg));
    }

    // ── State ───────────────────────────────────────────────────────────────

    function onState(s) {
        if (!s) return;
        // Order: never let an older state (or a replayed one) wind the screen back.
        if (app.state && s.sid === app.sid && s.seq <= app.seq) return;
        if (app.state && s.ts && s.ts < app.state.ts - 5000) return;
        app.sid = s.sid;
        app.seq = s.seq;
        const now = Date.now();
        app.clockOffset = s.ts ? s.ts - now : 0;
        // Something just tapped here is still on its way to Spotify.
        for (const [field, hold] of Object.entries(app.holds)) {
            if (now >= hold.until) { delete app.holds[field]; continue; }
            if (field === 'progressMs') s.progressMs = hold.value + (s.playing ? now - hold.at : 0);
            else s[field] = hold.value;
        }
        const trackChanged = !app.state || trackId(app.state) !== trackId(s);
        const firstState = !app.state;
        app.state = s;
        app.stateAt = now;
        if (app.conn !== 'live') setConn('live');
        render();
        // A new song rises into place, as the Now Playing card does on iOS.
        if (trackChanged && !firstState) {
            motion(ui.title, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }]);
            motion(ui.artist, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { delay: 50, fill: 'backwards' });
        }
        if (trackChanged && app.tab === 'queue') send('queue');
    }

    const trackId = (s) => (s && s.track ? s.track.id || `${s.track.name}|${s.track.artist}` : '');

    function hold(field, value) {
        const now = Date.now();
        app.holds[field] = { value, at: now, until: now + LOCAL_HOLD_MS };
        if (app.state) app.state[field] = value;
    }

    function position() {
        const s = app.state;
        if (!s || !s.track) return 0;
        const pos = s.progressMs + (s.playing ? Date.now() - app.stateAt : 0);
        return Math.max(0, s.durationMs ? Math.min(s.durationMs, pos) : pos);
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    function effectiveLook() {
        if (app.look === 'glass' || app.look === 'white') return app.look;
        return app.state && app.state.look === 'white' ? 'white' : 'glass';
    }

    function applyLook() {
        const look = effectiveLook();
        document.body.classList.toggle('look-white', look === 'white');
        document.body.classList.toggle('look-glass', look !== 'white');
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', look === 'white' ? '#F2F2EF' : '#05060A');
        document.querySelectorAll('.seg-btn').forEach((b) => {
            const on = b.dataset.look === app.look;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    function render() {
        const s = app.state;
        applyLook();
        const track = s && s.track;
        document.body.classList.toggle('is-playing', !!(s && s.playing));
        document.body.classList.toggle('is-paused', !(s && s.playing));

        ui.title.textContent = track ? track.name : (s && !s.connected ? 'Spotify isn’t connected' : 'Not playing');
        // A single's album is the song again: say it once.
        const album = track && track.album && track.album !== track.name ? ` · ${track.album}` : '';
        ui.artist.textContent = track ? track.artist + album : (s && !s.connected ? 'Connect it in main on your PC' : 'Play something on your PC');
        ui.device.textContent = s && s.device ? s.device : 'your PC';
        const kind = deviceKind(s);
        // An <svg> has no .hidden property (that is HTML-only): set the attribute.
        for (const [name, icon] of Object.entries(ui.devIcons)) icon.toggleAttribute('hidden', name !== kind);
        setArt(track ? track.image : '');

        const liked = !!(s && s.liked);
        ui.like.classList.toggle('is-on', liked);
        ui.like.setAttribute('aria-pressed', liked ? 'true' : 'false');
        ui.like.setAttribute('aria-label', liked ? 'Remove from Liked Songs' : 'Add to Liked Songs');
        ui.like.disabled = !(track && track.id);

        const shuffle = !!(s && s.shuffle);
        ui.shuffle.classList.toggle('is-on', shuffle);
        ui.shuffle.setAttribute('aria-pressed', shuffle ? 'true' : 'false');
        const repeat = (s && s.repeat) || 'off';
        ui.repeat.classList.toggle('is-on', repeat !== 'off');
        ui.repeat.classList.toggle('is-track', repeat === 'track');
        ui.repeat.setAttribute('aria-label', { off: 'Repeat: off', context: 'Repeat: all', track: 'Repeat: this song' }[repeat]);
        ui.play.setAttribute('aria-label', s && s.playing ? 'Pause' : 'Play');

        if (s && Number.isFinite(s.volume) && !app.holds.volume && !app.volDragging) showVolume(s.volume);

        renderLyrics();
        tickOnce();
        scheduleTick();
    }

    // Which icon goes with the device Spotify is playing on. Older PCs don't
    // send its type, so its name is the fallback.
    function deviceKind(s) {
        const type = (s && s.deviceType) || '';
        if (/smartphone|tablet/.test(type)) return 'phone';
        if (/speaker|avr|audiodongle|castaudio|tv|castvideo|stb|gameconsole|automobile/.test(type)) return 'speaker';
        if (type) return 'computer';
        const name = (s && s.device) || '';
        if (/iphone|ipad|android|pixel|galaxy|phone/i.test(name)) return 'phone';
        if (/speaker|sonos|echo|homepod|tv|chromecast/i.test(name)) return 'speaker';
        return 'computer';
    }

    function setArt(url) {
        if (url === app.art) return;
        const hadArt = !!app.art;
        app.art = url;
        // The new sleeve settles in with a little give.
        if (url && hadArt) motion(ui.cover.parentElement, [{ transform: 'scale(0.9)' }, { transform: 'none' }], { duration: 730, easing: BOUNCY });
        for (const img of [ui.cover, ui.label]) {
            img.classList.remove('is-on');
            if (url) {
                img.onload = () => { if (app.art === url) img.classList.add('is-on'); };
                img.src = url;
            } else {
                img.removeAttribute('src');
            }
        }
        // The blurred backdrop cross-fades between two layers.
        const next = app.bgFront === ui.bgA ? ui.bgB : ui.bgA;
        const prev = app.bgFront;
        if (url) {
            next.onload = () => {
                if (app.art !== url) return;
                next.classList.add('is-on');
                if (prev) prev.classList.remove('is-on');
            };
            next.src = url;
            app.bgFront = next;
        } else if (prev) {
            prev.classList.remove('is-on');
            app.bgFront = null;
        }
    }

    // Lyrics: every line built once per song, then the current one is chased
    // by moving the column (like the launcher's full-screen stage).
    function onLyrics(l) {
        if (!l) return;
        app.lyrics = l;
        app.lineEls = [];
        app.lineIdx = -2;
        ui.lines.replaceChildren();
        renderLyrics();
        tickOnce();
    }

    function renderLyrics() {
        const s = app.state;
        const l = app.lyrics;
        const msg = (title, sub) => {
            ui.lines.hidden = true;
            ui.lyricsMsg.hidden = false;
            const b = document.createElement('b');
            b.textContent = title;
            const span = document.createElement('span');
            span.textContent = sub || '';
            ui.lyricsMsg.replaceChildren(b, span);
        };
        if (!s || !s.track) { msg('Nothing playing', 'Start a song in Spotify and its lyrics show up here.'); return; }
        if (!l || l.key !== trackId(s) || l.status === 'loading') { msg('Finding lyrics…', s.track.name); return; }
        if (l.status !== 'ready' || !l.lines.length) { msg('No lyrics for this song', 'There are no lyrics for it yet.'); return; }
        ui.lyricsMsg.hidden = true;
        ui.lines.hidden = false;
        if (app.lineEls.length) return;
        ui.lines.classList.toggle('is-static', !l.synced);
        const frag = document.createDocumentFragment();
        app.lineEls = l.lines.map((line, i) => {
            const div = document.createElement('div');
            div.className = 'line';
            if (!line.text.trim()) {
                const rest = document.createElement('span');
                rest.className = 'rest';
                rest.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
                div.appendChild(rest);
            } else {
                div.textContent = line.text;
            }
            if (l.synced && line.t != null) div.addEventListener('click', () => seekTo(line.t));
            frag.appendChild(div);
            return div;
        });
        ui.lines.appendChild(frag);
        app.lineIdx = -2;
    }

    // Apple Music's ripple: a step to the next line lets each line below the
    // singing one leave a beat after the one above it; a jump (a seek, a new
    // song, a layout change) moves everything at once.
    function setLine(idx) {
        if (idx === app.lineIdx || !app.lineEls.length) return;
        const step = app.lineIdx >= -1 && idx - app.lineIdx === 1;
        app.lineIdx = idx;
        const at = Math.max(0, idx);
        app.lineEls.forEach((el, i) => {
            const d = i - idx;
            el.classList.toggle('is-on', d === 0);
            el.classList.toggle('is-past', idx >= 0 && d < 0);
            el.classList.toggle('d1', d === 1);
            el.classList.toggle('d2', d === 2);
            el.classList.toggle('d3', d === 3);
            el.classList.toggle('is-out', Math.abs(i - at) > LYRIC_WINDOW);
            const delay = step && d >= 0 && d <= 8 ? d * LYRIC_STAGGER_MS : 0;
            el.style.setProperty('--ld', `${delay}ms`);
        });
        const target = app.lineEls[at];
        if (!target) return;
        const y = ui.lyricsView.clientHeight * 0.42 - (target.offsetTop + target.offsetHeight / 2);
        ui.lines.style.setProperty('--ly', `${Math.round(y)}px`);
    }

    // ── The clock: progress bar, times, the current lyric line ──────────────

    function tickOnce() {
        const s = app.state;
        const dur = s && s.durationMs ? s.durationMs : 0;
        const pos = app.seeking != null ? app.seeking : position();
        const frac = dur ? Math.min(1, pos / dur) : 0;
        ui.seekFill.style.transform = `scaleX(${frac})`;
        const second = Math.floor(pos / 1000);
        if (second !== app.lastSecond || app.seeking != null) {
            app.lastSecond = second;
            ui.elapsed.textContent = P.formatTime(pos);
            ui.remain.textContent = `-${P.formatTime(Math.max(0, dur - pos))}`;
            ui.seek.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
            ui.seek.setAttribute('aria-valuetext', `${P.formatTime(pos)} of ${P.formatTime(dur)}`);
        }
        const l = app.lyrics;
        if (l && l.synced && app.lineEls.length && s && s.track && l.key === trackId(s)) {
            setLine(P.lineIndex(l.lines, pos, s.lead));
        }
    }

    function scheduleTick() {
        cancelAnimationFrame(app.raf);
        app.raf = 0;
        const running = !document.hidden && app.state && (app.state.playing || app.seeking != null);
        if (!running) return;
        const loop = () => {
            tickOnce();
            app.raf = requestAnimationFrame(loop);
        };
        app.raf = requestAnimationFrame(loop);
    }

    // ── Up next ─────────────────────────────────────────────────────────────

    function onQueue(q) {
        if (!q) return;
        app.queue = q;
        renderQueue();
    }

    function queueRow(item, isNow) {
        const row = document.createElement('div');
        row.className = isNow ? 'qrow is-now' : 'qrow';
        const art = document.createElement('span');
        art.className = 'qart';
        if (item.image) {
            const img = document.createElement('img');
            img.alt = '';
            img.src = item.image;
            img.onerror = () => img.remove();
            art.appendChild(img);
        }
        const text = document.createElement('span');
        text.className = 'qtext';
        const name = document.createElement('div');
        name.className = 'qname ellip';
        name.textContent = item.name || '—';
        const meta = document.createElement('div');
        meta.className = 'qmeta ellip';
        meta.textContent = item.artist || '';
        text.append(name, meta);
        row.append(art, text);
        if (isNow) {
            const eq = document.createElement('span');
            eq.className = 'eq';
            eq.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
            row.appendChild(eq);
        } else if (item.durationMs) {
            const dur = document.createElement('span');
            dur.className = 'qdur';
            dur.textContent = P.formatTime(item.durationMs);
            row.appendChild(dur);
        }
        return row;
    }

    function renderQueue() {
        const s = app.state;
        const q = app.queue;
        const rows = [];
        if (s && s.track) rows.push(queueRow(s.track, true));
        if (q && q.ok) q.items.forEach((item) => rows.push(queueRow(item, false)));
        const fresh = !ui.queue.childElementCount;
        ui.queue.replaceChildren(...rows);
        // The list arrives as a cascade the first time it fills.
        if (fresh) rows.slice(0, 10).forEach((row, i) => motion(row, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { delay: i * 35, fill: 'backwards' }));
        ui.queueSub.textContent = !q ? 'Loading…'
            : !q.ok ? 'Play something on your PC to see what’s next'
                : q.items.length ? `${q.items.length} song${q.items.length === 1 ? '' : 's'} after this one`
                    : 'Nothing queued after this song';
    }

    // The segmented control's pill slides to the chosen tab.
    function placeThumb() {
        const on = app.tab === 'queue' ? ui.tabQueue : ui.tabLyrics;
        if (!on.offsetWidth) return;
        ui.tabThumb.style.setProperty('--thumb-x', `${on.offsetLeft}px`);
        ui.tabThumb.style.setProperty('--thumb-w', `${on.offsetWidth}px`);
    }

    function setTab(tab) {
        app.tab = tab;
        const queue = tab === 'queue';
        ui.tabLyrics.classList.toggle('is-on', !queue);
        ui.tabQueue.classList.toggle('is-on', queue);
        placeThumb();
        ui.tabLyrics.setAttribute('aria-selected', String(!queue));
        ui.tabQueue.setAttribute('aria-selected', String(queue));
        ui.lyricsView.hidden = queue;
        ui.queueView.hidden = !queue;
        if (queue) {
            renderQueue();
            send('queue');
        } else {
            app.lineIdx = -2;
            tickOnce();
        }
    }

    // ── Controls ────────────────────────────────────────────────────────────

    function togglePlay() {
        const s = app.state;
        if (!s || !s.track) return;
        const pos = position();
        s.progressMs = pos;
        app.stateAt = Date.now();
        hold('playing', !s.playing);
        app.holds.progressMs = { value: pos, at: Date.now(), until: Date.now() + LOCAL_HOLD_MS };
        render();
        send('toggle');
    }

    function seekTo(ms) {
        const s = app.state;
        if (!s || !s.track) return;
        const v = Math.max(0, Math.min(s.durationMs || ms, Math.round(ms)));
        s.progressMs = v;
        app.stateAt = Date.now();
        app.holds.progressMs = { value: v, at: Date.now(), until: Date.now() + LOCAL_HOLD_MS };
        app.lineIdx = -2;
        tickOnce();
        send('seek', v);
    }

    // Where along the bar a finger is. On a stage turned with CSS the bar runs
    // up or down the physical screen, so the finger's other axis is the one
    // that counts.
    function pointerFraction(el, ev) {
        const r = el.getBoundingClientRect();
        const turned = document.body.classList.contains('is-turned');
        let frac;
        if (turned && app.turn === 'cw') frac = r.height ? (ev.clientY - r.top) / r.height : 0;
        else if (turned) frac = r.height ? (r.bottom - ev.clientY) / r.height : 0;
        else frac = r.width ? (ev.clientX - r.left) / r.width : 0;
        return Math.min(1, Math.max(0, frac));
    }

    function seekFromPointer(ev) {
        return pointerFraction(ui.seek, ev) * ((app.state && app.state.durationMs) || 0);
    }

    // Dragged past either end, a bar stretches a little that way, like rubber,
    // and springs back when let go (the CSS transition on .bar).
    function rubberBand(el, bar, ev) {
        const r = el.getBoundingClientRect();
        const turned = document.body.classList.contains('is-turned');
        const along = turned ? r.height : r.width;
        if (!along) return;
        let raw;
        if (turned && app.turn === 'cw') raw = (ev.clientY - r.top) / along;
        else if (turned) raw = (r.bottom - ev.clientY) / along;
        else raw = (ev.clientX - r.left) / along;
        const over = raw < 0 ? -raw : raw > 1 ? raw - 1 : 0;
        if (!over) { bar.style.transform = ''; return; }
        const stretch = 1 + Math.min(0.06, over * 0.25);
        bar.style.transformOrigin = raw < 0 ? 'right center' : 'left center';
        bar.style.transform = `scaleX(${stretch})`;
    }

    function wireSeek() {
        ui.seek.addEventListener('pointerdown', (ev) => {
            if (!app.state || !app.state.track) return;
            ui.seek.setPointerCapture(ev.pointerId);
            ui.seek.classList.add('is-dragging');
            app.seeking = seekFromPointer(ev);
            tickOnce();
            scheduleTick();
        });
        ui.seek.addEventListener('pointermove', (ev) => {
            if (app.seeking == null) return;
            app.seeking = seekFromPointer(ev);
            rubberBand(ui.seek, ui.seekBar, ev);
            tickOnce();
        });
        const end = (ev, commit) => {
            if (app.seeking == null) return;
            const ms = ev && commit ? seekFromPointer(ev) : app.seeking;
            app.seeking = null;
            ui.seek.classList.remove('is-dragging');
            ui.seekBar.style.transform = '';
            if (commit) seekTo(ms);
            scheduleTick();
        };
        ui.seek.addEventListener('pointerup', (ev) => end(ev, true));
        ui.seek.addEventListener('pointercancel', () => end(null, false));
        ui.seek.addEventListener('keydown', (ev) => {
            if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
                ev.preventDefault();
                seekTo(position() + (ev.key === 'ArrowRight' ? 5000 : -5000));
            }
        });
    }

    function wireControls() {
        ui.play.addEventListener('click', togglePlay);
        // The skip glyphs nudge the way they point, then spring back.
        const nudge = (btn, dx) => motion(btn.firstElementChild, [
            { transform: 'translateX(0)' }, { transform: `translateX(${dx}px)`, offset: 0.3 }, { transform: 'translateX(0)' },
        ], { duration: 520, easing: 'ease-out' });
        const bounce = (btn) => motion(btn.firstElementChild, [{ transform: 'scale(0.7)' }, { transform: 'none' }], { duration: 730, easing: BOUNCY });
        ui.prev.addEventListener('click', () => { nudge(ui.prev, -7); send('previous'); });
        ui.next.addEventListener('click', () => { nudge(ui.next, 7); send('next'); });
        ui.shuffle.addEventListener('click', () => {
            if (!app.state) return;
            hold('shuffle', !app.state.shuffle);
            render();
            bounce(ui.shuffle);
            send('shuffle', app.state.shuffle);
        });
        ui.repeat.addEventListener('click', () => {
            if (!app.state) return;
            const order = P.REPEAT_MODES;
            const next = order[(order.indexOf(app.state.repeat) + 1) % order.length];
            hold('repeat', next);
            render();
            bounce(ui.repeat);
            send('repeat', next);
        });
        ui.like.addEventListener('click', () => {
            const s = app.state;
            if (!s || !s.track || !s.track.id) return;
            const liked = !s.liked;
            hold('liked', liked);
            // The heart bounces as an SF Symbol does when it fills.
            motion(ui.like.firstElementChild, liked
                ? [{ transform: 'scale(0.6)' }, { transform: 'scale(1.25)', offset: 0.45 }, { transform: 'none' }]
                : [{ transform: 'scale(0.85)' }, { transform: 'none' }], { duration: 730, easing: liked ? 'ease-out' : BOUNCY });
            render();
            send('like', liked);
        });
        wireVolume();
        ui.tabLyrics.addEventListener('click', () => setTab('lyrics'));
        ui.tabQueue.addEventListener('click', () => setTab('queue'));
        wireSeek();
    }

    // ── The ⋯ sheet ─────────────────────────────────────────────────────────

    // ── Volume ──────────────────────────────────────────────────────────────
    // The same knob-less bar as the scrubber.

    function showVolume(v) {
        app.volume = Math.max(0, Math.min(100, Math.round(v)));
        ui.volumeFill.style.transform = `scaleX(${app.volume / 100})`;
        ui.volume.setAttribute('aria-valuenow', String(app.volume));
    }

    function setVolume(v) {
        showVolume(v);
        hold('volume', app.volume);
        clearTimeout(app.volumeTimer);
        const value = app.volume;
        app.volumeTimer = setTimeout(() => send('volume', value), VOLUME_DEBOUNCE_MS);
    }

    function wireVolume() {
        const fromPointer = (ev) => pointerFraction(ui.volume, ev) * 100;
        ui.volume.addEventListener('pointerdown', (ev) => {
            ui.volume.setPointerCapture(ev.pointerId);
            ui.volume.classList.add('is-dragging');
            app.volDragging = true;
            setVolume(fromPointer(ev));
        });
        ui.volume.addEventListener('pointermove', (ev) => {
            if (!app.volDragging) return;
            setVolume(fromPointer(ev));
            rubberBand(ui.volume, ui.volumeBar, ev);
        });
        const end = () => {
            if (!app.volDragging) return;
            app.volDragging = false;
            ui.volume.classList.remove('is-dragging');
            ui.volumeBar.style.transform = '';
        };
        ui.volume.addEventListener('pointerup', end);
        ui.volume.addEventListener('pointercancel', end);
        ui.volume.addEventListener('keydown', (ev) => {
            if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { ev.preventDefault(); setVolume(app.volume + 5); }
            if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { ev.preventDefault(); setVolume(app.volume - 5); }
        });
    }

    function openSheet() {
        clearTimeout(app.sheetTimer);
        ui.sheet.classList.remove('is-closing');
        const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
        ui.installHint.hidden = standalone;
        app.unpairArmed = false;
        ui.unpair.classList.remove('is-armed');
        ui.unpair.textContent = 'Unpair this phone';
        ui.sheet.hidden = false;
    }

    // It slides back down before it goes.
    function closeSheet() {
        if (ui.sheet.hidden || ui.sheet.classList.contains('is-closing')) return;
        if (CALM.matches) { ui.sheet.hidden = true; return; }
        ui.sheet.classList.add('is-closing');
        app.sheetTimer = setTimeout(() => {
            ui.sheet.hidden = true;
            ui.sheet.classList.remove('is-closing');
        }, 280);
    }

    function wireSheet() {
        ui.menuBtn.addEventListener('click', openSheet);
        ui.sheetClose.addEventListener('click', closeSheet);
        ui.sheet.addEventListener('click', (ev) => { if (ev.target === ui.sheet) closeSheet(); });
        document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
            app.look = b.dataset.look;
            storage((s) => s.setItem(LOOK_KEY, app.look));
            applyLook();
        }));
        // Two taps, so a stray one can't unpair.
        ui.unpair.addEventListener('click', () => {
            if (!app.unpairArmed) {
                app.unpairArmed = true;
                ui.unpair.classList.add('is-armed');
                ui.unpair.textContent = 'Tap again to unpair';
                return;
            }
            unpair();
        });
    }

    // ── Sideways full screen ────────────────────────────────────────────────

    function applyStage() {
        const landscape = LANDSCAPE.matches;
        const on = app.stageForced || landscape;
        // Only a forced stage on an upright phone needs turning with CSS; a
        // phone that has really turned lays it out sideways by itself.
        const turned = app.stageForced && PORTRAIT.matches;
        const cls = on ? (turned ? `stage turned ${app.turn}` : 'stage') : '';
        if (cls === app.stageClass) return;
        app.stageClass = cls;
        document.body.classList.toggle('is-stage', on);
        document.body.classList.toggle('is-turned', turned);
        document.body.classList.toggle('turn-cw', turned && app.turn === 'cw');
        document.body.classList.toggle('turn-ccw', turned && app.turn === 'ccw');
        if (on) {
            ui.sheet.hidden = true;
            if (app.tab !== 'lyrics') setTab('lyrics');
        }
        keepAwake(on);
        app.lineIdx = -2;
        requestAnimationFrame(() => { app.lineIdx = -2; tickOnce(); placeThumb(); });
    }

    // The button's own turn: the player swings round on a spring (a view
    // transition on .player; the backdrop stays put). Where the browser can
    // also go full screen it does, which is what hides the clock and battery —
    // an iPhone only lets a web page do that by really turning the phone.
    function turnStage(forced) {
        const change = () => { app.stageForced = forced; applyStage(); };
        if (forced) enterFullscreen();
        else exitFullscreen();
        if (document.startViewTransition && !CALM.matches) document.startViewTransition(change);
        else change();
    }

    function enterFullscreen() {
        const el = document.documentElement;
        const go = el.requestFullscreen || el.webkitRequestFullscreen;
        const allowed = document.fullscreenEnabled || document.webkitFullscreenEnabled;
        if (!go || !allowed) return;
        try {
            const p = go.call(el);
            if (p && p.catch) p.catch(() => {});
        } catch (e) { /* not here */ }
    }

    function exitFullscreen() {
        const active = document.fullscreenElement || document.webkitFullscreenElement;
        const leave = document.exitFullscreen || document.webkitExitFullscreen;
        if (!active || !leave) return;
        try {
            const p = leave.call(document);
            if (p && p.catch) p.catch(() => {});
        } catch (e) { /* already out */ }
    }

    // A lyrics screen on a table shouldn't go dark mid-song.
    async function keepAwake(on) {
        if (!on || document.hidden) {
            const lock = app.wakeLock;
            app.wakeLock = null;
            if (lock) { try { await lock.release(); } catch (e) { /* already gone */ } }
            return;
        }
        if (app.wakeLock || !navigator.wakeLock) return;
        try {
            app.wakeLock = await navigator.wakeLock.request('screen');
            app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
        } catch (e) { /* not allowed here: the screen just sleeps as usual */ }
    }

    function wireStage() {
        ui.stageBtn.addEventListener('click', () => turnStage(true));
        ui.stageExit.addEventListener('click', () => turnStage(false));
        ui.stageFlip.addEventListener('click', () => {
            const flip = () => {
                app.turn = app.turn === 'cw' ? 'ccw' : 'cw';
                storage((st) => st.setItem(TURN_KEY, app.turn));
                applyStage();
            };
            if (document.startViewTransition && !CALM.matches) document.startViewTransition(flip);
            else flip();
        });
        // Leaving the browser's full screen (a swipe) leaves the stage too.
        const fsChange = () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement && app.stageForced) turnStage(false);
        };
        document.addEventListener('fullscreenchange', fsChange);
        document.addEventListener('webkitfullscreenchange', fsChange);
        const change = () => { sizeViewport(); applyStage(); };
        LANDSCAPE.addEventListener('change', change);
        PORTRAIT.addEventListener('change', change);
    }

    // The page's real size. A home-screen app on iPhone can report a viewport
    // a status bar shorter than the screen it actually fills, which left a dark
    // strip along the bottom; there, the screen's own size is the truth.
    function sizeViewport() {
        let w = window.innerWidth;
        let h = window.innerHeight;
        const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
        if (standalone && window.screen && window.screen.width && window.screen.height) {
            const short = Math.min(window.screen.width, window.screen.height);
            const long = Math.max(window.screen.width, window.screen.height);
            const fullW = h >= w ? short : long;
            const fullH = h >= w ? long : short;
            if (fullH > h && fullH - h <= 120) h = fullH;
            if (fullW > w && fullW - w <= 120) w = fullW;
        }
        const root = document.documentElement.style;
        root.setProperty('--app-w', `${w}px`);
        root.setProperty('--app-h', `${h}px`);
        // How far short of the screen the browser's own viewport stops.
        root.setProperty('--band', `${Math.max(0, h - window.innerHeight)}px`);
    }

    // ── Boot ────────────────────────────────────────────────────────────────

    function showScreen(which) {
        ui.pair.hidden = which !== 'pair';
        ui.player.hidden = which !== 'player';
    }

    async function start() {
        app.pairing = loadPairing();
        if (!app.pairing) { showScreen('pair'); return; }
        showScreen('player');
        render();
        try {
            app.key = await P.deriveKey(app.pairing.secret);
            app.room = await P.deriveRoom(app.pairing.secret);
        } catch (e) {
            // No WebCrypto: an old browser, or the page opened over plain http.
            setConn('waiting');
            ui.conn.textContent = 'This browser can’t open a secure connection';
            return;
        }
        connect();
    }

    function boot() {
        if (!P) return;
        const savedLook = storage((s) => s.getItem(LOOK_KEY));
        app.look = savedLook === 'glass' || savedLook === 'white' ? savedLook : 'pc';
        app.turn = storage((st) => st.getItem(TURN_KEY)) === 'ccw' ? 'ccw' : 'cw';
        sizeViewport();
        wireControls();
        wireSheet();
        wireStage();
        applyStage();
        showVolume(app.volume);
        // iOS only shows :active (the press springs) with a touch listener about.
        document.addEventListener('touchstart', () => {}, { passive: true });
        // The page is exactly one screen; never let it drift.
        window.addEventListener('scroll', () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); }, { passive: true });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeThumb);
        requestAnimationFrame(placeThumb);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { scheduleTick(); keepAwake(false); return; }
            wake();
            keepAwake(!!app.stageClass);
            tickOnce();
            scheduleTick();
        });
        window.addEventListener('pageshow', (ev) => { if (ev.persisted) wake(); });
        window.addEventListener('online', wake);
        window.addEventListener('hashchange', () => {
            const fresh = P.parseLink(location.hash);
            if (fresh && (!app.pairing || fresh.secret !== app.pairing.secret)) {
                disconnect();
                app.state = null;
                app.lyrics = null;
                app.queue = null;
                start();
            }
        });
        window.addEventListener('resize', () => { sizeViewport(); applyStage(); placeThumb(); app.lineIdx = -2; tickOnce(); });
        start();
    }

    boot();
})();
