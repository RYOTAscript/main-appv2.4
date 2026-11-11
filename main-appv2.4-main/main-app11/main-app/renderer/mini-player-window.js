// ── Corner player window ──
// The page inside the corner player (mini-player.html). Everything it knows
// arrives from main over window.miniPlayer (mini-player-preload.js); everything
// it does goes back the same way. Track text comes from Spotify, so it only
// ever goes in through textContent.
//
// Idle-cheap on purpose — this window sits on top of games for hours. What moves
// for long (the progress bar, the disc) is ONE animation of transform that runs
// on the compositor, so a playing song costs the main thread nothing per frame,
// and ONE setTimeout is aimed at the next moment something visible changes (the
// next whole second on the clock, or the next lyric line). A paused song or a
// hidden window schedules nothing at all.
//
// A poll must never show. Main hands over Spotify's position every 2.5s and each
// one is a little off, so the page runs its own clock that polls only correct
// (MiniPlayerEngine.followClock), the bar is only re-seated when the song really
// jumped, and the lyric rows only move when the line really changes.

(function () {
    'use strict';

    const E = window.MiniPlayerEngine;
    const api = window.miniPlayer;
    if (!E || !api) return;

    const $ = (id) => document.getElementById(id);
    const els = {
        body: document.body,
        card: $('card'),
        tools: $('tools'),
        lyric: $('lyric'),
        rows: $('lyric-rows'),
        measure: $('lyric-measure'),
        live: $('lyric-live'),
        row: $('row'),
        halo: $('halo'),
        disk: $('disk'),
        tile: $('cover-tile'),
        slide: $('vinyl-slide'),
        vinyl: $('vinyl'),
        covers: [$('cover-tile'), $('cover-label'), $('cover-sleeve')],
        title: $('title'),
        artist: $('artist'),
        seek: $('seek'),
        fill: $('seek-fill'),
        rail: $('seek-rail'),
        tCur: $('t-cur'),
        tTotal: $('t-total'),
        prev: $('btn-prev'),
        play: $('btn-play'),
        nextBtn: $('btn-next'),
        expand: $('btn-expand'),
        dismiss: $('btn-dismiss')
    };

    // The launcher's settle curve: quick off the mark, a long soft landing.
    const SETTLE = 'cubic-bezier(0.16, 1, 0.3, 1)';
    const BAR_GLIDE_MS = 380;      // a seek or a new song: the bar travels there
    const BAR_EASE_MS = 160;       // play/pause: absorbs what a poll corrected
    const TEXT_OUT_MS = 130;
    const RETIRE_MS = 720;         // outlasts the rows' transitions in the page's CSS
    const QUIET_LOADING_MS = 700;  // most lookups land sooner: no "Finding lyrics…" flash
    const MIN_REST_FILL_MS = 1500; // a shorter gap isn't worth counting down
    const SPIN_MS = 3400;
    const SPIN_UP_MS = 800;
    const SPIN_DOWN_MS = 1200;
    const SKIP_MEMORY_MS = 4000;   // how long a pressed skip explains the next song
    const REST_AFTER_MS = 260;     // off screen: once the exit has played, everything stops
    const ROLES =['is-cur', 'is-next', 'is-past', 'is-below', 'is-faded'];

    const calmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let calm = calmQuery.matches;

    let state = null;
    let clock = null;         // the page's own playback clock (see followClock)
    let onScreen = false;     // main says the card is showing ('presence')
    let shownKey = null;      // track whose details are on screen
    let shownLine = null;     // lyric line on screen (index, or a status name)
    let shownRest = false;    // …and it is the rest dots
    let shownSec = -1;        // the second the clock label shows
    let shownCover = '';
    let shownAccent = null;
    let lineCur = null;       // the two lyric rows
    let lineNext = null;
    let tickTimer = null;
    let quietTimer = null;
    let loadingKey = null;    // track whose lyrics are being looked up, and since when
    let loadingSince = 0;
    let textTimer = null;
    let barAnims = [];
    let spinning = false;
    let spinRamp = 0;
    let cardAnim = null;
    let restTimer = null;
    let skipDir = 1;
    let skipAt = 0;
    let layoutSig = null;     // style + lyric-row on/off the window was sized for
    let lastHeight = 0;

    function prefs() {
        return (state && state.prefs) || {};
    }

    function apply(s) {
        if (!s || typeof s !== 'object') return;
        // The song went away: main is taking the card off screen (it never shows
        // it without one), so it leaves still showing what it was showing.
        if (!s.track && state && state.track) s = Object.assign({}, state, { presence: s.presence, prefs: s.prefs });
        state = s;
        const p = prefs();
        const white = p.style === 'white';
        els.body.classList.toggle('style-white', white);
        els.body.classList.toggle('style-glass', !white);
        els.body.classList.toggle('no-lyrics', p.lyrics === false);
        els.body.classList.toggle('is-playing', !!s.playing);
        els.body.classList.toggle('is-paused', !s.playing);
        const accent = E.hexToRgb(p.accent).join(', ');
        if (accent !== shownAccent) {
            shownAccent = accent;
            document.documentElement.style.setProperty('--accent', accent);
        }
        els.play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');

        // The window is sized from the card; tell main whenever the look changes
        // (it hides the window while that happens and waits for this).
        const sig = (white ? 'white' : 'glass') + '|' + (p.lyrics === false ? 'off' : 'on');
        const restyled = sig !== layoutSig;
        layoutSig = sig;

        const arriving = s.presence === 'in' && !onScreen;
        const departing = s.presence !== 'in' && onScreen;
        onScreen = s.presence === 'in';
        // Settled before anything else: whatever goes wrong further down, a card
        // main has put on screen must never sit invisible in its window.
        els.body.classList.toggle('is-in', onScreen);
        // Only what changes in front of the viewer gets to move.
        const live = onScreen && !arriving && !restyled && !calm;

        const moved = E.followClock(clock, s, Date.now());
        clock = moved.clock;

        const key = E.trackKey(s.track);
        if (key !== shownKey) {
            shownKey = key;
            showTrack(s.track, live);
        }

        if (restyled || arriving || moved.jump) {
            seatBar(!live ? 0 : moved.jump === 'state' ? BAR_EASE_MS : BAR_GLIDE_MS);
        }
        if (restyled || arriving || spinning !== clock.playing) {
            spinning = clock.playing;
            setSpin(spinning, live);
        }
        showTime(!!moved.jump);
        renderLyric({ jumped: !!moved.jump, live, rebuild: restyled || arriving });
        schedule();
        reportHeight(restyled);

        if (arriving) enterCard();
        else if (departing) leaveCard();
    }

    // ── The song ────────────────────────────────────────────────────────────

    function setTrackText(name, artist) {
        clearTimeout(textTimer);
        textTimer = null;
        els.title.textContent = name;
        els.title.title = name;
        els.artist.textContent = artist;
    }

    function showTrack(t, live) {
        // Line numbers mean nothing across songs.
        shownLine = null;
        shownSec = -1;
        const name = t ? t.name : 'Nothing playing';
        const artist = t ? t.artist : '';
        els.tTotal.textContent = E.formatTime(t ? t.durationMs : 0);
        showCover(t && t.image ? t.image : '', live);
        if (!live) {
            for (const el of [els.title, els.artist]) stopMotion(el);
            setTrackText(name, artist);
            return;
        }
        // Out one way, in from the other, following the skip that caused it.
        const dir = Date.now() - skipAt < SKIP_MEMORY_MS ? skipDir : 1;
        skipAt = 0;
        const rows = [els.title, els.artist];
        for (const el of rows) {
            stopMotion(el);
            el.animate([
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'translateX(' + (-10 * dir) + 'px)' }
            ], { duration: TEXT_OUT_MS, easing: 'ease-in', fill: 'forwards' });
        }
        clearTimeout(textTimer);
        textTimer = setTimeout(() => {
            setTrackText(name, artist);
            rows.forEach((el, i) => {
                stopMotion(el);
                el.animate([
                    { opacity: 0, transform: 'translateX(' + (12 * dir) + 'px)' },
                    { opacity: 1, transform: 'none' }
                ], { duration: 420, delay: i * 50, easing: SETTLE, fill: 'backwards' });
            });
        }, TEXT_OUT_MS);
        // The record itself: the disc's glow swells; the vinyl dips into its sleeve.
        if (prefs().style === 'white') {
            els.slide.animate([
                { transform: 'translateX(0)' },
                { transform: 'translateX(-13px)', offset: 0.42 },
                { transform: 'translateX(0)' }
            ], { duration: 680, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', composite: 'add' });
        } else {
            els.halo.animate([{ opacity: 0.6, offset: 0.3 }], { duration: 900, easing: 'ease-out' });
            els.tile.animate([{ transform: 'scale(0.84)' }, { transform: 'none' }], { duration: 520, easing: SETTLE });
        }
    }

    function stopMotion(el) {
        for (const a of el.getAnimations()) a.cancel();
    }

    function setCover(url) {
        for (const img of els.covers) {
            if (url) img.src = url;
            else img.removeAttribute('src');
        }
    }

    // The old cover stays until the new one has loaded, then fades away on top
    // of it, so the art never blinks through empty.
    function showCover(url, live) {
        if (url === shownCover) return;
        shownCover = url;
        if (!url || !live) {
            setCover(url);
            return;
        }
        const probe = new Image();
        probe.onload = () => { if (shownCover === url) crossfadeCover(url); };
        probe.onerror = () => { if (shownCover === url) setCover(''); };
        probe.src = url;
    }

    function crossfadeCover(url) {
        for (const img of els.covers) {
            if (img.getAttribute('src')) {
                const ghost = img.cloneNode(false);
                ghost.removeAttribute('id');
                img.after(ghost);
                ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: 'ease', fill: 'forwards' });
                setTimeout(() => ghost.remove(), 520);
            } else {
                img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, easing: 'ease' });
            }
            img.src = url;
        }
    }

    // ── The disc ────────────────────────────────────────────────────────────
    // It has weight: it winds up when the music starts and coasts to a stop when
    // it pauses. Only the visible look's disc ever runs, and a stopped one is
    // paused outright, so there's nothing for the compositor to do.

    const spins = new Map();

    function spinOf(el) {
        let a = spins.get(el);
        if (!a) {
            a = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: SPIN_MS, iterations: Infinity });
            a.pause();
            spins.set(el, a);
        }
        return a;
    }

    function setSpin(on, live) {
        cancelAnimationFrame(spinRamp);
        const white = prefs().style === 'white';
        const idle = spins.get(white ? els.disk : els.vinyl);
        if (idle) idle.pause();
        if (calm || !onScreen) {
            for (const a of spins.values()) a.pause();
            return;
        }
        const a = spinOf(white ? els.vinyl : els.disk);
        if (!live) {
            a.playbackRate = 1;
            if (on) a.play();
            else a.pause();
            return;
        }
        const from = a.playState === 'running' ? a.playbackRate : 0;
        const to = on ? 1 : 0;
        const ms = on ? SPIN_UP_MS : SPIN_DOWN_MS;
        a.playbackRate = from;
        if (on) a.play();
        const started = performance.now();
        const step = (t) => {
            const k = Math.min(1, Math.max(0, (t - started) / ms));
            a.playbackRate = from + (to - from) * (1 - Math.pow(1 - k, 3));
            if (k < 1) spinRamp = requestAnimationFrame(step);
            else if (!on) a.pause();
        };
        spinRamp = requestAnimationFrame(step);
    }

    // ── The progress bar ────────────────────────────────────────────────────
    // Two transforms, one for the fill and one for the rail carrying the knob,
    // and one long animation from here to the end of the song. Moving width or
    // left instead would be layout and paint on the main thread on every frame,
    // for as long as the music plays.

    function railX() {
        const m = getComputedStyle(els.rail).transform;
        return m && m !== 'none' ? new DOMMatrixReadOnly(m).m41 : 0;
    }

    function paintBar(x, w) {
        els.rail.style.transform = 'translateX(' + x + 'px)';
        els.fill.style.transform = 'translateX(' + (x - w) + 'px)';
    }

    function animateBar(el, xs, offsets, durationMs, glide) {
        const frames = xs.map((x, i) => ({
            transform: 'translateX(' + x + 'px)',
            offset: offsets[i],
            easing: glide && i === 0 ? SETTLE : 'linear'
        }));
        return el.animate(frames, { duration: durationMs });
    }

    // Puts the bar where the song is. With glideMs it travels there first, from
    // wherever it is showing right now, mid-animation included.
    function seatBar(glideMs) {
        const dur = clock && clock.track ? Number(clock.track.durationMs) || 0 : 0;
        const w = els.rail.offsetWidth;
        const glide = glideMs > 0 ? glideMs : 0;
        const fromX = glide ? railX() : 0;
        for (const a of barAnims) a.cancel();
        barAnims = [];
        if (!w) return;
        const running = !!(clock && clock.playing) && dur > 0 && !calm && onScreen;
        const pos = clock ? E.positionAt(clock, Date.now() + (running ? glide : 0)) : 0;
        const seatX = dur > 0 ? (pos / dur) * w : 0;
        const endX = running ? w : seatX;
        // Resting state is where the animation ends, so it just stops there.
        paintBar(endX, w);
        const remaining = running ? Math.max(0, dur - pos) : 0;
        const total = glide + remaining;
        if (total <= 0) return;
        const xs = [];
        const offsets = [];
        if (glide) { xs.push(fromX); offsets.push(0); }
        xs.push(seatX);
        offsets.push(glide / total);
        if (running) { xs.push(endX); offsets.push(1); }
        if (xs.length < 2) return;
        barAnims = [
            animateBar(els.rail, xs, offsets, total, !!glide),
            animateBar(els.fill, xs.map((x) => x - w), offsets, total, !!glide)
        ];
    }

    function showTime(jumped) {
        const sec = Math.floor(E.positionAt(clock, Date.now()) / 1000);
        // A poll's correction must not run the clock backwards.
        if (sec === shownSec || (sec < shownSec && !jumped && clock.playing)) return;
        shownSec = sec;
        els.tCur.textContent = E.formatTime(sec * 1000);
    }

    // ── The lyric rows ──────────────────────────────────────────────────────
    // A conveyor: the next line glides up and grows into the current one, which
    // lifts away, and a new next line fades in beneath. Nothing blinks and no
    // row reappears; the page's CSS only ever animates transform and opacity.

    function statusView(id, text) {
        return { id, text, next: '', dim: true, rest: null };
    }

    function loadingView() {
        const now = Date.now();
        if (loadingKey !== shownKey) {
            loadingKey = shownKey;
            loadingSince = now;
        }
        const wait = QUIET_LOADING_MS - (now - loadingSince);
        if (wait <= 0) return statusView('loading', 'Finding lyrics…');
        clearTimeout(quietTimer);
        // Off screen nobody is waiting to be told; arriving looks again.
        quietTimer = onScreen ? setTimeout(() => renderLyric({ live: onScreen && !calm }), wait + 5) : null;
        return statusView('quiet', '');
    }

    // What the lyric rows say right now.
    function lyricView(jumped) {
        const lyr = (state && state.lyrics) || { status: 'none', lines: [] };
        if (!state || !state.track) return statusView('empty', '');
        if (lyr.status === 'loading') return loadingView();
        if (lyr.status !== 'ready' || !lyr.lines || !lyr.lines.length) return statusView('none', 'No lyrics for this song');
        if (!lyr.synced) return statusView('unsynced', 'These lyrics aren’t timed');
        const pos = E.positionAt(clock, Date.now());
        const lead = prefs().anticipateMs;
        const idx = E.settledLine(lyr.lines, pos, lead, jumped ? null : shownLine);
        const line = idx >= 0 ? lyr.lines[idx] : null;
        const upcoming = lyr.lines[idx + 1];
        const text = line && line.text ? line.text : '';
        const rest = text ? null : (E.restSpan(lyr.lines, idx, pos, lead) || { durationMs: 0, elapsedMs: 0 });
        return { id: idx, text, next: upcoming ? upcoming.text : '', dim: false, rest };
    }

    function addRow(text) {
        const el = document.createElement('div');
        el.className = 'lline';
        el.textContent = text;
        el.dataset.t = text;
        els.rows.appendChild(el);
        return el;
    }

    // An instrumental gap: three dots that fill up as the next line nears.
    function addRestRow(rest) {
        const el = addRow('');
        const dots = document.createElement('span');
        dots.className = 'dots';
        for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
        if (rest.durationMs >= MIN_REST_FILL_MS) {
            dots.classList.add('is-filling');
            dots.style.setProperty('--third', (rest.durationMs / 3) + 'ms');
            dots.style.setProperty('--gone', rest.elapsedMs + 'ms');
        }
        el.appendChild(dots);
        return el;
    }

    function setRole(el, ...roles) {
        el.classList.remove(...ROLES);
        el.classList.add(...roles);
    }

    // The free span of the row: clear of the corner buttons on the right.
    function lyricRoom() {
        const right = els.tools.offsetLeft - 4;
        if (prefs().style === 'white') return { left: 14, right, centre: 14, align: 'left' };
        return { left: 10, right, centre: els.card.clientWidth / 2, align: 'centre' };
    }

    function makeCurrent(el, view) {
        els.measure.textContent = el.dataset.t || '';
        const fit = E.lyricFit(els.measure.offsetWidth, lyricRoom());
        el.style.setProperty('--fit', String(fit.scale));
        el.style.setProperty('--shift', fit.shift + 'px');
        el.classList.toggle('is-dim', !!view.dim);
        setRole(el, 'is-cur');
    }

    function retire(el, ...roles) {
        if (!el) return;
        setRole(el, ...roles);
        setTimeout(() => el.remove(), RETIRE_MS);
    }

    // No motion: the card is arriving, hidden, or restyling.
    function layDown(view) {
        els.rows.textContent = '';
        lineCur = view.rest ? addRestRow(view.rest) : addRow(view.text);
        makeCurrent(lineCur, view);
        lineNext = addRow(view.next);
        setRole(lineNext, 'is-next');
    }

    // The ordinary case: the next line was already showing, so it's the one that moves.
    function advance(view) {
        retire(lineCur, 'is-past');
        lineCur = lineNext;
        makeCurrent(lineCur, view);
        lineNext = addRow(view.next);
        setRole(lineNext, 'is-below');
        void lineNext.offsetWidth;
        setRole(lineNext, 'is-next');
    }

    // Anything else (a seek, a new song, a status message): out and in, up the
    // screen going forwards and down it going back.
    function swap(view, forward) {
        retire(lineCur, forward ? 'is-past' : 'is-below');
        retire(lineNext, 'is-next', 'is-faded');
        lineCur = view.rest ? addRestRow(view.rest) : addRow(view.text);
        setRole(lineCur, forward ? 'is-below' : 'is-past');
        lineNext = addRow(view.next);
        setRole(lineNext, 'is-next', 'is-faded');
        void lineCur.offsetWidth;
        makeCurrent(lineCur, view);
        setRole(lineNext, 'is-next');
    }

    function renderLyric(how) {
        if (prefs().lyrics === false) return;
        const o = how || {};
        const view = lyricView(o.jumped);
        // The dots count down from where the song is, so a seek inside a gap resets them.
        if (view.id === shownLine && !o.rebuild && !(o.jumped && shownRest)) return;
        const from = shownLine;
        shownLine = view.id;
        shownRest = !!view.rest;
        if (els.live.textContent !== view.text) els.live.textContent = view.text;
        if (!o.live || o.rebuild) layDown(view);
        else if (Number.isInteger(from) && view.id === from + 1 && !view.rest && lineNext && lineNext.dataset.t === view.text) advance(view);
        else swap(view, !(Number.isInteger(from) && Number.isInteger(view.id) && view.id < from));
    }

    // One timer, aimed at whichever comes first: the clock's next second or
    // the next lyric line.
    function schedule() {
        clearTimeout(tickTimer);
        tickTimer = null;
        if (!onScreen || !clock || !clock.playing || !clock.track) return;
        const pos = E.positionAt(clock, Date.now());
        let wait = 1000 - (pos % 1000);
        const lyr = state.lyrics;
        if (prefs().lyrics !== false && lyr && lyr.status === 'ready' && lyr.synced && Number.isInteger(shownLine)) {
            const upcoming = lyr.lines[shownLine + 1];
            if (upcoming && Number.isFinite(upcoming.t)) {
                const lead = Number.isFinite(prefs().anticipateMs) ? prefs().anticipateMs : E.DEFAULT_ANTICIPATE_MS;
                const due = Math.max(0, upcoming.t - lead) - pos;
                if (due > 0 && due < wait) wait = due;
            }
        }
        tickTimer = setTimeout(tick, Math.max(16, Math.ceil(wait) + 5));
    }

    function tick() {
        tickTimer = null;
        if (!onScreen || !clock || !clock.playing) return;
        showTime(false);
        // With reduced motion there's no long animation carrying the bar.
        if (calm) seatBar(0);
        renderLyric({ live: !calm });
        schedule();
    }

    // ── Arriving and leaving ────────────────────────────────────────────────
    // Main shows the window and tells the page 'in'; it tells the page 'out' and
    // hides the window a moment later. Rising out of a bottom corner, dropping
    // out of a top one.

    function cornerDrop() {
        return String(prefs().corner || '').startsWith('top') ? -12 : 12;
    }

    function enterCard() {
        clearTimeout(restTimer);
        restTimer = null;
        if (cardAnim) cardAnim.cancel();
        cardAnim = null;
        if (calm) return;
        const dy = cornerDrop();
        els.card.style.transformOrigin = '50% ' + (dy < 0 ? '0%' : '100%');
        cardAnim = els.card.animate([
            { opacity: 0, transform: 'translateY(' + dy + 'px) scale(0.965)' },
            { opacity: 1, transform: 'none' }
        ], { duration: 480, easing: SETTLE });
        [els.lyric, els.row].forEach((el, i) => {
            el.animate([
                { opacity: 0, transform: 'translateY(' + (dy / 2) + 'px)' },
                { opacity: 1, transform: 'none' }
            ], { duration: 460, delay: 50 + i * 50, easing: SETTLE, fill: 'backwards' });
        });
    }

    function leaveCard() {
        if (cardAnim) cardAnim.cancel();
        cardAnim = null;
        clearTimeout(restTimer);
        restTimer = setTimeout(rest, REST_AFTER_MS);
        if (calm) return;
        const dy = cornerDrop() * 0.6;
        cardAnim = els.card.animate([
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'translateY(' + dy + 'px) scale(0.985)' }
        ], { duration: 170, easing: 'ease-in', fill: 'forwards' });
    }

    // Off screen there's nobody to move for. This window is never throttled, so
    // a disc left spinning in a hidden card would go on being animated for as
    // long as it stayed hidden. Everything stops; arriving seats it all again.
    function rest() {
        restTimer = null;
        if (onScreen) return;
        for (const a of barAnims) a.cancel();
        barAnims = [];
        cancelAnimationFrame(spinRamp);
        for (const a of spins.values()) a.pause();
    }

    function reportHeight(force) {
        // Layout height: a transform in mid-entrance must not resize the window.
        const h = els.card.offsetHeight;
        if (!h || (!force && h === lastHeight)) return;
        lastHeight = h;
        api.laidOut(h);
    }

    // ── Input ───────────────────────────────────────────────────────────────

    function noteSkip(dir, button) {
        skipDir = dir;
        skipAt = Date.now();
        if (calm) return;
        const icon = button.querySelector('svg');
        if (icon) {
            icon.animate([
                { transform: 'translateX(0)' },
                { transform: 'translateX(' + (dir * 3) + 'px)', offset: 0.35 },
                { transform: 'translateX(0)' }
            ], { duration: 300, easing: 'cubic-bezier(0.3, 0.7, 0.2, 1)' });
        }
    }

    els.play.addEventListener('click', () => {
        if (!state || !state.track) return;
        // Answer instantly; main confirms with the next state it pushes.
        const now = Date.now();
        apply(Object.assign({}, state, { playing: !state.playing, progressMs: E.positionAt(clock, now), at: now }));
        api.action('toggle');
    });
    els.prev.addEventListener('click', () => { noteSkip(-1, els.prev); api.action('previous'); });
    els.nextBtn.addEventListener('click', () => { noteSkip(1, els.nextBtn); api.action('next'); });
    els.seek.addEventListener('click', (e) => {
        const t = state && state.track;
        if (!t || !t.durationMs) return;
        const r = els.seek.getBoundingClientRect();
        if (!r.width) return;
        const ms = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * t.durationMs);
        // The viewer pointed at this spot: no drift tolerance, the song is there now.
        const now = Date.now();
        state = Object.assign({}, state, { progressMs: ms, at: now });
        clock = Object.assign({}, clock, { progressMs: ms, at: now });
        seatBar(calm ? 0 : BAR_GLIDE_MS);
        showTime(true);
        renderLyric({ jumped: true, live: onScreen && !calm });
        schedule();
        api.action('seek', ms);
    });
    els.expand.addEventListener('click', () => api.expand());
    els.dismiss.addEventListener('click', () => api.dismiss());
    window.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.menu();
    });

    calmQuery.addEventListener('change', () => {
        calm = calmQuery.matches;
        if (!clock) return;
        seatBar(0);
        setSpin(spinning, false);
        renderLyric({ rebuild: true });
    });

    // Fonts arriving (or anything else) can change the card's height.
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => reportHeight(false)).observe(els.card);
    }

    api.onState(apply);
    api.ready().then(apply).catch(() => {});
})();
