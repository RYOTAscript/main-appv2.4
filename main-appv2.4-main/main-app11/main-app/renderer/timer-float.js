// ── Floating timer window ──
// The page inside each popped-out timer (timer-float.html). Everything it
// knows arrives from main over window.timerFloat (timer-float-preload.js);
// everything it does goes back the same way. It never names a timer id.
//
// Idle-cheap on purpose — this window sits on top of games for hours. There is
// no rAF loop: while a timer runs, ONE setTimeout is aimed at the moment the
// displayed digits next change (the next whole second for a countdown, the
// next tenth for a stopwatch) and the ring/bar glide there with a CSS
// transition. A paused, idle or finished timer schedules nothing at all.

(function () {
    'use strict';

    const E = window.TimerEngine;
    const api = window.timerFloat;
    if (!E || !api) return;

    const $ = (id) => document.getElementById(id);
    const root = $('tf');
    const els = {
        label: $('tf-label'), clock: $('tf-clock'), sub: $('tf-sub'), arc: $('tf-arc'), bar: $('tf-bar'),
        primary: $('tf-primary'), secondary: $('tf-secondary'), more: $('tf-more'), close: $('tf-close'), ghost: $('tf-ghost'),
        cps: $('tf-cps'), barCps: $('tf-bar-cps')
    };
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const RADIUS = 45;
    const CIRC = 2 * Math.PI * RADIUS;
    els.arc.style.strokeDasharray = String(CIRC);

    let state = null;
    let tickHandle = null;
    let lastClock = '';
    let overHandle = false;
    // The ring and the pill's bar are Web Animations whose clock is pinned to
    // the timer's real elapsed time: the compositor moves them every frame with
    // no JS per frame, and each digit tick re-pins currentTime so they can
    // never drift from the clock. `progressKey` says what they were built for.
    let arcAnim = null;
    let barAnim = null;
    let progressKey = '';
    let cpSig = '';
    // Style/size the window was last laid out for, and the size we're waiting
    // for the window to reach after a change (see main/timers.js hideForLayout).
    let layoutKey = '';
    let pendingLayout = null;
    let layoutFallback = null;

    function endsAt(ts) {
        try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
    }

    function icon(cls) { return `<i class="fas ${cls}"></i>`; }

    function setButton(btn, html, title) {
        if (btn.innerHTML !== html) btn.innerHTML = html;
        btn.title = title;
    }

    function applyChrome() {
        const t = state.timer;
        const p = state.prefs;
        const keep = ['flash', 'near', 'no-trans'].filter(c => root.classList.contains(c));
        root.className = ['tf', 'style-' + p.style, 'size-' + p.size, 'is-' + t.status, 'kind-' + t.kind, p.ghost ? 'ghost' : ''].concat(keep).join(' ').trim();
        root.style.setProperty('--c', t.color);
        els.label.innerHTML = '';
        const dot = document.createElement('span');
        dot.className = 'dot';
        els.label.appendChild(dot);
        els.label.appendChild(document.createTextNode(E.displayName(t)));

        const running = t.status === 'running';
        if (t.status === 'done') {
            setButton(els.primary, icon(t.kind === 'pomodoro' ? 'fa-play' : 'fa-rotate-right'),
                t.kind === 'pomodoro' ? 'Start ' + (E.PHASE_LABELS[t.phase] || '').toLowerCase() : 'Restart');
            setButton(els.secondary, icon('fa-check'), 'Dismiss');
        } else {
            setButton(els.primary, icon(running ? 'fa-pause' : 'fa-play'), running ? 'Pause (Space)' : 'Start (Space)');
            if (t.kind === 'stopwatch') {
                if (running) setButton(els.secondary, icon('fa-flag'), 'Lap (L)');
                else setButton(els.secondary, icon('fa-rotate-left'), 'Reset (R)');
            } else {
                setButton(els.secondary, '+1', 'Add a minute (+)');
            }
        }
        renderCheckpoints();
    }

    // A tick across the ring / a notch on the bar at the point the draining
    // line reaches when each checkpoint fires. Passed ones fade.
    function renderCheckpoints() {
        const t = state.timer;
        const marks = E.checkpointMarks(t);
        const sig = t.durationMs + '|' + marks.map(m => m.leftMs + (m.hit ? 'h' : '')).join(',');
        if (sig === cpSig) return;
        cpSig = sig;
        els.cps.textContent = '';
        els.barCps.textContent = '';
        for (const m of marks) {
            const a = m.frac * 2 * Math.PI;
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('x1', (50 + 39.5 * Math.cos(a)).toFixed(2));
            line.setAttribute('y1', (50 + 39.5 * Math.sin(a)).toFixed(2));
            line.setAttribute('x2', (50 + 49.5 * Math.cos(a)).toFixed(2));
            line.setAttribute('y2', (50 + 49.5 * Math.sin(a)).toFixed(2));
            if (m.hit) line.setAttribute('class', 'hit');
            els.cps.appendChild(line);
            const notch = document.createElement('b');
            notch.style.left = (m.frac * 100).toFixed(3) + '%';
            if (m.hit) notch.className = 'hit';
            els.barCps.appendChild(notch);
        }
    }

    function finishLayout() {
        clearTimeout(layoutFallback);
        layoutFallback = null;
        pendingLayout = null;
        root.classList.remove('no-trans');
        api.laidOut();
    }

    // Waits until the window has actually been resized to the new look, lets
    // it lay out and paint once, then tells main it can show the window again.
    function checkLayout() {
        if (!pendingLayout) return;
        if (Math.abs(window.innerWidth - pendingLayout.width) > 2 || Math.abs(window.innerHeight - pendingLayout.height) > 2) return;
        pendingLayout = null;
        requestAnimationFrame(() => requestAnimationFrame(finishLayout));
    }

    function cancelProgress() {
        if (arcAnim) { arcAnim.cancel(); arcAnim = null; }
        if (barAnim) { barAnim.cancel(); barAnim = null; }
        progressKey = '';
    }

    // `fill` is how much of the ring/bar is drawn, 0..1.
    function setStaticProgress(fill) {
        const f = Math.min(1, Math.max(0, fill));
        els.arc.style.strokeDashoffset = String(CIRC * (1 - f));
        els.bar.style.transform = `scaleX(${f})`;
        // A round line cap leaves a dot at zero length — hide it when empty.
        els.arc.style.opacity = f <= 0.0005 ? '0' : '';
    }

    function syncProgress(now) {
        const t = state.timer;
        const stopwatch = t.kind === 'stopwatch';
        if (t.status !== 'running') {
            cancelProgress();
            const prog = E.progress(t, now);
            setStaticProgress(stopwatch ? prog : 1 - prog);
            return;
        }
        // A countdown drains over its whole duration; a stopwatch sweeps
        // once a minute, forever.
        const period = stopwatch ? 60000 : Math.max(1, t.durationMs);
        const key = t.id + '|' + t.kind + '|' + period;
        if (key !== progressKey || !arcAnim || !barAnim) {
            cancelProgress();
            els.arc.style.opacity = '';
            const opts = { duration: period, easing: 'linear', fill: 'forwards', iterations: stopwatch ? Infinity : 1 };
            try {
                arcAnim = els.arc.animate(stopwatch
                    ? [{ strokeDashoffset: String(CIRC) }, { strokeDashoffset: '0' }]
                    : [{ strokeDashoffset: '0' }, { strokeDashoffset: String(CIRC) }], opts);
                barAnim = els.bar.animate(stopwatch
                    ? [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }]
                    : [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], opts);
                progressKey = key;
            } catch (e) {
                cancelProgress();
                const prog = E.progress(t, now);
                setStaticProgress(stopwatch ? prog : 1 - prog);
                return;
            }
        }
        const pos = stopwatch ? E.elapsed(t, now) : Math.min(period, Math.max(0, period - E.remaining(t, now)));
        arcAnim.currentTime = pos;
        barAnim.currentTime = pos;
    }

    function paint() {
        if (!state) return;
        const t = state.timer;
        const now = Date.now();
        let text, frac = '';
        if (t.kind === 'stopwatch') {
            const full = E.formatClock(E.elapsed(t, now), 1);
            const dot = full.lastIndexOf('.');
            text = full.slice(0, dot);
            frac = full.slice(dot);
        } else {
            text = E.formatClock(E.remaining(t, now), 0);
        }
        const key = text + frac;
        if (key !== lastClock) {
            lastClock = key;
            els.clock.textContent = text;
            if (frac) {
                const f = document.createElement('span');
                f.className = 'frac';
                f.textContent = frac;
                els.clock.appendChild(f);
            }
            els.clock.classList.toggle('long', text.length > 5);
        }

        syncProgress(now);

        els.sub.textContent = '';
        if (t.kind === 'pomodoro') {
            els.sub.appendChild(document.createTextNode(E.PHASE_LABELS[t.phase] || ''));
            const pips = document.createElement('span');
            pips.className = 'pips';
            const every = state.longEvery || 4;
            const filled = t.phase === 'long' ? every : t.cycle % every;
            for (let i = 0; i < every; i++) {
                const b = document.createElement('b');
                if (i < filled) b.className = 'on';
                pips.appendChild(b);
            }
            els.sub.appendChild(pips);
        } else if (t.kind === 'stopwatch') {
            els.sub.textContent = t.laps.length ? `Lap ${t.laps.length + 1}` : (t.status === 'running' ? 'Running' : t.status === 'paused' ? 'Paused' : 'Stopwatch');
        } else if (t.status === 'running') {
            const rounds = t.repeat !== 0 ? ` · ${t.repeatsDone + 1}/${t.repeat < 0 ? '∞' : t.repeat + 1}` : '';
            els.sub.textContent = 'Ends ' + endsAt(t.endAt) + rounds;
        } else {
            els.sub.textContent = t.status === 'done' ? "Time's up" : t.status === 'paused' ? 'Paused' : 'Ready';
        }
    }

    function schedule() {
        clearTimeout(tickHandle);
        tickHandle = null;
        if (!state || state.timer.status !== 'running') return;
        const t = state.timer;
        let delay;
        if (t.kind === 'stopwatch') {
            delay = 100 - (E.elapsed(t, Date.now()) % 100);
        } else {
            const left = E.remaining(t, Date.now());
            // The countdown display rounds up, so digits change just after
            // each whole second of `left` elapses.
            delay = (left % 1000) || 1000;
        }
        tickHandle = setTimeout(() => {
            tickHandle = null;
            paint();
            schedule();
        }, Math.max(16, Math.min(1000, delay + 4)));
    }

    function apply(payload) {
        if (!payload || !payload.timer) return;
        const key = payload.prefs.style + '|' + payload.prefs.size;
        const restyled = layoutKey !== '' && key !== layoutKey;
        layoutKey = key;
        state = payload;
        if (restyled) {
            root.classList.add('no-trans');
            pendingLayout = E.floatDims(payload.prefs.style, payload.prefs.size);
            clearTimeout(layoutFallback);
            // A window clamped smaller than its look (tiny screen) never matches.
            layoutFallback = setTimeout(finishLayout, 500);
        }
        applyChrome();
        paint();
        schedule();
        checkLayout();
    }
    window.addEventListener('resize', checkLayout);

    function run(action, arg) { return api.action(action, arg); }

    els.primary.addEventListener('click', () => {
        const t = state && state.timer;
        if (!t) return;
        if (t.status === 'done') run(t.kind === 'pomodoro' ? 'start' : 'restart');
        else run('toggle');
    });
    els.secondary.addEventListener('click', () => {
        const t = state && state.timer;
        if (!t) return;
        if (t.status === 'done') run('dismiss');
        else if (t.kind === 'stopwatch') run(t.status === 'running' ? 'lap' : 'reset');
        else run('adjust', 60000);
    });
    els.more.addEventListener('click', () => api.menu());
    els.close.addEventListener('click', () => api.close());
    els.ghost.addEventListener('click', () => api.exitGhost());
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); api.menu(); });

    // Ghost mode: the window lets clicks fall through to whatever is under it,
    // but still receives mouse MOVES. Ask main to catch clicks only while the
    // pointer is over the unlock handle.
    document.addEventListener('mousemove', (e) => {
        if (!state || !state.prefs.ghost) return;
        root.classList.add('near');
        const r = els.ghost.getBoundingClientRect();
        const over = e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
        if (over !== overHandle) {
            overHandle = over;
            api.hoverHandle(over);
        }
    });
    document.addEventListener('mouseleave', () => {
        root.classList.remove('near');
        if (overHandle) { overHandle = false; api.hoverHandle(false); }
    });

    document.addEventListener('keydown', (e) => {
        const t = state && state.timer;
        if (!t || e.ctrlKey || e.altKey || e.metaKey) return;
        const k = e.key.toLowerCase();
        if (k === ' ' || k === 'enter') { e.preventDefault(); els.primary.click(); }
        else if (k === 'r') run(t.status === 'done' ? 'dismiss' : 'reset');
        else if (k === 'l') run('lap');
        else if (k === '+' || k === '=') run('adjust', 60000);
        else if (k === '-' || k === '_') run('adjust', -60000);
        else if (k === 's') run('skip');
        else if (k === 'escape') api.close();
    });

    api.onState(apply);
    api.onAlert((a) => {
        if (!a || a.type === 'done') return; // 'done' already pulses via .is-done
        root.classList.remove('flash');
        void root.offsetWidth;
        root.classList.add('flash');
        setTimeout(() => root.classList.remove('flash'), 1700);
    });
    api.ready().then(apply).catch(() => { /* main will push state */ });
})();
