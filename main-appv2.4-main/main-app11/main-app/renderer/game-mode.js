        // ── Game Mode (renderer) ──
        // Config panel for per-game "profiles" plus the client side that actually
        // applies a profile's actions when the main process reports a game started
        // (and reverts them when it ends). Detection lives in main/gameMode.js; the
        // actions — muting the mic, showing the crosshair, running the FPS
        // optimiser, enabling other mini widgets — are renderer features, so we
        // drive them here from the game-mode-event stream. initGameMode() wires the
        // event listener at startup so profiles fire even with the panel closed.

        let gameModeState = null;       // last full status from main
        let gameModeEditing = null;     // rule object being edited in the panel, or null
        let gameModeProcList = null;    // cached process-name list for the picker
        let gameModeHooked = false;
        // What a running profile changed, so it can be undone cleanly on stop.
        let gameModeApplied = { ruleId: null, mutedMic: false, enabledWidgets: [], ranFps: false };

        function isGameModeEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.gameMode;
        }

        async function applyGameModeEnabled(enabled) {
            if (window.electronAPI?.gameModeSetEnabled) {
                await window.electronAPI.gameModeSetEnabled(!!enabled);
            }
            if (typeof renderGameModePanel === 'function') renderGameModePanel();
        }

        // Registered once at startup — profiles must apply whether or not the
        // Widget Library detail panel is open.
        function initGameMode() {
            if (gameModeHooked) return;
            gameModeHooked = true;
            if (window.electronAPI?.onGameModeEvent) {
                window.electronAPI.onGameModeEvent((data) => {
                    if (!data || !data.rule) return;
                    if (data.type === 'start') applyGameProfile(data.rule, data.exe);
                    else if (data.type === 'stop') revertGameProfile(data.rule);
                });
            }
            if (window.electronAPI?.onGameModeDetect) {
                window.electronAPI.onGameModeDetect((data) => {
                    if (gameModeState) {
                        gameModeState.exe = data.exe;
                        gameModeState.fullscreen = data.fullscreen;
                        gameModeState.activeRuleId = data.activeRuleId;
                    }
                    gameModeRenderStatus();
                });
            }
        }

        // ── Applying / reverting a profile ──
        async function applyGameProfile(rule, exe) {
            const a = rule.actions || {};
            const applied = { ruleId: rule.id, mutedMic: false, enabledWidgets: [], ranFps: false };

            if (a.showToast && typeof showToast === 'function') {
                showToast(`Game Mode: ${rule.name}`);
            }
            if (a.muteMic && window.electronAPI?.getMicMuteStatus && window.electronAPI?.micMuteToggle) {
                try {
                    const st = await window.electronAPI.getMicMuteStatus();
                    if (st && st.muted === false) { await window.electronAPI.micMuteToggle(); applied.mutedMic = true; }
                } catch (e) { /* ignore */ }
            }
            if (a.crosshair) {
                if (!isMiniWidgetEnabled('crosshair')) { await gameModeEnableWidget('crosshair'); applied.enabledWidgets.push('crosshair'); }
            }
            for (const id of (a.enableWidgets || [])) {
                if (id === 'gameMode') continue;
                if (!isMiniWidgetEnabled(id)) { await gameModeEnableWidget(id); applied.enabledWidgets.push(id); }
            }
            if (a.fpsOptimize && window.electronAPI?.fpsOptimizeOnly) {
                try { await window.electronAPI.fpsOptimizeOnly(); applied.ranFps = true; } catch (e) { /* ignore */ }
            }
            gameModeApplied = applied;
            gameModeRenderStatus();
        }

        async function revertGameProfile(rule) {
            if (!rule.revert) { if (gameModeApplied.ruleId === rule.id) gameModeApplied = { ruleId: null, mutedMic: false, enabledWidgets: [], ranFps: false }; gameModeRenderStatus(); return; }
            const applied = gameModeApplied.ruleId === rule.id ? gameModeApplied : null;
            if (applied) {
                if (applied.mutedMic && window.electronAPI?.getMicMuteStatus && window.electronAPI?.micMuteToggle) {
                    try {
                        const st = await window.electronAPI.getMicMuteStatus();
                        if (st && st.muted === true) await window.electronAPI.micMuteToggle();
                    } catch (e) { /* ignore */ }
                }
                for (const id of applied.enabledWidgets) {
                    if (isMiniWidgetEnabled(id)) await gameModeDisableWidget(id);
                }
                if (applied.ranFps && window.electronAPI?.fpsRevertOptimizations) {
                    try { await window.electronAPI.fpsRevertOptimizations(); } catch (e) { /* ignore */ }
                }
            }
            gameModeApplied = { ruleId: null, mutedMic: false, enabledWidgets: [], ranFps: false };
            if (rule.actions && rule.actions.showToast && typeof showToast === 'function') showToast(`Game Mode: ${rule.name} ended`);
            gameModeRenderStatus();
        }

        // Enable/disable another mini widget through the same path the library uses,
        // so all its side effects (overlay windows, main-process toggles) run.
        async function gameModeEnableWidget(id) {
            if (typeof setMiniWidgetEnabled === 'function') await setMiniWidgetEnabled(id, true);
        }
        async function gameModeDisableWidget(id) {
            if (typeof setMiniWidgetEnabled === 'function') await setMiniWidgetEnabled(id, false);
        }

        // ── Panel ──
        async function renderGameModePanel() {
            const panel = document.getElementById('game-mode-panel');
            if (!panel) return;
            initGameMode();
            if (!isGameModeEnabled()) { panel.innerHTML = ''; gameModeEditing = null; return; }
            if (!window.electronAPI?.gameModeGet) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Game Mode is unavailable.</p>`;
                return;
            }
            const state = await window.electronAPI.gameModeGet();
            if (!isGameModeEnabled() || !document.getElementById('game-mode-panel')) return;
            gameModeState = state;
            gameModePaint();
        }

        function gameModePaint() {
            const panel = document.getElementById('game-mode-panel');
            if (!panel || !gameModeState) return;
            if (gameModeEditing) { gameModePaintEditor(); return; }

            const rules = gameModeState.rules || [];
            const ruleCards = rules.length ? rules.map(gameModeRuleCard).join('') :
                `<p class="text-xs text-neutral-600 py-2">No profiles yet. Add one to choose what happens when a game launches.</p>`;

            panel.innerHTML = `
                <div class="mt-3 space-y-3">
                    <div id="game-mode-status">${gameModeStatusHtml()}</div>
                    <div class="space-y-2">${ruleCards}</div>
                    <button type="button" onclick="gameModeAddRule()"
                        class="w-full px-3 py-2 border border-dashed border-neutral-700 rounded-xl text-xs text-neutral-400 hover:bg-neutral-900/50 hover:text-white transition-colors no-drag">
                        <i class="fas fa-plus mr-1.5"></i>Add game profile</button>
                </div>`;
        }

        function gameModeStatusHtml() {
            const s = gameModeState || {};
            const active = (s.rules || []).find(r => r.id === s.activeRuleId);
            if (active) {
                return `<div class="flex items-center gap-2 text-xs border rounded-xl px-3 py-2 bg-emerald-600/15 border-emerald-600/40 text-emerald-300">
                    <i class="fas fa-gamepad"></i><span><strong>${esc(active.name)}</strong> active${s.exe ? ` · ${esc(s.exe)}.exe` : ''}</span></div>`;
            }
            if (s.exe) {
                return `<div class="flex items-center gap-2 text-xs border rounded-xl px-3 py-2 bg-neutral-800/60 border-neutral-700/50 text-neutral-400">
                    <i class="fas fa-desktop"></i><span>Foreground: ${esc(s.exe)}.exe${s.fullscreen ? ' (fullscreen)' : ''} — no profile matches</span></div>`;
            }
            return `<div class="flex items-center gap-2 text-xs border rounded-xl px-3 py-2 bg-neutral-800/60 border-neutral-700/50 text-neutral-500">
                <i class="fas fa-circle-notch fa-spin"></i><span>Watching for games…</span></div>`;
        }

        function gameModeRenderStatus() {
            const el = document.getElementById('game-mode-status');
            if (el) el.innerHTML = gameModeStatusHtml();
        }

        function gameModeActionSummary(r) {
            const a = r.actions || {};
            const parts = [];
            if (a.muteMic) parts.push('mute mic');
            if (a.crosshair) parts.push('crosshair');
            if (a.fpsOptimize) parts.push('FPS optimize');
            if (a.showToast) parts.push('notify');
            const widgets = (a.enableWidgets || []).map(id => (getMiniWidgetById(id) || {}).label).filter(Boolean);
            if (widgets.length) parts.push('enable ' + widgets.join(', '));
            return parts.length ? parts.join(' · ') : 'no actions';
        }

        function gameModeRuleCard(r) {
            const target = r.match === 'fullscreen' ? 'Any fullscreen game' : (r.processName ? `${esc(r.processName)}.exe` : 'No game set');
            const isActive = gameModeState && gameModeState.activeRuleId === r.id;
            return `<div class="border ${isActive ? 'border-emerald-600/40' : 'border-white/10'} rounded-xl p-3">
                <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0">
                        <p class="text-sm text-white truncate">${esc(r.name)}${isActive ? ' <span class="text-[9px] text-emerald-400 uppercase tracking-wide">• active</span>' : ''}</p>
                        <p class="text-[11px] text-neutral-500 truncate">${target}</p>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button type="button" class="w-7 h-7 flex items-center justify-center rounded-lg border border-neutral-700/50 text-neutral-400 hover:text-white transition-colors no-drag" title="Edit" onclick="gameModeEditRule(${jsAttr(r.id)})"><i class="fas fa-pen text-xs"></i></button>
                        <button type="button" class="w-7 h-7 flex items-center justify-center rounded-lg border border-neutral-700/50 text-neutral-400 hover:text-red-400 hover:border-red-700/50 transition-colors no-drag" title="Delete" onclick="gameModeDeleteRule(${jsAttr(r.id)})"><i class="fas fa-trash text-xs"></i></button>
                    </div>
                </div>
                <p class="text-[11px] text-neutral-400 mt-2"><i class="fas fa-bolt text-[9px] text-neutral-600 mr-1"></i>${esc(gameModeActionSummary(r))}</p>
            </div>`;
        }

        function gameModeAddRule() {
            gameModeEditing = { id: '', name: '', match: 'process', processName: '', revert: true, actions: { muteMic: false, crosshair: false, fpsOptimize: false, showToast: true, enableWidgets: [] } };
            gameModeEnsureProcList();
            gameModePaint();
        }

        function gameModeEditRule(id) {
            const r = (gameModeState.rules || []).find(x => x.id === id);
            if (!r) return;
            gameModeEditing = JSON.parse(JSON.stringify(r));
            if (!gameModeEditing.actions) gameModeEditing.actions = { enableWidgets: [] };
            if (!Array.isArray(gameModeEditing.actions.enableWidgets)) gameModeEditing.actions.enableWidgets = [];
            gameModeEnsureProcList();
            gameModePaint();
        }

        async function gameModeDeleteRule(id) {
            if (!window.electronAPI?.gameModeDeleteRule) return;
            const state = await window.electronAPI.gameModeDeleteRule(id);
            if (state) gameModeState = state;
            gameModePaint();
        }

        async function gameModeEnsureProcList() {
            if (gameModeProcList || !window.electronAPI?.gameModeListProcesses) return;
            try { gameModeProcList = await window.electronAPI.gameModeListProcesses(); }
            catch (e) { gameModeProcList = []; }
            // Repaint the editor's datalist once the list arrives.
            if (gameModeEditing) gameModePaintEditor();
        }

        function gameModePaintEditor() {
            const panel = document.getElementById('game-mode-panel');
            if (!panel || !gameModeEditing) return;
            const e = gameModeEditing;
            const a = e.actions;
            const procOptions = (gameModeProcList || []).map(n => `<option value="${esc(n)}">`).join('');

            // Mini widgets a profile can auto-enable (everything except Game Mode itself).
            const widgetChips = (typeof MINI_WIDGETS !== 'undefined' ? MINI_WIDGETS : [])
                .filter(w => w.id !== 'gameMode' && w.id !== 'crosshair')
                .map(w => {
                    const on = (a.enableWidgets || []).includes(w.id);
                    return `<button type="button" class="game-mode-widget-chip no-drag ${on ? 'on' : ''}" onclick="gameModeToggleWidget(${jsAttr(w.id)})">
                        <i class="${w.iconStyle || 'fas'} ${w.icon} text-[10px]"></i>${esc(w.label)}</button>`;
                }).join('');

            panel.innerHTML = `
                <div class="mt-3 space-y-4">
                    <div>
                        <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Profile name</label>
                        <input type="text" id="gm-name" value="${esc(e.name)}" placeholder="e.g. Valorant"
                            class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                    </div>
                    <div>
                        <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Trigger</label>
                        <div class="flex gap-2">
                            <button type="button" class="flex-1 px-3 py-2 rounded-xl text-xs border transition-colors no-drag ${e.match === 'process' ? 'bg-white/10 border-white/25 text-white' : 'bg-neutral-900 border-neutral-800 text-neutral-400'}" onclick="gameModeSetMatch('process')">A specific game</button>
                            <button type="button" class="flex-1 px-3 py-2 rounded-xl text-xs border transition-colors no-drag ${e.match === 'fullscreen' ? 'bg-white/10 border-white/25 text-white' : 'bg-neutral-900 border-neutral-800 text-neutral-400'}" onclick="gameModeSetMatch('fullscreen')">Any fullscreen game</button>
                        </div>
                        ${e.match === 'process' ? `
                        <div class="mt-2">
                            <input type="text" id="gm-process" list="gm-proc-list" value="${esc(e.processName)}" placeholder="game.exe process name" spellcheck="false"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                            <datalist id="gm-proc-list">${procOptions}</datalist>
                            <p class="text-[10px] text-neutral-600 mt-1">Start the game, then pick it from the list — or type its process name (without .exe).</p>
                        </div>` : `<p class="text-[10px] text-neutral-600 mt-1">Fires for any app that goes fullscreen (borderless or exclusive).</p>`}
                    </div>
                    <div>
                        <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-2">When it launches…</label>
                        <div class="space-y-2">
                            ${gameModeActionToggle('muteMic', 'Mute my microphone', a.muteMic)}
                            ${gameModeActionToggle('crosshair', 'Show the crosshair overlay', a.crosshair)}
                            ${gameModeActionToggle('fpsOptimize', 'Run the FPS optimizer', a.fpsOptimize)}
                            ${gameModeActionToggle('showToast', 'Show a notification', a.showToast)}
                        </div>
                        <p class="text-[11px] uppercase tracking-wider text-neutral-500 mt-3 mb-2">…and enable these widgets</p>
                        <div class="flex flex-wrap gap-1.5">${widgetChips || '<span class="text-[11px] text-neutral-600">No widgets available.</span>'}</div>
                    </div>
                    <label class="flex items-center gap-2.5 text-sm text-neutral-300 no-drag cursor-pointer">
                        <span class="ios-toggle">
                            <input type="checkbox" class="ios-toggle-input" id="gm-revert" ${e.revert ? 'checked' : ''}>
                            <span class="ios-toggle-track"></span>
                        </span>
                        Undo these actions when the game closes
                    </label>
                    <div class="flex items-center gap-2 pt-1">
                        <button type="button" onclick="gameModeSaveRule()" class="flex-1 px-3 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-sm text-white transition-colors no-drag"><i class="fas fa-check mr-1.5"></i>Save profile</button>
                        <button type="button" onclick="gameModeCancelEdit()" class="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-sm transition-colors no-drag">Cancel</button>
                    </div>
                </div>`;
        }

        function gameModeActionToggle(key, label, on) {
            return `<label class="flex items-center gap-2.5 text-sm text-neutral-300 no-drag cursor-pointer">
                <span class="ios-toggle">
                    <input type="checkbox" class="ios-toggle-input" ${on ? 'checked' : ''} onchange="gameModeSetAction(${jsAttr(key)}, this.checked)">
                    <span class="ios-toggle-track"></span>
                </span>${esc(label)}</label>`;
        }

        function gameModeSetMatch(match) {
            if (!gameModeEditing) return;
            gameModeCaptureEditor();
            gameModeEditing.match = match;
            gameModePaintEditor();
        }

        function gameModeSetAction(key, val) {
            if (!gameModeEditing) return;
            gameModeEditing.actions[key] = !!val;
        }

        function gameModeToggleWidget(id) {
            if (!gameModeEditing) return;
            const list = gameModeEditing.actions.enableWidgets || (gameModeEditing.actions.enableWidgets = []);
            const i = list.indexOf(id);
            if (i >= 0) list.splice(i, 1); else list.push(id);
            gameModePaintEditor();
        }

        // Pulls the live input values into the editing object before a repaint or save.
        function gameModeCaptureEditor() {
            if (!gameModeEditing) return;
            const name = document.getElementById('gm-name');
            const proc = document.getElementById('gm-process');
            const revert = document.getElementById('gm-revert');
            if (name) gameModeEditing.name = name.value;
            if (proc) gameModeEditing.processName = proc.value;
            if (revert) gameModeEditing.revert = revert.checked;
        }

        async function gameModeSaveRule() {
            if (!gameModeEditing || !window.electronAPI?.gameModeSaveRule) return;
            gameModeCaptureEditor();
            const e = gameModeEditing;
            if (!e.name.trim()) { showToast('Give the profile a name', true); return; }
            if (e.match === 'process' && !e.processName.trim()) { showToast('Pick or type a game process', true); return; }
            const state = await window.electronAPI.gameModeSaveRule(e);
            if (state) gameModeState = state;
            gameModeEditing = null;
            gameModePaint();
            showToast('Profile saved');
        }

        function gameModeCancelEdit() {
            gameModeEditing = null;
            gameModePaint();
        }
