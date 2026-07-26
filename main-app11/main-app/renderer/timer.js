        // ── Countdown Timer mini widget ──
        // Renderer-only. State lives in localStorage ('timerState') so a running
        // countdown survives the Widget Library panel being closed/reopened and is
        // resumed on app start. A single 1 Hz tick (started by initTimerWidget)
        // drives both the library panel (#timer-panel, when open) and a live
        // readout pinned in the header (#timer-indicator) — "synced into the main
        // UI" so you can watch it from anywhere in the app. When it hits zero it
        // fires a toast + a short beep.

        const TIMER_PRESETS = [
            { label: '1m', ms: 1 * 60 * 1000 },
            { label: '5m', ms: 5 * 60 * 1000 },
            { label: '10m', ms: 10 * 60 * 1000 },
            { label: '15m', ms: 15 * 60 * 1000 },
            { label: '25m', ms: 25 * 60 * 1000 },
            { label: '60m', ms: 60 * 60 * 1000 }
        ];
        const TIMER_DEFAULT_STATE = { status: 'idle', durationMs: 0, remainingMs: 0, endTime: null };

        let timerTickHandle = null;

        function isTimerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.timer;
        }

        function getTimerState() {
            const s = safeParseJSON(localStorage.getItem('timerState'), TIMER_DEFAULT_STATE);
            // Guard against partial/corrupt values.
            if (!s || typeof s !== 'object' || !['idle', 'running', 'paused', 'done'].includes(s.status)) {
                return { ...TIMER_DEFAULT_STATE };
            }
            return {
                status: s.status,
                durationMs: Number(s.durationMs) || 0,
                remainingMs: Number(s.remainingMs) || 0,
                endTime: s.endTime == null ? null : Number(s.endTime)
            };
        }

        function setTimerState(s) {
            localStorage.setItem('timerState', JSON.stringify(s));
        }

        // Live remaining time (ms). While running it's derived from the wall-clock
        // end time so it stays accurate even if a tick is missed.
        function timerRemaining(state) {
            const s = state || getTimerState();
            if (s.status === 'running' && s.endTime != null) {
                return Math.max(0, s.endTime - Date.now());
            }
            return Math.max(0, s.remainingMs || 0);
        }

        function formatTimerClock(ms) {
            const total = Math.max(0, Math.ceil(ms / 1000));
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const sec = total % 60;
            const pad = (n) => String(n).padStart(2, '0');
            return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
        }

        // ── Controls ──────────────────────────────────────────────────────────

        function timerStart(durationMs) {
            const ms = Math.max(1000, Math.round(durationMs));
            setTimerState({ status: 'running', durationMs: ms, remainingMs: ms, endTime: Date.now() + ms });
            ensureTimerTick();
            renderTimerPanel();
            updateTimerIndicator();
        }

        function timerStartPreset(ms) {
            timerStart(ms);
        }

        function timerStartCustom() {
            const minEl = document.getElementById('timer-custom-min');
            const secEl = document.getElementById('timer-custom-sec');
            const mins = Math.max(0, Math.floor(Number(minEl && minEl.value) || 0));
            const secs = Math.max(0, Math.floor(Number(secEl && secEl.value) || 0));
            const totalMs = (mins * 60 + secs) * 1000;
            if (totalMs < 1000) {
                showToast('Set at least 1 second', true);
                return;
            }
            timerStart(totalMs);
        }

        function timerPause() {
            const s = getTimerState();
            if (s.status !== 'running') return;
            const remaining = timerRemaining(s);
            setTimerState({ status: 'paused', durationMs: s.durationMs, remainingMs: remaining, endTime: null });
            renderTimerPanel();
            updateTimerIndicator();
        }

        function timerResume() {
            const s = getTimerState();
            if (s.status !== 'paused') return;
            const remaining = Math.max(0, s.remainingMs);
            if (remaining <= 0) { timerReset(); return; }
            setTimerState({ status: 'running', durationMs: s.durationMs, remainingMs: remaining, endTime: Date.now() + remaining });
            ensureTimerTick();
            renderTimerPanel();
            updateTimerIndicator();
        }

        function timerReset() {
            setTimerState({ ...TIMER_DEFAULT_STATE });
            renderTimerPanel();
            updateTimerIndicator();
        }

        // Restarts the just-finished (or any) timer with the same duration.
        function timerRestart() {
            const s = getTimerState();
            if (s.durationMs > 0) timerStart(s.durationMs);
        }

        // ── Tick / completion ─────────────────────────────────────────────────

        function ensureTimerTick() {
            if (timerTickHandle) return;
            timerTickHandle = setInterval(timerTick, 250);
        }

        function timerTick() {
            const s = getTimerState();
            if (s.status !== 'running') {
                // Nothing counting down — stop the interval to stay idle-cheap.
                if (timerTickHandle) { clearInterval(timerTickHandle); timerTickHandle = null; }
                return;
            }
            if (timerRemaining(s) <= 0) {
                timerComplete();
                return;
            }
            updateTimerIndicator();
            // Only repaint the panel's clock when it's actually on screen.
            const clock = document.getElementById('timer-clock');
            if (clock) clock.textContent = formatTimerClock(timerRemaining(s));
        }

        function timerComplete() {
            const s = getTimerState();
            setTimerState({ status: 'done', durationMs: s.durationMs, remainingMs: 0, endTime: null });
            if (timerTickHandle) { clearInterval(timerTickHandle); timerTickHandle = null; }
            renderTimerPanel();
            updateTimerIndicator();
            timerBeep();
            if (typeof showToast === 'function') showToast('⏰ Timer finished');
        }

        function timerBeep() {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const blip = (at, freq) => {
                    const o = ctx.createOscillator();
                    const g = ctx.createGain();
                    o.type = 'sine';
                    o.frequency.value = freq;
                    o.connect(g); g.connect(ctx.destination);
                    const t = ctx.currentTime + at;
                    g.gain.setValueAtTime(0.0001, t);
                    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
                    o.start(t);
                    o.stop(t + 0.36);
                };
                blip(0, 880); blip(0.4, 880); blip(0.8, 1174);
                setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1600);
            } catch (e) {
                // Audio is a nicety — never let it break the timer.
            }
        }

        // ── Header indicator (main-UI sync) ────────────────────────────────────

        function updateTimerIndicator() {
            const el = document.getElementById('timer-indicator');
            if (!el) return;
            const s = getTimerState();
            const active = isTimerEnabled() && s.status !== 'idle';
            if (!active) {
                el.classList.add('hidden');
                el.classList.remove('timer-indicator-done');
                return;
            }
            el.classList.remove('hidden');
            const done = s.status === 'done';
            el.classList.toggle('timer-indicator-done', done);
            const paused = s.status === 'paused';
            const iconCls = done ? 'fa-bell' : (paused ? 'fa-pause' : 'fa-hourglass-half');
            const text = done ? 'Done' : formatTimerClock(timerRemaining(s));
            el.innerHTML = `<i class="fas ${iconCls} text-[10px]"></i><span class="tabular-nums">${esc(text)}</span>`;
            el.title = done ? 'Timer finished — click to reset' : 'Countdown timer — click to open';
        }

        // Clicking the header readout opens the widget in the library.
        function openTimerFromIndicator() {
            if (typeof openWidgetLibrary === 'function') openWidgetLibrary('timer');
        }

        // ── Panel ──────────────────────────────────────────────────────────────

        function renderTimerPanel() {
            const panel = document.getElementById('timer-panel');
            if (!panel) return;
            if (!isTimerEnabled()) { panel.innerHTML = ''; return; }

            const s = getTimerState();
            const remaining = timerRemaining(s);
            const running = s.status === 'running';
            const paused = s.status === 'paused';
            const done = s.status === 'done';
            const idle = s.status === 'idle';

            const clockDisplay = done ? '00:00' : formatTimerClock(idle ? 0 : remaining);

            const presetBtns = TIMER_PRESETS.map(p => `
                <button type="button" onclick="timerStartPreset(${p.ms})"
                    class="px-2.5 py-1.5 rounded-lg text-[11px] border bg-neutral-800/30 border-neutral-700/50 text-neutral-300 hover:text-white hover:border-neutral-600 transition-colors no-drag">${p.label}</button>
            `).join('');

            let controls;
            if (running) {
                controls = `
                    <button type="button" onclick="timerPause()" class="timer-btn no-drag"><i class="fas fa-pause mr-1.5"></i>Pause</button>
                    <button type="button" onclick="timerReset()" class="timer-btn timer-btn-ghost no-drag"><i class="fas fa-stop mr-1.5"></i>Reset</button>`;
            } else if (paused) {
                controls = `
                    <button type="button" onclick="timerResume()" class="timer-btn timer-btn-primary no-drag"><i class="fas fa-play mr-1.5"></i>Resume</button>
                    <button type="button" onclick="timerReset()" class="timer-btn timer-btn-ghost no-drag"><i class="fas fa-stop mr-1.5"></i>Reset</button>`;
            } else if (done) {
                controls = `
                    <button type="button" onclick="timerRestart()" class="timer-btn timer-btn-primary no-drag"><i class="fas fa-rotate-right mr-1.5"></i>Restart</button>
                    <button type="button" onclick="timerReset()" class="timer-btn timer-btn-ghost no-drag"><i class="fas fa-check mr-1.5"></i>Dismiss</button>`;
            } else {
                controls = ''; // idle — start via presets / custom below
            }

            panel.innerHTML = `<div class="mt-3 space-y-4">
                <div class="rounded-xl border border-white/10 bg-neutral-800/20 py-6 text-center ${done ? 'timer-face-done' : ''}">
                    <p id="timer-clock" class="text-4xl font-semibold text-white tabular-nums leading-none">${clockDisplay}</p>
                    <p class="text-[11px] text-neutral-500 mt-2">${done ? "Time's up" : (running ? 'Counting down' : (paused ? 'Paused' : 'Pick a preset or set a custom time'))}</p>
                </div>

                ${controls ? `<div class="flex items-center gap-2">${controls}</div>` : ''}

                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Presets</p>
                    <div class="flex flex-wrap gap-1.5">${presetBtns}</div>
                </div>

                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Custom</p>
                    <div class="flex items-center gap-2">
                        <input type="number" id="timer-custom-min" min="0" max="999" placeholder="0" value=""
                            class="w-16 bg-neutral-900 border border-neutral-800 rounded-xl px-2.5 py-2 text-xs text-center focus:outline-none focus:border-neutral-600 no-drag">
                        <span class="text-[11px] text-neutral-500">min</span>
                        <input type="number" id="timer-custom-sec" min="0" max="59" placeholder="0" value=""
                            class="w-16 bg-neutral-900 border border-neutral-800 rounded-xl px-2.5 py-2 text-xs text-center focus:outline-none focus:border-neutral-600 no-drag">
                        <span class="text-[11px] text-neutral-500">sec</span>
                        <button type="button" onclick="timerStartCustom()"
                            class="ml-auto px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs transition-colors no-drag"><i class="fas fa-play mr-1.5"></i>Start</button>
                    </div>
                </div>
            </div>`;
        }

        // Resumes a persisted countdown on app start and wires the header readout.
        function initTimerWidget() {
            const s = getTimerState();
            // A timer that expired while the app was closed should read as done.
            if (s.status === 'running' && timerRemaining(s) <= 0) {
                setTimerState({ status: 'done', durationMs: s.durationMs, remainingMs: 0, endTime: null });
            } else if (s.status === 'running') {
                ensureTimerTick();
            }
            updateTimerIndicator();
        }
