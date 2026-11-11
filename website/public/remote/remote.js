// main Phone Remote — the phone page. index.html says what it is; protocol.js
// holds the crypto. Everything the PC sends is opened, checked
// (protocol.js sanitize*) and drawn with textContent — nothing from the wire
// ever becomes markup.
//
// Connection: one WebSocket to the relay room (the room id comes from the
// pairing secret; the relay never sees the secret or anything readable). A
// ping every 25 s keeps it open; iOS freezes a page in the background, so on
// coming back the socket is checked and, if it went quiet, replaced.
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

    const $ = (id) => document.getElementById(id);
    const ui = {
        pair: $('pair-screen'), player: $('player-screen'), conn: $('conn'),
        album: $('album'), title: $('title'), artist: $('artist'), cover: $('cover'), label: $('label'),
        bgA: $('bg-a'), bgB: $('bg-b'), like: $('like'),
        tabLyrics: $('tab-lyrics'), tabQueue: $('tab-queue'),
        lyricsView: $('lyrics-view'), lines: $('lines'), lyricsMsg: $('lyrics-msg'),
        queueView: $('queue-view'), queue: $('queue'), queueSub: $('queue-sub'),
        seek: $('seek'), seekFill: $('seek-fill'), seekKnob: $('seek-knob'),
        elapsed: $('elapsed'), remain: $('remain'),
        shuffle: $('shuffle'), prev: $('prev'), play: $('play'), next: $('next'), repeat: $('repeat'),
        volume: $('volume'), device: $('device'),
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
    };

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
        app.state = s;
        app.stateAt = now;
        if (app.conn !== 'live') setConn('live');
        render();
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
        ui.artist.textContent = track ? track.artist : (s && !s.connected ? 'Connect it in main on your PC' : 'Play something on your PC');
        ui.album.textContent = track && track.album ? track.album : '—';
        ui.device.textContent = s && s.device ? `Playing on ${s.device}` : 'Playing on your PC';
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

        if (s && Number.isFinite(s.volume) && !app.holds.volume && document.activeElement !== ui.volume) {
            ui.volume.value = String(s.volume);
        }
        ui.volume.style.setProperty('--vol', `${ui.volume.value}%`);

        renderLyrics();
        tickOnce();
        scheduleTick();
    }

    function setArt(url) {
        if (url === app.art) return;
        app.art = url;
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

    function setLine(idx) {
        if (idx === app.lineIdx || !app.lineEls.length) return;
        app.lineIdx = idx;
        app.lineEls.forEach((el, i) => {
            const d = i - idx;
            el.classList.toggle('is-on', d === 0);
            el.classList.toggle('is-past', idx >= 0 && d < 0);
            el.classList.toggle('d1', d === 1);
            el.classList.toggle('d2', d === 2);
            el.classList.toggle('d3', d === 3);
        });
        const target = app.lineEls[Math.max(0, idx)];
        if (!target) return;
        const y = ui.lyricsView.clientHeight * 0.42 - (target.offsetTop + target.offsetHeight / 2);
        ui.lines.style.transform = `translate3d(0, ${Math.round(y)}px, 0)`;
    }

    // ── The clock: progress bar, times, the current lyric line ──────────────

    function tickOnce() {
        const s = app.state;
        const dur = s && s.durationMs ? s.durationMs : 0;
        const pos = app.seeking != null ? app.seeking : position();
        const frac = dur ? Math.min(1, pos / dur) : 0;
        ui.seekFill.style.transform = `scaleX(${frac})`;
        ui.seekKnob.style.left = `${(frac * 100).toFixed(3)}%`;
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
        ui.queue.replaceChildren(...rows);
        ui.queueSub.textContent = !q ? 'Loading…'
            : !q.ok ? 'Play something on your PC to see what’s next'
                : q.items.length ? `${q.items.length} song${q.items.length === 1 ? '' : 's'} after this one`
                    : 'Nothing queued after this song';
    }

    function setTab(tab) {
        app.tab = tab;
        const queue = tab === 'queue';
        ui.tabLyrics.classList.toggle('is-on', !queue);
        ui.tabQueue.classList.toggle('is-on', queue);
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

    function seekFromPointer(ev) {
        const r = ui.seek.getBoundingClientRect();
        const frac = r.width ? Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) : 0;
        return frac * ((app.state && app.state.durationMs) || 0);
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
            tickOnce();
        });
        const end = (ev, commit) => {
            if (app.seeking == null) return;
            const ms = ev && commit ? seekFromPointer(ev) : app.seeking;
            app.seeking = null;
            ui.seek.classList.remove('is-dragging');
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
        ui.prev.addEventListener('click', () => send('previous'));
        ui.next.addEventListener('click', () => send('next'));
        ui.shuffle.addEventListener('click', () => {
            if (!app.state) return;
            hold('shuffle', !app.state.shuffle);
            render();
            send('shuffle', app.state.shuffle);
        });
        ui.repeat.addEventListener('click', () => {
            if (!app.state) return;
            const order = P.REPEAT_MODES;
            const next = order[(order.indexOf(app.state.repeat) + 1) % order.length];
            hold('repeat', next);
            render();
            send('repeat', next);
        });
        ui.like.addEventListener('click', () => {
            const s = app.state;
            if (!s || !s.track || !s.track.id) return;
            const liked = !s.liked;
            hold('liked', liked);
            if (liked) {
                ui.like.classList.remove('is-popping');
                void ui.like.offsetWidth;
                ui.like.classList.add('is-popping');
            }
            render();
            send('like', liked);
        });
        ui.volume.addEventListener('input', () => {
            const v = Number(ui.volume.value);
            ui.volume.style.setProperty('--vol', `${v}%`);
            hold('volume', v);
            clearTimeout(app.volumeTimer);
            app.volumeTimer = setTimeout(() => send('volume', v), VOLUME_DEBOUNCE_MS);
        });
        ui.tabLyrics.addEventListener('click', () => setTab('lyrics'));
        ui.tabQueue.addEventListener('click', () => setTab('queue'));
        wireSeek();
    }

    // ── The ⋯ sheet ─────────────────────────────────────────────────────────

    function openSheet() {
        const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
        ui.installHint.hidden = standalone;
        app.unpairArmed = false;
        ui.unpair.classList.remove('is-armed');
        ui.unpair.textContent = 'Unpair this phone';
        ui.sheet.hidden = false;
    }

    function closeSheet() {
        ui.sheet.hidden = true;
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
        wireControls();
        wireSheet();
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { scheduleTick(); return; }
            wake();
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
        window.addEventListener('resize', () => { app.lineIdx = -2; tickOnce(); });
        start();
    }

    boot();
})();
