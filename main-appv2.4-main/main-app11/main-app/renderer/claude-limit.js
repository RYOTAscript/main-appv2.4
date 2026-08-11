        // ── Claude Limit Auto-Continue mini widget ──
        // Detects when a Claude usage limit resets and continues the conversation for
        // you: at reset time it focuses the chat window you picked and pastes + Enters
        // your prompt. The window enumeration / focus / paste all happen in the main
        // process (main/claudeLimit.js); this file is the panel UI + the reset-time
        // parser + the countdown scheduler.
        //
        // The scheduler runs whether or not the panel is open (it's the whole point),
        // so it's kicked off at script load from persisted state — the panel just
        // configures and visualises it.

        const CL_DEFAULT_PROMPT = 'My usage limit should have reset now — please continue exactly where we left off.';

        function clDefaults() {
            return { targetProcess: '', targetTitle: '', prompt: CL_DEFAULT_PROMPT, pressEnter: true, bufferSec: 20, autoWatch: false, autoArm: false };
        }

        function clGetConfig() {
            return { ...clDefaults(), ...safeParseJSON(localStorage.getItem('claudeLimitConfig'), {}) };
        }
        function clSaveConfig(cfg) {
            localStorage.setItem('claudeLimitConfig', JSON.stringify(cfg));
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
        }
        function clGetArm() {
            const a = safeParseJSON(localStorage.getItem('claudeLimitArm'), null);
            return (a && typeof a.at === 'number') ? a : null;
        }
        function clSetArm(a) {
            if (a) localStorage.setItem('claudeLimitArm', JSON.stringify(a));
            else localStorage.removeItem('claudeLimitArm');
        }

        let clWindows = [];            // last-listed windows
        let clPendingResetAt = null;   // parsed-but-not-yet-armed reset Date (ms)
        let clSchedTimer = null;
        let clFiring = false;
        let clWatchHooked = false;

        function isClaudeLimitEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.claudeLimit;
        }

        // ── Reset-time parsing ──────────────────────────────────────────────────
        // Turns a copied limit message (or a manual phrase) into an absolute time.
        function clDurationToMs(str) {
            let ms = 0;
            const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
            let m;
            while ((m = re.exec(str)) !== null) {
                const n = parseFloat(m[1]);
                const u = m[2][0]; // h / m / s
                if (u === 'h') ms += n * 3600000;
                else if (u === 'm') ms += n * 60000;
                else ms += n * 1000;
            }
            return ms;
        }

        function clNextClock(hour, minute, ampm) {
            const now = new Date();
            let h = hour;
            if (ampm === 'pm' && h < 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;
            const d = new Date(now);
            d.setHours(h, minute || 0, 0, 0);
            if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // next occurrence
            return d;
        }

        // Returns a Date (ms) or null.
        function clParseResetTime(text) {
            if (!text) return null;
            const t = String(text).toLowerCase().replace(/\s+/g, ' ');
            const now = Date.now();

            // 1. Relative: "resets in 2 hours 30 minutes", "in 45 minutes", "in 3h"
            const rel = t.match(/\bin\s+((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/);
            if (rel) {
                const ms = clDurationToMs(rel[1]);
                if (ms > 0) return new Date(now + ms);
            }

            // 2. Rolling "N-hour limit" window → reset ~N hours from now.
            const nhour = t.match(/(\d+)\s*-\s*hour\s+limit/);
            if (nhour) return new Date(now + parseInt(nhour[1], 10) * 3600000);

            // 3. Explicit clock time, ideally near a reset/again cue:
            //    "resets at 3:00 pm", "available again at 15:30", "back at 9am"
            const cued = t.match(/(?:reset[s]?|again|at|until|back)\b[^0-9]{0,16}(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
            if (cued) {
                const h = parseInt(cued[1], 10);
                const min = cued[2] ? parseInt(cued[2], 10) : 0;
                const ap = cued[3] ? (cued[3][0] === 'a' ? 'am' : 'pm') : null;
                if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return clNextClock(h, min, ap);
            }

            // 4. A bare clock time anywhere: "3:47 am" / "15:30"
            const bare = t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/);
            if (bare) {
                const h = parseInt(bare[1], 10);
                const min = parseInt(bare[2], 10);
                const ap = bare[3] ? (bare[3][0] === 'a' ? 'am' : 'pm') : null;
                if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return clNextClock(h, min, ap);
            }

            // 5. Last resort — let the engine try a full date/time it recognises.
            const cleaned = text.replace(/.*reset[s]?\s*(on|at)?\s*/i, '').trim();
            const parsed = Date.parse(cleaned);
            if (!isNaN(parsed) && parsed > now) return new Date(parsed);

            return null;
        }

        function clFmtClock(ms) {
            const d = new Date(ms);
            const sameDay = new Date().toDateString() === d.toDateString();
            const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
            return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
        }
        function clFmtRemaining(ms) {
            if (ms < 0) ms = 0;
            const s = Math.floor(ms / 1000);
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
            if (h > 0) return `${h}h ${m}m ${sec}s`;
            if (m > 0) return `${m}m ${sec}s`;
            return `${sec}s`;
        }

        // ── Scheduler (runs regardless of panel visibility) ─────────────────────
        function clStartScheduler() {
            if (clSchedTimer) return;
            clSchedTimer = setInterval(clTick, 1000);
            clTick();
        }
        function clStopScheduler() {
            if (clSchedTimer) { clearInterval(clSchedTimer); clSchedTimer = null; }
        }
        function clTick() {
            const arm = clGetArm();
            if (!arm) { clStopScheduler(); clPaintStatus(); return; }
            const remaining = arm.at - Date.now();
            if (remaining <= 0) { clFire(); return; }
            clPaintCountdown(remaining, arm.at);
        }

        async function clResolveHwnd() {
            if (!window.electronAPI?.claudeLimitListWindows) return null;
            const res = await window.electronAPI.claudeLimitListWindows();
            const wins = res?.windows || [];
            clWindows = wins;
            const cfg = clGetConfig();
            const p = (cfg.targetProcess || '').toLowerCase();
            const ttl = cfg.targetTitle || '';
            const key = ttl.slice(0, 24);
            const pick =
                wins.find((w) => (w.process || '').toLowerCase() === p && w.title === ttl) ||
                wins.find((w) => (w.process || '').toLowerCase() === p && key && w.title.includes(key)) ||
                wins.find((w) => ttl && w.title === ttl) ||
                wins.find((w) => (w.process || '').toLowerCase() === p) ||
                wins.find((w) => key && w.title.includes(key));
            return pick ? pick.hwnd : null;
        }

        async function clFire() {
            if (clFiring) return;
            clFiring = true;
            const cfg = clGetConfig();
            try {
                const hwnd = await clResolveHwnd();
                if (!hwnd) {
                    showToast('Auto-continue: couldn\'t find the target window', true);
                } else {
                    const res = await window.electronAPI.claudeLimitSend(hwnd, cfg.prompt, cfg.pressEnter);
                    showToast(res?.ok ? 'Limit reset — continued the conversation' : 'Auto-continue: send failed', !res?.ok);
                }
            } catch (e) {
                showToast('Auto-continue failed', true);
            } finally {
                clSetArm(null);
                clStopScheduler();
                clFiring = false;
                clPaintStatus();
            }
        }

        function clArmAt(resetMs) {
            const cfg = clGetConfig();
            const fireAt = resetMs + Math.max(0, (cfg.bufferSec || 0) * 1000);
            clSetArm({ at: fireAt, resetAt: resetMs });
            clStartScheduler();
            clPaintStatus();
        }
        function clDisarm() {
            clSetArm(null);
            clStopScheduler();
            clPaintStatus();
            showToast('Auto-continue disarmed');
        }

        // ── Panel UI ────────────────────────────────────────────────────────────
        function renderClaudeLimitPanel() {
            const panel = document.getElementById('claude-limit-panel');
            if (!panel) return;
            if (!isClaudeLimitEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.claudeLimitSend) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Auto-continue is unavailable.</p>`;
                return;
            }

            if (!clWatchHooked && window.electronAPI.onClaudeLimitClipboardHit) {
                window.electronAPI.onClaudeLimitClipboardHit(clOnClipboardHit);
                clWatchHooked = true;
            }

            const cfg = clGetConfig();
            panel.innerHTML = `
                <div class="cl-root mt-3">
                    <div class="cl-section">
                        <p class="cl-label">1 · Where to continue</p>
                        <div class="flex items-center gap-1.5">
                            <select id="cl-target" class="cl-select no-drag" onchange="clSelectTarget(this)"></select>
                            <button type="button" class="cl-btn no-drag" onclick="clRefreshWindows()" title="Refresh window list"><i class="fas fa-rotate-right"></i></button>
                        </div>
                        <p class="cl-hint">Pick the exact Cursor / Nimbalyst / Claude window to continue in.</p>
                    </div>

                    <div class="cl-section">
                        <p class="cl-label">2 · Continue prompt</p>
                        <textarea id="cl-prompt" class="cl-textarea no-drag" rows="2" oninput="clOnPromptInput(this.value)" spellcheck="false">${esc(cfg.prompt)}</textarea>
                        <label class="cl-check mt-1.5"><input type="checkbox" id="cl-enter" ${cfg.pressEnter ? 'checked' : ''} onchange="clOnEnterToggle(this.checked)"><span>Press Enter to send it</span></label>
                    </div>

                    <div class="cl-section">
                        <p class="cl-label">3 · When does the limit reset?</p>
                        <textarea id="cl-msg" class="cl-textarea no-drag" rows="2" placeholder="Paste the limit message here (e.g. “resets at 3:00 PM” or “5-hour limit”)…" spellcheck="false"></textarea>
                        <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            <button type="button" class="cl-btn no-drag" onclick="clParseFromBox()"><i class="fas fa-wand-magic-sparkles mr-1"></i>Read reset time</button>
                            <button type="button" class="cl-btn no-drag" onclick="clDetectFromClipboard()"><i class="fas fa-clipboard mr-1"></i>From clipboard</button>
                            <label class="cl-check"><input type="checkbox" id="cl-watch" ${cfg.autoWatch ? 'checked' : ''} onchange="clOnWatchToggle(this.checked)"><span>Auto-watch clipboard</span></label>
                        </div>
                        <div class="flex items-center gap-1.5 mt-2 flex-wrap">
                            <span class="cl-hint">or set it:</span>
                            <input type="time" id="cl-time" class="cl-input no-drag" step="60">
                            <button type="button" class="cl-btn no-drag" onclick="clSetManualTime()">at time</button>
                            <input type="number" id="cl-mins" class="cl-input cl-input-num no-drag" min="1" max="1440" placeholder="min">
                            <button type="button" class="cl-btn no-drag" onclick="clSetManualMinutes()">in min</button>
                        </div>
                        <label class="cl-check mt-2"><input type="checkbox" id="cl-autoarm" ${cfg.autoArm ? 'checked' : ''} onchange="clOnAutoArmToggle(this.checked)"><span>Arm automatically when a limit is detected</span></label>
                    </div>

                    <div id="cl-status" class="cl-status">${clStatusHtml()}</div>
                </div>`;

            clRenderWindowOptions();
            clRefreshWindows(); // pull a fresh list on open
        }

        function clStatusHtml() {
            const arm = clGetArm();
            const cfg = clGetConfig();
            if (arm) {
                const remaining = arm.at - Date.now();
                return `<div class="cl-armed">
                        <div class="cl-armed-row">
                            <span class="cl-armed-dot"></span>
                            <div class="min-w-0 flex-1">
                                <p class="cl-armed-title">Continues in <span id="cl-count">${esc(clFmtRemaining(remaining))}</span></p>
                                <p class="cl-armed-sub">at ${esc(clFmtClock(arm.at))}${cfg.bufferSec ? ` · ${cfg.bufferSec}s after reset` : ''}</p>
                            </div>
                            <button type="button" class="cl-btn cl-btn-danger no-drag" onclick="clDisarm()">Disarm</button>
                        </div>
                        <button type="button" class="cl-btn no-drag mt-2" onclick="clContinueNow()"><i class="fas fa-paper-plane mr-1"></i>Continue now (test)</button>
                    </div>`;
            }
            const ready = clPendingResetAt && cfg.prompt && cfg.targetProcess;
            const resetLine = clPendingResetAt
                ? `<p class="cl-armed-sub mb-2">Detected reset: <b class="text-neutral-200">${esc(clFmtClock(clPendingResetAt))}</b> (${esc(clFmtRemaining(clPendingResetAt - Date.now()))})</p>`
                : `<p class="cl-hint mb-2">No reset time yet — read it from the message, clipboard, or set one.</p>`;
            return `<div class="cl-idle">
                    ${resetLine}
                    <div class="flex items-center gap-1.5">
                        <button type="button" class="cl-btn cl-btn-primary no-drag" ${ready ? '' : 'disabled'} onclick="clArmNow()"><i class="fas fa-clock mr-1"></i>Arm auto-continue</button>
                        <button type="button" class="cl-btn no-drag" onclick="clContinueNow()" title="Send the prompt right now to check it lands in the right place"><i class="fas fa-paper-plane mr-1"></i>Test now</button>
                    </div>
                    ${clPendingResetAt && !cfg.targetProcess ? '<p class="cl-hint mt-1.5 text-amber-400">Pick a target window above first.</p>' : ''}
                </div>`;
        }

        function clPaintStatus() {
            const el = document.getElementById('cl-status');
            if (el) el.innerHTML = clStatusHtml();
        }
        function clPaintCountdown(remaining, at) {
            const c = document.getElementById('cl-count');
            if (c) c.textContent = clFmtRemaining(remaining);
            else clPaintStatus(); // status block not showing the countdown yet — rebuild it
        }

        function clRenderWindowOptions() {
            const sel = document.getElementById('cl-target');
            if (!sel) return;
            const cfg = clGetConfig();
            const opts = ['<option value="">— choose a window —</option>'];
            let matched = false;
            clWindows.forEach((w, i) => {
                const isSel = (w.process || '').toLowerCase() === (cfg.targetProcess || '').toLowerCase() && w.title === cfg.targetTitle;
                if (isSel) matched = true;
                const label = `${w.process || 'app'} — ${w.title}`;
                opts.push(`<option value="${i}" ${isSel ? 'selected' : ''}>${esc(label.length > 70 ? label.slice(0, 69) + '…' : label)}</option>`);
            });
            // Keep a stale saved target visible even if its window isn't open right now.
            if (!matched && cfg.targetTitle) {
                opts.push(`<option value="saved" selected>${esc(`${cfg.targetProcess || 'app'} — ${cfg.targetTitle}`.slice(0, 69))} (not open)</option>`);
            }
            sel.innerHTML = opts.join('');
        }

        async function clRefreshWindows() {
            if (!window.electronAPI?.claudeLimitListWindows) return;
            const res = await window.electronAPI.claudeLimitListWindows();
            clWindows = res?.windows || [];
            clRenderWindowOptions();
        }

        function clSelectTarget(sel) {
            const v = sel.value;
            if (v === '' || v === 'saved') return;
            const w = clWindows[parseInt(v, 10)];
            if (!w) return;
            const cfg = clGetConfig();
            cfg.targetProcess = w.process || '';
            cfg.targetTitle = w.title || '';
            clSaveConfig(cfg);
            clPaintStatus();
        }

        function clOnPromptInput(v) { const cfg = clGetConfig(); cfg.prompt = v; clSaveConfig(cfg); }
        function clOnEnterToggle(v) { const cfg = clGetConfig(); cfg.pressEnter = !!v; clSaveConfig(cfg); }
        function clOnAutoArmToggle(v) { const cfg = clGetConfig(); cfg.autoArm = !!v; clSaveConfig(cfg); }

        function clOnWatchToggle(v) {
            const cfg = clGetConfig();
            cfg.autoWatch = !!v;
            clSaveConfig(cfg);
            if (window.electronAPI?.claudeLimitSetWatch) window.electronAPI.claudeLimitSetWatch(!!v);
            showToast(v ? 'Watching clipboard for limit messages' : 'Clipboard watch off');
        }

        function clSetPendingReset(ms, quiet) {
            if (!ms || ms <= Date.now()) { if (!quiet) showToast('Couldn\'t read a future reset time', true); return false; }
            clPendingResetAt = ms;
            clPaintStatus();
            if (!quiet) showToast(`Reset time: ${clFmtClock(ms)}`);
            return true;
        }

        function clParseFromBox() {
            const box = document.getElementById('cl-msg');
            const parsed = clParseResetTime(box ? box.value : '');
            clSetPendingReset(parsed ? parsed.getTime() : null);
        }

        async function clDetectFromClipboard() {
            if (!window.electronAPI?.claudeLimitReadClipboard) return;
            const res = await window.electronAPI.claudeLimitReadClipboard();
            const box = document.getElementById('cl-msg');
            if (box && res?.text) box.value = res.text.slice(0, 2000);
            const parsed = clParseResetTime(res?.text || '');
            clSetPendingReset(parsed ? parsed.getTime() : null);
        }

        function clSetManualTime() {
            const el = document.getElementById('cl-time');
            if (!el || !el.value) { showToast('Enter a time first', true); return; }
            const [h, m] = el.value.split(':').map((x) => parseInt(x, 10));
            if (isNaN(h) || isNaN(m)) { showToast('Invalid time', true); return; }
            clSetPendingReset(clNextClock(h, m, null).getTime());
        }
        function clSetManualMinutes() {
            const el = document.getElementById('cl-mins');
            const mins = parseInt(el ? el.value : '', 10);
            if (isNaN(mins) || mins <= 0) { showToast('Enter minutes first', true); return; }
            clSetPendingReset(Date.now() + mins * 60000);
        }

        function clArmNow() {
            const cfg = clGetConfig();
            if (!clPendingResetAt) { showToast('Set a reset time first', true); return; }
            if (!cfg.targetProcess) { showToast('Pick a target window first', true); return; }
            clArmAt(clPendingResetAt);
            showToast(`Armed — continues at ${clFmtClock(clGetArm().at)}`);
        }

        async function clContinueNow() {
            const cfg = clGetConfig();
            if (!cfg.targetProcess) { showToast('Pick a target window first', true); return; }
            showToast('Sending continue prompt…');
            const hwnd = await clResolveHwnd();
            if (!hwnd) { showToast('Target window isn\'t open', true); return; }
            const res = await window.electronAPI.claudeLimitSend(hwnd, cfg.prompt, cfg.pressEnter);
            showToast(res?.ok ? 'Sent' : 'Send failed', !res?.ok);
        }

        // Fired by the main-process clipboard watcher when a limit message is copied.
        function clOnClipboardHit(data) {
            if (!data?.text) return;
            const box = document.getElementById('cl-msg');
            if (box) box.value = data.text.slice(0, 2000);
            const parsed = clParseResetTime(data.text);
            if (!parsed) return;
            const cfg = clGetConfig();
            clSetPendingReset(parsed.getTime(), true);
            if (cfg.autoArm && cfg.targetProcess && cfg.prompt) {
                clArmAt(parsed.getTime());
                showToast(`Limit detected — armed, continues at ${clFmtClock(clGetArm().at)}`);
            } else {
                showToast(`Limit detected — resets ${clFmtClock(parsed.getTime())}`);
            }
        }

        // Called from applyMiniWidgetPrefs when the widget is toggled, and from boot.
        // Starts/stops the clipboard watch and resumes any armed schedule so firing
        // works even when the config panel isn't open.
        function applyClaudeLimitEnabled(enabled) {
            if (!enabled) {
                clStopScheduler();
                if (window.electronAPI?.claudeLimitSetWatch) window.electronAPI.claudeLimitSetWatch(false);
                return;
            }
            const cfg = clGetConfig();
            if (cfg.autoWatch && window.electronAPI?.claudeLimitSetWatch) {
                window.electronAPI.claudeLimitSetWatch(true);
            }
            const arm = clGetArm();
            if (!arm) return;
            const remaining = arm.at - Date.now();
            if (remaining > 0) {
                clStartScheduler();
            } else if (remaining > -10 * 60000) {
                // Missed by <10 min (app was closed/asleep right at reset) — continue now.
                clFire();
            } else {
                clSetArm(null); // too stale to be meaningful
            }
        }

        // Boot: resume any armed schedule + clipboard watch even if the panel is
        // closed, since firing is the widget's whole job.
        (function clBoot() {
            if (isClaudeLimitEnabled()) applyClaudeLimitEnabled(true);
        })();
