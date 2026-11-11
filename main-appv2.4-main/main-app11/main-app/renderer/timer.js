        // ── Timers mini widget (renderer UI) ──
        // The main process owns the timers (main/timers.js): the alarm scheduler,
        // the floating always-on-top timer windows and the global hotkeys all
        // live there, because a hidden launcher throttles renderer timers and an
        // alarm set before minimising to the tray used to fire late. Every rule
        // about time lives in renderer/timer-engine.js, shared with main. THIS
        // file is only UI: it renders the library panel and the header readout
        // from the state main broadcasts, sends actions back, and plays the
        // alarm sound.
        //
        // Nothing here polls. While something is running, ONE setTimeout is
        // aimed at the moment the visible digits next change; with nothing
        // running, nothing is scheduled.
        //
        // The old single-countdown globals (timerStart, timerPause, getTimerState,
        // timerRemaining, formatTimerClock…) are kept — the voice assistant calls
        // them — and act on the "current" timer.

        const TmE = window.TimerEngine;
        const TM_TABS = [
            { id: 'timers', label: 'Timers', icon: 'fa-hourglass-half' },
            { id: 'stopwatch', label: 'Stopwatch', icon: 'fa-stopwatch' },
            { id: 'focus', label: 'Focus', icon: 'fa-brain' },
            { id: 'stats', label: 'Stats', icon: 'fa-chart-simple' },
            { id: 'settings', label: 'Settings', icon: 'fa-sliders' }
        ];
        // `repeat` is the number of EXTRA rounds; -1 loops until stopped.
        const TM_REPEATS = [
            { v: 0, l: 'Once' }, { v: 1, l: '2×' }, { v: 2, l: '3×' }, { v: 4, l: '5×' }, { v: -1, l: 'Loop' }
        ];
        const TM_RING_MAX_S = 60;
        const TM_FOCUS_RADIUS = 88;
        const TM_FOCUS_CIRC = 2 * Math.PI * TM_FOCUS_RADIUS;
        const TM_PHASE_ICONS = { focus: 'fa-brain', short: 'fa-mug-hot', long: 'fa-couch' };
        const TM_WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

        // [offset s, frequency Hz, wave, length s, gain, glide-to Hz]
        const TM_SOUND_PATTERNS = {
            chime: { cycle: 1.8, notes: [[0, 880, 'sine', 0.9, 1], [0.16, 1174.66, 'sine', 0.9, 0.9], [0.32, 1318.51, 'sine', 1.2, 0.85]] },
            bell: { cycle: 2.6, notes: [[0, 660, 'sine', 2.2, 1], [0, 1821.6, 'sine', 1.2, 0.35], [0, 1320, 'triangle', 1.4, 0.25]] },
            digital: { cycle: 1.1, notes: [[0, 1760, 'square', 0.07, 0.3], [0.13, 1760, 'square', 0.07, 0.3], [0.26, 1760, 'square', 0.07, 0.3], [0.39, 1760, 'square', 0.07, 0.3]] },
            soft: { cycle: 2.4, notes: [[0, 523.25, 'sine', 1.1, 0.8], [0.35, 659.25, 'sine', 1.4, 0.7]] },
            rise: { cycle: 1.8, notes: [[0, 440, 'sine', 0.5, 0.8, 880], [0.5, 1318.51, 'sine', 0.9, 0.8]] }
        };
        const TM_WARN_PATTERN = { cycle: 0.6, notes: [[0, 987.77, 'sine', 0.35, 0.7], [0.14, 987.77, 'sine', 0.35, 0.5]] };
        const TM_CHECKPOINT_PATTERN = { cycle: 0.7, notes: [[0, 783.99, 'sine', 0.3, 0.7], [0.12, 1046.5, 'sine', 0.45, 0.75]] };

        const TM_REGIONS = {
            tabs: tmTabsHtml,
            presets: tmPresetsHtml,
            countdowns: tmCountdownsHtml,
            stopwatch: tmStopwatchHtml,
            focus: tmFocusHtml,
            focusSettings: tmFocusSettingsHtml,
            stats: tmStatsHtml,
            settings: tmSettingsHtml
        };

        let tmState = null;
        let tmSubscribed = false;
        let tmLoading = false;
        let tmTickHandle = null;
        let tmTab = (() => {
            try {
                const t = localStorage.getItem('timerTab');
                return TM_TABS.some(x => x.id === t) ? t : 'timers';
            } catch (e) { return 'timers'; }
        })();
        const tmDraft = { text: '', label: '', color: null, float: false, repeat: 0 };
        let tmEditing = null;      // { id, field: 'label' | 'duration' }
        let tmDirty = false;       // state arrived while an input in a region had focus
        let tmRing = null;         // { stop, timerId } — the alarm currently sounding
        let tmBinding = null;      // settings key being bound to a hotkey
        let tmLegacyChecked = false;
        let tmClearArmed = false;
        const tmCpOpen = new Set();   // timer ids whose checkpoint editor is open
        const tmCpMode = {};          // timer id -> 'left' | 'in' | 'every'

        function isTimerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.timer;
        }

        async function tmCall(method, ...args) {
            const fn = window.electronAPI && window.electronAPI[method];
            if (typeof fn !== 'function') return { ok: false, error: 'Timers aren’t available' };
            try {
                const res = await fn(...args);
                if (res && res.ok === false && res.error && typeof showToast === 'function') showToast(res.error, true);
                return res;
            } catch (e) {
                console.warn('[timers]', method, e);
                return { ok: false };
            }
        }

        // ── State ─────────────────────────────────────────────────────────────

        function tmSetState(s) {
            if (!s || !Array.isArray(s.timers)) return;
            tmState = s;
            tmCheckRing();
            updateTimerIndicator();
            tmRenderRegions();
            tmScheduleTick();
        }

        async function tmRefresh() {
            if (tmLoading) return;
            tmLoading = true;
            const s = await tmCall('timerGet');
            tmLoading = false;
            if (s && Array.isArray(s.timers)) {
                tmSetState(s);
                if (!document.querySelector('#timer-panel .tm')) renderTimerPanel();
            } else {
                const panel = document.getElementById('timer-panel');
                if (panel) panel.innerHTML = '<div class="tm"><p class="tm-muted">Timers couldn’t load — try toggling the widget off and on.</p></div>';
            }
        }

        function tmSubscribe() {
            if (tmSubscribed || !window.electronAPI) return;
            tmSubscribed = true;
            if (window.electronAPI.onTimerChanged) window.electronAPI.onTimerChanged(tmSetState);
            if (window.electronAPI.onTimerAlert) window.electronAPI.onTimerAlert(tmOnAlert);
            if (window.electronAPI.onTimerOpen) window.electronAPI.onTimerOpen(tmOnOpen);
            document.addEventListener('focusout', (e) => {
                if (!tmDirty || !e.target || !e.target.closest || !e.target.closest('#timer-panel')) return;
                const flush = () => setTimeout(() => {
                    if (!tmDirty) return;
                    tmDirty = false;
                    tmRenderRegions();
                }, 0);
                // Focus moving to a button in the panel means a click is on its
                // way — re-rendering now would replace that button under the
                // pointer and swallow the click. Catch up after it lands.
                const next = e.relatedTarget;
                if (next && next.tagName === 'BUTTON' && next.closest && next.closest('#timer-panel')) {
                    document.addEventListener('click', flush, { once: true });
                    setTimeout(flush, 1500);
                } else {
                    flush();
                }
            });
        }

        function tmTimers(kind) {
            return tmState ? tmState.timers.filter(t => !kind || t.kind === kind) : [];
        }

        function tmFind(id) {
            return tmState ? tmState.timers.find(t => t.id === id) || null : null;
        }

        function tmIsFloating(id) {
            return !!(tmState && Array.isArray(tmState.openFloats) && tmState.openFloats.includes(id));
        }

        function tmActiveCount(kind) {
            return tmTimers(kind).filter(t => t.status === 'running' || t.status === 'done').length;
        }

        // The "current" timer: one that's ringing, else the one ending soonest,
        // else the one last touched, else a paused one.
        function tmPick(list) {
            const now = Date.now();
            const done = list.find(t => t.status === 'done');
            if (done) return done;
            const running = list.filter(t => t.status === 'running')
                .sort((a, b) => (a.kind === 'stopwatch' ? Infinity : TmE.remaining(a, now)) - (b.kind === 'stopwatch' ? Infinity : TmE.remaining(b, now)));
            if (running.length) return running[0];
            const focused = tmState && list.find(t => t.id === tmState.focusId);
            if (focused) return focused;
            return list.find(t => t.status === 'paused') || list[0] || null;
        }

        function tmPrimary(skipStopwatch) {
            return tmPick(tmTimers().filter(t => !skipStopwatch || t.kind !== 'stopwatch'));
        }

        function tmClockTime(ts) {
            try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
        }

        function tmMinutesText(ms) {
            const m = Math.round((ms || 0) / 60000);
            const h = Math.floor(m / 60);
            return h ? `${h}h ${m % 60}m` : `${m}m`;
        }

        // ── Legacy globals (voice assistant) ──────────────────────────────────

        function getTimerState() {
            const t = tmPrimary(true);
            if (!t) return { status: 'idle', durationMs: 0, remainingMs: 0, endTime: null };
            return {
                status: t.status,
                durationMs: t.durationMs,
                remainingMs: t.status === 'idle' ? 0 : TmE.remaining(t, Date.now()),
                endTime: t.status === 'running' ? t.endAt : null,
                label: TmE.displayName(t),
                id: t.id
            };
        }

        function timerRemaining(state) {
            const s = state || getTimerState();
            if (s.status === 'running' && s.endTime != null) return Math.max(0, s.endTime - Date.now());
            if (s.status === 'done') return 0;
            return Math.max(0, s.remainingMs || 0);
        }

        function formatTimerClock(ms) {
            return TmE ? TmE.formatClock(ms, 0) : '00:00';
        }

        function timerStart(durationMs, label) {
            return tmCall('timerCreate', { kind: 'countdown', durationMs: Math.max(1000, Math.round(durationMs)), label: label || '', start: true });
        }

        function timerStartPreset(ms) { return timerStart(ms); }

        function timerPause() {
            const t = tmTimers().find(x => x.kind !== 'stopwatch' && x.status === 'running');
            if (t) tmAct(t.id, 'pause');
        }

        function timerResume() {
            const t = tmTimers().find(x => x.kind !== 'stopwatch' && x.status === 'paused');
            if (t) tmAct(t.id, 'resume');
        }

        function timerReset() {
            const t = tmPrimary(true);
            if (t) tmAct(t.id, t.status === 'done' ? 'dismiss' : 'reset');
        }

        function timerRestart() {
            const t = tmPrimary(true);
            if (t) tmAct(t.id, 'restart');
        }

        async function timerStartStopwatch() {
            const sw = tmPick(tmTimers('stopwatch'));
            if (sw && sw.status === 'running') return { ok: true, message: 'Stopwatch already running' };
            const res = sw ? await tmAct(sw.id, 'start') : await tmCall('timerCreate', { kind: 'stopwatch', start: true });
            return res && res.ok ? { ok: true, message: 'Stopwatch started' } : { ok: false, message: 'Couldn’t start the stopwatch' };
        }

        async function timerStartFocus() {
            const t = tmTimers('pomodoro')[0];
            if (t && t.status === 'running') return { ok: true, message: `${TmE.PHASE_LABELS[t.phase]} already running` };
            const res = t ? await tmAct(t.id, 'start') : await tmCall('timerCreate', { kind: 'pomodoro', start: true });
            const phase = res && res.timer ? res.timer.phase : 'focus';
            return res && res.ok ? { ok: true, message: `${TmE.PHASE_LABELS[phase]} started` } : { ok: false, message: 'Couldn’t start a focus session' };
        }

        async function timerFloatPrimary() {
            const t = tmPrimary(false);
            if (!t) return { ok: false, message: 'No timer to pop out — set one first' };
            const res = await tmCall('timerFloatOpen', t.id);
            return res && res.ok ? { ok: true, message: `${TmE.displayName(t)} is floating` } : { ok: false, message: (res && res.error) || 'Couldn’t pop the timer out' };
        }

        // ── Actions ───────────────────────────────────────────────────────────

        function tmAct(id, action, arg) {
            return tmCall('timerAction', id, action, arg);
        }

        function tmRemove(id) {
            if (tmEditing && tmEditing.id === id) tmEditing = null;
            return tmCall('timerRemove', id);
        }

        function tmToggleFloat(id) {
            return tmIsFloating(id) ? tmCall('timerFloatClose', id) : tmCall('timerFloatOpen', id);
        }

        function tmCycleColor(id) {
            const t = tmFind(id);
            if (!t) return;
            const i = TmE.COLORS.indexOf(t.color);
            tmCall('timerUpdate', id, { color: TmE.COLORS[(i + 1) % TmE.COLORS.length] });
        }

        function tmCycleRepeat(id) {
            const t = tmFind(id);
            if (!t) return;
            const i = TM_REPEATS.findIndex(r => r.v === t.repeat);
            tmCall('timerUpdate', id, { repeat: TM_REPEATS[(i + 1) % TM_REPEATS.length].v });
        }

        function tmRepeatLabel(v) {
            const r = TM_REPEATS.find(x => x.v === v);
            return r ? r.l : (v < 0 ? 'Loop' : (v + 1) + '×');
        }

        function tmPauseAll() {
            for (const t of tmTimers('countdown')) if (t.status === 'running') tmAct(t.id, 'pause');
        }

        function tmClearFinished() {
            for (const t of tmTimers('countdown')) if (t.status === 'done') tmRemove(t.id);
        }

        function tmStartRename(id) {
            tmEditing = { id, field: 'label' };
            tmRenderRegions();
            const el = document.getElementById('tm-rename-' + id);
            if (el) { el.focus(); el.select(); }
        }

        function tmEditKey(e, id) {
            if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
            else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                tmEditing = null;
                tmRenderRegions();
            }
        }

        function tmCommitRename(id) {
            if (!tmEditing || tmEditing.id !== id || tmEditing.field !== 'label') return;
            const el = document.getElementById('tm-rename-' + id);
            const t = tmFind(id);
            tmEditing = null;
            if (el && t && el.value.trim() !== t.label) tmCall('timerUpdate', id, { label: el.value });
            else tmRenderRegions();
        }

        function tmStartEditDuration(id) {
            const t = tmFind(id);
            if (!t || t.kind !== 'countdown' || t.status === 'running') return;
            tmEditing = { id, field: 'duration' };
            tmRenderRegions();
            const el = document.getElementById('tm-dur-' + id);
            if (el) { el.focus(); el.select(); }
        }

        function tmCommitDuration(id) {
            if (!tmEditing || tmEditing.id !== id || tmEditing.field !== 'duration') return;
            const el = document.getElementById('tm-dur-' + id);
            tmEditing = null;
            const parsed = el && el.value.trim() ? TmE.parseDuration(el.value, Date.now()) : null;
            if (el && el.value.trim() && !parsed) showToast('Try “10”, “5:30” or “1h 15m”', true);
            if (parsed) tmCall('timerUpdate', id, { durationMs: parsed.ms });
            else tmRenderRegions();
        }

        async function tmCopyLaps(id) {
            const t = tmFind(id);
            if (!t || !t.laps.length) return;
            const lines = TmE.lapRows(t.laps).map(r => `Lap ${r.n}\t${TmE.formatClock(r.lap, 2)}\t${TmE.formatClock(r.total, 2)}`);
            try {
                await navigator.clipboard.writeText([TmE.displayName(t)].concat(lines).join('\n'));
                showToast('Laps copied');
            } catch (e) {
                showToast('Couldn’t copy the laps', true);
            }
        }

        // ── Quick start ───────────────────────────────────────────────────────

        function tmDraftColor() {
            return tmDraft.color || TmE.COLORS[tmTimers('countdown').length % TmE.COLORS.length];
        }

        function tmDraftSet(key, value) {
            if (key === 'repeat') tmDraft.repeat = Number(value) || 0;
            else if (key === 'float') tmDraft.float = !!value;
            else if (key === 'label') tmDraft.label = String(value || '');
        }

        function tmDraftSetColor(color) {
            tmDraft.color = color;
            document.querySelectorAll('#timer-panel .tm-color').forEach(b => b.classList.toggle('on', b.dataset.color === color));
        }

        function tmPreview() {
            const text = tmDraft.text.trim();
            if (!text) return { text: 'Type a time — or tap a preset below', bad: false };
            const now = Date.now();
            const p = TmE.parseDuration(text, now);
            if (!p) return { text: 'Try “10”, “5:30”, “1h 15m” or “at 5pm”', bad: true };
            if (p.until) return { text: `Until ${tmClockTime(p.until)} · ${TmE.formatHuman(p.ms)}`, bad: false };
            return { text: `${TmE.formatHuman(p.ms)} · ends ${tmClockTime(now + p.ms)}`, bad: false };
        }

        function tmQuickInput() {
            const input = document.getElementById('tm-q-time');
            tmDraft.text = input ? input.value : '';
            const el = document.getElementById('tm-q-preview');
            if (!el) return;
            const p = tmPreview();
            el.textContent = p.text;
            el.classList.toggle('bad', p.bad);
        }

        function tmQuickKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); tmQuickStart(); }
        }

        async function tmCreateFromDraft(opts) {
            const res = await tmCall('timerCreate', Object.assign({
                kind: 'countdown',
                label: tmDraft.label,
                color: tmDraftColor(),
                repeat: tmDraft.repeat,
                float: tmDraft.float,
                start: true
            }, opts));
            if (res && res.ok) {
                tmDraft.label = '';
                tmDraft.color = null;
                const label = document.getElementById('tm-q-label');
                if (label) label.value = '';
            }
            return res;
        }

        async function tmQuickStart() {
            const input = document.getElementById('tm-q-time');
            if (input) tmDraft.text = input.value;
            const p = TmE.parseDuration(tmDraft.text, Date.now());
            if (!p) {
                showToast(tmDraft.text.trim() ? 'Try “10”, “5:30”, “1h 15m” or “at 5pm”' : 'Type a time first', true);
                if (input) input.focus();
                return;
            }
            const res = await tmCreateFromDraft(p.until ? { until: p.until } : { durationMs: p.ms });
            if (res && res.ok) {
                tmDraft.text = '';
                if (input) input.value = '';
                tmQuickInput();
                tmRenderRegions();
            }
        }

        function tmStartPreset(presetId) {
            const p = tmState && tmState.presets.find(x => x.id === presetId);
            if (p) tmCreateFromDraft({ durationMs: p.ms });
        }

        function tmDeletePreset(presetId) {
            tmCall('timerDeletePreset', presetId);
        }

        function tmSavePresetFromInput() {
            const input = document.getElementById('tm-q-time');
            const p = input ? TmE.parseDuration(input.value, Date.now()) : null;
            if (!p || p.until) {
                showToast('Type a duration above, then save it as a preset', true);
                if (input) input.focus();
                return;
            }
            const label = document.getElementById('tm-q-label');
            tmCall('timerSavePreset', { ms: p.ms, label: label && label.value.trim() ? label.value : '' });
        }

        // ── Header readout ────────────────────────────────────────────────────

        function updateTimerIndicator() {
            const el = document.getElementById('timer-indicator');
            if (!el) return;
            const active = isTimerEnabled() && tmState && TmE
                ? tmState.timers.filter(t => t.status === 'running' || t.status === 'paused' || t.status === 'done')
                : [];
            if (!active.length) {
                el.classList.add('hidden');
                el.classList.remove('timer-indicator-done');
                el.dataset.sig = '';
                return;
            }
            const t = tmPick(active);
            const done = t.status === 'done';
            const sig = [t.id, t.status, t.color, active.length].join('|');
            if (el.dataset.sig !== sig) {
                el.dataset.sig = sig;
                const icon = done ? 'fa-bell' : t.status === 'paused' ? 'fa-pause'
                    : t.kind === 'stopwatch' ? 'fa-stopwatch' : t.kind === 'pomodoro' ? (TM_PHASE_ICONS[t.phase] || 'fa-brain') : 'fa-hourglass-half';
                el.innerHTML = `<i class="fas ${icon} text-[10px]"></i><span class="tabular-nums" id="timer-indicator-text"></span>${active.length > 1 ? `<span class="timer-indicator-more">+${active.length - 1}</span>` : ''}`;
                el.style.setProperty('--tm-c', t.color);
                el.classList.remove('hidden');
                el.classList.toggle('timer-indicator-done', done);
                el.title = done ? `${TmE.displayName(t)} finished — click to open` : `${TmE.displayName(t)} — click to open Timers`;
            }
            const now = Date.now();
            let text;
            if (done) text = t.kind === 'pomodoro' ? (t.phase === 'focus' ? 'Focus?' : 'Break!') : 'Done';
            else if (t.kind === 'stopwatch') text = TmE.formatClock(TmE.elapsed(t, now), 0, false);
            else text = TmE.formatClock(TmE.remaining(t, now), 0);
            const span = document.getElementById('timer-indicator-text');
            if (span && span.textContent !== text) span.textContent = text;
        }

        function openTimerFromIndicator() {
            tmStopRing();
            const t = tmState && tmPick(tmState.timers.filter(x => x.status !== 'idle'));
            if (t) tmTabForKind(t.kind);
            if (typeof openWidgetLibrary === 'function') openWidgetLibrary('timer');
        }

        function tmTabForKind(kind) {
            tmTab = kind === 'stopwatch' ? 'stopwatch' : kind === 'pomodoro' ? 'focus' : 'timers';
            try { localStorage.setItem('timerTab', tmTab); } catch (e) { /* non-fatal */ }
        }

        // ── Live ticking ──────────────────────────────────────────────────────

        function tmPanelVisible() {
            const p = document.getElementById('timer-panel');
            return !!(p && !p.classList.contains('hidden') && p.offsetParent !== null);
        }

        function tmScheduleTick() {
            clearTimeout(tmTickHandle);
            tmTickHandle = null;
            if (!tmState || !TmE || !isTimerEnabled()) return;
            const running = tmState.timers.filter(t => t.status === 'running');
            if (!running.length) return;
            const now = Date.now();
            const fine = tmPanelVisible();
            let delay = 1000;
            for (const t of running) {
                let d;
                if (t.kind === 'stopwatch') {
                    const el = TmE.elapsed(t, now);
                    d = fine ? 100 - (el % 100) : 1000 - (el % 1000);
                } else {
                    d = (TmE.remaining(t, now) % 1000) || 1000;
                }
                delay = Math.min(delay, d);
            }
            tmTickHandle = setTimeout(tmTick, Math.max(16, delay + 6));
        }

        function tmTick() {
            tmTickHandle = null;
            updateTimerIndicator();
            tmPaintLive();
            tmScheduleTick();
        }

        function tmClockParts(t, now) {
            if (t.kind === 'stopwatch') {
                const full = TmE.formatClock(TmE.elapsed(t, now), 1);
                const dot = full.lastIndexOf('.');
                return { main: full.slice(0, dot), frac: full.slice(dot) };
            }
            // A finished focus/break phase is waiting to start the next one.
            if (t.kind === 'pomodoro' && t.status === 'done') return { main: TmE.formatClock(t.durationMs, 0), frac: '' };
            return { main: TmE.formatClock(TmE.remaining(t, now), 0), frac: '' };
        }

        function tmClockInner(t, now) {
            const p = tmClockParts(t, now);
            return p.main + (p.frac ? `<span class="frac">${p.frac}</span>` : '');
        }

        function tmBarFraction(t, now) {
            if (t.kind === 'stopwatch') return TmE.progress(t, now);
            if (t.status === 'idle') return 1;
            return 1 - TmE.progress(t, now);
        }

        function tmRingOffset(t, now) {
            if (!t || t.status === 'idle' || (t.kind === 'pomodoro' && t.status === 'done')) return 0;
            return TM_FOCUS_CIRC * TmE.progress(t, now);
        }

        function tmInfoText(t, now) {
            if (t.kind === 'stopwatch') {
                if (!t.laps.length) return t.status === 'running' ? 'Running' : t.status === 'paused' ? 'Paused' : 'Ready';
                return `${t.laps.length} lap${t.laps.length === 1 ? '' : 's'}`;
            }
            const rounds = t.kind === 'countdown' && t.repeat !== 0 ? ` · round ${t.repeatsDone + 1}/${t.repeat < 0 ? '∞' : t.repeat + 1}` : '';
            if (t.status === 'running') {
                const nextCp = t.kind === 'countdown' ? (t.checkpoints || []).find(c => !c.hit && c.leftMs < t.durationMs) : null;
                const cp = nextCp ? ` · 🚩 in ${TmE.formatClock(Math.max(0, TmE.remaining(t, now) - nextCp.leftMs), 0)}` : '';
                return `Ends ${tmClockTime(t.endAt)}${rounds}${cp}`;
            }
            if (t.status === 'paused') return `Paused · ${TmE.formatHuman(TmE.remaining(t, now))} left`;
            if (t.status === 'done') {
                if (t.kind === 'pomodoro') return `Up next: ${TmE.PHASE_LABELS[t.phase].toLowerCase()}`;
                return t.doneAt ? `Finished ${tmClockTime(t.doneAt)}` : "Time's up";
            }
            return TmE.formatHuman(t.durationMs) + (t.repeat !== 0 && t.kind === 'countdown' ? ` · repeats ${tmRepeatLabel(t.repeat)}` : '');
        }

        // Updates only the moving parts — never re-renders, so inputs keep focus.
        function tmPaintLive() {
            if (!tmState || !TmE || !document.getElementById('timer-panel')) return;
            const now = Date.now();
            for (const t of tmState.timers) {
                const clock = document.getElementById('tm-clock-' + t.id);
                if (clock) {
                    const html = tmClockInner(t, now);
                    if (clock.dataset.v !== html) { clock.dataset.v = html; clock.innerHTML = html; }
                }
                const prog = document.getElementById('tm-prog-' + t.id);
                if (prog) prog.style.width = (tmBarFraction(t, now) * 100).toFixed(2) + '%';
                const info = document.getElementById('tm-info-' + t.id);
                if (info) {
                    const txt = tmInfoText(t, now);
                    if (info.textContent !== txt) info.textContent = txt;
                }
                const cur = document.getElementById('tm-curlap-' + t.id);
                if (cur) cur.textContent = TmE.formatClock(TmE.elapsed(t, now) - (t.laps.length ? t.laps[t.laps.length - 1] : 0), 1);
                const arc = document.getElementById('tm-arc-' + t.id);
                if (arc) arc.style.strokeDashoffset = String(tmRingOffset(t, now));
            }
        }

        // ── Alarms ────────────────────────────────────────────────────────────

        function tmNote(ctx, dest, at, n) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = n[2];
            osc.frequency.setValueAtTime(n[1], at);
            if (n[5]) osc.frequency.exponentialRampToValueAtTime(n[5], at + n[3] * 0.8);
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(n[4], at + 0.012);
            g.gain.exponentialRampToValueAtTime(0.0001, at + n[3]);
            osc.connect(g);
            g.connect(dest);
            osc.start(at);
            osc.stop(at + n[3] + 0.05);
        }

        // Everything is scheduled on the AUDIO clock up front, which Chromium
        // does not throttle — so a looping alarm keeps its rhythm while the
        // launcher is hidden in the tray. Returns a stop function (or null).
        function tmPlaySound(sound, volume, opts) {
            const o = opts || {};
            if (sound === 'none' || !(volume > 0)) return null;
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            try {
                const ctx = new Ctx();
                const master = ctx.createGain();
                master.gain.value = Math.pow(volume / 100, 2) * 0.55;
                master.connect(ctx.destination);
                const pat = o.soft
                    ? (o.checkpoint ? TM_CHECKPOINT_PATTERN : TM_WARN_PATTERN)
                    : (TM_SOUND_PATTERNS[sound] || TM_SOUND_PATTERNS.chime);
                const cycles = o.loop ? Math.max(1, Math.floor(TM_RING_MAX_S / pat.cycle)) : (o.soft ? 1 : 2);
                const start = ctx.currentTime + 0.05;
                for (let c = 0; c < cycles; c++) {
                    for (const n of pat.notes) tmNote(ctx, master, start + c * pat.cycle + n[0], n);
                }
                let closed = false;
                const stop = () => {
                    if (closed) return;
                    closed = true;
                    try { master.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch (e) { /* closing */ }
                    setTimeout(() => { try { ctx.close(); } catch (e) { /* already closed */ } }, 200);
                };
                setTimeout(stop, (cycles * pat.cycle + 1.5) * 1000);
                return stop;
            } catch (e) {
                // Sound is a nicety — never let it break the timer.
                return null;
            }
        }

        function tmStopRing() {
            if (!tmRing) return;
            try { if (tmRing.stop) tmRing.stop(); } catch (e) { /* ignore */ }
            tmRing = null;
        }

        // A ringing timer that got dismissed, restarted or deleted — from the
        // panel, a floating window, a notification or a hotkey — goes quiet.
        function tmCheckRing() {
            if (!tmRing || !tmRing.timerId) return;
            const t = tmFind(tmRing.timerId);
            if (!t || t.status !== 'done') tmStopRing();
        }

        function tmOnAlert(a) {
            if (!a || !isTimerEnabled()) return;
            if (typeof showToast === 'function') {
                if (a.type === 'warn') showToast(`⏳ ${a.title}`, false, 3500);
                else if (a.type === 'checkpoint') showToast(`🚩 ${a.title} — ${a.body}`, false, 4000);
                else showToast(`⏰ ${a.title}${a.body ? ' — ' + a.body : ''}`, false, 5000);
            }
            if (a.soft) {
                tmPlaySound(a.sound, a.volume, { soft: true, checkpoint: a.type === 'checkpoint' });
                return;
            }
            tmStopRing();
            const stop = tmPlaySound(a.sound, a.volume, { loop: !!a.loop });
            if (stop) tmRing = { stop, timerId: a.loop ? a.timerId : null };
        }

        function tmOnOpen(p) {
            tmStopRing();
            const t = p && tmFind(p.timerId);
            if (t) tmTabForKind(t.kind);
            if (typeof openWidgetLibrary === 'function') openWidgetLibrary('timer');
            else renderTimerPanel();
        }

        function tmTestSound() {
            if (!tmState) return;
            tmStopRing();
            const stop = tmPlaySound(tmState.settings.sound, tmState.settings.volume, {});
            if (stop) tmRing = { stop, timerId: null };
            else if (tmState.settings.sound === 'none') showToast('Sound is set to Silent');
        }

        // ── Settings ──────────────────────────────────────────────────────────

        function tmSetSetting(key, value) {
            return tmCall('timerSetSettings', { [key]: value });
        }

        function tmFocusStep(key, delta) {
            if (!tmState) return;
            const cur = tmState.settings.pomodoro[key];
            let next = cur + delta;
            if (key !== 'longEvery' && Math.abs(delta) >= 5 && (delta < 0 ? cur <= 5 : cur < 5)) next = cur + Math.sign(delta);
            tmCall('timerSetSettings', { pomodoro: { [key]: next } });
        }

        function tmFocusToggle(key, on) {
            tmCall('timerSetSettings', { pomodoro: { [key]: !!on } });
        }

        function tmFocusAction(action) {
            const t = tmTimers('pomodoro')[0];
            if (!t) {
                tmCall('timerCreate', { kind: 'pomodoro', start: action === 'start', float: action === 'float' });
                return;
            }
            if (action === 'float') tmToggleFloat(t.id);
            else tmAct(t.id, action);
        }

        function tmNewStopwatch(start) {
            tmCall('timerCreate', { kind: 'stopwatch', start: !!start });
        }

        function tmClearHistory() {
            if (!tmClearArmed) {
                tmClearArmed = true;
                tmRenderRegions();
                setTimeout(() => { if (tmClearArmed) { tmClearArmed = false; tmRenderRegions(); } }, 4000);
                return;
            }
            tmClearArmed = false;
            tmCall('timerClearHistory');
        }

        function tmHotkeyText(accel) {
            if (!accel) return 'Not set';
            const raw = accel.replace(/CommandOrControl/g, 'Control');
            return typeof formatHotkeyDisplay === 'function' ? formatHotkeyDisplay(raw) : raw;
        }

        async function tmBindHotkey(key) {
            if (tmBinding || (typeof bindingTarget !== 'undefined' && bindingTarget)) return;
            tmBinding = key;
            if (typeof disableAllHotkeys === 'function') await disableAllHotkeys();
            window.addEventListener('keydown', tmBindListener, true);
            tmRenderRegions();
            showToast('Press a shortcut — Esc to cancel');
        }

        async function tmEndBind() {
            window.removeEventListener('keydown', tmBindListener, true);
            tmBinding = null;
            if (typeof enableAllHotkeys === 'function') await enableAllHotkeys();
            tmRenderRegions();
        }

        async function tmBindListener(e) {
            if (!tmBinding) return;
            // Capture phase on window runs before every document listener, so
            // the Widget Library and the app's close key never see this press.
            e.preventDefault();
            e.stopImmediatePropagation();
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            const key = tmBinding;
            if (e.key === 'Escape') {
                await tmEndBind();
                showToast('Cancelled');
                return;
            }
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            const isFKey = /^F\d{1,2}$/.test(accel.split('+').pop());
            if (!isFKey && !(e.ctrlKey || e.altKey || e.metaKey)) {
                showToast('Use Ctrl or Alt with a key — or an F-key', true);
                return;
            }
            const electronAccel = toElectronAccelerator(accel);
            const other = key === 'hotkeyToggle' ? 'hotkeyFloat' : 'hotkeyToggle';
            const takenInApp = typeof hotkeys === 'object' && hotkeys && Object.values(hotkeys).includes(accel);
            await tmEndBind();
            if (takenInApp || (tmState && tmState.settings[other] === electronAccel)) {
                showToast('That shortcut is already used in main', true);
                return;
            }
            const res = await tmCall('timerSetSettings', { [key]: electronAccel });
            const failed = res && res.hotkeys && Array.isArray(res.hotkeys.failed) ? res.hotkeys.failed : [];
            if (failed.includes(key === 'hotkeyToggle' ? 'toggle' : 'float')) {
                showToast('Another app already uses that shortcut', true);
                await tmCall('timerSetSettings', { [key]: '' });
            } else {
                showToast('Shortcut saved');
            }
        }

        // ── Rendering ─────────────────────────────────────────────────────────

        function tmSetTab(id) {
            if (!TM_TABS.some(t => t.id === id)) return;
            tmTab = id;
            tmEditing = null;
            try { localStorage.setItem('timerTab', id); } catch (e) { /* non-fatal */ }
            renderTimerPanel();
        }

        function renderTimerPanel() {
            const panel = document.getElementById('timer-panel');
            if (!panel) return;
            if (!isTimerEnabled()) { panel.innerHTML = ''; return; }
            if (!TmE) { panel.innerHTML = '<p class="tm-muted">Timers failed to load.</p>'; return; }
            tmSubscribe();
            if (!tmState) {
                panel.innerHTML = '<div class="tm"><p class="tm-muted">Loading timers…</p></div>';
                tmRefresh();
                return;
            }
            panel.innerHTML = `<div class="tm">
                <div data-tm-region="tabs">${tmTabsHtml()}</div>
                ${tmBodyHtml()}
            </div>`;
            tmPaintLive();
            tmScheduleTick();
        }

        // Re-renders the state-driven regions, leaving the quick-start inputs
        // alone. A region holding the focused input is skipped and caught up
        // when focus leaves it, so typing is never interrupted.
        function tmRenderRegions() {
            const panel = document.getElementById('timer-panel');
            if (!panel || !tmState) return;
            if (!panel.querySelector('.tm')) { renderTimerPanel(); return; }
            const active = document.activeElement;
            for (const el of panel.querySelectorAll('[data-tm-region]')) {
                const fn = TM_REGIONS[el.dataset.tmRegion];
                if (!fn) continue;
                const focusedHere = active && el.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
                if (focusedHere && active.id && active.dataset.tmKeep) {
                    // Plain text boxes with no commit-on-blur (the checkpoint
                    // editor): re-render and put the caret straight back, so a
                    // checkpoint firing mid-typing updates the list without
                    // eating what you typed.
                    const snap = { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd };
                    el.innerHTML = fn();
                    const again = document.getElementById(snap.id);
                    if (again) {
                        again.value = snap.value;
                        again.focus();
                        try { again.setSelectionRange(snap.start, snap.end); } catch (e) { /* not a text input */ }
                    }
                    continue;
                }
                if (focusedHere) { tmDirty = true; continue; }
                el.innerHTML = fn();
            }
            tmPaintLive();
        }

        function tmBodyHtml() {
            switch (tmTab) {
                case 'stopwatch':
                    return `<div data-tm-region="stopwatch">${tmStopwatchHtml()}</div>`;
                case 'focus':
                    return `<div data-tm-region="focus">${tmFocusHtml()}</div><div data-tm-region="focusSettings">${tmFocusSettingsHtml()}</div>`;
                case 'stats':
                    return `<div data-tm-region="stats">${tmStatsHtml()}</div>`;
                case 'settings':
                    return `<div data-tm-region="settings">${tmSettingsHtml()}</div>`;
                default:
                    return `${tmQuickHtml()}<div data-tm-region="presets">${tmPresetsHtml()}</div><div data-tm-region="countdowns">${tmCountdownsHtml()}</div>`;
            }
        }

        function tmTabsHtml() {
            const counts = { timers: tmActiveCount('countdown'), stopwatch: tmActiveCount('stopwatch'), focus: tmActiveCount('pomodoro') };
            return `<div class="tm-tabs">${TM_TABS.map(t => `
                <button type="button" class="tm-tab no-drag ${tmTab === t.id ? 'active' : ''}" onclick="tmSetTab(${jsAttr(t.id)})">
                    <i class="fas ${t.icon}"></i>${t.label}${counts[t.id] ? `<span class="tm-badge">${counts[t.id]}</span>` : ''}
                </button>`).join('')}</div>`;
        }

        function tmToggleHtml(label, sub, checked, call) {
            return `<label class="tm-toggle-row no-drag">
                <span class="ios-toggle"><input type="checkbox" class="ios-toggle-input" ${checked ? 'checked' : ''} onchange="${call}"><span class="ios-toggle-track"></span></span>
                <span>${label}${sub ? `<small>${sub}</small>` : ''}</span>
            </label>`;
        }

        function tmQuickHtml() {
            const preview = tmPreview();
            const color = tmDraftColor();
            return `<div class="tm-quick">
                <div class="tm-quick-row">
                    <input id="tm-q-time" class="tm-input tm-input-main no-drag" placeholder="25 · 5:30 · 1h15 · at 5pm" value="${esc(tmDraft.text)}"
                        oninput="tmQuickInput()" onkeydown="tmQuickKey(event)" autocomplete="off" spellcheck="false">
                    <input id="tm-q-label" class="tm-input tm-input-label no-drag" placeholder="Label (optional)" maxlength="40" value="${esc(tmDraft.label)}"
                        oninput="tmDraftSet('label', this.value)" onkeydown="tmQuickKey(event)" autocomplete="off">
                    <button type="button" class="tm-btn tm-btn-primary no-drag" onclick="tmQuickStart()"><i class="fas fa-play"></i>Start</button>
                </div>
                <div class="tm-quick-meta">
                    <span id="tm-q-preview" class="tm-preview ${preview.bad ? 'bad' : ''}">${esc(preview.text)}</span>
                    <div class="tm-colors">${TmE.COLORS.map(c => `<button type="button" class="tm-color no-drag ${c === color ? 'on' : ''}" data-color="${c}" style="background:${c}" title="Colour" onclick="tmDraftSetColor(${jsAttr(c)})"></button>`).join('')}</div>
                    <select class="tm-input tm-btn-sm no-drag" title="Repeat" onchange="tmDraftSet('repeat', this.value)">
                        ${TM_REPEATS.map(r => `<option value="${r.v}" ${tmDraft.repeat === r.v ? 'selected' : ''}>${r.v === 0 ? 'Once' : 'Repeat ' + r.l}</option>`).join('')}
                    </select>
                    <label class="tm-check no-drag" title="Open it as a floating window on your desktop"><input type="checkbox" ${tmDraft.float ? 'checked' : ''} onchange="tmDraftSet('float', this.checked)">Pop out</label>
                </div>
            </div>`;
        }

        function tmPresetsHtml() {
            const custom = JSON.stringify(tmState.presets.map(p => p.ms)) !== JSON.stringify(TmE.defaultPresets().map(p => p.ms));
            const chips = tmState.presets.map(p => `
                <button type="button" class="tm-chip no-drag" onclick="tmStartPreset(${jsAttr(p.id)})" title="Start a ${esc(TmE.formatHuman(p.ms))} timer">${esc(p.label)}<span class="tm-chip-x" title="Remove preset" onclick="event.stopPropagation(); tmDeletePreset(${jsAttr(p.id)})"><i class="fas fa-xmark"></i></span></button>`).join('');
            return `<div>
                <div class="tm-section-title">Presets
                    ${custom ? `<button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmCall('timerResetPresets')">Reset</button>` : '<small>Hover to remove · save your own</small>'}
                </div>
                <div class="tm-chips">${chips}
                    <button type="button" class="tm-chip tm-chip-add no-drag" onclick="tmSavePresetFromInput()" title="Save the time typed above as a preset"><i class="fas fa-plus"></i> Save</button>
                </div>
            </div>`;
        }

        function tmCardTopHtml(t, extraTools) {
            const renaming = tmEditing && tmEditing.id === t.id && tmEditing.field === 'label';
            const floating = tmIsFloating(t.id);
            const name = renaming
                ? `<input id="tm-rename-${t.id}" class="tm-input tm-rename no-drag" maxlength="40" value="${esc(t.label)}" placeholder="${esc(TmE.displayName(Object.assign({}, t, { label: '' })))}"
                        onkeydown="tmEditKey(event, ${jsAttr(t.id)})" onblur="tmCommitRename(${jsAttr(t.id)})">`
                : `<button type="button" class="tm-name no-drag" title="Rename" onclick="tmStartRename(${jsAttr(t.id)})">${esc(TmE.displayName(t))}</button>`;
            const tag = t.kind === 'countdown' && t.repeat !== 0
                ? `<span class="tm-tag"><i class="fas fa-repeat"></i> ${t.repeat < 0 ? 'loop' : `${t.repeatsDone + 1}/${t.repeat + 1}`}</span>`
                : '';
            return `<div class="tm-card-top">
                <span class="tm-dot"></span>${name}${tag}
                <div class="tm-tools">
                    ${extraTools || ''}
                    <button type="button" class="tm-icon no-drag" title="Change colour" onclick="tmCycleColor(${jsAttr(t.id)})"><i class="fas fa-palette"></i></button>
                    <button type="button" class="tm-icon no-drag ${floating ? 'on' : ''}" title="${floating ? 'Close the floating timer' : 'Pop out — float it on your desktop'}" onclick="tmToggleFloat(${jsAttr(t.id)})"><i class="fas fa-up-right-from-square"></i></button>
                    <button type="button" class="tm-icon tm-icon-danger no-drag" title="Delete" onclick="tmRemove(${jsAttr(t.id)})"><i class="fas fa-trash-can"></i></button>
                </div>
            </div>`;
        }

        function tmBtn(cls, icon, text, call, title) {
            return `<button type="button" class="tm-btn tm-btn-sm ${cls} no-drag" onclick="${call}"${title ? ` title="${title}"` : ''}>${icon ? `<i class="fas ${icon}"></i>` : ''}${text}</button>`;
        }

        function tmCountdownActions(t) {
            const id = jsAttr(t.id);
            switch (t.status) {
                case 'running':
                    return tmBtn('', 'fa-pause', 'Pause', `tmAct(${id}, 'pause')`)
                        + tmBtn('', '', '−1m', `tmAct(${id}, 'adjust', -60000)`, 'Take a minute off')
                        + tmBtn('', '', '+1m', `tmAct(${id}, 'adjust', 60000)`, 'Add a minute')
                        + tmBtn('', '', '+5m', `tmAct(${id}, 'adjust', 300000)`, 'Add five minutes')
                        + tmBtn('tm-btn-danger', 'fa-rotate-left', 'Reset', `tmAct(${id}, 'reset')`);
                case 'paused':
                    return tmBtn('tm-btn-primary', 'fa-play', 'Resume', `tmAct(${id}, 'resume')`)
                        + tmBtn('', '', '−1m', `tmAct(${id}, 'adjust', -60000)`, 'Take a minute off')
                        + tmBtn('', '', '+1m', `tmAct(${id}, 'adjust', 60000)`, 'Add a minute')
                        + tmBtn('tm-btn-danger', 'fa-rotate-left', 'Reset', `tmAct(${id}, 'reset')`);
                case 'done':
                    return tmBtn('tm-btn-accent', 'fa-rotate-right', 'Restart', `tmAct(${id}, 'restart')`)
                        + tmBtn('', 'fa-bell-slash', '+1 min', `tmAct(${id}, 'adjust', 60000)`, 'Snooze for a minute')
                        + tmBtn('', 'fa-bell-slash', '+5 min', `tmAct(${id}, 'adjust', 300000)`, 'Snooze for five minutes')
                        + tmBtn('', 'fa-check', 'Dismiss', `tmAct(${id}, 'dismiss')`);
                default:
                    return tmBtn('tm-btn-primary', 'fa-play', 'Start', `tmAct(${id}, 'start')`)
                        + tmBtn('', '', '−1m', `tmAct(${id}, 'adjust', -60000)`, 'A minute shorter')
                        + tmBtn('', '', '+1m', `tmAct(${id}, 'adjust', 60000)`, 'A minute longer')
                        + tmBtn('', '', '+5m', `tmAct(${id}, 'adjust', 300000)`, 'Five minutes longer');
            }
        }

        function tmCountdownCardHtml(t) {
            const now = Date.now();
            const editing = tmEditing && tmEditing.id === t.id && tmEditing.field === 'duration';
            const repeatTool = `<button type="button" class="tm-icon tm-icon-wide no-drag ${t.repeat !== 0 ? 'on' : ''}" title="Repeat: ${tmRepeatLabel(t.repeat)} — click to change" onclick="tmCycleRepeat(${jsAttr(t.id)})"><i class="fas fa-repeat"></i>${t.repeat !== 0 ? `<span>${tmRepeatLabel(t.repeat)}</span>` : ''}</button>`;
            let clock;
            if (editing) {
                clock = `<input id="tm-dur-${t.id}" class="tm-input tm-duration-edit no-drag" value="${esc(TmE.formatShort(t.durationMs))}" placeholder="e.g. 25 or 1h30"
                    onkeydown="tmEditKey(event, ${jsAttr(t.id)})" onblur="tmCommitDuration(${jsAttr(t.id)})" autocomplete="off" spellcheck="false">`;
            } else if (t.status === 'running') {
                clock = `<div class="tm-clock" id="tm-clock-${t.id}">${tmClockInner(t, now)}</div>`;
            } else {
                clock = `<button type="button" class="tm-clock no-drag" id="tm-clock-${t.id}" title="Change the duration" onclick="tmStartEditDuration(${jsAttr(t.id)})">${tmClockInner(t, now)}</button>`;
            }
            const cps = t.checkpoints || [];
            const cpOpen = tmCpOpen.has(t.id);
            const flagTool = `<button type="button" class="tm-icon tm-icon-wide no-drag ${cps.length || cpOpen ? 'on' : ''}" title="Checkpoints — get pinged part-way through" onclick="tmToggleCheckpoints(${jsAttr(t.id)})"><i class="fas fa-flag"></i>${cps.length ? `<span>${cps.length}</span>` : ''}</button>`;
            return `<div class="tm-card is-${t.status}" style="--c:${t.color}">
                ${tmCardTopHtml(t, flagTool + repeatTool)}
                <div class="tm-card-mid">${clock}<div class="tm-info" id="tm-info-${t.id}">${esc(tmInfoText(t, now))}</div></div>
                <div class="tm-progress-wrap">
                    <div class="tm-progress"><i id="tm-prog-${t.id}" style="width:${(tmBarFraction(t, now) * 100).toFixed(2)}%"></i></div>
                    ${tmCheckpointMarksHtml(t)}
                </div>
                ${cpOpen ? tmCheckpointEditorHtml(t) : ''}
                <div class="tm-actions">${tmCountdownActions(t)}</div>
            </div>`;
        }

        // ── Checkpoints ───────────────────────────────────────────────────────

        function tmCpText(c) {
            return `${TmE.formatClock(c.leftMs, 0)} left${c.label ? ' · ' + c.label : ''}`;
        }

        // Notches on the card's bar at the point the draining bar reaches when
        // each checkpoint fires — the same positions the floating ring uses.
        function tmCheckpointMarksHtml(t) {
            return TmE.checkpointMarks(t).map(m =>
                `<span class="tm-cp-mark ${m.hit ? 'hit' : ''}" style="left:${(m.frac * 100).toFixed(3)}%" title="${esc(tmCpText(m))}"></span>`
            ).join('');
        }

        function tmCheckpointEditorHtml(t) {
            const id = jsAttr(t.id);
            const mode = tmCpMode[t.id] || 'left';
            const cps = t.checkpoints || [];
            const chips = cps.map(c => `
                <span class="tm-cp-chip ${c.hit ? 'hit' : ''} ${c.leftMs >= t.durationMs ? 'out' : ''}" title="${c.leftMs >= t.durationMs ? 'Longer than this timer' : c.hit ? 'Passed' : 'Coming up'}">
                    <i class="fas fa-flag"></i>${esc(tmCpText(c))}
                    <button type="button" class="tm-cp-x no-drag" title="Remove" onclick="tmRemoveCheckpoint(${id}, ${jsAttr(c.id)})"><i class="fas fa-xmark"></i></button>
                </span>`).join('');
            const modes = [['left', 'left'], ['in', 'after start'], ['every', 'every']];
            return `<div class="tm-cp">
                <div class="tm-cp-row">
                    <input id="tm-cp-time-${t.id}" data-tm-keep="1" class="tm-input tm-cp-time no-drag" placeholder="5m · 2:30" autocomplete="off" spellcheck="false"
                        onkeydown="tmCheckpointKey(event, ${id})">
                    <select class="tm-input tm-btn-sm no-drag" title="When it fires" onchange="tmCpSetMode(${id}, this.value)">
                        ${modes.map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                    <input id="tm-cp-label-${t.id}" data-tm-keep="1" class="tm-input tm-cp-label no-drag" placeholder="Label (optional)" maxlength="30" autocomplete="off"
                        onkeydown="tmCheckpointKey(event, ${id})">
                    <button type="button" class="tm-btn tm-btn-sm tm-btn-accent no-drag" onclick="tmAddCheckpoint(${id})"><i class="fas fa-plus"></i>Add</button>
                </div>
                <div class="tm-chips">${chips || '<span class="tm-muted">No checkpoints yet. Each one pings you and flags the ring and bar when it passes.</span>'}</div>
                <div class="tm-cp-row">
                    <button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmCheckpointPreset(${id}, 'half')">Halfway</button>
                    <button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmCheckpointPreset(${id}, 'quarters')">Quarters</button>
                    <button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmCheckpointPreset(${id}, 'minute')">1 min left</button>
                    ${cps.length ? `<button type="button" class="tm-btn tm-btn-sm tm-btn-danger no-drag" style="margin-left:auto" onclick="tmClearCheckpoints(${id})">Clear</button>` : ''}
                </div>
            </div>`;
        }

        function tmToggleCheckpoints(id) {
            if (tmCpOpen.has(id)) tmCpOpen.delete(id);
            else tmCpOpen.add(id);
            tmRenderRegions();
            const input = tmCpOpen.has(id) && document.getElementById('tm-cp-time-' + id);
            if (input) input.focus();
        }

        function tmCpSetMode(id, mode) {
            tmCpMode[id] = ['left', 'in', 'every'].includes(mode) ? mode : 'left';
        }

        function tmCheckpointKey(e, id) {
            if (e.key === 'Enter') { e.preventDefault(); tmAddCheckpoint(id); }
        }

        async function tmSaveCheckpoints(t, list) {
            if (new Set(list.map(c => c.leftMs)).size > TmE.MAX_CHECKPOINTS) {
                showToast(`Up to ${TmE.MAX_CHECKPOINTS} checkpoints — kept the earliest`, true);
            }
            const res = await tmCall('timerSetCheckpoints', t.id, list);
            return !!(res && res.ok);
        }

        async function tmAddCheckpoint(id) {
            const t = tmFind(id);
            if (!t) return;
            const timeEl = document.getElementById('tm-cp-time-' + id);
            const labelEl = document.getElementById('tm-cp-label-' + id);
            const p = timeEl && timeEl.value.trim() ? TmE.parseDuration(timeEl.value, Date.now()) : null;
            if (!p || p.until) {
                showToast('Type a time like 5m, 90s or 2:30', true);
                if (timeEl) timeEl.focus();
                return;
            }
            const mode = tmCpMode[id] || 'left';
            const label = labelEl ? labelEl.value : '';
            const add = [];
            if (mode === 'every') {
                for (let k = 1; k * p.ms < t.durationMs && add.length < TmE.MAX_CHECKPOINTS; k++) add.push({ leftMs: t.durationMs - k * p.ms, label });
            } else {
                add.push({ leftMs: mode === 'in' ? t.durationMs - p.ms : p.ms, label });
            }
            const valid = add.filter(c => c.leftMs >= 1000 && c.leftMs < t.durationMs);
            if (!valid.length) {
                showToast(`That's outside this ${TmE.formatHuman(t.durationMs)} timer`, true);
                return;
            }
            if (await tmSaveCheckpoints(t, (t.checkpoints || []).concat(valid))) {
                const time = document.getElementById('tm-cp-time-' + id);
                const lab = document.getElementById('tm-cp-label-' + id);
                if (time) { time.value = ''; time.focus(); }
                if (lab) lab.value = '';
            }
        }

        function tmCheckpointPreset(id, kind) {
            const t = tmFind(id);
            if (!t) return;
            const d = t.durationMs;
            let add = [];
            if (kind === 'half') add = [{ leftMs: Math.round(d / 2), label: 'Halfway' }];
            else if (kind === 'quarters') add = [0.75, 0.5, 0.25].map(f => ({ leftMs: Math.round(d * f), label: '' }));
            else if (kind === 'minute') add = [{ leftMs: 60000, label: '1 min left' }];
            add = add.filter(c => c.leftMs >= 1000 && c.leftMs < d);
            if (!add.length) {
                showToast('This timer is too short for that', true);
                return;
            }
            tmSaveCheckpoints(t, (t.checkpoints || []).concat(add));
        }

        function tmRemoveCheckpoint(id, cpId) {
            const t = tmFind(id);
            if (t) tmSaveCheckpoints(t, (t.checkpoints || []).filter(c => c.id !== cpId));
        }

        function tmClearCheckpoints(id) {
            const t = tmFind(id);
            if (t) tmSaveCheckpoints(t, []);
        }

        function tmCountdownsHtml() {
            const list = tmTimers('countdown');
            if (!list.length) {
                return `<div class="tm-empty"><i class="fas fa-hourglass-start"></i>No timers yet.<br>Type a time above or tap a preset. Run as many as you like side by side,<br>and pop any of them out to float over your desktop, games or a second monitor.</div>`;
            }
            const running = list.some(t => t.status === 'running');
            const finished = list.some(t => t.status === 'done');
            return `<div>
                <div class="tm-section-title">Your timers <small>${tmState.timers.length}/${TmE.MAX_TIMERS}</small>
                    <span style="margin-left:auto; display:flex; gap:6px">
                        ${list.length > 1 && running ? `<button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmPauseAll()"><i class="fas fa-pause"></i>Pause all</button>` : ''}
                        ${finished ? `<button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmClearFinished()"><i class="fas fa-broom"></i>Clear finished</button>` : ''}
                    </span>
                </div>
                <div class="tm-list">${list.map(tmCountdownCardHtml).join('')}</div>
            </div>`;
        }

        function tmStopwatchCardHtml(t) {
            const now = Date.now();
            const id = jsAttr(t.id);
            let actions;
            if (t.status === 'running') {
                actions = tmBtn('tm-btn-accent', 'fa-flag', 'Lap', `tmAct(${id}, 'lap')`) + tmBtn('', 'fa-pause', 'Pause', `tmAct(${id}, 'pause')`);
            } else if (t.status === 'paused') {
                actions = tmBtn('tm-btn-primary', 'fa-play', 'Resume', `tmAct(${id}, 'resume')`) + tmBtn('tm-btn-danger', 'fa-rotate-left', 'Reset', `tmAct(${id}, 'reset')`);
            } else {
                actions = tmBtn('tm-btn-primary', 'fa-play', 'Start', `tmAct(${id}, 'start')`);
            }
            const rows = TmE.lapRows(t.laps).reverse();
            const copy = t.laps.length ? `<button type="button" class="tm-icon no-drag" title="Copy laps" onclick="tmCopyLaps(${id})"><i class="fas fa-copy"></i></button>` : '';
            const laps = (t.laps.length || t.status === 'running') && t.status !== 'idle' ? `<div class="tm-laps">
                    <div class="tm-lap head"><span>Lap</span><span>Lap time</span><span>Total</span></div>
                    ${t.status !== 'idle' ? `<div class="tm-lap current"><span>${t.laps.length + 1}</span><span id="tm-curlap-${t.id}">${TmE.formatClock(TmE.elapsed(t, now) - (t.laps.length ? t.laps[t.laps.length - 1] : 0), 1)}</span><span>—</span></div>` : ''}
                    ${rows.map(r => `<div class="tm-lap ${r.best ? 'best' : ''} ${r.worst ? 'worst' : ''}"><span>${r.n}</span><span>${TmE.formatClock(r.lap, 2)}</span><span>${TmE.formatClock(r.total, 2)}</span></div>`).join('')}
                </div>` : '';
            return `<div class="tm-card is-${t.status}" style="--c:${t.color}">
                ${tmCardTopHtml(t, copy)}
                <div class="tm-card-mid"><div class="tm-clock" id="tm-clock-${t.id}">${tmClockInner(t, now)}</div><div class="tm-info" id="tm-info-${t.id}">${esc(tmInfoText(t, now))}</div></div>
                <div class="tm-progress"><i id="tm-prog-${t.id}" style="width:${(tmBarFraction(t, now) * 100).toFixed(2)}%"></i></div>
                <div class="tm-actions" style="margin-bottom:${laps ? '10px' : '0'}">${actions}</div>
                ${laps}
            </div>`;
        }

        function tmStopwatchHtml() {
            const list = tmTimers('stopwatch');
            if (!list.length) {
                return `<div class="tm-empty"><i class="fas fa-stopwatch"></i>Time anything to the tenth of a second, with laps —<br>fastest and slowest highlighted. Pop it out to keep it on screen.
                    <div style="margin-top:12px"><button type="button" class="tm-btn tm-btn-primary no-drag" onclick="tmNewStopwatch(true)"><i class="fas fa-play"></i>Start a stopwatch</button></div></div>`;
            }
            const room = tmState.timers.length < TmE.MAX_TIMERS;
            return `<div class="tm-list">${list.map(tmStopwatchCardHtml).join('')}
                ${room ? `<button type="button" class="tm-btn tm-btn-block no-drag" onclick="tmNewStopwatch(false)"><i class="fas fa-plus"></i>Another stopwatch</button>` : ''}
            </div>`;
        }

        function tmFocusHtml() {
            const S = tmState.settings;
            const t = tmTimers('pomodoro')[0] || null;
            const now = Date.now();
            const phase = t ? t.phase : 'focus';
            const status = t ? t.status : 'idle';
            const pseudo = t || { kind: 'pomodoro', phase: 'focus', cycle: 0, status: 'idle', durationMs: TmE.phaseMs(S, 'focus'), remainingMs: TmE.phaseMs(S, 'focus'), laps: [] };
            const dots = TmE.cycleDots(pseudo, S);
            const pips = Array.from({ length: dots.total }, (_, i) => `<b class="${i < dots.filled ? 'on' : ''}"></b>`).join('');
            const phaseName = TmE.PHASE_LABELS[phase];
            const idAttr = t ? t.id : 'none';
            let actions;
            if (status === 'running') {
                actions = tmBtn('', 'fa-pause', 'Pause', `tmFocusAction('pause')`) + tmBtn('', 'fa-forward-step', 'Skip', `tmFocusAction('skip')`, 'Skip to the next phase');
            } else if (status === 'paused') {
                actions = tmBtn('tm-btn-primary', 'fa-play', 'Resume', `tmFocusAction('resume')`)
                    + tmBtn('', 'fa-forward-step', 'Skip', `tmFocusAction('skip')`)
                    + tmBtn('tm-btn-danger', 'fa-rotate-left', 'Reset', `tmFocusAction('reset')`);
            } else {
                actions = tmBtn(status === 'done' ? 'tm-btn-accent' : 'tm-btn-primary', 'fa-play', `Start ${phaseName.toLowerCase()}`, `tmFocusAction('start')`)
                    + tmBtn('', 'fa-forward-step', 'Skip', `tmFocusAction('skip')`, 'Skip to the next phase');
            }
            const floating = t && tmIsFloating(t.id);
            const today = tmState.summary ? tmState.summary.today : { pomodoros: 0, focusMs: 0 };
            const sub = status === 'done'
                ? (phase === 'focus' ? 'Break’s over — ready when you are' : 'Session done — take your break')
                : status === 'running' ? `Ends ${tmClockTime(t.endAt)}` : status === 'paused' ? 'Paused' : `${dots.total - dots.filled} to a long break`;
            return `<div class="tm-focus phase-${phase} is-${status}">
                <div class="tm-ring">
                    <svg viewBox="0 0 200 200" aria-hidden="true">
                        <circle class="track" cx="100" cy="100" r="${TM_FOCUS_RADIUS}"></circle>
                        <circle class="arc" id="tm-arc-${idAttr}" cx="100" cy="100" r="${TM_FOCUS_RADIUS}" style="stroke-dasharray:${TM_FOCUS_CIRC}; stroke-dashoffset:${tmRingOffset(t, now)}"></circle>
                    </svg>
                    <div class="tm-ring-face">
                        <span class="tm-phase"><i class="fas ${TM_PHASE_ICONS[phase]}"></i>${phaseName}</span>
                        <div class="tm-clock" id="tm-clock-${idAttr}">${tmClockInner(pseudo, now)}</div>
                        <div class="tm-pips" title="Sessions in this set">${pips}</div>
                    </div>
                </div>
                <div class="tm-muted" id="tm-info-none">${esc(sub)}</div>
                <div class="tm-actions">${actions}</div>
                <div style="display:flex; gap:6px; width:100%">
                    <button type="button" class="tm-btn tm-btn-sm no-drag ${floating ? 'tm-btn-accent' : ''}" style="flex:1" onclick="tmFocusAction('float')"><i class="fas fa-up-right-from-square"></i>${floating ? 'Close floating' : 'Pop out'}</button>
                    <button type="button" class="tm-btn tm-btn-sm no-drag" style="flex:1" onclick="tmFocusAction('resetCycle')" ${t ? '' : 'disabled'}><i class="fas fa-arrows-rotate"></i>New set</button>
                </div>
                <div class="tm-hint">Today: <b style="color:#e5e5e5">${today.pomodoros}</b> session${today.pomodoros === 1 ? '' : 's'} · <b style="color:#e5e5e5">${tmMinutesText(today.focusMs)}</b> focused</div>
            </div>`;
        }

        function tmStepperHtml(label, key, value, unit, step) {
            return `<div class="tm-stepper-row"><span>${label}</span><div class="tm-stepper">
                <button type="button" class="no-drag" title="Less" onclick="tmFocusStep(${jsAttr(key)}, ${-step})">−</button>
                <b>${value}${unit}</b>
                <button type="button" class="no-drag" title="More" onclick="tmFocusStep(${jsAttr(key)}, ${step})">+</button>
            </div></div>`;
        }

        function tmFocusSettingsHtml() {
            const P = tmState.settings.pomodoro;
            return `<div style="margin-top:14px; display:flex; flex-direction:column; gap:10px">
                <div class="tm-section-title">Session lengths <small>Takes effect on the next phase</small></div>
                <div class="tm-grid-2">
                    ${tmStepperHtml('Focus', 'focusMin', P.focusMin, 'm', 5)}
                    ${tmStepperHtml('Short break', 'shortMin', P.shortMin, 'm', 1)}
                    ${tmStepperHtml('Long break', 'longMin', P.longMin, 'm', 5)}
                    ${tmStepperHtml('Long break every', 'longEvery', P.longEvery, '', 1)}
                </div>
                ${tmToggleHtml('Start breaks automatically', 'When a focus session ends', P.autoBreaks, "tmFocusToggle('autoBreaks', this.checked)")}
                ${tmToggleHtml('Start focus automatically', 'When a break ends', P.autoFocus, "tmFocusToggle('autoFocus', this.checked)")}
            </div>`;
        }

        function tmWhen(ts) {
            const d = new Date(ts);
            const now = new Date();
            const time = tmClockTime(ts);
            if (d.toDateString() === now.toDateString()) return time;
            const y = new Date(now);
            y.setDate(now.getDate() - 1);
            if (d.toDateString() === y.toDateString()) return 'Yesterday ' + time;
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
        }

        function tmStatsHtml() {
            const s = tmState.summary || { today: { focusMs: 0, pomodoros: 0, completed: 0 }, week: [], streak: 0, totalFocusMs: 0, totalPomodoros: 0, totalCompleted: 0 };
            const useFocus = s.week.some(d => d.focusMs > 0);
            const value = (d) => (useFocus ? d.focusMs : d.completed);
            const max = Math.max(1, ...s.week.map(value));
            const todayKey = s.week.length ? s.week[s.week.length - 1].key : '';
            const bars = s.week.map(d => {
                const v = value(d);
                const pct = v ? Math.max(6, Math.round((v / max) * 100)) : 4;
                const title = useFocus ? `${tmMinutesText(d.focusMs)} focused · ${d.pomodoros} sessions` : `${d.completed} timer${d.completed === 1 ? '' : 's'} finished`;
                return `<div class="tm-bar-col ${d.key === todayKey ? 'today' : ''}" title="${esc(title)}"><div class="tm-bar-fill ${v ? '' : 'empty'}" style="height:${pct}%"></div><small>${TM_WEEKDAYS[d.weekday]}</small></div>`;
            }).join('');
            const history = tmState.history.length
                ? tmState.history.map(h => `<div class="tm-history-row" style="--c:${h.color}">
                        <span class="tm-dot"></span>
                        <span class="grow">${esc(h.phase ? TmE.PHASE_LABELS[h.phase] : h.label)}</span>
                        ${h.missed ? '<span class="tm-pill" title="Finished while main was closed or asleep">missed</span>' : ''}
                        <span class="when">${esc(TmE.formatShort(h.ms))}</span>
                        <span class="when">${esc(tmWhen(h.at))}</span>
                    </div>`).join('')
                : '<div class="tm-muted" style="padding:10px 2px">Finished timers and focus sessions show up here.</div>';
            return `<div style="display:flex; flex-direction:column; gap:12px">
                <div class="tm-stats">
                    <div class="tm-stat"><b>${tmMinutesText(s.today.focusMs)}</b><span>Focused today</span></div>
                    <div class="tm-stat"><b>${s.today.pomodoros}</b><span>Sessions today</span></div>
                    <div class="tm-stat"><b>${s.today.completed}</b><span>Timers finished</span></div>
                    <div class="tm-stat"><b>${s.streak}<small style="font-size:11px; color:#737373"> day${s.streak === 1 ? '' : 's'}</small></b><span>Streak</span></div>
                    <div class="tm-stat"><b>${tmMinutesText(s.totalFocusMs)}</b><span>Total focus</span></div>
                    <div class="tm-stat"><b>${s.totalPomodoros}</b><span>All sessions</span></div>
                </div>
                <div>
                    <div class="tm-section-title">Last 7 days <small>${useFocus ? 'Focus time' : 'Timers finished'}</small></div>
                    <div class="tm-bars">${bars}</div>
                </div>
                <div>
                    <div class="tm-section-title">History
                        ${tmState.history.length ? `<button type="button" class="tm-btn tm-btn-sm tm-btn-danger no-drag" onclick="tmClearHistory()"><i class="fas fa-trash-can"></i>${tmClearArmed ? 'Click again to clear' : 'Clear'}</button>` : ''}
                    </div>
                    <div class="tm-history">${history}</div>
                </div>
            </div>`;
        }

        function tmSegmentHtml(options, current, call) {
            return `<div class="tm-chips">${options.map(o => `<button type="button" class="tm-chip no-drag ${o.v === current ? 'on' : ''}" onclick="${call}(${jsAttr(o.v)})">${o.l}</button>`).join('')}</div>`;
        }

        function tmSetFloatStyle(v) { return tmSetSetting('floatStyle', v); }
        function tmSetFloatSize(v) { return tmSetSetting('floatSize', v); }

        function tmHotkeyRowHtml(label, key) {
            const accel = tmState.settings[key];
            const listening = tmBinding === key;
            return `<div class="tm-row">
                <span style="font-size:12px; color:#e5e5e5">${label}</span>
                <span style="display:flex; gap:6px; align-items:center">
                    <button type="button" class="tm-kbd no-drag ${listening ? 'listening' : ''}" onclick="tmBindHotkey(${jsAttr(key)})" title="Click, then press a shortcut">${listening ? 'Press keys…' : esc(tmHotkeyText(accel))}</button>
                    ${accel && !listening ? `<button type="button" class="tm-icon tm-icon-danger no-drag" title="Clear" onclick="tmSetSetting(${jsAttr(key)}, '')"><i class="fas fa-xmark"></i></button>` : ''}
                </span>
            </div>`;
        }

        function tmSettingsHtml() {
            const S = tmState.settings;
            const openCount = (tmState.openFloats || []).length;
            return `<div class="tm-settings">
                <div>
                    <div class="tm-section-title">Alarm</div>
                    <div style="display:flex; flex-direction:column; gap:10px">
                        <div class="tm-row">
                            <select class="tm-input no-drag" style="flex:1" onchange="tmSetSetting('sound', this.value)">
                                ${TmE.SOUNDS.map(o => `<option value="${o.id}" ${S.sound === o.id ? 'selected' : ''}>${o.label}</option>`).join('')}
                            </select>
                            <button type="button" class="tm-btn no-drag" onclick="tmTestSound()"><i class="fas fa-volume-high"></i>Test</button>
                        </div>
                        <div class="tm-slider-row">
                            <span>Volume</span>
                            <input type="range" min="0" max="100" value="${S.volume}" class="ve-vol-slider flex-1 no-drag"
                                oninput="document.getElementById('tm-vol-val').textContent = this.value + '%'" onchange="tmSetSetting('volume', Number(this.value))">
                            <span class="ve-vol-val" id="tm-vol-val">${S.volume}%</span>
                        </div>
                        ${tmToggleHtml('Keep ringing until dismissed', 'For up to a minute — or until you stop it anywhere', S.ringUntilDismissed, "tmSetSetting('ringUntilDismissed', this.checked)")}
                        ${tmToggleHtml('Desktop notifications', 'With +1 min, Restart and Dismiss buttons — works from the tray', S.notify, "tmSetSetting('notify', this.checked)")}
                        <div class="tm-row">
                            <span style="font-size:12px; color:#e5e5e5">Heads-up before the end</span>
                            <select class="tm-input tm-btn-sm no-drag" onchange="tmSetSetting('warnSeconds', Number(this.value))">
                                ${TmE.WARN_OPTIONS.map(v => `<option value="${v}" ${S.warnSeconds === v ? 'selected' : ''}>${v === 0 ? 'Off' : TmE.formatHuman(v * 1000)}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                </div>

                <div>
                    <div class="tm-section-title">Floating timers
                        ${openCount ? `<button type="button" class="tm-btn tm-btn-sm no-drag" onclick="tmCall('timerFloatCloseAll')"><i class="fas fa-xmark"></i>Close all (${openCount})</button>` : ''}
                    </div>
                    <div style="display:flex; flex-direction:column; gap:10px">
                        ${tmToggleHtml('Pop out automatically when a timer starts', 'Every timer you start opens on your desktop', S.autoFloat, "tmSetSetting('autoFloat', this.checked)")}
                        <div class="tm-row"><span class="tm-muted">Look</span>${tmSegmentHtml([{ v: 'ring', l: 'Ring' }, { v: 'pill', l: 'Pill' }, { v: 'text', l: 'Text only' }], S.floatStyle, 'tmSetFloatStyle')}</div>
                        <div class="tm-row"><span class="tm-muted">Size</span>${tmSegmentHtml([{ v: 's', l: 'Small' }, { v: 'm', l: 'Medium' }, { v: 'l', l: 'Large' }], S.floatSize, 'tmSetFloatSize')}</div>
                        <div class="tm-slider-row">
                            <span>Opacity</span>
                            <input type="range" min="30" max="100" step="5" value="${S.floatOpacity}" class="ve-vol-slider flex-1 no-drag"
                                oninput="document.getElementById('tm-op-val').textContent = this.value + '%'" onchange="tmSetSetting('floatOpacity', Number(this.value))">
                            <span class="ve-vol-val" id="tm-op-val">${S.floatOpacity}%</span>
                        </div>
                        <p class="tm-hint">The look applies to timers you pop out from now on. Drag a floating timer anywhere — onto any monitor — and it reopens there next time. Right-click it for size, opacity, snap-to-corner, move to another display, and <b>click-through</b> mode so it never gets in the way of a game.</p>
                    </div>
                </div>

                <div>
                    <div class="tm-section-title">Global hotkeys <small>Work everywhere, even in games</small></div>
                    <div style="display:flex; flex-direction:column; gap:8px">
                        ${tmHotkeyRowHtml('Start / pause the current timer', 'hotkeyToggle')}
                        ${tmHotkeyRowHtml('Pop out / hide the current timer', 'hotkeyFloat')}
                        <p class="tm-hint">“Current” is the timer that's ringing, otherwise the one ending soonest.</p>
                    </div>
                </div>
            </div>`;
        }

        // ── Lifecycle ─────────────────────────────────────────────────────────

        // The pre-2.0 widget kept one countdown in localStorage. Hand it to main
        // once, then drop the old key.
        async function tmMigrateLegacy() {
            if (tmLegacyChecked) return;
            tmLegacyChecked = true;
            let raw = null;
            try { raw = localStorage.getItem('timerState'); } catch (e) { return; }
            if (!raw) return;
            const legacy = safeParseJSON(raw, null);
            if (legacy && ['running', 'paused', 'done'].includes(legacy.status) && Number(legacy.durationMs) >= 1000) {
                await tmCall('timerImportLegacy', legacy);
            }
            try { localStorage.removeItem('timerState'); } catch (e) { /* non-fatal */ }
        }

        async function applyTimerEnabled(enabled) {
            tmSubscribe();
            if (!enabled) {
                tmStopRing();
                if (tmBinding) await tmEndBind();
            }
            const s = await tmCall('timerSetEnabled', !!enabled);
            if (s && Array.isArray(s.timers)) tmSetState(s);
            if (enabled) await tmMigrateLegacy();
            updateTimerIndicator();
        }

        function initTimerWidget() {
            tmSubscribe();
            tmRefresh();
        }
