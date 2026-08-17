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
        //
        // Built for unattended / overnight use, so it leans on reliability features:
        //   • keep-awake      — holds a power-save blocker while armed so the machine
        //                       doesn't sleep through the reset (main process).
        //   • retry-on-fail   — if the target can't be focused at fire time it retries
        //                       a few times with backoff before giving up.
        //   • repeat mode     — for rolling "N-hour limit" windows it re-arms itself
        //                       for the next reset, up to a safety cap, so a long
        //                       autonomous run keeps continuing on its own.
        //   • history + OS toast — you can see (and get notified) that an overnight
        //                       continue actually fired, even with the app in the tray.

        const CL_DEFAULT_PROMPT = 'My usage limit should have reset now — please continue exactly where we left off.';
        const CL_MAX_HISTORY = 8;

        function clDefaults() {
            return {
                targetProcess: '', targetTitle: '', prompt: CL_DEFAULT_PROMPT, pressEnter: true,
                bufferSec: 20, autoWatch: false, autoWindow: false, autoCc: false, autoArm: false,
                repeat: false, maxContinues: 12, keepAwake: true, notify: true
            };
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
        function clGetHistory() {
            const h = safeParseJSON(localStorage.getItem('claudeLimitHistory'), []);
            return Array.isArray(h) ? h : [];
        }
        function clPushHistory(entry) {
            const h = clGetHistory();
            h.unshift({ t: Date.now(), ...entry });
            localStorage.setItem('claudeLimitHistory', JSON.stringify(h.slice(0, CL_MAX_HISTORY)));
        }
        function clClearHistory() {
            localStorage.removeItem('claudeLimitHistory');
            clPaintHistory();
            showToast('Auto-continue history cleared');
        }

        let clWindows = [];              // last-listed windows
        let clPendingResetAt = null;     // parsed-but-not-yet-armed reset Date (ms)
        let clPendingInterval = null;    // rolling-window length (ms) when known, for repeat mode
        let clSchedTimer = null;
        let clFiring = false;
        let clWatchHooked = false;
        let clTargetMissing = false;     // last window-health probe couldn't find the target
        let clHealthTick = 0;

        function isClaudeLimitEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.claudeLimit;
        }

        // ── Reset-time parsing ──────────────────────────────────────────────────
        // Turns a copied limit message (or a manual phrase) into an absolute time,
        // and — when the message describes a rolling window — the window length too,
        // so repeat mode knows how far ahead to re-arm.
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

        // Returns { at:number(ms), interval:number|null, source:string } or null.
        function clParseReset(text) {
            if (!text) return null;
            const t = String(text).toLowerCase().replace(/\s+/g, ' ');
            const now = Date.now();

            // 1. Relative: "resets in 2 hours 30 minutes", "in 45 minutes", "in 3h"
            const rel = t.match(/\bin\s+((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/);
            if (rel) {
                const ms = clDurationToMs(rel[1]);
                if (ms > 0) return { at: now + ms, interval: ms, source: 'in ' + rel[1].trim() };
            }

            // 2. Rolling "N-hour limit" window → reset ~N hours from now, repeats every N hours.
            const nhour = t.match(/(\d+)\s*-\s*hour\s+limit/);
            if (nhour) {
                const ms = parseInt(nhour[1], 10) * 3600000;
                return { at: now + ms, interval: ms, source: nhour[1] + '-hour rolling limit' };
            }

            // 3. Explicit clock time, ideally near a reset/again cue:
            //    "resets at 3:00 pm", "available again at 15:30", "back at 9am"
            const cued = t.match(/(?:reset[s]?|again|at|until|back)\b[^0-9]{0,16}(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
            if (cued) {
                const h = parseInt(cued[1], 10);
                const min = cued[2] ? parseInt(cued[2], 10) : 0;
                const ap = cued[3] ? (cued[3][0] === 'a' ? 'am' : 'pm') : null;
                if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { at: clNextClock(h, min, ap).getTime(), interval: null, source: 'clock time' };
            }

            // 4. A bare clock time anywhere: "3:47 am" / "15:30"
            const bare = t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/);
            if (bare) {
                const h = parseInt(bare[1], 10);
                const min = parseInt(bare[2], 10);
                const ap = bare[3] ? (bare[3][0] === 'a' ? 'am' : 'pm') : null;
                if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { at: clNextClock(h, min, ap).getTime(), interval: null, source: 'clock time' };
            }

            // 5. Last resort — let the engine try a full date/time it recognises.
            const cleaned = text.replace(/.*reset[s]?\s*(on|at)?\s*/i, '').trim();
            const parsed = Date.parse(cleaned);
            if (!isNaN(parsed) && parsed > now) return { at: parsed, interval: null, source: 'date' };

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
        function clFmtInterval(ms) {
            const h = ms / 3600000;
            if (h >= 1 && Number.isInteger(h)) return `${h}h`;
            if (h >= 1) return `${h.toFixed(1)}h`;
            return `${Math.round(ms / 60000)}m`;
        }

        // ── Keep-awake ──────────────────────────────────────────────────────────
        // Hold a power-save blocker (main process) whenever a continue is armed and
        // the user wants it, so the machine doesn't sleep through the reset.
        function clSyncKeepAwake() {
            if (!window.electronAPI?.claudeLimitSetKeepAwake) return;
            const cfg = clGetConfig();
            const want = !!(clGetArm() && cfg.keepAwake);
            window.electronAPI.claudeLimitSetKeepAwake(want);
        }

        // ── In-window auto-detect ───────────────────────────────────────────────
        // Poll the picked window for a limit banner, but only while it makes sense:
        // widget on, a target chosen, auto-detect enabled, and nothing armed yet
        // (once we have a reset time and are counting down there's nothing to find).
        function clSyncWindowWatch() {
            if (!window.electronAPI?.claudeLimitSetWindowWatch) return;
            const cfg = clGetConfig();
            const want = !!(isClaudeLimitEnabled() && cfg.autoWindow && cfg.targetProcess && !clGetArm());
            window.electronAPI.claudeLimitSetWindowWatch(want, cfg.targetProcess || '', cfg.targetTitle || '');
        }

        // Watch Claude Code's own session transcripts for the 429 rate_limit event.
        // No target window needed to *detect* (it's read from disk); a target is
        // only needed to later *continue*.
        function clSyncCcWatch() {
            if (!window.electronAPI?.claudeLimitSetCcWatch) return;
            const cfg = clGetConfig();
            const want = !!(isClaudeLimitEnabled() && cfg.autoCc && !clGetArm());
            window.electronAPI.claudeLimitSetCcWatch(want);
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
            clPaintCountdown(remaining, arm);
            // Cheap safety net: while armed and the panel is open, confirm every ~30s
            // that the target window is still around, so a vanished window is flagged
            // long before fire time instead of failing silently at 3am.
            if (document.getElementById('cl-status') && (++clHealthTick % 30 === 0)) clHealthCheck();
        }

        async function clResolveHwnd() {
            if (!window.electronAPI?.claudeLimitListWindows) return null;
            const res = await window.electronAPI.claudeLimitListWindows();
            const wins = res?.windows || [];
            clWindows = wins;
            return clPickHwnd(wins);
        }
        function clPickHwnd(wins) {
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

        async function clHealthCheck() {
            if (!window.electronAPI?.claudeLimitListWindows) return;
            try {
                const res = await window.electronAPI.claudeLimitListWindows();
                clWindows = res?.windows || [];
                const missing = !clPickHwnd(clWindows);
                if (missing !== clTargetMissing) { clTargetMissing = missing; clPaintStatus(); }
            } catch (e) { /* ignore probe failures */ }
        }

        // Focus + paste, retrying a few times with backoff. Overnight the target can
        // momentarily refuse focus (fullscreen app, lock screen just cleared, …), so
        // one failed attempt shouldn't sink the whole continue.
        async function clSendWithRetry(prompt, pressEnter, tries = 4) {
            let lastErr = 'no window';
            for (let i = 0; i < tries; i++) {
                const hwnd = await clResolveHwnd();
                if (hwnd) {
                    try {
                        const res = await window.electronAPI.claudeLimitSend(hwnd, prompt, pressEnter);
                        if (res?.ok) return { ok: true };
                        lastErr = res?.error || 'send failed';
                    } catch (e) { lastErr = 'send error'; }
                } else {
                    lastErr = 'target window not found';
                }
                if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
            }
            return { ok: false, error: lastErr };
        }

        async function clFire() {
            if (clFiring) return;
            clFiring = true;
            const arm = clGetArm();
            const cfg = clGetConfig();
            let ok = false;
            let note = '';
            try {
                const res = await clSendWithRetry(cfg.prompt, cfg.pressEnter);
                ok = !!res.ok;
                note = ok ? '' : (res.error || 'failed');
                const title = cfg.targetTitle || cfg.targetProcess || 'target';
                if (ok) showToast('Limit reset — continued the conversation');
                else showToast(`Auto-continue: ${note}`, true);
                clPushHistory({ ok, title, note });
                if (cfg.notify && window.electronAPI?.claudeLimitNotify) {
                    window.electronAPI.claudeLimitNotify(
                        ok ? 'Claude continued' : 'Auto-continue failed',
                        ok ? `Sent your continue prompt to ${title}.` : `Couldn't continue in ${title} — ${note}.`
                    );
                }
            } catch (e) {
                showToast('Auto-continue failed', true);
                clPushHistory({ ok: false, title: cfg.targetTitle || '', note: 'error' });
            } finally {
                clFiring = false;
                // Repeat mode: for a known rolling window, re-arm for the next reset
                // (measured from the reset we just passed, so there's no per-cycle drift),
                // up to the safety cap.
                const count = (arm?.count || 1);
                const total = (arm?.total || cfg.maxContinues || 0);
                const interval = arm?.interval || 0;
                if (ok && cfg.repeat && interval > 0 && count < total) {
                    const nextReset = (arm.resetAt || Date.now()) + interval;
                    clSetArm({ at: nextReset + Math.max(0, (cfg.bufferSec || 0) * 1000), resetAt: nextReset, interval, count: count + 1, total, armedAt: Date.now() });
                    clStartScheduler();
                    showToast(`Continue ${count} of ${total} — next at ${clFmtClock(nextReset)}`);
                } else {
                    clSetArm(null);
                    clStopScheduler();
                    if (ok && cfg.repeat && interval > 0 && count >= total) showToast(`Reached the ${total}-continue safety cap — stopping`);
                }
                clSyncKeepAwake();
                clSyncWindowWatch(); // if we disarmed (not repeating), resume auto-detect
                clSyncCcWatch();
                clPaintStatus();
                clPaintHistory();
            }
        }

        function clArmAt(resetMs, interval) {
            const cfg = clGetConfig();
            const fireAt = resetMs + Math.max(0, (cfg.bufferSec || 0) * 1000);
            const total = (cfg.repeat && interval > 0) ? Math.max(1, cfg.maxContinues || 1) : 1;
            clSetArm({ at: fireAt, resetAt: resetMs, interval: interval || null, count: 1, total, armedAt: Date.now() });
            clTargetMissing = false;
            clStartScheduler();
            clSyncKeepAwake();
            clSyncWindowWatch(); // armed → nothing to detect, pause the window poll
            clSyncCcWatch();     // and the Claude Code poll
            clPaintStatus();
        }
        function clDisarm() {
            clSetArm(null);
            clStopScheduler();
            clSyncKeepAwake();
            clSyncWindowWatch(); // idle again → resume auto-detect if it was on
            clSyncCcWatch();
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

            if (!clWatchHooked) {
                if (window.electronAPI.onClaudeLimitClipboardHit) window.electronAPI.onClaudeLimitClipboardHit(clOnClipboardHit);
                if (window.electronAPI.onClaudeLimitWindowHit) window.electronAPI.onClaudeLimitWindowHit(clOnWindowHit);
                if (window.electronAPI.onClaudeLimitCcHit) window.electronAPI.onClaudeLimitCcHit(clOnCcHit);
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
                        <div class="cl-detect">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                <button type="button" class="cl-btn cl-btn-primary no-drag" onclick="clDetectFromCc()"><i class="fas fa-bolt mr-1"></i>Detect from Claude Code</button>
                                <label class="cl-check"><input type="checkbox" id="cl-cc" ${cfg.autoCc ? 'checked' : ''} onchange="clOnCcWatchToggle(this.checked)"><span>Auto-detect Claude Code</span></label>
                                <span class="cl-tag">most reliable</span>
                            </div>
                            <p class="cl-hint mt-1">Reads the exact reset time from Claude Code / Nimbalyst's own session log — the same 429 event Claude Code records. No copying, works even unfocused.</p>
                            <div class="flex items-center gap-1.5 flex-wrap mt-2 pt-2 cl-detect-div">
                                <button type="button" class="cl-btn no-drag" onclick="clDetectFromWindow()"><i class="fas fa-magnifying-glass mr-1"></i>Detect in window</button>
                                <label class="cl-check"><input type="checkbox" id="cl-window" ${cfg.autoWindow ? 'checked' : ''} onchange="clOnWindowWatchToggle(this.checked)"><span>Auto-detect in window</span></label>
                            </div>
                            <p class="cl-hint mt-1">For claude.ai in a browser or other apps — reads the on-screen banner from the window you picked above.</p>
                        </div>
                        <p class="cl-or">or paste / set it manually</p>
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

                    <details class="cl-adv" ${cfg.repeat ? 'open' : ''}>
                        <summary class="cl-label cl-adv-sum">4 · Reliability &amp; unattended</summary>
                        <div class="cl-adv-body">
                            <label class="cl-check"><input type="checkbox" id="cl-repeat" ${cfg.repeat ? 'checked' : ''} onchange="clOnRepeatToggle(this.checked)"><span>Keep continuing on each reset <span class="cl-hint">(rolling limits)</span></span></label>
                            <div class="cl-field ${cfg.repeat ? '' : 'cl-field-off'}" id="cl-repeat-field">
                                <span class="cl-hint">stop after</span>
                                <input type="number" id="cl-maxcont" class="cl-input cl-input-num no-drag" min="1" max="99" value="${cfg.maxContinues}" onchange="clOnMaxContinues(this.value)">
                                <span class="cl-hint">continues</span>
                            </div>
                            <div class="cl-field">
                                <span class="cl-hint">continue</span>
                                <input type="number" id="cl-buffer" class="cl-input cl-input-num no-drag" min="0" max="600" value="${cfg.bufferSec}" onchange="clOnBuffer(this.value)">
                                <span class="cl-hint">sec after the reset</span>
                            </div>
                            <label class="cl-check"><input type="checkbox" id="cl-keepawake" ${cfg.keepAwake ? 'checked' : ''} onchange="clOnKeepAwake(this.checked)"><span>Keep the PC awake while armed</span></label>
                            <label class="cl-check"><input type="checkbox" id="cl-notify" ${cfg.notify ? 'checked' : ''} onchange="clOnNotify(this.checked)"><span>Show a desktop notification when it fires</span></label>
                        </div>
                    </details>

                    <div id="cl-status" class="cl-status">${clStatusHtml()}</div>
                    <div id="cl-history" class="cl-history">${clHistoryHtml()}</div>
                </div>`;

            clRenderWindowOptions();
            clRefreshWindows(); // pull a fresh list on open
        }

        function clStatusHtml() {
            const arm = clGetArm();
            const cfg = clGetConfig();
            if (arm) {
                const remaining = arm.at - Date.now();
                const span = Math.max(1, arm.at - (arm.armedAt || (arm.at - remaining)));
                const pct = Math.min(100, Math.max(0, ((span - remaining) / span) * 100));
                const repeatLine = (arm.total > 1)
                    ? ` · continue ${arm.count} of ${arm.total}${arm.interval ? `, every ${clFmtInterval(arm.interval)}` : ''}`
                    : '';
                const missing = clTargetMissing
                    ? `<p class="cl-warn"><i class="fas fa-triangle-exclamation mr-1"></i>Target window isn't open right now — reopen it before the reset.</p>`
                    : '';
                return `<div class="cl-armed">
                        <div class="cl-armed-row">
                            <span class="cl-armed-dot"></span>
                            <div class="min-w-0 flex-1">
                                <p class="cl-armed-title">Continues in <span id="cl-count">${esc(clFmtRemaining(remaining))}</span></p>
                                <p class="cl-armed-sub">at ${esc(clFmtClock(arm.at))}${cfg.bufferSec ? ` · ${cfg.bufferSec}s after reset` : ''}${repeatLine}</p>
                            </div>
                            <button type="button" class="cl-btn cl-btn-danger no-drag" onclick="clDisarm()">Disarm</button>
                        </div>
                        <div class="cl-progress"><div class="cl-progress-fill" id="cl-bar" style="width:${pct.toFixed(1)}%"></div></div>
                        ${missing}
                        <button type="button" class="cl-btn no-drag mt-2" onclick="clContinueNow()"><i class="fas fa-paper-plane mr-1"></i>Continue now (test)</button>
                    </div>`;
            }
            const ready = clPendingResetAt && cfg.prompt && cfg.targetProcess;
            const repeatHint = (cfg.repeat && clPendingInterval)
                ? ` — will repeat every ${clFmtInterval(clPendingInterval)}`
                : (cfg.repeat && !clPendingInterval && clPendingResetAt ? ' — one-off (no rolling window detected)' : '');
            const resetLine = clPendingResetAt
                ? `<p class="cl-armed-sub mb-2">Detected reset: <b class="text-neutral-200">${esc(clFmtClock(clPendingResetAt))}</b> (${esc(clFmtRemaining(clPendingResetAt - Date.now()))})${esc(repeatHint)}</p>`
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

        function clHistoryHtml() {
            const h = clGetHistory();
            if (!h.length) return '';
            const rows = h.map((e) => {
                const when = clFmtClock(e.t);
                const icon = e.ok ? '<i class="fas fa-circle-check cl-h-ok"></i>' : '<i class="fas fa-circle-xmark cl-h-fail"></i>';
                const txt = e.ok ? `Continued ${esc(e.title || '')}` : `Failed — ${esc(e.note || 'error')}`;
                return `<div class="cl-h-row">${icon}<span class="cl-h-txt">${txt}</span><span class="cl-h-when">${esc(when)}</span></div>`;
            }).join('');
            return `<div class="cl-h-head"><span class="cl-label">Recent</span><button type="button" class="cl-h-clear no-drag" onclick="clClearHistory()">clear</button></div>${rows}`;
        }

        function clPaintStatus() {
            const el = document.getElementById('cl-status');
            if (el) el.innerHTML = clStatusHtml();
        }
        function clPaintHistory() {
            const el = document.getElementById('cl-history');
            if (el) el.innerHTML = clHistoryHtml();
        }
        function clPaintCountdown(remaining, arm) {
            const c = document.getElementById('cl-count');
            if (!c) { clPaintStatus(); return; } // status block not showing the countdown yet — rebuild it
            c.textContent = clFmtRemaining(remaining);
            const bar = document.getElementById('cl-bar');
            if (bar && arm) {
                const span = Math.max(1, arm.at - (arm.armedAt || (arm.at - remaining)));
                const pct = Math.min(100, Math.max(0, ((span - remaining) / span) * 100));
                bar.style.width = pct.toFixed(1) + '%';
            }
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
            clTargetMissing = false;
            clSyncWindowWatch(); // point the auto-detect poll at the newly picked window
            clPaintStatus();
        }

        function clOnPromptInput(v) { const cfg = clGetConfig(); cfg.prompt = v; clSaveConfig(cfg); }
        function clOnEnterToggle(v) { const cfg = clGetConfig(); cfg.pressEnter = !!v; clSaveConfig(cfg); }
        function clOnAutoArmToggle(v) { const cfg = clGetConfig(); cfg.autoArm = !!v; clSaveConfig(cfg); }

        function clOnRepeatToggle(v) {
            const cfg = clGetConfig(); cfg.repeat = !!v; clSaveConfig(cfg);
            const field = document.getElementById('cl-repeat-field');
            if (field) field.classList.toggle('cl-field-off', !v);
            clPaintStatus(); // idle hint reflects repeat state
        }
        function clOnMaxContinues(v) {
            const n = parseInt(v, 10);
            const cfg = clGetConfig(); cfg.maxContinues = (!isNaN(n) && n >= 1) ? Math.min(99, n) : 12; clSaveConfig(cfg);
        }
        function clOnBuffer(v) {
            const n = parseInt(v, 10);
            const cfg = clGetConfig(); cfg.bufferSec = (!isNaN(n) && n >= 0) ? Math.min(600, n) : 20; clSaveConfig(cfg);
            clPaintStatus();
        }
        function clOnKeepAwake(v) { const cfg = clGetConfig(); cfg.keepAwake = !!v; clSaveConfig(cfg); clSyncKeepAwake(); }
        function clOnNotify(v) { const cfg = clGetConfig(); cfg.notify = !!v; clSaveConfig(cfg); }

        function clOnWatchToggle(v) {
            const cfg = clGetConfig();
            cfg.autoWatch = !!v;
            clSaveConfig(cfg);
            if (window.electronAPI?.claudeLimitSetWatch) window.electronAPI.claudeLimitSetWatch(!!v);
            showToast(v ? 'Watching clipboard for limit messages' : 'Clipboard watch off');
        }

        function clOnWindowWatchToggle(v) {
            const cfg = clGetConfig();
            cfg.autoWindow = !!v;
            clSaveConfig(cfg);
            clSyncWindowWatch();
            if (v && !cfg.targetProcess) showToast('Pick a target window above so it knows where to look', true);
            else showToast(v ? 'Auto-detecting the limit inside the window' : 'Window auto-detect off');
        }

        function clOnCcWatchToggle(v) {
            const cfg = clGetConfig();
            cfg.autoCc = !!v;
            clSaveConfig(cfg);
            clSyncCcWatch();
            showToast(v ? 'Auto-detecting limits from Claude Code' : 'Claude Code auto-detect off');
        }

        async function clDetectFromCc() {
            if (!window.electronAPI?.claudeLimitReadCcLimit) { showToast('Claude Code detection is unavailable', true); return; }
            showToast('Checking Claude Code session log…');
            const res = await window.electronAPI.claudeLimitReadCcLimit();
            if (!res?.ok) { showToast('Couldn\'t read the Claude Code log', true); return; }
            if (!res.found) { showToast('No recent Claude Code limit found', true); return; }
            const box = document.getElementById('cl-msg');
            if (box) box.value = String(res.text).slice(0, 2000);
            const p = clParseReset(res.text);
            if (p) clSetPendingReset(p.at, { interval: p.interval, source: p.source });
            else showToast('Found a limit event but couldn\'t read the reset time', true);
        }

        async function clDetectFromWindow() {
            const cfg = clGetConfig();
            if (!cfg.targetProcess) { showToast('Pick a target window above first', true); return; }
            if (!window.electronAPI?.claudeLimitReadWindowText) { showToast('Window detection is unavailable', true); return; }
            showToast('Reading the window…');
            const res = await window.electronAPI.claudeLimitReadWindowText(cfg.targetProcess, cfg.targetTitle);
            if (!res?.ok) { showToast(res?.error === 'window not open' ? 'Target window isn\'t open' : 'Couldn\'t read that window', true); return; }
            if (!res.found) { showToast('No usage-limit banner found in that window', true); return; }
            const box = document.getElementById('cl-msg');
            if (box) box.value = String(res.text).slice(0, 2000);
            const p = clParseReset(res.text);
            if (p) clSetPendingReset(p.at, { interval: p.interval, source: p.source });
            else showToast('Found a limit banner but couldn\'t read the reset time', true);
        }

        function clSetPendingReset(ms, opts) {
            opts = opts || {};
            if (!ms || ms <= Date.now()) { if (!opts.quiet) showToast('Couldn\'t read a future reset time', true); return false; }
            clPendingResetAt = ms;
            clPendingInterval = opts.interval || null;
            clPaintStatus();
            if (!opts.quiet) showToast(`Reset time: ${clFmtClock(ms)}${opts.source ? ` (${opts.source})` : ''}`);
            return true;
        }

        function clParseFromBox() {
            const box = document.getElementById('cl-msg');
            const p = clParseReset(box ? box.value : '');
            if (p) clSetPendingReset(p.at, { interval: p.interval, source: p.source });
            else clSetPendingReset(null);
        }

        async function clDetectFromClipboard() {
            if (!window.electronAPI?.claudeLimitReadClipboard) return;
            const res = await window.electronAPI.claudeLimitReadClipboard();
            const box = document.getElementById('cl-msg');
            if (box && res?.text) box.value = res.text.slice(0, 2000);
            const p = clParseReset(res?.text || '');
            if (p) clSetPendingReset(p.at, { interval: p.interval, source: p.source });
            else clSetPendingReset(null);
        }

        function clSetManualTime() {
            const el = document.getElementById('cl-time');
            if (!el || !el.value) { showToast('Enter a time first', true); return; }
            const [h, m] = el.value.split(':').map((x) => parseInt(x, 10));
            if (isNaN(h) || isNaN(m)) { showToast('Invalid time', true); return; }
            clSetPendingReset(clNextClock(h, m, null).getTime(), { source: 'manual time' });
        }
        function clSetManualMinutes() {
            const el = document.getElementById('cl-mins');
            const mins = parseInt(el ? el.value : '', 10);
            if (isNaN(mins) || mins <= 0) { showToast('Enter minutes first', true); return; }
            // A manual countdown is inherently a fixed interval, so repeat mode can use it.
            clSetPendingReset(Date.now() + mins * 60000, { interval: mins * 60000, source: `in ${mins} min` });
        }

        function clArmNow() {
            const cfg = clGetConfig();
            if (!clPendingResetAt) { showToast('Set a reset time first', true); return; }
            if (!cfg.targetProcess) { showToast('Pick a target window first', true); return; }
            clArmAt(clPendingResetAt, clPendingInterval);
            const arm = clGetArm();
            showToast(`Armed — continues at ${clFmtClock(arm.at)}${arm.total > 1 ? `, up to ${arm.total}×` : ''}`);
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

        // Shared path for a limit detected automatically — from the clipboard watcher
        // or the in-window poller. Sets the pending reset and, if auto-arm is on and
        // we're configured, arms straight away.
        function clHandleDetection(text, via) {
            if (!text) return;
            const box = document.getElementById('cl-msg');
            if (box) box.value = String(text).slice(0, 2000);
            const p = clParseReset(text);
            if (!p) return;
            const cfg = clGetConfig();
            clSetPendingReset(p.at, { interval: p.interval, source: p.source, quiet: true });
            const tag = via ? ` (${via})` : '';
            if (cfg.autoArm && cfg.targetProcess && cfg.prompt) {
                clArmAt(p.at, p.interval);
                showToast(`Limit detected${tag} — armed, continues at ${clFmtClock(clGetArm().at)}`);
            } else {
                showToast(`Limit detected${tag} — resets ${clFmtClock(p.at)}`);
            }
        }

        // Fired by the main-process clipboard watcher when a limit message is copied.
        function clOnClipboardHit(data) { if (data?.text) clHandleDetection(data.text, 'clipboard'); }
        // Fired by the in-window poller when a limit banner appears in the target.
        function clOnWindowHit(data) { if (data?.text) clHandleDetection(data.text, 'window'); }
        // Fired by the Claude Code transcript poller on a fresh 429 rate_limit event.
        function clOnCcHit(data) { if (data?.text) clHandleDetection(data.text, 'Claude Code'); }

        // Called from applyMiniWidgetPrefs when the widget is toggled, and from boot.
        // Starts/stops the clipboard watch and resumes any armed schedule so firing
        // works even when the config panel isn't open.
        function applyClaudeLimitEnabled(enabled) {
            if (!enabled) {
                clStopScheduler();
                if (window.electronAPI?.claudeLimitSetWatch) window.electronAPI.claudeLimitSetWatch(false);
                if (window.electronAPI?.claudeLimitSetWindowWatch) window.electronAPI.claudeLimitSetWindowWatch(false, '', '');
                if (window.electronAPI?.claudeLimitSetCcWatch) window.electronAPI.claudeLimitSetCcWatch(false);
                if (window.electronAPI?.claudeLimitSetKeepAwake) window.electronAPI.claudeLimitSetKeepAwake(false);
                return;
            }
            const cfg = clGetConfig();
            if (cfg.autoWatch && window.electronAPI?.claudeLimitSetWatch) {
                window.electronAPI.claudeLimitSetWatch(true);
            }
            clSyncWindowWatch();
            clSyncCcWatch();
            const arm = clGetArm();
            if (!arm) return;
            const remaining = arm.at - Date.now();
            if (remaining > 0) {
                clStartScheduler();
                clSyncKeepAwake();
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
