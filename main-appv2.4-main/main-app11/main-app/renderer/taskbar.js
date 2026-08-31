        // ── Translucent Taskbar mini widget UI ──
        // Renders inside the #taskbar-panel container in the Widget Library detail
        // view. Edits the look, shows a live mock-taskbar preview, and pushes every
        // change to main/taskbar.js over IPC, which enforces it on the real Explorer
        // taskbar(s) via SetWindowCompositionAttribute. Modeled on the Crosshair panel.

        const TASKBAR_DEFAULTS = { mode: 'clear', color: '#0f0f14', opacity: 30 };

        // Which controls each mode exposes. `opacity:false` means the tint is drawn
        // fully solid (Opaque) — main forces alpha to 255 regardless.
        const TASKBAR_MODES = [
            { v: 'normal',  l: 'Normal',  color: false, opacity: false, hint: 'Windows default look' },
            { v: 'clear',   l: 'Clear',   color: true,  opacity: true,  hint: 'See-through, optional tint' },
            { v: 'blur',    l: 'Blur',    color: false, opacity: false, hint: 'Frosted blur behind the bar' },
            { v: 'acrylic', l: 'Acrylic', color: true,  opacity: true,  hint: 'Acrylic material with a tint' },
            { v: 'opaque',  l: 'Opaque',  color: true,  opacity: false, hint: 'Solid colour' }
        ];
        const TASKBAR_COLOR_PRESETS = ['#0f0f14', '#000000', '#1e2430', '#2a1a3a', '#0a2540', '#ffffff'];

        function getTaskbarConfig() {
            return Object.assign({}, TASKBAR_DEFAULTS, safeParseJSON(localStorage.getItem('taskbarConfig'), {}));
        }

        function isTaskbarWidgetEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.taskbar;
        }

        function taskbarModeDef(mode) {
            return TASKBAR_MODES.find((m) => m.v === mode) || TASKBAR_MODES[1];
        }

        // '#rrggbb' -> { r, g, b }. Defensive against a short/garbage stored value.
        function taskbarHexToRgb(hex) {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
            if (!m) return { r: 15, g: 15, b: 20 };
            const n = parseInt(m[1], 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }

        // Push the current look to the main process (which applies it to every
        // taskbar and keeps re-asserting it). Safe to call on startup and every edit.
        // Last (mode|rgba) actually sent to main. Guards against re-pushing an
        // identical look on every panel repaint / prefs re-apply — which, once
        // TranslucentTB is driving the bar, would otherwise rewrite its settings and
        // relaunch it in a tight loop (visible as taskbar/notification spam).
        let lastTaskbarPushSig = null;

        function pushTaskbarState() {
            if (!window.electronAPI?.taskbarApply) return;
            const cfg = getTaskbarConfig();
            const def = taskbarModeDef(cfg.mode);
            const rgb = taskbarHexToRgb(cfg.color);
            // Alpha only matters for colour modes with an opacity control; solid and
            // colourless modes send a: 0 and let main decide.
            const a = def.opacity ? Math.round((Number(cfg.opacity) || 0) / 100 * 255) : (def.color ? 255 : 0);
            const sig = `${cfg.mode}|${rgb.r},${rgb.g},${rgb.b},${a}`;
            if (sig === lastTaskbarPushSig) return; // unchanged — don't re-apply
            lastTaskbarPushSig = sig;
            window.electronAPI.taskbarApply(cfg.mode, { r: rgb.r, g: rgb.g, b: rgb.b, a });
        }

        // Called from applyMiniWidgetPrefs() when the toggle flips (and on startup) —
        // mirrors applyCrosshairEnabled: enabling pushes the saved look, disabling
        // restores the system taskbar.
        function applyTaskbarEnabled(enabled) {
            if (enabled) {
                pushTaskbarState();
            } else if (window.electronAPI?.taskbarClear) {
                lastTaskbarPushSig = null; // so re-enabling re-pushes the look
                window.electronAPI.taskbarClear();
            }
            renderTaskbarPanel();
        }

        function tbSetMode(mode) {
            const cfg = getTaskbarConfig();
            cfg.mode = mode;
            localStorage.setItem('taskbarConfig', JSON.stringify(cfg));
            pushTaskbarState();
            renderTaskbarPanel();
            scheduleSettingsSave();
        }

        function tbSetColor(value) {
            const cfg = getTaskbarConfig();
            cfg.color = value;
            localStorage.setItem('taskbarConfig', JSON.stringify(cfg));
            paintTaskbarPreview();
            pushTaskbarState();
            scheduleSettingsSave();
        }

        // color changed from a preset swatch — persist, push, and re-render so the
        // active swatch ring repaints.
        function tbSetColorDiscrete(value) {
            const cfg = getTaskbarConfig();
            cfg.color = value;
            localStorage.setItem('taskbarConfig', JSON.stringify(cfg));
            pushTaskbarState();
            renderTaskbarPanel();
            scheduleSettingsSave();
        }

        function tbSetOpacity(value) {
            const cfg = getTaskbarConfig();
            cfg.opacity = Math.max(0, Math.min(100, Number(value) || 0));
            localStorage.setItem('taskbarConfig', JSON.stringify(cfg));
            const label = document.getElementById('taskbar-val-opacity');
            if (label) label.textContent = `${cfg.opacity}%`;
            paintTaskbarPreview();
            pushTaskbarState();
            scheduleSettingsSave();
        }

        function tbResetConfig() {
            localStorage.setItem('taskbarConfig', JSON.stringify(TASKBAR_DEFAULTS));
            pushTaskbarState();
            renderTaskbarPanel();
            scheduleSettingsSave();
            showToast('Taskbar reset to defaults');
        }

        // Repaints the mock-taskbar preview from the current config — approximates
        // the chosen look with a CSS backdrop so users can judge it before it lands
        // on the real bar.
        function paintTaskbarPreview() {
            const bar = document.getElementById('taskbar-preview-bar');
            if (!bar) return;
            const cfg = getTaskbarConfig();
            const def = taskbarModeDef(cfg.mode);
            const rgb = taskbarHexToRgb(cfg.color);
            const alpha = def.opacity ? (Number(cfg.opacity) || 0) / 100 : 1;

            let background = 'transparent';
            let backdrop = 'none';
            if (cfg.mode === 'normal') {
                background = 'rgba(20,20,26,0.85)';
                backdrop = 'blur(6px)';
            } else if (cfg.mode === 'blur') {
                background = 'rgba(30,30,38,0.35)';
                backdrop = 'blur(10px)';
            } else if (cfg.mode === 'acrylic') {
                background = `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.max(0.15, alpha)})`;
                backdrop = 'blur(14px) saturate(1.4)';
            } else if (cfg.mode === 'clear') {
                background = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
            } else if (cfg.mode === 'opaque') {
                background = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
            }
            bar.style.background = background;
            bar.style.backdropFilter = backdrop;
            bar.style.webkitBackdropFilter = backdrop;
        }

        function renderTaskbarPanel() {
            const panel = document.getElementById('taskbar-panel');
            if (!panel) return;
            if (!isTaskbarWidgetEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.taskbarApply) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Taskbar styling is unavailable.</p>`;
                return;
            }

            const cfg = getTaskbarConfig();
            const def = taskbarModeDef(cfg.mode);

            const colorBlock = def.color ? `
                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Tint colour</p>
                    <div class="flex items-center gap-1.5">
                        ${TASKBAR_COLOR_PRESETS.map((col) => `
                        <button type="button" onclick="tbSetColorDiscrete(${jsAttr(col)})" title="${col}"
                            class="w-7 h-7 rounded-lg border transition-transform no-drag hover:scale-110 ${cfg.color.toLowerCase() === col ? 'border-white' : 'border-white/15'}"
                            style="background:${col}"></button>`).join('')}
                        <input type="color" value="${esc(cfg.color)}" title="Custom colour"
                            class="w-7 h-7 rounded-lg bg-transparent border border-white/15 cursor-pointer no-drag"
                            oninput="tbSetColor(this.value)">
                    </div>
                </div>` : '';

            const opacityBlock = def.opacity ? `
                <div class="flex items-center gap-3">
                    <span class="text-[11px] text-neutral-400 w-16 shrink-0">Opacity</span>
                    <input type="range" min="0" max="100" value="${cfg.opacity}" class="ve-vol-slider flex-1 no-drag"
                        oninput="tbSetOpacity(this.value)">
                    <span class="ve-vol-val" id="taskbar-val-opacity">${cfg.opacity}%</span>
                </div>` : '';

            panel.innerHTML = `<div class="mt-3 space-y-3">
                <!-- TranslucentTB install prompt (shown when it isn't installed) -->
                <div id="taskbar-ttb-prompt"></div>

                <!-- Live mock-taskbar preview over a wallpaper-like backdrop -->
                <div class="rounded-xl border border-white/10 overflow-hidden relative" style="height:120px; background:
                    linear-gradient(135deg, #3a4a6b 0%, #6b4a7a 45%, #b06a52 100%)">
                    <div style="position:absolute;left:14px;top:14px;display:flex;gap:6px">
                        <span style="width:26px;height:26px;border-radius:7px;background:rgba(255,255,255,0.18)"></span>
                        <span style="width:26px;height:26px;border-radius:7px;background:rgba(255,255,255,0.12)"></span>
                    </div>
                    <div id="taskbar-preview-bar" style="position:absolute;left:0;right:0;bottom:0;height:34px;display:flex;align-items:center;justify-content:center;gap:10px;border-top:1px solid rgba(255,255,255,0.08)">
                        <span style="width:16px;height:16px;border-radius:4px;background:rgba(255,255,255,0.55)"></span>
                        <span style="width:16px;height:16px;border-radius:4px;background:rgba(255,255,255,0.4)"></span>
                        <span style="width:16px;height:16px;border-radius:4px;background:rgba(255,255,255,0.4)"></span>
                        <span style="width:16px;height:16px;border-radius:4px;background:rgba(255,255,255,0.4)"></span>
                    </div>
                </div>

                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Appearance</p>
                    <div class="grid grid-cols-5 gap-1.5">${TASKBAR_MODES.map((m) => `
                        <button type="button" onclick="tbSetMode(${jsAttr(m.v)})"
                            class="px-1.5 py-1.5 rounded-lg text-[11px] border transition-colors no-drag ${cfg.mode === m.v
                                ? 'bg-white/15 border-white/25 text-white'
                                : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'}">${m.l}</button>`).join('')}
                    </div>
                    <p class="text-[10px] text-neutral-600 mt-1.5">${esc(def.hint)}</p>
                </div>

                ${colorBlock}
                ${opacityBlock}

                <div class="flex items-center justify-between gap-3">
                    <div id="taskbar-engine-badge" class="text-[10px] text-neutral-600"></div>
                    <button type="button" onclick="tbResetConfig()" class="hotkey-bind no-drag">Reset</button>
                </div>

                <p class="text-[10px] text-neutral-600 leading-relaxed">Styles the Windows taskbar on every monitor. Turning the widget off restores the default taskbar. Acrylic can make the taskbar feel slightly laggy to hover on some builds — switch to Blur or Clear if you notice it.</p>
            </div>`;

            paintTaskbarPreview();
            updateTaskbarEngineBadge();
        }

        // Fills the engine badge asynchronously: which backend is styling the
        // taskbar. On modern Windows 11 the built-in accent API can't touch the
        // taskbar, so we drive an installed TranslucentTB instead — and when it
        // isn't installed, we say so and offer the Store link rather than silently
        // doing nothing.
        async function updateTaskbarEngineBadge() {
            const badge = document.getElementById('taskbar-engine-badge');
            if (!badge || !window.electronAPI?.taskbarStatus) return;
            let st;
            try { st = await window.electronAPI.taskbarStatus(); } catch (e) { return; }
            const badgeNow = document.getElementById('taskbar-engine-badge');
            const prompt = document.getElementById('taskbar-ttb-prompt');
            if (!badgeNow) return;
            if (st.engine === 'translucenttb') {
                // Installed → drive TranslucentTB; no prompt needed.
                badgeNow.innerHTML = `<i class="fas fa-bolt mr-1 text-emerald-400/70"></i>Powered by TranslucentTB${st.running ? '' : ' <span class="text-neutral-700">(will launch on apply)</span>'}`;
                if (prompt) prompt.innerHTML = '';
            } else {
                // Not installed → TranslucentTB is the default engine, so prompt to
                // install it (we don't run the old built-in engine as a fallback).
                badgeNow.innerHTML = `<i class="fas fa-triangle-exclamation mr-1 text-amber-400/70"></i>Needs <span class="text-neutral-400">TranslucentTB</span> to style the taskbar`;
                if (prompt) {
                    // Inline styles for colours so this renders correctly without a
                    // Tailwind rebuild (matches how the rest of this panel inlines style).
                    prompt.innerHTML = `
                        <div style="border:1px solid rgba(251,191,36,0.28);background:rgba(251,191,36,0.10);border-radius:12px;padding:11px;display:flex;flex-direction:column;gap:9px">
                            <div style="display:flex;align-items:flex-start;gap:8px">
                                <i class="fas fa-wand-magic-sparkles" style="color:rgba(252,211,77,0.85);margin-top:2px"></i>
                                <div style="font-size:11px;line-height:1.5;color:#e5e5e5">
                                    <b>Install TranslucentTB to style your taskbar.</b>
                                    <span style="color:#a3a3a3">Taskbar styling runs through TranslucentTB (it's the only reliable way on current Windows 11). One click installs it for you via winget.</span>
                                </div>
                            </div>
                            <button type="button" class="taskbar-install-btn no-drag" onclick="tbInstallTtb()"
                                style="align-self:flex-start;font-size:11px;padding:6px 12px;border-radius:8px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;cursor:pointer;transition:background .15s">
                                <i class="fas fa-download mr-1.5"></i>Install TranslucentTB (winget)
                            </button>
                        </div>`;
                }
            }
        }

        // Kicks off a user-initiated TranslucentTB install (winget, Store fallback)
        // via the main process. On success the widget is now driving TranslucentTB,
        // so re-push the saved look and refresh the badge to the TranslucentTB engine.
        async function tbInstallTtb() {
            if (!window.electronAPI?.taskbarInstallTtb) return;
            const btn = document.querySelector('.taskbar-install-btn');
            const resetBtn = (label) => { if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-download mr-1.5"></i>${label}`; } };
            if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-1.5"></i>Installing…`; }
            showToast('Installing TranslucentTB via winget…');
            let res;
            try { res = await window.electronAPI.taskbarInstallTtb(); }
            catch (e) { res = { ok: false }; }

            if (res && res.ok && (res.method === 'winget' || res.already)) {
                showToast('TranslucentTB installed');
                lastTaskbarPushSig = null;    // force the first post-install apply through
                pushTaskbarState();          // now applies through TranslucentTB
                updateTaskbarEngineBadge();  // clears the prompt, flips the badge
            } else if (res && res.method === 'store') {
                showToast('winget unavailable — opened the Microsoft Store. Click Get, then reopen this panel.');
                resetBtn('Install TranslucentTB (winget)');
            } else {
                showToast('Install failed — try the Microsoft Store', true);
                resetBtn('Install TranslucentTB (winget)');
            }
        }
